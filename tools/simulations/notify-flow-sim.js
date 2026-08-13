'use strict'

const assert = require('node:assert/strict')

const TEMPLATE_ID = 'template_reminder'
const ROUND_KEY = '2026-06-05_round_1'
const LAST_OPENID = 'openid_last_recipient_test'
const MAX_ATTEMPTS = 2
const BATCH_LIMIT = 1800
const TRIGGER_MINUTES = [3, 5, 10]
const ALL_DAY_ITEM = '棱镜球'
const SUBSCRIBE_TEMPLATE_IDS = [
  'ZT-hSLIk-muFnlIZ-VACBoNpxKKGrGb31fsWn4XaGxY',
  'x1IzmXjI0iUa8d2AEou0bPm72oBDVXwCzara5zBwk0M',
  'y0kmCnjN496miwcs73YNlzY6Fi47LxCKhekWGCqb-og'
]

function makeOpenid(index) {
  return `openid_${String(index).padStart(5, '0')}`
}

function deliveryIdOf(openid) {
  return `${openid}|${TEMPLATE_ID}|${ROUND_KEY}`
}

function deliveryIdOfRound(openid, roundKey) {
  return `${openid}|${TEMPLATE_ID}|${roundKey}`
}

function attemptIdOf(openid, attemptNo) {
  return `${deliveryIdOf(openid)}#attempt_${attemptNo}`
}

function createDb() {
  return {
    targets: new Map(),
    quotas: new Map(),
    deliveries: new Map(),
    jobs: new Map(),
    histories: new Map(),
    remoteFetches: [],
    sendCalls: new Map()
  }
}

function addTarget(db, openid, quota = 2) {
  db.targets.set(openid, {
    openid,
    templateId: TEMPLATE_ID,
    enabled: true,
    items: [{ itemName: '矿石', keywords: ['蓝晶碧玺'] }]
  })
  db.quotas.set(openid, {
    openid,
    templateId: TEMPLATE_ID,
    remainingCount: quota,
    consumedDeliveryIds: []
  })
}

function seedUsers(count, includeLast = false) {
  const db = createDb()
  for (let index = 1; index <= count; index += 1) {
    addTarget(db, makeOpenid(index), 3)
  }
  if (includeLast) addTarget(db, LAST_OPENID, 3)
  return db
}

function matchedRound() {
  return {
    roundKey: ROUND_KEY,
    date: '2026-06-05',
    round: 1,
    capturedMinute: 5,
    dispatchDeadlineMinute: 15,
    items: [{ name: '蓝晶碧玺' }]
  }
}

function allDayRound(date, round, items = [{ name: ALL_DAY_ITEM }]) {
  return {
    roundKey: `${date}_round_${round}`,
    date,
    round,
    items
  }
}

function canCollectAt(minute, remoteAvailableMinute) {
  return TRIGGER_MINUTES.includes(minute) && minute >= remoteAvailableMinute
}

function collectJob(db, minute, remoteAvailableMinute) {
  if (!TRIGGER_MINUTES.includes(minute)) return { collected: false, reason: 'outside_trigger' }
  if (!canCollectAt(minute, remoteAvailableMinute)) {
    db.jobs.set(ROUND_KEY, {
      roundKey: ROUND_KEY,
      status: 'collecting',
      attemptMinutes: [minute],
      lastError: 'normal_refresh_missing_waiting'
    })
    return { collected: false, reason: 'remote_missing' }
  }
  const job = db.jobs.get(ROUND_KEY) || { attemptMinutes: [] }
  db.jobs.set(ROUND_KEY, {
    ...job,
    roundKey: ROUND_KEY,
    status: 'dispatching',
    capturedMinute: minute,
    dispatchDeadlineMinute: minute + 10,
    attemptMinutes: Array.from(new Set(job.attemptMinutes.concat(minute))).sort((a, b) => a - b)
  })
  return { collected: true, merchant: { ...matchedRound(), capturedMinute: minute, dispatchDeadlineMinute: minute + 10 } }
}

function hasTrustedTimerCollection(job) {
  if (!job || job.manual === true || job.fetched !== true || Number(job.itemCount || 0) <= 0) return false
  return Array.isArray(job.attemptMinutes) && job.attemptMinutes.some(minute => TRIGGER_MINUTES.includes(Number(minute)))
}

function collectJobWithHistory(db, minute, remoteAvailableMinute) {
  if (!TRIGGER_MINUTES.includes(minute)) return { collected: false, reason: 'outside_trigger' }

  const existingJob = db.jobs.get(ROUND_KEY)
  const history = db.histories.get(ROUND_KEY)
  if (hasTrustedTimerCollection(existingJob) && history) {
    return { collected: true, merchant: history, source: 'history' }
  }

  db.remoteFetches.push(minute)
  const collected = collectJob(db, minute, remoteAvailableMinute)
  if (collected.collected) {
    const job = db.jobs.get(ROUND_KEY)
    db.jobs.set(ROUND_KEY, {
      ...job,
      fetched: true,
      itemCount: collected.merchant.items.length
    })
    db.histories.set(ROUND_KEY, collected.merchant)
  }
  return { ...collected, source: collected.collected ? 'remote' : collected.reason }
}

function materialize(db, merchant) {
  for (const target of db.targets.values()) {
    if (!target.enabled || !target.items.some(item => item.keywords.includes(merchant.items[0].name))) continue
    const id = deliveryIdOf(target.openid)
    if (db.deliveries.has(id)) continue
    db.deliveries.set(id, {
      openid: target.openid,
      templateId: TEMPLATE_ID,
      roundKey: ROUND_KEY,
      itemNames: [merchant.items[0].name],
      status: 'pending',
      attemptCount: 0,
      attempts: [],
      events: []
    })
  }
}

function materializeSelectedAdminItem(db, merchant, selectedItemName) {
  const selectedItems = merchant.items.filter(item => item.name === selectedItemName)
  if (!selectedItems.length) return

  for (const target of db.targets.values()) {
    if (!target.enabled) continue
    const matched = target.items.some(targetItem => {
      return selectedItems.some(item => targetItem.keywords.includes(item.name))
    })
    if (!matched) continue
    const quota = db.quotas.get(target.openid)
    if (!quota || quota.wechatRejected === true || Number(quota.remainingCount || 0) <= 0) continue

    const id = deliveryIdOf(target.openid)
    const existing = db.deliveries.get(id)
    if (existing && existing.status === 'sent') continue
    if (existing) {
      existing.itemNames = [selectedItemName]
      continue
    }
    db.deliveries.set(id, {
      openid: target.openid,
      templateId: TEMPLATE_ID,
      roundKey: ROUND_KEY,
      itemNames: [selectedItemName],
      status: 'pending',
      attemptCount: 0,
      attempts: [],
      events: []
    })
  }
}

function isAllDayItem(name) {
  return name === ALL_DAY_ITEM
}

function isAllDayRepeatException(merchant, itemName) {
  return merchant.date === '2026-06-14' &&
    merchant.round === 2 &&
    isAllDayItem(itemName)
}

function hasSentAllDayToday(db, merchant, openid, itemName) {
  if (!isAllDayItem(itemName)) return false

  for (let round = 1; round < merchant.round; round += 1) {
    const delivery = db.deliveries.get(deliveryIdOfRound(openid, `${merchant.date}_round_${round}`))
    if (delivery && delivery.status === 'sent' && delivery.itemNames.includes(itemName)) return true
  }

  return false
}

function materializeAllDayAware(db, merchant) {
  for (const target of db.targets.values()) {
    if (!target.enabled) continue
    const matchedItems = merchant.items.filter(merchantItem => {
      return target.items.some(targetItem => targetItem.keywords.includes(merchantItem.name))
    })
    const pushableItems = matchedItems.filter(item => {
      return !hasSentAllDayToday(db, merchant, target.openid, item.name) ||
        isAllDayRepeatException(merchant, item.name)
    })
    if (!pushableItems.length) continue

    const id = deliveryIdOfRound(target.openid, merchant.roundKey)
    if (db.deliveries.has(id)) continue
    db.deliveries.set(id, {
      openid: target.openid,
      templateId: TEMPLATE_ID,
      roundKey: merchant.roundKey,
      itemNames: pushableItems.map(item => item.name),
      status: 'pending',
      attemptCount: 0,
      attempts: [],
      events: []
    })
  }
}

function countSendCalls(db, openid) {
  return db.sendCalls.get(openid) || 0
}

function countStatus(db, status) {
  return Array.from(db.deliveries.values()).filter(delivery => delivery.status === status).length
}

function hasNormalProcessable(db) {
  return Array.from(db.deliveries.values()).some(delivery => {
    if (delivery.openid === LAST_OPENID) return false
    return ['pending', 'retryable_failed', 'sending'].includes(delivery.status)
  })
}

function claimAttempt(db, delivery) {
  if (delivery.attemptCount >= MAX_ATTEMPTS) {
    delivery.status = 'final_failed'
    delivery.errorMsg = 'max notification attempts reached'
    return null
  }
  const quota = db.quotas.get(delivery.openid)
  if (!quota || quota.remainingCount <= 0) {
    delivery.status = 'no_quota'
    return null
  }
  const attemptNo = delivery.attemptCount + 1
  const quotaAttemptId = attemptIdOf(delivery.openid, attemptNo)
  quota.remainingCount -= 1
  quota.consumedDeliveryIds.push(quotaAttemptId)
  delivery.attemptCount = attemptNo
  delivery.status = 'sending'
  delivery.attempts.push({
    attemptNo,
    quotaAttemptId,
    status: 'sending',
    quotaConsumed: true
  })
  return { attemptNo, quotaAttemptId }
}

function refundAttempt(db, delivery, claim) {
  const quota = db.quotas.get(delivery.openid)
  if (!quota || !claim) return
  quota.consumedDeliveryIds = quota.consumedDeliveryIds.filter(id => id !== claim.quotaAttemptId)
  quota.remainingCount += 1
  const attempt = delivery.attempts.find(item => item.attemptNo === claim.attemptNo)
  if (attempt) {
    attempt.quotaConsumed = false
    attempt.quotaRefunded = true
  }
}

function sendOne(db, delivery, sendModes) {
  const claim = claimAttempt(db, delivery)
  if (!claim) return
  db.sendCalls.set(delivery.openid, countSendCalls(db, delivery.openid) + 1)
  const mode = sendModes[delivery.openid] || 'success'
  const attempt = delivery.attempts.find(item => item.attemptNo === claim.attemptNo)
  if (mode === 'timeout' && claim.attemptNo === 1) {
    refundAttempt(db, delivery, claim)
    delivery.status = 'retryable_failed'
    delivery.errorMsg = 'timeout'
    if (attempt) attempt.status = 'retryable_failed'
    return
  }
  if (mode === 'stuck' && claim.attemptNo === 1) {
    delivery.status = 'sending'
    delivery.errorMsg = 'stuck sending'
    if (attempt) attempt.status = 'sending'
    return
  }
  if (mode === 'reject43101') {
    delivery.status = 'final_failed'
    delivery.errorMsg = '43101 user refuse'
    if (attempt) attempt.status = 'final_failed'
    const quota = db.quotas.get(delivery.openid)
    quota.previousRemainingCount = quota.remainingCount
    quota.remainingCount = 0
    quota.wechatRejected = true
    return
  }
  delivery.status = 'sent'
  delivery.errorMsg = ''
  delivery.attempts = delivery.attempts.filter(item => item.attemptNo !== claim.attemptNo)
}

function dispatch(db, sendModes = {}, batchLimit = BATCH_LIMIT) {
  const processable = Array.from(db.deliveries.values())
    .filter(delivery => ['pending', 'retryable_failed', 'sending'].includes(delivery.status))
  const normal = processable.filter(delivery => delivery.openid !== LAST_OPENID)
  const selected = (normal.length ? normal : processable)
    .slice(0, batchLimit)
  selected.forEach(delivery => sendOne(db, delivery, sendModes))
  return {
    sent: countStatus(db, 'sent'),
    pending: countStatus(db, 'pending') + countStatus(db, 'retryable_failed') + countStatus(db, 'sending'),
    finalFailed: countStatus(db, 'final_failed')
  }
}

function runDispatchUntilDone(db, merchant, sendModes = {}, maxRuns = 10) {
  materialize(db, merchant)
  let result = null
  for (let run = 0; run < maxRuns; run += 1) {
    result = dispatch(db, sendModes)
    if (result.pending === 0) break
  }
  return result
}

function testTriggerWindowStartsAtFirstSuccessfulCollect() {
  const db = seedUsers(20)
  assert.deepEqual(collectJob(db, 3, 5), { collected: false, reason: 'remote_missing' })
  const collected = collectJob(db, 5, 5)
  assert.equal(collected.collected, true)
  assert.equal(db.jobs.get(ROUND_KEY).capturedMinute, 5)
  assert.equal(db.jobs.get(ROUND_KEY).dispatchDeadlineMinute, 15)
  const result = runDispatchUntilDone(db, collected.merchant)
  assert.equal(result.sent, 20)
  return '第3分钟失败、第5分钟成功后从第5分钟起算10分钟'
}

function testTenthMinuteFallbackStartsOwnWindow() {
  const db = seedUsers(20)
  collectJob(db, 3, 10)
  collectJob(db, 5, 10)
  const collected = collectJob(db, 10, 10)
  assert.equal(collected.collected, true)
  assert.equal(db.jobs.get(ROUND_KEY).dispatchDeadlineMinute, 20)
  const result = runDispatchUntilDone(db, collected.merchant)
  assert.equal(result.sent, 20)
  return '第10分钟保底采集后有独立10分钟派发窗口'
}

function testThirdMinuteIgnoresEarlyHistoryWithoutTrustedJob() {
  const db = seedUsers(20)
  db.histories.set(ROUND_KEY, {
    ...matchedRound(),
    capturedMinute: 0,
    items: [{ name: '旧商品' }]
  })

  const collected = collectJobWithHistory(db, 3, 3)

  assert.equal(collected.collected, true)
  assert.equal(collected.source, 'remote')
  assert.deepEqual(db.remoteFetches, [3])
  assert.deepEqual(db.histories.get(ROUND_KEY).items, [{ name: '蓝晶碧玺' }])
  assert.equal(db.jobs.get(ROUND_KEY).fetched, true)
  assert.equal(db.jobs.get(ROUND_KEY).itemCount, 1)
  return '第3分钟不会复用整点提前写入的旧历史'
}

function testLaterRetryUsesTrustedThirdMinuteCollection() {
  const db = seedUsers(20)
  const thirdMinute = collectJobWithHistory(db, 3, 3)
  const fifthMinute = collectJobWithHistory(db, 5, 3)

  assert.equal(thirdMinute.source, 'remote')
  assert.equal(fifthMinute.source, 'history')
  assert.deepEqual(db.remoteFetches, [3])
  assert.deepEqual(db.jobs.get(ROUND_KEY).attemptMinutes, [3])
  return '第3分钟可信采集成功后第5分钟不再重拉远端'
}

function testMissingThirdMinuteRetriesRemoteAtFifthMinute() {
  const db = seedUsers(20)
  const thirdMinute = collectJobWithHistory(db, 3, 5)
  const fifthMinute = collectJobWithHistory(db, 5, 5)

  assert.equal(thirdMinute.collected, false)
  assert.equal(thirdMinute.source, 'remote_missing')
  assert.equal(fifthMinute.collected, true)
  assert.equal(fifthMinute.source, 'remote')
  assert.deepEqual(db.remoteFetches, [3, 5])
  return '第3分钟未拿到有效商品时第5分钟继续重拉远端'
}

function testQueueScalesTo5000WithBatches() {
  const db = seedUsers(5000)
  const merchant = matchedRound()
  const result = runDispatchUntilDone(db, merchant, {}, 3)
  assert.equal(db.deliveries.size, 5000)
  assert.equal(result.sent, 5000)
  assert.equal(result.pending, 0)
  assert.equal(db.quotas.get(makeOpenid(1)).remainingCount, 2)
  assert.equal(db.quotas.get(makeOpenid(5000)).remainingCount, 2)
  assert.equal(db.deliveries.get(deliveryIdOf(makeOpenid(1))).attempts.length, 0)
  assert.equal(db.deliveries.get(deliveryIdOf(makeOpenid(1))).events.length, 0)
  return '5000用户分批派发完成且每个成功发送扣1次'
}

function testRetryDeductsAgainButMaxTwoAttempts() {
  const db = seedUsers(1)
  const openid = makeOpenid(1)
  const result = runDispatchUntilDone(db, matchedRound(), { [openid]: 'timeout' }, 3)
  assert.equal(result.sent, 1)
  assert.equal(countSendCalls(db, openid), 2)
  assert.equal(db.quotas.get(openid).remainingCount, 2)
  assert.equal(db.deliveries.get(deliveryIdOf(openid)).attemptCount, 2)
  assert.equal(db.deliveries.get(deliveryIdOf(openid)).attempts.length, 1)
  assert.equal(db.deliveries.get(deliveryIdOf(openid)).attempts[0].status, 'retryable_failed')
  assert.equal(db.deliveries.get(deliveryIdOf(openid)).events.length, 0)
  return '临时失败先退回，第二次发送再扣一次且最多两次'
}

function testLastRecipientWaitsForNormalQueue() {
  const db = seedUsers(5, true)
  materialize(db, matchedRound())
  dispatch(db, { [makeOpenid(1)]: 'timeout' }, 4)
  assert.equal(countSendCalls(db, LAST_OPENID), 0)
  assert.equal(hasNormalProcessable(db), true)
  dispatch(db, { [makeOpenid(1)]: 'timeout' }, 10)
  assert.equal(hasNormalProcessable(db), false)
  assert.equal(countSendCalls(db, LAST_OPENID), 0)
  dispatch(db, {}, 10)
  assert.equal(countSendCalls(db, LAST_OPENID), 1)
  assert.equal(db.deliveries.get(deliveryIdOf(LAST_OPENID)).status, 'sent')
  return '收尾账号在普通队列清空后才发送'
}

function buildLoadTestModes(count, scenario) {
  const modes = {}
  for (let index = 1; index <= count; index += 1) {
    const openid = makeOpenid(index)
    if (scenario === 'timeout5' && index % 20 === 0) modes[openid] = 'timeout'
    if (scenario === 'reject1' && index % 100 === 0) modes[openid] = 'reject43101'
    if (scenario === 'stuck2' && index % 50 === 0) modes[openid] = 'stuck'
  }
  return modes
}

function assertNoMoreThanTwoAttempts(db) {
  for (const delivery of db.deliveries.values()) {
    assert.ok(delivery.attemptCount <= MAX_ATTEMPTS, `${delivery.openid} exceeded max attempts`)
  }
}

function assertRetryRefunded(db, openid) {
  const delivery = db.deliveries.get(deliveryIdOf(openid))
  const firstAttempt = delivery.attempts.find(attempt => attempt.attemptNo === 1)
  assert.equal(firstAttempt.quotaConsumed, false)
  assert.equal(firstAttempt.quotaRefunded, true)
}

function testLoadTestShadowAllSuccess1000() {
  const db = seedUsers(1000, true)
  const result = runDispatchUntilDone(db, matchedRound(), {}, 5)
  assert.equal(db.deliveries.size, 1001)
  assert.equal(result.sent, 1001)
  assert.equal(result.pending, 0)
  assert.equal(db.quotas.get(makeOpenid(1)).remainingCount, 2)
  assert.equal(db.quotas.get(LAST_OPENID).remainingCount, 2)
  assertNoMoreThanTwoAttempts(db)
  return '影子压测1000人全成功：不触达微信也能校验队列和扣次'
}

function testLoadTestShadowTimeoutRetry1000() {
  const db = seedUsers(1000)
  const modes = buildLoadTestModes(1000, 'timeout5')
  const result = runDispatchUntilDone(db, matchedRound(), modes, 6)
  assert.equal(result.sent, 1000)
  assert.equal(result.pending, 0)
  assert.equal(countSendCalls(db, makeOpenid(20)), 2)
  assertRetryRefunded(db, makeOpenid(20))
  assert.equal(db.quotas.get(makeOpenid(20)).remainingCount, 2)
  assertNoMoreThanTwoAttempts(db)
  return '影子压测1000人+5%超时：失败退回、二次发送再扣次'
}

function testLoadTestShadowReject1000() {
  const db = seedUsers(1000)
  const modes = buildLoadTestModes(1000, 'reject1')
  const result = runDispatchUntilDone(db, matchedRound(), modes, 5)
  assert.equal(result.sent, 990)
  assert.equal(result.finalFailed, 10)
  assert.equal(db.quotas.get(makeOpenid(100)).remainingCount, 0)
  assert.equal(db.quotas.get(makeOpenid(100)).wechatRejected, true)
  assertNoMoreThanTwoAttempts(db)
  return '影子压测1000人+1%拒收：43101归零且不阻塞其他用户'
}

function testLoadTestShadowStuckSending1000() {
  const db = seedUsers(1000)
  const modes = buildLoadTestModes(1000, 'stuck2')
  const result = runDispatchUntilDone(db, matchedRound(), modes, 6)
  assert.equal(result.sent, 1000)
  assert.equal(result.pending, 0)
  assert.equal(countSendCalls(db, makeOpenid(50)), 2)
  assert.equal(db.deliveries.get(deliveryIdOf(makeOpenid(50))).attemptCount, 2)
  assert.equal(db.quotas.get(makeOpenid(50)).remainingCount, 1)
  assertNoMoreThanTwoAttempts(db)
  return '影子压测1000人+stuck sending：过期发送可补偿且最多两次'
}

function testAllDayPrismOnlySendsOncePerFutureDay() {
  const db = createDb()
  db.targets.set('openid_prism', {
    openid: 'openid_prism',
    templateId: TEMPLATE_ID,
    enabled: true,
    items: [{ itemName: ALL_DAY_ITEM, keywords: [ALL_DAY_ITEM] }]
  })
  db.quotas.set('openid_prism', { openid: 'openid_prism', templateId: TEMPLATE_ID, remainingCount: 4 })

  materializeAllDayAware(db, allDayRound('2026-06-15', 1))
  db.deliveries.get(deliveryIdOfRound('openid_prism', '2026-06-15_round_1')).status = 'sent'
  materializeAllDayAware(db, allDayRound('2026-06-15', 2))
  materializeAllDayAware(db, allDayRound('2026-06-15', 3))
  materializeAllDayAware(db, allDayRound('2026-06-15', 4))

  assert.equal(db.deliveries.size, 1)
  return '未来棱镜球同一天最多物料化一次提醒'
}

function testAllDayPrismAllowsJune14SecondRoundRepeat() {
  const db = createDb()
  db.targets.set('openid_prism', {
    openid: 'openid_prism',
    templateId: TEMPLATE_ID,
    enabled: true,
    items: [{ itemName: ALL_DAY_ITEM, keywords: [ALL_DAY_ITEM] }]
  })
  db.quotas.set('openid_prism', { openid: 'openid_prism', templateId: TEMPLATE_ID, remainingCount: 4 })

  materializeAllDayAware(db, allDayRound('2026-06-14', 1))
  db.deliveries.get(deliveryIdOfRound('openid_prism', '2026-06-14_round_1')).status = 'sent'
  materializeAllDayAware(db, allDayRound('2026-06-14', 2))
  db.deliveries.get(deliveryIdOfRound('openid_prism', '2026-06-14_round_2')).status = 'sent'
  materializeAllDayAware(db, allDayRound('2026-06-14', 3))
  materializeAllDayAware(db, allDayRound('2026-06-14', 4))

  assert.equal(db.deliveries.size, 2)
  return '2026-06-14 第2轮允许棱镜球补发一次，后两轮不再生成'
}

function testAllDayFilterKeepsOtherMatchedItems() {
  const db = createDb()
  db.targets.set('openid_mix', {
    openid: 'openid_mix',
    templateId: TEMPLATE_ID,
    enabled: true,
    items: [
      { itemName: ALL_DAY_ITEM, keywords: [ALL_DAY_ITEM] },
      { itemName: '国王球', keywords: ['国王球'] }
    ]
  })
  db.quotas.set('openid_mix', { openid: 'openid_mix', templateId: TEMPLATE_ID, remainingCount: 4 })

  materializeAllDayAware(db, allDayRound('2026-06-15', 1))
  db.deliveries.get(deliveryIdOfRound('openid_mix', '2026-06-15_round_1')).status = 'sent'
  materializeAllDayAware(db, allDayRound('2026-06-15', 2, [{ name: ALL_DAY_ITEM }, { name: '国王球' }]))

  const secondRound = db.deliveries.get(deliveryIdOfRound('openid_mix', '2026-06-15_round_2'))
  assert.deepEqual(secondRound.itemNames, ['国王球'])
  return '棱镜球被当天去重时，同轮其他命中商品仍会提醒'
}

function buildAllDayRemark(round) {
  const remainingRounds = Math.max(0, 4 - round)
  if (!remainingRounds) return `${ALL_DAY_ITEM}持续一天`
  return `${ALL_DAY_ITEM}持续一天，后续${remainingRounds === 3 ? '三' : remainingRounds === 2 ? '两' : remainingRounds}轮不重复`
}

function testAllDayRemarkFitsTemplateLimit() {
  assert.equal(buildAllDayRemark(1), '棱镜球持续一天，后续三轮不重复')
  assert.equal(buildAllDayRemark(2), '棱镜球持续一天，后续两轮不重复')
  assert.ok(buildAllDayRemark(1).length <= 20)
  assert.ok(buildAllDayRemark(2).length <= 20)
  return '棱镜球持续一天备注区分第1/2轮且不超过20字'
}

function addFocusedTarget(db, openid, itemName, remainingCount, wechatRejected = false) {
  db.targets.set(openid, {
    openid,
    templateId: TEMPLATE_ID,
    enabled: true,
    items: [{ itemName, keywords: [itemName] }]
  })
  db.quotas.set(openid, {
    openid,
    templateId: TEMPLATE_ID,
    remainingCount,
    wechatRejected,
    consumedDeliveryIds: []
  })
}

function testAdminSelectedItemOnlyTargetsEligibleFollowers() {
  const db = createDb()
  addFocusedTarget(db, 'openid_prism_ok', '棱镜球', 2)
  addFocusedTarget(db, 'openid_king', '国王球', 2)
  addFocusedTarget(db, 'openid_prism_empty', '棱镜球', 0)
  addFocusedTarget(db, 'openid_prism_rejected', '棱镜球', 2, true)
  const merchant = {
    ...matchedRound(),
    items: [{ name: '棱镜球' }, { name: '国王球' }]
  }

  materializeSelectedAdminItem(db, merchant, '棱镜球')
  assert.equal(db.deliveries.size, 1)
  assert.deepEqual(db.deliveries.get(deliveryIdOf('openid_prism_ok')).itemNames, ['棱镜球'])
  dispatch(db)
  assert.equal(db.quotas.get('openid_prism_ok').remainingCount, 1)
  assert.equal(db.quotas.get('openid_king').remainingCount, 2)
  assert.equal(db.quotas.get('openid_prism_rejected').remainingCount, 2)
  return '管理员指定商品只推有次数且未拒收的关注用户'
}

function testAdminSelectedItemKeepsSameRoundIdempotent() {
  const db = createDb()
  addFocusedTarget(db, 'openid_prism_once', '棱镜球', 2)
  const merchant = { ...matchedRound(), items: [{ name: '棱镜球' }] }

  materializeSelectedAdminItem(db, merchant, '棱镜球')
  dispatch(db)
  materializeSelectedAdminItem(db, merchant, '棱镜球')
  dispatch(db)

  assert.equal(countSendCalls(db, 'openid_prism_once'), 1)
  assert.equal(db.quotas.get('openid_prism_once').remainingCount, 1)
  return '管理员重复触发同轮商品不会重复推送或扣次'
}

function sendFromTemplatePool(channels, modes = {}) {
  const attempts = []
  for (const channel of channels) {
    if (channel.rejected || channel.remainingCount <= 0) continue
    const modeList = Array.isArray(modes[channel.id]) ? modes[channel.id] : [modes[channel.id] || 'success']
    const maxAttempts = Math.min(2, modeList.length)
    for (let index = 0; index < maxAttempts; index += 1) {
      channel.remainingCount -= 1
      const mode = modeList[index]
      attempts.push({ templateId: channel.id, mode })
      if (mode === 'reject43101') {
        channel.rejected = true
        channel.remainingCount = 0
        break
      }
      if (mode === 'timeout') {
        channel.remainingCount += 1
        if (index + 1 < maxAttempts) continue
        return { sent: false, attempts }
      }
      return { sent: true, templateId: channel.id, attempts }
    }
  }
  return { sent: false, attempts }
}

function testTemplatePoolSendsOnlyOnce() {
  const channels = [
    { id: 'template_1', remainingCount: 1 },
    { id: 'template_2', remainingCount: 1 },
    { id: 'template_3', remainingCount: 1 }
  ]
  const result = sendFromTemplatePool(channels)
  assert.equal(result.sent, true)
  assert.equal(result.attempts.length, 1)
  assert.equal(channels.reduce((sum, item) => sum + item.remainingCount, 0), 2)
  return '三模板共享次数池同轮只成功发送一条'
}

function testTemplatePoolRejectFallsBackSameRound() {
  const channels = [
    { id: 'template_1', remainingCount: 2 },
    { id: 'template_2', remainingCount: 2 }
  ]
  const result = sendFromTemplatePool(channels, { template_1: 'reject43101', template_2: 'success' })
  assert.equal(result.sent, true)
  assert.equal(result.templateId, 'template_2')
  assert.equal(channels[0].rejected, true)
  assert.equal(channels[0].remainingCount, 0)
  assert.equal(channels[1].remainingCount, 1)
  return '首模板43101后同轮切换下一可用模板'
}

function testTemplatePoolAllRejectedStops() {
  const channels = [
    { id: 'template_1', remainingCount: 1 },
    { id: 'template_2', remainingCount: 1 },
    { id: 'template_3', remainingCount: 1 }
  ]
  const result = sendFromTemplatePool(channels, {
    template_1: 'reject43101',
    template_2: 'reject43101',
    template_3: 'reject43101'
  })
  assert.equal(result.sent, false)
  assert.equal(result.attempts.length, 3)
  assert.equal(channels.every(item => item.rejected && item.remainingCount === 0), true)
  return '全部模板拒收后停止并将各通道标记为待授权'
}

function testTemplatePoolTimeoutRefundsAndRetriesOnce() {
  const channels = [{ id: 'template_1', remainingCount: 2 }]
  const result = sendFromTemplatePool(channels, { template_1: ['timeout', 'success'] })
  assert.equal(result.sent, true)
  assert.equal(result.attempts.length, 2)
  assert.equal(channels[0].remainingCount, 1)
  return '临时失败退回次数并在同模板最多重试一次'
}

function getRequestableTemplateIds(reminderCount) {
  const capacity = Math.max(0, 99 - Number(reminderCount || 0))
  return SUBSCRIBE_TEMPLATE_IDS.slice(0, Math.min(3, capacity))
}

function testThreeTemplateAuthorizationCapacity() {
  assert.deepEqual(getRequestableTemplateIds(0), SUBSCRIBE_TEMPLATE_IDS)
  assert.deepEqual(getRequestableTemplateIds(96), SUBSCRIBE_TEMPLATE_IDS)
  assert.deepEqual(getRequestableTemplateIds(97), SUBSCRIBE_TEMPLATE_IDS.slice(0, 2))
  assert.deepEqual(getRequestableTemplateIds(98), SUBSCRIBE_TEMPLATE_IDS.slice(0, 1))
  assert.deepEqual(getRequestableTemplateIds(99), [])

  const acceptedAll = getRequestableTemplateIds(96).filter(() => true)
  const acceptedPartial = getRequestableTemplateIds(96).filter((_, index) => index !== 1)
  assert.equal(Math.min(99, 96 + acceptedAll.length), 99)
  assert.equal(Math.min(99, 96 + acceptedPartial.length), 98)
  assert.equal(Math.min(99, 96), 96)
  return '三个模板按剩余容量请求且按实际允许数量入账'
}

function testStaleSingleTemplateStatusCannotShrinkRequest() {
  const clientTemplates = SUBSCRIBE_TEMPLATE_IDS.map((templateId, index) => ({ templateId, label: `模板${index + 1}` }))
  const staleServerTemplates = [{ templateId: SUBSCRIBE_TEMPLATE_IDS[0], remainingCount: 4 }]
  const serverById = new Map(staleServerTemplates.map(item => [item.templateId, item]))
  const mergedClientTemplates = clientTemplates.map(template => ({
    ...template,
    ...(serverById.get(template.templateId) || {}),
    templateId: template.templateId
  }))
  assert.equal(mergedClientTemplates.length, 3)
  assert.deepEqual(mergedClientTemplates.map(item => item.templateId), SUBSCRIBE_TEMPLATE_IDS)

  const defaultSlots = SUBSCRIBE_TEMPLATE_IDS.map((templateId, index) => ({ key: `slot_${index}`, templateId }))
  const oldSingleTemplateJson = [{ key: 'slot_0', templateId: SUBSCRIBE_TEMPLATE_IDS[0] }]
  const mergedBackendTemplates = defaultSlots.map((slot, index) => oldSingleTemplateJson[index] || slot)
  assert.equal(mergedBackendTemplates.length, 3)
  assert.deepEqual(mergedBackendTemplates.map(item => item.templateId), SUBSCRIBE_TEMPLATE_IDS)
  return '旧单模板状态和环境配置不会再缩减三模板请求'
}

function buildTemplatePayload(mode, fields, itemName, merchantInfo, remainingCount) {
  if (mode === 'activity_progress') {
    const shortDate = String(merchantInfo.date || '').slice(5)
    const time = String(merchantInfo.currentTime || '').slice(0, 5)
    return {
      [fields.item]: itemName.slice(0, 20),
      [fields.time]: `${shortDate} ${time} · 第${merchantInfo.round}轮`.slice(0, 20),
      [fields.remark]: `剩余 ${remainingCount} 次提醒`.slice(0, 20)
    }
  }
  return {
    [fields.item]: itemName.slice(0, 20),
    [fields.time]: `${merchantInfo.date} ${merchantInfo.currentTime}`.trim(),
    [fields.remark]: `刷新啦，还剩${remainingCount}次提醒`.slice(0, 20)
  }
}

function testThreeTemplatePayloadMappings() {
  const merchantInfo = { date: '2026-08-11', currentTime: '08:03:00', round: 1 }
  const primary = buildTemplatePayload('product_arrival', { item: 'thing1', time: 'time5', remark: 'thing3' }, '钥匙镜子', merchantInfo, 7)
  const arrival = buildTemplatePayload('product_arrival', { item: 'thing1', time: 'time2', remark: 'thing3' }, '钥匙镜子', merchantInfo, 7)
  const activity = buildTemplatePayload('activity_progress', { item: 'thing1', time: 'thing2', remark: 'thing3' }, '钥匙镜子', merchantInfo, 7)
  assert.deepEqual(Object.keys(primary), ['thing1', 'time5', 'thing3'])
  assert.deepEqual(Object.keys(arrival), ['thing1', 'time2', 'thing3'])
  assert.deepEqual(activity, {
    thing1: '钥匙镜子',
    thing2: '08-11 08:03 · 第1轮',
    thing3: '剩余 7 次提醒'
  })
  return '三个模板字段映射正确且活动模板使用文本进度字段'
}

function testTemplatePoolFallsBackToActivity() {
  const channels = SUBSCRIBE_TEMPLATE_IDS.map(id => ({ id, remainingCount: 1 }))
  const result = sendFromTemplatePool(channels, {
    [SUBSCRIBE_TEMPLATE_IDS[0]]: 'reject43101',
    [SUBSCRIBE_TEMPLATE_IDS[1]]: 'reject43101',
    [SUBSCRIBE_TEMPLATE_IDS[2]]: 'success'
  })
  assert.equal(result.sent, true)
  assert.equal(result.templateId, SUBSCRIBE_TEMPLATE_IDS[2])
  assert.deepEqual(result.attempts.map(attempt => attempt.templateId), SUBSCRIBE_TEMPLATE_IDS)
  return '前两个模板拒收后同轮回退到活动进度提醒'
}

function isWeeklyFridayFirstRound(date, round) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    new Date(`${date}T12:00:00Z`).getUTCDay() === 5 &&
    Number(round) === 1
}

function testFixedHotOnlyFridayFirstRound() {
  assert.equal(isWeeklyFridayFirstRound('2026-06-12', 1), true)
  assert.equal(isWeeklyFridayFirstRound('2026-06-12', 2), false)
  assert.equal(isWeeklyFridayFirstRound('2026-06-13', 1), false)
  assert.equal(isWeeklyFridayFirstRound('2026-06-14', 1), false)
  return '钥匙镜子仅周五第一轮进入提醒候选'
}

function main() {
  const tests = [
    testTriggerWindowStartsAtFirstSuccessfulCollect,
    testTenthMinuteFallbackStartsOwnWindow,
    testThirdMinuteIgnoresEarlyHistoryWithoutTrustedJob,
    testLaterRetryUsesTrustedThirdMinuteCollection,
    testMissingThirdMinuteRetriesRemoteAtFifthMinute,
    testQueueScalesTo5000WithBatches,
    testRetryDeductsAgainButMaxTwoAttempts,
    testLastRecipientWaitsForNormalQueue,
    testLoadTestShadowAllSuccess1000,
    testLoadTestShadowTimeoutRetry1000,
    testLoadTestShadowReject1000,
    testLoadTestShadowStuckSending1000,
    testAllDayPrismOnlySendsOncePerFutureDay,
    testAllDayPrismAllowsJune14SecondRoundRepeat,
    testAllDayFilterKeepsOtherMatchedItems,
    testAllDayRemarkFitsTemplateLimit,
    testAdminSelectedItemOnlyTargetsEligibleFollowers,
    testAdminSelectedItemKeepsSameRoundIdempotent,
    testTemplatePoolSendsOnlyOnce,
    testTemplatePoolRejectFallsBackSameRound,
    testTemplatePoolAllRejectedStops,
    testTemplatePoolTimeoutRefundsAndRetriesOnce,
    testThreeTemplateAuthorizationCapacity,
    testStaleSingleTemplateStatusCannotShrinkRequest,
    testThreeTemplatePayloadMappings,
    testTemplatePoolFallsBackToActivity,
    testFixedHotOnlyFridayFirstRound
  ]

  tests.forEach(test => {
    console.log(`PASS ${test()}`)
  })
  console.log(`\n全部 ${tests.length} 个推送队列模拟测试通过。`)
}

main()
