const { matchProduct } = require('./products')
const { normalizeHistoryRecords } = require('./history-cache')

const ROUND_TEXT_BY_NUMBER = ['', '第一轮', '第二轮', '第三轮', '第四轮']

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function buildRoundKey(dateText, round) {
  return `${dateText}_round_${round}`
}

function getCurrentRoundKey(now = new Date()) {
  const hour = now.getHours()
  if (hour < 8) return ''
  const round = Math.floor((hour - 8) / 4) + 1
  return round >= 1 && round <= 4 ? buildRoundKey(formatDate(now), round) : ''
}

function getLastCompletedRoundKey(now = new Date()) {
  const hour = now.getHours()
  const dateText = formatDate(now)
  if (hour < 12) return buildRoundKey(formatDate(addDays(now, -1)), 4)
  if (hour < 16) return buildRoundKey(dateText, 1)
  if (hour < 20) return buildRoundKey(dateText, 2)
  return buildRoundKey(dateText, 3)
}

function getHistoryRefreshKey(now = new Date()) {
  const currentRoundKey = getCurrentRoundKey(now)
  if (currentRoundKey && now.getMinutes() >= 10) return currentRoundKey
  return getLastCompletedRoundKey(now)
}

function normalizeName(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function recordContainsProduct(record, product) {
  const targetId = String(product && product.product_id || '').trim()
  const targetNames = [product && product.title].concat(product && product.aliases || [])
    .map(normalizeName)
    .filter(Boolean)

  return (record.items || []).some(item => {
    if (targetId && String(item && item.product_id || '').trim() === targetId) return true
    const matched = matchProduct(item)
    if (targetId && !matched.is_unknown && matched.product_id === targetId) return true
    const itemName = normalizeName(item && (item.raw_name || item.name || item.title))
    return Boolean(itemName && targetNames.includes(itemName))
  })
}

function normalizeUniqueRecords(records) {
  return normalizeHistoryRecords(records)
}

function formatShortDate(dateText) {
  const parts = String(dateText || '').split('-')
  if (parts.length !== 3) return dateText || ''
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

function getWeekKey(dateText) {
  const parts = String(dateText || '').split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  return formatDate(date)
}

function isPrismBall(product) {
  return [product && product.title].concat(product && product.aliases || [])
    .map(normalizeName)
    .includes('棱镜球')
}

function getOccurrenceKey(record, saleGroup, product) {
  if (saleGroup === 'daily-hot' || isPrismBall(product)) return record.date
  if (saleGroup === 'fixed-hot') return getWeekKey(record.date)
  return record.roundKey
}

function countOccurrences(records, saleGroup, product, startDate) {
  return new Set(records
    .filter(record => record.date >= startDate)
    .map(record => getOccurrenceKey(record, saleGroup, product)))
    .size
}

function buildProductHistoryStats(product, records, options = {}) {
  const now = options.now || new Date()
  const today = formatDate(now)
  const sevenDayStart = formatDate(addDays(now, -6))
  const thirtyDayStart = formatDate(addDays(now, -29))
  const currentRoundKey = options.currentRoundKey === undefined
    ? getCurrentRoundKey(now)
    : options.currentRoundKey
  const saleGroup = options.saleGroup || 'normal'
  const occurrences = normalizeUniqueRecords(records)
    .filter(record => record.date <= today && recordContainsProduct(record, product))
    .sort((a, b) => String(b.roundKey).localeCompare(String(a.roundKey)))
  const lastSeen = occurrences.find(record => record.roundKey !== currentRoundKey)
  const sevenDayCount = countOccurrences(occurrences, saleGroup, product, sevenDayStart)
  const thirtyDayCount = countOccurrences(occurrences, saleGroup, product, thirtyDayStart)

  return {
    lastSeenDateText: lastSeen ? formatShortDate(lastSeen.date) : '暂无记录',
    lastSeenRoundText: lastSeen ? (ROUND_TEXT_BY_NUMBER[lastSeen.round] || `第${lastSeen.round}轮`) : '',
    sevenDayCount,
    sevenDayCountText: `${sevenDayCount}次`,
    thirtyDayCount,
    thirtyDayCountText: `${thirtyDayCount}次`
  }
}

function getLatestRecordRoundKey(records) {
  return normalizeUniqueRecords(records)
    .map(record => record.roundKey)
    .filter(Boolean)
    .sort()
    .pop() || ''
}

function buildSeasonRateRows(product, saleGroup) {
  if (saleGroup !== 'normal') return []
  return [
    { key: 'current', label: '本赛季到目前出现频率', value: product && product.appear_rate_current_season },
    { key: 's2', label: 'S2出现频率', value: product && product.appear_rate_last_season },
    { key: 's1', label: 'S1出现频率', value: product && product.appear_rate_s1 }
  ].filter(item => item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value)))
    .map(item => ({
      ...item,
      valueText: `${Number(item.value).toFixed(1)}%`
    }))
}

function buildProductDetailHistoryStats(product, records, options = {}) {
  const currentRoundKey = options.currentRoundKey === undefined
    ? getCurrentRoundKey(options.now || new Date())
    : options.currentRoundKey
  const localStats = buildProductHistoryStats(product, records, options)
  const snapshotRoundKey = String(product && product.stats_updated_round_key || '')
  const latestLocalRoundKey = getLatestRecordRoundKey(records)
  const canUseRollingSnapshot = Boolean(
    product && product.has_rolling_stats && snapshotRoundKey &&
    (!latestLocalRoundKey || snapshotRoundKey >= latestLocalRoundKey)
  )
  let result = localStats

  if (canUseRollingSnapshot) {
    const lastSeen = (product.last_occurrences || []).find(item => {
      return String(item.round_key || item.roundKey || '') !== currentRoundKey
    })
    const sevenDayCount = Math.max(0, Number(product.appear_count_7d || 0))
    const thirtyDayCount = Math.max(0, Number(product.appear_count_30d || 0))
    result = {
      lastSeenDateText: lastSeen ? formatShortDate(lastSeen.date) : '暂无记录',
      lastSeenRoundText: lastSeen ? (ROUND_TEXT_BY_NUMBER[Number(lastSeen.round)] || `第${lastSeen.round}轮`) : '',
      sevenDayCount,
      sevenDayCountText: `${sevenDayCount}次`,
      thirtyDayCount,
      thirtyDayCountText: `${thirtyDayCount}次`
    }
  }

  const seasonRateRows = buildSeasonRateRows(product, options.saleGroup || 'normal')
  const seasonRateScopeLabel = String(product && product.season_rate_scope_label || '')
  return {
    ...result,
    seasonRateRows,
    showSeasonRates: seasonRateRows.length > 0,
    seasonRateTitle: seasonRateScopeLabel
      ? `赛季出现频率（${seasonRateScopeLabel}）`
      : '赛季出现频率',
    showS1DataNote: seasonRateRows.some(item => item.key === 's1')
  }
}

module.exports = {
  buildProductDetailHistoryStats,
  buildProductHistoryStats,
  buildRoundKey,
  getCurrentRoundKey,
  getHistoryRefreshKey,
  getLastCompletedRoundKey,
  normalizeUniqueRecords
}
