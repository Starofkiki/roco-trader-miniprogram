const COLLECTIONS = {
  announcements: 'announcements',
  feedback: 'feedback',
  quotas: 'subscription_quotas',
  subscriptions: 'subscriptions'
}

const HOME_ANNOUNCEMENT_ID = 'home'
const LEGACY_ANNOUNCEMENT_ID = 'notice_legacy_home'
const DEFAULT_ANNOUNCEMENT_PAGE_SIZE = 10
const DEFAULT_FEEDBACK_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

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

async function ensureCollectionExists(db, collectionName) {
  if (!collectionName || typeof db.createCollection !== 'function') return
  try {
    await db.createCollection(collectionName)
  } catch (error) {
    if (!isCollectionAlreadyExistsError(error)) throw error
  }
}

async function queryAll(db, collectionName) {
  const pageSize = 100
  const rows = []
  let offset = 0

  try {
    while (true) {
      const res = await db.collection(collectionName).skip(offset).limit(pageSize).get()
      const data = res.data || []
      rows.push(...data)
      if (data.length < pageSize) break
      offset += data.length
    }
  } catch (error) {
    if (isCollectionNotExistsError(error)) return []
    throw error
  }

  return rows
}

function encodeCursor(doc, orderField) {
  if (!doc || !doc[orderField]) return ''
  const value = doc[orderField]
  const date = value instanceof Date
    ? value
    : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value))
  if (Number.isNaN(date.getTime())) return ''
  return Buffer.from(JSON.stringify({ time: date.toISOString(), id: String(doc._id || '') })).toString('base64')
}

function decodeCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'))
    const date = new Date(parsed.time)
    return Number.isNaN(date.getTime()) ? null : { date, id: String(parsed.id || '') }
  } catch (error) {
    return null
  }
}

async function queryCursorPage(db, collectionName, where, orderField, pageSize, cursor, legacyPage) {
  const command = db.command
  const cursorValue = decodeCursor(cursor)
  const baseWhere = where || {}
  const queryWhere = cursorValue
    ? (cursorValue.id
        ? command.or([
            { ...baseWhere, [orderField]: command.lt(cursorValue.date) },
            { ...baseWhere, [orderField]: command.eq(cursorValue.date), _id: command.lt(cursorValue.id) }
          ])
        : { ...baseWhere, [orderField]: command.lt(cursorValue.date) })
    : baseWhere
  let query = db.collection(collectionName)
  if (cursorValue || Object.keys(baseWhere).length) query = query.where(queryWhere)
  query = query.orderBy(orderField, 'desc').orderBy('_id', 'desc')
  if (!cursorValue && Number(legacyPage || 1) > 1) query = query.skip((Number(legacyPage) - 1) * pageSize)
  try {
    const response = await query.limit(pageSize + 1).get()
    const docs = response.data || []
    const hasMore = docs.length > pageSize
    const items = docs.slice(0, pageSize)
    const last = items[items.length - 1]
    return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(last, orderField) : '' }
  } catch (error) {
    if (isCollectionNotExistsError(error)) return { items: [], hasMore: false, nextCursor: '' }
    throw error
  }
}

async function getDoc(db, collectionName, id) {
  try {
    const res = await db.collection(collectionName).doc(id).get()
    return res.data || null
  } catch (error) {
    if (isCollectionNotExistsError(error) || Number(error && error.errCode) === -1) return null
    const message = `${error && error.message ? error.message : ''} ${error && error.errMsg ? error.errMsg : ''}`.toLowerCase()
    if (message.includes('not exist') || message.includes('not found')) return null
    throw error
  }
}

async function setDoc(db, collectionName, id, data) {
  try {
    await db.collection(collectionName).doc(id).set({ data })
  } catch (error) {
    if (!isCollectionNotExistsError(error)) throw error
    await ensureCollectionExists(db, collectionName)
    await db.collection(collectionName).doc(id).set({ data })
  }
}

function normalizeDateValue(value) {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
  if (value && typeof value.getTime === 'function') return new Date(value.getTime()).toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function getTimeValue(value) {
  const normalized = normalizeDateValue(value)
  const time = new Date(normalized || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function clampPage(value, fallback = 1) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function clampPageSize(value, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return fallback
  return Math.min(number, MAX_PAGE_SIZE)
}

function maskOpenid(openid) {
  const value = String(openid || '').trim()
  if (!value) return ''
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`
  return `${value.slice(0, 6)}***${value.slice(-4)}`
}

function normalizeText(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function validateAnnouncementInput(event = {}) {
  const title = String(event.title || '').trim()
  const content = String(event.content || '').trim()
  if (!title) throw new Error('请填写公告标题')
  if (!content) throw new Error('请填写公告正文')
  if (title.length > 20) throw new Error('公告标题不能超过 20 个字')
  if (content.length > 500) throw new Error('公告内容不能超过 500 个字')
  return {
    title,
    content,
    pinned: event.pinned === true,
    hasPinned: Object.prototype.hasOwnProperty.call(event, 'pinned')
  }
}

function normalizeAnnouncement(doc = {}, pinnedAnnouncementId = '') {
  const id = doc._id || doc.id || ''
  return {
    id,
    title: String(doc.title || '公告').trim() || '公告',
    content: String(doc.content || '').trim(),
    publishedAt: normalizeDateValue(doc.publishedAt || doc.updatedAt),
    updatedAt: normalizeDateValue(doc.updatedAt || doc.publishedAt),
    deleted: doc.deleted === true,
    deletedAt: normalizeDateValue(doc.deletedAt),
    legacy: doc.legacy === true,
    pinned: Boolean(pinnedAnnouncementId && id === pinnedAnnouncementId)
  }
}

function getNoticeDocs(docs, includeDeleted = false, pinnedAnnouncementId = '') {
  return (docs || [])
    .filter(doc => doc && doc._id !== HOME_ANNOUNCEMENT_ID && doc.kind === 'notice')
    .filter(doc => includeDeleted || doc.deleted !== true)
    .sort((a, b) => {
      const pinnedDiff = Number(b._id === pinnedAnnouncementId) - Number(a._id === pinnedAnnouncementId)
      return pinnedDiff || getTimeValue(b.publishedAt || b.updatedAt) - getTimeValue(a.publishedAt || a.updatedAt)
    })
}

async function materializeLegacyHome(db, adminOpenid) {
  const existing = await getDoc(db, COLLECTIONS.announcements, LEGACY_ANNOUNCEMENT_ID)
  if (existing) return existing

  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  if (!home || home.announcementId || home.enabled === false || !String(home.content || '').trim()) return null

  const publishedAt = home.updatedAt || new Date()
  const legacy = {
    kind: 'notice',
    title: String(home.title || '公告').trim() || '公告',
    content: String(home.content || '').trim(),
    publishedAt,
    updatedAt: publishedAt,
    deleted: false,
    legacy: true,
    createdBy: adminOpenid || 'legacy'
  }
  await setDoc(db, COLLECTIONS.announcements, LEGACY_ANNOUNCEMENT_ID, legacy)
  return { _id: LEGACY_ANNOUNCEMENT_ID, ...legacy }
}

async function syncHomeAnnouncement(db, options = {}) {
  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const requestedPinnedId = Object.prototype.hasOwnProperty.call(options, 'pinnedAnnouncementId')
    ? String(options.pinnedAnnouncementId || '').trim()
    : String(home && home.pinnedAnnouncementId || '').trim()
  const requestedPinned = requestedPinnedId
    ? await getDoc(db, COLLECTIONS.announcements, requestedPinnedId)
    : null
  const pinned = requestedPinned && requestedPinned.kind === 'notice' && requestedPinned.deleted !== true
    ? requestedPinned
    : null
  const pinnedAnnouncementId = pinned ? pinned._id : ''
  const latestPage = pinned
    ? null
    : await queryCursorPage(
      db,
      COLLECTIONS.announcements,
      { kind: 'notice', deleted: db.command.neq(true) },
      'publishedAt',
      1,
      '',
      1
    )
  const latest = pinned || latestPage && latestPage.items[0] || null
  if (!latest) {
    await setDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID, {
      title: '公告',
      content: '',
      enabled: false,
      announcementId: '',
      pinnedAnnouncementId: '',
      updatedAt: new Date()
    })
    return null
  }

  await setDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID, {
    title: String(latest.title || '公告').trim() || '公告',
    content: String(latest.content || '').trim(),
    enabled: true,
    announcementId: latest._id,
    pinnedAnnouncementId,
    pinned: Boolean(pinned),
    publishedAt: latest.publishedAt || latest.updatedAt || new Date(),
    updatedAt: latest.updatedAt || latest.publishedAt || new Date()
  })
  return normalizeAnnouncement(latest, pinnedAnnouncementId)
}

async function listAnnouncements(db, event = {}) {
  const page = clampPage(event.page)
  const pageSize = clampPageSize(event.pageSize, DEFAULT_ANNOUNCEMENT_PAGE_SIZE)
  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const pinnedAnnouncementId = String(home && home.pinnedAnnouncementId || '').trim()
  const result = await queryCursorPage(
    db,
    COLLECTIONS.announcements,
    { kind: 'notice' },
    'publishedAt',
    pageSize,
    event.cursor,
    page
  )
  let docs = getNoticeDocs(result.items, true, pinnedAnnouncementId)
  let hasMore = result.hasMore
  let nextCursor = result.nextCursor
  if (page === 1 && !event.cursor && pinnedAnnouncementId) {
    const pinned = docs.find(item => item._id === pinnedAnnouncementId) || await getDoc(db, COLLECTIONS.announcements, pinnedAnnouncementId)
    const chronological = docs.filter(item => item._id !== pinnedAnnouncementId)
    const pinnedItems = pinned ? [pinned] : []
    const displayed = chronological.slice(0, Math.max(0, pageSize - pinnedItems.length))
    docs = pinnedItems.concat(displayed)
    hasMore = result.hasMore || chronological.length > displayed.length
    const cursorItem = displayed[displayed.length - 1]
    nextCursor = hasMore && cursorItem ? encodeCursor(cursorItem, 'publishedAt') : ''
  } else if (pinnedAnnouncementId) {
    docs = docs.filter(item => item._id !== pinnedAnnouncementId)
  }
  return {
    items: docs.map(item => normalizeAnnouncement(item, pinnedAnnouncementId)),
    page,
    pageSize,
    total: null,
    hasMore,
    nextCursor
  }
}

async function createAnnouncement(db, event, adminOpenid) {
  const input = validateAnnouncementInput(event)
  await materializeLegacyHome(db, adminOpenid)
  await ensureCollectionExists(db, COLLECTIONS.announcements)
  const now = new Date()
  const res = await db.collection(COLLECTIONS.announcements).add({
    data: {
      kind: 'notice',
      title: input.title,
      content: input.content,
      publishedAt: now,
      updatedAt: now,
      deleted: false,
      createdBy: adminOpenid,
      updatedBy: adminOpenid
    }
  })
  await syncHomeAnnouncement(db, input.pinned ? { pinnedAnnouncementId: res._id } : {})
  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const pinnedAnnouncementId = String(home && home.pinnedAnnouncementId || '').trim()
  const doc = await getDoc(db, COLLECTIONS.announcements, res._id)
  return { announcement: normalizeAnnouncement(doc || { _id: res._id, title: input.title, content: input.content, publishedAt: now, updatedAt: now }, pinnedAnnouncementId) }
}

async function updateAnnouncement(db, event, adminOpenid) {
  const id = String(event.id || '').trim()
  if (!id || id === HOME_ANNOUNCEMENT_ID) throw new Error('公告 id 不正确')
  const input = validateAnnouncementInput(event)
  const existing = await getDoc(db, COLLECTIONS.announcements, id)
  if (!existing || existing.kind !== 'notice') throw new Error('公告不存在')
  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const currentPinnedId = String(home && home.pinnedAnnouncementId || '').trim()
  const nextPinnedId = input.hasPinned
    ? (input.pinned ? id : (currentPinnedId === id ? '' : currentPinnedId))
    : currentPinnedId
  const data = { ...existing }
  delete data._id
  await setDoc(db, COLLECTIONS.announcements, id, {
    ...data,
    title: input.title,
    content: input.content,
    updatedAt: new Date(),
    updatedBy: adminOpenid
  })
  await syncHomeAnnouncement(db, { pinnedAnnouncementId: nextPinnedId })
  return { announcement: normalizeAnnouncement(await getDoc(db, COLLECTIONS.announcements, id) || { _id: id, ...data, title: input.title, content: input.content }, nextPinnedId) }
}

async function setAnnouncementDeleted(db, event, adminOpenid, deleted) {
  const id = String(event.id || '').trim()
  if (!id || id === HOME_ANNOUNCEMENT_ID) throw new Error('公告 id 不正确')
  const existing = await getDoc(db, COLLECTIONS.announcements, id)
  if (!existing || existing.kind !== 'notice') throw new Error('公告不存在')
  const home = await getDoc(db, COLLECTIONS.announcements, HOME_ANNOUNCEMENT_ID)
  const currentPinnedId = String(home && home.pinnedAnnouncementId || '').trim()
  const nextPinnedId = deleted && currentPinnedId === id ? '' : currentPinnedId
  const data = { ...existing }
  delete data._id
  const now = new Date()
  await setDoc(db, COLLECTIONS.announcements, id, {
    ...data,
    deleted,
    deletedAt: deleted ? now : null,
    deletedBy: deleted ? adminOpenid : '',
    restoredAt: deleted ? null : now,
    restoredBy: deleted ? '' : adminOpenid,
    updatedAt: now,
    updatedBy: adminOpenid
  })
  await syncHomeAnnouncement(db, { pinnedAnnouncementId: nextPinnedId })
  return { announcement: normalizeAnnouncement(await getDoc(db, COLLECTIONS.announcements, id) || { _id: id, ...data, deleted }, nextPinnedId) }
}

function normalizeFeedback(doc = {}) {
  return {
    id: doc._id || '',
    type: String(doc.type || ''),
    content: String(doc.content || ''),
    status: doc.status === 'handled' ? 'handled' : 'new',
    maskedOpenid: maskOpenid(doc.openid),
    adminNote: String(doc.adminNote || ''),
    publicReply: String(doc.publicReply || ''),
    createdAt: normalizeDateValue(doc.createdAt),
    updatedAt: normalizeDateValue(doc.updatedAt),
    handledAt: normalizeDateValue(doc.handledAt),
    replyUpdatedAt: normalizeDateValue(doc.replyUpdatedAt),
    replyReadAt: normalizeDateValue(doc.replyReadAt)
  }
}

async function listFeedback(db, event = {}) {
  const page = clampPage(event.page)
  const pageSize = clampPageSize(event.pageSize, DEFAULT_FEEDBACK_PAGE_SIZE)
  const status = ['new', 'handled'].includes(event.status) ? event.status : 'all'
  const result = await queryCursorPage(
    db,
    COLLECTIONS.feedback,
    status === 'all' ? {} : { status },
    'createdAt',
    pageSize,
    event.cursor,
    page
  )
  return {
    items: result.items.map(normalizeFeedback),
    page,
    pageSize,
    total: null,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
  }
}

async function updateFeedback(db, event = {}, adminOpenid) {
  const id = String(event.id || '').trim()
  if (!id) throw new Error('反馈 id 不能为空')
  const existing = await getDoc(db, COLLECTIONS.feedback, id)
  if (!existing) throw new Error('反馈不存在')
  const adminNote = String(event.adminNote || '').trim()
  if (adminNote.length > 500) throw new Error('管理员备注不能超过 500 个字')
  const requestedReply = String(event.publicReply || '').trim()
  if (requestedReply.length > 500) throw new Error('公开回复不能超过 500 个字')
  const existingReply = String(existing.publicReply || '').trim()
  const publicReply = requestedReply || existingReply
  const replyChanged = Boolean(requestedReply && requestedReply !== existingReply)
  const handled = Boolean(publicReply) || event.handled === true
  const now = new Date()
  const data = { ...existing }
  delete data._id
  const nextFeedback = {
    ...data,
    status: handled ? 'handled' : 'new',
    adminNote,
    publicReply,
    replyUpdatedAt: replyChanged ? now : (existing.replyUpdatedAt || null),
    replyReadAt: replyChanged ? null : (existing.replyReadAt || null),
    handledAt: handled ? (existing.handledAt || now) : null,
    handledBy: handled ? adminOpenid : '',
    updatedAt: now,
    updatedBy: adminOpenid
  }
  await setDoc(db, COLLECTIONS.feedback, id, nextFeedback)
  return { feedback: normalizeFeedback(await getDoc(db, COLLECTIONS.feedback, id) || { _id: id, ...nextFeedback }) }
}

function quotaKey(openid, templateId) {
  return `${openid}|${templateId}`
}

function matchesFocusItem(itemName, focusName) {
  const item = normalizeText(itemName)
  if (focusName === '炫彩蛋') return item === '炫彩蛋' || item === '炫彩精灵蛋'
  return item === normalizeText(focusName)
}

async function getOverview(db) {
  const [subscriptions, quotas] = await Promise.all([
    queryAll(db, COLLECTIONS.subscriptions),
    queryAll(db, COLLECTIONS.quotas)
  ])
  const enabled = subscriptions.filter(item => item.enabled === true && item.openid)
  const followers = new Set(enabled.map(item => item.openid))
  const quotaMap = new Map(quotas
    .filter(item => item.openid)
    .map(item => [quotaKey(item.openid, item.templateId || item.template_id || ''), item]))
  const templateKeysByUser = new Map()
  const focusSets = {
    '炫彩蛋': new Set(),
    '国王球': new Set(),
    '棱镜球': new Set()
  }

  enabled.forEach(item => {
    const templateId = item.templateId || item.template_id || ''
    if (!templateKeysByUser.has(item.openid)) templateKeysByUser.set(item.openid, new Set())
    templateKeysByUser.get(item.openid).add(quotaKey(item.openid, templateId))
    Object.keys(focusSets).forEach(name => {
      if (matchesFocusItem(item.itemName || item.item_name, name)) focusSets[name].add(item.openid)
    })
  })

  let usersWithRemaining = 0
  let unavailableUsers = 0
  const followerQuotaKeys = new Set()
  templateKeysByUser.forEach(keys => keys.forEach(key => followerQuotaKeys.add(key)))

  templateKeysByUser.forEach(keys => {
    const docs = Array.from(keys).map(key => quotaMap.get(key)).filter(Boolean)
    const hasRemaining = docs.some(item => Number(item.remainingCount || 0) > 0)
    const hasAvailable = docs.some(item => Number(item.remainingCount || 0) > 0 && item.wechatRejected !== true)
    const hasRejected = docs.some(item => item.wechatRejected === true)
    if (hasRemaining) usersWithRemaining += 1
    if (hasRejected || !hasAvailable) unavailableUsers += 1
  })

  return {
    totalFollowUsers: followers.size,
    usersWithRemaining,
    colorfulEggFollowers: focusSets['炫彩蛋'].size,
    kingBallFollowers: focusSets['国王球'].size,
    prismBallFollowers: focusSets['棱镜球'].size,
    totalRemainingQuota: Array.from(followerQuotaKeys).reduce((sum, key) => {
      const quota = quotaMap.get(key)
      return sum + Math.max(0, Number(quota && quota.remainingCount || 0))
    }, 0),
    unavailableUsers
  }
}

async function callRocoApi(cloud, payload) {
  const maintenanceSecret = process.env.MAINTENANCE_SECRET || ''
  if (!maintenanceSecret) throw new Error('rocoAdminApi 未配置 MAINTENANCE_SECRET')
  const response = await cloud.callFunction({
    name: 'rocoApi',
    data: {
      ...payload,
      maintenanceSecret
    }
  })
  const result = response && response.result ? response.result : response
  if (!result || result.success !== true) {
    throw new Error(result && result.message ? result.message : 'rocoApi 调用失败')
  }
  return result.data || {}
}

async function runMiniProgramAdminAction({ cloud, db, action, event, adminOpenid }) {
  switch (action) {
    case 'admin.overview':
      return getOverview(db)
    case 'admin.current.get':
      return callRocoApi(cloud, { action: 'admin.manualCurrent.get' })
    case 'admin.current.saveManual':
      return callRocoApi(cloud, {
        action: 'admin.manualCurrent.save',
        productIds: event.productIds,
        roundKey: event.roundKey,
        overwrite: event.overwrite === true,
        adminOpenid
      })
    case 'admin.notification.preview':
      return callRocoApi(cloud, {
        action: 'admin.manualCurrent.previewNotification',
        productId: event.productId,
        roundKey: event.roundKey
      })
    case 'admin.notification.send':
      return callRocoApi(cloud, {
        action: 'admin.manualCurrent.notifyItem',
        productId: event.productId,
        roundKey: event.roundKey,
        confirmSend: event.confirmSend === true,
        adminOpenid
      })
    case 'admin.announcements.list':
      return listAnnouncements(db, event)
    case 'admin.announcements.create':
      return createAnnouncement(db, event, adminOpenid)
    case 'admin.announcements.update':
      return updateAnnouncement(db, event, adminOpenid)
    case 'admin.announcements.delete':
      return setAnnouncementDeleted(db, event, adminOpenid, true)
    case 'admin.announcements.restore':
      return setAnnouncementDeleted(db, event, adminOpenid, false)
    case 'admin.feedback.list':
      return listFeedback(db, event)
    case 'admin.feedback.update':
      return updateFeedback(db, event, adminOpenid)
    default:
      throw new Error(`未知小程序管理员动作: ${action}`)
  }
}

module.exports = {
  runMiniProgramAdminAction
}
