const cloud = require('wx-server-sdk')
const {
  getDashboardSummary,
  getRoundNotificationDetail,
  getUserNotificationTrace,
  setFollowItemMatchers
} = require('./dashboardService')
const { runAdminOperation } = require('./operationService')
const { runMiniProgramAdminAction } = require('./miniProgramService')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const COLLECTIONS = {
  announcements: 'announcements',
  productCatalogMeta: 'product_catalog_meta'
}
const HOME_ANNOUNCEMENT_ID = 'home'
const PRODUCT_CATALOG_META_ID = 'current'

function ok(data = {}, message = '') {
  return { success: true, message, data }
}

function fail(message, extra = {}) {
  return { success: false, message, ...extra }
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
  if (!collectionName || typeof db.createCollection !== 'function') return
  try {
    await db.createCollection(collectionName)
  } catch (error) {
    if (!isCollectionAlreadyExistsError(error)) throw error
  }
}

async function getDoc(collectionName, id) {
  try {
    const res = await db.collection(collectionName).doc(id).get()
    return res.data || null
  } catch (error) {
    if (isCollectionNotExistsError(error)) return null
    throw error
  }
}

async function setDoc(collectionName, id, data) {
  try {
    await db.collection(collectionName).doc(id).set({ data })
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
    await ensureCollectionExists(collectionName)
    await db.collection(collectionName).doc(id).set({ data })
  }
}

function normalizeAnnouncement(doc = {}) {
  return {
    id: doc._id || HOME_ANNOUNCEMENT_ID,
    title: String(doc.title || '公告').trim() || '公告',
    content: String(doc.content || '').trim(),
    enabled: doc.enabled !== false,
    updatedAt: doc.updatedAt || null
  }
}

async function getAnnouncement() {
  const doc = await getDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  return {
    announcement: normalizeAnnouncement(doc || {
      enabled: false,
      title: '公告',
      content: ''
    })
  }
}

async function updateAnnouncement(event = {}) {
  const title = String(event.title || '公告').trim() || '公告'
  const content = String(event.content || '').trim()
  const enabled = event.enabled === true

  if (title.length > 20) throw new Error('公告标题不能超过 20 个字')
  if (content.length > 500) throw new Error('公告内容不能超过 500 个字')
  if (enabled && !content) throw new Error('启用公告前请填写内容')

  const home = await getDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  if (enabled) {
    const action = home && home.announcementId
      ? 'admin.announcements.update'
      : 'admin.announcements.create'
    await runMiniProgramAdminAction({
      cloud,
      db,
      action,
      event: {
        id: home && home.announcementId ? home.announcementId : '',
        title,
        content
      },
      adminOpenid: 'maintenance'
    })
  } else if (home && home.announcementId) {
    await runMiniProgramAdminAction({
      cloud,
      db,
      action: 'admin.announcements.delete',
      event: { id: home.announcementId },
      adminOpenid: 'maintenance'
    })
  } else {
    await setDoc(COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID, {
      title,
      content,
      enabled: false,
      updatedAt: new Date()
    })
  }
  return getAnnouncement()
}

function validateMaintenanceSecret(event = {}) {
  const expectedSecret = process.env.MAINTENANCE_SECRET || ''
  const providedSecret = typeof event.maintenanceSecret === 'string' ? event.maintenanceSecret : ''
  return expectedSecret && providedSecret === expectedSecret
}

function getAdminOpenids() {
  return new Set(String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map(openid => openid.trim())
    .filter(Boolean))
}

function isAdminOpenid(openid) {
  return Boolean(openid) && getAdminOpenids().has(openid)
}

function isMiniProgramAdminAction(action) {
  return [
    'admin.overview',
    'admin.current.get',
    'admin.current.saveManual',
    'admin.notification.preview',
    'admin.notification.send',
    'admin.announcements.list',
    'admin.announcements.create',
    'admin.announcements.update',
    'admin.announcements.delete',
    'admin.announcements.restore',
    'admin.feedback.list',
    'admin.feedback.update'
  ].includes(action)
}

async function dispatchAdminAction(event = {}) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''
  const action = event.action || 'admin.dashboardSummary'

  try {
    if (action === 'admin.status') {
      return ok({ isAdmin: isAdminOpenid(openid) })
    }

    const miniProgramAction = isMiniProgramAdminAction(action)
    const maintenanceAuthenticated = validateMaintenanceSecret(event)
    if (miniProgramAction ? !isAdminOpenid(openid) : !maintenanceAuthenticated) {
      if (miniProgramAction) return fail('无管理员权限', { code: 'ADMIN_FORBIDDEN' })
      return fail('维护密钥不正确')
    }

    if (action === 'admin.userNotificationTrace') {
      const productCatalogMeta = await getDoc(COLLECTIONS.productCatalogMeta, PRODUCT_CATALOG_META_ID)
      setFollowItemMatchers(productCatalogMeta && productCatalogMeta.follow_targets)
    }

    switch (action) {
      case 'admin.overview':
      case 'admin.current.get':
      case 'admin.current.saveManual':
      case 'admin.notification.preview':
      case 'admin.notification.send':
      case 'admin.announcements.list':
      case 'admin.announcements.create':
      case 'admin.announcements.update':
      case 'admin.announcements.delete':
      case 'admin.announcements.restore':
      case 'admin.feedback.list':
      case 'admin.feedback.update':
        return ok(await runMiniProgramAdminAction({ cloud, db, action, event, adminOpenid: openid }))
      case 'admin.dashboardSummary':
        return ok(await getDashboardSummary(db, event))
      case 'admin.roundNotificationDetail':
        return ok(await getRoundNotificationDetail(db, event))
      case 'admin.userNotificationTrace':
        return ok(await getUserNotificationTrace(db, event))
      case 'admin.announcement.get':
        return ok(await getAnnouncement())
      case 'admin.announcement.update':
        return ok(await updateAnnouncement(event), '公告已保存')
      case 'admin.operation':
        return ok(await runAdminOperation(cloud, event))
      default:
        return fail(`未知云函数动作: ${action}`)
    }
  } catch (error) {
    console.error(`[rocoAdminApi] ${action} failed`, error)
    return fail(error.message || '云函数执行失败')
  }
}

exports.main = async (event = {}) => {
  const action = event.action || 'admin.dashboardSummary'
  const startedAt = Date.now()
  let result = null
  try {
    result = await dispatchAdminAction(event)
    return result
  } finally {
    let responseBytes = 0
    try {
      responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    } catch (error) {}
    console.log('[rocoAdminApi][usage]', JSON.stringify({
      action,
      durationMs: Date.now() - startedAt,
      success: Boolean(result && result.success),
      responseBytes,
      source: 'cloud-database'
    }))
  }
}
