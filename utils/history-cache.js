const HISTORY_CACHE_KEY = 'merchant_history_cache_v7'
const HISTORY_SYNC_STATE_KEY = 'merchant_history_sync_state_v1'

const DEFAULT_METADATA = {
  checkedUntilRoundKey: '',
  currentRoundKey: '',
  includedCurrentRoundKey: '',
  backfillBeforeRoundKey: '',
  backfillMonth: '',
  backfillComplete: false,
  lastSuccessfulRoundKey: '',
  lastAttemptRoundKey: '',
  lastAttemptAt: 0,
  backfillAttemptMonth: '',
  backfillAttemptAt: 0,
  updatedAt: 0
}

function buildRoundKey(date, round) {
  return `${date}_round_${round}`
}

function parseRecordIdentity(record = {}) {
  const rawRoundKey = String(record.roundKey || record._id || '').trim()
  const match = rawRoundKey.match(/^(\d{4}-\d{2}-\d{2})_round_([1-4])$/)
  const date = String(record.date || (match && match[1]) || '').trim()
  const round = Number(record.round || (match && match[2]) || 0)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || round < 1 || round > 4) return null
  return { date, round, roundKey: buildRoundKey(date, round) }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeHistoryItem(item = {}) {
  const next = { ...item }
  ;[
    'allDayLabel',
    'canPrismShare',
    'hasImage',
    'historyDate',
    'historyDateText',
    'historyRound',
    'historyRoundKey',
    'historyRoundText',
    'limitBadgeText',
    'priceBadgeText'
  ].forEach(key => delete next[key])
  return next
}

function normalizeHistoryItems(items) {
  const seen = new Set()
  return (Array.isArray(items) ? items : []).map(normalizeHistoryItem).filter(item => {
    const key = stableStringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeHistoryRecord(record = {}) {
  const identity = parseRecordIdentity(record)
  if (!identity) return null
  return {
    roundKey: identity.roundKey,
    date: identity.date,
    round: identity.round,
    timeRange: record.timeRange || '',
    status: record.status || 'active',
    items: normalizeHistoryItems(record.items),
    source: record.source || '',
    fetchedAt: record.fetchedAt || record.capturedAt || '',
    voteSummary: record.voteSummary || null
  }
}

function sortHistoryRecords(records) {
  return (records || []).slice().sort((a, b) => String(b.roundKey).localeCompare(String(a.roundKey)))
}

function normalizeHistoryRecords(records) {
  const byRoundKey = new Map()
  ;(records || []).forEach(record => {
    const normalized = normalizeHistoryRecord(record)
    if (normalized) byRoundKey.set(normalized.roundKey, normalized)
  })
  return sortHistoryRecords(Array.from(byRoundKey.values()))
}

function normalizeMetadata(cache = {}) {
  return {
    checkedUntilRoundKey: cache.checkedUntilRoundKey || '',
    currentRoundKey: cache.currentRoundKey || '',
    includedCurrentRoundKey: cache.includedCurrentRoundKey || '',
    backfillBeforeRoundKey: cache.backfillBeforeRoundKey || '',
    backfillMonth: cache.backfillMonth || '',
    backfillComplete: cache.backfillComplete === true,
    lastSuccessfulRoundKey: cache.lastSuccessfulRoundKey || '',
    lastAttemptRoundKey: cache.lastAttemptRoundKey || '',
    lastAttemptAt: Number(cache.lastAttemptAt || 0),
    backfillAttemptMonth: cache.backfillAttemptMonth || '',
    backfillAttemptAt: Number(cache.backfillAttemptAt || 0),
    updatedAt: Number(cache.updatedAt || 0)
  }
}

function readHistoryCache() {
  let cache = null
  let syncState = null
  try {
    cache = wx.getStorageSync(HISTORY_CACHE_KEY)
    syncState = wx.getStorageSync(HISTORY_SYNC_STATE_KEY)
  } catch (error) {}
  if (!cache || typeof cache !== 'object') {
    return {
      records: [],
      metadata: normalizeMetadata(syncState && typeof syncState === 'object' ? syncState : DEFAULT_METADATA)
    }
  }
  return {
    records: normalizeHistoryRecords(cache.records),
    metadata: normalizeMetadata({
      ...cache,
      ...(syncState && typeof syncState === 'object' ? syncState : {})
    })
  }
}

function writeHistorySyncState(metadata = {}) {
  const state = {
    lastSuccessfulRoundKey: metadata.lastSuccessfulRoundKey || '',
    lastAttemptRoundKey: metadata.lastAttemptRoundKey || '',
    lastAttemptAt: Number(metadata.lastAttemptAt || 0),
    backfillAttemptMonth: metadata.backfillAttemptMonth || '',
    backfillAttemptAt: Number(metadata.backfillAttemptAt || 0)
  }
  wx.setStorageSync(HISTORY_SYNC_STATE_KEY, state)
  return state
}

function writeHistoryCache(records, metadata = {}) {
  const normalizedRecords = normalizeHistoryRecords(records)
  const normalizedMetadata = {
    ...DEFAULT_METADATA,
    ...normalizeMetadata(metadata),
    updatedAt: Date.now()
  }
  wx.setStorageSync(HISTORY_CACHE_KEY, {
    records: normalizedRecords,
    ...normalizedMetadata
  })
  writeHistorySyncState(normalizedMetadata)
  return { records: normalizedRecords, metadata: normalizedMetadata }
}

function mergeHistoryRecords(existingRecords, nextRecords) {
  const recordByRoundKey = new Map(normalizeHistoryRecords(existingRecords).map(record => [record.roundKey, record]))
  const changedRoundKeys = []
  const changedDates = new Set()

  ;(nextRecords || []).forEach(record => {
    const normalized = normalizeHistoryRecord(record)
    if (!normalized) return
    const previous = recordByRoundKey.get(normalized.roundKey)
    if (previous && stableStringify(previous) === stableStringify(normalized)) return
    recordByRoundKey.set(normalized.roundKey, normalized)
    changedRoundKeys.push(normalized.roundKey)
    changedDates.add(normalized.date)
  })

  return {
    records: sortHistoryRecords(Array.from(recordByRoundKey.values())),
    changed: changedRoundKeys.length > 0,
    changedRoundKeys,
    changedDates: Array.from(changedDates).sort()
  }
}

module.exports = {
  HISTORY_CACHE_KEY,
  HISTORY_SYNC_STATE_KEY,
  mergeHistoryRecords,
  normalizeHistoryRecord,
  normalizeHistoryRecords,
  readHistoryCache,
  writeHistoryCache,
  writeHistorySyncState
}
