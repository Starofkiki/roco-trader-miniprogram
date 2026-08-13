const SEASONS = [
  { id: 'season_s1', key: 's1', startDate: '2026-03-26', endDate: '2026-05-20', isFinal: true },
  { id: 'season_s2', key: 's2', startDate: '2026-05-21', endDate: '2026-07-15', isFinal: true },
  { id: 'season_s3', key: 's3', startDate: '2026-07-16', endDate: '2026-09-10', isFinal: false }
]
const AGGREGATE_RATE_CATEGORIES = ['矿石', '粉尘', '血脉秘药']
const INDIVIDUAL_BLOODLINE_PRODUCTS = ['奇异血脉秘药', '首领血脉秘药']

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(dateText, days) {
  const parts = String(dateText || '').split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  date.setDate(date.getDate() + days)
  return formatDate(date)
}

function normalizeName(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function getSeasonRateScope(product = {}) {
  const category = String(product.category || '')
  const title = normalizeName(product.title)
  const isIndividualBloodline = category === '血脉秘药' &&
    INDIVIDUAL_BLOODLINE_PRODUCTS.some(name => normalizeName(name) === title)
  if (AGGREGATE_RATE_CATEGORIES.includes(category) && !isIndividualBloodline) {
    return { type: 'group', key: category, label: category }
  }
  return { type: 'product', key: String(product.product_id || ''), label: '' }
}

function getRoundKey(record) {
  if (record && record.roundKey) return String(record.roundKey)
  if (record && record.date && record.round) return `${record.date}_round_${record.round}`
  return ''
}

function normalizeRecords(records) {
  const byRoundKey = new Map()
  ;(records || []).forEach(record => {
    const roundKey = getRoundKey(record)
    if (!roundKey || !record.date || !record.round) return
    const previous = byRoundKey.get(roundKey)
    byRoundKey.set(roundKey, {
      ...previous,
      ...record,
      roundKey,
      items: (previous && previous.items || []).concat(record.items || [])
    })
  })
  return Array.from(byRoundKey.values()).sort((a, b) => String(a.roundKey).localeCompare(String(b.roundKey)))
}

function getWeekKey(dateText) {
  const parts = String(dateText || '').split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  return formatDate(date)
}

function getOccurrenceKey(record, product) {
  if (product.sale_group === 'daily-hot' || normalizeName(product.title) === '棱镜球') {
    return record.date
  }
  if (product.sale_group === 'fixed-hot') return getWeekKey(record.date)
  return record.roundKey
}

function getResolvedProducts(record, resolveProduct) {
  const byProductId = new Map()
  ;(record.items || []).forEach(item => {
    const product = resolveProduct(item)
    if (!product || !product.product_id || !product.sale_group) return
    if (!byProductId.has(product.product_id)) byProductId.set(product.product_id, product)
  })
  return Array.from(byProductId.values())
}

function sortOccurrences(occurrences) {
  return (occurrences || []).slice().sort((a, b) => String(b.round_key).localeCompare(String(a.round_key)))
}

function buildRollingSnapshot(records, resolveProduct) {
  const normalizedRecords = normalizeRecords(records)
  const latestRecord = normalizedRecords[normalizedRecords.length - 1] || null
  const asOfDate = latestRecord ? latestRecord.date : ''
  const sevenDayStart = asOfDate ? addDays(asOfDate, -6) : ''
  const thirtyDayStart = asOfDate ? addDays(asOfDate, -29) : ''
  const states = new Map()

  normalizedRecords.forEach(record => {
    getResolvedProducts(record, resolveProduct).forEach(product => {
      const state = states.get(product.product_id) || {
        occurrenceRecords: [],
        lastOccurrences: []
      }
      state.occurrenceRecords.push({
        date: record.date,
        key: getOccurrenceKey(record, product)
      })
      state.lastOccurrences.push({
        date: record.date,
        round: Number(record.round),
        round_key: record.roundKey
      })
      states.set(product.product_id, state)
    })
  })

  const products = {}
  states.forEach((state, productId) => {
    const countSince = startDate => new Set(state.occurrenceRecords
      .filter(item => !startDate || item.date >= startDate)
      .map(item => item.key)).size
    products[productId] = {
      appear_count_7d: countSince(sevenDayStart),
      appear_count_30d: countSince(thirtyDayStart),
      last_occurrences: sortOccurrences(state.lastOccurrences).slice(0, 2)
    }
  })

  return {
    schema_version: 1,
    snapshot_type: 'rolling',
    as_of_date: asOfDate,
    updated_round_key: latestRecord ? latestRecord.roundKey : '',
    source_record_count: normalizedRecords.length,
    products
  }
}

function mergeRollingSnapshot(previous, current) {
  const previousProducts = previous && previous.products || {}
  const currentProducts = current && current.products || {}
  const productIds = new Set(Object.keys(previousProducts).concat(Object.keys(currentProducts)))
  const products = {}

  productIds.forEach(productId => {
    const previousStats = previousProducts[productId] || {}
    const currentStats = currentProducts[productId] || {}
    const occurrences = new Map()
    ;(currentStats.last_occurrences || []).concat(previousStats.last_occurrences || []).forEach(item => {
      if (item && item.round_key && !occurrences.has(item.round_key)) occurrences.set(item.round_key, item)
    })
    products[productId] = {
      appear_count_7d: Number(currentStats.appear_count_7d || 0),
      appear_count_30d: Number(currentStats.appear_count_30d || 0),
      last_occurrences: sortOccurrences(Array.from(occurrences.values())).slice(0, 2)
    }
  })

  return {
    ...current,
    products
  }
}

function roundRate(value) {
  return Math.round(value * 10) / 10
}

function buildSeasonSnapshot(season, records, resolveProduct, options = {}) {
  const normalizedRecords = normalizeRecords(records)
    .filter(record => record.date >= season.startDate && record.date <= season.endDate)
  const occurrenceKeys = new Map()
  const resolvedProducts = new Map()

  normalizedRecords.forEach(record => {
    getResolvedProducts(record, resolveProduct)
      .filter(product => product.sale_group === 'normal')
      .forEach(product => {
        resolvedProducts.set(product.product_id, product)
        const keys = occurrenceKeys.get(product.product_id) || new Set()
        keys.add(getOccurrenceKey(record, product))
        occurrenceKeys.set(product.product_id, keys)
      })
  })

  const counts = {}
  occurrenceKeys.forEach((keys, productId) => {
    counts[productId] = keys.size
  })
  Object.entries(options.countOverrides || {}).forEach(([productId, count]) => {
    counts[productId] = Math.max(0, Number(count || 0))
  })

  const totalNormalOccurrences = Object.values(counts).reduce((total, count) => total + Number(count || 0), 0)
  const products = {}
  Object.entries(counts).forEach(([productId, count]) => {
    products[productId] = {
      occurrence_count: count,
      appear_rate: totalNormalOccurrences > 0 ? roundRate(count / totalNormalOccurrences * 100) : null
    }
  })
  const groups = {}
  AGGREGATE_RATE_CATEGORIES.forEach(category => {
    const occurrenceCount = Object.entries(counts).reduce((total, [productId, count]) => {
      const product = resolvedProducts.get(productId)
      return product && product.category === category ? total + Number(count || 0) : total
    }, 0)
    groups[category] = {
      occurrence_count: occurrenceCount,
      appear_rate: totalNormalOccurrences > 0
        ? roundRate(occurrenceCount / totalNormalOccurrences * 100)
        : null
    }
  })
  const latestRecord = normalizedRecords[normalizedRecords.length - 1] || null

  return {
    schema_version: 2,
    snapshot_type: 'season',
    season_key: season.key,
    start_date: season.startDate,
    end_date: season.endDate,
    is_final: season.isFinal === true,
    updated_round_key: latestRecord ? latestRecord.roundKey : '',
    source_record_count: normalizedRecords.length,
    total_normal_occurrences: totalNormalOccurrences,
    manual_corrections: options.manualCorrections || {},
    products,
    groups
  }
}

function getSeasonMonths(season) {
  const months = []
  const [startYear, startMonth] = season.startDate.split('-').map(Number)
  const [endYear, endMonth] = season.endDate.split('-').map(Number)
  const cursor = new Date(startYear, startMonth - 1, 1)
  const end = new Date(endYear, endMonth - 1, 1)
  while (cursor <= end) {
    months.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`)
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}

module.exports = {
  AGGREGATE_RATE_CATEGORIES,
  SEASONS,
  buildRollingSnapshot,
  buildSeasonSnapshot,
  getSeasonMonths,
  getSeasonRateScope,
  mergeRollingSnapshot,
  normalizeRecords
}
