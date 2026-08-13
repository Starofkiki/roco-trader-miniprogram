const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const url = require('url')

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const CACHE_DIR = path.join(ROOT, 'cache')
const SUMMARY_CACHE = path.join(CACHE_DIR, 'summary.json')
const SUBSCRIPTION_HISTORY_CACHE = path.join(CACHE_DIR, 'subscription-history.json')
const DETAIL_CACHE_DIR = path.join(CACHE_DIR, 'round-details')
const AUTO_REFRESH_TIMES = [
  { hour: 8, minute: 15 },
  { hour: 12, minute: 15 },
  { hour: 16, minute: 15 },
  { hour: 20, minute: 15 }
]

loadDotEnv(path.join(ROOT, '.env'))

const sessions = new Set()
let cloudApp = null

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  lines.forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const index = trimmed.indexOf('=')
    if (index < 0) return
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  })
}

function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.mkdirSync(DETAIL_CACHE_DIR, { recursive: true })
  if (!fs.existsSync(SUMMARY_CACHE)) {
    writeJson(SUMMARY_CACHE, { cachedAt: '', source: 'empty', response: null })
  }
  if (!fs.existsSync(SUBSCRIPTION_HISTORY_CACHE)) {
    writeJson(SUBSCRIPTION_HISTORY_CACHE, { snapshots: [] })
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return fallback
  }
}

function getConfig() {
  return {
    envId: process.env.TCB_ENV_ID || process.env.CLOUDBASE_ENV_ID || '',
    secretId: process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '',
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '',
    maintenanceSecret: process.env.ROCO_MAINTENANCE_SECRET || process.env.MAINTENANCE_SECRET || '',
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    port: Number(process.env.PORT || 8787)
  }
}

function assertDashboardConfigured() {
  const config = getConfig()
  const missing = []
  if (!config.envId) missing.push('TCB_ENV_ID')
  if (!config.secretId) missing.push('TENCENTCLOUD_SECRET_ID')
  if (!config.secretKey) missing.push('TENCENTCLOUD_SECRET_KEY')
  if (!config.maintenanceSecret) missing.push('ROCO_MAINTENANCE_SECRET')
  if (!config.dashboardPassword) missing.push('DASHBOARD_PASSWORD')
  if (missing.length) {
    const error = new Error(`Missing required .env values: ${missing.join(', ')}`)
    error.statusCode = 500
    throw error
  }
  return config
}

function getCloudApp() {
  if (cloudApp) return cloudApp
  const config = assertDashboardConfigured()
  const cloudbase = require('@cloudbase/node-sdk')
  cloudApp = cloudbase.init({
    env: config.envId,
    secretId: config.secretId,
    secretKey: config.secretKey
  })
  return cloudApp
}

async function callAdminApi(data) {
  const config = assertDashboardConfigured()
  const app = getCloudApp()
  const result = await app.callFunction({
    name: 'rocoAdminApi',
    data: {
      ...data,
      maintenanceSecret: config.maintenanceSecret
    }
  }, {
    timeout: 60000
  })

  const response = result && result.result ? result.result : result
  if (!response || response.success !== true) {
    throw new Error((response && response.message) || 'rocoAdminApi call failed')
  }
  return response
}

function getChinaParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    date: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  }
}

function chinaPartsToLocalDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour - 8, parts.minute, parts.second || 0))
}

function getNextAutoRefreshAt(now = new Date()) {
  const parts = getChinaParts(now)
  for (const time of AUTO_REFRESH_TIMES) {
    const candidate = chinaPartsToLocalDate({
      ...parts,
      hour: time.hour,
      minute: time.minute,
      second: 0
    })
    if (candidate.getTime() > now.getTime()) return candidate
  }

  return chinaPartsToLocalDate({
    ...parts,
    date: parts.date + 1,
    hour: AUTO_REFRESH_TIMES[0].hour,
    minute: AUTO_REFRESH_TIMES[0].minute,
    second: 0
  })
}

function pad(num) {
  return String(num).padStart(2, '0')
}

function getSubscriptionHistorySlot(now = new Date()) {
  const parts = getChinaParts(now)
  const slot = AUTO_REFRESH_TIMES.reduce((selected, time) => {
    if (parts.hour > time.hour || (parts.hour === time.hour && parts.minute >= time.minute)) return time
    return selected
  }, AUTO_REFRESH_TIMES[AUTO_REFRESH_TIMES.length - 1])
  const date = slot === AUTO_REFRESH_TIMES[AUTO_REFRESH_TIMES.length - 1] &&
    (parts.hour < AUTO_REFRESH_TIMES[0].hour || (parts.hour === AUTO_REFRESH_TIMES[0].hour && parts.minute < AUTO_REFRESH_TIMES[0].minute))
    ? new Date(chinaPartsToLocalDate({ ...parts, hour: 0, minute: 0, second: 0 }).getTime() - 24 * 60 * 60 * 1000)
    : chinaPartsToLocalDate({ ...parts, hour: 0, minute: 0, second: 0 })
  const dateParts = getChinaParts(date)
  const dateText = `${dateParts.year}-${pad(dateParts.month)}-${pad(dateParts.date)}`

  return {
    slotKey: `${dateText}_${slot.hour}`,
    date: dateText,
    hour: slot.hour
  }
}

function readSubscriptionHistory() {
  const history = readJson(SUBSCRIPTION_HISTORY_CACHE, { snapshots: [] })
  return {
    snapshots: Array.isArray(history && history.snapshots) ? history.snapshots : []
  }
}

function readSummaryCache() {
  const cache = readJson(SUMMARY_CACHE, { cachedAt: '', source: 'empty', response: null })
  return {
    ...cache,
    subscriptionHistory: cache.subscriptionHistory || readSubscriptionHistory()
  }
}

function upsertSubscriptionHistory(response, source) {
  const subscriptions = response && response.data && response.data.subscriptions
  if (!subscriptions) return readSubscriptionHistory()

  const slot = getSubscriptionHistorySlot()
  const history = readSubscriptionHistory()
  const snapshot = {
    ...slot,
    userCount: Number(subscriptions.userCount || 0),
    usersWithQuota: Number(subscriptions.usersWithQuota || 0),
    wechatRejectedQuotaCount: Number(subscriptions.wechatRejectedQuotaCount || 0),
    source,
    updatedAt: new Date().toISOString()
  }
  const nextSnapshots = history.snapshots
    .filter(item => item && item.slotKey !== snapshot.slotKey)
    .concat(snapshot)
    .sort((a, b) => String(b.slotKey || '').localeCompare(String(a.slotKey || '')))
    .slice(0, 56)
  const nextHistory = { snapshots: nextSnapshots }
  writeJson(SUBSCRIPTION_HISTORY_CACHE, nextHistory)
  return nextHistory
}

function scheduleAutoRefresh() {
  const next = getNextAutoRefreshAt()
  const delay = Math.max(1000, next.getTime() - Date.now())
  setTimeout(async () => {
    try {
      await refreshSummaryFromCloud('scheduled')
    } catch (error) {
      console.warn(`[admin-dashboard] scheduled refresh failed: ${error.message}`)
    } finally {
      scheduleAutoRefresh()
    }
  }, delay)

  console.log(`[admin-dashboard] next scheduled cloud refresh at ${next.toISOString()}`)
}

async function refreshSummaryFromCloud(source, days = 3) {
  const response = await callAdminApi({
    action: 'admin.dashboardSummary',
    days
  })
  const cache = {
    cachedAt: new Date().toISOString(),
    source,
    response,
    subscriptionHistory: upsertSubscriptionHistory(response, source)
  }
  writeJson(SUMMARY_CACHE, cache)
  return cache
}

async function refreshRoundDetailFromCloud(roundKey) {
  const response = await callAdminApi({
    action: 'admin.roundNotificationDetail',
    roundKey
  })
  const cache = {
    roundKey,
    cachedAt: new Date().toISOString(),
    source: 'manual',
    response
  }
  writeJson(getRoundDetailPath(roundKey), cache)
  return cache
}

async function fetchUserTraceFromCloud(openid, roundKey) {
  const response = await callAdminApi({
    action: 'admin.userNotificationTrace',
    openid,
    roundKey
  })
  return {
    fetchedAt: new Date().toISOString(),
    response
  }
}

async function fetchAnnouncementFromCloud() {
  const response = await callAdminApi({
    action: 'admin.announcement.get'
  })
  return {
    fetchedAt: new Date().toISOString(),
    response
  }
}

async function updateAnnouncementInCloud(payload = {}) {
  const response = await callAdminApi({
    action: 'admin.announcement.update',
    title: payload.title,
    content: payload.content,
    enabled: payload.enabled === true
  })
  return {
    updatedAt: new Date().toISOString(),
    response
  }
}

function getRoundDetailPath(roundKey) {
  const safe = String(roundKey || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(DETAIL_CACHE_DIR, `${safe}.json`)
}

async function runOperation(operation, payload = {}) {
  return callAdminApi({
    action: 'admin.operation',
    operation,
    ...payload
  })
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/(?:^|;\s*)admin_session=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function isAuthenticated(req) {
  const config = getConfig()
  if (!config.dashboardPassword) return false
  return sessions.has(getSessionToken(req))
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(data))
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js') return 'application/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname
  const resolved = path.resolve(PUBLIC_DIR, `.${target}`)
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden')
    return
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendText(res, 404, 'Not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': getMimeType(resolved),
    'Cache-Control': 'no-store'
  })
  fs.createReadStream(resolved).pipe(res)
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        req.destroy(new Error('request body too large'))
      }
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === '/api/session' && req.method === 'GET') {
      const configured = Boolean(getConfig().dashboardPassword)
      sendJson(res, 200, {
        authenticated: configured && isAuthenticated(req),
        configured,
        nextAutoRefreshAt: getNextAutoRefreshAt().toISOString()
      })
      return
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readRequestBody(req)
      const config = assertDashboardConfigured()
      if (body.password !== config.dashboardPassword) {
        sendJson(res, 401, { success: false, message: '密码不正确' })
        return
      }
      const token = crypto.randomBytes(24).toString('hex')
      sessions.add(token)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`,
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify({ success: true }))
      return
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = getSessionToken(req)
      if (token) sessions.delete(token)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'admin_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/',
        'Cache-Control': 'no-store'
      })
      res.end(JSON.stringify({ success: true }))
      return
    }

    if (!isAuthenticated(req)) {
      sendJson(res, 401, { success: false, message: '未登录' })
      return
    }

    if (pathname === '/api/cache' && req.method === 'GET') {
      sendJson(res, 200, {
        success: true,
        cache: readSummaryCache(),
        nextAutoRefreshAt: getNextAutoRefreshAt().toISOString()
      })
      return
    }

    if (pathname === '/api/cloud-refresh' && req.method === 'POST') {
      const body = await readRequestBody(req)
      if (body.confirmCloudCall !== true) {
        sendJson(res, 400, { success: false, message: '需要确认会调用云函数' })
        return
      }
      const cache = await refreshSummaryFromCloud('manual', body.days || 3)
      sendJson(res, 200, { success: true, cache, nextAutoRefreshAt: getNextAutoRefreshAt().toISOString() })
      return
    }

    if (pathname === '/api/round-detail' && req.method === 'POST') {
      const body = await readRequestBody(req)
      const roundKey = String(body.roundKey || '').trim()
      if (!roundKey) {
        sendJson(res, 400, { success: false, message: 'roundKey is required' })
        return
      }
      const filePath = getRoundDetailPath(roundKey)
      if (body.forceCloud === true) {
        if (body.confirmCloudCall !== true) {
          sendJson(res, 400, { success: false, message: '需要确认会调用云函数' })
          return
        }
        sendJson(res, 200, { success: true, cache: await refreshRoundDetailFromCloud(roundKey) })
        return
      }
      sendJson(res, 200, {
        success: true,
        cache: readJson(filePath, null),
        requiresCloudFetch: !fs.existsSync(filePath)
      })
      return
    }

    if (pathname === '/api/user-trace' && req.method === 'POST') {
      const body = await readRequestBody(req)
      const openid = String(body.openid || '').trim()
      const roundKey = String(body.roundKey || '').trim()
      if (!openid) {
        sendJson(res, 400, { success: false, message: 'openid is required' })
        return
      }
      if (body.confirmCloudCall !== true) {
        sendJson(res, 400, { success: false, message: '需要确认会调用云函数' })
        return
      }
      sendJson(res, 200, {
        success: true,
        trace: await fetchUserTraceFromCloud(openid, roundKey)
      })
      return
    }

    if (pathname === '/api/announcement' && req.method === 'GET') {
      sendJson(res, 200, {
        success: true,
        announcement: await fetchAnnouncementFromCloud()
      })
      return
    }

    if (pathname === '/api/announcement' && req.method === 'POST') {
      const body = await readRequestBody(req)
      if (body.confirmCloudCall !== true) {
        sendJson(res, 400, { success: false, message: '需要确认会调用云函数' })
        return
      }
      sendJson(res, 200, {
        success: true,
        announcement: await updateAnnouncementInCloud(body)
      })
      return
    }

    if (pathname === '/api/admin/operation' && req.method === 'POST') {
      const body = await readRequestBody(req)
      if (body.confirmOperation !== true) {
        sendJson(res, 400, { success: false, message: '需要二次确认操作' })
        return
      }
      const response = await runOperation(body.operation, body.payload || {})
      sendJson(res, 200, { success: true, response })
      return
    }

    sendJson(res, 404, { success: false, message: 'unknown api route' })
  } catch (error) {
    sendJson(res, error.statusCode || 500, { success: false, message: error.message })
  }
}

function startServer() {
  ensureDirs()
  const config = getConfig()
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url)
    if (parsed.pathname.startsWith('/api/')) {
      handleApi(req, res, parsed.pathname)
      return
    }
    serveStatic(req, res, parsed.pathname)
  })

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[admin-dashboard] http://127.0.0.1:${config.port}`)
    if (!config.dashboardPassword) {
      console.warn('[admin-dashboard] DASHBOARD_PASSWORD is not configured; APIs will stay locked.')
    }
    scheduleAutoRefresh()
  })
}

startServer()
