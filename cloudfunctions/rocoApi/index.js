const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { AsyncLocalStorage } = require('async_hooks')
const fallbackProductCatalog = require('./product-catalog-fallback')
const {
  SEASONS: PRODUCT_STATS_SEASONS,
  buildRollingSnapshot,
  buildSeasonSnapshot,
  getSeasonMonths,
  getSeasonRateScope,
  mergeRollingSnapshot
} = require('./product-stats-snapshots')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const COLLECTIONS = {
  announcements: 'announcements',
  deliveries: 'notification_deliveries',
  feedback: 'feedback',
  history: 'merchant_history',
  historyBundles: 'merchant_history_bundles',
  jobs: 'merchant_round_jobs',
  productCatalog: 'product_catalog',
  productCatalogMeta: 'product_catalog_meta',
  productOffers: 'product_offers',
  productStatsSnapshots: 'merchant_product_stats_snapshots',
  roundVotes: 'merchant_round_votes',
  roundVoteSummaries: 'merchant_round_vote_summaries',
  shareImageAssets: 'share_image_assets',
  quotas: 'subscription_quotas',
  subscriptions: 'subscriptions',
  subscriptionProfiles: 'subscription_profiles',
  itemTargets: 'subscription_item_targets',
  itemTargetsV2: 'subscription_item_targets_v2',
  targets: 'subscription_targets',
  users: 'users'
}

const LOADTEST_COLLECTIONS = {
  deliveries: 'loadtest_notification_deliveries',
  jobs: 'loadtest_merchant_round_jobs',
  quotas: 'loadtest_subscription_quotas',
  targets: 'loadtest_subscription_targets'
}

const RETRY_MINUTES = [3, 5, 10]
const FINAL_RETRY_MINUTE = 10
const DISPATCH_WINDOW_MS = 10 * 60 * 1000
const DELIVERY_LOCK_MS = 2 * 60 * 1000
const MAX_DELIVERY_ATTEMPTS = 2
const MAX_POOL_DELIVERY_ATTEMPTS = 4
const LAST_RECIPIENT_OPENID = process.env.NOTIFY_LAST_RECIPIENT_OPENID || ''
const RAW_NOTIFY_CONCURRENCY = Number(process.env.NOTIFY_CONCURRENCY || 40)
const NOTIFY_CONCURRENCY = Number.isFinite(RAW_NOTIFY_CONCURRENCY)
  ? Math.min(Math.max(RAW_NOTIFY_CONCURRENCY, 1), 40)
  : 40
const RAW_NOTIFY_BATCH_LIMIT = Number(process.env.NOTIFY_BATCH_LIMIT || 1800)
const NOTIFY_BATCH_LIMIT = Number.isFinite(RAW_NOTIFY_BATCH_LIMIT)
  ? Math.min(Math.max(RAW_NOTIFY_BATCH_LIMIT, 1), 5000)
  : 1800
const RAW_NOTIFY_TIME_BUDGET_MS = Number(process.env.NOTIFY_TIME_BUDGET_MS || 52000)
const NOTIFY_TIME_BUDGET_MS = Number.isFinite(RAW_NOTIFY_TIME_BUDGET_MS)
  ? Math.min(Math.max(RAW_NOTIFY_TIME_BUDGET_MS, 10000), 55000)
  : 52000
const FINAL_SUBSCRIBE_ERROR_CODES = new Set([40003, 40037, 41030, 43101, 43104, 47003])
const HISTORY_BY_KEYS_LIMIT = 120
const HISTORY_BY_KEYS_BATCH_SIZE = 20
const HISTORY_RECENT_BUNDLE_ID = 'recent_120'
const HISTORY_RECENT_BUNDLE_LIMIT = 120
const VOTE_ROUND_KEY_BATCH_SIZE = 20
const QUOTA_QUERY_BATCH_SIZE = 20
const SUBSCRIPTION_BACKFILL_BATCH_LIMIT = 80
const HOME_ANNOUNCEMENT_ID = 'home'
const PRODUCT_CATALOG_META_ID = 'current'
const PRODUCT_CATALOG_CACHE_MS = 5 * 60 * 1000
const SUBSCRIPTION_V2_DUAL_WRITE = process.env.SUBSCRIPTION_V2_DUAL_WRITE === 'true'
const SUBSCRIPTION_V2_READ = process.env.SUBSCRIPTION_V2_READ === 'true'
const SUBSCRIPTION_V2_READ_FALLBACK = process.env.SUBSCRIPTION_V2_READ_FALLBACK !== 'false'
const SUBSCRIPTION_V2_SHADOW_READ = process.env.SUBSCRIPTION_V2_SHADOW_READ === 'true'
const SUBSCRIPTION_V2_LEGACY_WRITE = process.env.SUBSCRIPTION_V2_LEGACY_WRITE !== 'false'
const usageStorage = new AsyncLocalStorage()
const PRODUCT_IMAGE_MIGRATION_SOURCE_BY_TITLE = {
  '变幻球': 'https://patchwiki.biligame.com/images/rocom/9/97/t58zrpfzxopvj3ke3oi3v57mf6k05s0.png',
  '调温球': 'https://patchwiki.biligame.com/images/rocom/0/0d/2fx8i8qxb62s1sj8dn08h9vhsnsim1t.png',
  '好战球': 'https://patchwiki.biligame.com/images/rocom/7/79/kdfs6bmfy54gk7ak70arjxug91zv1z5.png',
  '淘沙球': 'https://patchwiki.biligame.com/images/rocom/8/81/7pzswfbn9l7hip6ptdg7f2mo341ztui.png',
  '万能血脉秘药': 'https://patchwiki.biligame.com/images/rocom/1/12/sl80e063jgtl9zy7oehsf8jelkt7woa.png',
  '魔法粉尘': 'https://patchwiki.biligame.com/images/rocom/9/95/gfvay0r9kbsk782of2bhsghsfw3qk4g.png'
}
let shareWxacodeCache = null

const ROUND_RANGES = [
  { round: 1, start: '08:00', end: '11:59', startHour: 8, endHour: 11 },
  { round: 2, start: '12:00', end: '15:59', startHour: 12, endHour: 15 },
  { round: 3, start: '16:00', end: '19:59', startHour: 16, endHour: 19 },
  { round: 4, start: '20:00', end: '23:59', startHour: 20, endHour: 23 }
]

const ROUND_VOTE_OPTIONS = [
  { key: 'amazing', label: '了不起' },
  { key: 'great', label: '相当好' },
  { key: 'good', label: '还不错' },
  { key: 'normal', label: '一般般' }
]

const ALL_DAY_REMINDER_REPEAT_EXCEPTIONS = [
  { date: '2026-06-14', round: 2, name: '棱镜球' }
]

const DEFAULT_ROCOM_BASE_URL = 'https://wegame.shallow.ink'
const MERCHANT_INFO_PATH = '/api/v1/games/rocom/merchant/info?refresh=false'
const WECHAT_STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token'
const WECHAT_SUBSCRIBE_SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send'
const DEFAULT_TEMPLATE_ID = ''
const DEFAULT_ARRIVAL_TEMPLATE_ID = ''
const DEFAULT_ACTIVITY_TEMPLATE_ID = ''
const TEMPLATE_PAYLOAD_MODES = {
  productArrival: 'product_arrival',
  activityProgress: 'activity_progress'
}
const REMINDER_QUOTA_LIMIT = 99
const REMINDER_QUOTA_LIMIT_MESSAGE = '次数已经很多了，之后再订阅吧'
const LEGACY_TEMPLATE_FIELD_KEYS = {
  item: process.env.WECHAT_TEMPLATE_FIELD_ITEM || 'thing1',
  time: process.env.WECHAT_TEMPLATE_FIELD_TIME || 'time5',
  remark: process.env.WECHAT_TEMPLATE_FIELD_REMARK || 'thing3'
}

function normalizeSubscribeTemplateConfig(config = {}, index = 0) {
  const fields = config.fields || {}
  return {
    key: String(config.key || `merchant_${index + 1}`).trim(),
    label: String(config.label || `商品提醒 ${index + 1}`).trim(),
    templateId: String(config.templateId || config.template_id || '').trim(),
    payloadMode: config.payloadMode === TEMPLATE_PAYLOAD_MODES.activityProgress
      ? TEMPLATE_PAYLOAD_MODES.activityProgress
      : TEMPLATE_PAYLOAD_MODES.productArrival,
    fields: {
      item: String(fields.item || config.itemField || LEGACY_TEMPLATE_FIELD_KEYS.item).trim(),
      time: String(fields.time || config.timeField || LEGACY_TEMPLATE_FIELD_KEYS.time).trim(),
      remark: String(fields.remark || config.remarkField || LEGACY_TEMPLATE_FIELD_KEYS.remark).trim()
    }
  }
}

function buildSubscribeTemplateConfigs() {
  const defaultConfigs = [
    {
      key: 'merchant_primary',
      label: '新商品上架提醒',
      templateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || DEFAULT_TEMPLATE_ID,
      payloadMode: process.env.WECHAT_TEMPLATE_PAYLOAD_MODE || TEMPLATE_PAYLOAD_MODES.productArrival,
      fields: LEGACY_TEMPLATE_FIELD_KEYS
    },
    {
      key: 'merchant_arrival',
      label: '商品到货提醒',
      templateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID_2 || DEFAULT_ARRIVAL_TEMPLATE_ID,
      payloadMode: process.env.WECHAT_TEMPLATE_PAYLOAD_MODE_2 || TEMPLATE_PAYLOAD_MODES.productArrival,
      fields: {
        item: process.env.WECHAT_TEMPLATE_FIELD_ITEM_2 || 'thing1',
        time: process.env.WECHAT_TEMPLATE_FIELD_TIME_2 || 'time2',
        remark: process.env.WECHAT_TEMPLATE_FIELD_REMARK_2 || 'thing3'
      }
    },
    {
      key: 'merchant_activity',
      label: '活动进度提醒',
      templateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID_3 || DEFAULT_ACTIVITY_TEMPLATE_ID,
      payloadMode: process.env.WECHAT_TEMPLATE_PAYLOAD_MODE_3 || TEMPLATE_PAYLOAD_MODES.activityProgress,
      fields: {
        item: process.env.WECHAT_TEMPLATE_FIELD_ITEM_3 || 'thing1',
        time: process.env.WECHAT_TEMPLATE_FIELD_TIME_3 || 'thing2',
        remark: process.env.WECHAT_TEMPLATE_FIELD_REMARK_3 || 'thing3'
      }
    }
  ]
  let configured = []
  const rawJson = String(process.env.WECHAT_SUBSCRIBE_TEMPLATES_JSON || '').trim()
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (Array.isArray(parsed)) configured = parsed
    } catch (error) {
      console.warn(`[rocoApi] WECHAT_SUBSCRIBE_TEMPLATES_JSON invalid: ${error.message}`)
    }
  }
  const slotByKey = {
    merchant_primary: 0,
    merchant_secondary: 1,
    merchant_arrival: 1,
    merchant_tertiary: 2,
    merchant_activity: 2
  }
  const overridesBySlot = new Map()
  configured.forEach((config, index) => {
    const slot = Object.prototype.hasOwnProperty.call(slotByKey, config && config.key)
      ? slotByKey[config.key]
      : index
    if (slot >= 0 && slot < defaultConfigs.length) overridesBySlot.set(slot, config)
  })
  configured = defaultConfigs.map((defaultConfig, index) => {
    const override = overridesBySlot.get(index)
    if (!override) return defaultConfig
    return {
      ...defaultConfig,
      ...override,
      fields: {
        ...defaultConfig.fields,
        ...(override.fields || {})
      }
    }
  })
  const seen = new Set()
  return configured
    .slice(0, 3)
    .map(normalizeSubscribeTemplateConfig)
    .filter(config => config.templateId && !seen.has(config.templateId) && seen.add(config.templateId))
}

const SUBSCRIBE_TEMPLATE_CONFIGS = buildSubscribeTemplateConfigs()

let wechatAccessTokenCache = {
  token: '',
  expiresAt: 0
}

const ensuredCollections = new Set()
const ensuringCollections = new Map()

function ok(data = {}, message = '') {
  return { success: true, message, data }
}

function fail(message, extra = {}) {
  return { success: false, message, ...extra }
}

function normalizeAnnouncement(doc = {}) {
  const id = doc.announcementId || (doc._id && doc._id !== HOME_ANNOUNCEMENT_ID ? doc._id : 'legacy_home')
  const content = String(doc.content || '').trim()
  return {
    id,
    title: String(doc.title || '公告').trim() || '公告',
    content,
    enabled: doc.enabled !== false,
    publishedAt: doc.publishedAt || null,
    pinned: doc.pinned === true || Boolean(doc.pinnedAnnouncementId && doc.pinnedAnnouncementId === id),
    updatedAt: doc.updatedAt || null
  }
}

function normalizeOpenids(openids) {
  const values = Array.isArray(openids)
    ? openids
    : String(openids || '').split(',')

  return Array.from(new Set(values
    .map(openid => String(openid || '').trim())
    .filter(Boolean)))
}

function pad(num) {
  return String(num).padStart(2, '0')
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

function getNotificationBatchLimit(value) {
  const parsed = Number(value || NOTIFY_BATCH_LIMIT)
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), 5000)
    : NOTIFY_BATCH_LIMIT
}

function getNotificationTimeBudgetMs(value) {
  const parsed = Number(value || NOTIFY_TIME_BUDGET_MS)
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 10000), 55000)
    : NOTIFY_TIME_BUDGET_MS
}

function formatChinaDate(date = new Date()) {
  const parts = getChinaParts(date)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.date)}`
}

function formatChinaTime(date = new Date()) {
  const parts = getChinaParts(date)
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
}

function getCurrentRoundInfo(date = new Date()) {
  const { hour } = getChinaParts(date)

  if (hour < 8) {
    return {
      round: null,
      timeRange: '00:00 - 07:59',
      status: 'inactive'
    }
  }

  const range = ROUND_RANGES.find(item => hour >= item.startHour && hour <= item.endHour)
  if (!range) {
    return {
      round: null,
      timeRange: '00:00 - 07:59',
      status: 'inactive'
    }
  }

  return {
    round: range.round,
    timeRange: `${range.start} - ${range.end}`,
    status: 'active'
  }
}

function encodeDocId(value) {
  return Buffer.from(String(value)).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function getUsageMetrics() {
  return usageStorage.getStore() || null
}

function trackDbRead(collectionName, count, queryType = 'query') {
  const metrics = getUsageMetrics()
  if (!metrics) return
  const value = Math.max(0, Number(count || 0))
  metrics.dbReadCalls += 1
  metrics.dbReadDocuments += value
  metrics.collectionsRead[collectionName] = (metrics.collectionsRead[collectionName] || 0) + value
  metrics.queryTypes[queryType] = (metrics.queryTypes[queryType] || 0) + 1
  metrics.dataSources.add('cloud_database')
}

function trackDbWrite(collectionName, count = 1, writeType = 'set') {
  const metrics = getUsageMetrics()
  if (!metrics) return
  const value = Math.max(0, Number(count || 0))
  metrics.dbWriteCalls += value
  metrics.collectionsWritten[collectionName] = (metrics.collectionsWritten[collectionName] || 0) + value
  metrics.writeTypes[writeType] = (metrics.writeTypes[writeType] || 0) + value
  metrics.dataSources.add('cloud_database')
}

function markUsageCacheHit(name) {
  const metrics = getUsageMetrics()
  if (!metrics || !name) return
  metrics.cacheHits[name] = (metrics.cacheHits[name] || 0) + 1
}

function markUsageSource(name) {
  const metrics = getUsageMetrics()
  if (metrics && name) metrics.dataSources.add(name)
}

async function queryAll(collectionName, where = null, limit = Infinity) {
  const results = []
  const pageSize = 100

  for (let skip = 0; skip < limit; skip += pageSize) {
    const batchLimit = Number.isFinite(limit)
      ? Math.min(pageSize, limit - skip)
      : pageSize
    if (batchLimit <= 0) break

    let query = db.collection(collectionName)
    if (where) query = query.where(where)
    let res = null
    try {
      res = await query.skip(skip).limit(batchLimit).get()
    } catch (error) {
      if (isCollectionNotExistsError(error)) return results
      throw error
    }
    const data = res.data || []
    trackDbRead(collectionName, data.length, 'query')
    results.push(...data)
    if (data.length < batchLimit) break
  }

  return results
}

async function countDocs(collectionName, where = null) {
  try {
    let query = db.collection(collectionName)
    if (where) query = query.where(where)
    const result = await query.count()
    const total = Number(result && result.total || 0)
    trackDbRead(collectionName, 0, 'count')
    return total
  } catch (error) {
    if (isCollectionNotExistsError(error)) return 0
    throw error
  }
}

function encodePageCursor(doc, orderField) {
  if (!doc || !doc[orderField]) return ''
  const value = doc[orderField]
  const date = value instanceof Date
    ? value
    : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value))
  if (Number.isNaN(date.getTime())) return ''
  return Buffer.from(JSON.stringify({ time: date.toISOString(), id: String(doc._id || '') })).toString('base64')
}

function decodePageCursor(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'))
    const date = new Date(value.time)
    return Number.isNaN(date.getTime()) ? null : { date, id: String(value.id || '') }
  } catch (error) {
    return null
  }
}

async function queryCursorPage(collectionName, where, orderField, pageSize, cursor = '', legacyPage = 1) {
  const cursorValue = decodePageCursor(cursor)
  const baseWhere = where || {}
  const queryWhere = cursorValue
    ? (cursorValue.id
        ? _.or([
            { ...baseWhere, [orderField]: _.lt(cursorValue.date) },
            { ...baseWhere, [orderField]: _.eq(cursorValue.date), _id: _.lt(cursorValue.id) }
          ])
        : { ...baseWhere, [orderField]: _.lt(cursorValue.date) })
    : baseWhere
  let query = db.collection(collectionName)
  if (cursorValue || Object.keys(baseWhere).length) query = query.where(queryWhere)
  query = query.orderBy(orderField, 'desc').orderBy('_id', 'desc')
  if (!cursorValue && Number(legacyPage || 1) > 1) {
    query = query.skip((Number(legacyPage) - 1) * pageSize)
  }
  try {
    const result = await query.limit(pageSize + 1).get()
    const docs = result.data || []
    trackDbRead(collectionName, docs.length, 'cursor_query')
    const hasMore = docs.length > pageSize
    const items = docs.slice(0, pageSize)
    const last = items[items.length - 1]
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodePageCursor(last, orderField) : ''
    }
  } catch (error) {
    if (isCollectionNotExistsError(error)) return { items: [], hasMore: false, nextCursor: '' }
    throw error
  }
}

async function getDoc(collectionName, id) {
  try {
    const res = await db.collection(collectionName).doc(id).get()
    trackDbRead(collectionName, res.data ? 1 : 0, 'doc')
    return res.data || null
  } catch (error) {
    trackDbRead(collectionName, 0, 'doc')
    return null
  }
}

function sanitizeDbData(data) {
  return Object.keys(data || {}).reduce((result, key) => {
    if (!key.startsWith('_')) {
      result[key] = data[key]
    }
    return result
  }, {})
}

function isCollectionNotExistsError(error) {
  const code = Number(error && (error.errCode || error.errcode || error.code))
  const message = `${error && error.message ? error.message : ''} ${error && error.errMsg ? error.errMsg : ''}`.toLowerCase()
  return code === -502005 ||
    message.includes('collection not exists') ||
    message.includes('db or table not exist') ||
    message.includes('table not exist') ||
    message.includes('resourcenotfound')
}

function isCollectionAlreadyExistsError(error) {
  const message = `${error && error.message ? error.message : ''} ${error && error.errMsg ? error.errMsg : ''}`.toLowerCase()
  return message.includes('collection already exists') ||
    message.includes('already exist') ||
    message.includes('already exists') ||
    message.includes('resourceexist') ||
    message.includes('resource exist') ||
    message.includes('table exist')
}

async function ensureCollectionExists(collectionName) {
  if (!collectionName || ensuredCollections.has(collectionName)) return
  if (typeof db.createCollection !== 'function') return
  if (ensuringCollections.has(collectionName)) {
    await ensuringCollections.get(collectionName)
    return
  }

  const pending = (async () => {
    try {
      await db.createCollection(collectionName)
    } catch (error) {
      if (!isCollectionAlreadyExistsError(error)) {
        throw error
      }
    } finally {
      ensuringCollections.delete(collectionName)
    }
    ensuredCollections.add(collectionName)
  })()

  ensuringCollections.set(collectionName, pending)
  await pending
}

async function setDoc(collectionName, id, data) {
  try {
    await db.collection(collectionName).doc(id).set({ data: sanitizeDbData(data) })
    trackDbWrite(collectionName, 1, 'set')
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
    await ensureCollectionExists(collectionName)
    await db.collection(collectionName).doc(id).set({ data: sanitizeDbData(data) })
    trackDbWrite(collectionName, 1, 'set')
  }
}

async function getTransactionDoc(transaction, collectionName, id) {
  try {
    const res = await transaction.collection(collectionName).doc(id).get()
    trackDbRead(collectionName, res.data ? 1 : 0, 'transaction_doc')
    return res.data || null
  } catch (error) {
    trackDbRead(collectionName, 0, 'transaction_doc')
    return null
  }
}

async function setTransactionDoc(transaction, collectionName, id, data) {
  await transaction.collection(collectionName).doc(id).set({ data: sanitizeDbData(data) })
  trackDbWrite(collectionName, 1, 'transaction_set')
}

async function addDocWithId(collectionName, id, data) {
  const payload = {
    data: {
      _id: id,
      ...sanitizeDbData(data)
    }
  }
  try {
    await db.collection(collectionName).add(payload)
    trackDbWrite(collectionName, 1, 'add')
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
    await ensureCollectionExists(collectionName)
    await db.collection(collectionName).add(payload)
    trackDbWrite(collectionName, 1, 'add')
  }
}

function normalizeCatalogProduct(product = {}) {
  const productId = String(product.product_id || product._id || '').trim()
  const aliases = Array.from(new Set((Array.isArray(product.aliases) ? product.aliases : [])
    .map(alias => String(alias || '').trim())
    .filter(Boolean)))
  return {
    product_id: productId,
    title: String(product.title || '').trim(),
    aliases,
    category: product.category || '未知',
    description: product.description || '',
    obtain: product.obtain || '',
    rarity: product.rarity === 'rare' ? 'rare' : 'normal',
    default_score: Number(product.default_score || 0),
    image_file_id: String(product.image_file_id || '').trim(),
    image_url: String(product.image_url || product.image || '').trim(),
    status: product.status || 'active'
  }
}

function normalizeCatalogOffer(offer = {}) {
  return {
    offer_id: String(offer.offer_id || offer._id || '').trim(),
    product_id: String(offer.product_id || '').trim(),
    raw_name: String(offer.raw_name || '').trim(),
    sale_group: offer.sale_group || 'normal',
    offer_type: offer.offer_type || 'normal_pool',
    price: Number(offer.price || 0),
    buy_limit: Number(offer.buy_limit || 0),
    enable: offer.enable !== false,
    source_row_id: offer.source_row_id === null ? null : Number(offer.source_row_id || 0),
    external_item_id: offer.external_item_id === null ? null : Number(offer.external_item_id || 0)
  }
}

function buildProductCatalogRuntime(snapshot = fallbackProductCatalog) {
  const products = (snapshot.products || [])
    .map(normalizeCatalogProduct)
    .filter(product => product.product_id && product.title && product.status !== 'inactive')
  const offers = (snapshot.offers || [])
    .map(normalizeCatalogOffer)
    .filter(offer => offer.offer_id && offer.enable)
  const fallbackTargets = fallbackProductCatalog.follow_targets || []
  const fixedHotFallback = fallbackTargets.find(target => target && target.id === 'fixed_hot_bundle')
  const snapshotTargets = (Array.isArray(snapshot.follow_targets) ? snapshot.follow_targets : []).map(target => {
    if (!fixedHotFallback || !target || target.id !== 'fixed_hot_bundle') return target
    return {
      ...target,
      name: fixedHotFallback.name,
      icon: fixedHotFallback.icon,
      reminder_policy: fixedHotFallback.reminder_policy,
      display_product_id: fixedHotFallback.display_product_id,
      keywords: Array.from(new Set([].concat(target.keywords || [], fixedHotFallback.keywords || [])))
    }
  })
  const snapshotTargetIds = new Set(snapshotTargets.map(target => target && target.id).filter(Boolean))
  const followTargetSource = snapshotTargets.concat(fallbackTargets
    .filter(target => target && !snapshotTargetIds.has(target.id)))
  const followTargets = followTargetSource.map(target => ({
    id: String(target.id || '').trim(),
    name: String(target.name || '').trim(),
    group: target.group === 'recommended' ? 'recommended' : 'other',
    icon: String(target.icon || '').trim(),
    tip: String(target.tip || '').trim(),
    all_day: target.all_day === true,
    reminder_policy: String(target.reminder_policy || '').trim(),
    display_product_id: String(target.display_product_id || '').trim(),
    product_ids: Array.isArray(target.product_ids) ? target.product_ids.filter(Boolean) : [],
    keywords: Array.from(new Set((Array.isArray(target.keywords) ? target.keywords : [])
      .map(keyword => String(keyword || '').trim())
      .filter(Boolean)))
  })).filter(target => target.id && target.name)
  const byId = new Map()
  const byName = new Map()
  const byExternalId = new Map()
  const offerByProductId = new Map()
  products.forEach(product => {
    byId.set(product.product_id, product)
    ;[product.title].concat(product.aliases || []).forEach(name => {
      const key = normalizeMatchText(name)
      if (key && !byName.has(key)) byName.set(key, product)
    })
  })
  const recommendedProductIds = new Set(followTargets
    .filter(target => target.group === 'recommended')
    .flatMap(target => target.product_ids))
  offers.forEach(offer => {
    if (!offer.product_id) return
    const product = byId.get(offer.product_id)
    if (product && offer.external_item_id) {
      const externalKey = String(offer.external_item_id)
      if (!byExternalId.has(externalKey)) byExternalId.set(externalKey, product)
    }
    if (!offerByProductId.has(offer.product_id)) offerByProductId.set(offer.product_id, [])
    offerByProductId.get(offer.product_id).push(offer)
  })
  offerByProductId.forEach(productOffers => {
    productOffers.sort((a, b) => {
      if (a.offer_type === 'fixed_hot' && b.offer_type !== 'fixed_hot') return -1
      if (a.offer_type === 'special_pool' && b.offer_type === 'normal_pool') return -1
      return Number(a.source_row_id || 0) - Number(b.source_row_id || 0)
    })
  })
  return {
    version: String(snapshot.version || fallbackProductCatalog.version || 'bundled'),
    products,
    offers,
    followTargets,
    byId,
    byName,
    byExternalId,
    offerByProductId,
    recommendedProductIds,
    loadedAt: Date.now()
  }
}

let productCatalogRuntime = buildProductCatalogRuntime(fallbackProductCatalog)
productCatalogRuntime.loadedAt = 0
let productCatalogLoadPromise = null
let FOLLOW_ITEM_MATCHERS = productCatalogRuntime.followTargets
let RECOMMENDED_NAMES = FOLLOW_ITEM_MATCHERS
  .filter(target => target.group === 'recommended')
  .flatMap(target => target.keywords)
let RARE_NAMES = productCatalogRuntime.products
  .filter(product => product.rarity === 'rare')
  .map(product => product.title)
let ALL_DAY_REMINDER_ITEMS = FOLLOW_ITEM_MATCHERS.filter(target => target.all_day)

function applyProductCatalogRuntime(snapshot) {
  productCatalogRuntime = buildProductCatalogRuntime(snapshot)
  FOLLOW_ITEM_MATCHERS = productCatalogRuntime.followTargets
  RECOMMENDED_NAMES = FOLLOW_ITEM_MATCHERS
    .filter(target => target.group === 'recommended')
    .flatMap(target => target.keywords)
  RARE_NAMES = productCatalogRuntime.products
    .filter(product => product.rarity === 'rare')
    .map(product => product.title)
  ALL_DAY_REMINDER_ITEMS = FOLLOW_ITEM_MATCHERS.filter(target => target.all_day)
  return productCatalogRuntime
}

function getCatalogProduct(item = {}) {
  const productId = String(item.product_id || '').trim()
  if (productId && productCatalogRuntime.byId.has(productId)) {
    return productCatalogRuntime.byId.get(productId)
  }
  const externalIds = [item._id, item.id, item.item_id]
    .map(value => value === undefined || value === null ? '' : String(value))
    .filter(Boolean)
  for (const externalId of externalIds) {
    if (productCatalogRuntime.byExternalId.has(externalId)) {
      return productCatalogRuntime.byExternalId.get(externalId)
    }
  }
  const name = item.raw_name || item.name || item.title || ''
  return productCatalogRuntime.byName.get(normalizeMatchText(name)) || null
}

function getCatalogOffer(item = {}) {
  const product = getCatalogProduct(item)
  if (!product) return null
  const offers = productCatalogRuntime.offerByProductId.get(product.product_id) || []
  return offers[0] || null
}

function resolveProductForStats(item = {}) {
  const product = getCatalogProduct(item)
  const offer = product ? getCatalogOffer(product) : null
  if (!product || !offer || !offer.sale_group) return null
  return {
    product_id: product.product_id,
    title: product.title,
    category: product.category,
    sale_group: offer.sale_group
  }
}

function getSnapshotProductStats(snapshot, productId) {
  return snapshot && snapshot.products && snapshot.products[productId]
    ? snapshot.products[productId]
    : null
}

function getSnapshotRate(snapshot, productId) {
  if (!snapshot || Number(snapshot.total_normal_occurrences || 0) <= 0) return null
  const stats = getSnapshotProductStats(snapshot, productId)
  return stats && Number.isFinite(Number(stats.appear_rate)) ? Number(stats.appear_rate) : 0
}

function getSnapshotGroupRate(snapshot, groupKey) {
  if (!snapshot || Number(snapshot.total_normal_occurrences || 0) <= 0) return null
  const stats = snapshot.groups && snapshot.groups[groupKey]
  return stats && Number.isFinite(Number(stats.appear_rate)) ? Number(stats.appear_rate) : 0
}

function getScopedSnapshotRate(snapshot, productId, scope) {
  return scope.type === 'group'
    ? getSnapshotGroupRate(snapshot, scope.key)
    : getSnapshotRate(snapshot, productId)
}

function enrichProductWithStats(product, snapshots) {
  const rolling = snapshots.rolling
  const rollingStats = getSnapshotProductStats(rolling, product.product_id)
  const offer = getCatalogOffer(product)
  const isRegular = Boolean(offer && offer.sale_group === 'normal')
  const seasonRateScope = getSeasonRateScope(product)
  const canShowSeasonRates = isRegular || (!offer && seasonRateScope.type === 'group')
  const currentSeasonRate = canShowSeasonRates
    ? getScopedSnapshotRate(snapshots.season_s3, product.product_id, seasonRateScope)
    : null
  const lastSeasonRate = canShowSeasonRates
    ? getScopedSnapshotRate(snapshots.season_s2, product.product_id, seasonRateScope)
    : null
  const s1Rate = canShowSeasonRates
    ? getScopedSnapshotRate(snapshots.season_s1, product.product_id, seasonRateScope)
    : null

  return {
    ...product,
    has_rolling_stats: Boolean(rolling),
    stats_updated_round_key: rolling && rolling.updated_round_key || '',
    stats_as_of_date: rolling && rolling.as_of_date || '',
    appear_count_7d: rollingStats ? Number(rollingStats.appear_count_7d || 0) : 0,
    appear_count_30d: rollingStats ? Number(rollingStats.appear_count_30d || 0) : 0,
    last_occurrences: rollingStats && Array.isArray(rollingStats.last_occurrences)
      ? rollingStats.last_occurrences
      : [],
    has_season_rates: [currentSeasonRate, lastSeasonRate, s1Rate].some(rate => rate !== null),
    season_rate_scope: seasonRateScope.type,
    season_rate_scope_label: seasonRateScope.label,
    appear_rate_current_season: currentSeasonRate,
    appear_rate_last_season: lastSeasonRate,
    appear_rate_s1: s1Rate,
    season_stats_updated_round_key: snapshots.season_s3 && snapshots.season_s3.updated_round_key || ''
  }
}

function serializeProductCatalogRuntime(runtime = productCatalogRuntime) {
  return {
    version: runtime.version,
    products: runtime.products,
    offers: runtime.offers,
    follow_targets: runtime.followTargets
  }
}

async function loadProductCatalogRuntime(force = false) {
  if (!force && Date.now() - productCatalogRuntime.loadedAt < PRODUCT_CATALOG_CACHE_MS) {
    markUsageCacheHit('product_catalog_runtime')
    return productCatalogRuntime
  }
  if (productCatalogLoadPromise) return productCatalogLoadPromise

  productCatalogLoadPromise = (async () => {
    const [products, offers, meta] = await Promise.all([
      queryAll(COLLECTIONS.productCatalog),
      queryAll(COLLECTIONS.productOffers),
      getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
    ])
    if (!products.length) {
      productCatalogRuntime.loadedAt = Date.now()
      return productCatalogRuntime
    }
    return applyProductCatalogRuntime({
      version: meta && meta.version ? meta.version : `cloud_${Date.now()}`,
      products,
      offers: offers.length ? offers : fallbackProductCatalog.offers,
      follow_targets: meta && Array.isArray(meta.follow_targets)
        ? meta.follow_targets
        : fallbackProductCatalog.follow_targets
    })
  })().finally(() => {
    productCatalogLoadPromise = null
  })
  return productCatalogLoadPromise
}

async function getProductCatalog() {
  const runtime = await loadProductCatalogRuntime()
  const serialized = serializeProductCatalogRuntime(runtime)
  const snapshots = await getProductStatsSnapshots()
  return {
    ...serialized,
    products: serialized.products.map(product => enrichProductWithStats(product, snapshots))
  }
}

async function getProductCatalogV2(event = {}) {
  const runtime = await loadProductCatalogRuntime()
  const serialized = serializeProductCatalogRuntime(runtime)
  if (String(event.ifVersion || '') === String(serialized.version || '')) {
    return {
      version: serialized.version,
      notModified: true
    }
  }
  return {
    ...serialized,
    notModified: false
  }
}

function getProductStatsVersion(snapshots = {}) {
  const rolling = snapshots[PRODUCT_STATS_ROLLING_ID] || {}
  return `${PRODUCT_STATS_ROLLING_ID}:${rolling.updated_round_key || ''}:${rolling.source_round_signature || ''}`
}

function serializeProductStatsFields(product = {}) {
  return {
    product_id: product.product_id,
    has_rolling_stats: product.has_rolling_stats === true,
    stats_updated_round_key: product.stats_updated_round_key || '',
    stats_as_of_date: product.stats_as_of_date || '',
    appear_count_7d: Number(product.appear_count_7d || 0),
    appear_count_30d: Number(product.appear_count_30d || 0),
    last_occurrences: product.last_occurrences || [],
    has_season_rates: product.has_season_rates === true,
    season_rate_scope: product.season_rate_scope || '',
    season_rate_scope_label: product.season_rate_scope_label || '',
    appear_rate_current_season: product.appear_rate_current_season,
    appear_rate_last_season: product.appear_rate_last_season,
    appear_rate_s1: product.appear_rate_s1,
    season_stats_updated_round_key: product.season_stats_updated_round_key || ''
  }
}

async function getProductStatsSnapshotPayload(event = {}) {
  const snapshots = await getProductStatsSnapshots()
  const version = getProductStatsVersion(snapshots)
  if (String(event.ifVersion || '') === version) {
    return { version, notModified: true, products: [] }
  }
  const serialized = serializeProductCatalogRuntime(productCatalogRuntime)
  return {
    version,
    notModified: false,
    products: serialized.products.map(product => {
      return serializeProductStatsFields(enrichProductWithStats(product, snapshots))
    })
  }
}

async function writeDocsInBatches(collectionName, docs, idField) {
  const batchSize = 20
  for (let index = 0; index < docs.length; index += batchSize) {
    const batch = docs.slice(index, index + batchSize)
    await Promise.all(batch.map(doc => setDoc(collectionName, doc[idField], doc)))
  }
}

async function seedProductCatalog(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  if (event.confirmProductCatalogSeed !== true) {
    return fail('请显式传入 confirmProductCatalogSeed: true')
  }

  const now = new Date()
  const overwriteExisting = event.overwriteExisting === true
  const [existingProducts, existingOffers, existingMeta] = await Promise.all([
    queryAll(COLLECTIONS.productCatalog),
    queryAll(COLLECTIONS.productOffers),
    getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
  ])
  const existingProductIds = new Set(existingProducts.map(product => product.product_id || product._id).filter(Boolean))
  const existingOfferIds = new Set(existingOffers.map(offer => offer.offer_id || offer._id).filter(Boolean))
  const products = fallbackProductCatalog.products
    .filter(product => overwriteExisting || !existingProductIds.has(product.product_id))
    .map(product => ({ ...product, updatedAt: now }))
  const offers = fallbackProductCatalog.offers
    .filter(offer => overwriteExisting || !existingOfferIds.has(offer.offer_id))
    .map(offer => ({ ...offer, updatedAt: now }))
  await writeDocsInBatches(COLLECTIONS.productCatalog, products, 'product_id')
  await writeDocsInBatches(COLLECTIONS.productOffers, offers, 'offer_id')
  await setDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID, {
    version: overwriteExisting || !existingProducts.length
      ? fallbackProductCatalog.version
      : (existingMeta && existingMeta.version ? existingMeta.version : `mixed_${fallbackProductCatalog.version}`),
    product_count: new Set(existingProducts.map(product => product.product_id || product._id)
      .concat(fallbackProductCatalog.products.map(product => product.product_id))
      .filter(Boolean)).size,
    offer_count: new Set(existingOffers.map(offer => offer.offer_id || offer._id)
      .concat(fallbackProductCatalog.offers.map(offer => offer.offer_id))
      .filter(Boolean)).size,
    follow_targets: fallbackProductCatalog.follow_targets,
    source: overwriteExisting ? 'bundled_migration_overwrite' : 'bundled_migration_fill_missing',
    updatedAt: now
  })
  const runtime = await loadProductCatalogRuntime(true)
  return ok({
    version: runtime.version,
    productCount: fallbackProductCatalog.products.length,
    offerCount: fallbackProductCatalog.offers.length,
    writtenProducts: products.length,
    writtenOffers: offers.length,
    skippedExistingProducts: fallbackProductCatalog.products.length - products.length,
    skippedExistingOffers: fallbackProductCatalog.offers.length - offers.length,
    overwriteExisting
  }, '商品目录已初始化')
}

async function syncProductCatalogImages(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  if (event.confirmProductImageSync !== true) {
    return fail('请显式传入 confirmProductImageSync: true')
  }

  const bundledProducts = fallbackProductCatalog.products
    .filter(product => product.status !== 'inactive')
  const missingBundledImages = bundledProducts
    .filter(product => !String(product.image_file_id || '').trim())
    .map(product => product.title)
  if (missingBundledImages.length) {
    return fail('商品目录仍有未配置的云存储图片', {
      data: { missingProducts: missingBundledImages }
    })
  }

  const migrationProducts = bundledProducts
    .filter(product => PRODUCT_IMAGE_MIGRATION_SOURCE_BY_TITLE[product.title])
  const migrationResponse = await getShareGoodsImages({
    items: migrationProducts.map(product => ({
      name: product.title,
      image: PRODUCT_IMAGE_MIGRATION_SOURCE_BY_TITLE[product.title]
    }))
  })
  const migrationItems = migrationResponse && migrationResponse.data && Array.isArray(migrationResponse.data.items)
    ? migrationResponse.data.items
    : []
  const migrationByName = new Map(migrationItems.map(item => [item.name, item]))
  const failedMigrations = migrationProducts.filter(product => {
    const item = migrationByName.get(product.title)
    return !item || !item.fileID || item.fileID !== product.image_file_id
  }).map(product => {
    const item = migrationByName.get(product.title) || {}
    return {
      title: product.title,
      expectedFileId: product.image_file_id,
      actualFileId: item.fileID || '',
      error: item.error || '云文件ID与目录映射不一致'
    }
  })
  if (failedMigrations.length) {
    return fail('商品图片补迁未全部完成，未更新商品目录', {
      data: { failedMigrations }
    })
  }

  const [existingProducts, existingMeta] = await Promise.all([
    queryAll(COLLECTIONS.productCatalog),
    getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
  ])
  const existingByProductId = new Map(existingProducts.map(product => [
    product.product_id || product._id,
    product
  ]))
  const missingProducts = bundledProducts
    .filter(product => !existingByProductId.has(product.product_id))
    .map(product => product.title)
  if (missingProducts.length) {
    return fail('云端商品目录缺少商品，未执行图片字段同步', {
      data: { missingProducts }
    })
  }

  const changedProducts = bundledProducts.filter(product => {
    const existing = existingByProductId.get(product.product_id)
    return String(existing.image_file_id || '').trim() !== String(product.image_file_id || '').trim() ||
      String(existing.image_url || '').trim() !== String(product.image_url || '').trim()
  })
  const now = new Date()
  for (let index = 0; index < changedProducts.length; index += 20) {
    const batch = changedProducts.slice(index, index + 20)
    await Promise.all(batch.map(product => {
      const existing = existingByProductId.get(product.product_id)
      return db.collection(COLLECTIONS.productCatalog)
        .doc(existing._id || product.product_id)
        .update({
        data: {
          image_file_id: product.image_file_id,
          image_url: product.image_url,
          updatedAt: now
        }
        })
    }))
  }

  const meta = { ...(existingMeta || {}) }
  delete meta._id
  await setDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID, {
    ...meta,
    version: fallbackProductCatalog.version,
    image_sync_version: fallbackProductCatalog.version,
    image_product_count: bundledProducts.length,
    image_source: 'bundled_cloud_image_map',
    updatedAt: now
  })
  const runtime = await loadProductCatalogRuntime(true)
  return ok({
    version: runtime.version,
    updatedCount: changedProducts.length,
    unchangedCount: bundledProducts.length - changedProducts.length,
    missingCount: 0,
    migratedCount: migrationItems.filter(item => item && item.migrated).length
  }, '商品云存储图片已同步')
}

async function syncProductCatalogStatuses(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  if (event.confirmProductStatusSync !== true) {
    return fail('请显式传入 confirmProductStatusSync: true')
  }

  const bundledProducts = fallbackProductCatalog.products || []
  const [existingProducts, existingMeta] = await Promise.all([
    queryAll(COLLECTIONS.productCatalog),
    getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
  ])
  const existingByProductId = new Map(existingProducts.map(product => [
    product.product_id || product._id,
    product
  ]))
  const missingProducts = bundledProducts
    .filter(product => !existingByProductId.has(product.product_id))
    .map(product => product.title)

  const existingBundledProducts = bundledProducts.filter(product => existingByProductId.has(product.product_id))
  const changedProducts = existingBundledProducts.filter(product => {
    const existing = existingByProductId.get(product.product_id)
    return String(existing.status || 'active') !== String(product.status || 'active')
  })
  const now = new Date()
  for (let index = 0; index < changedProducts.length; index += 20) {
    const batch = changedProducts.slice(index, index + 20)
    await Promise.all(batch.map(product => {
      const existing = existingByProductId.get(product.product_id)
      return db.collection(COLLECTIONS.productCatalog)
        .doc(existing._id || product.product_id)
        .update({
          data: {
            status: product.status || 'active',
            updatedAt: now
          }
        })
    }))
  }

  const meta = { ...(existingMeta || {}) }
  delete meta._id
  await setDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID, {
    ...meta,
    version: fallbackProductCatalog.version,
    status_sync_version: fallbackProductCatalog.version,
    active_product_count: bundledProducts.filter(product => product.status !== 'inactive').length,
    updatedAt: now
  })
  const runtime = await loadProductCatalogRuntime(true)
  return ok({
    version: runtime.version,
    updatedCount: changedProducts.length,
    unchangedCount: existingBundledProducts.length - changedProducts.length,
    missingCount: missingProducts.length,
    missingProducts,
    activeCount: bundledProducts.filter(product => product.status !== 'inactive').length,
    inactiveProducts: bundledProducts
      .filter(product => product.status === 'inactive')
      .map(product => product.title)
  }, '商品启停状态已同步')
}

async function previewCloudProductCatalog(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  const fileID = String(event.cloudFileId || '').trim()
  if (!fileID) return fail('请提供 cloudFileId')
  const download = await cloud.downloadFile({ fileID })
  const buffer = download && download.fileContent
  if (!buffer) return fail('云存储商品 JSON 下载失败')
  const parsed = JSON.parse(Buffer.from(buffer).toString('utf8'))
  const incoming = Array.isArray(parsed) ? parsed : (parsed.products || parsed.data || [])
  if (!Array.isArray(incoming)) return fail('云存储商品 JSON 结构不正确')

  const additions = []
  const conflicts = []
  incoming.forEach(raw => {
    const title = String(raw.title || raw.name || '').trim()
    if (!title) return
    const existing = productCatalogRuntime.byName.get(normalizeMatchText(title))
    if (!existing) {
      additions.push(title)
      return
    }
    ;['category', 'description', 'obtain', 'rarity', 'default_score'].forEach(field => {
      const value = raw[field]
      if (value !== undefined && value !== '' && String(value) !== String(existing[field])) {
        conflicts.push({ title, field, current: existing[field], incoming: value })
      }
    })
  })
  return ok({
    fileID,
    incomingCount: incoming.length,
    additions,
    conflicts,
    canAutoImport: additions.length === 0 && conflicts.length === 0
  }, '云存储商品 JSON 已完成只读对照')
}

function getCategoryByName(name) {
  const product = getCatalogProduct({ name })
  if (product && name && name.includes('炫彩')) return 'limited'
  if (product && product.rarity === 'rare') return 'rare'
  if (name && name.includes('炫彩')) return 'limited'
  if (RARE_NAMES.includes(name)) return 'rare'
  return 'normal'
}

function normalizeImageUrl(url) {
  return url ? String(url).replace(/&amp;/g, '&') : ''
}

function normalizeProp(prop) {
  const rawName = prop && prop.name ? String(prop.name).trim() : ''
  const product = getCatalogProduct(prop || {})
  if (rawName && !product) {
    console.warn(`[product-catalog] unmatched remote product: ${rawName}`)
  }
  const name = product ? product.title : rawName
  const sourceItemId = prop && (prop.item_id || prop._id || prop.id)
  const imageSnapshot = normalizeImageUrl(prop && prop.icon_url)

  return {
    id: prop && (prop._id || prop.id) ? (prop._id || prop.id) : name,
    product_id: product ? product.product_id : '',
    raw_name: rawName,
    source_item_id: sourceItemId === undefined || sourceItemId === null ? '' : String(sourceItemId),
    name,
    category: getCategoryByName(name),
    image: imageSnapshot,
    image_snapshot: imageSnapshot,
    desc: '',
    price: '',
    limit: '',
    icon: name ? name.slice(0, 1) : '',
    isRecommended: product
      ? productCatalogRuntime.recommendedProductIds.has(product.product_id)
      : RECOMMENDED_NAMES.some(keyword => isKeywordMatched(rawName, keyword))
  }
}

function isKeywordMatched(itemName, keyword) {
  if (!itemName || !keyword) return false
  const normalizedItemName = normalizeMatchText(itemName)
  const normalizedKeyword = normalizeMatchText(keyword)
  return normalizedItemName === normalizedKeyword ||
    normalizedItemName.includes(normalizedKeyword) ||
    normalizedItemName.endsWith(normalizedKeyword)
}

function normalizeMatchText(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function getFollowMatcher(name) {
  return FOLLOW_ITEM_MATCHERS.find(item => item.name === name) || { name, keywords: [name] }
}

function getItemKeywords(name, keywords = []) {
  const matcher = getFollowMatcher(name)
  return Array.from(new Set([name]
    .concat(matcher.keywords || [])
    .concat(Array.isArray(keywords) ? keywords : [])
    .filter(keyword => typeof keyword === 'string')
    .map(keyword => keyword.trim())
    .filter(Boolean)))
}

function getAllDayReminderItem(itemName) {
  return ALL_DAY_REMINDER_ITEMS.find(item => {
    return item.keywords.some(keyword => isKeywordMatched(itemName, keyword))
  }) || null
}

function isAllDayReminderRepeatException(date, round, itemName) {
  const allDayItem = getAllDayReminderItem(itemName)
  if (!allDayItem) return false

  return ALL_DAY_REMINDER_REPEAT_EXCEPTIONS.some(exception => {
    return exception.date === date &&
      Number(exception.round) === Number(round) &&
      exception.name === allDayItem.name
  })
}

function getAllDayReminderRoundKeys(date, round, itemName) {
  const keys = []
  for (let currentRound = 1; currentRound < Number(round); currentRound += 1) {
    keys.push(buildRoundKey(date, currentRound))
  }
  return keys
}

function deliveryIncludesItem(delivery, itemName) {
  const itemNames = Array.isArray(delivery && delivery.itemNames) ? delivery.itemNames : []
  return itemNames.some(name => isKeywordMatched(name, itemName))
}

function getAllDaySentSetKey(openid, templateId, itemName) {
  return `${openid}|${itemName}`
}

function isFridayDate(dateText) {
  const value = String(dateText || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T12:00:00Z`).getUTCDay() === 5
}

function isReminderPolicyAllowed(itemName, merchantInfo) {
  const normalizedItemName = normalizeMatchText(itemName)
  const matcher = FOLLOW_ITEM_MATCHERS.find(item => {
    return [item.name].concat(item.keywords || [])
      .some(keyword => normalizeMatchText(keyword) === normalizedItemName)
  })
  if (!matcher || !matcher.reminder_policy) return true
  if (matcher.reminder_policy === 'weekly_friday_round_1') {
    return Number(merchantInfo && merchantInfo.round || 0) === 1 && isFridayDate(merchantInfo && merchantInfo.date)
  }
  return true
}

async function buildAllDaySentReminderSet(merchantInfo) {
  const previousRoundKeys = getAllDayReminderRoundKeys(
    merchantInfo && merchantInfo.date,
    merchantInfo && merchantInfo.round,
    ALL_DAY_REMINDER_ITEMS[0] && ALL_DAY_REMINDER_ITEMS[0].name
  )
  if (!previousRoundKeys.length) return new Set()

  const deliveries = await queryAll(COLLECTIONS.deliveries, {
    status: 'sent',
    roundKey: _.in(previousRoundKeys)
  })
  const sentSet = new Set()
  deliveries.forEach(delivery => {
    ALL_DAY_REMINDER_ITEMS.forEach(item => {
      if (deliveryIncludesItem(delivery, item.name)) {
        sentSet.add(getAllDaySentSetKey(delivery.openid, delivery.templateId, item.name))
      }
    })
  })
  return sentSet
}

function filterAllDayReminderItemsWithSentSet(openid, templateId, merchantInfo, items, sentSet) {
  return (items || []).filter(item => {
    const allDayItem = getAllDayReminderItem(item && item.name)
    return !allDayItem ||
      isAllDayReminderRepeatException(merchantInfo.date, merchantInfo.round, item.name) ||
      !sentSet.has(getAllDaySentSetKey(openid, templateId, allDayItem.name))
  })
}

function hasPropTime(prop) {
  return Number.isFinite(Number(prop && prop.start_time)) && Number.isFinite(Number(prop && prop.end_time))
}

function isPropInCurrentRound(prop, now) {
  if (!hasPropTime(prop)) return false
  const nowTime = now.getTime()
  return nowTime >= Number(prop.start_time) && nowTime < Number(prop.end_time)
}

function dedupeProps(props) {
  const map = new Map()

  props.forEach(prop => {
    if (!prop || !prop.name) return
    const key = prop._id || prop.id || prop.name
    if (!map.has(key)) {
      map.set(key, prop)
    }
  })

  return Array.from(map.values())
}

function getActivityProps(activity) {
  return activity && Array.isArray(activity.get_props) ? activity.get_props : []
}

function getCurrentRoundPropsFromActivities(activities, now) {
  const currentProps = activities.flatMap(activity => {
    return getActivityProps(activity).filter(prop => isPropInCurrentRound(prop, now))
  })

  if (currentProps.length) {
    return dedupeProps(currentProps)
  }

  const firstActivityProps = getActivityProps(activities[0])
  const timedProps = firstActivityProps.filter(hasPropTime)
  return timedProps.length ? [] : dedupeProps(firstActivityProps)
}

function normalizeRemoteItems(raw, now = new Date()) {
  const activities = raw && raw.data && Array.isArray(raw.data.merchantActivities)
    ? raw.data.merchantActivities
    : []
  const currentProps = getCurrentRoundPropsFromActivities(activities, now)

  return currentProps
    .filter(prop => prop && prop.name)
    .map(normalizeProp)
}

function isFixedHotSaleItem(item) {
  const offer = getCatalogOffer(item)
  return Boolean(offer && offer.sale_group === 'fixed-hot')
}

function isDailyHotSaleBall(item) {
  const offer = getCatalogOffer(item)
  return Boolean(offer && offer.sale_group === 'daily-hot')
}

function hasNormalRefreshItem(merchantInfo) {
  const items = merchantInfo && Array.isArray(merchantInfo.items) ? merchantInfo.items : []
  return items.some(item => !isFixedHotSaleItem(item) && !isDailyHotSaleBall(item))
}

function requestJson(url, { apiKey = '', timeoutMs = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'roco-trader-miniprogram-cloud/0.1.0'
    }

    if (apiKey) headers['X-API-Key'] = apiKey

    const req = https.get(url, { headers, timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Remote API returned HTTP ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`Remote API returned invalid JSON: ${error.message}`))
        }
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error(`Remote API timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
  })
}

function postJson(url, body, { timeoutMs = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {})
    const req = https.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'roco-trader-miniprogram-cloud/0.1.0'
      }
    }, res => {
      let responseBody = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        responseBody += chunk
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 300)}`))
          return
        }
        try {
          resolve(JSON.parse(responseBody))
        } catch (error) {
          reject(new Error(`Remote API returned invalid JSON: ${error.message}`))
        }
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error(`Remote API timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function getWechatAccessToken() {
  const now = Date.now()
  if (wechatAccessTokenCache.token && wechatAccessTokenCache.expiresAt - now > 5 * 60 * 1000) {
    return wechatAccessTokenCache.token
  }

  const appid = process.env.WECHAT_APP_ID || ''
  const secret = process.env.WECHAT_APP_SECRET || ''
  if (!appid || !secret) {
    throw new Error('WECHAT_APP_ID or WECHAT_APP_SECRET is not configured for HTTPS subscribe message fallback')
  }

  const result = await postJson(WECHAT_STABLE_TOKEN_URL, {
    grant_type: 'client_credential',
    appid,
    secret,
    force_refresh: false
  }, {
    timeoutMs: Number(process.env.WECHAT_TIMEOUT_MS || 9000)
  })

  if (result.errcode) {
    throw new Error(`WeChat stable_token failed: ${result.errcode} ${result.errmsg || ''}`.trim())
  }
  if (!result.access_token) {
    throw new Error('WeChat stable_token did not return access_token')
  }

  wechatAccessTokenCache = {
    token: result.access_token,
    expiresAt: now + Number(result.expires_in || 7200) * 1000
  }
  return wechatAccessTokenCache.token
}

async function fetchRocomMerchantInfo() {
  markUsageSource('rocom_remote')
  const baseUrl = String(process.env.ROCOM_API_BASE_URL || DEFAULT_ROCOM_BASE_URL).replace(/\/+$/, '')
  const raw = await requestJson(`${baseUrl}${MERCHANT_INFO_PATH}`, {
    apiKey: process.env.ROCOM_API_KEY || '',
    timeoutMs: Number(process.env.ROCOM_TIMEOUT_MS || 9000)
  })

  if (!raw || typeof raw !== 'object') {
    throw new Error('Remote API returned empty response')
  }
  if (raw.code !== 0) {
    throw new Error(`Remote API returned code ${raw.code}`)
  }

  return raw
}

function buildRoundKey(date, round) {
  return `${date}_round_${round}`
}

function parseRoundKey(roundKey) {
  const match = String(roundKey || '').trim().match(/^(\d{4}-\d{2}-\d{2})_round_(\d+)$/)
  if (!match) return null
  return {
    date: match[1],
    round: Number(match[2])
  }
}

function getCurrentRoundKey(now = new Date()) {
  const roundInfo = getCurrentRoundInfo(now)
  if (roundInfo.status !== 'active' || !roundInfo.round) return ''
  return buildRoundKey(formatChinaDate(now), roundInfo.round)
}

function getRoundVoteDocId(openid, roundKey) {
  return `round_vote_${encodeDocId(`${openid}|${roundKey}`)}`
}

function getRoundVoteSummaryDocId(roundKey) {
  return `round_vote_summary_${roundKey}`
}

function isValidVoteChoice(choice) {
  return ROUND_VOTE_OPTIONS.some(option => option.key === choice)
}

function createEmptyVoteCounts() {
  return ROUND_VOTE_OPTIONS.reduce((counts, option) => {
    counts[option.key] = 0
    return counts
  }, {})
}

function normalizeVoteCounts(counts = {}) {
  const normalized = createEmptyVoteCounts()
  ROUND_VOTE_OPTIONS.forEach(option => {
    const value = Number(counts && counts[option.key])
    normalized[option.key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  })
  return normalized
}

function buildVotePercentMap(counts, total) {
  const percentMap = createEmptyVoteCounts()
  if (!total) return percentMap

  const parts = ROUND_VOTE_OPTIONS.map((option, index) => {
    const exact = counts[option.key] * 100 / total
    return {
      key: option.key,
      index,
      floor: Math.floor(exact),
      remainder: exact - Math.floor(exact)
    }
  })
  let used = parts.reduce((sum, part) => sum + part.floor, 0)
  parts.forEach(part => {
    percentMap[part.key] = part.floor
  })
  parts
    .slice()
    .sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder
      return a.index - b.index
    })
    .slice(0, Math.max(0, 100 - used))
    .forEach(part => {
      percentMap[part.key] += 1
      used += 1
    })
  return percentMap
}

function buildRoundVoteSummary(roundKey, counts = {}, myChoice = '') {
  const parsed = parseRoundKey(roundKey) || {}
  const normalizedCounts = normalizeVoteCounts(counts)
  const total = ROUND_VOTE_OPTIONS.reduce((sum, option) => sum + normalizedCounts[option.key], 0)
  const percents = buildVotePercentMap(normalizedCounts, total)
  const options = ROUND_VOTE_OPTIONS.map(option => ({
    ...option,
    count: normalizedCounts[option.key],
    percent: percents[option.key],
    selected: myChoice === option.key
  }))
  const topChoice = total
    ? options.slice().sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return ROUND_VOTE_OPTIONS.findIndex(option => option.key === a.key) -
        ROUND_VOTE_OPTIONS.findIndex(option => option.key === b.key)
    })[0]
    : null

  return {
    roundKey,
    date: parsed.date || '',
    round: parsed.round || null,
    total,
    myChoice: isValidVoteChoice(myChoice) ? myChoice : '',
    options,
    topChoice: topChoice ? {
      key: topChoice.key,
      label: topChoice.label,
      count: topChoice.count,
      percent: topChoice.percent
    } : null,
    topText: topChoice ? `${topChoice.label} ${topChoice.percent}%` : ''
  }
}

function summarizeRoundVotes(roundKey, votes = [], openid = '') {
  const counts = createEmptyVoteCounts()
  let myChoice = ''

  votes.forEach(vote => {
    const choice = vote && vote.choice
    if (!isValidVoteChoice(choice)) return
    counts[choice] += 1
    if (openid && vote.openid === openid) {
      myChoice = choice
    }
  })

  return buildRoundVoteSummary(roundKey, counts, myChoice)
}

async function setRoundVoteSummaryInTransaction(transaction, roundKey, choice, parsed, now) {
  const summaryId = getRoundVoteSummaryDocId(roundKey)
  const existing = await getTransactionDoc(transaction, COLLECTIONS.roundVoteSummaries, summaryId)
  const counts = normalizeVoteCounts(existing && existing.counts)
  counts[choice] += 1

  await setTransactionDoc(transaction, COLLECTIONS.roundVoteSummaries, summaryId, {
    summaryId,
    roundKey,
    date: parsed.date,
    round: parsed.round,
    counts,
    total: ROUND_VOTE_OPTIONS.reduce((sum, option) => sum + counts[option.key], 0),
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now
  })
}

async function queryVoteSummariesByRoundKeys(roundKeys) {
  const keys = Array.from(new Set((roundKeys || []).filter(isValidHistoryRoundKey)))
  if (!keys.length) return []

  const summaries = []
  for (let index = 0; index < keys.length; index += VOTE_ROUND_KEY_BATCH_SIZE) {
    const batch = keys.slice(index, index + VOTE_ROUND_KEY_BATCH_SIZE)
    summaries.push(...await queryAll(COLLECTIONS.roundVoteSummaries, { roundKey: _.in(batch) }))
  }
  return summaries
}

async function getVoteChoiceForRound(roundKey, openid = '') {
  if (!openid) return ''
  const vote = await getDoc(COLLECTIONS.roundVotes, getRoundVoteDocId(openid, roundKey))
  return vote && isValidVoteChoice(vote.choice) ? vote.choice : ''
}

async function getVoteSummaryForRound(roundKey, openid = '') {
  if (!isValidHistoryRoundKey(roundKey)) {
    throw new Error('roundKey 格式不正确')
  }
  const summary = await getDoc(COLLECTIONS.roundVoteSummaries, getRoundVoteSummaryDocId(roundKey))
  const myChoice = await getVoteChoiceForRound(roundKey, openid)
  return buildRoundVoteSummary(roundKey, summary && summary.counts, myChoice)
}

async function getVoteSummariesForRecords(records) {
  const roundKeys = Array.from(new Set((records || [])
    .map(record => record && record.roundKey)
    .filter(isValidHistoryRoundKey)))
  if (!roundKeys.length) return {}

  const summaries = await queryVoteSummariesByRoundKeys(roundKeys)
  const summaryByRoundKey = summaries.reduce((map, summary) => {
    if (summary && summary.roundKey) map[summary.roundKey] = summary
    return map
  }, {})
  return roundKeys.reduce((map, roundKey) => {
    const summary = buildRoundVoteSummary(roundKey, summaryByRoundKey[roundKey] && summaryByRoundKey[roundKey].counts)
    if (summary.total > 0) {
      map[roundKey] = summary
    }
    return map
  }, {})
}

async function attachVoteSummaries(records) {
  const voteSummaries = await getVoteSummariesForRecords(records)
  return (records || []).map(record => ({
    ...record,
    voteSummary: voteSummaries[record.roundKey] || null
  }))
}

function getRoundJobId(date, round) {
  return buildRoundKey(date, round)
}

async function getRoundJob(date, round) {
  return getDoc(COLLECTIONS.jobs, getRoundJobId(date, round))
}

function getNotificationStatusForJob(status, notification) {
  if (!notification) return 'pending'
  if (status === 'processing') return 'processing'
  if (status === 'retrying' || Number(notification.failed || 0) > 0) return 'retrying'
  if (Number(notification.pending || 0) > 0 || Number(notification.retryableFailed || 0) > 0) return 'retrying'
  if (Number(notification.finalFailed || 0) > 0) return 'completed_with_final_failures'
  return 'completed'
}

function isRoundNotificationCompleted(job) {
  if (!job) return false
  const notificationStatus = job.notificationStatus || ''
  if (['completed', 'completed_with_final_failures'].includes(notificationStatus)) return true

  return job.status === 'success' && job.notified === true && Boolean(job.notification)
}

function hasTrustedTimerCollection(job) {
  if (!job || job.manual === true || job.fetched !== true || Number(job.itemCount || 0) <= 0) return false
  return Array.isArray(job.attemptMinutes) && job.attemptMinutes.some(minute => RETRY_MINUTES.includes(Number(minute)))
}

async function recordRoundJobAttempt({ merchantInfo, attemptMinute, status, notification = null, error = null, manual = false }) {
  if (!merchantInfo || !merchantInfo.date || !merchantInfo.round) return

  const docId = getRoundJobId(merchantInfo.date, merchantInfo.round)
  const existing = await getDoc(COLLECTIONS.jobs, docId)
  const now = new Date()
  const existingNotification = existing && existing.notification ? existing.notification : null
  let persistedNotification = notification
  if (!persistedNotification && existingNotification) {
    persistedNotification = existingNotification
  } else if (persistedNotification && existingNotification && existingNotification.roundItemSnapshotRecorded === true) {
    persistedNotification = {
      ...notification,
      roundItems: existingNotification.roundItems,
      roundItemTotals: existingNotification.roundItemTotals || {
        subscriptionCount: 0,
        pushableCount: 0
      },
      roundItemSnapshotRecorded: true
    }
  }
  const notificationStatus = getNotificationStatusForJob(status, persistedNotification)
  const attemptMinutes = Array.from(new Set((existing && Array.isArray(existing.attemptMinutes) ? existing.attemptMinutes : [])
    .concat(Number.isFinite(Number(attemptMinute)) ? [Number(attemptMinute)] : [])))
    .sort((a, b) => a - b)

  await setDoc(COLLECTIONS.jobs, docId, {
    roundKey: docId,
    date: merchantInfo.date,
    round: merchantInfo.round,
    timeRange: merchantInfo.timeRange || '',
    status,
    notificationStage: notificationStatus === 'completed' || notificationStatus === 'completed_with_final_failures'
      ? 'completed'
      : (notification ? (Number(notification.materialized || 0) > 0 ? 'dispatching' : 'materializing') : 'collecting'),
    fetched: Array.isArray(merchantInfo.items) && merchantInfo.items.length > 0,
    notified: ['completed', 'completed_with_final_failures'].includes(notificationStatus),
    notificationStatus,
    attemptMinutes,
    itemCount: Array.isArray(merchantInfo.items) ? merchantInfo.items.length : 0,
    notification: persistedNotification,
    lastError: error ? String(error.message || error) : '',
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    capturedAt: existing && existing.capturedAt ? existing.capturedAt : (Array.isArray(merchantInfo.items) && merchantInfo.items.length > 0 ? now : null),
    dispatchDeadlineAt: existing && existing.dispatchDeadlineAt
      ? existing.dispatchDeadlineAt
      : (Array.isArray(merchantInfo.items) && merchantInfo.items.length > 0 ? new Date(now.getTime() + DISPATCH_WINDOW_MS) : null),
    lastAttemptAt: now,
    processedAt: status === 'success' ? now : (existing && existing.processedAt ? existing.processedAt : null),
    ...(manual ? { manual: true } : {})
  })
}

function buildBaseMerchant(roundInfo, now = new Date()) {
  return {
    date: formatChinaDate(now),
    currentTime: formatChinaTime(now),
    round: roundInfo.round,
    timeRange: roundInfo.timeRange,
    status: roundInfo.status
  }
}

async function getHistoryRecord(date, round) {
  return getDoc(COLLECTIONS.history, buildRoundKey(date, round))
}

async function recordMerchantSnapshot(snapshot) {
  if (!snapshot || snapshot.status !== 'active' || !snapshot.round || !Array.isArray(snapshot.items)) return

  const roundKey = buildRoundKey(snapshot.date, snapshot.round)
  const snapshotSignature = crypto.createHash('sha1').update(JSON.stringify({
    roundKey,
    manualOverride: snapshot.manualOverride === true,
    items: snapshot.items.map(item => ({
      id: String(item && (item.product_id || item.id || item._id) || ''),
      name: String(item && (item.raw_name || item.name || item.title) || ''),
      saleGroup: String(item && (item.saleGroup || item.sale_group) || ''),
      price: Number(item && item.price || 0),
      buyLimit: Number(item && (item.buyLimit || item.buy_limit) || 0)
    })).sort((a, b) => `${a.id}|${a.name}`.localeCompare(`${b.id}|${b.name}`))
  })).digest('hex')
  const existing = await getDoc(COLLECTIONS.history, roundKey)
  if (existing && existing.snapshotSignature === snapshotSignature) {
    markUsageCacheHit('merchant_snapshot_unchanged')
    return { changed: false, roundKey, snapshotSignature }
  }
  const now = new Date()
  const record = {
    roundKey,
    date: snapshot.date,
    round: snapshot.round,
    timeRange: snapshot.timeRange,
    status: snapshot.status,
    source: snapshot.source || '',
    fetchedAt: now,
    capturedAt: now,
    items: snapshot.items,
    snapshotSignature,
    manualOverride: snapshot.manualOverride === true,
    manualBy: snapshot.manualOverride === true ? String(snapshot.manualBy || '') : '',
    manualAt: snapshot.manualOverride === true ? (snapshot.manualAt || now) : null
  }
  await setDoc(COLLECTIONS.history, roundKey, record)
  await updateHistoryBundles(record)
  try {
    await updateProductStatsSnapshots(record)
  } catch (error) {
    console.warn(`[product-stats] snapshot update skipped: ${error.message}`)
  }
  return { changed: true, roundKey, snapshotSignature }
}

function resolveVoteSummaryRoundKey(event = {}, now = new Date()) {
  const requestedRoundKey = typeof event.roundKey === 'string' ? event.roundKey.trim() : ''
  if (requestedRoundKey) {
    if (!isValidHistoryRoundKey(requestedRoundKey)) {
      throw new Error('roundKey 格式不正确')
    }
    return requestedRoundKey
  }
  const roundKey = getCurrentRoundKey(now)
  if (!roundKey) {
    throw new Error('当前为空档期')
  }
  return roundKey
}

function resolveVoteSubmitRoundKey(event = {}, now = new Date()) {
  const currentRoundKey = getCurrentRoundKey(now)
  if (!currentRoundKey) {
    throw new Error('当前为空档期，不能记录印象')
  }
  const requestedRoundKey = typeof event.roundKey === 'string' ? event.roundKey.trim() : currentRoundKey
  if (!isValidHistoryRoundKey(requestedRoundKey)) {
    throw new Error('roundKey 格式不正确')
  }
  if (requestedRoundKey !== currentRoundKey) {
    throw new Error('只能记录当前轮次印象')
  }
  return currentRoundKey
}

async function getRoundVoteSummary(event = {}, openid = '') {
  const roundKey = resolveVoteSummaryRoundKey(event)
  return getVoteSummaryForRound(roundKey, openid)
}

async function submitRoundVote(event = {}, openid = '') {
  if (!openid) return fail('无法识别用户')

  const choice = typeof event.choice === 'string' ? event.choice.trim() : ''
  if (!isValidVoteChoice(choice)) {
    return fail('印象选项不正确')
  }

  const roundKey = resolveVoteSubmitRoundKey(event)
  const parsed = parseRoundKey(roundKey)
  const voteId = getRoundVoteDocId(openid, roundKey)
  await ensureCollectionExists(COLLECTIONS.roundVotes)
  await ensureCollectionExists(COLLECTIONS.roundVoteSummaries)

  const result = await db.runTransaction(async transaction => {
    const existing = await getTransactionDoc(transaction, COLLECTIONS.roundVotes, voteId)
    if (existing && existing.choice) {
      return {
        created: false,
        choice: existing.choice
      }
    }

    const now = new Date()
    await setTransactionDoc(transaction, COLLECTIONS.roundVotes, voteId, {
      voteId,
      openid,
      roundKey,
      date: parsed.date,
      round: parsed.round,
      choice,
      createdAt: now,
      updatedAt: now
    })
    await setRoundVoteSummaryInTransaction(transaction, roundKey, choice, parsed, now)
    return {
      created: true,
      choice
    }
  })

  const summary = await getVoteSummaryForRound(roundKey, openid)
  return ok({
    created: result.created,
    choice: result.choice,
    summary
  }, result.created ? '印象已记录' : '你已经记录过本轮商品')
}

async function collectCurrentMerchant(now = new Date()) {
  const roundInfo = getCurrentRoundInfo(now)
  const base = buildBaseMerchant(roundInfo, now)

  if (roundInfo.status === 'inactive') {
    return {
      ...base,
      items: [],
      message: '远行商人暂未开启',
      source: 'cloud'
    }
  }

  const manualMerchant = await getLockedManualMerchant(base)
  if (manualMerchant) return manualMerchant

  const raw = await fetchRocomMerchantInfo()
  const items = normalizeRemoteItems(raw, now)
  if (!items.length && page === 1 && !event.cursor) {
    throw new Error('Remote API returned no props for the current round')
  }

  const result = {
    ...base,
    items,
    source: 'rocom_remote'
  }
  if (hasNormalRefreshItem(result) || getChinaParts(now).minute >= FINAL_RETRY_MINUTE) {
    await recordMerchantSnapshot(result)
  }
  return result
}

async function getLockedManualMerchant(base) {
  if (!base || base.status !== 'active' || !base.date || !base.round) return null
  const historyRecord = await getHistoryRecord(base.date, base.round)
  if (!historyRecord || historyRecord.manualOverride !== true || !Array.isArray(historyRecord.items) || !historyRecord.items.length) {
    return null
  }
  return {
    ...base,
    items: historyRecord.items,
    source: 'admin_manual',
    manualOverride: true,
    manualBy: historyRecord.manualBy || '',
    manualAt: historyRecord.manualAt || historyRecord.capturedAt || ''
  }
}

async function fetchCurrentMerchantSnapshot(now = new Date()) {
  const roundInfo = getCurrentRoundInfo(now)
  const base = buildBaseMerchant(roundInfo, now)

  if (roundInfo.status === 'inactive') {
    return {
      ...base,
      items: [],
      message: '远行商人暂未开启',
      source: 'cloud'
    }
  }

  const manualMerchant = await getLockedManualMerchant(base)
  if (manualMerchant) return manualMerchant

  const raw = await fetchRocomMerchantInfo()
  const items = normalizeRemoteItems(raw, now)
  if (!items.length) {
    throw new Error('Remote API returned no props for the current round')
  }

  return {
    ...base,
    items,
    source: 'rocom_remote'
  }
}

async function getCurrentMerchant(now = new Date()) {
  const roundInfo = getCurrentRoundInfo(now)
  const base = buildBaseMerchant(roundInfo, now)

  if (roundInfo.status === 'inactive') {
    markUsageSource('inactive_schedule')
    return {
      ...base,
      items: [],
      message: '远行商人暂未开启',
      source: 'cloud',
      pending: false
    }
  }

  const historyRecord = await getHistoryRecord(base.date, roundInfo.round)
  if (historyRecord && historyRecord.items && historyRecord.items.length) {
    markUsageSource('merchant_history')
    return {
      ...base,
      items: historyRecord.items,
      source: historyRecord.source || 'history',
      pending: false
    }
  }
  markUsageSource('merchant_pending')
  return {
    ...base,
    items: [],
    source: 'pending',
    pending: true,
    message: '本轮商品同步中'
  }
}

async function getHistoryRecords() {
  const records = await queryAll(COLLECTIONS.history)
  const formattedRecords = records
    .map(formatHistoryRecord)
    .sort(compareHistoryRecord)
  return attachVoteSummaries(formattedRecords)
}

function isValidHistoryRoundKey(roundKey) {
  return /^(\d{4}-\d{2}-\d{2})_round_([1-4])$/.test(String(roundKey || ''))
}

function compareHistoryRecord(a, b) {
  const dateCompare = String(b.date).localeCompare(String(a.date))
  if (dateCompare !== 0) return dateCompare
  return Number(b.round || 0) - Number(a.round || 0)
}

function formatHistoryRecord(record) {
  return {
    roundKey: record.roundKey || record._id,
    date: record.date,
    round: record.round,
    timeRange: record.timeRange,
    status: record.status || 'active',
    items: record.items || [],
    source: record.source || '',
    fetchedAt: record.fetchedAt || record.capturedAt || '',
    voteSummary: record.voteSummary || null
  }
}

function sortHistoryRecords(records) {
  return (records || []).slice().sort(compareHistoryRecord)
}

function mergeHistoryBundleRecords(existingRecords, nextRecord, limit = Infinity) {
  const map = new Map()
  ;(existingRecords || []).concat(nextRecord ? [nextRecord] : []).forEach(record => {
    const formatted = formatHistoryRecord(record)
    if (formatted.roundKey) {
      map.set(formatted.roundKey, formatted)
    }
  })
  return sortHistoryRecords(Array.from(map.values())).slice(0, limit)
}

function hasHistoryRecord(records, roundKey) {
  return (records || []).some(record => (record.roundKey || record._id) === roundKey)
}

function getHistoryBundleMeta(records) {
  const latest = records && records[0]
  const oldest = records && records.length ? records[records.length - 1] : null
  return {
    latestRoundKey: latest ? latest.roundKey : '',
    oldestRoundKey: oldest ? oldest.roundKey : ''
  }
}

function getHistoryMonthFromRecord(record) {
  return record && record.date ? String(record.date).slice(0, 7) : ''
}

function getHistoryMonthBundleId(month) {
  return /^(\d{4})-(\d{2})$/.test(String(month || '')) ? `month_${month}` : ''
}

const PRODUCT_STATS_ROLLING_ID = 'rolling'

async function getProductStatsSnapshots() {
  const ids = [PRODUCT_STATS_ROLLING_ID].concat(PRODUCT_STATS_SEASONS.map(season => season.id))
  const snapshots = await Promise.all(ids.map(id => getDoc(COLLECTIONS.productStatsSnapshots, id)))
  return ids.reduce((result, id, index) => {
    result[id] = snapshots[index]
    return result
  }, {})
}

function getProductStatsRoundSignature(record) {
  const itemKeys = (record && record.items || []).map(item => {
    const product = resolveProductForStats(item)
    if (product) return `${product.product_id}:${product.sale_group}`
    return `unknown:${normalizeMatchText(item && (item.raw_name || item.name || item.title))}`
  }).filter(Boolean).sort()
  return crypto.createHash('sha1')
    .update(`${record && (record.roundKey || record._id) || ''}|${itemKeys.join(',')}`)
    .digest('hex')
}

function getLatestStatsRecord(records) {
  return sortHistoryRecords(records || [])[0] || null
}

function decorateProductStatsSnapshot(snapshot, records) {
  const latestRecord = getLatestStatsRecord(records)
  return {
    ...snapshot,
    source_round_signature: getProductStatsRoundSignature(latestRecord),
    updatedAt: new Date()
  }
}

async function getSeasonBundleRecords(season) {
  const bundles = await Promise.all(getSeasonMonths(season).map(month => {
    return getDoc(COLLECTIONS.historyBundles, getHistoryMonthBundleId(month))
  }))
  return bundles.flatMap(bundle => bundle && Array.isArray(bundle.records) ? bundle.records : [])
}

function getS1CountOverrides() {
  const prismProduct = productCatalogRuntime.products.find(product => normalizeMatchText(product.title) === '棱镜球')
  if (!prismProduct) return { countOverrides: {}, manualCorrections: {} }
  return {
    countOverrides: { [prismProduct.product_id]: 2 },
    manualCorrections: { [prismProduct.product_id]: 'S1棱镜球固定校正为2次' }
  }
}

async function writeProductStatsSnapshot(id, snapshot, records, previous = null) {
  const decorated = decorateProductStatsSnapshot(snapshot, records)
  if (
    previous &&
    previous.updated_round_key === decorated.updated_round_key &&
    previous.source_round_signature === decorated.source_round_signature
  ) {
    return false
  }
  await setDoc(COLLECTIONS.productStatsSnapshots, id, decorated)
  return true
}

async function updateProductStatsSnapshots(record) {
  const recentBundle = await getDoc(COLLECTIONS.historyBundles, HISTORY_RECENT_BUNDLE_ID)
  const recentRecords = recentBundle && Array.isArray(recentBundle.records) ? recentBundle.records : []
  const previousRolling = await getDoc(COLLECTIONS.productStatsSnapshots, PRODUCT_STATS_ROLLING_ID)
  const rolling = mergeRollingSnapshot(
    previousRolling,
    buildRollingSnapshot(recentRecords, resolveProductForStats)
  )
  const rollingUpdated = await writeProductStatsSnapshot(
    PRODUCT_STATS_ROLLING_ID,
    rolling,
    recentRecords,
    previousRolling
  )

  const currentSeason = PRODUCT_STATS_SEASONS.find(season => {
    return record && record.date >= season.startDate && record.date <= season.endDate
  })
  let seasonUpdated = false
  if (currentSeason && currentSeason.key === 's3') {
    const seasonRecords = await getSeasonBundleRecords(currentSeason)
    const previousSeason = await getDoc(COLLECTIONS.productStatsSnapshots, currentSeason.id)
    seasonUpdated = await writeProductStatsSnapshot(
      currentSeason.id,
      buildSeasonSnapshot(currentSeason, seasonRecords, resolveProductForStats),
      seasonRecords,
      previousSeason
    )
  }

  return { rollingUpdated, seasonUpdated }
}

function buildHistoryBundlePayload(id, records) {
  const sortedRecords = sortHistoryRecords(records || [])
  const meta = getHistoryBundleMeta(sortedRecords)
  return {
    bundleId: id,
    records: sortedRecords,
    recordCount: sortedRecords.length,
    ...meta,
    updatedAt: new Date()
  }
}

async function setHistoryBundle(id, records) {
  await setDoc(COLLECTIONS.historyBundles, id, buildHistoryBundlePayload(id, records))
}

async function updateHistoryBundle(id, record, limit = Infinity) {
  if (!id || !record) return
  const existing = await getDoc(COLLECTIONS.historyBundles, id)
  const records = mergeHistoryBundleRecords(existing && existing.records, record, limit)
  await setHistoryBundle(id, records)
}

async function updateHistoryBundles(record) {
  await updateHistoryBundle(HISTORY_RECENT_BUNDLE_ID, record, HISTORY_RECENT_BUNDLE_LIMIT)
  const month = getHistoryMonthFromRecord(record)
  const monthBundleId = getHistoryMonthBundleId(month)
  if (monthBundleId) {
    await updateHistoryBundle(monthBundleId, record)
  }
}

async function getHistoryBundle(event = {}) {
  const month = typeof event.month === 'string' ? event.month.trim() : ''
  const monthBundleId = month ? getHistoryMonthBundleId(month) : ''
  const bundleId = month ? monthBundleId : HISTORY_RECENT_BUNDLE_ID
  if (!bundleId) {
    throw new Error('history bundle month 格式不正确')
  }

  const bundle = await getDoc(COLLECTIONS.historyBundles, bundleId)
  const records = bundle && Array.isArray(bundle.records)
    ? sortHistoryRecords(bundle.records.map(formatHistoryRecord))
    : []
  const currentRoundKey = month ? '' : getCurrentRoundKey()
  const includedCurrentRoundKey = currentRoundKey && hasHistoryRecord(records, currentRoundKey)
    ? currentRoundKey
    : ''
  const meta = getHistoryBundleMeta(records)
  markUsageSource(bundle ? 'history_bundle' : 'history_bundle_missing')
  return {
    bundleId,
    month: month || '',
    records: await attachVoteSummaries(records),
    currentRoundKey,
    includedCurrentRoundKey,
    ...meta,
    updatedAt: bundle && bundle.updatedAt ? bundle.updatedAt : '',
    pending: !bundle
  }
}

async function getHistoryRecordsByKeys(event) {
  const roundKeys = Array.from(new Set((event.roundKeys || [])
    .filter(key => typeof key === 'string')
    .map(key => key.trim())
    .filter(isValidHistoryRoundKey)))
    .slice(0, HISTORY_BY_KEYS_LIMIT)

  if (!roundKeys.length) return []

  const records = []
  for (let index = 0; index < roundKeys.length; index += HISTORY_BY_KEYS_BATCH_SIZE) {
    const batch = roundKeys.slice(index, index + HISTORY_BY_KEYS_BATCH_SIZE)
    records.push(...await queryAll(COLLECTIONS.history, { roundKey: _.in(batch) }, batch.length))
  }
  const formattedRecords = records
    .filter(record => record && record.items && record.items.length)
    .map(formatHistoryRecord)
    .sort((a, b) => {
      const dateCompare = String(b.date).localeCompare(String(a.date))
      if (dateCompare !== 0) return dateCompare
      return Number(b.round || 0) - Number(a.round || 0)
    })
  return attachVoteSummaries(formattedRecords)
}

async function getRecommendedStats() {
  const records = await getHistoryRecords()
  const recommendedNames = productCatalogRuntime.followTargets
    .filter(target => target.group === 'recommended')
    .map(target => target.name)

  return recommendedNames.map(name => {
    const keywords = getItemKeywords(name)
    const allDayItem = ALL_DAY_REMINDER_ITEMS.find(item => {
      return keywords.some(keyword => item.keywords.some(itemKeyword => isKeywordMatched(keyword, itemKeyword)))
    })
    const appearances = records.filter(record => {
      return (record.items || []).some(item => {
        return keywords.some(keyword => isKeywordMatched(item.name, keyword))
      })
    })
    const lastSeen = appearances[0]
    const count = allDayItem
      ? new Set(appearances.map(record => record.date).filter(Boolean)).size
      : appearances.length

    if (!lastSeen) {
      return {
        name,
        count: 0,
        lastSeenDate: '',
        lastSeenRound: null,
        lastSeenTimeRange: '',
        lastSeenText: '暂无出现记录',
        statusText: '暂无出现记录'
      }
    }

    return {
      name,
      count,
      lastSeenDate: lastSeen.date,
      lastSeenRound: lastSeen.round,
      lastSeenTimeRange: lastSeen.timeRange,
      lastSeenText: `${lastSeen.date} 第${lastSeen.round}轮`,
      statusText: `累计出现 ${count} 次`
    }
  })
}

function normalizeFollowedItems(items) {
  return Array.from(new Map((items || [])
    .map(item => {
      if (typeof item === 'string') {
        const name = item.trim()
        return name ? [name, { name, keywords: [name] }] : null
      }

      const name = item && typeof item.name === 'string' ? item.name.trim() : ''
      if (!name) return null

      const keywords = getItemKeywords(name, item.keywords)

      return [name, { name, keywords }]
    })
    .filter(Boolean)).values())
}

function getTemplateId(event) {
  return String((event && event.templateId) || (SUBSCRIBE_TEMPLATE_CONFIGS[0] && SUBSCRIBE_TEMPLATE_CONFIGS[0].templateId) || '').trim()
}

function getSubscribeTemplateConfig(templateId) {
  return SUBSCRIBE_TEMPLATE_CONFIGS.find(config => config.templateId === templateId) || null
}

function getConfiguredTemplateIds() {
  return SUBSCRIBE_TEMPLATE_CONFIGS.map(config => config.templateId)
}

function getAcceptedTemplateIds(event = {}) {
  const requested = Array.isArray(event.acceptedTemplateIds)
    ? event.acceptedTemplateIds
    : [event.templateId || getTemplateId(event)]
  const configuredIds = new Set(getConfiguredTemplateIds())
  return Array.from(new Set(requested
    .map(templateId => String(templateId || '').trim())
    .filter(templateId => configuredIds.has(templateId))))
}

function getQuotaDocId(openid, templateId) {
  return `quota_${encodeDocId(`${openid}|${templateId}`)}`
}

async function saveUser(openid) {
  const existing = await getDoc(COLLECTIONS.users, openid)
  if (existing) return { created: false }
  const now = new Date()
  await setDoc(COLLECTIONS.users, openid, {
    openid,
    createdAt: now,
    updatedAt: now
  })
  return { created: true }
}

async function replaceEnabledSubscriptions(openid, followedItems, templateId) {
  const now = new Date()
  const existingSubscriptions = await queryAll(COLLECTIONS.subscriptions, { openid, templateId })
  const nextIds = new Set(followedItems.map(item => `sub_${encodeDocId(`${openid}|${templateId}|${item.name}`)}`))
  const existingById = new Map(existingSubscriptions.map(subscription => [subscription._id, subscription]))
  const writes = []

  existingSubscriptions.forEach(subscription => {
    if (subscription.enabled !== true || nextIds.has(subscription._id)) return
    writes.push(setDoc(COLLECTIONS.subscriptions, subscription._id, {
      ...subscription,
      enabled: false,
      updatedAt: now
    }))
  })

  followedItems.forEach(item => {
    const docId = `sub_${encodeDocId(`${openid}|${templateId}|${item.name}`)}`
    const existing = existingById.get(docId)
    const keywords = item.keywords || [item.name]
    if (existing && existing.enabled === true && getFollowedItemsSignature([{
      name: existing.itemName || existing.item_name,
      keywords: existing.keywords || []
    }]) === getFollowedItemsSignature([{ name: item.name, keywords }])) return
    writes.push(setDoc(COLLECTIONS.subscriptions, docId, {
      openid,
      itemName: item.name,
      keywords,
      templateId,
      enabled: true,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now
    }))
  })
  await Promise.all(writes)
  return writes.length
}

function getSubscriptionTargetDocId(openid, templateId) {
  return `target_${encodeDocId(`${openid}|${templateId}`)}`
}

function getFollowedItemsSignature(items) {
  return normalizeFollowedItems(items)
    .map(item => ({
      name: item.name,
      keywords: Array.from(new Set(item.keywords || [item.name])).sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(item => `${item.name}:${item.keywords.join(',')}`)
    .join('|')
}

function getTargetFollowedItems(target) {
  if (!target || target.enabled !== true || !Array.isArray(target.items)) return []
  return target.items.map(item => ({
    name: item.itemName || item.item_name || item.name || '',
    keywords: item.keywords || []
  }))
}

async function syncSubscriptionItemTargets(openid, followedItems, templateId) {
  const now = new Date()
  const items = normalizeFollowedItems(followedItems)
  const existingTargets = await queryAll(COLLECTIONS.itemTargets, { openid, templateId })
  const nextIds = new Set()

  const existingById = new Map(existingTargets.map(target => [target._id, target]))
  const writes = []
  items.forEach(item => {
    const itemKey = getSubscriptionItemKey(item.name)
    if (!itemKey) return
    const docId = getSubscriptionItemTargetDocId(openid, templateId, itemKey)
    const existing = existingById.get(docId)
    nextIds.add(docId)
    const keywords = item.keywords || [item.name]
    if (existing && existing.enabled === true && existing.itemName === item.name &&
      getFollowedItemsSignature([{ name: existing.itemName, keywords: existing.keywords || [] }]) ===
      getFollowedItemsSignature([{ name: item.name, keywords }])) return
    writes.push(setDoc(COLLECTIONS.itemTargets, docId, {
      openid,
      templateId,
      itemKey,
      itemName: item.name,
      keywords,
      enabled: true,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now
    }))
  })

  existingTargets
    .filter(target => target.enabled === true && !nextIds.has(target._id))
    .forEach(target => writes.push(setDoc(COLLECTIONS.itemTargets, target._id, {
      ...target,
      enabled: false,
      updatedAt: now
    })))
  await Promise.all(writes)
  return writes.length
}

async function syncSubscriptionState(openid, followedItems, templateId) {
  const items = normalizeFollowedItems(followedItems)
  const docId = getSubscriptionTargetDocId(openid, templateId)
  const existingTarget = await getDoc(COLLECTIONS.targets, docId)
  const unchanged = getFollowedItemsSignature(getTargetFollowedItems(existingTarget)) === getFollowedItemsSignature(items) &&
    Boolean(existingTarget && existingTarget.enabled === true) === Boolean(items.length)
  if (unchanged) {
    markUsageCacheHit('subscription_selection_unchanged')
    return { changed: false, selectionSignature: getFollowedItemsSignature(items) }
  }
  await replaceEnabledSubscriptions(openid, items, templateId)
  const now = new Date()
  await setDoc(COLLECTIONS.targets, docId, {
    openid,
    templateId,
    enabled: items.length > 0,
    items: items.map(item => ({ itemName: item.name, keywords: item.keywords || [item.name] })),
    itemNames: items.map(item => item.name),
    selectionSignature: getFollowedItemsSignature(items),
    createdAt: existingTarget && existingTarget.createdAt ? existingTarget.createdAt : now,
    updatedAt: now
  })
  await syncSubscriptionItemTargets(openid, items, templateId)
  return { changed: true, selectionSignature: getFollowedItemsSignature(items) }
}

async function setSubscriptionIndexesSnapshot(openid, followedItems, templateId) {
  const now = new Date()
  const items = normalizeFollowedItems(followedItems)
  await setDoc(COLLECTIONS.targets, getSubscriptionTargetDocId(openid, templateId), {
    openid,
    templateId,
    enabled: items.length > 0,
    items: items.map(item => ({
      itemName: item.name,
      keywords: item.keywords || [item.name]
    })),
    itemNames: items.map(item => item.name),
    createdAt: now,
    updatedAt: now
  })

  await Promise.all(items.map(item => {
    const itemKey = getSubscriptionItemKey(item.name)
    if (!itemKey) return Promise.resolve()
    return setDoc(COLLECTIONS.itemTargets, getSubscriptionItemTargetDocId(openid, templateId, itemKey), {
      openid,
      templateId,
      itemKey,
      itemName: item.name,
      keywords: item.keywords || [item.name],
      enabled: true,
      createdAt: now,
      updatedAt: now
    })
  }))
}

function getSubscriptionItemTargetV2DocId(openid, itemKey) {
  return `item_target_v2_${itemKey}_${encodeDocId(openid)}`
}

async function syncSubscriptionProfileV2(openid, followedItems, templateIds = []) {
  const items = normalizeFollowedItems(followedItems)
  const selectionSignature = getFollowedItemsSignature(items)
  const existingProfile = await getDoc(COLLECTIONS.subscriptionProfiles, openid)
  const enabledTemplateIds = Array.from(new Set((existingProfile && existingProfile.enabledTemplateIds || [])
    .concat(templateIds)
    .filter(templateId => getSubscribeTemplateConfig(templateId))))
  const existingTargets = await queryAll(COLLECTIONS.itemTargetsV2, { openid })
  const nextIds = new Set()
  const writes = []
  const now = new Date()

  items.forEach(item => {
    const itemKey = getSubscriptionItemKey(item.name)
    if (!itemKey) return
    const docId = getSubscriptionItemTargetV2DocId(openid, itemKey)
    nextIds.add(docId)
    const existing = existingTargets.find(target => target._id === docId)
    const keywords = item.keywords || [item.name]
    const unchanged = existing && existing.enabled === true && existing.itemName === item.name &&
      getFollowedItemsSignature([{ name: existing.itemName, keywords: existing.keywords || [] }]) ===
      getFollowedItemsSignature([{ name: item.name, keywords }])
    if (unchanged) return
    writes.push(setDoc(COLLECTIONS.itemTargetsV2, docId, {
      openid,
      itemKey,
      itemName: item.name,
      keywords,
      enabled: true,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now
    }))
  })
  existingTargets.filter(target => target.enabled === true && !nextIds.has(target._id)).forEach(target => {
    writes.push(setDoc(COLLECTIONS.itemTargetsV2, target._id, {
      ...target,
      enabled: false,
      updatedAt: now
    }))
  })

  const profileUnchanged = existingProfile &&
    existingProfile.selectionSignature === selectionSignature &&
    getFollowedItemsSignature(existingProfile.followedItems || []) === selectionSignature &&
    enabledTemplateIds.slice().sort().join('|') === (existingProfile.enabledTemplateIds || []).slice().sort().join('|')
  if (!profileUnchanged) {
    writes.push(setDoc(COLLECTIONS.subscriptionProfiles, openid, {
      openid,
      enabled: items.length > 0,
      followedItems: items,
      itemNames: items.map(item => item.name),
      selectionSignature,
      enabledTemplateIds,
      createdAt: existingProfile && existingProfile.createdAt ? existingProfile.createdAt : now,
      updatedAt: now
    }))
  }
  await Promise.all(writes)
  return { changed: writes.length > 0, selectionSignature, writeCount: writes.length }
}

async function getReminderQuota(openid, templateId) {
  const quota = await getDoc(COLLECTIONS.quotas, getQuotaDocId(openid, templateId))
  if (isQuotaWechatRejected(quota)) return 0
  return quota ? Number(quota.remainingCount || 0) : 0
}

async function getReminderQuotaDoc(openid, templateId) {
  return getDoc(COLLECTIONS.quotas, getQuotaDocId(openid, templateId))
}

function isQuotaWechatRejected(quota) {
  return Boolean(quota && quota.wechatRejected === true)
}

async function addReminderQuotas(openid, templateIds) {
  const acceptedTemplateIds = Array.from(new Set((templateIds || []).filter(templateId => getSubscribeTemplateConfig(templateId))))
  const now = new Date()

  const writeQuotas = () => db.runTransaction(async transaction => {
    const configuredIds = getConfiguredTemplateIds()
    const quotaEntries = []
    for (const templateId of configuredIds) {
      const quota = await getTransactionDoc(transaction, COLLECTIONS.quotas, getQuotaDocId(openid, templateId))
      quotaEntries.push([templateId, quota])
    }
    const quotaMap = new Map(quotaEntries)
    let reminderCount = quotaEntries.reduce((total, [, quota]) => {
      return total + (isQuotaWechatRejected(quota) ? 0 : Math.max(0, Number(quota && quota.remainingCount || 0)))
    }, 0)
    const addedTemplateIds = []

    for (const templateId of acceptedTemplateIds) {
      if (reminderCount >= REMINDER_QUOTA_LIMIT) break
      const quota = quotaMap.get(templateId)
      const remainingCount = Math.max(0, Number(quota && quota.remainingCount || 0)) + 1
      await setTransactionDoc(transaction, COLLECTIONS.quotas, getQuotaDocId(openid, templateId), {
        ...(quota || {}),
        openid,
        templateId,
        remainingCount,
        wechatRejected: false,
        wechatRejectedAt: null,
        wechatRejectedRoundKey: '',
        wechatRejectedError: '',
        createdAt: quota && quota.createdAt ? quota.createdAt : now,
        updatedAt: now
      })
      quotaMap.set(templateId, { ...(quota || {}), remainingCount, wechatRejected: false })
      reminderCount += 1
      addedTemplateIds.push(templateId)
    }

    return {
      reminderCount,
      addedTemplateIds,
      addedCount: addedTemplateIds.length,
      capped: reminderCount >= REMINDER_QUOTA_LIMIT,
      message: reminderCount >= REMINDER_QUOTA_LIMIT ? REMINDER_QUOTA_LIMIT_MESSAGE : ''
    }
  })

  try {
    return await writeQuotas()
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
    await ensureCollectionExists(COLLECTIONS.quotas)
    return writeQuotas()
  }
}

async function addReminderQuota(openid, templateId) {
  const result = await addReminderQuotas(openid, [templateId])
  return {
    remainingCount: result.reminderCount,
    added: result.addedCount > 0,
    capped: result.capped,
    message: result.message
  }
}

async function markReminderQuotaWechatRejected(openid, templateId, roundKey, errorMsg, itemNames = []) {
  const docId = getQuotaDocId(openid, templateId)
  const quota = await getDoc(COLLECTIONS.quotas, docId)
  const now = new Date()
  const previousRemainingCount = quota && quota.wechatRejected === true && Number(quota.previousRemainingCount || 0) > 0
    ? Number(quota.previousRemainingCount || 0)
    : Number(quota && quota.remainingCount ? quota.remainingCount : 0)
  await setDoc(COLLECTIONS.quotas, docId, {
    ...(quota || {}),
    openid,
    templateId,
    remainingCount: 0,
    previousRemainingCount,
    wechatRejected: true,
    wechatRejectedAt: now,
    wechatRejectedRoundKey: roundKey,
    wechatRejectedError: errorMsg || '',
    lastIssue: {
      roundKey: roundKey || '',
      itemNames: Array.from(new Set(itemNames || [])),
      errorMsg: errorMsg || '',
      updatedAt: now
    },
    createdAt: quota && quota.createdAt ? quota.createdAt : now,
    updatedAt: now
  })
}

async function consumeReminderQuota(openid, templateId, deliveryId = '') {
  const docId = getQuotaDocId(openid, templateId)
  const quota = await getDoc(COLLECTIONS.quotas, docId)
  const remainingCount = Number(quota && quota.remainingCount ? quota.remainingCount : 0)
  const consumedDeliveryIds = Array.isArray(quota && quota.consumedDeliveryIds)
    ? quota.consumedDeliveryIds
    : []

  if (deliveryId && consumedDeliveryIds.includes(deliveryId)) return true

  if (remainingCount <= 0) return false

  const nextConsumedDeliveryIds = deliveryId
    ? Array.from(new Set(consumedDeliveryIds.concat(deliveryId))).slice(-400)
    : consumedDeliveryIds

  await setDoc(COLLECTIONS.quotas, docId, {
    ...quota,
    openid,
    templateId,
    remainingCount: remainingCount - 1,
    consumedDeliveryIds: nextConsumedDeliveryIds,
    updatedAt: new Date()
  })
  return true
}

async function getTotalReminderQuota(openid) {
  const quotas = await queryAll(COLLECTIONS.quotas, { openid })
  return quotas.reduce((total, quota) => total + Number(quota.remainingCount || 0), 0)
}

async function saveSubscription(event, openid) {
  const followedItems = normalizeFollowedItems(event.followedItems)
  const acceptedTemplateIds = getAcceptedTemplateIds(event)

  if (!followedItems.length) {
    return fail('请先选择关注商品')
  }
  if (!acceptedTemplateIds.length) {
    return fail('订阅模板未配置或未通过校验')
  }

  await saveUser(openid)
  const selectionResults = []
  if (SUBSCRIPTION_V2_LEGACY_WRITE) {
    selectionResults.push(...await Promise.all(acceptedTemplateIds.map(templateId => {
      return syncSubscriptionState(openid, followedItems, templateId)
    })))
  }
  if (SUBSCRIPTION_V2_DUAL_WRITE || !SUBSCRIPTION_V2_LEGACY_WRITE) {
    selectionResults.push(await syncSubscriptionProfileV2(openid, followedItems, acceptedTemplateIds))
  }
  const quotaResult = await addReminderQuotas(openid, acceptedTemplateIds)
  const poolStatus = await getSubscriptionPoolStatus(openid)

  return ok({
    followedItems,
    templateId: acceptedTemplateIds[0],
    acceptedTemplateIds,
    changed: selectionResults.some(result => result.changed),
    selectionSignature: getFollowedItemsSignature(followedItems),
    addedTemplateIds: quotaResult.addedTemplateIds,
    addedCount: quotaResult.addedCount,
    reminderCount: poolStatus.reminderCount,
    quotaAdded: quotaResult.addedCount > 0,
    quotaCapped: quotaResult.capped,
    configuredTemplateCount: poolStatus.configuredTemplateCount,
    rejectedTemplateCount: poolStatus.rejectedTemplateCount,
    availableGrantCount: poolStatus.availableGrantCount,
    hasEnabledSubscription: poolStatus.hasEnabledSubscription,
    templates: poolStatus.templates,
    homeStatus: buildPoolHomeStatus(poolStatus),
    notification: null
  }, quotaResult.message || '微信提醒已开启')
}

async function updateSubscriptionItems(event, openid) {
  const followedItems = normalizeFollowedItems(event.followedItems)
  let templateIds = event.templateId ? getAcceptedTemplateIds(event) : []
  let selectionResults = []
  if (!templateIds.length) {
    const configuredIds = new Set(getConfiguredTemplateIds())
    const profile = !SUBSCRIPTION_V2_LEGACY_WRITE || SUBSCRIPTION_V2_READ
      ? await getDoc(COLLECTIONS.subscriptionProfiles, openid)
      : null
    if (profile) {
      templateIds = Array.from(new Set((profile.enabledTemplateIds || [])
        .filter(templateId => configuredIds.has(templateId))))
    } else {
      const existingTargets = await queryAll(COLLECTIONS.targets, { openid })
      templateIds = Array.from(new Set(existingTargets
        .map(target => target.templateId || target.template_id || '')
        .filter(templateId => configuredIds.has(templateId))))
    }
  }

  if (templateIds.length) {
    await saveUser(openid)
    if (SUBSCRIPTION_V2_LEGACY_WRITE) {
      selectionResults.push(...await Promise.all(templateIds.map(templateId => {
        return syncSubscriptionState(openid, followedItems, templateId)
      })))
    }
    if (SUBSCRIPTION_V2_DUAL_WRITE || !SUBSCRIPTION_V2_LEGACY_WRITE) {
      selectionResults.push(await syncSubscriptionProfileV2(openid, followedItems, templateIds))
    }
  }
  const poolStatus = await getSubscriptionPoolStatus(openid)

  return ok({
    followedItems,
    templateId: templateIds[0] || '',
    templateIds,
    changed: Array.isArray(selectionResults) && selectionResults.some(result => result.changed),
    selectionSignature: getFollowedItemsSignature(followedItems),
    reminderCount: poolStatus.reminderCount,
    configuredTemplateCount: poolStatus.configuredTemplateCount,
    rejectedTemplateCount: poolStatus.rejectedTemplateCount,
    availableGrantCount: poolStatus.availableGrantCount,
    hasEnabledSubscription: poolStatus.hasEnabledSubscription,
    templates: poolStatus.templates,
    homeStatus: buildPoolHomeStatus(poolStatus),
    lightweight: templateIds.length === 0
  }, '关注商品已同步')
}

async function getSubscriptionPoolStatus(openid) {
  const configuredIds = getConfiguredTemplateIds()
  const [quotas, profile] = await Promise.all([
    queryAll(COLLECTIONS.quotas, { openid }),
    SUBSCRIPTION_V2_READ
      ? getDoc(COLLECTIONS.subscriptionProfiles, openid)
      : Promise.resolve(null)
  ])
  const targets = !SUBSCRIPTION_V2_READ || (!profile && SUBSCRIPTION_V2_READ_FALLBACK)
    ? await queryAll(COLLECTIONS.targets, { openid })
    : []
  const quotaMap = new Map(quotas
    .filter(quota => configuredIds.includes(quota.templateId || quota.template_id || ''))
    .map(quota => [quota.templateId || quota.template_id, quota]))
  const templates = SUBSCRIBE_TEMPLATE_CONFIGS.map(config => {
    const quota = quotaMap.get(config.templateId)
    const wechatRejected = isQuotaWechatRejected(quota)
    return {
      key: config.key,
      label: config.label,
      templateId: config.templateId,
      remainingCount: wechatRejected ? 0 : Math.max(0, Number(quota && quota.remainingCount || 0)),
      wechatRejected,
      updatedAt: quota && (quota.wechatRejectedAt || quota.updatedAt) || ''
    }
  })
  const activeTemplateIds = new Set(profile && profile.enabled === true
    ? (profile.enabledTemplateIds || [])
    : targets
      .filter(target => target.enabled === true)
      .map(target => target.templateId || target.template_id || ''))
  const reminderCount = templates.reduce((total, template) => total + template.remainingCount, 0)
  return {
    reminderCount,
    configuredTemplateCount: templates.length,
    rejectedTemplateCount: templates.filter(template => template.wechatRejected).length,
    hasEnabledSubscription: templates.some(template => activeTemplateIds.has(template.templateId)),
    availableGrantCount: Math.max(0, Math.min(templates.length, REMINDER_QUOTA_LIMIT - reminderCount)),
    templates,
    quotaMap
  }
}

async function getSubscriptionStatus(event, openid) {
  const poolStatus = await getSubscriptionPoolStatus(openid)
  const latestRejectedTemplate = poolStatus.templates
    .filter(template => template.wechatRejected)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
  const rejectedQuota = latestRejectedTemplate ? poolStatus.quotaMap.get(latestRejectedTemplate.templateId) : null
  const reminderIssue = latestRejectedTemplate
    ? await getLatestReminderIssue(openid, latestRejectedTemplate.templateId, rejectedQuota)
    : null
  const homeStatus = buildPoolHomeStatus(poolStatus)
  return ok({
    reminderCount: poolStatus.reminderCount,
    configuredTemplateCount: poolStatus.configuredTemplateCount,
    rejectedTemplateCount: poolStatus.rejectedTemplateCount,
    availableGrantCount: poolStatus.availableGrantCount,
    hasEnabledSubscription: poolStatus.hasEnabledSubscription,
    templates: poolStatus.templates,
    reminderIssue,
    homeStatus,
    homeReminder: homeStatus
  })
}

function buildPoolHomeStatus(poolStatus) {
  const reminderCount = Number(poolStatus.reminderCount || 0)
  const rejectedTemplateCount = Number(poolStatus.rejectedTemplateCount || 0)
  if (!poolStatus.hasEnabledSubscription) {
    return {
      type: 'not_following',
      title: '还未设置关注商品',
      text: '去关注页选择商品并开启微信提醒。',
      actionText: '去关注页',
      statusKey: 'not_following'
    }
  }
  if (rejectedTemplateCount > 0) {
    return {
      type: 'wechat_rejected',
      title: '关注提醒',
      text: `剩余 ${reminderCount} 次 · ${rejectedTemplateCount} 个通道需重新授权`,
      actionText: '去处理',
      statusKey: `wechat_rejected|${reminderCount}|${rejectedTemplateCount}`
    }
  }
  if (reminderCount > 0) {
    return {
      type: reminderCount <= 2 ? 'low_quota' : 'normal',
      title: '关注提醒',
      text: `剩余 ${reminderCount} 次`,
      actionText: '去关注页',
      statusKey: `quota|${reminderCount}`
    }
  }
  return {
    type: 'no_quota',
    title: '提醒次数已用完',
    text: '去关注页增加次数后才能继续收到提醒。',
    actionText: '去增加',
    statusKey: 'no_quota'
  }
}

async function getLatestReminderIssue(openid, templateId, quota = null) {
  if (!isQuotaWechatRejected(quota)) return null

  if (quota && quota.lastIssue) {
    return {
      type: 'wechat_rejected_reset',
      roundKey: quota.lastIssue.roundKey || quota.wechatRejectedRoundKey || '',
      itemNames: quota.lastIssue.itemNames || [],
      previousReminderCount: Number(quota.previousRemainingCount || 0),
      errorCode: '43101',
      errorMsg: quota.lastIssue.errorMsg || quota.wechatRejectedError || '',
      updatedAt: quota.lastIssue.updatedAt || quota.wechatRejectedAt || ''
    }
  }

  const deliveries = await queryAll(COLLECTIONS.deliveries, { openid })
  const matchedDeliveries = deliveries
    .filter(item => !templateId || item.templateId === templateId)
    .filter(item => item.status === 'final_failed')
    .filter(item => isWechatRejectErrorMsg(item.errorMsg))
    .sort((a, b) => String(b.updatedAt || b.lastAttemptAt || '').localeCompare(String(a.updatedAt || a.lastAttemptAt || '')))
  const latestDelivery = matchedDeliveries[0]

  return {
    type: isQuotaWechatRejected(quota) ? 'wechat_rejected_reset' : 'wechat_rejected',
    roundKey: (latestDelivery && latestDelivery.roundKey) || (quota && quota.wechatRejectedRoundKey) || '',
    itemNames: (latestDelivery && latestDelivery.itemNames) || [],
    previousReminderCount: Number(quota && quota.previousRemainingCount ? quota.previousRemainingCount : 0),
    errorCode: '43101',
    errorMsg: (latestDelivery && latestDelivery.errorMsg) || (quota && quota.wechatRejectedError) || '',
    updatedAt: (latestDelivery && (latestDelivery.updatedAt || latestDelivery.lastAttemptAt)) || (quota && quota.wechatRejectedAt) || ''
  }
}

function isWechatRejectErrorMsg(errorMsg) {
  const message = String(errorMsg || '').toLowerCase()
  return message.includes('43101') ||
    message.includes('user refuse') ||
    message.includes('refuse to accept')
}

function isSubscriptionMatched(itemName, subscription) {
  if (!itemName || !subscription) return false
  const keywords = getItemKeywords(subscription.itemName, subscription.keywords)
  return keywords.some(keyword => isKeywordMatched(itemName, keyword))
}

function getRoundItemDisplayName(itemName) {
  const matcher = FOLLOW_ITEM_MATCHERS.find(item => item.keywords.some(keyword => isKeywordMatched(itemName, keyword)))
  return matcher ? matcher.name : itemName
}

function getSubscriptionItemKey(itemName) {
  const displayName = getRoundItemDisplayName(itemName)
  return displayName ? encodeDocId(displayName) : ''
}

function getSubscriptionItemTargetDocId(openid, templateId, itemKey) {
  return `item_target_${itemKey}_${encodeDocId(`${openid}|${templateId}`)}`
}

function getMerchantItemKeys(items) {
  return Array.from(new Set((items || [])
    .map(item => getSubscriptionItemKey(item && item.name))
    .filter(Boolean)))
}

function serializeRoundItemSnapshot(itemMap) {
  const totalSubscriptionKeys = new Set()
  const totalPushableKeys = new Set()
  const items = Array.from(itemMap.values()).map(item => {
    item.subscriptionKeys.forEach(key => totalSubscriptionKeys.add(key))
    item.pushableKeys.forEach(key => totalPushableKeys.add(key))
    return {
      name: item.name,
      itemNames: Array.from(item.itemNames),
      subscriptionCount: item.subscriptionKeys.size,
      pushableCount: item.pushableKeys.size
    }
  })

  return {
    roundItems: items,
    roundItemTotals: {
      subscriptionCount: totalSubscriptionKeys.size,
      pushableCount: totalPushableKeys.size
    }
  }
}

function addRoundItemSnapshotMatch(itemMap, itemName, subscriptionKey, pushable) {
  const displayName = getRoundItemDisplayName(itemName)
  if (!displayName) return

  const current = itemMap.get(displayName) || {
    name: displayName,
    itemNames: new Set(),
    subscriptionKeys: new Set(),
    pushableKeys: new Set()
  }
  current.itemNames.add(itemName)
  current.subscriptionKeys.add(subscriptionKey)
  if (pushable) current.pushableKeys.add(subscriptionKey)
  itemMap.set(displayName, current)
}

function buildNotificationDeliveryId(openid, templateId, roundKey) {
  return `delivery_${encodeDocId(`${openid}|${templateId}|${roundKey}`)}`
}

function buildPooledNotificationDeliveryId(openid, roundKey) {
  return `delivery_pool_${encodeDocId(`${openid}|${roundKey}`)}`
}

function getDeliveryAttemptLimit(delivery = {}) {
  const candidateCount = Array.isArray(delivery.candidateTemplateIds)
    ? delivery.candidateTemplateIds.length
    : 0
  return candidateCount > 1
    ? Math.min(MAX_POOL_DELIVERY_ATTEMPTS, candidateCount + 1)
    : MAX_DELIVERY_ATTEMPTS
}

function buildNotificationAttemptId(deliveryId, attemptNo) {
  return `${deliveryId}#attempt_${attemptNo}`
}

function normalizeDeliveryStatus(status) {
  if (status === 'failed') return 'retryable_failed'
  return status || ''
}

function isLockedDelivery(delivery, now = Date.now()) {
  if (!delivery || normalizeDeliveryStatus(delivery.status) !== 'sending') return false
  const lockedUntil = delivery.lockedUntil && delivery.lockedUntil.getTime
    ? delivery.lockedUntil.getTime()
    : new Date(delivery.lockedUntil || 0).getTime()
  return Number.isFinite(lockedUntil) && lockedUntil > now
}

function isFinalSubscribeSendError(error) {
  const code = Number(error && (error.errCode || error.errcode || error.code))
  const message = `${error && error.errMsg ? error.errMsg : ''} ${error && error.message ? error.message : ''}`.toLowerCase()

  return FINAL_SUBSCRIBE_ERROR_CODES.has(code) ||
    message.includes('43101') ||
    message.includes('user refuse') ||
    message.includes('refuse to accept') ||
    message.includes('reject') ||
    message.includes('invalid openid') ||
    message.includes('invalid template')
}

function isWechatSubscribeRejectedError(error) {
  const code = Number(error && (error.errCode || error.errcode || error.code))
  const message = `${error && error.errMsg ? error.errMsg : ''} ${error && error.message ? error.message : ''}`.toLowerCase()
  return code === 43101 ||
    message.includes('43101') ||
    message.includes('user refuse') ||
    message.includes('refuse to accept')
}

function classifySubscribeSendError(error) {
  return {
    status: isFinalSubscribeSendError(error) ? 'final_failed' : 'retryable_failed',
    errorMsg: error && error.message ? error.message : String(error || ''),
    wechatRejected: isWechatSubscribeRejectedError(error)
  }
}

async function appendNotificationEvent(deliveryId, delivery, event) {
  try {
    const latest = await getDoc(COLLECTIONS.deliveries, deliveryId)
    const events = Array.isArray(latest && latest.events)
      ? latest.events
      : (Array.isArray(delivery && delivery.events) ? delivery.events : [])
    await setNotificationDelivery(deliveryId, latest || delivery, {
      events: events.concat({
        ...event,
        createdAt: event.createdAt || new Date()
      }).slice(-40)
    })
    return true
  } catch (error) {
    console.warn(`[rocoApi] Failed to record notification event: ${error.message}`)
    return false
  }
}

function updateAttemptInDelivery(delivery, attemptNo, patch) {
  const attempts = Array.isArray(delivery && delivery.attempts) ? delivery.attempts : []
  let found = false
  const nextAttempts = attempts.map(attempt => {
    if (Number(attempt.attemptNo || 0) !== Number(attemptNo || 0)) return attempt
    found = true
    return {
      ...attempt,
      ...patch,
      updatedAt: patch.updatedAt || new Date()
    }
  })
  if (!found) {
    nextAttempts.push({
      attemptNo,
      ...patch,
      updatedAt: patch.updatedAt || new Date()
    })
  }
  return nextAttempts.slice(-getDeliveryAttemptLimit(delivery))
}

async function setNotificationDelivery(deliveryId, delivery, patch) {
  await setDoc(COLLECTIONS.deliveries, deliveryId, {
    ...(delivery || {}),
    ...patch,
    updatedAt: new Date()
  })
}

function formatPostSendError(error) {
  return error && error.message ? error.message : String(error || '')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildQuotaPostSend({
  consumed = false,
  pending = false,
  error = '',
  recordedAt = null,
  refunded = false,
  refundPending = false,
  refundError = '',
  refundRecordedAt = null
} = {}) {
  return {
    quotaConsumed: consumed === true,
    quotaConsumePending: pending === true,
    quotaRecordedAt: recordedAt,
    quotaError: error || '',
    quotaRefunded: refunded === true,
    quotaRefundPending: refundPending === true,
    quotaRefundError: refundError || '',
    quotaRefundRecordedAt: refundRecordedAt
  }
}

function needsQuotaConfirmation(delivery) {
  return !delivery || !delivery.postSend || delivery.postSend.quotaConsumed !== true
}

async function consumeReminderQuotaWithRetry(openid, templateId, deliveryId, attempts = 3) {
  let lastError = null

  for (let index = 0; index < attempts; index += 1) {
    try {
      const consumed = await consumeReminderQuota(openid, templateId, deliveryId)
      if (consumed) return { consumed: true, error: '' }
      lastError = new Error('quota not consumed')
    } catch (error) {
      lastError = error
    }

    if (index < attempts - 1) {
      await delay(120 * (index + 1))
    }
  }

  return { consumed: false, error: formatPostSendError(lastError) }
}

async function confirmSentDeliveryQuota(deliveryId, delivery, { retry = true } = {}) {
  const quotaAttemptId = buildNotificationAttemptId(deliveryId, Number(delivery && delivery.attemptCount ? delivery.attemptCount : 1))
  let quotaResult = { consumed: false, error: 'quota not consumed' }
  if (retry) {
    quotaResult = await consumeReminderQuotaWithRetry(delivery.openid, delivery.templateId, quotaAttemptId)
  } else {
    try {
      const consumed = await consumeReminderQuota(delivery.openid, delivery.templateId, quotaAttemptId)
      quotaResult = { consumed, error: consumed ? '' : 'quota not consumed' }
    } catch (error) {
      quotaResult = { consumed: false, error: formatPostSendError(error) }
    }
  }

  const postSend = buildQuotaPostSend({
    consumed: quotaResult.consumed,
    pending: quotaResult.consumed !== true,
    error: quotaResult.consumed ? '' : (quotaResult.error || 'quota not consumed'),
    recordedAt: new Date()
  })
  await setNotificationDelivery(deliveryId, delivery, { postSend })
  return { consumed: quotaResult.consumed === true, postSend }
}

async function refundReminderQuota(openid, templateId, deliveryId) {
  const docId = getQuotaDocId(openid, templateId)
  return db.runTransaction(async transaction => {
    const quota = await getTransactionDoc(transaction, COLLECTIONS.quotas, docId)
    if (!quota) return { refunded: false, error: 'quota not found' }

    const consumedDeliveryIds = Array.isArray(quota.consumedDeliveryIds)
      ? quota.consumedDeliveryIds
      : []
    if (!consumedDeliveryIds.includes(deliveryId)) {
      return { refunded: true, alreadyRefunded: true }
    }

    const nextConsumedDeliveryIds = consumedDeliveryIds.filter(id => id !== deliveryId)
    await setTransactionDoc(transaction, COLLECTIONS.quotas, docId, {
      ...quota,
      openid,
      templateId,
      remainingCount: Number(quota.remainingCount || 0) + 1,
      consumedDeliveryIds: nextConsumedDeliveryIds,
      updatedAt: new Date()
    })
    return { refunded: true, alreadyRefunded: false }
  })
}

async function refundReminderQuotaWithRetry(openid, templateId, deliveryId, attempts = 3) {
  let lastError = null

  for (let index = 0; index < attempts; index += 1) {
    try {
      const result = await refundReminderQuota(openid, templateId, deliveryId)
      if (result && result.refunded) return { refunded: true, error: '' }
      lastError = new Error((result && result.error) || 'quota not refunded')
    } catch (error) {
      lastError = error
    }

    if (index < attempts - 1) {
      await delay(120 * (index + 1))
    }
  }

  return { refunded: false, error: formatPostSendError(lastError) }
}

async function claimNotificationDeliveryWithQuota(pending, roundKey, source) {
  const requestedCandidates = Array.from(new Set((pending.candidateTemplateIds || [pending.templateId])
    .filter(templateId => getSubscribeTemplateConfig(templateId))))
  const deliveryId = pending.deliveryId || (requestedCandidates.length > 1
    ? buildPooledNotificationDeliveryId(pending.openid, roundKey)
    : buildNotificationDeliveryId(pending.openid, requestedCandidates[0], roundKey))

  return db.runTransaction(async transaction => {
    const latest = await getTransactionDoc(transaction, COLLECTIONS.deliveries, deliveryId)
    const status = normalizeDeliveryStatus(latest && latest.status)
    const candidateTemplateIds = Array.from(new Set((latest && latest.candidateTemplateIds || requestedCandidates)
      .filter(templateId => getSubscribeTemplateConfig(templateId))))

    if (status === 'sent') {
      return { claimed: false, reason: 'already_sent', deliveryId, delivery: latest }
    }
    if (latest && latest.postSend && latest.postSend.quotaRefundPending === true) {
      return { claimed: false, reason: 'quota_refund_pending', deliveryId, delivery: latest }
    }
    if (!isProcessableDeliveryStatus(status, source, latest)) {
      return { claimed: false, reason: status || 'missing_delivery', deliveryId, delivery: latest }
    }
    if (isLockedDelivery(latest)) {
      return { claimed: false, reason: 'sending', deliveryId, delivery: latest }
    }
    const latestAttempts = Array.isArray(latest && latest.attempts) ? latest.attempts : []
    const retryableAttemptsForCurrentTemplate = latest && latest.lastFailureWechatRejected !== true
      ? latestAttempts.filter(attempt => {
        return attempt.templateId === latest.templateId && normalizeDeliveryStatus(attempt.status) === 'retryable_failed'
      }).length
      : 0
    if (retryableAttemptsForCurrentTemplate >= MAX_DELIVERY_ATTEMPTS) {
      const finalDelivery = {
        ...(latest || {}),
        status: 'final_failed',
        lockedUntil: null,
        errorMsg: 'max notification attempts reached for template',
        updatedAt: new Date()
      }
      await setTransactionDoc(transaction, COLLECTIONS.deliveries, deliveryId, finalDelivery)
      return { claimed: false, reason: 'max_attempts', deliveryId, delivery: finalDelivery }
    }
    const nextAttemptNo = Number(latest && latest.attemptCount ? latest.attemptCount : 0) + 1
    const attemptLimit = getDeliveryAttemptLimit({ ...(latest || {}), candidateTemplateIds })
    if (nextAttemptNo > attemptLimit) {
      const finalDelivery = {
        ...(latest || {}),
        status: 'final_failed',
        lockedUntil: null,
        errorMsg: 'max notification attempts reached',
        updatedAt: new Date()
      }
      await setTransactionDoc(transaction, COLLECTIONS.deliveries, deliveryId, finalDelivery)
      return { claimed: false, reason: 'max_attempts', deliveryId, delivery: finalDelivery }
    }

    const now = new Date()
    const rejectedTemplateIds = new Set(Array.isArray(latest && latest.rejectedTemplateIds) ? latest.rejectedTemplateIds : [])
    const quotaEntries = []
    for (const templateId of candidateTemplateIds) {
      const quota = await getTransactionDoc(transaction, COLLECTIONS.quotas, getQuotaDocId(pending.openid, templateId))
      quotaEntries.push([templateId, quota])
    }
    const quotaMap = new Map(quotaEntries)
    const retryTemplateId = status === 'retryable_failed' && latest && latest.lastFailureWechatRejected !== true
      ? latest.templateId
      : ''
    const orderedCandidates = Array.from(new Set([retryTemplateId].concat(candidateTemplateIds).filter(Boolean)))
    const templateId = orderedCandidates.find(candidateId => {
      const quota = quotaMap.get(candidateId)
      return !rejectedTemplateIds.has(candidateId) && !isQuotaWechatRejected(quota) && Number(quota && quota.remainingCount || 0) > 0
    })
    const baseDelivery = {
      ...(latest || {}),
      openid: pending.openid,
      templateId: templateId || (latest && latest.templateId) || candidateTemplateIds[0] || '',
      candidateTemplateIds,
      rejectedTemplateIds: Array.from(rejectedTemplateIds),
      roundKey,
      itemNames: pending.itemNames || [],
      source,
      createdAt: latest && latest.createdAt ? latest.createdAt : now
    }

    if (!templateId) {
      const allRejected = candidateTemplateIds.length > 0 && candidateTemplateIds.every(candidateId => {
        return rejectedTemplateIds.has(candidateId) || isQuotaWechatRejected(quotaMap.get(candidateId))
      })
      const unavailableDelivery = {
        ...baseDelivery,
        status: allRejected ? 'final_failed' : 'no_quota',
        lockedUntil: null,
        errorMsg: allRejected ? 'WeChat subscription channels rejected; waiting for user re-authorization' : '',
        updatedAt: now,
        postSend: buildQuotaPostSend()
      }
      await setTransactionDoc(transaction, COLLECTIONS.deliveries, deliveryId, unavailableDelivery)
      return {
        claimed: false,
        reason: allRejected ? 'wechat_rejected' : 'no_quota',
        deliveryId,
        delivery: unavailableDelivery
      }
    }

    const quota = quotaMap.get(templateId)
    const quotaId = getQuotaDocId(pending.openid, templateId)
    const consumedDeliveryIds = Array.isArray(quota && quota.consumedDeliveryIds)
      ? quota.consumedDeliveryIds
      : []
    const quotaAttemptId = buildNotificationAttemptId(deliveryId, nextAttemptNo)
    const alreadyConsumed = consumedDeliveryIds.includes(quotaAttemptId)
    const remainingCount = Number(quota && quota.remainingCount ? quota.remainingCount : 0)

    let remainingCountAfter = remainingCount
    if (!alreadyConsumed) {
      const nextConsumedDeliveryIds = Array.from(new Set(consumedDeliveryIds.concat(quotaAttemptId))).slice(-400)
      remainingCountAfter = remainingCount - 1
      await setTransactionDoc(transaction, COLLECTIONS.quotas, quotaId, {
        ...(quota || {}),
        openid: pending.openid,
        templateId,
        remainingCount: remainingCountAfter,
        consumedDeliveryIds: nextConsumedDeliveryIds,
        updatedAt: now
      })
    }

    const attempts = updateAttemptInDelivery(baseDelivery, nextAttemptNo, {
      attemptNo: nextAttemptNo,
      templateId,
      quotaAttemptId,
      source,
      status: 'sending',
      itemNames: pending.itemNames || [],
      startedAt: now,
      errorMsg: '',
      quotaConsumed: true,
      quotaRefunded: false,
      quotaRefundPending: false
    })
    const claimedDelivery = {
      ...baseDelivery,
      templateId,
      status: 'sending',
      attemptCount: nextAttemptNo,
      attempts,
      lockedUntil: new Date(now.getTime() + DELIVERY_LOCK_MS),
      lastAttemptAt: now,
      errorMsg: '',
      lastFailureWechatRejected: false,
      updatedAt: now,
      postSend: buildQuotaPostSend({
        consumed: true,
        pending: false,
        recordedAt: now
      })
    }

    await setTransactionDoc(transaction, COLLECTIONS.deliveries, deliveryId, claimedDelivery)
    const totalRemainingCount = quotaEntries.reduce((total, [candidateId, candidateQuota]) => {
      if (candidateId === templateId) return total + Math.max(0, remainingCountAfter)
      if (rejectedTemplateIds.has(candidateId) || isQuotaWechatRejected(candidateQuota)) return total
      return total + Math.max(0, Number(candidateQuota && candidateQuota.remainingCount || 0))
    }, 0)
    return {
      claimed: true,
      deliveryId,
      delivery: claimedDelivery,
      attemptNo: nextAttemptNo,
      templateId,
      quotaAttemptId,
      remainingCountAfter: totalRemainingCount
    }
  })
}

async function finalizeSuccessfulNotification(pending, claim, roundKey, source) {
  const sentAt = new Date()
  const attempts = updateAttemptInDelivery(claim.delivery, claim.attemptNo, {
    templateId: claim.templateId,
    status: 'sent',
    finishedAt: sentAt,
    errorMsg: '',
    quotaConsumed: true,
    quotaRefunded: false,
    quotaRefundPending: false
  })
  await setNotificationDelivery(claim.deliveryId, claim.delivery, {
    status: 'sent',
    templateId: claim.templateId,
    attempts,
    lockedUntil: null,
    sentAt,
    errorMsg: '',
    postSend: {
      ...(claim.delivery.postSend || {}),
      quotaConsumed: true,
      quotaConsumePending: false,
      quotaError: '',
      quotaRefundPending: false,
      quotaRefundError: ''
    }
  })
}

async function finalizeFailedNotification(pending, claim, roundKey, failure) {
  let postSend = claim.delivery.postSend || buildQuotaPostSend({ consumed: true, recordedAt: new Date() })
  const failedAt = new Date()
  const templateId = claim.templateId || pending.templateId
  let attemptPatch = {
    templateId,
    status: failure.status,
    finishedAt: failedAt,
    errorMsg: failure.errorMsg,
    quotaConsumed: true,
    quotaRefunded: false,
    quotaRefundPending: false
  }

  if (failure.wechatRejected) {
    await markReminderQuotaWechatRejected(pending.openid, templateId, roundKey, failure.errorMsg, pending.itemNames)
    postSend = {
      ...postSend,
      quotaConsumed: true,
      quotaConsumePending: false,
      quotaError: '',
      quotaRefunded: false,
      quotaRefundPending: false,
      quotaRefundError: ''
    }
  } else {
    const refund = await refundReminderQuotaWithRetry(pending.openid, templateId, claim.quotaAttemptId || claim.deliveryId)
    attemptPatch = {
      ...attemptPatch,
      quotaConsumed: refund.refunded !== true,
      quotaRefunded: refund.refunded === true,
      quotaRefundPending: refund.refunded !== true,
      quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded')
    }
    postSend = {
      ...postSend,
      quotaConsumed: refund.refunded !== true,
      quotaConsumePending: false,
      quotaError: '',
      quotaRefunded: refund.refunded === true,
      quotaRefundPending: refund.refunded !== true,
      quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded'),
      quotaRefundRecordedAt: new Date()
    }
    if (!refund.refunded) {
      console.warn(`[rocoApi] Subscribe quota refund incomplete: ${pending.openid} ${roundKey} ${postSend.quotaRefundError}`)
    }
  }

  const attempts = updateAttemptInDelivery(claim.delivery, claim.attemptNo, attemptPatch)
  const events = (Array.isArray(claim.delivery.events) ? claim.delivery.events : []).concat({
    type: failure.status,
    templateId,
    itemNames: pending.itemNames,
    errorMsg: failure.errorMsg,
    createdAt: failedAt
  }).slice(-40)
  const rejectedTemplateIds = failure.wechatRejected
    ? Array.from(new Set((claim.delivery.rejectedTemplateIds || []).concat(templateId)))
    : (claim.delivery.rejectedTemplateIds || [])
  await setNotificationDelivery(claim.deliveryId, claim.delivery, {
    status: failure.wechatRejected ? 'retryable_failed' : failure.status,
    templateId,
    rejectedTemplateIds,
    lastFailureWechatRejected: failure.wechatRejected === true,
    attempts,
    events,
    lockedUntil: null,
    errorMsg: failure.errorMsg,
    postSend
  })
}

function createEmptyNotificationStats(checked = 0) {
  return {
    checked,
    quotaEligible: 0,
    matched: 0,
    materialized: 0,
    createdDelivery: 0,
    pending: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    retryableFailed: 0,
    finalFailed: 0,
    skipped: 0,
    noQuota: 0,
    skippedNoQuota: 0,
    existingDelivery: 0,
    wechatRejected: 0,
    quotaRepaired: 0,
    quotaRepairFailed: 0,
    roundItems: [],
    roundItemTotals: {
      subscriptionCount: 0,
      pushableCount: 0
    },
    roundItemSnapshotRecorded: false,
    concurrency: NOTIFY_CONCURRENCY,
    batchLimit: NOTIFY_BATCH_LIMIT,
    timeBudgetMs: NOTIFY_TIME_BUDGET_MS,
    deferred: 0,
    queueTotal: 0,
    queueSent: 0,
    queuePending: 0,
    queueRetryableFailed: 0,
    queueFinalFailed: 0,
    queueNoQuota: 0,
    staleSending: 0,
    secondAttempt: 0,
    lastRecipientDeferred: false,
    remainingBatches: 0,
    timeBudgetReached: false
  }
}

function isProcessableDeliveryStatus(status, source, delivery = null) {
  if (status === 'pending' || status === 'retryable_failed') return true
  if (status === 'sending') {
    return !isLockedDelivery(delivery) && Number(delivery && delivery.attemptCount ? delivery.attemptCount : 0) < getDeliveryAttemptLimit(delivery)
  }
  return source === 'immediate' && (status === 'final_failed' || status === 'no_quota')
}

async function materializeNotificationDelivery(pending, roundKey, source) {
  const candidateTemplateIds = Array.from(new Set((pending.candidateTemplateIds || [pending.templateId]).filter(Boolean)))
  const deliveryId = Array.isArray(pending.candidateTemplateIds)
    ? buildPooledNotificationDeliveryId(pending.openid, roundKey)
    : buildNotificationDeliveryId(pending.openid, candidateTemplateIds[0], roundKey)
  let existing = await getDoc(COLLECTIONS.deliveries, deliveryId)
  const status = normalizeDeliveryStatus(existing && existing.status)

  if (status === 'sent') {
    return { processable: false, reason: 'already_sent', deliveryId, delivery: existing, created: false }
  }
  if (existing) {
    if (isProcessableDeliveryStatus(status, source, existing)) {
      const nextItemNames = source === 'admin'
        ? pending.items.map(item => item.name)
        : Array.from(new Set((existing.itemNames || []).concat(pending.items.map(item => item.name))))
      const mergedCandidateIds = SUBSCRIBE_TEMPLATE_CONFIGS
        .map(config => config.templateId)
        .filter(templateId => (existing.candidateTemplateIds || []).concat(candidateTemplateIds).includes(templateId))
      const nextSubscriptionItemNames = Array.from(pending.subscriptionItemNames || [])
      const sameList = (left, right) => (left || []).slice().sort().join('|') === (right || []).slice().sort().join('|')
      if (!sameList(existing.itemNames, nextItemNames) ||
        !sameList(existing.candidateTemplateIds, mergedCandidateIds) ||
        !sameList(existing.subscriptionItemNames, nextSubscriptionItemNames)) {
        const nextExisting = {
          ...existing,
          itemNames: nextItemNames,
          candidateTemplateIds: mergedCandidateIds,
          subscriptionItemNames: nextSubscriptionItemNames,
          updatedAt: new Date()
        }
        delete nextExisting._id
        await setDoc(COLLECTIONS.deliveries, deliveryId, nextExisting)
        existing = { _id: deliveryId, ...nextExisting }
      }
    }
    return {
      processable: isProcessableDeliveryStatus(status, source, existing),
      reason: status || 'existing_delivery',
      deliveryId,
      delivery: {
        ...existing,
        itemNames: existing.itemNames && existing.itemNames.length
          ? existing.itemNames
          : pending.items.map(item => item.name),
        items: pending.items
      },
      created: false
    }
  }

  const now = new Date()
  const delivery = {
    openid: pending.openid,
    templateId: candidateTemplateIds[0] || pending.templateId,
    candidateTemplateIds,
    rejectedTemplateIds: [],
    roundKey,
    itemNames: pending.items.map(item => item.name),
    status: 'pending',
    source,
    attemptCount: 0,
    lockedUntil: null,
    lastAttemptAt: null,
    errorMsg: '',
    createdAt: now,
    updatedAt: now
  }

  try {
    await addDocWithId(COLLECTIONS.deliveries, deliveryId, delivery)
    return {
      processable: true,
      reason: delivery.status,
      deliveryId,
      delivery: {
        ...delivery,
        items: pending.items
      },
      created: true
    }
  } catch (error) {
    const latest = await getDoc(COLLECTIONS.deliveries, deliveryId)
    if (!latest) {
      throw error
    }
    const latestStatus = normalizeDeliveryStatus(latest && latest.status)
    return {
      processable: isProcessableDeliveryStatus(latestStatus, source, latest),
      reason: latestStatus || 'create_conflict',
      deliveryId,
      delivery: {
        ...latest,
        itemNames: latest.itemNames && latest.itemNames.length
          ? latest.itemNames
          : pending.items.map(item => item.name),
        items: pending.items
      },
      created: false
    }
  }
}

async function claimNotificationDelivery(deliveryId, delivery, source) {
  const latest = await getDoc(COLLECTIONS.deliveries, deliveryId)
  const status = normalizeDeliveryStatus(latest && latest.status)

  if (!isProcessableDeliveryStatus(status, source, latest)) {
    return { claimed: false, reason: status || 'missing_delivery', delivery: latest }
  }
  if (isLockedDelivery(latest)) {
    return { claimed: false, reason: 'sending', delivery: latest }
  }

  const now = new Date()
  const claimedDelivery = {
    ...(latest || {}),
    openid: delivery.openid,
    templateId: delivery.templateId,
    roundKey: delivery.roundKey,
    itemNames: delivery.itemNames || [],
    status: 'sending',
    source,
    attemptCount: Number(latest && latest.attemptCount ? latest.attemptCount : 0) + 1,
    lockedUntil: new Date(now.getTime() + DELIVERY_LOCK_MS),
    lastAttemptAt: now,
    createdAt: latest && latest.createdAt ? latest.createdAt : now,
    updatedAt: now
  }

  await setDoc(COLLECTIONS.deliveries, deliveryId, claimedDelivery)
  return { claimed: true, deliveryId, delivery: claimedDelivery }
}

function trimTemplateValue(value, maxLength = 20) {
  const text = String(value || '')
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function buildReminderRemark(remainingCount) {
  const count = Number(remainingCount)
  if (!Number.isFinite(count)) return '刷新啦，快去看看'
  if (count <= 0) return '次数用完，回小程序增加'
  if (count <= 1) return `仅剩${count}次，回小程序增加`
  return `刷新啦，还剩${count}次提醒`
}

function buildActivityProgressText(merchantInfo = {}) {
  const dateText = String(merchantInfo.date || '').trim()
  const timeText = String(merchantInfo.currentTime || '').trim().slice(0, 5)
  const round = Number(merchantInfo.round || 0)
  const shortDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText.slice(5) : dateText
  const occurrenceText = [shortDate, timeText].filter(Boolean).join(' ')
  return trimTemplateValue([occurrenceText, round > 0 ? `第${round}轮` : ''].filter(Boolean).join(' · ') || '查看当前进度')
}

function buildActivityReminderRemark(remainingCount) {
  const count = Number(remainingCount)
  if (!Number.isFinite(count)) return '回小程序查看提醒'
  return trimTemplateValue(`剩余 ${Math.max(0, count)} 次提醒`)
}

function buildAllDayReminderRemark(merchantInfo, itemNames) {
  const allDayItem = (itemNames || [])
    .map(name => getAllDayReminderItem(name))
    .find(Boolean)
  if (!allDayItem) return ''

  const remainingRounds = Math.max(0, 4 - Number(merchantInfo && merchantInfo.round ? merchantInfo.round : 0))
  if (!remainingRounds) return `${allDayItem.name}持续一天`
  return `${allDayItem.name}持续一天，后续${remainingRounds === 3 ? '三' : remainingRounds === 2 ? '两' : remainingRounds}轮不重复`
}

function formatNotificationItemNames(itemNames) {
  const names = Array.from(new Set((itemNames || [])
    .filter(name => typeof name === 'string')
    .map(name => name.trim())
    .filter(Boolean)))
  if (!names.length) return ''

  const joined = names.join('、')
  if (joined.length <= 20) return joined

  return trimTemplateValue(`${names[0]}等${names.length}件商品`)
}

function buildSubscribeMessageData({ templateConfig, itemName, itemNames, merchantInfo, remainingCount }) {
  const fieldKeys = templateConfig.fields
  if (templateConfig.payloadMode === TEMPLATE_PAYLOAD_MODES.activityProgress) {
    return {
      [fieldKeys.item]: { value: trimTemplateValue(itemName) },
      [fieldKeys.time]: { value: buildActivityProgressText(merchantInfo) },
      [fieldKeys.remark]: { value: buildActivityReminderRemark(remainingCount) }
    }
  }

  const allDayRemark = buildAllDayReminderRemark(merchantInfo, itemNames || [])
  return {
    [fieldKeys.item]: { value: trimTemplateValue(itemName) },
    [fieldKeys.time]: { value: `${merchantInfo.date} ${merchantInfo.currentTime || ''}`.trim() },
    [fieldKeys.remark]: { value: trimTemplateValue(allDayRemark || buildReminderRemark(remainingCount)) }
  }
}

async function sendSubscribeMessage({ openid, templateId, itemName, itemNames, merchantInfo, remainingCount }) {
  const templateConfig = getSubscribeTemplateConfig(templateId)
  if (!templateConfig) throw new Error('Subscribe template is not configured')
  const data = buildSubscribeMessageData({ templateConfig, itemName, itemNames, merchantInfo, remainingCount })

  const miniprogramState = process.env.WECHAT_MINIPROGRAM_STATE || 'formal'

  try {
    return await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId,
      page: 'pages/home/home',
      miniprogramState,
      data
    })
  } catch (error) {
    if (!isInvalidCloudOpenapiTokenError(error)) {
      throw error
    }

    console.warn(`[rocoApi] cloud.openapi subscribeMessage token invalid, falling back to HTTPS send: ${error.message}`)
    return sendSubscribeMessageByHttp({
      openid,
      templateId,
      data,
      miniprogramState
    })
  }
}

function isInvalidCloudOpenapiTokenError(error) {
  const message = `${error && error.errMsg ? error.errMsg : ''} ${error && error.message ? error.message : ''}`
  return error && (error.errCode === -501001 || message.includes('invalid wx openapi access_token'))
}

async function sendSubscribeMessageByHttp({ openid, templateId, data, miniprogramState }) {
  const accessToken = await getWechatAccessToken()
  const result = await postJson(`${WECHAT_SUBSCRIBE_SEND_URL}?access_token=${encodeURIComponent(accessToken)}`, {
    touser: openid,
    template_id: templateId,
    page: 'pages/home/home',
    miniprogram_state: miniprogramState,
    data
  }, {
    timeoutMs: Number(process.env.WECHAT_TIMEOUT_MS || 9000)
  })

  if (result.errcode) {
    throw new Error(`WeChat subscribe message send failed: ${result.errcode} ${result.errmsg || ''}`.trim())
  }

  return result
}

function buildPendingFromDelivery(delivery, merchantInfo, roundKey) {
  const itemNames = Array.isArray(delivery && delivery.itemNames)
    ? delivery.itemNames.filter(name => typeof name === 'string' && name.trim())
    : []
  const merchantItems = Array.isArray(merchantInfo && merchantInfo.items) ? merchantInfo.items : []
  const items = itemNames
    .map(name => merchantItems.find(item => item && item.name === name) || { name })
    .filter(item => item && item.name)

  return {
    openid: delivery.openid,
    templateId: delivery.templateId,
    candidateTemplateIds: Array.isArray(delivery.candidateTemplateIds) && delivery.candidateTemplateIds.length
      ? delivery.candidateTemplateIds
      : [delivery.templateId].filter(Boolean),
    roundKey,
    deliveryId: delivery._id || (Array.isArray(delivery.candidateTemplateIds)
      ? buildPooledNotificationDeliveryId(delivery.openid, roundKey)
      : buildNotificationDeliveryId(delivery.openid, delivery.templateId, roundKey)),
    delivery,
    itemNames,
    items: items.length ? items : itemNames.map(name => ({ name }))
  }
}

async function getRoundDeliveryQueueCounts(roundKey, openid = '') {
  const baseWhere = openid ? { roundKey, openid } : { roundKey }
  const [pending, sent, retryableFailed, legacyFailed, finalFailed, noQuota, sendingDocs, secondAttempt] = await Promise.all([
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'pending' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'sent' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'retryable_failed' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'failed' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'final_failed' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, status: 'no_quota' }),
    queryAll(COLLECTIONS.deliveries, { ...baseWhere, status: 'sending' }),
    countDocs(COLLECTIONS.deliveries, { ...baseWhere, attemptCount: _.gte(2) })
  ])
  const counts = {
    total: pending + sent + retryableFailed + legacyFailed + finalFailed + noQuota + sendingDocs.length,
    pending,
    sent,
    sending: sendingDocs.length,
    staleSending: sendingDocs.filter(delivery => !isLockedDelivery(delivery)).length,
    secondAttempt,
    retryableFailed: retryableFailed + legacyFailed,
    finalFailed,
    noQuota
  }
  return counts
}

function applyQueueCountsToStats(stats, counts) {
  const processableRemaining = Number(counts.pending || 0) + Number(counts.retryableFailed || 0) + Number(counts.staleSending || 0)
  stats.queueTotal = Number(counts.total || 0)
  stats.queueSent = Number(counts.sent || 0)
  stats.queuePending = Number(counts.pending || 0)
  stats.queueRetryableFailed = Number(counts.retryableFailed || 0)
  stats.queueFinalFailed = Number(counts.finalFailed || 0)
  stats.queueNoQuota = Number(counts.noQuota || 0)
  stats.staleSending = Number(counts.staleSending || 0)
  stats.secondAttempt = Number(counts.secondAttempt || 0)
  stats.pending = processableRemaining
  stats.deferred = processableRemaining
  stats.retryableFailed = Math.max(Number(stats.retryableFailed || 0), Number(counts.retryableFailed || 0))
  stats.finalFailed = Math.max(Number(stats.finalFailed || 0), Number(counts.finalFailed || 0))
  stats.noQuota = Math.max(Number(stats.noQuota || 0), Number(counts.noQuota || 0))
  stats.remainingBatches = stats.batchLimit > 0
    ? Math.ceil(processableRemaining / stats.batchLimit)
    : 0
}

async function queryProcessableRoundDeliveries(roundKey, source, openid = '') {
  const statuses = source === 'immediate'
    ? ['pending', 'retryable_failed', 'failed', 'sending', 'final_failed', 'no_quota']
    : ['pending', 'retryable_failed', 'failed', 'sending']
  const where = {
    roundKey,
    status: _.in(statuses),
    ...(openid ? { openid } : {})
  }
  const deliveries = await queryAll(COLLECTIONS.deliveries, where)
  return deliveries.filter(delivery => isProcessableDeliveryStatus(normalizeDeliveryStatus(delivery.status), source, delivery))
}

function normalizeTargetItems(target) {
  const items = Array.isArray(target && target.items)
    ? target.items
    : []
  return items.map(item => {
    const itemName = item.itemName || item.item_name || item.name || ''
    return {
      itemName,
      keywords: getItemKeywords(itemName, item.keywords)
    }
  }).filter(item => item.itemName)
}

async function loadSubscriptionTargets(openid = '') {
  const where = {
    enabled: true,
    ...(openid ? { openid } : {})
  }
  const targets = (await queryAll(COLLECTIONS.targets, where))
    .filter(target => target.openid && target.templateId && normalizeTargetItems(target).length)

  if (targets.length) return targets

  const subscriptions = (await queryAll(COLLECTIONS.subscriptions, openid ? { openid } : null))
    .filter(subscription => subscription.enabled === true)
  const targetMap = new Map()
  subscriptions.forEach(subscription => {
    const templateId = subscription.templateId || subscription.template_id || ''
    if (!subscription.openid || !templateId) return
    const key = `${subscription.openid}|${templateId}`
    const current = targetMap.get(key) || {
      openid: subscription.openid,
      templateId,
      enabled: true,
      items: []
    }
    current.items.push({
      itemName: subscription.itemName || subscription.item_name || '',
      keywords: subscription.keywords || []
    })
    targetMap.set(key, current)
  })
  return Array.from(targetMap.values())
}

function buildTargetsFromItemTargets(itemTargets) {
  const targetMap = new Map()
  ;(itemTargets || []).forEach(target => {
    const templateId = target.templateId || target.template_id || ''
    const itemName = target.itemName || target.item_name || ''
    if (!target.openid || !templateId || !itemName) return
    const key = `${target.openid}|${templateId}`
    const current = targetMap.get(key) || {
      openid: target.openid,
      templateId,
      enabled: true,
      items: []
    }
    if (!current.items.some(item => item.itemName === itemName)) {
      current.items.push({
        itemName,
        keywords: target.keywords || [itemName]
      })
    }
    targetMap.set(key, current)
  })
  return Array.from(targetMap.values())
}

async function loadSubscriptionTargetsV2ForMerchant(merchantInfo, openid = '') {
  const itemKeys = getMerchantItemKeys(merchantInfo && merchantInfo.items)
  if (!itemKeys.length) return []
  const where = {
    enabled: true,
    ...(openid ? { openid } : { itemKey: _.in(itemKeys) })
  }
  const itemTargets = (await queryAll(COLLECTIONS.itemTargetsV2, where)).filter(target => {
    return target.enabled === true && (!openid || target.openid === openid) && itemKeys.includes(target.itemKey)
  })
  const openids = Array.from(new Set(itemTargets.map(target => target.openid).filter(Boolean)))
  if (!openids.length) return []
  const profiles = []
  for (let index = 0; index < openids.length; index += QUOTA_QUERY_BATCH_SIZE) {
    profiles.push(...await queryAll(COLLECTIONS.subscriptionProfiles, {
      openid: _.in(openids.slice(index, index + QUOTA_QUERY_BATCH_SIZE)),
      enabled: true
    }))
  }
  const targets = []
  profiles.forEach(profile => {
    const matchedItems = itemTargets
      .filter(target => target.openid === profile.openid)
      .map(target => ({ itemName: target.itemName, keywords: target.keywords || [target.itemName] }))
    ;(profile.enabledTemplateIds || []).forEach(templateId => {
      if (!getSubscribeTemplateConfig(templateId) || !matchedItems.length) return
      targets.push({ openid: profile.openid, templateId, enabled: true, items: matchedItems })
    })
  })
  return targets
}

async function loadSubscriptionTargetsV1ForMerchant(merchantInfo, openid = '') {
  const itemKeys = getMerchantItemKeys(merchantInfo && merchantInfo.items)
  if (!itemKeys.length) return []

  const where = {
    enabled: true,
    ...(openid ? { openid } : { itemKey: _.in(itemKeys) })
  }
  const itemTargets = (await queryAll(COLLECTIONS.itemTargets, where))
    .filter(target => {
      return target.enabled === true &&
        (!openid || target.openid === openid) &&
        itemKeys.includes(target.itemKey)
    })
  if (itemTargets.length) {
    return buildTargetsFromItemTargets(itemTargets)
  }

  const anyItemTarget = await queryAll(COLLECTIONS.itemTargets, { enabled: true }, 1)
  if (anyItemTarget.length && !openid) return []

  return loadSubscriptionTargets(openid)
}

function getSubscriptionTargetComparisonKeys(targets = []) {
  return targets.map(target => {
    const itemSignature = getFollowedItemsSignature(getTargetFollowedItems(target))
    return `${target.openid || ''}|${target.templateId || ''}|${itemSignature}`
  }).sort()
}

async function loadSubscriptionTargetsForMerchant(merchantInfo, openid = '') {
  if (SUBSCRIPTION_V2_READ) {
    const v2Targets = await loadSubscriptionTargetsV2ForMerchant(merchantInfo, openid)
    if (v2Targets.length || !SUBSCRIPTION_V2_READ_FALLBACK) {
      markUsageSource('subscription_targets_v2')
      return v2Targets
    }
  }

  const v1Targets = await loadSubscriptionTargetsV1ForMerchant(merchantInfo, openid)
  if (SUBSCRIPTION_V2_SHADOW_READ && !SUBSCRIPTION_V2_READ) {
    const v2Targets = await loadSubscriptionTargetsV2ForMerchant(merchantInfo, openid)
    const v1Keys = getSubscriptionTargetComparisonKeys(v1Targets)
    const v2Keys = getSubscriptionTargetComparisonKeys(v2Targets)
    console.log('[subscription-v2][shadow]', JSON.stringify({
      roundKey: merchantInfo && merchantInfo.roundKey || buildRoundKey(merchantInfo && merchantInfo.date, merchantInfo && merchantInfo.round),
      openid: openid || '',
      v1TargetCount: v1Targets.length,
      v2TargetCount: v2Targets.length,
      matched: v1Keys.join('\n') === v2Keys.join('\n')
    }))
  }
  return v1Targets
}

async function loadQuotasForTargets(targets) {
  const openids = Array.from(new Set((targets || []).map(target => target.openid).filter(Boolean)))
  const quotas = []
  for (let index = 0; index < openids.length; index += QUOTA_QUERY_BATCH_SIZE) {
    const batch = openids.slice(index, index + QUOTA_QUERY_BATCH_SIZE)
    quotas.push(...await queryAll(COLLECTIONS.quotas, { openid: _.in(batch) }))
  }
  return quotas
}

function isLastRecipient(openid) {
  return Boolean(LAST_RECIPIENT_OPENID) && openid === LAST_RECIPIENT_OPENID
}

async function materializeNotificationDeliveries(merchantInfo, options = {}) {
  if (!merchantInfo || merchantInfo.status !== 'active' || !merchantInfo.round || !Array.isArray(merchantInfo.items)) {
    return createEmptyNotificationStats()
  }

  const roundKey = buildRoundKey(merchantInfo.date, merchantInfo.round)
  const targets = await loadSubscriptionTargetsForMerchant(merchantInfo, options.openid || '')
  const allowedSubscriptions = options.itemNames && options.itemNames.length
    ? new Set(options.itemNames)
    : null
  const source = options.source || (options.openid ? 'immediate' : 'timer')
  const stats = createEmptyNotificationStats(targets.length)
  const quotas = await loadQuotasForTargets(targets)
  const quotaMap = new Map(quotas.map(quota => [
    `${quota.openid}|${quota.templateId}`,
    quota
  ]))
  const pendingMap = new Map()
  const roundItemMap = new Map()
  const allDaySentSet = await buildAllDaySentReminderSet(merchantInfo)

  for (const target of targets) {
    const targetItems = normalizeTargetItems(target)
      .filter(item => isReminderPolicyAllowed(item.itemName, merchantInfo))
      .filter(item => !allowedSubscriptions || allowedSubscriptions.has(item.itemName) || Array.from(allowedSubscriptions).some(itemName => {
        return isSubscriptionMatched(itemName, { itemName: item.itemName, keywords: item.keywords })
      }))
    if (!targetItems.length) continue

    const quota = quotaMap.get(`${target.openid}|${target.templateId}`)
    const subscriptionKey = `${target.openid}|${target.templateId}`
    const quotaRejected = isQuotaWechatRejected(quota)
    const remainingQuota = Number(quota && quota.remainingCount ? quota.remainingCount : 0)
    const isPushableSubscription = !quotaRejected && remainingQuota > 0
    const matchedItems = []

    targetItems.forEach(targetItem => {
      const subscription = {
        openid: target.openid,
        templateId: target.templateId,
        itemName: targetItem.itemName,
        keywords: targetItem.keywords
      }
      merchantInfo.items
        .filter(item => isSubscriptionMatched(item.name, subscription))
        .forEach(item => {
          addRoundItemSnapshotMatch(roundItemMap, item.name, subscriptionKey, isPushableSubscription)
          if (!matchedItems.some(existing => existing.name === item.name)) {
            matchedItems.push(item)
          }
        })
    })

    if (quotaRejected) {
      stats.wechatRejected += 1
      stats.skipped += 1
      continue
    }
    if (remainingQuota <= 0) {
      stats.skippedNoQuota += 1
      stats.noQuota += 1
      continue
    }
    stats.quotaEligible += 1

    const pushableMatchedItems = filterAllDayReminderItemsWithSentSet(target.openid, target.templateId, merchantInfo, matchedItems, allDaySentSet)
    stats.skipped += matchedItems.length - pushableMatchedItems.length

    for (const item of pushableMatchedItems) {
      const pendingKey = target.openid
      if (!pendingMap.has(pendingKey)) {
        pendingMap.set(pendingKey, {
          openid: target.openid,
          templateId: target.templateId,
          candidateTemplateIds: new Set(),
          items: [],
          itemNameSet: new Set(),
          subscriptionItemNames: new Set()
        })
      }

      const pending = pendingMap.get(pendingKey)
      pending.candidateTemplateIds.add(target.templateId)
      targetItems.forEach(targetItem => pending.subscriptionItemNames.add(targetItem.itemName))
      if (!pending.itemNameSet.has(item.name)) {
        pending.itemNameSet.add(item.name)
        pending.items.push(item)
      }
    }
  }

  const candidates = Array.from(pendingMap.values()).map(pending => ({
    ...pending,
    candidateTemplateIds: SUBSCRIBE_TEMPLATE_CONFIGS
      .map(config => config.templateId)
      .filter(templateId => pending.candidateTemplateIds.has(templateId)),
    itemNames: pending.items.map(item => item.name),
    subscriptionItemNames: Array.from(pending.subscriptionItemNames || [])
  })).filter(pending => pending.candidateTemplateIds.length)
  const roundItemSnapshot = serializeRoundItemSnapshot(roundItemMap)
  stats.roundItems = roundItemSnapshot.roundItems
  stats.roundItemTotals = roundItemSnapshot.roundItemTotals
  stats.roundItemSnapshotRecorded = true
  stats.matched = candidates.length
  stats.batchLimit = getNotificationBatchLimit(options.batchLimit)
  stats.timeBudgetMs = getNotificationTimeBudgetMs(options.timeBudgetMs)

  const processable = []
  await runNotificationPool(candidates, NOTIFY_CONCURRENCY, async pending => {
    const materialized = await materializeNotificationDelivery(pending, roundKey, source)
    if (materialized.delivery) stats.materialized += 1
    if (materialized.created) stats.createdDelivery += 1
    if (!materialized.processable) {
      if (materialized.delivery && normalizeDeliveryStatus(materialized.delivery.status) === 'sent' && needsQuotaConfirmation(materialized.delivery)) {
        const repair = await confirmSentDeliveryQuota(materialized.deliveryId, materialized.delivery, { retry: true })
        if (repair.consumed) {
          stats.quotaRepaired += 1
        } else {
          stats.quotaRepairFailed += 1
          stats.failed += 1
        }
      }
      stats.skipped += pending.items.length
      if (materialized.delivery) stats.existingDelivery += 1
      return
    }

    processable.push({
      ...pending,
      deliveryId: materialized.deliveryId,
      delivery: materialized.delivery
    })
  })

  stats.pending = processable.length
  stats.deferred = Math.max(0, stats.pending)
  if (options.skipQueueCounts !== true) {
    applyQueueCountsToStats(stats, await getRoundDeliveryQueueCounts(roundKey, options.openid || ''))
  }
  console.info(`[rocoApi] notification materialized ${roundKey}: targetCandidates=${targets.length} quotaCandidates=${quotas.length} deliveriesCreated=${stats.createdDelivery} sent=${stats.sent}`)

  return stats
}

async function notifySubscribersForMerchant(merchantInfo, options = {}) {
  const stats = await materializeNotificationDeliveries(merchantInfo, {
    ...options,
    skipQueueCounts: true
  })
  if (typeof options.onMaterialized === 'function') {
    await options.onMaterialized({ ...stats })
  }
  if (!merchantInfo || merchantInfo.status !== 'active' || !merchantInfo.round || !Array.isArray(merchantInfo.items)) {
    return stats
  }
  return dispatchNotificationQueueForMerchant(merchantInfo, options, stats)
}

async function dispatchNotificationQueueForMerchant(merchantInfo, options = {}, baseStats = null) {
  if (!merchantInfo || merchantInfo.status !== 'active' || !merchantInfo.round || !Array.isArray(merchantInfo.items)) {
    return baseStats || createEmptyNotificationStats()
  }

  const roundKey = buildRoundKey(merchantInfo.date, merchantInfo.round)
  const source = options.source || (options.openid ? 'immediate' : 'timer')
  const stats = baseStats || createEmptyNotificationStats()
  stats.batchLimit = getNotificationBatchLimit(options.batchLimit)
  stats.timeBudgetMs = getNotificationTimeBudgetMs(options.timeBudgetMs)
  const startedAt = Date.now()
  const shouldContinue = () => Date.now() - startedAt < stats.timeBudgetMs
  const deliveries = await queryProcessableRoundDeliveries(roundKey, source, options.openid || '')
  const normalDeliveries = deliveries.filter(delivery => !isLastRecipient(delivery.openid))
  const lastRecipientDeliveries = deliveries.filter(delivery => isLastRecipient(delivery.openid))
  const selectedDeliveries = normalDeliveries.length ? normalDeliveries : lastRecipientDeliveries
  stats.lastRecipientDeferred = normalDeliveries.length > 0 && lastRecipientDeliveries.length > 0
  const processNow = selectedDeliveries
    .slice(0, stats.batchLimit)
    .map(delivery => buildPendingFromDelivery(delivery, merchantInfo, roundKey))
    .filter(pending => pending.openid && pending.templateId && pending.items.length)
  const processedBefore = stats.processed

  await runNotificationPoolUntil(processNow, NOTIFY_CONCURRENCY, item => (
    sendMaterializedNotification(item, merchantInfo, roundKey, source, stats)
  ), shouldContinue)

  const processedThisRun = stats.processed - processedBefore
  stats.timeBudgetReached = processedThisRun < processNow.length && !shouldContinue()
  applyQueueCountsToStats(stats, await getRoundDeliveryQueueCounts(roundKey, options.openid || ''))
  console.info(`[rocoApi] notification dispatched ${roundKey}: targetCandidates=${stats.checked} quotaEligible=${stats.quotaEligible} deliveriesCreated=${stats.createdDelivery} sent=${stats.sent} pending=${stats.pending}`)
  return stats
}

async function runNotificationPool(items, concurrency, handler) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await handler(item)
    }
  })
  await Promise.all(workers)
}

async function runNotificationPoolUntil(items, concurrency, handler, shouldContinue) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length && shouldContinue()) {
      const item = items[index]
      index += 1
      await handler(item)
    }
  })
  await Promise.all(workers)
}

async function sendMaterializedNotification(pending, merchantInfo, roundKey, source, stats) {
  while (true) {
    const claim = await claimNotificationDeliveryWithQuota(pending, roundKey, source)
    if (!claim.claimed) {
      stats.processed += 1
      stats.skipped += pending.items.length
      if (claim.delivery) stats.existingDelivery += 1
      if (claim.reason === 'wechat_rejected') {
        stats.wechatRejected += 1
        stats.finalFailed += 1
      }
      if (claim.reason === 'no_quota') stats.noQuota += 1
      if (claim.reason === 'max_attempts') stats.finalFailed += 1
      return
    }

    try {
      await sendSubscribeMessage({
        openid: pending.openid,
        templateId: claim.templateId,
        itemName: formatNotificationItemNames(pending.itemNames),
        itemNames: pending.itemNames,
        merchantInfo,
        remainingCount: claim.remainingCountAfter
      })
    } catch (error) {
      const failure = classifySubscribeSendError(error)
      await finalizeFailedNotification(pending, claim, roundKey, failure)
      console.warn(`[rocoApi] Subscribe send failed: ${error.message}`)
      if (failure.wechatRejected) {
        stats.wechatRejected += 1
        continue
      }
      stats.processed += 1
      if (failure.status === 'retryable_failed') {
        stats.failed += 1
        stats.retryableFailed += 1
      } else {
        stats.finalFailed += 1
      }
      return
    }

    stats.processed += 1
    stats.sent += 1
    await finalizeSuccessfulNotification(pending, claim, roundKey, source)
    return
  }
}

function maybeScheduleNotificationContinuation(roundKey, notification) {
  const remaining = Number(notification && notification.pending ? notification.pending : 0)
  if (remaining <= 0) return false
  const maintenanceSecret = process.env.MAINTENANCE_SECRET || ''
  if (!maintenanceSecret) return false

  cloud.callFunction({
    name: 'rocoApi',
    data: {
      action: 'admin.notifyRoundPending',
      maintenanceSecret,
      roundKey,
      batchLimit: NOTIFY_BATCH_LIMIT,
      timeBudgetMs: NOTIFY_TIME_BUDGET_MS
    }
  }).catch(error => {
    console.warn(`[rocoApi] Async notification continuation failed: ${error.message}`)
  })
  return true
}

async function notifyCurrentMerchant(event = {}) {
  if (event.force) {
    const secretError = validateMaintenanceSecret(event)
    if (secretError) return fail(secretError)
  }

  const parts = getChinaParts()
  if (!event.force && (![8, 12, 16, 20].includes(parts.hour) || !RETRY_MINUTES.includes(parts.minute))) {
    return ok({ skipped: true, reason: 'outside_retry_window' })
  }

  const now = new Date()
  const roundInfo = getCurrentRoundInfo(now)
  const baseMerchant = buildBaseMerchant(roundInfo, now)

  if (roundInfo.status !== 'active' || !roundInfo.round) {
    return ok({ skipped: true, reason: 'inactive_round', merchantInfo: baseMerchant })
  }

  const existingJob = await getRoundJob(baseMerchant.date, baseMerchant.round)
  if (isRoundNotificationCompleted(existingJob)) {
    return ok({
      skipped: true,
      reason: 'round_already_processed',
      job: existingJob
    })
  }

  try {
    const historyRecord = await getHistoryRecord(baseMerchant.date, baseMerchant.round)
    const historyMerchant = historyRecord && historyRecord.items && historyRecord.items.length
      ? {
        ...baseMerchant,
        items: historyRecord.items,
        source: historyRecord.source || 'history'
      }
      : null
    let merchantInfo = hasTrustedTimerCollection(existingJob) && historyMerchant
      ? historyMerchant
      : null

    if (!merchantInfo) {
      merchantInfo = await fetchCurrentMerchantSnapshot(now)
      if (!hasNormalRefreshItem(merchantInfo) && parts.minute < FINAL_RETRY_MINUTE) {
        await recordRoundJobAttempt({
          merchantInfo,
          attemptMinute: parts.minute,
          status: 'retrying',
          error: new Error('normal_refresh_missing_waiting')
        })
        return ok({
          merchantInfo,
          skipped: true,
          retrying: true,
          reason: 'normal_refresh_missing_waiting'
        })
      }
      await recordMerchantSnapshot(merchantInfo)
    }

    await recordRoundJobAttempt({
      merchantInfo,
      attemptMinute: parts.minute,
      status: 'processing',
      notification: createEmptyNotificationStats()
    })

    const shouldMaterialize = !existingJob ||
      !existingJob.notification ||
      existingJob.notification.roundItemSnapshotRecorded !== true
    const notification = shouldMaterialize
      ? await notifySubscribersForMerchant(merchantInfo, {
        source: 'timer',
        onMaterialized: materializedNotification => recordRoundJobAttempt({
          merchantInfo,
          attemptMinute: parts.minute,
          status: 'processing',
          notification: materializedNotification
        })
      })
      : await dispatchNotificationQueueForMerchant(merchantInfo, { source: 'timer' })
    if (notification.failed > 0 || notification.pending > 0) {
      const continuationScheduled = maybeScheduleNotificationContinuation(buildRoundKey(merchantInfo.date, merchantInfo.round), notification)
      await recordRoundJobAttempt({
        merchantInfo,
        attemptMinute: parts.minute,
        status: 'retrying',
        notification,
        error: new Error(notification.pending > 0 ? 'notification_pending' : 'notification_failed')
      })
      return ok({
        merchantInfo,
        notification,
        retrying: true,
        reason: notification.pending > 0 ? 'notification_pending' : 'notification_failed',
        continuationScheduled
      })
    }

    await recordRoundJobAttempt({
      merchantInfo,
      attemptMinute: parts.minute,
      status: 'success',
      notification
    })
    return ok({ merchantInfo, notification })
  } catch (error) {
    await recordRoundJobAttempt({
      merchantInfo: baseMerchant,
      attemptMinute: parts.minute,
      status: 'retrying',
      error
    })
    console.warn(`[rocoApi] Round ${baseMerchant.date}_round_${baseMerchant.round} attempt failed: ${error.message}`)
    return ok({
      skipped: true,
      reason: 'collect_failed',
      retrying: true,
      error: error.message,
      merchantInfo: baseMerchant
    })
  }
}

async function notifyRoundPending(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const roundInfo = parseRoundKey(event.roundKey)
  if (!roundInfo) {
    return fail('roundKey 格式不正确')
  }

  const historyRecord = await getHistoryRecord(roundInfo.date, roundInfo.round)
  if (!historyRecord || !Array.isArray(historyRecord.items) || !historyRecord.items.length) {
    return fail('该轮历史商品未记录，不能安全补发')
  }

  const attemptMinute = Number.isFinite(Number(event.attemptMinute))
    ? Number(event.attemptMinute)
    : getChinaParts().minute
  const merchantInfo = {
    date: historyRecord.date || roundInfo.date,
    round: historyRecord.round || roundInfo.round,
    timeRange: historyRecord.timeRange || '',
    currentTime: historyRecord.currentTime || '',
    status: 'active',
    source: historyRecord.source || 'history',
    items: historyRecord.items
  }

  await recordRoundJobAttempt({
    merchantInfo,
    attemptMinute,
    status: 'processing',
    manual: true
  })

  const notification = await dispatchNotificationQueueForMerchant(merchantInfo, {
    source: 'admin',
    batchLimit: event.batchLimit,
    timeBudgetMs: event.timeBudgetMs
  })
  const needsRetry = Number(notification.failed || 0) > 0 || Number(notification.pending || 0) > 0
  const continuationScheduled = needsRetry
    ? maybeScheduleNotificationContinuation(buildRoundKey(merchantInfo.date, merchantInfo.round), notification)
    : false

  await recordRoundJobAttempt({
    merchantInfo,
    attemptMinute,
    status: needsRetry ? 'retrying' : 'success',
    notification,
    error: needsRetry ? new Error(Number(notification.pending || 0) > 0 ? 'notification_pending' : 'notification_failed') : null,
    manual: true
  })

  return ok({
    merchantInfo,
    notification,
    retrying: needsRetry,
    continuationScheduled
  }, needsRetry ? '本轮待处理已补发一批，仍有剩余或失败' : '本轮待处理已补发完成')
}

function validateMaintenanceSecret(event = {}) {
  const expectedSecret = process.env.MAINTENANCE_SECRET || ''
  const providedSecret = typeof event.maintenanceSecret === 'string' ? event.maintenanceSecret : ''

  return expectedSecret && providedSecret === expectedSecret ? '' : '维护密钥不正确'
}

function getManualCurrentRoundContext(now = new Date()) {
  const roundInfo = getCurrentRoundInfo(now)
  const roundKey = roundInfo.status === 'active'
    ? buildRoundKey(formatChinaDate(now), roundInfo.round)
    : ''
  return { now, roundInfo, roundKey }
}

function normalizeAdminCurrentRecord(record, context) {
  return {
    roundKey: context.roundKey,
    date: context.roundKey ? formatChinaDate(context.now) : '',
    round: context.roundInfo.round || 0,
    timeRange: context.roundInfo.timeRange || '',
    status: context.roundInfo.status,
    hasData: Boolean(record && Array.isArray(record.items) && record.items.length),
    source: record && record.source ? record.source : '',
    manualOverride: Boolean(record && record.manualOverride === true),
    manualAt: record && (record.manualAt || record.capturedAt || record.fetchedAt) || '',
    items: record && Array.isArray(record.items)
      ? record.items.map(item => ({
        id: item.id || item.product_id || item.name,
        product_id: item.product_id || '',
        name: item.name || '',
        image: item.image || item.image_snapshot || ''
      }))
      : []
  }
}

async function getManualCurrentRecord(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  const context = getManualCurrentRoundContext()
  if (!context.roundKey) return ok(normalizeAdminCurrentRecord(null, context))
  const parsed = parseRoundKey(context.roundKey)
  const record = parsed ? await getHistoryRecord(parsed.date, parsed.round) : null
  return ok(normalizeAdminCurrentRecord(record, context))
}

function buildManualCatalogItem(product) {
  return normalizeProp({
    id: product.product_id,
    product_id: product.product_id,
    name: product.title,
    icon_url: product.image_file_id || product.image_url || ''
  })
}

async function saveManualCurrentRecord(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const context = getManualCurrentRoundContext()
  if (!context.roundKey || context.roundInfo.status !== 'active') return fail('当前不在远行商人开放轮次')
  if (String(event.roundKey || '') !== context.roundKey) return fail('轮次已变化，请刷新后重试', { code: 'ROUND_CHANGED' })

  const productIds = Array.from(new Set((Array.isArray(event.productIds) ? event.productIds : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)))
  if (!productIds.length) return fail('请至少选择一个商品')
  const products = productIds.map(productId => productCatalogRuntime.byId.get(productId)).filter(Boolean)
  if (products.length !== productIds.length) return fail('所选商品包含无效或已停用商品，请刷新目录后重试')

  const parsed = parseRoundKey(context.roundKey)
  const existing = parsed ? await getHistoryRecord(parsed.date, parsed.round) : null
  if (existing && Array.isArray(existing.items) && existing.items.length && event.overwrite !== true) {
    return fail('当前轮已有商品数据，请确认覆盖后再保存', { code: 'CURRENT_DATA_EXISTS' })
  }

  const base = buildBaseMerchant(context.roundInfo, context.now)
  const snapshot = {
    ...base,
    source: 'admin_manual',
    items: products.map(buildManualCatalogItem),
    manualOverride: true,
    manualBy: String(event.adminOpenid || ''),
    manualAt: context.now
  }
  await recordMerchantSnapshot(snapshot)
  const record = await getHistoryRecord(base.date, base.round)
  return ok({
    ...normalizeAdminCurrentRecord(record, context),
    overwritten: Boolean(existing && Array.isArray(existing.items) && existing.items.length)
  }, '人工兜底商品已保存，本轮自动同步已锁定')
}

function getCurrentRecordProduct(record, productId) {
  return (record && Array.isArray(record.items) ? record.items : []).find(item => {
    if (String(item.product_id || '') === productId) return true
    const product = getCatalogProduct(item)
    return Boolean(product && product.product_id === productId)
  }) || null
}

async function loadManualNotificationContext(event = {}) {
  const context = getManualCurrentRoundContext()
  if (!context.roundKey || String(event.roundKey || '') !== context.roundKey) {
    throw new Error('轮次已变化，请刷新后重试')
  }
  const parsed = parseRoundKey(context.roundKey)
  const record = parsed ? await getHistoryRecord(parsed.date, parsed.round) : null
  if (!record || !Array.isArray(record.items) || !record.items.length) throw new Error('当前轮商品尚未写入')
  const productId = String(event.productId || '').trim()
  const item = getCurrentRecordProduct(record, productId)
  if (!item) throw new Error('所选商品不在当前轮，请刷新后重试')
  const merchantInfo = {
    date: record.date || parsed.date,
    round: record.round || parsed.round,
    timeRange: record.timeRange || context.roundInfo.timeRange || '',
    currentTime: formatChinaTime(),
    status: 'active',
    source: record.source || 'history',
    items: [item]
  }
  return { context, record, item, merchantInfo }
}

async function buildManualNotificationPreview(merchantInfo, item) {
  const roundKey = buildRoundKey(merchantInfo.date, merchantInfo.round)
  const targets = await loadSubscriptionTargetsForMerchant(merchantInfo)
  const quotas = await loadQuotasForTargets(targets)
  const quotaMap = new Map(quotas.map(quota => [`${quota.openid}|${quota.templateId}`, quota]))
  const deliveries = await queryAll(COLLECTIONS.deliveries, { roundKey })
  const sentKeys = new Set(deliveries
    .filter(delivery => normalizeDeliveryStatus(delivery.status) === 'sent')
    .map(delivery => `${delivery.openid}|${delivery.templateId}`))
  const allDaySentSet = await buildAllDaySentReminderSet(merchantInfo)
  const followerUsers = new Set()
  const eligibleUsers = new Set()

  targets.forEach(target => {
    const targetItems = normalizeTargetItems(target)
    const matches = targetItems.some(targetItem => isSubscriptionMatched(item.name, {
      itemName: targetItem.itemName,
      keywords: targetItem.keywords
    }))
    if (!matches) return
    followerUsers.add(target.openid)
    const quota = quotaMap.get(`${target.openid}|${target.templateId}`)
    if (!quota || quota.wechatRejected === true || Number(quota.remainingCount || 0) <= 0) return
    if (sentKeys.has(`${target.openid}|${target.templateId}`)) return
    const pushableItems = filterAllDayReminderItemsWithSentSet(
      target.openid,
      target.templateId,
      merchantInfo,
      [item],
      allDaySentSet
    )
    if (pushableItems.length) eligibleUsers.add(target.openid)
  })

  return {
    roundKey,
    productId: item.product_id || (getCatalogProduct(item) && getCatalogProduct(item).product_id) || '',
    itemName: item.name,
    followerCount: followerUsers.size,
    eligibleCount: eligibleUsers.size
  }
}

async function previewManualNotification(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  try {
    const { merchantInfo, item } = await loadManualNotificationContext(event)
    return ok(await buildManualNotificationPreview(merchantInfo, item))
  } catch (error) {
    return fail(error.message || '推送预览失败')
  }
}

async function notifyManualCurrentItem(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  if (event.confirmSend !== true) return fail('请先完成二次确认', { code: 'CONFIRM_REQUIRED' })

  try {
    const { context, merchantInfo, item } = await loadManualNotificationContext(event)
    const preview = await buildManualNotificationPreview(merchantInfo, item)
    const attemptMinute = getChinaParts(context.now).minute
    const notification = await notifySubscribersForMerchant(merchantInfo, {
      source: 'admin',
      onMaterialized: materializedNotification => recordRoundJobAttempt({
        merchantInfo,
        attemptMinute,
        status: 'processing',
        notification: materializedNotification,
        manual: true
      })
    })
    const needsRetry = Number(notification.failed || 0) > 0 || Number(notification.pending || 0) > 0
    const continuationScheduled = needsRetry
      ? maybeScheduleNotificationContinuation(context.roundKey, notification)
      : false
    await recordRoundJobAttempt({
      merchantInfo,
      attemptMinute,
      status: needsRetry ? 'retrying' : 'success',
      notification,
      error: needsRetry ? new Error(Number(notification.pending || 0) > 0 ? 'notification_pending' : 'notification_failed') : null,
      manual: true
    })
    return ok({
      preview,
      notification,
      continuationScheduled
    }, needsRetry ? '提醒已发送一批，剩余任务将继续处理' : '重点商品提醒已处理完成')
  } catch (error) {
    return fail(error.message || '重点商品提醒发送失败')
  }
}

async function syncCurrentMerchant(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  return ok(await collectCurrentMerchant(), '当前轮次已写入历史')
}

async function forceSyncCurrentMerchant(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const now = new Date()
  const merchantInfo = await fetchCurrentMerchantSnapshot(now)
  if (merchantInfo.status !== 'active' || !merchantInfo.round) {
    return ok({
      skipped: true,
      reason: 'inactive_round',
      merchantInfo
    })
  }

  await recordMerchantSnapshot(merchantInfo)

  const shouldNotify = event.notify === true
  const attemptMinute = getChinaParts(now).minute
  const notification = shouldNotify ? await notifySubscribersForMerchant(merchantInfo, {
    source: 'admin',
    onMaterialized: materializedNotification => recordRoundJobAttempt({
      merchantInfo,
      attemptMinute,
      status: 'processing',
      notification: materializedNotification,
      manual: true
    })
  }) : null
  const needsRetry = notification && (Number(notification.failed || 0) > 0 || Number(notification.pending || 0) > 0)
  const continuationScheduled = notification && needsRetry
    ? maybeScheduleNotificationContinuation(buildRoundKey(merchantInfo.date, merchantInfo.round), notification)
    : false
  await recordRoundJobAttempt({
    merchantInfo,
    attemptMinute,
    status: needsRetry ? 'retrying' : 'success',
    notification,
    error: needsRetry ? new Error(Number(notification.pending || 0) > 0 ? 'notification_pending' : 'notification_failed') : null,
    manual: true
  })

  return ok({
    merchantInfo,
    notification,
    notified: shouldNotify,
    continuationScheduled
  }, shouldNotify ? '当前轮次已强制同步并推送' : '当前轮次已强制同步')
}

async function submitFeedback(event, openid) {
  if (!openid) return fail('无法识别当前用户')
  const type = typeof event.type === 'string' ? event.type.trim() : ''
  const content = typeof event.content === 'string' ? event.content.trim() : ''
  const validTypes = ['商品数据错误', '页面显示问题', '功能建议', '其他问题']

  if (!validTypes.includes(type) || !content) {
    return fail('反馈类型或内容不能为空')
  }
  if (content.length > 500) return fail('反馈内容不能超过 500 个字')

  const feedback = {
    openid,
    type,
    content,
    createdAt: new Date(),
    status: 'new'
  }
  const result = await db.collection(COLLECTIONS.feedback).add({ data: feedback })
  trackDbWrite(COLLECTIONS.feedback, 1, 'add')
  return ok(normalizeUserFeedback({ _id: result._id || '', ...feedback }), '反馈已提交')
}

function getFeedbackTime(value) {
  const normalized = normalizeAnnouncementDate(value)
  const time = new Date(normalized || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function isFeedbackReplyUnread(feedback = {}) {
  if (!String(feedback.publicReply || '').trim()) return false
  const replyUpdatedAt = getFeedbackTime(feedback.replyUpdatedAt)
  const replyReadAt = getFeedbackTime(feedback.replyReadAt)
  return replyUpdatedAt > 0 && replyUpdatedAt > replyReadAt
}

function normalizeUserFeedback(feedback = {}) {
  return {
    id: String(feedback._id || feedback.id || ''),
    type: String(feedback.type || ''),
    content: String(feedback.content || ''),
    status: feedback.status === 'handled' ? 'handled' : 'new',
    publicReply: String(feedback.publicReply || ''),
    createdAt: normalizeAnnouncementDate(feedback.createdAt),
    replyUpdatedAt: normalizeAnnouncementDate(feedback.replyUpdatedAt),
    replyReadAt: normalizeAnnouncementDate(feedback.replyReadAt),
    unread: isFeedbackReplyUnread(feedback)
  }
}

async function getMyFeedback(event, openid) {
  if (!openid) return fail('无法识别当前用户')
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1)
  const pageSize = Math.min(30, Math.max(1, Number.parseInt(event.pageSize, 10) || 10))
  const result = await queryCursorPage(
    COLLECTIONS.feedback,
    { openid },
    'createdAt',
    pageSize,
    event.cursor,
    page
  )
  return ok({
    items: result.items.map(normalizeUserFeedback),
    page,
    pageSize,
    total: null,
    unreadCount: result.items.filter(isFeedbackReplyUnread).length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
  })
}

async function markFeedbackRead(event, openid) {
  if (!openid) return fail('无法识别当前用户')
  const id = String(event.id || '').trim()
  if (!id) return fail('反馈 id 不能为空')
  const existing = await getDoc(COLLECTIONS.feedback, id)
  if (!existing || String(existing.openid || '') !== String(openid || '')) return fail('反馈不存在')
  if (!String(existing.publicReply || '').trim()) return ok({ id, unread: false })

  const replyReadAt = new Date()
  await setDoc(COLLECTIONS.feedback, id, {
    ...existing,
    replyReadAt
  })
  return ok({
    id,
    unread: false,
    replyReadAt: normalizeAnnouncementDate(replyReadAt)
  })
}

async function getCurrentAnnouncement() {
  const doc = await getDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const announcement = normalizeAnnouncement(doc || {
    enabled: false,
    title: '公告',
    content: ''
  })

  return ok({ announcement })
}

function isBootstrapAdmin(openid) {
  const adminOpenids = String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return Boolean(openid && adminOpenids.includes(openid))
}

async function getHomeBootstrap(event = {}, openid = '') {
  const allowedSections = new Set(['merchant', 'announcement', 'subscription', 'vote'])
  const requestedSections = Array.isArray(event.sections) && event.sections.length
    ? event.sections.filter(section => allowedSections.has(section))
    : Array.from(allowedSections)
  const sections = new Set(requestedSections)
  const now = new Date()
  const currentRoundKey = getCurrentRoundKey(now)
  const tasks = {}

  if (sections.has('merchant')) tasks.merchant = getCurrentMerchant(now)
  if (sections.has('announcement')) tasks.announcement = getCurrentAnnouncement()
  if (sections.has('subscription')) tasks.subscription = getSubscriptionStatus(event, openid)
  if (sections.has('vote') && currentRoundKey) {
    tasks.vote = getRoundVoteSummary({ roundKey: currentRoundKey }, openid)
  }
  tasks.catalogMeta = getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
  tasks.statsVersion = getDoc(COLLECTIONS.productStatsSnapshots, PRODUCT_STATS_ROLLING_ID)

  const keys = Object.keys(tasks)
  const values = await Promise.all(keys.map(key => tasks[key]))
  const resultByKey = keys.reduce((result, key, index) => {
    result[key] = values[index]
    return result
  }, {})
  const announcementResult = resultByKey.announcement
  const subscriptionResult = resultByKey.subscription
  const rollingSnapshot = resultByKey.statsVersion || {}

  return {
    roundKey: currentRoundKey,
    serverTime: now.toISOString(),
    sections: requestedSections,
    merchant: resultByKey.merchant || null,
    announcement: announcementResult && announcementResult.data
      ? announcementResult.data.announcement || null
      : null,
    subscriptionStatus: subscriptionResult && subscriptionResult.data
      ? subscriptionResult.data
      : null,
    voteSummary: resultByKey.vote || null,
    catalogVersion: resultByKey.catalogMeta && resultByKey.catalogMeta.version || fallbackProductCatalog.version || '',
    statsVersion: getProductStatsVersion({ [PRODUCT_STATS_ROLLING_ID]: rollingSnapshot }),
    isAdmin: isBootstrapAdmin(openid)
  }
}

function normalizeAnnouncementDate(value) {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
  if (value && typeof value.getTime === 'function') return new Date(value.getTime()).toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function getAnnouncementTime(value) {
  const time = new Date(normalizeAnnouncementDate(value) || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function normalizePublicAnnouncement(doc = {}, pinnedAnnouncementId = '') {
  const id = doc._id || doc.id || ''
  const content = String(doc.content || '').trim()
  return {
    id,
    title: String(doc.title || '公告').trim() || '公告',
    content,
    publishedAt: normalizeAnnouncementDate(doc.publishedAt || doc.updatedAt),
    pinned: Boolean(pinnedAnnouncementId && id === pinnedAnnouncementId)
  }
}

async function getAnnouncementList(event = {}) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1)
  const pageSize = Math.min(30, Math.max(1, Number.parseInt(event.pageSize, 10) || 10))
  const home = await getDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const pinnedAnnouncementId = String(home && home.pinnedAnnouncementId || '').trim()
  const result = await queryCursorPage(
    COLLECTIONS.announcements,
    { kind: 'notice', deleted: _.neq(true) },
    'publishedAt',
    pageSize,
    event.cursor,
    page
  )
  let items = result.items.filter(doc => String(doc.content || '').trim())
  let hasMore = result.hasMore
  let nextCursor = result.nextCursor
  if (page === 1 && !event.cursor && pinnedAnnouncementId) {
    const pinned = items.find(item => item._id === pinnedAnnouncementId) ||
      await getDoc(COLLECTIONS.announcements, pinnedAnnouncementId)
    const chronologicalItems = items.filter(item => item._id !== pinnedAnnouncementId)
    const pinnedItems = pinned && pinned.deleted !== true && String(pinned.content || '').trim() ? [pinned] : []
    const displayedChronological = chronologicalItems.slice(0, Math.max(0, pageSize - pinnedItems.length))
    items = pinnedItems.concat(displayedChronological)
    hasMore = result.hasMore || chronologicalItems.length > displayedChronological.length
    const cursorItem = displayedChronological[displayedChronological.length - 1]
    nextCursor = hasMore && cursorItem ? encodePageCursor(cursorItem, 'publishedAt') : ''
  } else {
    items = items
      .filter(item => !pinnedAnnouncementId || item._id !== pinnedAnnouncementId)
      .slice(0, pageSize)
  }
  if (!items.length) {
    if (home && home.enabled !== false && String(home.content || '').trim()) {
      items = [{ ...home, _id: 'legacy_home' }]
    }
  }
  return ok({
    items: items.map(item => normalizePublicAnnouncement(item, pinnedAnnouncementId)),
    page,
    pageSize,
    total: null,
    hasMore,
    nextCursor
  })
}

async function getAnnouncementDetail(event = {}) {
  const id = String(event.id || '').trim()
  if (!id) return fail('公告地址无效', { code: 'ANNOUNCEMENT_NOT_FOUND' })

  const home = await getDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const pinnedAnnouncementId = String(home && home.pinnedAnnouncementId || '').trim()
  if (id === 'legacy_home') {
    if (!home || home.enabled === false || !String(home.content || '').trim()) {
      return fail('公告不存在或已下架', { code: 'ANNOUNCEMENT_NOT_FOUND' })
    }
    return ok({ announcement: normalizePublicAnnouncement({ ...home, _id: 'legacy_home' }, pinnedAnnouncementId) })
  }

  const doc = await getDoc(COLLECTIONS.announcements, id)
  if (!doc || doc.kind !== 'notice' || doc.deleted === true || !String(doc.content || '').trim()) {
    return fail('公告不存在或已下架', { code: 'ANNOUNCEMENT_NOT_FOUND' })
  }
  return ok({ announcement: normalizePublicAnnouncement(doc, pinnedAnnouncementId) })
}

async function getShareWxacode() {
  if (shareWxacodeCache) return ok(shareWxacodeCache)

  const result = await cloud.openapi.wxacode.getUnlimited({
    scene: 'stats',
    page: 'pages/stats/stats',
    checkPath: false,
    width: 240
  })
  const buffer = result && result.buffer
  if (!buffer) return fail('小程序码生成失败')
  const imageBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)

  shareWxacodeCache = {
    mimeType: 'image/png',
    base64: imageBuffer.toString('base64')
  }
  return ok(shareWxacodeCache)
}

function getShareImageAssetId(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex')
}

function isAllowedShareImageHost(hostname) {
  return hostname === 'wegame.shallow.ink' ||
    hostname === 'mmbiz.qpic.cn' ||
    hostname === 'patchwiki.biligame.com' ||
    /^env-[a-z0-9-]+\.normal\.cloudstatic\.cn$/.test(hostname)
}

function getImageExtFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/gif') return 'gif'
  return 'png'
}

function getImageExtFromUrl(url) {
  const pathname = (() => {
    try {
      return new URL(url).pathname || ''
    } catch (error) {
      return ''
    }
  })()
  const match = pathname.match(/\.([a-z0-9]{2,5})$/i)
  const ext = match ? match[1].toLowerCase() : ''
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
    ? (ext === 'jpeg' ? 'jpg' : ext)
    : ''
}

function downloadShareImage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed = null
    try {
      parsed = new URL(url)
    } catch (error) {
      reject(new Error('图片地址不正确'))
      return
    }
    if (parsed.protocol !== 'https:' || !isAllowedShareImageHost(parsed.hostname)) {
      reject(new Error('图片来源不允许'))
      return
    }

    const request = https.get(parsed, response => {
      const status = Number(response.statusCode || 0)
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 3) {
        response.resume()
        const nextUrl = new URL(response.headers.location, parsed).toString()
        downloadShareImage(nextUrl, redirects + 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        reject(new Error(`图片下载失败 ${status}`))
        return
      }

      const chunks = []
      let size = 0
      const maxSize = 2 * 1024 * 1024
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxSize) {
          request.destroy(new Error('图片文件过大'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const contentType = response.headers['content-type'] || ''
        if (!String(contentType).toLowerCase().startsWith('image/')) {
          reject(new Error('远程资源不是图片'))
          return
        }
        resolve({
          buffer: Buffer.concat(chunks),
          mimeType: String(contentType).split(';')[0].trim() || 'image/png',
          ext: getImageExtFromContentType(contentType) || getImageExtFromUrl(url) || 'png'
        })
      })
    })
    request.setTimeout(8000, () => {
      request.destroy(new Error('图片下载超时'))
    })
    request.on('error', reject)
  })
}

function normalizeShareImageItem(item = {}) {
  const name = String(item.name || '').trim()
  const image = String(item.image || '').replace(/&amp;/g, '&').trim()
  return { name, image }
}

async function getShareGoodsImageAsset(item) {
  const normalized = normalizeShareImageItem(item)
  const sourceUrl = normalized.image
  if (!sourceUrl || !/^https:\/\//.test(sourceUrl)) {
    return { name: normalized.name, sourceUrl, fileID: '', migrated: false }
  }

  const id = getShareImageAssetId(sourceUrl)
  const existing = await getDoc(COLLECTIONS.shareImageAssets, id)
  if (existing && existing.fileID) {
    return {
      name: normalized.name,
      sourceUrl,
      fileID: existing.fileID,
      migrated: false
    }
  }

  const image = await downloadShareImage(sourceUrl)
  const ext = image.ext || getImageExtFromUrl(sourceUrl) || 'png'
  const cloudPath = `share-goods/${id}.${ext}`
  const upload = await cloud.uploadFile({
    cloudPath,
    fileContent: image.buffer
  })
  const fileID = upload && upload.fileID ? upload.fileID : ''
  if (!fileID) throw new Error('图片上传云存储失败')

  await setDoc(COLLECTIONS.shareImageAssets, id, {
    sourceUrl,
    name: normalized.name,
    fileID,
    cloudPath,
    mimeType: image.mimeType,
    updatedAt: new Date()
  })

  return {
    name: normalized.name,
    sourceUrl,
    fileID,
    migrated: true
  }
}

async function getShareGoodsImages(event = {}) {
  const items = Array.isArray(event.items) ? event.items.slice(0, 6) : []
  const results = new Array(items.length)
  let cursor = 0

  const migrateNext = async () => {
    const index = cursor
    cursor += 1
    if (index >= items.length) return

    const item = items[index]
    try {
      results[index] = await getShareGoodsImageAsset(item)
    } catch (error) {
      console.warn(`[rocoApi] share image migration failed: ${error.message}`)
      const normalized = normalizeShareImageItem(item)
      results[index] = {
        name: normalized.name,
        sourceUrl: normalized.image,
        fileID: '',
        migrated: false,
        error: error.message
      }
    }
    await migrateNext()
  }

  await Promise.all(Array.from({ length: Math.min(3, items.length) }, migrateNext))
  return ok({ items: results })
}

async function removeByOpenids(collectionName, openids) {
  if (!openids.length) return 0

  const docs = await queryAll(collectionName, { openid: _.in(openids) })
  await Promise.all(docs.map(doc => db.collection(collectionName).doc(doc._id).remove()))
  trackDbWrite(collectionName, docs.length, 'remove')

  return docs.length
}

async function resetTesterData(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const openids = normalizeOpenids(event.openids)
  if (!openids.length) {
    return fail('请提供需要清零的测试人员 openid 列表')
  }

  const collections = [
    COLLECTIONS.deliveries,
    COLLECTIONS.users,
    COLLECTIONS.subscriptions,
    COLLECTIONS.quotas,
    COLLECTIONS.targets,
    COLLECTIONS.itemTargets,
    COLLECTIONS.feedback
  ]
  const removed = {}

  for (const collectionName of collections) {
    removed[collectionName] = await removeByOpenids(collectionName, openids)
  }

  return ok({
    openids,
    removed
  }, '测试人员数据已清零')
}

async function clearRoundVotes(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  if (event.confirmClearAllVotes !== true) {
    return fail('请确认 confirmClearAllVotes 为 true')
  }

  const removed = {
    [COLLECTIONS.roundVotes]: await removeAllFromCollection(COLLECTIONS.roundVotes),
    [COLLECTIONS.roundVoteSummaries]: await removeAllFromCollection(COLLECTIONS.roundVoteSummaries)
  }

  return ok({ removed }, '投票历史已清空')
}

async function backfillWechatRejectedQuotas(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const where = event.roundKey
    ? { status: 'final_failed', roundKey: String(event.roundKey) }
    : { status: 'final_failed' }
  const deliveries = await queryAll(COLLECTIONS.deliveries, where)
  const rejectedDeliveries = deliveries.filter(item => isWechatSubscribeRejectedError({
    errCode: item.errorCode,
    errMsg: item.errorMsg,
    message: item.errorMsg
  }))
  const quotaMap = new Map()

  rejectedDeliveries.forEach(item => {
    if (!item.openid || !item.templateId) return
    quotaMap.set(`${item.openid}|${item.templateId}`, item)
  })

  let updated = 0
  for (const item of quotaMap.values()) {
    await markReminderQuotaWechatRejected(item.openid, item.templateId, item.roundKey || '', item.errorMsg || '')
    updated += 1
  }

  return ok({
    scanned: deliveries.length,
    rejectedDeliveries: rejectedDeliveries.length,
    updated
  }, '微信拒收额度标记已回填')
}

async function repairQuotaConsumePending(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const where = event.roundKey
    ? { status: 'sent', roundKey: String(event.roundKey) }
    : { status: 'sent' }
  const deliveries = await queryAll(COLLECTIONS.deliveries, where)
  const pendingDeliveries = deliveries.filter(needsQuotaConfirmation)
  let repaired = 0
  let failed = 0

  for (const delivery of pendingDeliveries) {
    const deliveryId = delivery._id || buildNotificationDeliveryId(delivery.openid, delivery.templateId, delivery.roundKey)
    const repair = await confirmSentDeliveryQuota(deliveryId, delivery, { retry: true })
    if (repair.consumed) {
      repaired += 1
    } else {
      failed += 1
    }
  }

  return ok({
    scanned: deliveries.length,
    pending: pendingDeliveries.length,
    repaired,
    failed
  }, '待补记扣次已处理')
}

async function repairQuotaRefundPending(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const where = event.roundKey
    ? { roundKey: String(event.roundKey) }
    : null
  const deliveries = await queryAll(COLLECTIONS.deliveries, where)
  const pendingDeliveries = deliveries.filter(delivery => {
    return delivery &&
      delivery.postSend &&
      delivery.postSend.quotaRefundPending === true &&
      delivery.status !== 'sent'
  })
  let repaired = 0
  let failed = 0

  for (const delivery of pendingDeliveries) {
    const deliveryId = delivery._id || buildNotificationDeliveryId(delivery.openid, delivery.templateId, delivery.roundKey)
    const attempts = Array.isArray(delivery.attempts) ? delivery.attempts : []
    const latestAttempt = attempts.slice().reverse().find(attempt => attempt.quotaRefundPending === true || attempt.quotaConsumed === true)
    const refundId = (latestAttempt && latestAttempt.quotaAttemptId) || deliveryId
    const refund = await refundReminderQuotaWithRetry(delivery.openid, delivery.templateId, refundId)
    const postSend = {
      ...(delivery.postSend || {}),
      quotaConsumed: refund.refunded !== true,
      quotaRefunded: refund.refunded === true,
      quotaRefundPending: refund.refunded !== true,
      quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded'),
      quotaRefundRecordedAt: new Date()
    }
    if (refund.refunded) {
      repaired += 1
    } else {
      failed += 1
    }
    const nextAttempts = latestAttempt
      ? updateAttemptInDelivery(delivery, latestAttempt.attemptNo, {
        quotaConsumed: refund.refunded !== true,
        quotaRefunded: refund.refunded === true,
        quotaRefundPending: refund.refunded !== true,
        quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded')
      })
      : delivery.attempts
    await setNotificationDelivery(deliveryId, delivery, {
      postSend,
      ...(nextAttempts ? { attempts: nextAttempts } : {})
    })
  }

  return ok({
    scanned: deliveries.length,
    pending: pendingDeliveries.length,
    repaired,
    failed
  }, '待退回次数已处理')
}

async function backfillSubscriptionTargets(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const batchLimit = clampLoadTestNumber(event.batchLimit, SUBSCRIPTION_BACKFILL_BATCH_LIMIT, 1, 200)
  const cursor = typeof event.cursor === 'string' ? event.cursor : ''
  const subscriptions = (await queryAll(COLLECTIONS.subscriptions))
    .filter(subscription => subscription.enabled === true)
  const targetMap = new Map()
  subscriptions.forEach(subscription => {
    const templateId = subscription.templateId || subscription.template_id || ''
    const itemName = subscription.itemName || subscription.item_name || ''
    if (!subscription.openid || !templateId || !itemName) return
    const key = `${subscription.openid}|${templateId}`
    const current = targetMap.get(key) || {
      openid: subscription.openid,
      templateId,
      items: []
    }
    current.items.push({
      name: itemName,
      keywords: subscription.keywords || []
    })
    targetMap.set(key, current)
  })

  const targets = Array.from(targetMap.values())
    .sort((a, b) => `${a.openid}|${a.templateId}`.localeCompare(`${b.openid}|${b.templateId}`))
  const remainingTargets = cursor
    ? targets.filter(target => `${target.openid}|${target.templateId}` > cursor)
    : targets
  const batchTargets = remainingTargets.slice(0, batchLimit)
  let updated = 0
  for (const target of batchTargets) {
    await setSubscriptionIndexesSnapshot(target.openid, target.items, target.templateId)
    updated += 1
  }
  const lastTarget = batchTargets[batchTargets.length - 1] || null
  const nextCursor = lastTarget ? `${lastTarget.openid}|${lastTarget.templateId}` : cursor
  const hasMore = remainingTargets.length > batchTargets.length

  return ok({
    scanned: subscriptions.length,
    totalTargets: targets.length,
    batchLimit,
    cursor,
    nextCursor,
    hasMore,
    updated
  }, hasMore ? '订阅派发索引已回填一批，请携带 nextCursor 继续执行' : '订阅派发索引已回填完成')
}

async function backfillSubscriptionProfilesV2(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  const batchLimit = clampLoadTestNumber(event.batchLimit, SUBSCRIPTION_BACKFILL_BATCH_LIMIT, 1, 100)
  const cursor = String(event.cursor || '')
  let userQuery = db.collection(COLLECTIONS.users)
  if (cursor) userQuery = userQuery.where({ _id: _.gt(cursor) })
  let userDocs = []
  try {
    const response = await userQuery.orderBy('_id', 'asc').limit(batchLimit + 1).get()
    userDocs = response.data || []
    trackDbRead(COLLECTIONS.users, userDocs.length, 'migration_cursor_query')
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
  }
  const batchUsers = userDocs.slice(0, batchLimit)
  const batchOpenids = batchUsers.map(user => String(user._id || user.openid || '')).filter(Boolean)
  const targets = []
  for (let index = 0; index < batchOpenids.length; index += QUOTA_QUERY_BATCH_SIZE) {
    targets.push(...await queryAll(COLLECTIONS.targets, {
      openid: _.in(batchOpenids.slice(index, index + QUOTA_QUERY_BATCH_SIZE)),
      enabled: true
    }))
  }
  const byOpenid = new Map()
  targets.forEach(target => {
    const current = byOpenid.get(target.openid) || { items: [], templateIds: [] }
    current.items = current.items.concat(getTargetFollowedItems(target))
    current.templateIds.push(target.templateId)
    byOpenid.set(target.openid, current)
  })
  const results = []
  for (const openid of Array.from(byOpenid.keys()).sort()) {
    const value = byOpenid.get(openid)
    results.push(await syncSubscriptionProfileV2(openid, value.items, value.templateIds))
  }
  const nextCursor = batchOpenids[batchOpenids.length - 1] || cursor
  return ok({
    scannedUsers: batchOpenids.length,
    scannedTargets: targets.length,
    processedProfiles: byOpenid.size,
    verifiedSignatures: results.filter(result => Boolean(result.selectionSignature)).length,
    updatedProfiles: results.filter(result => result.changed).length,
    writes: results.reduce((sum, result) => sum + Number(result.writeCount || 0), 0),
    nextCursor,
    hasMore: userDocs.length > batchLimit
  }, userDocs.length > batchLimit ? 'v2 订阅索引已回填一批' : 'v2 订阅索引已回填完成')
}

async function backfillHistoryBundles(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const records = sortHistoryRecords((await queryAll(COLLECTIONS.history))
    .filter(record => record && record.items && record.items.length)
    .map(formatHistoryRecord))
  await setHistoryBundle(HISTORY_RECENT_BUNDLE_ID, records.slice(0, HISTORY_RECENT_BUNDLE_LIMIT))

  const monthMap = new Map()
  records.forEach(record => {
    const month = getHistoryMonthFromRecord(record)
    const bundleId = getHistoryMonthBundleId(month)
    if (!bundleId) return
    const monthRecords = monthMap.get(bundleId) || []
    monthRecords.push(record)
    monthMap.set(bundleId, monthRecords)
  })

  for (const [bundleId, monthRecords] of monthMap.entries()) {
    await setHistoryBundle(bundleId, monthRecords)
  }

  return ok({
    scanned: records.length,
    bundles: 1 + monthMap.size,
    months: Array.from(monthMap.keys()).map(key => key.replace(/^month_/, '')).sort()
  }, '历史聚合包已回填')
}

async function backfillProductStatsSnapshots(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const records = sortHistoryRecords((await queryAll(COLLECTIONS.history))
    .filter(record => record && record.items && record.items.length)
    .map(formatHistoryRecord))
  const rolling = decorateProductStatsSnapshot(
    buildRollingSnapshot(records, resolveProductForStats),
    records
  )
  await setDoc(COLLECTIONS.productStatsSnapshots, PRODUCT_STATS_ROLLING_ID, rolling)

  const seasonSummaries = []
  for (const season of PRODUCT_STATS_SEASONS) {
    const seasonOptions = season.key === 's1' ? getS1CountOverrides() : {}
    const snapshot = decorateProductStatsSnapshot(
      buildSeasonSnapshot(season, records, resolveProductForStats, seasonOptions),
      records.filter(record => record.date >= season.startDate && record.date <= season.endDate)
    )
    await setDoc(COLLECTIONS.productStatsSnapshots, season.id, snapshot)
    seasonSummaries.push({
      season: season.key,
      records: snapshot.source_record_count,
      totalNormalOccurrences: snapshot.total_normal_occurrences,
      updatedRoundKey: snapshot.updated_round_key
    })
  }

  return ok({
    scanned: records.length,
    rollingUpdatedRoundKey: rolling.updated_round_key,
    seasons: seasonSummaries
  }, '商品统计快照已回填')
}

async function removeAllFromCollection(collectionName, batchLimit = 500) {
  let removed = 0
  while (true) {
    const docs = await queryAll(collectionName, null, batchLimit)
    if (!docs.length) break
    await Promise.all(docs.map(doc => db.collection(collectionName).doc(doc._id).remove()))
    trackDbWrite(collectionName, docs.length, 'remove')
    removed += docs.length
    if (docs.length < batchLimit) break
  }
  return removed
}

async function clearLegacyNotificationCollections(event) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  const removed = {
    notification_attempts: await removeAllFromCollection('notification_attempts'),
    notification_logs: await removeAllFromCollection('notification_logs')
  }

  return ok({ removed }, '旧通知审计集合已清理')
}

function clampLoadTestNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function getLoadTestConfig(event = {}) {
  return {
    userCount: clampLoadTestNumber(event.userCount, 1000, 1, 5000),
    timeoutRate: clampLoadTestNumber(event.timeoutRate, 0, 0, 0.5),
    rejectRate: clampLoadTestNumber(event.rejectRate, 0, 0, 0.2),
    stuckRate: clampLoadTestNumber(event.stuckRate, 0, 0, 0.2),
    delayMinMs: clampLoadTestNumber(event.delayMinMs, 50, 0, 2000),
    delayMaxMs: clampLoadTestNumber(event.delayMaxMs, 120, 0, 3000),
    batchLimit: getNotificationBatchLimit(event.batchLimit || 600),
    timeBudgetMs: getNotificationTimeBudgetMs(event.timeBudgetMs || 52000),
    concurrency: clampLoadTestNumber(event.concurrency, NOTIFY_CONCURRENCY, 1, 40),
    includeLastRecipient: event.includeLastRecipient !== false
  }
}

function validateLoadTestCostConfirmation(event = {}) {
  return event.confirmLoadTestCost === true
    ? ''
    : '压测会产生大量数据库读写，请确认成本后传 confirmLoadTestCost: true'
}

function stableHash(value) {
  let hash = 2166136261
  const text = String(value || '')
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function stableRatio(value) {
  return stableHash(value) / 0xffffffff
}

function buildLoadTestOpenid(index) {
  return `test_openid_${String(index).padStart(6, '0')}`
}

function getLoadTestTargetDocId(openid, templateId) {
  return `loadtest_target_${encodeDocId(`${openid}|${templateId}`)}`
}

async function buildLoadTestItemDistribution() {
  const counts = new Map()
  const subscriptions = (await queryAll(COLLECTIONS.subscriptions))
    .filter(subscription => subscription && subscription.enabled === true)

  subscriptions.forEach(subscription => {
    const name = String(subscription.itemName || subscription.item_name || '').trim()
    if (!name) return
    const current = counts.get(name) || {
      name,
      keywords: getItemKeywords(name, subscription.keywords),
      weight: 0
    }
    current.weight += 1
    counts.set(name, current)
  })

  const distribution = counts.size
    ? Array.from(counts.values())
    : FOLLOW_ITEM_MATCHERS.map(item => ({
      name: item.name,
      keywords: getItemKeywords(item.name, item.keywords),
      weight: 1
    }))

  return distribution.map(item => ({
    ...item,
    weight: Math.max(1, Number(item.weight || 1))
  }))
}

function chooseWeightedLoadTestItem(distribution, seed) {
  const totalWeight = distribution.reduce((sum, item) => sum + Number(item.weight || 1), 0)
  let cursor = stableHash(seed) % Math.max(1, totalWeight)
  for (const item of distribution) {
    cursor -= Number(item.weight || 1)
    if (cursor < 0) return item
  }
  return distribution[0]
}

function chooseLoadTestItems(distribution, index) {
  const desiredCount = Math.min(distribution.length, 1 + (stableHash(`item-count:${index}`) % 5))
  const selected = new Map()
  let offset = 0
  while (selected.size < desiredCount && offset < distribution.length * 3) {
    const item = chooseWeightedLoadTestItem(distribution, `item:${index}:${offset}`)
    selected.set(item.name, {
      itemName: item.name,
      keywords: getItemKeywords(item.name, item.keywords)
    })
    offset += 1
  }
  return Array.from(selected.values())
}

function getLoadTestQuotaCount(index) {
  return 1 + (stableHash(`quota:${index}`) % 3)
}

function buildLoadTestMerchantInfo(event = {}) {
  const round = clampLoadTestNumber(event.round, 1, 1, 99)
  const date = String(event.date || formatChinaDate()).trim()
  const roundKey = String(event.roundKey || `loadtest_${date.replace(/-/g, '')}_${round}`).trim()
  const eventItems = Array.isArray(event.items) ? event.items : null
  const names = eventItems && eventItems.length
    ? eventItems.map(item => typeof item === 'string' ? item : item && item.name).filter(Boolean)
    : ['蓝晶碧玺', '棱镜球', '炫彩蛋', '祝福项坠', '国王球']

  return {
    roundKey,
    date,
    round,
    timeRange: 'loadtest',
    currentTime: formatChinaTime(),
    status: 'active',
    source: 'loadtest',
    items: names.map(name => ({ name }))
  }
}

async function seedLoadTest(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  const confirmError = validateLoadTestCostConfirmation(event)
  if (confirmError) return fail(confirmError)

  const config = getLoadTestConfig(event)
  const templateId = getTemplateId(event)
  const distribution = await buildLoadTestItemDistribution()
  await cleanupLoadTest({ ...event, skipSecret: true })

  const now = new Date()
  const targets = []
  for (let index = 1; index <= config.userCount; index += 1) {
    targets.push({
      openid: buildLoadTestOpenid(index),
      index,
      items: chooseLoadTestItems(distribution, index),
      quotaCount: getLoadTestQuotaCount(index)
    })
  }
  if (config.includeLastRecipient && LAST_RECIPIENT_OPENID) {
    targets.push({
      openid: LAST_RECIPIENT_OPENID,
      index: config.userCount + 1,
      items: chooseLoadTestItems(distribution, config.userCount + 1),
      quotaCount: 3,
      isLastRecipient: true
    })
  }

  await runNotificationPool(targets, 40, async target => {
    const targetId = getLoadTestTargetDocId(target.openid, templateId)
    const quotaId = getQuotaDocId(target.openid, templateId)
    await setDoc(LOADTEST_COLLECTIONS.targets, targetId, {
      openid: target.openid,
      templateId,
      enabled: true,
      isLastRecipient: target.isLastRecipient === true,
      items: target.items,
      itemNames: target.items.map(item => item.itemName),
      createdAt: now,
      updatedAt: now
    })
    await setDoc(LOADTEST_COLLECTIONS.quotas, quotaId, {
      openid: target.openid,
      templateId,
      initialCount: target.quotaCount,
      remainingCount: target.quotaCount,
      consumedDeliveryIds: [],
      wechatRejected: false,
      createdAt: now,
      updatedAt: now
    })
  })

  return ok({
    collections: LOADTEST_COLLECTIONS,
    generatedTestUsers: config.userCount,
    lastRecipientIncluded: config.includeLastRecipient && Boolean(LAST_RECIPIENT_OPENID),
    totalTargets: targets.length,
    distributionItems: distribution.length
  }, '压测种子数据已生成，仅写入 loadtest_* 集合')
}

async function setLoadTestDelivery(deliveryId, delivery, patch) {
  await setDoc(LOADTEST_COLLECTIONS.deliveries, deliveryId, {
    ...(delivery || {}),
    ...patch,
    updatedAt: new Date()
  })
}

async function markLoadTestQuotaWechatRejected(openid, templateId, roundKey, errorMsg) {
  const quotaId = getQuotaDocId(openid, templateId)
  const quota = await getDoc(LOADTEST_COLLECTIONS.quotas, quotaId)
  const now = new Date()
  await setDoc(LOADTEST_COLLECTIONS.quotas, quotaId, {
    ...(quota || {}),
    openid,
    templateId,
    remainingCount: 0,
    previousRemainingCount: Number(quota && quota.remainingCount ? quota.remainingCount : 0),
    wechatRejected: true,
    wechatRejectedAt: now,
    wechatRejectedRoundKey: roundKey,
    wechatRejectedError: errorMsg || '',
    updatedAt: now
  })
}

async function refundLoadTestQuota(openid, templateId, quotaAttemptId) {
  const quotaId = getQuotaDocId(openid, templateId)
  return db.runTransaction(async transaction => {
    const quota = await getTransactionDoc(transaction, LOADTEST_COLLECTIONS.quotas, quotaId)
    if (!quota) return { refunded: false, error: 'quota not found' }
    const consumedDeliveryIds = Array.isArray(quota.consumedDeliveryIds) ? quota.consumedDeliveryIds : []
    if (!consumedDeliveryIds.includes(quotaAttemptId)) return { refunded: true, alreadyRefunded: true }
    await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.quotas, quotaId, {
      ...quota,
      remainingCount: Number(quota.remainingCount || 0) + 1,
      consumedDeliveryIds: consumedDeliveryIds.filter(id => id !== quotaAttemptId),
      updatedAt: new Date()
    })
    return { refunded: true, alreadyRefunded: false }
  })
}

async function claimLoadTestDeliveryWithQuota(pending, roundKey, source) {
  const deliveryId = pending.deliveryId || buildNotificationDeliveryId(pending.openid, pending.templateId, roundKey)
  const quotaId = getQuotaDocId(pending.openid, pending.templateId)

  return db.runTransaction(async transaction => {
    const latest = await getTransactionDoc(transaction, LOADTEST_COLLECTIONS.deliveries, deliveryId)
    const quota = await getTransactionDoc(transaction, LOADTEST_COLLECTIONS.quotas, quotaId)
    const status = normalizeDeliveryStatus(latest && latest.status)

    if (!isProcessableDeliveryStatus(status, source, latest)) {
      return { claimed: false, reason: status || 'missing_delivery', deliveryId, delivery: latest }
    }
    if (isLockedDelivery(latest)) {
      return { claimed: false, reason: 'sending', deliveryId, delivery: latest }
    }

    const nextAttemptNo = Number(latest && latest.attemptCount ? latest.attemptCount : 0) + 1
    if (nextAttemptNo > MAX_DELIVERY_ATTEMPTS) {
      const finalDelivery = {
        ...(latest || {}),
        status: 'final_failed',
        lockedUntil: null,
        errorMsg: 'max loadtest attempts reached',
        updatedAt: new Date()
      }
      await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.deliveries, deliveryId, finalDelivery)
      return { claimed: false, reason: 'max_attempts', deliveryId, delivery: finalDelivery }
    }

    const now = new Date()
    const baseDelivery = {
      ...(latest || {}),
      openid: pending.openid,
      templateId: pending.templateId,
      roundKey,
      itemNames: pending.itemNames || [],
      source,
      createdAt: latest && latest.createdAt ? latest.createdAt : now
    }

    if (isQuotaWechatRejected(quota)) {
      const failedDelivery = {
        ...baseDelivery,
        status: 'final_failed',
        lockedUntil: null,
        errorMsg: quota.wechatRejectedError || 'mock 43101 user refuse',
        updatedAt: now,
        postSend: buildQuotaPostSend()
      }
      await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.deliveries, deliveryId, failedDelivery)
      return { claimed: false, reason: 'wechat_rejected', deliveryId, delivery: failedDelivery }
    }

    const consumedDeliveryIds = Array.isArray(quota && quota.consumedDeliveryIds)
      ? quota.consumedDeliveryIds
      : []
    const quotaAttemptId = buildNotificationAttemptId(deliveryId, nextAttemptNo)
    const alreadyConsumed = consumedDeliveryIds.includes(quotaAttemptId)
    const remainingCount = Number(quota && quota.remainingCount ? quota.remainingCount : 0)

    if (!alreadyConsumed && remainingCount <= 0) {
      const noQuotaDelivery = {
        ...baseDelivery,
        status: 'no_quota',
        lockedUntil: null,
        errorMsg: '',
        updatedAt: now,
        postSend: buildQuotaPostSend()
      }
      await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.deliveries, deliveryId, noQuotaDelivery)
      return { claimed: false, reason: 'no_quota', deliveryId, delivery: noQuotaDelivery }
    }

    let remainingCountAfter = remainingCount
    if (!alreadyConsumed) {
      remainingCountAfter = remainingCount - 1
      await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.quotas, quotaId, {
        ...(quota || {}),
        openid: pending.openid,
        templateId: pending.templateId,
        remainingCount: remainingCountAfter,
        consumedDeliveryIds: Array.from(new Set(consumedDeliveryIds.concat(quotaAttemptId))).slice(-400),
        updatedAt: now
      })
    }

    const attempts = updateAttemptInDelivery(baseDelivery, nextAttemptNo, {
      attemptNo: nextAttemptNo,
      quotaAttemptId,
      source,
      status: 'sending',
      itemNames: pending.itemNames || [],
      startedAt: now,
      errorMsg: '',
      quotaConsumed: true,
      quotaRefunded: false,
      quotaRefundPending: false
    })
    const claimedDelivery = {
      ...baseDelivery,
      status: 'sending',
      attemptCount: nextAttemptNo,
      attempts,
      lockedUntil: new Date(now.getTime() + DELIVERY_LOCK_MS),
      lastAttemptAt: now,
      errorMsg: '',
      updatedAt: now,
      postSend: buildQuotaPostSend({
        consumed: true,
        recordedAt: now
      })
    }

    await setTransactionDoc(transaction, LOADTEST_COLLECTIONS.deliveries, deliveryId, claimedDelivery)
    return {
      claimed: true,
      deliveryId,
      delivery: claimedDelivery,
      attemptNo: nextAttemptNo,
      quotaAttemptId,
      remainingCountAfter
    }
  })
}

async function finalizeLoadTestSuccess(pending, claim, source) {
  const sentAt = new Date()
  const attempts = (Array.isArray(claim.delivery.attempts) ? claim.delivery.attempts : [])
    .filter(attempt => Number(attempt.attemptNo || 0) !== Number(claim.attemptNo || 0))
  await setLoadTestDelivery(claim.deliveryId, claim.delivery, {
    status: 'sent',
    attempts,
    lockedUntil: null,
    sentAt,
    errorMsg: '',
    postSend: {
      ...(claim.delivery.postSend || {}),
      quotaConsumed: true,
      quotaConsumePending: false,
      quotaError: '',
      quotaRefundPending: false,
      quotaRefundError: ''
    }
  })
}

async function finalizeLoadTestFailure(pending, claim, roundKey, failure) {
  const failedAt = new Date()
  let postSend = claim.delivery.postSend || buildQuotaPostSend({ consumed: true, recordedAt: failedAt })
  let attemptPatch = {
    status: failure.status,
    finishedAt: failedAt,
    errorMsg: failure.errorMsg,
    quotaConsumed: true,
    quotaRefunded: false,
    quotaRefundPending: false
  }

  if (failure.wechatRejected) {
    await markLoadTestQuotaWechatRejected(pending.openid, pending.templateId, roundKey, failure.errorMsg)
  } else {
    const refund = await refundLoadTestQuota(pending.openid, pending.templateId, claim.quotaAttemptId)
    attemptPatch = {
      ...attemptPatch,
      quotaConsumed: refund.refunded !== true,
      quotaRefunded: refund.refunded === true,
      quotaRefundPending: refund.refunded !== true,
      quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded')
    }
    postSend = {
      ...postSend,
      quotaConsumed: refund.refunded !== true,
      quotaRefunded: refund.refunded === true,
      quotaRefundPending: refund.refunded !== true,
      quotaRefundError: refund.refunded ? '' : (refund.error || 'quota not refunded'),
      quotaRefundRecordedAt: new Date()
    }
  }

  const attempts = updateAttemptInDelivery(claim.delivery, claim.attemptNo, attemptPatch)
  const events = (Array.isArray(claim.delivery.events) ? claim.delivery.events : []).concat({
    type: `mock_${failure.status}`,
    itemNames: pending.itemNames,
    errorMsg: failure.errorMsg,
    createdAt: failedAt
  }).slice(-40)
  await setLoadTestDelivery(claim.deliveryId, claim.delivery, {
    status: failure.status,
    attempts,
    events,
    lockedUntil: null,
    errorMsg: failure.errorMsg,
    postSend
  })
}

async function materializeLoadTestDeliveries(merchantInfo, config) {
  const roundKey = merchantInfo.roundKey
  const source = 'loadtest'
  const targets = (await queryAll(LOADTEST_COLLECTIONS.targets, { enabled: true }))
    .filter(target => target.openid && target.templateId && normalizeTargetItems(target).length)
  const quotas = await queryAll(LOADTEST_COLLECTIONS.quotas)
  const quotaMap = new Map(quotas.map(quota => [`${quota.openid}|${quota.templateId}`, quota]))
  const roundDeliveries = await queryAll(LOADTEST_COLLECTIONS.deliveries, { roundKey })
  const sentKeys = new Set(roundDeliveries
    .filter(delivery => normalizeDeliveryStatus(delivery.status) === 'sent')
    .map(delivery => `${delivery.openid}|${delivery.templateId}`))
  const stats = createEmptyNotificationStats(targets.length)
  stats.batchLimit = config.batchLimit
  stats.timeBudgetMs = config.timeBudgetMs
  stats.concurrency = config.concurrency

  const pendingMap = new Map()
  for (const target of targets) {
    const targetItems = normalizeTargetItems(target)
    const quota = quotaMap.get(`${target.openid}|${target.templateId}`)
    if (isQuotaWechatRejected(quota)) {
      stats.wechatRejected += 1
      continue
    }
    if (Number(quota && quota.remainingCount ? quota.remainingCount : 0) <= 0) {
      stats.noQuota += 1
      continue
    }
    if (sentKeys.has(`${target.openid}|${target.templateId}`)) continue

    const matchedItems = []
    targetItems.forEach(targetItem => {
      const subscription = {
        openid: target.openid,
        templateId: target.templateId,
        itemName: targetItem.itemName,
        keywords: targetItem.keywords
      }
      merchantInfo.items
        .filter(item => isSubscriptionMatched(item.name, subscription))
        .forEach(item => {
          if (!matchedItems.some(existing => existing.name === item.name)) matchedItems.push(item)
        })
    })
    if (!matchedItems.length) continue
    pendingMap.set(`${target.openid}|${target.templateId}`, {
      openid: target.openid,
      templateId: target.templateId,
      items: matchedItems,
      itemNames: matchedItems.map(item => item.name)
    })
  }

  const candidates = Array.from(pendingMap.values())
  stats.matched = candidates.length
  await runNotificationPool(candidates, config.concurrency, async pending => {
    const deliveryId = buildNotificationDeliveryId(pending.openid, pending.templateId, roundKey)
    const existing = await getDoc(LOADTEST_COLLECTIONS.deliveries, deliveryId)
    if (existing) {
      stats.materialized += 1
      stats.existingDelivery += 1
      return
    }
    const now = new Date()
    await addDocWithId(LOADTEST_COLLECTIONS.deliveries, deliveryId, {
      openid: pending.openid,
      templateId: pending.templateId,
      roundKey,
      itemNames: pending.itemNames,
      status: 'pending',
      source,
      attemptCount: 0,
      attempts: [],
      events: [],
      lockedUntil: null,
      lastAttemptAt: null,
      errorMsg: '',
      createdAt: now,
      updatedAt: now
    })
    stats.materialized += 1
    stats.createdDelivery += 1
  })

  return stats
}

async function getLoadTestQueueCounts(roundKey) {
  const deliveries = await queryAll(LOADTEST_COLLECTIONS.deliveries, { roundKey })
  const counts = {
    total: deliveries.length,
    pending: 0,
    sent: 0,
    sending: 0,
    staleSending: 0,
    retryableFailed: 0,
    finalFailed: 0,
    noQuota: 0,
    secondAttempt: 0
  }
  deliveries.forEach(delivery => {
    const status = normalizeDeliveryStatus(delivery.status)
    if (status === 'pending') counts.pending += 1
    else if (status === 'sent') counts.sent += 1
    else if (status === 'sending') {
      counts.sending += 1
      if (!isLockedDelivery(delivery)) counts.staleSending += 1
    } else if (status === 'retryable_failed') counts.retryableFailed += 1
    else if (status === 'final_failed') counts.finalFailed += 1
    else if (status === 'no_quota') counts.noQuota += 1
    if (Number(delivery.attemptCount || 0) >= 2) counts.secondAttempt += 1
  })
  return counts
}

async function queryLoadTestProcessableDeliveries(roundKey) {
  const deliveries = await queryAll(LOADTEST_COLLECTIONS.deliveries, {
    roundKey,
    status: _.in(['pending', 'retryable_failed', 'failed', 'sending'])
  })
  return deliveries.filter(delivery => isProcessableDeliveryStatus(normalizeDeliveryStatus(delivery.status), 'loadtest', delivery))
}

function getLoadTestMockMode(openid, attemptNo, config) {
  const ratio = stableRatio(`mode:${openid}`)
  if (ratio < config.rejectRate) return 'reject43101'
  if (attemptNo === 1 && ratio < config.rejectRate + config.stuckRate) return 'stuck'
  if (attemptNo === 1 && ratio < config.rejectRate + config.stuckRate + config.timeoutRate) return 'timeout'
  return 'success'
}

async function mockLoadTestSend(openid, attemptNo, config) {
  const mode = getLoadTestMockMode(openid, attemptNo, config)
  const minDelay = Math.min(config.delayMinMs, config.delayMaxMs)
  const maxDelay = Math.max(config.delayMinMs, config.delayMaxMs)
  const delayMs = maxDelay > 0
    ? minDelay + (stableHash(`delay:${openid}:${attemptNo}`) % (maxDelay - minDelay + 1))
    : 0
  if (delayMs > 0) await delay(delayMs)
  if (mode === 'timeout') {
    const error = new Error('mock timeout')
    error.code = 'ETIMEDOUT'
    throw error
  }
  if (mode === 'reject43101') {
    const error = new Error('mock 43101 user refuse')
    error.errCode = 43101
    throw error
  }
  return { mode }
}

async function sendLoadTestNotification(pending, merchantInfo, roundKey, config, stats) {
  const claim = await claimLoadTestDeliveryWithQuota(pending, roundKey, 'loadtest')
  if (!claim.claimed) {
    stats.processed += 1
    stats.skipped += 1
    if (claim.reason === 'no_quota') stats.noQuota += 1
    if (claim.reason === 'wechat_rejected') stats.wechatRejected += 1
    if (claim.reason === 'max_attempts') stats.finalFailed += 1
    return
  }

  const mockMode = getLoadTestMockMode(pending.openid, claim.attemptNo, config)
  if (mockMode === 'stuck') {
    const attempts = updateAttemptInDelivery(claim.delivery, claim.attemptNo, {
      status: 'sending',
      errorMsg: 'mock stuck sending',
      quotaConsumed: true,
      quotaRefunded: false
    })
    await setLoadTestDelivery(claim.deliveryId, claim.delivery, {
      status: 'sending',
      attempts,
      lockedUntil: new Date(Date.now() - 1000),
      errorMsg: 'mock stuck sending'
    })
    stats.processed += 1
    stats.failed += 1
    stats.retryableFailed += 1
    return
  }

  try {
    await mockLoadTestSend(pending.openid, claim.attemptNo, config)
  } catch (error) {
    const failure = classifySubscribeSendError(error)
    await finalizeLoadTestFailure(pending, claim, roundKey, failure)
    stats.processed += 1
    if (failure.status === 'retryable_failed') {
      stats.failed += 1
      stats.retryableFailed += 1
    } else {
      stats.finalFailed += 1
    }
    return
  }

  stats.processed += 1
  stats.sent += 1
  await finalizeLoadTestSuccess(pending, claim, 'loadtest')
}

async function dispatchLoadTestQueueForMerchant(merchantInfo, config, baseStats) {
  const roundKey = merchantInfo.roundKey
  const stats = baseStats || createEmptyNotificationStats()
  stats.batchLimit = config.batchLimit
  stats.timeBudgetMs = config.timeBudgetMs
  stats.concurrency = config.concurrency
  const startedAt = Date.now()
  const shouldContinue = () => Date.now() - startedAt < stats.timeBudgetMs

  while (shouldContinue()) {
    const deliveries = await queryLoadTestProcessableDeliveries(roundKey)
    const normalDeliveries = deliveries.filter(delivery => !isLastRecipient(delivery.openid))
    const lastRecipientDeliveries = deliveries.filter(delivery => isLastRecipient(delivery.openid))
    const selectedDeliveries = (normalDeliveries.length ? normalDeliveries : lastRecipientDeliveries)
      .slice(0, stats.batchLimit)
    stats.lastRecipientDeferred = normalDeliveries.length > 0 && lastRecipientDeliveries.length > 0
    if (!selectedDeliveries.length) break

    const processNow = selectedDeliveries
      .map(delivery => buildPendingFromDelivery(delivery, merchantInfo, roundKey))
      .filter(pending => pending.openid && pending.templateId && pending.items.length)
    const processedBefore = stats.processed
    await runNotificationPoolUntil(processNow, config.concurrency, item => (
      sendLoadTestNotification(item, merchantInfo, roundKey, config, stats)
    ), shouldContinue)
    if (stats.processed === processedBefore) break
  }

  stats.timeBudgetReached = !shouldContinue()
  applyQueueCountsToStats(stats, await getLoadTestQueueCounts(roundKey))
  return stats
}

async function recordLoadTestJob(merchantInfo, notification, status = 'dispatching') {
  const counts = await getLoadTestQueueCounts(merchantInfo.roundKey)
  const notificationStatus = counts.pending + counts.retryableFailed + counts.staleSending > 0
    ? 'retrying'
    : (counts.finalFailed > 0 ? 'completed_with_final_failures' : 'completed')
  await setDoc(LOADTEST_COLLECTIONS.jobs, merchantInfo.roundKey, {
    roundKey: merchantInfo.roundKey,
    date: merchantInfo.date,
    round: merchantInfo.round,
    status,
    notificationStage: notificationStatus === 'retrying' ? 'dispatching' : 'completed',
    notificationStatus,
    notification,
    counts,
    capturedAt: new Date(),
    dispatchDeadlineAt: new Date(Date.now() + DISPATCH_WINDOW_MS),
    updatedAt: new Date()
  })
}

async function runLoadTestRound(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)
  const confirmError = validateLoadTestCostConfirmation(event)
  if (confirmError) return fail(confirmError)

  const config = getLoadTestConfig(event)
  const merchantInfo = buildLoadTestMerchantInfo(event)
  const materialized = await materializeLoadTestDeliveries(merchantInfo, config)
  const notification = await dispatchLoadTestQueueForMerchant(merchantInfo, config, materialized)
  await recordLoadTestJob(merchantInfo, notification, notification.pending > 0 ? 'retrying' : 'success')
  return ok({
    merchantInfo,
    config,
    notification,
    summary: await buildLoadTestSummary({ ...event, skipSecret: true, roundKey: merchantInfo.roundKey })
  }, notification.pending > 0 ? '压测轮已执行一批，仍有待处理' : '压测轮已执行完成')
}

function summarizeLoadTestAttempts(deliveries) {
  const attemptStatus = {}
  const errorDistribution = {}
  let totalAttempts = 0
  deliveries.forEach(delivery => {
    const attempts = Array.isArray(delivery.attempts) ? delivery.attempts : []
    totalAttempts += attempts.length
    attempts.forEach(attempt => {
      const status = attempt.status || 'unknown'
      attemptStatus[status] = (attemptStatus[status] || 0) + 1
      if (attempt.errorMsg) {
        errorDistribution[attempt.errorMsg] = (errorDistribution[attempt.errorMsg] || 0) + 1
      }
    })
    if (delivery.errorMsg) {
      errorDistribution[delivery.errorMsg] = (errorDistribution[delivery.errorMsg] || 0) + 1
    }
  })
  return { totalAttempts, attemptStatus, errorDistribution }
}

function verifyLoadTestQuotaConsistency(deliveries, quotaMap) {
  const examples = []
  let inconsistent = 0
  deliveries.forEach(delivery => {
    const attempts = Array.isArray(delivery.attempts) ? delivery.attempts : []
    if (attempts.length > MAX_DELIVERY_ATTEMPTS) {
      inconsistent += 1
      examples.push({ deliveryId: delivery._id, reason: 'attempts_exceed_limit' })
      return
    }
    const quota = quotaMap.get(`${delivery.openid}|${delivery.templateId}`)
    const consumedIds = Array.isArray(quota && quota.consumedDeliveryIds) ? quota.consumedDeliveryIds : []
    attempts.forEach(attempt => {
      const consumedInQuota = consumedIds.includes(attempt.quotaAttemptId)
      const status = attempt.status || ''
      const shouldBeConsumed = status === 'sent' || status === 'sending' || (status === 'final_failed' && isWechatRejectErrorMsg(attempt.errorMsg))
      if (shouldBeConsumed && attempt.quotaConsumed !== true) {
        inconsistent += 1
        examples.push({ deliveryId: delivery._id, attemptNo: attempt.attemptNo, reason: 'missing_quota_consumed_flag' })
      }
      if (shouldBeConsumed && !isQuotaWechatRejected(quota) && !consumedInQuota) {
        inconsistent += 1
        examples.push({ deliveryId: delivery._id, attemptNo: attempt.attemptNo, reason: 'missing_consumed_id' })
      }
      if (status === 'retryable_failed' && attempt.quotaRefunded !== true) {
        inconsistent += 1
        examples.push({ deliveryId: delivery._id, attemptNo: attempt.attemptNo, reason: 'missing_refund' })
      }
    })
  })
  return {
    ok: inconsistent === 0,
    inconsistent,
    examples: examples.slice(0, 10)
  }
}

async function buildLoadTestSummary(event = {}) {
  const targets = await queryAll(LOADTEST_COLLECTIONS.targets)
  const quotas = await queryAll(LOADTEST_COLLECTIONS.quotas)
  const jobs = await queryAll(LOADTEST_COLLECTIONS.jobs)
  const roundKey = String(event.roundKey || (jobs[0] && jobs[0].roundKey) || '').trim()
  const deliveries = roundKey
    ? await queryAll(LOADTEST_COLLECTIONS.deliveries, { roundKey })
    : await queryAll(LOADTEST_COLLECTIONS.deliveries)
  const quotasByKey = new Map(quotas.map(quota => [`${quota.openid}|${quota.templateId}`, quota]))
  const statusCounts = deliveries.reduce((counts, delivery) => {
    const status = normalizeDeliveryStatus(delivery.status) || 'unknown'
    counts[status] = (counts[status] || 0) + 1
    return counts
  }, {})
  const attempts = summarizeLoadTestAttempts(deliveries)
  const quotaConsistency = verifyLoadTestQuotaConsistency(deliveries, quotasByKey)

  return {
    collections: LOADTEST_COLLECTIONS,
    roundKey,
    targets: targets.length,
    quotas: quotas.length,
    jobs: jobs.length,
    deliveries: deliveries.length,
    statusCounts,
    attempts,
    quotaConsistency,
    lastRecipient: deliveries.find(delivery => isLastRecipient(delivery.openid)) || null
  }
}

async function summarizeLoadTest(event = {}) {
  const secretError = validateMaintenanceSecret(event)
  if (secretError) return fail(secretError)

  return ok(await buildLoadTestSummary(event), '压测摘要已生成')
}

async function cleanupLoadTest(event = {}) {
  if (event.skipSecret !== true) {
    const secretError = validateMaintenanceSecret(event)
    if (secretError) return fail(secretError)
  }
  const removed = {}
  for (const collectionName of Object.values(LOADTEST_COLLECTIONS)) {
    removed[collectionName] = await removeAllFromCollection(collectionName, 500)
  }
  return ok({ removed, collections: LOADTEST_COLLECTIONS }, '压测集合已清理')
}

async function dispatchRocoAction(event = {}) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const action = event.action || 'merchant.notifyCurrent'

  try {
    switch (action) {
      case 'home.bootstrap':
        return ok(await getHomeBootstrap(event, openid))
      case 'products.catalog':
        return ok(await getProductCatalog())
      case 'products.catalogV2':
        return ok(await getProductCatalogV2(event))
      case 'products.statsSnapshots':
        return ok(await getProductStatsSnapshotPayload(event))
      case 'merchant.current':
        return ok(await getCurrentMerchant())
      case 'merchant.history':
        return ok({ records: await getHistoryRecords() })
      case 'merchant.historyBundle':
        return ok(await getHistoryBundle(event))
      case 'merchant.historyByKeys':
        return ok({ records: await getHistoryRecordsByKeys(event) })
      case 'merchant.stats':
        return ok({ recommendedItems: await getRecommendedStats() })
      case 'merchant.voteSummary':
        return ok({ summary: await getRoundVoteSummary(event, openid) })
      case 'merchant.voteSubmit':
        return submitRoundVote(event, openid)
      case 'merchant.syncCurrent':
        return syncCurrentMerchant(event)
      case 'merchant.notifyCurrent':
        return notifyCurrentMerchant(event)
      case 'subscribe.status':
        return getSubscriptionStatus(event, openid)
      case 'subscribe.save':
        return saveSubscription(event, openid)
      case 'subscribe.updateItems':
        return updateSubscriptionItems(event, openid)
      case 'feedback.submit':
        return submitFeedback(event, openid)
      case 'feedback.mine':
        return getMyFeedback(event, openid)
      case 'feedback.markRead':
        return markFeedbackRead(event, openid)
      case 'announcement.current':
        return getCurrentAnnouncement()
      case 'announcement.list':
        return getAnnouncementList(event)
      case 'announcement.detail':
        return getAnnouncementDetail(event)
      case 'share.wxacode':
        return getShareWxacode()
      case 'share.goodsImages':
        return getShareGoodsImages(event)
      case 'admin.resetTesterData':
        return resetTesterData(event)
      case 'admin.clearRoundVotes':
        return clearRoundVotes(event)
      case 'admin.backfillWechatRejectedQuotas':
        return backfillWechatRejectedQuotas(event)
      case 'admin.repairQuotaConsumePending':
        return repairQuotaConsumePending(event)
      case 'admin.repairQuotaRefundPending':
        return repairQuotaRefundPending(event)
      case 'admin.backfillSubscriptionTargets':
        return backfillSubscriptionTargets(event)
      case 'admin.backfillSubscriptionProfilesV2':
        return backfillSubscriptionProfilesV2(event)
      case 'admin.backfillHistoryBundles':
        return backfillHistoryBundles(event)
      case 'admin.backfillProductStatsSnapshots':
        return backfillProductStatsSnapshots(event)
      case 'admin.clearLegacyNotificationCollections':
        return clearLegacyNotificationCollections(event)
      case 'admin.loadTest.seed':
        return seedLoadTest(event)
      case 'admin.loadTest.runRound':
        return runLoadTestRound(event)
      case 'admin.loadTest.summary':
        return summarizeLoadTest(event)
      case 'admin.loadTest.cleanup':
        return cleanupLoadTest(event)
      case 'admin.notifyRoundPending':
        return notifyRoundPending(event)
      case 'admin.forceSyncCurrent':
        return forceSyncCurrentMerchant(event)
      case 'admin.manualCurrent.get':
        return getManualCurrentRecord(event)
      case 'admin.manualCurrent.save':
        return saveManualCurrentRecord(event)
      case 'admin.manualCurrent.previewNotification':
        return previewManualNotification(event)
      case 'admin.manualCurrent.notifyItem':
        return notifyManualCurrentItem(event)
      case 'admin.productCatalog.previewCloudJson':
        return previewCloudProductCatalog(event)
      case 'admin.productCatalog.seed':
        return seedProductCatalog(event)
      case 'admin.productCatalog.syncImages':
        return syncProductCatalogImages(event)
      case 'admin.productCatalog.syncStatuses':
        return syncProductCatalogStatuses(event)
      default:
        return fail(`未知云函数动作: ${action}`)
    }
  } catch (error) {
    console.error(`[rocoApi] ${action} failed`, error)
    return fail(error.message || '云函数执行失败')
  }
}

exports.main = async (event = {}) => {
  const action = event.action || 'merchant.notifyCurrent'
  const startedAt = Date.now()
  const metrics = {
    action,
    dbReadCalls: 0,
    dbReadDocuments: 0,
    dbWriteCalls: 0,
    collectionsRead: {},
    collectionsWritten: {},
    queryTypes: {},
    writeTypes: {},
    cacheHits: {},
    dataSources: new Set()
  }
  return usageStorage.run(metrics, async () => {
    let response = null
    try {
      response = await dispatchRocoAction(event)
      return response
    } finally {
      let responseBytes = 0
      try {
        responseBytes = Buffer.byteLength(JSON.stringify(response || null), 'utf8')
      } catch (error) {}
      console.info('[rocoApi][usage]', JSON.stringify({
        action,
        durationMs: Date.now() - startedAt,
        success: Boolean(response && response.success === true),
        dbReadCalls: metrics.dbReadCalls,
        dbReadDocuments: metrics.dbReadDocuments,
        dbWriteCalls: metrics.dbWriteCalls,
        collectionsRead: metrics.collectionsRead,
        collectionsWritten: metrics.collectionsWritten,
        queryTypes: metrics.queryTypes,
        writeTypes: metrics.writeTypes,
        cacheHits: metrics.cacheHits,
        dataSources: Array.from(metrics.dataSources),
        responseBytes
      }))
    }
  })
}
