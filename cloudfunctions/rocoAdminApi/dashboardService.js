const fallbackProductCatalog = require('./product-catalog-fallback')

const COLLECTIONS = {
  deliveries: 'notification_deliveries',
  feedback: 'feedback',
  history: 'merchant_history',
  jobs: 'merchant_round_jobs',
  quotas: 'subscription_quotas',
  subscriptions: 'subscriptions',
  targets: 'subscription_targets',
  users: 'users'
}

let FOLLOW_ITEM_MATCHERS = fallbackProductCatalog.follow_targets || []

function setFollowItemMatchers(targets) {
  const configured = Array.isArray(targets) ? targets : []
  const fallback = fallbackProductCatalog.follow_targets || []
  const configuredIds = new Set(configured.map(item => String(item && item.id || '')))
  FOLLOW_ITEM_MATCHERS = configured.concat(fallback.filter(item => !configuredIds.has(String(item && item.id || ''))))
}

const ROUND_COUNT = 4
const DEFAULT_DAYS = 3
const MAX_DAYS = 14

function pad(num) {
  return String(num).padStart(2, '0')
}

function getChinaDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    date: shifted.getUTCDate()
  }
}

function formatChinaDate(date = new Date()) {
  const parts = getChinaDateParts(date)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.date)}`
}

function addDays(dateText, offset) {
  const [year, month, day] = String(dateText).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + offset)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function buildRoundKey(date, round) {
  return `${date}_round_${round}`
}

function parseRoundKey(roundKey) {
  const match = String(roundKey || '').match(/^(\d{4}-\d{2}-\d{2})_round_(\d+)$/)
  if (!match) return { date: '', round: null }
  return { date: match[1], round: Number(match[2]) }
}

function normalizeDateValue(value) {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString()
  if (value.$date) return String(value.$date)
  if (typeof value.toISOString === 'function') return value.toISOString()
  return String(value)
}

function deliveryAttemptsToRows(deliveries) {
  return deliveries.flatMap(delivery => {
    const attempts = Array.isArray(delivery.attempts) ? delivery.attempts : []
    return attempts.map(attempt => ({
      openid: delivery.openid,
      templateId: attempt.templateId || delivery.templateId || '',
      roundKey: delivery.roundKey,
      itemNames: attempt.itemNames || delivery.itemNames || [],
      source: attempt.source || delivery.source || '',
      status: attempt.status || '',
      errorMsg: attempt.errorMsg || '',
      attemptNo: Number(attempt.attemptNo || 0),
      quotaAttemptId: attempt.quotaAttemptId || '',
      quotaConsumed: attempt.quotaConsumed === true,
      quotaRefunded: attempt.quotaRefunded === true,
      quotaRefundPending: attempt.quotaRefundPending === true,
      createdAt: attempt.startedAt || attempt.createdAt || delivery.lastAttemptAt || ''
    }))
  })
}

function deliveryEventsToRows(deliveries) {
  return deliveries.flatMap(delivery => {
    const events = Array.isArray(delivery.events) ? delivery.events : []
    return events.map(event => ({
      openid: delivery.openid,
      templateId: event.templateId || delivery.templateId || '',
      roundKey: delivery.roundKey,
      itemName: Array.isArray(event.itemNames) ? event.itemNames.join('、') : '',
      itemNames: event.itemNames || delivery.itemNames || [],
      status: event.type || event.status || '',
      errorMsg: event.errorMsg || '',
      sentAt: event.createdAt || delivery.updatedAt || ''
    }))
  })
}

function createCounter() {
  return {
    pending: 0,
    sent: 0,
    sending: 0,
    failed: 0,
    retryableFailed: 0,
    finalFailed: 0,
    noQuota: 0,
    skipped: 0
  }
}

function incrementStatus(counter, status, amount = 1) {
  if (!status) return
  if (status === 'pending') counter.pending += amount
  else if (status === 'sent') counter.sent += amount
  else if (status === 'sending') counter.sending += amount
  else if (status === 'failed' || status === 'retryable_failed') counter.retryableFailed += amount
  else if (status === 'final_failed') counter.finalFailed += amount
  else if (status === 'no_quota') counter.noQuota += amount
  else if (status === 'skipped') counter.skipped += amount
}

function normalizeMatchText(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function isKeywordMatched(itemName, keyword) {
  if (!itemName || !keyword) return false
  const normalizedItemName = normalizeMatchText(itemName)
  const normalizedKeyword = normalizeMatchText(keyword)
  return normalizedItemName === normalizedKeyword ||
    normalizedItemName.includes(normalizedKeyword) ||
    normalizedItemName.endsWith(normalizedKeyword)
}

function getItemKeywords(name, keywords = []) {
  const matcher = FOLLOW_ITEM_MATCHERS.find(item => item.name === name) || { name, keywords: [name] }
  return Array.from(new Set([name]
    .concat(matcher.keywords || [])
    .concat(Array.isArray(keywords) ? keywords : [])
    .filter(keyword => typeof keyword === 'string')
    .map(keyword => keyword.trim())
    .filter(Boolean)))
}

function isSubscriptionMatched(itemName, subscription) {
  const keywords = getItemKeywords(subscription.itemName || subscription.item_name, subscription.keywords)
  return keywords.some(keyword => isKeywordMatched(itemName, keyword))
}

async function queryAll(db, collectionName, where = null, limit = Infinity) {
  const results = []
  const pageSize = 100

  for (let skip = 0; skip < limit; skip += pageSize) {
    const batchLimit = Number.isFinite(limit)
      ? Math.min(pageSize, limit - skip)
      : pageSize
    if (batchLimit <= 0) break

    let query = db.collection(collectionName)
    if (where) query = query.where(where)
    const res = await query.skip(skip).limit(batchLimit).get()
    const data = res.data || []
    results.push(...data)
    if (data.length < batchLimit) break
  }

  return results
}

function summarizeError(errorMsg) {
  const text = String(errorMsg || '').trim()
  if (!text) return ''
  if (text.includes('43101') || text.toLowerCase().includes('user refuse')) return '43101 user refuse'
  if (text.toLowerCase().includes('timeout') || text.includes('timed out')) return 'timeout'
  if (text.toLowerCase().includes('token')) return 'token'
  if (text.toLowerCase().includes('quota') || text.includes('no_quota')) return 'no quota'
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

function normalizeRoundItemSnapshot(notification) {
  if (!notification || notification.roundItemSnapshotRecorded !== true || !Array.isArray(notification.roundItems)) {
    return {
      items: [],
      totals: {
        recorded: false,
        subscriptionCount: 0,
        pushableCount: 0
      }
    }
  }

  const items = notification.roundItems
    .filter(item => item && item.name)
    .map(item => ({
      name: item.name,
      itemNames: Array.isArray(item.itemNames) ? item.itemNames : [],
      subscriptionCount: Number(item.subscriptionCount || 0),
      pushableCount: Number(item.pushableCount || 0)
    }))
  const totals = notification.roundItemTotals || {}

  return {
    items,
    totals: {
      recorded: true,
      subscriptionCount: Number(totals.subscriptionCount || 0),
      pushableCount: Number(totals.pushableCount || 0)
    }
  }
}

function getQuotaCount(quotas, openid, templateId) {
  const quota = quotas.find(item => item.openid === openid && (item.templateId || item.template_id) === templateId)
  return quota ? Number(quota.remainingCount || 0) : 0
}

function getQuotaDoc(quotas, openid, templateId) {
  return quotas.find(item => item.openid === openid && (item.templateId || item.template_id) === templateId) || null
}

function isWechatRejected(errorMsg) {
  const text = String(errorMsg || '').toLowerCase()
  return text.includes('43101') ||
    text.includes('user refuse') ||
    text.includes('refuse to accept')
}

function getLatestError(delivery, attempts, logs) {
  const withError = [delivery].concat(attempts || [], logs || [])
    .filter(item => item && item.errorMsg)
  return withError.length ? withError[withError.length - 1].errorMsg : ''
}

function isStaleSending(delivery) {
  if (!delivery || delivery.status !== 'sending') return false
  const lockedUntil = new Date(normalizeDateValue(delivery.lockedUntil) || 0).getTime()
  return Number.isFinite(lockedUntil) && lockedUntil > 0 && lockedUntil < Date.now()
}

function diagnoseUserTrace({ delivery, attempts, logs, subscriptions, quotas, matchedItems, history }) {
  const latestError = getLatestError(delivery, attempts, logs)
  const sentLog = logs.find(item => item.status === 'sent')
  const rejectedQuota = quotas.find(item => item.wechatRejected === true)

  if (delivery && delivery.status === 'sent') {
    if (!delivery.postSend || delivery.postSend.quotaConsumed !== true) {
      if (delivery.postSend && delivery.postSend.quotaError) {
        return { type: 'sent_quota_failed', level: 'warn', text: '微信发送成功，但扣次数确认失败；不会重发，需要执行扣次数补记。' }
      }
      return { type: 'sent_quota_pending', level: 'warn', text: '微信发送成功，但扣次数待确认；不会重发，需要执行扣次数补记。' }
    }
    return { type: 'sent', level: 'good', text: '已发送且扣次数已确认；若用户没看到，优先检查微信通知入口。' }
  }
  if (sentLog) {
    return { type: 'sent_log_only', level: 'good', text: '已有发送成功日志，但 delivery 缺失或不完整，属于历史记录缺口。' }
  }
  if (delivery && delivery.status === 'final_failed' && isWechatRejected(latestError)) {
    return { type: 'wechat_rejected', level: 'bad', text: '微信拒收 43101，需要用户到小程序设置重新允许订阅消息，或重新点击增加提醒次数。' }
  }
  if (rejectedQuota) {
    return { type: 'wechat_rejected_quota', level: 'bad', text: '该用户已被标记为微信拒收，重新点击增加提醒次数成功前，不会再自动推送。' }
  }
  if (delivery && delivery.status === 'final_failed') {
    if (delivery.postSend && delivery.postSend.quotaRefundPending === true) {
      return { type: 'final_failed_refund_pending', level: 'bad', text: '最终失败，次数退回未确认；需要执行退款补记。' }
    }
    return { type: 'final_failed', level: 'bad', text: `最终失败：${summarizeError(latestError) || '未知错误'}` }
  }
  if (delivery && delivery.status === 'retryable_failed') {
    if (delivery.postSend && delivery.postSend.quotaRefundPending === true) {
      return { type: 'retryable_failed_refund_pending', level: 'bad', text: '临时失败，次数退回未确认；需要执行退款补记后再补偿。' }
    }
    return { type: 'retryable_failed', level: 'warn', text: '临时失败，自动流程会在补偿触发时只重试这一个用户。' }
  }
  if (delivery && delivery.status === 'pending') {
    return { type: 'pending', level: 'warn', text: '已进入候选但还没发送，等待补偿触发处理。' }
  }
  if (delivery && delivery.status === 'sending') {
    return isStaleSending(delivery)
      ? { type: 'stale_sending', level: 'bad', text: '发送中残留。为避免重复打扰，自动流程不会重发 sending，需要人工判断。' }
      : { type: 'sending', level: 'warn', text: '正在发送或锁未过期，短时间内先观察。' }
  }
  if (delivery && delivery.status === 'no_quota') {
    return { type: 'no_quota', level: 'warn', text: '发送前复查发现无剩余次数，没有调用微信发送。' }
  }
  if (!subscriptions.length) {
    return { type: 'no_subscription', level: 'warn', text: '该用户当前没有启用订阅。' }
  }
  if (history && Array.isArray(history.items) && history.items.length && !matchedItems.length) {
    return { type: 'not_matched', level: '', text: '本轮商品没有命中该用户当前订阅。' }
  }
  if (matchedItems.length && subscriptions.every(item => {
    const quota = getQuotaDoc(quotas, item.openid, item.templateId || item.template_id)
    return !quota || Number(quota.remainingCount || 0) <= 0 || quota.wechatRejected === true
  })) {
    return { type: 'no_quota_candidate', level: 'warn', text: '本轮命中订阅，但该用户没有剩余提醒次数，所以没有进入推送候选。' }
  }
  if (matchedItems.length) {
    return { type: 'matched_without_delivery', level: 'bad', text: '本轮命中且有剩余次数，但没有 delivery，需检查该轮 job 或当时部署版本。' }
  }
  return { type: 'insufficient_data', level: 'warn', text: '没有足够的本轮商品历史，无法判断是否命中。' }
}

function buildRoundRows(roundKeys, jobs, deliveries, attempts, logs, histories = []) {
  const jobMap = new Map(jobs.map(job => [job.roundKey || job._id, job]))
  const historyMap = new Map(histories.map(history => [history.roundKey || history._id, history]))
  const rows = []
  const now = Date.now()

  for (const roundKey of roundKeys) {
    const parsed = parseRoundKey(roundKey)
    const job = jobMap.get(roundKey) || null
    const history = historyMap.get(roundKey) || null
    const rowDeliveries = deliveries.filter(item => item.roundKey === roundKey)
    const rowAttempts = attempts.filter(item => item.roundKey === roundKey)
    const rowLogs = logs.filter(item => item.roundKey === roundKey)
    const deliveryCounter = createCounter()
    const attemptCounter = createCounter()
    const logCounter = createCounter()

    rowDeliveries.forEach(item => incrementStatus(deliveryCounter, item.status))
    rowAttempts.forEach(item => incrementStatus(attemptCounter, item.status))
    rowLogs.forEach(item => incrementStatus(logCounter, item.status))

    const hasJob = Boolean(job)
    const hasLogsWithoutJob = !hasJob && rowLogs.length > 0
    const hasDeliveriesWithoutJob = !hasJob && rowDeliveries.length > 0
    const sendingWithoutLogs = deliveryCounter.sending > 0 && rowLogs.length === 0
    const sendingDeliveries = rowDeliveries.filter(item => item.status === 'sending')
    const staleSendingDeliveries = sendingDeliveries.filter(item => {
      const lockedUntil = new Date(normalizeDateValue(item.lockedUntil) || 0).getTime()
      return Number.isFinite(lockedUntil) && lockedUntil > 0 && lockedUntil < now
    })
    const staleSending = staleSendingDeliveries.length > 0
    const finalFailedDeliveries = rowDeliveries.filter(item => item.status === 'final_failed')
    const finalFailedLogs = rowLogs.filter(item => item.status === 'final_failed')
    const finalFailureRecords = finalFailedDeliveries.length ? finalFailedDeliveries : finalFailedLogs
    const wechatRejectedCount = finalFailureRecords.filter(item => isWechatRejected(item.errorMsg)).length
    const otherFinalFailedCount = Math.max(0, finalFailureRecords.length - wechatRejectedCount)
    const quotaConsumePendingCount = rowDeliveries.filter(item => {
      return item.status === 'sent' &&
        (!item.postSend || item.postSend.quotaConsumed !== true || item.postSend.quotaConsumePending === true)
    }).length
    const quotaRefundPendingCount = rowDeliveries.filter(item => {
      return item.postSend && item.postSend.quotaRefundPending === true && item.status !== 'sent'
    }).length
    const mostlySentButRetrying = Boolean(job && job.status === 'retrying' && (deliveryCounter.sent > 0 || logCounter.sent > 0))
    const finalFailureOnly = otherFinalFailedCount > 0 && deliveryCounter.retryableFailed === 0
    const notification = job && job.notification ? job.notification : null
    const matchedCandidates = Number(notification && notification.matched ? notification.matched : 0)
    const materializedCandidates = Number(notification && notification.materialized ? notification.materialized : 0)
    const candidateUnmaterialized = matchedCandidates > 0 && matchedCandidates > rowDeliveries.length
    const roundItemSummary = normalizeRoundItemSnapshot(notification)
    const queueTotal = Math.max(
      matchedCandidates,
      materializedCandidates,
      Number(notification && notification.queueTotal ? notification.queueTotal : 0),
      rowDeliveries.length
    )
    const queuePending = deliveryCounter.pending
    const queueRetryableFailed = deliveryCounter.retryableFailed
    const secondAttemptCount = rowDeliveries.filter(item => Number(item.attemptCount || 0) >= 2).length
    const queueProcessable = queuePending + queueRetryableFailed + staleSendingDeliveries.length
    const batchLimit = Number(notification && notification.batchLimit ? notification.batchLimit : 0)
    const remainingBatches = batchLimit > 0 ? Math.ceil(queueProcessable / batchLimit) : 0

    rows.push({
      roundKey,
      date: parsed.date,
      round: parsed.round,
      jobStatus: job ? job.status || '' : 'missing',
      notificationStatus: job ? job.notificationStatus || '' : '',
      notificationStage: job ? job.notificationStage || '' : '',
      capturedAt: normalizeDateValue(job && job.capturedAt),
      dispatchDeadlineAt: normalizeDateValue(job && job.dispatchDeadlineAt),
      fetched: Boolean(job && job.fetched),
      itemCount: job ? Number(job.itemCount || 0) : (history && Array.isArray(history.items) ? history.items.length : 0),
      roundItems: roundItemSummary.items,
      roundItemTotals: roundItemSummary.totals,
      attemptMinutes: job && Array.isArray(job.attemptMinutes) ? job.attemptMinutes : [],
      jobNotification: notification,
      coverage: {
        matched: matchedCandidates,
        materialized: materializedCandidates,
        deliveries: rowDeliveries.length,
        unmaterialized: Math.max(0, matchedCandidates - rowDeliveries.length),
        pending: Number(notification && notification.pending ? notification.pending : 0),
        processed: Number(notification && notification.processed ? notification.processed : 0),
        concurrency: Number(notification && notification.concurrency ? notification.concurrency : 0),
        batchLimit,
        timeBudgetMs: Number(notification && notification.timeBudgetMs ? notification.timeBudgetMs : 0),
        timeBudgetReached: Boolean(notification && notification.timeBudgetReached)
      },
      queue: {
        total: queueTotal,
        sent: deliveryCounter.sent || logCounter.sent,
        pending: queuePending,
        retryableFailed: queueRetryableFailed,
        finalFailed: otherFinalFailedCount,
        noQuota: deliveryCounter.noQuota,
        remainingBatches,
        batchLimit
      },
      deliveries: deliveryCounter,
      attempts: attemptCounter,
      logs: logCounter,
      flags: {
        hasLogsWithoutJob,
        hasDeliveriesWithoutJob,
        sendingWithoutLogs,
        staleSending,
        activeSendingCount: Math.max(0, sendingDeliveries.length - staleSendingDeliveries.length),
        staleSendingCount: staleSendingDeliveries.length,
        secondAttemptCount,
        wechatRejectedCount,
        otherFinalFailedCount,
        quotaConsumePendingCount,
        quotaRefundPendingCount,
        mostlySentButRetrying,
        finalFailureOnly,
        candidateUnmaterialized,
        queueNotDrained: queueProcessable > 0
      }
    })
  }

  return rows
}

function summarizeErrors(attempts, logs) {
  const map = new Map()
  attempts.concat(logs).forEach(item => {
    if (!item.errorMsg) return
    const key = summarizeError(item.errorMsg)
    if (!key) return
    const current = map.get(key) || { message: key, count: 0, roundKeys: new Set() }
    current.count += 1
    if (item.roundKey) current.roundKeys.add(item.roundKey)
    map.set(key, current)
  })

  return Array.from(map.values())
    .map(item => ({
      message: item.message,
      count: item.count,
      roundKeys: Array.from(item.roundKeys).slice(0, 8)
    }))
    .sort((a, b) => b.count - a.count)
}

function buildSubscriptionSummary(users, subscriptions, quotas) {
  const enabledSubscriptions = subscriptions.filter(item => item.enabled === true)
  const quotaItems = quotas.filter(item => Number(item.remainingCount || 0) > 0)
  const quotaUsers = new Set(quotaItems.map(item => item.openid))
  const pushableQuotaItems = quotaItems.filter(item => item.wechatRejected !== true)
  const wechatRejectedQuotaItems = quotas.filter(item => item.wechatRejected === true)
  const quotaKeys = new Set(pushableQuotaItems.map(item => `${item.openid}|${item.templateId || item.template_id}`))
  const itemMap = new Map()
  const pushableItemMap = new Map()

  enabledSubscriptions.forEach(item => {
    const name = item.itemName || item.item_name || ''
    if (!name) return
    itemMap.set(name, (itemMap.get(name) || 0) + 1)
    if (quotaKeys.has(`${item.openid}|${item.templateId || item.template_id}`)) {
      pushableItemMap.set(name, (pushableItemMap.get(name) || 0) + 1)
    }
  })

  return {
    userCount: users.length,
    enabledSubscriptionCount: enabledSubscriptions.length,
    quotaEligibleSubscriptionCount: enabledSubscriptions.filter(item => quotaKeys.has(`${item.openid}|${item.templateId || item.template_id}`)).length,
    usersWithQuota: quotaUsers.size,
    totalQuota: quotas.reduce((sum, item) => sum + Number(item.remainingCount || 0), 0),
    wechatRejectedQuotaCount: wechatRejectedQuotaItems.length,
    topItems: Array.from(itemMap.entries())
      .map(([name, count]) => ({ name, count, pushableCount: pushableItemMap.get(name) || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }
}

function buildFeedbackSummary(feedbacks) {
  const sorted = feedbacks
    .slice()
    .sort((a, b) => String(normalizeDateValue(b.createdAt)).localeCompare(String(normalizeDateValue(a.createdAt))))

  return {
    totalCount: feedbacks.length,
    newCount: feedbacks.filter(item => !item.status || item.status === 'new').length,
    recentItems: sorted.slice(0, 8).map(item => ({
      type: item.type || '',
      content: item.content || '',
      status: item.status || 'new',
      openid: item.openid || '',
      createdAt: normalizeDateValue(item.createdAt)
    }))
  }
}

async function getDashboardSummary(db, event = {}) {
  const days = Math.min(Math.max(Number(event.days || DEFAULT_DAYS), 1), MAX_DAYS)
  const today = formatChinaDate()
  const dates = Array.from({ length: days }, (_, index) => addDays(today, index - days + 1))
  const roundKeys = dates.flatMap(date => Array.from({ length: ROUND_COUNT }, (_, index) => buildRoundKey(date, index + 1)))
  const _ = db.command
  const whereRoundKeys = { roundKey: _.in(roundKeys) }

  const [jobs, deliveries, histories, users, subscriptions, quotas, feedbacks] = await Promise.all([
    queryAll(db, COLLECTIONS.jobs, whereRoundKeys),
    queryAll(db, COLLECTIONS.deliveries, whereRoundKeys),
    queryAll(db, COLLECTIONS.history, whereRoundKeys),
    queryAll(db, COLLECTIONS.users),
    queryAll(db, COLLECTIONS.subscriptions),
    queryAll(db, COLLECTIONS.quotas),
    queryAll(db, COLLECTIONS.feedback)
  ])
  const attempts = deliveryAttemptsToRows(deliveries)
  const logs = deliveryEventsToRows(deliveries)

  const rows = buildRoundRows(roundKeys, jobs, deliveries, attempts, logs, histories)
  const totals = rows.reduce((result, row) => {
    result.sent += row.deliveries.sent || row.logs.sent
    result.pending += row.deliveries.pending
    result.sending += row.deliveries.sending
    result.retryableFailed += row.deliveries.retryableFailed
    result.finalFailed += row.flags.otherFinalFailedCount || 0
    result.noQuota += row.deliveries.noQuota
    result.skipped += row.deliveries.skipped
    if (row.flags.hasLogsWithoutJob) result.roundsWithLogsNoJob += 1
    if (row.flags.hasDeliveriesWithoutJob) result.roundsWithDeliveriesNoJob += 1
    if (row.flags.sendingWithoutLogs) result.roundsSendingWithoutLogs += 1
    if (row.flags.staleSending) result.staleSendingRounds += 1
    if (row.flags.candidateUnmaterialized) result.candidateUnmaterializedRounds += 1
    if (row.jobStatus === 'retrying') result.retryingRounds += 1
    return result
  }, {
    sent: 0,
    pending: 0,
    sending: 0,
    retryableFailed: 0,
    finalFailed: 0,
    noQuota: 0,
    skipped: 0,
    retryingRounds: 0,
    roundsWithLogsNoJob: 0,
    roundsWithDeliveriesNoJob: 0,
    roundsSendingWithoutLogs: 0,
    staleSendingRounds: 0,
    candidateUnmaterializedRounds: 0
  })

  return {
    generatedAt: new Date().toISOString(),
    days,
    dates,
    rows: rows.sort((a, b) => String(b.roundKey).localeCompare(String(a.roundKey))),
    totals,
    errors: summarizeErrors(attempts, logs),
    subscriptions: buildSubscriptionSummary(users, subscriptions, quotas),
    feedback: buildFeedbackSummary(feedbacks)
  }
}

function groupRoundDetail(roundKey, deliveries, attempts, logs) {
  const users = new Map()

  function ensure(openid) {
    const key = openid || 'unknown'
    if (!users.has(key)) {
      users.set(key, {
        openid: key,
        delivery: null,
        attempts: [],
        logs: [],
        itemNames: []
      })
    }
    return users.get(key)
  }

  deliveries.forEach(item => {
    const user = ensure(item.openid)
    user.delivery = item
    user.itemNames = Array.from(new Set((item.itemNames || []).concat(user.itemNames || [])))
  })
  attempts.forEach(item => {
    const user = ensure(item.openid)
    user.attempts.push(item)
    user.itemNames = Array.from(new Set((item.itemNames || []).concat(user.itemNames || [])))
  })
  logs.forEach(item => {
    const user = ensure(item.openid)
    user.logs.push(item)
    if (item.itemName) user.itemNames = Array.from(new Set(user.itemNames.concat(item.itemName)))
  })

  return Array.from(users.values())
    .map(item => ({
      openid: item.openid,
      itemNames: item.itemNames,
      deliveryStatus: item.delivery ? item.delivery.status || '' : '',
      attemptCount: item.attempts.length,
      logCount: item.logs.length,
      lastError: summarizeError(
        (item.attempts.slice().reverse().find(attempt => attempt.errorMsg) || item.logs.slice().reverse().find(log => log.errorMsg) || {}).errorMsg
      ),
      delivery: item.delivery,
      attempts: item.attempts.map(attempt => ({
        templateId: attempt.templateId || '',
        status: attempt.status,
        source: attempt.source || '',
        itemNames: attempt.itemNames || [],
        errorMsg: attempt.errorMsg || '',
        createdAt: normalizeDateValue(attempt.createdAt)
      })),
      logs: item.logs.map(log => ({
        itemName: log.itemName,
        status: log.status,
        errorMsg: log.errorMsg || '',
        sentAt: normalizeDateValue(log.sentAt)
      }))
    }))
    .sort((a, b) => String(a.deliveryStatus).localeCompare(String(b.deliveryStatus)) || String(a.openid).localeCompare(String(b.openid)))
}

async function getRoundNotificationDetail(db, event = {}) {
  const roundKey = String(event.roundKey || '').trim()
  if (!roundKey) {
    throw new Error('roundKey is required')
  }

  const _ = db.command
  const parsed = parseRoundKey(roundKey)
  const [jobs, deliveries, histories] = await Promise.all([
    queryAll(db, COLLECTIONS.jobs, { roundKey }),
    queryAll(db, COLLECTIONS.deliveries, { roundKey }),
    queryAll(db, COLLECTIONS.history, { roundKey })
  ])
  const attempts = deliveryAttemptsToRows(deliveries)
  const logs = deliveryEventsToRows(deliveries)
  const rows = buildRoundRows([roundKey], jobs, deliveries, attempts, logs, histories)

  return {
    roundKey,
    date: parsed.date,
    round: parsed.round,
    summary: rows[0] || null,
    job: jobs[0] || null,
    users: groupRoundDetail(roundKey, deliveries, attempts, logs),
    rawCounts: {
      deliveries: deliveries.length,
      attempts: attempts.length,
      logs: logs.length
    }
  }
}

async function getUserNotificationTrace(db, event = {}) {
  const openid = String(event.openid || '').trim()
  const roundKey = String(event.roundKey || '').trim()
  if (!openid) {
    throw new Error('openid is required')
  }

  const deliveryWhere = roundKey ? { openid, roundKey } : { openid }
  const [deliveries, subscriptions, quotas, histories, jobs] = await Promise.all([
    queryAll(db, COLLECTIONS.deliveries, deliveryWhere),
    queryAll(db, COLLECTIONS.subscriptions, { openid }),
    queryAll(db, COLLECTIONS.quotas, { openid }),
    roundKey ? queryAll(db, COLLECTIONS.history, { roundKey }) : Promise.resolve([]),
    roundKey ? queryAll(db, COLLECTIONS.jobs, { roundKey }) : Promise.resolve([])
  ])
  const attempts = deliveryAttemptsToRows(deliveries)
  const logs = deliveryEventsToRows(deliveries)
  const enabledSubscriptions = subscriptions.filter(item => item.enabled === true)
  const history = histories[0] || null
  const job = jobs[0] || null
  const roundItems = history && Array.isArray(history.items) ? history.items : []
  const matchedItems = roundItems.filter(item => enabledSubscriptions.some(subscription => isSubscriptionMatched(item.name, subscription)))
  const delivery = deliveries
    .slice()
    .sort((a, b) => String(b.updatedAt || b.lastAttemptAt || '').localeCompare(String(a.updatedAt || a.lastAttemptAt || '')))[0] || null
  const roundItemSummary = normalizeRoundItemSnapshot(job && job.notification)
  const diagnosis = diagnoseUserTrace({
    delivery,
    attempts,
    logs,
    subscriptions: enabledSubscriptions,
    quotas,
    matchedItems,
    history
  })

  return {
    openid,
    roundKey,
    diagnosis,
    matchedItems: matchedItems.map(item => item.name),
    roundItems: roundItemSummary.items.filter(item => item.subscriptionCount > 0 || item.pushableCount > 0),
    roundItemTotals: roundItemSummary.totals,
    subscriptions: enabledSubscriptions.map(item => ({
      itemName: item.itemName || item.item_name || '',
      templateId: item.templateId || item.template_id || '',
      keywords: item.keywords || [],
      remainingCount: getQuotaCount(quotas, openid, item.templateId || item.template_id),
      previousRemainingCount: Number(getQuotaDoc(quotas, openid, item.templateId || item.template_id) && getQuotaDoc(quotas, openid, item.templateId || item.template_id).previousRemainingCount || 0),
      wechatRejected: Boolean(getQuotaDoc(quotas, openid, item.templateId || item.template_id) && getQuotaDoc(quotas, openid, item.templateId || item.template_id).wechatRejected === true)
    })),
    quotas: quotas.map(item => ({
      templateId: item.templateId || item.template_id || '',
      remainingCount: Number(item.remainingCount || 0),
      previousRemainingCount: Number(item.previousRemainingCount || 0),
      wechatRejected: item.wechatRejected === true,
      wechatRejectedAt: normalizeDateValue(item.wechatRejectedAt),
      wechatRejectedRoundKey: item.wechatRejectedRoundKey || ''
    })),
      delivery: delivery ? {
        status: delivery.status || '',
        itemNames: delivery.itemNames || [],
        candidateTemplateIds: delivery.candidateTemplateIds || [],
        rejectedTemplateIds: delivery.rejectedTemplateIds || [],
        attemptCount: Number(delivery.attemptCount || 0),
      errorMsg: delivery.errorMsg || '',
      postSend: delivery.postSend || null,
      lockedUntil: normalizeDateValue(delivery.lockedUntil),
      lastAttemptAt: normalizeDateValue(delivery.lastAttemptAt),
      updatedAt: normalizeDateValue(delivery.updatedAt)
    } : null,
    attempts: attempts.map(item => ({
      templateId: item.templateId || '',
      status: item.status || '',
      source: item.source || '',
      itemNames: item.itemNames || [],
      errorMsg: item.errorMsg || '',
      createdAt: normalizeDateValue(item.createdAt)
    })),
    logs: logs.map(item => ({
      templateId: item.templateId || '',
      itemName: item.itemName || '',
      status: item.status || '',
      errorMsg: item.errorMsg || '',
      sentAt: normalizeDateValue(item.sentAt)
    }))
  }
}

module.exports = {
  getDashboardSummary,
  getRoundNotificationDetail,
  getUserNotificationTrace,
  setFollowItemMatchers
}
