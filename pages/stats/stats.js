const { callCloudApi } = require('../../utils/cloud-api')
const { SALE_GROUPS, attachGoodsMeta, getGoodsImage } = require('../../utils/goods-info')
const {
  advanceProductImage,
  getAllProducts,
  getCatalogVersion,
  getFollowItems,
  loadProductCatalog,
  loadProductStatsSnapshots,
  matchProduct
} = require('../../utils/products')
const {
  mergeHistoryRecords,
  normalizeHistoryRecords,
  readHistoryCache,
  writeHistoryCache,
  writeHistorySyncState
} = require('../../utils/history-cache')
const {
  ensureProductImageCached,
  getCachedProductImage,
  getProductImageSource,
  invalidateProductImageCache
} = require('../../utils/product-image-cache')
const app = typeof getApp === 'function' ? getApp() : { globalData: {} }
const PRODUCT_GROUP_ORDER = ['重点商品', '精灵蛋', '养成材料', '咕噜球', '血脉秘药', '矿石', '粉尘']
const WEEKDAY_TEXTS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const CALENDAR_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const ROUND_VOTE_IMAGE_BY_KEY = {
  amazing: '/assets/feedback/merchant-amazing-reference-small.png',
  great: '/assets/feedback/merchant-good.png',
  good: '/assets/feedback/merchant-not-bad.png',
  normal: '/assets/feedback/merchant-average.png'
}
const ROUND_VOTE_OPTIONS = [
  { key: 'amazing', label: '了不起', image: ROUND_VOTE_IMAGE_BY_KEY.amazing },
  { key: 'great', label: '相当好', image: ROUND_VOTE_IMAGE_BY_KEY.great },
  { key: 'good', label: '还不错', image: ROUND_VOTE_IMAGE_BY_KEY.good },
  { key: 'normal', label: '一般般', image: ROUND_VOTE_IMAGE_BY_KEY.normal }
]
const VOTE_SHARE_CANVAS_ID = 'voteShareCanvas'
const VOTE_SHARE_POSTER_WIDTH = 750
const VOTE_SHARE_POSTER_HEIGHT = 1000
const VOTE_SHARE_POSTER_TIMEOUT_MS = 8000
const SHARE_GOODS_IMAGE_CACHE_KEY = 'share_goods_image_cache_v1'
const PRISM_BALL_NAME = '棱镜球'
const PRISM_SHARE_HERO_IMAGE = 'cloud://cloud1-d7ga0y9wyc4ee559d.636c-cloud1-d7ga0y9wyc4ee559d-1427743983/share-assets/prism-merchant-hero.png'
const HISTORY_SYNC_RETRY_MS = 2 * 60 * 1000
const HISTORY_BACKFILL_RETRY_MS = 30 * 60 * 1000
const CURRENT_VOTE_REFRESH_MS = 5 * 60 * 1000
const HISTORY_REFRESH_BOUNDARIES = [
  { hour: 8, minute: 3 },
  { hour: 8, minute: 5 },
  { hour: 8, minute: 10 },
  { hour: 12, minute: 3 },
  { hour: 12, minute: 5 },
  { hour: 12, minute: 10 },
  { hour: 16, minute: 3 },
  { hour: 16, minute: 5 },
  { hour: 16, minute: 10 },
  { hour: 20, minute: 3 },
  { hour: 20, minute: 5 },
  { hour: 20, minute: 10 }
]

function pad(num) {
  return String(num).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function dateFromText(dateText) {
  const parts = String(dateText || '').split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function buildRoundKey(dateText, round) {
  return `${dateText}_round_${round}`
}

function parseRoundKey(roundKey) {
  const match = String(roundKey || '').match(/^(\d{4}-\d{2}-\d{2})_round_([1-4])$/)
  return match ? { date: match[1], round: Number(match[2]) } : null
}

function compareRoundKey(a, b) {
  const left = parseRoundKey(a)
  const right = parseRoundKey(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  const dateCompare = left.date.localeCompare(right.date)
  if (dateCompare !== 0) return dateCompare
  return left.round - right.round
}

function getLastCompletedRoundKey(now = new Date()) {
  const hour = now.getHours()
  const dateText = formatDate(now)

  if (hour < 8) {
    return buildRoundKey(formatDate(addDays(now, -1)), 4)
  }
  if (hour < 12) {
    return buildRoundKey(formatDate(addDays(now, -1)), 4)
  }
  if (hour < 16) {
    return buildRoundKey(dateText, 1)
  }
  if (hour < 20) {
    return buildRoundKey(dateText, 2)
  }
  return buildRoundKey(dateText, 3)
}

function getCurrentRoundKey(now = new Date()) {
  const hour = now.getHours()
  if (hour < 8) return ''
  const round = Math.floor((hour - 8) / 4) + 1
  return round >= 1 && round <= 4 ? buildRoundKey(formatDate(now), round) : ''
}

function getNextHistoryRefreshAt(now = new Date()) {
  const candidates = HISTORY_REFRESH_BOUNDARIES.map(boundary => {
    const candidate = new Date(now)
    candidate.setHours(boundary.hour, boundary.minute, 1, 0)
    return candidate
  })
  const nextToday = candidates.find(candidate => candidate > now)
  if (nextToday) return nextToday

  const tomorrow = addDays(now, 1)
  tomorrow.setHours(HISTORY_REFRESH_BOUNDARIES[0].hour, HISTORY_REFRESH_BOUNDARIES[0].minute, 1, 0)
  return tomorrow
}

function formatDateText(dateText) {
  const parts = String(dateText || '').split('-')
  if (parts.length !== 3) return dateText || ''
  return `${Number(parts[0])}年${Number(parts[1])}月${Number(parts[2])}日`
}

function formatMonthText(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`
}

function getWeekdayText(dateText) {
  return WEEKDAY_TEXTS[dateFromText(dateText).getDay()]
}

function normalizeRoundVoteSummary(summary) {
  const total = Number(summary && summary.total || 0)
  if (!summary || !total) return null
  const topChoice = summary.topChoice || {}
  const optionMap = {}
  ;(summary.options || []).forEach(option => {
    if (option && option.key) optionMap[option.key] = option
  })
  const options = ROUND_VOTE_OPTIONS.map(option => {
    const item = optionMap[option.key] || {}
    return {
      ...option,
      count: Number(item.count || 0),
      percent: Number(item.percent || 0)
    }
  })
  const fallbackTopChoice = options.slice().sort((a, b) => b.count - a.count)[0]
  const topOption = options.find(option => option.key === topChoice.key)
  const normalizedTopChoice = topChoice.key
    ? { ...(topOption || {}), ...topChoice }
    : fallbackTopChoice
  const normalizedOptions = options.map(option => ({
    ...option,
    isTop: normalizedTopChoice.key === option.key
  }))

  return {
    total,
    topChoice: normalizedTopChoice,
    topKey: normalizedTopChoice.key || '',
    topLabel: normalizedTopChoice.label || '',
    topPercent: Number(normalizedTopChoice.percent || 0),
    topImage: ROUND_VOTE_IMAGE_BY_KEY[normalizedTopChoice.key] || '',
    options: normalizedOptions
  }
}

function normalizeCanvasImageSrc(src) {
  if (!src) return ''
  if (/^(https?:|wxfile:|cloud:)/.test(src)) return src
  if (src.startsWith('/')) return `../..${src}`
  return `../../${src.replace(/^\.?\//, '')}`
}

function getCanvasImageCandidates(src) {
  const imageSrc = normalizeCanvasImageSrc(src)
  if (!imageSrc) return []
  const candidates = [imageSrc]
  if (/^https?:/.test(imageSrc)) {
    const encodedSrc = encodeURI(imageSrc)
    if (encodedSrc !== imageSrc) candidates.push(encodedSrc)
  }
  return candidates
}

function buildPosterProductImageItems(products) {
  return (products || [])
    .map(product => ({
      name: product.name || '',
      image: product.image || ''
    }))
    .filter(item => item.name && /^https:\/\//.test(item.image))
}

function readShareGoodsImageCache() {
  const cache = wx.getStorageSync(SHARE_GOODS_IMAGE_CACHE_KEY)
  return cache && typeof cache === 'object' ? cache : {}
}

function writeShareGoodsImageCache(cache) {
  wx.setStorageSync(SHARE_GOODS_IMAGE_CACHE_KEY, cache || {})
}

function sortHistoryRecords(records) {
  return (records || []).slice().sort((a, b) => {
    const dateCompare = String(b.date).localeCompare(String(a.date))
    if (dateCompare !== 0) return dateCompare
    return Number(b.round || 0) - Number(a.round || 0)
  })
}

function filterVisibleHistoryRecords(records, lastCompletedRoundKey, includedCurrentRoundKey = '') {
  return sortHistoryRecords(records)
    .filter(record => {
      if (!record.roundKey) return false
      return compareRoundKey(record.roundKey, lastCompletedRoundKey) <= 0 ||
        record.roundKey === includedCurrentRoundKey
    })
}

function getLatestRecordRoundKey(records) {
  return records && records[0] && records[0].roundKey ? records[0].roundKey : ''
}

function hasHistoryRound(records, roundKey) {
  return (records || []).some(record => record && record.roundKey === roundKey)
}

function getOldestRecordRoundKey(records) {
  return records && records.length && records[records.length - 1].roundKey
    ? records[records.length - 1].roundKey
    : ''
}

function getPreviousMonth(monthText) {
  const match = String(monthText || '').match(/^(\d{4})-(\d{2})$/)
  if (!match) return ''

  const date = new Date(Number(match[1]), Number(match[2]) - 2, 1)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

function getOldestRecordMonth(records) {
  const oldest = records && records.length ? records[records.length - 1] : null
  return oldest && oldest.date ? String(oldest.date).slice(0, 7) : ''
}

function getNextBackfillMonth(records) {
  return getOldestRecordMonth(records)
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

function formatHistoryProduct(product, index) {
  const enriched = attachGoodsMeta(product)
  const productInfo = matchProduct(enriched)
  const image = enriched.image || productInfo.image || product.image || product.icon_url || ''
  const name = productInfo.is_unknown ? enriched.name : productInfo.title

  return {
    product_id: productInfo.product_id || enriched.product_id || '',
    raw_name: enriched.raw_name || enriched.name || '',
    name,
    id: enriched.id || `${name || 'item'}_${index}`,
    image,
    icon: enriched.icon || (name ? name.slice(0, 1) : ''),
    saleGroup: enriched.saleGroup || SALE_GROUPS.normal
  }
}

function getRareCalendarIcons(products) {
  const seen = new Set()
  return products.map(product => {
    const productInfo = matchProduct(product)
    if (productInfo.is_unknown || productInfo.rarity !== 'rare' || seen.has(productInfo.product_id)) return null
    seen.add(productInfo.product_id)
    return {
      key: productInfo.product_id,
      image: productInfo.image || product.image || getGoodsImage(productInfo.title)
    }
  }).filter(item => item && item.image)
}

function isRareProduct(product) {
  const productInfo = matchProduct(product)
  return !productInfo.is_unknown && productInfo.rarity === 'rare'
}

function isPrismBallProduct(product) {
  return isKeywordMatched(product && product.name, PRISM_BALL_NAME)
}

function isAllDayHistoryProduct(product) {
  return getFollowItems().filter(item => item.all_day).some(item => {
    return item.keywords.some(keyword => isKeywordMatched(product.name, keyword))
  })
}

function isHistoryHotProduct(product) {
  return product.saleGroup === SALE_GROUPS.fixedHot ||
    product.saleGroup === SALE_GROUPS.dailyHot
}

function addUniqueProduct(list, map, product) {
  const key = normalizeMatchText(product.name)
  if (!key || map[key]) return
  map[key] = true
  list.push({
    ...product,
    allDayLabel: isAllDayHistoryProduct(product) ? '持续一天' : ''
  })
}

function createDayHistory(dateText) {
  return {
    date: dateText,
    dateText: formatDateText(dateText),
    weekdayText: getWeekdayText(dateText),
    rareItems: [],
    rareItemMap: {},
    hotItems: [],
    hotItemMap: {},
    rounds: [1, 2, 3, 4].map(round => ({
      round,
      roundText: `第${round}轮`,
      voteSummary: null,
      normalItems: []
    })),
    normalRoundCount: 0
  }
}

function buildHistoryDay(records, dateText) {
  const day = createDayHistory(dateText)
  ;(records || []).slice().sort((a, b) => Number(a.round || 0) - Number(b.round || 0)).forEach(record => {
    const round = day.rounds.find(item => item.round === Number(record.round))
    if (round) {
      round.voteSummary = normalizeRoundVoteSummary(record.voteSummary)
      round.roundKey = record.roundKey
    }

    ;(record.items || []).forEach((item, index) => {
      const product = {
        ...formatHistoryProduct(item, index),
        historyDate: record.date,
        historyDateText: formatDateText(record.date),
        historyRound: Number(record.round || 0),
        historyRoundText: `第${record.round}轮`,
        historyRoundKey: record.roundKey || `${record.date}_round_${record.round}`
      }
      product.canPrismShare = isPrismBallProduct(product)

      if (isRareProduct(product)) {
        addUniqueProduct(day.rareItems, day.rareItemMap, product)
      } else if (isHistoryHotProduct(product)) {
        addUniqueProduct(day.hotItems, day.hotItemMap, product)
      }

      if (round && !isHistoryHotProduct(product) && !isAllDayHistoryProduct(product)) {
        round.normalItems.push(product)
      }
    })
  })

  const visibleRounds = day.rounds.filter(round => round.normalItems.length > 0)
  return {
    date: day.date,
    dateText: day.dateText,
    weekdayText: day.weekdayText,
    rareItems: day.rareItems,
    hotItems: day.hotItems,
    rounds: visibleRounds,
    normalRoundCount: visibleRounds.length,
    totalItemCount: day.rareItems.length + day.hotItems.length + visibleRounds.reduce((total, round) => total + round.normalItems.length, 0)
  }
}

function buildCalendarWeeks(monthDate, dayMap, selectedDate) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const firstDay = new Date(year, month, 1)
  const startOffset = (firstDay.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const weekCount = Math.max(5, Math.ceil((startOffset + daysInMonth) / 7))
  const cursor = addDays(firstDay, -startOffset)
  const weeks = []

  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    const week = []
    week.weekKey = `${year}-${month + 1}-${weekIndex}`
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(cursor, weekIndex * 7 + dayIndex)
      const dateText = formatDate(date)
      const historyDay = dayMap[dateText]

      week.push({
        date: dateText,
        day: date.getDate(),
        isCurrentMonth: date.getMonth() === month,
        hasData: Boolean(historyDay),
        isSelected: dateText === selectedDate,
        rareIcons: historyDay ? historyDay.rareIcons.slice(0, 4) : []
      })
    }
    weeks.push(week)
  }

  return weeks
}

function buildHistoryViewCache(records) {
  const normalizedRecords = normalizeHistoryRecords(records)
  const recordByRoundKey = {}
  const recordsByDate = {}
  normalizedRecords.forEach(record => {
    recordByRoundKey[record.roundKey] = record
    if (!recordsByDate[record.date]) recordsByDate[record.date] = []
    recordsByDate[record.date].push(record)
  })
  const availableDates = Object.keys(recordsByDate).sort().reverse()
  return {
    records: normalizedRecords,
    recordByRoundKey,
    recordsByDate,
    availableDates,
    availableMonths: Array.from(new Set(availableDates.map(date => date.slice(0, 7)))).sort(),
    dayViewCache: {},
    monthDayMapCache: {}
  }
}

function updateHistoryViewCache(viewCache, records, changedDates) {
  if (!viewCache || !Array.isArray(changedDates) || !changedDates.length) {
    return buildHistoryViewCache(records)
  }
  const normalizedRecords = normalizeHistoryRecords(records)
  const changedDateSet = new Set(changedDates)
  viewCache.records = normalizedRecords
  viewCache.recordByRoundKey = {}
  changedDates.forEach(date => {
    delete viewCache.recordsByDate[date]
    delete viewCache.dayViewCache[date]
    delete viewCache.monthDayMapCache[date.slice(0, 7)]
  })
  normalizedRecords.forEach(record => {
    viewCache.recordByRoundKey[record.roundKey] = record
    if (!changedDateSet.has(record.date)) return
    if (!viewCache.recordsByDate[record.date]) viewCache.recordsByDate[record.date] = []
    viewCache.recordsByDate[record.date].push(record)
  })
  viewCache.availableDates = Object.keys(viewCache.recordsByDate).sort().reverse()
  viewCache.availableMonths = Array.from(new Set(viewCache.availableDates.map(date => date.slice(0, 7)))).sort()
  return viewCache
}

function getHistoryDayView(viewCache, dateText) {
  if (!dateText || !viewCache.recordsByDate[dateText]) return null
  if (!viewCache.dayViewCache[dateText]) {
    viewCache.dayViewCache[dateText] = buildHistoryDay(viewCache.recordsByDate[dateText], dateText)
  }
  return viewCache.dayViewCache[dateText]
}

function getMonthDayMap(viewCache, monthText) {
  if (viewCache.monthDayMapCache[monthText]) return viewCache.monthDayMapCache[monthText]
  const dayMap = {}
  ;(viewCache.availableDates || []).forEach(date => {
    if (date.slice(0, 7) !== monthText) return
    const records = viewCache.recordsByDate[date] || []
    const products = records.reduce((items, record) => items.concat(record.items || []), [])
    dayMap[date] = { rareIcons: getRareCalendarIcons(products).slice(0, 4) }
  })
  viewCache.monthDayMapCache[monthText] = dayMap
  return dayMap
}

function buildHistoryViewState(viewCache, selectedDate, calendarMonthText) {
  const availableDates = viewCache.availableDates || []
  const nextSelectedDate = selectedDate && viewCache.recordsByDate[selectedDate]
    ? selectedDate
    : (availableDates[0] || '')
  const monthText = calendarMonthText || (nextSelectedDate ? nextSelectedDate.slice(0, 7) : formatDate(new Date()).slice(0, 7))
  const calendarMonth = dateFromText(`${monthText}-01`)
  const availableMonths = viewCache.availableMonths || []
  const currentMonthIndex = availableMonths.indexOf(monthText)

  return {
    hasHistoryData: availableDates.length > 0,
    calendarWeekdays: CALENDAR_WEEKDAYS,
    calendarWeeks: buildCalendarWeeks(calendarMonth, getMonthDayMap(viewCache, monthText), nextSelectedDate),
    calendarMonthText: formatMonthText(calendarMonth),
    calendarMonthValue: monthText,
    canPrevCalendarMonth: currentMonthIndex > 0,
    canNextCalendarMonth: currentMonthIndex >= 0 && currentMonthIndex < availableMonths.length - 1,
    selectedDate: nextSelectedDate,
    selectedDay: getHistoryDayView(viewCache, nextSelectedDate)
  }
}

function buildCalendarViewState(viewCache, selectedDate, calendarMonthText) {
  const availableMonths = viewCache.availableMonths || []
  const monthText = calendarMonthText || (selectedDate ? selectedDate.slice(0, 7) : formatDate(new Date()).slice(0, 7))
  const calendarMonth = dateFromText(`${monthText}-01`)
  const currentMonthIndex = availableMonths.indexOf(monthText)
  const nextSelectedDate = selectedDate && viewCache.recordsByDate[selectedDate] ? selectedDate : ''

  return {
    calendarWeeks: buildCalendarWeeks(calendarMonth, getMonthDayMap(viewCache, monthText), nextSelectedDate),
    calendarMonthText: formatMonthText(calendarMonth),
    calendarMonthValue: monthText,
    canPrevCalendarMonth: currentMonthIndex > 0,
    canNextCalendarMonth: currentMonthIndex >= 0 && currentMonthIndex < availableMonths.length - 1,
    selectedDate: nextSelectedDate,
    selectedDay: getHistoryDayView(viewCache, nextSelectedDate)
  }
}

function normalizeProductCategory(category) {
  return category === '养成道具' ? '养成材料' : category
}

function buildProductListCard(product) {
  const imageSource = getProductImageSource(product)
  const image = imageSource ? getCachedProductImage(product) : product.image
  return {
    product_id: product.product_id || '',
    title: product.title || '未知商品',
    image: image || '',
    hasImage: Boolean(image),
    fallbackIcon: (product.title || '物').slice(0, 1)
  }
}

function buildProductGroups(previousGroups = []) {
  const products = getAllProducts()
  const previousStateByName = new Map((previousGroups || []).map(group => [group.name, group]))
  const recommendedIds = new Set(getFollowItems()
    .filter(item => item.group === 'recommended')
    .flatMap(item => item.product_ids || []))
  const focusIds = new Set(products
    .filter(product => product.rarity === 'rare' || recommendedIds.has(product.product_id))
    .map(product => product.product_id))

  return PRODUCT_GROUP_ORDER.map(name => {
    const items = name === '重点商品'
      ? products.filter(product => focusIds.has(product.product_id))
      : products.filter(product => {
        return normalizeProductCategory(product.category) === name
      })
    const isFocus = name === '重点商品'
    const previousState = previousStateByName.get(name) || {}
    return {
      name,
      isFocus,
      isExpanded: isFocus || previousState.isExpanded === true,
      isLoaded: isFocus || previousState.isLoaded === true,
      items: items.map(buildProductListCard)
    }
  }).filter(group => group.items.length > 0)
}

Page({
  data: {
    activeTab: 'history',
    hasHistoryData: false,
    calendarWeekdays: CALENDAR_WEEKDAYS,
    calendarWeeks: [],
    calendarMonthText: '',
    calendarMonthValue: '',
    canPrevCalendarMonth: false,
    canNextCalendarMonth: false,
    selectedDate: '',
    selectedDay: null,
    productGroups: [],
    historyLoading: false,
    historyRefreshing: false,
    voteDetailVisible: false,
    selectedRoundVoteDetail: null,
    voteShareGenerating: false
  },

  onShareAppMessage() {
    return {
      title: '远行商人历史日历和商品清单',
      path: '/pages/stats/stats'
    }
  },

  onShareTimeline() {
    return {
      title: '远行商人历史日历和商品清单'
    }
  },

  onLoad() {
    this.catalogVersion = getCatalogVersion()
    this.backfillAttempted = false
    this.loadHistory()
    Promise.all([
      loadProductCatalog({ knownVersion: app.globalData.catalogVersion }),
      loadProductStatsSnapshots({ knownVersion: app.globalData.statsVersion })
    ]).then(() => {
      const nextCatalogVersion = getCatalogVersion()
      const catalogChanged = nextCatalogVersion !== this.catalogVersion
      if (catalogChanged && this.historyViewCache) {
        this.historyViewCache.dayViewCache = {}
        this.historyViewCache.monthDayMapCache = {}
        this.renderVisibleHistory()
      }
      this.catalogVersion = nextCatalogVersion
      if (this.data.activeTab === 'stats') {
        this.loadStats({ force: catalogChanged })
      }
    })
    this.scheduleHistoryRefresh()
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.data.selected !== 2) {
      tabBar.setData({ selected: 2 })
    }
    this.setStatsTabBarVisible(!this.data.voteDetailVisible)
    this.refreshHistoryIfStale()
    this.scheduleHistoryRefresh()
  },

  onHide() {
    this.setStatsTabBarVisible(true)
    this.clearHistoryRefreshTimer()
  },

  onUnload() {
    this.setStatsTabBarVisible(true)
    this.clearHistoryRefreshTimer()
  },

  onPullDownRefresh() {
    if (this.data.activeTab === 'stats') {
      this.loadStats({ force: true })
      wx.stopPullDownRefresh()
      return
    }
    this.loadHistory({ force: true })
      .finally(() => {
        wx.stopPullDownRefresh()
      })
  },

  refreshHistoryFromButton() {
    if (this.data.historyRefreshing) {
      return this.historyRefreshButtonPromise || Promise.resolve()
    }

    this.setData({ historyRefreshing: true })
    this.historyRefreshButtonPromise = this.loadHistory({ force: true })
      .finally(() => {
        this.setData({ historyRefreshing: false })
        this.historyRefreshButtonPromise = null
      })
    return this.historyRefreshButtonPromise
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })

    if (tab === 'history' && !this.data.hasHistoryData) {
      this.loadHistory()
    } else if (tab === 'history') {
      this.refreshHistoryIfStale()
    }
    if (tab === 'stats' && !this.data.productGroups.length) {
      this.loadStats()
    } else if (tab === 'stats') {
      this.cacheProductGroup('重点商品')
    }
    if (tab === 'history') this.scheduleHistoryRefresh()
    else this.clearHistoryRefreshTimer()
  },

  clearHistoryRefreshTimer() {
    if (this.historyRefreshTimer) {
      clearTimeout(this.historyRefreshTimer)
      this.historyRefreshTimer = null
    }
  },

  scheduleHistoryRefresh() {
    this.clearHistoryRefreshTimer()
    if (this.data.activeTab !== 'history') return
    const nextRefreshAt = getNextHistoryRefreshAt()
    const delay = Math.max(1000, nextRefreshAt.getTime() - Date.now())
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = null
      this.loadHistory({ automatic: true, selectLatest: true })
        .finally(() => {
          this.scheduleHistoryRefresh()
        })
    }, delay)
  },

  refreshHistoryIfStale() {
    if (this.data.activeTab !== 'history') return
    const cacheState = readHistoryCache()
    const metadata = cacheState.metadata || {}
    const visibleRecords = filterVisibleHistoryRecords(cacheState.records, getLastCompletedRoundKey(), metadata.includedCurrentRoundKey)
    const latestRecordRoundKey = getLatestRecordRoundKey(visibleRecords)
    const lastCompletedRoundKey = getLastCompletedRoundKey()
    const currentRoundKey = getCurrentRoundKey()
    const completedMissing = !latestRecordRoundKey ||
      compareRoundKey(metadata.checkedUntilRoundKey, lastCompletedRoundKey) < 0 ||
      !hasHistoryRound(cacheState.records, lastCompletedRoundKey)
    const currentMissing = Boolean(currentRoundKey && metadata.includedCurrentRoundKey !== currentRoundKey)
    if (completedMissing || currentMissing) {
      this.loadHistory({ automatic: true, selectLatest: true })
    }
  },

  loadHistory(options = {}) {
    if (this.historyLoadingPromise) return this.historyLoadingPromise
    const force = options.force === true
    const lastCompletedRoundKey = getLastCompletedRoundKey()
    const cacheState = readHistoryCache()
    const metadata = cacheState.metadata || {}
    const cachedRecords = filterVisibleHistoryRecords(cacheState.records, lastCompletedRoundKey, metadata.includedCurrentRoundKey)
    const selectLatest = force || options.selectLatest === true || !this.data.selectedDate

    if (cachedRecords.length && !this.historyViewCache) {
      this.applyHistoryRecords(cachedRecords, { selectLatest })
    }

    if (!cachedRecords.length) this.setData({ historyLoading: true })

    this.historyLoadingPromise = this.loadCachedHistory({
      cacheState,
      lastCompletedRoundKey,
      force,
      automatic: options.automatic !== false
    })
      .then(result => {
        if (result.changed || !this.historyViewCache) {
          this.applyHistoryRecords(result.records, {
            changedDates: result.changedDates,
            selectLatest
          })
        }
        this.scheduleHistoryBackfill(result.cacheState || cacheState, result.records, lastCompletedRoundKey)
      })
      .catch(() => {
        wx.showToast({ title: '历史记录加载失败', icon: 'none' })
      })
      .finally(() => {
        this.setData({ historyLoading: false })
        this.historyLoadingPromise = null
      })
    return this.historyLoadingPromise
  },

  loadCachedHistory(options = {}) {
    const lastCompletedRoundKey = options.lastCompletedRoundKey || getLastCompletedRoundKey()
    const force = options.force === true
    const cacheState = options.cacheState || readHistoryCache()
    const metadata = cacheState.metadata || {}
    const cachedRecords = sortHistoryRecords(cacheState.records || [])
    const cachedVisibleRecords = filterVisibleHistoryRecords(cachedRecords, lastCompletedRoundKey, metadata.includedCurrentRoundKey)
    const currentRoundKey = getCurrentRoundKey()
    const syncRoundKey = currentRoundKey || lastCompletedRoundKey
    const cacheBase = {
      ...metadata,
      checkedUntilRoundKey: metadata.checkedUntilRoundKey || getLatestRecordRoundKey(cachedRecords),
      currentRoundKey: metadata.currentRoundKey || '',
      includedCurrentRoundKey: metadata.includedCurrentRoundKey || '',
      backfillBeforeRoundKey: metadata.backfillBeforeRoundKey || getOldestRecordRoundKey(cachedRecords),
      backfillMonth: metadata.backfillMonth || getNextBackfillMonth(cachedRecords),
      backfillComplete: metadata.backfillComplete === true
    }

    const cacheFresh = compareRoundKey(cacheBase.checkedUntilRoundKey, lastCompletedRoundKey) >= 0 &&
      compareRoundKey(getLatestRecordRoundKey(cachedRecords), lastCompletedRoundKey) >= 0 &&
      hasHistoryRound(cachedRecords, lastCompletedRoundKey) &&
      (!currentRoundKey || cacheBase.includedCurrentRoundKey === currentRoundKey)
    const retryCoolingDown = options.automatic &&
      cacheBase.lastAttemptRoundKey === syncRoundKey &&
      Date.now() - Number(cacheBase.lastAttemptAt || 0) < HISTORY_SYNC_RETRY_MS

    if (!force && (cacheFresh || retryCoolingDown)) {
      return Promise.resolve({
        records: cachedVisibleRecords,
        cacheState: { records: cachedRecords, metadata: cacheBase },
        changed: false,
        changedDates: []
      })
    }

    const attemptMetadata = {
      ...cacheBase,
      lastAttemptRoundKey: syncRoundKey,
      lastAttemptAt: Date.now()
    }
    writeHistorySyncState(attemptMetadata)

    return callCloudApi('merchant.historyBundle', {
      ensureRoundKey: currentRoundKey || lastCompletedRoundKey,
      includeCurrent: true
    }).then(result => {
      if (!result || !result.success) throw new Error('history delta load failed')
      const resultData = result.data || {}
      const merged = mergeHistoryRecords(cachedRecords, resultData.records || [])
      const includedCurrentRoundKey = resultData.includedCurrentRoundKey || ''
      const records = filterVisibleHistoryRecords(merged.records, lastCompletedRoundKey, includedCurrentRoundKey)
      const nextCache = {
        ...attemptMetadata,
        checkedUntilRoundKey: resultData.latestRoundKey || getLatestRecordRoundKey(merged.records) || lastCompletedRoundKey,
        currentRoundKey: resultData.currentRoundKey || '',
        includedCurrentRoundKey,
        backfillBeforeRoundKey: cacheBase.backfillBeforeRoundKey || resultData.oldestRoundKey || getOldestRecordRoundKey(merged.records),
        backfillMonth: cacheBase.backfillMonth || getNextBackfillMonth(merged.records),
        backfillComplete: cacheBase.backfillComplete,
        lastSuccessfulRoundKey: includedCurrentRoundKey || resultData.latestRoundKey || cacheBase.lastSuccessfulRoundKey || ''
      }
      const writtenCache = writeHistoryCache(merged.records, nextCache)
      return {
        records,
        cacheState: writtenCache,
        changed: merged.changed,
        changedDates: merged.changedDates
      }
    })
  },

  scheduleHistoryBackfill(cacheState, records, lastCompletedRoundKey) {
    if (this.backfillAttempted) return
    this.backfillAttempted = true
    setTimeout(() => {
      this.backfillHistoryOnce(cacheState, records, lastCompletedRoundKey)
    }, 0)
  },

  backfillHistoryOnce(cacheState, records, lastCompletedRoundKey) {
    const metadata = cacheState && cacheState.metadata ? cacheState.metadata : {}
    if (this.backfillLoading || metadata.backfillComplete) return

    const beforeRoundKey = metadata.backfillBeforeRoundKey
      ? metadata.backfillBeforeRoundKey
      : getOldestRecordRoundKey(records)
    const month = metadata.backfillMonth
      ? metadata.backfillMonth
      : getNextBackfillMonth(records)
    if (!beforeRoundKey || !month) return
    if (
      metadata.backfillAttemptMonth === month &&
      Date.now() - Number(metadata.backfillAttemptAt || 0) < HISTORY_BACKFILL_RETRY_MS
    ) return

    this.backfillLoading = true
    writeHistorySyncState({
      ...metadata,
      backfillAttemptMonth: month,
      backfillAttemptAt: Date.now()
    })
    callCloudApi('merchant.historyBundle', { month })
      .then(result => {
        if (!result || !result.success) return
        const currentCache = readHistoryCache()
        const currentMetadata = currentCache.metadata || {}
        const merged = mergeHistoryRecords(currentCache.records, result.data.records || [])
        const nextRecords = filterVisibleHistoryRecords(merged.records, lastCompletedRoundKey, currentMetadata.includedCurrentRoundKey)
        const returnedRecords = result.data.records || []
        const nextCache = {
          ...currentMetadata,
          checkedUntilRoundKey: currentMetadata.checkedUntilRoundKey || getLatestRecordRoundKey(merged.records),
          backfillBeforeRoundKey: result.data.oldestRoundKey || getOldestRecordRoundKey(merged.records),
          backfillMonth: getPreviousMonth(month),
          backfillComplete: !returnedRecords.length,
          backfillAttemptMonth: '',
          backfillAttemptAt: 0
        }
        const writtenCache = writeHistoryCache(merged.records, nextCache)
        if (merged.changed) {
          this.applyHistoryRecords(nextRecords, {
            changedDates: merged.changedDates,
            preserveVisible: true
          })
        }
        return writtenCache
      })
      .finally(() => {
        this.backfillLoading = false
      })
  },

  applyHistoryRecords(records, options = {}) {
    const normalizedRecords = normalizeHistoryRecords(records)
    const historyViewCache = updateHistoryViewCache(
      this.historyViewCache,
      normalizedRecords,
      options.changedDates
    )
    this.allHistoryRecords = normalizedRecords
    this.historyViewCache = historyViewCache
    const selectedDate = options.selectLatest ? '' : this.data.selectedDate
    const calendarMonthValue = options.selectLatest ? '' : this.data.calendarMonthValue
    if (options.preserveVisible) {
      const visibleMonth = this.data.calendarMonthValue
      const visibleDate = this.data.selectedDate
      const affected = (options.changedDates || []).some(date => date === visibleDate || date.slice(0, 7) === visibleMonth)
      if (!affected) {
        const monthIndex = historyViewCache.availableMonths.indexOf(visibleMonth)
        this.setData({
          hasHistoryData: normalizedRecords.length > 0,
          canPrevCalendarMonth: monthIndex > 0,
          canNextCalendarMonth: monthIndex >= 0 && monthIndex < historyViewCache.availableMonths.length - 1
        })
        return
      }
    }
    const historyViewState = buildHistoryViewState(historyViewCache, selectedDate, calendarMonthValue)
    this.setData(historyViewState)
  },

  renderVisibleHistory() {
    if (!this.historyViewCache) return
    this.setData(buildHistoryViewState(
      this.historyViewCache,
      this.data.selectedDate,
      this.data.calendarMonthValue
    ))
  },

  selectCalendarDate(e) {
    const date = e.currentTarget.dataset.date
    const historyViewCache = this.historyViewCache
    if (!historyViewCache || !historyViewCache.recordsByDate[date]) return

    this.setData(buildCalendarViewState(historyViewCache, date, date.slice(0, 7)))
  },

  changeCalendarMonth(e) {
    const direction = Number(e.currentTarget.dataset.direction || 0)
    const historyViewCache = this.historyViewCache
    if (!historyViewCache) return
    const availableMonths = historyViewCache.availableMonths || []
    const currentIndex = availableMonths.indexOf(this.data.calendarMonthValue)
    const nextMonth = availableMonths[currentIndex + direction]
    if (!nextMonth) return

    const nextDate = historyViewCache.availableDates.find(date => date.slice(0, 7) === nextMonth) || ''
    this.setData(buildCalendarViewState(historyViewCache, nextDate, nextMonth))
  },

  setStatsTabBarVisible(visible) {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.data.visible !== visible) {
      tabBar.setData({ visible })
    }
  },

  showRoundVoteDetail(e) {
    const roundNo = Number(e.currentTarget.dataset.round || 0)
    const selectedDay = this.data.selectedDay
    if (!selectedDay || !roundNo) return

    const round = (selectedDay.rounds || []).find(item => Number(item.round) === roundNo)
    if (!round) return

    const detail = {
      roundKey: round.roundKey || buildRoundKey(selectedDay.date, roundNo),
      dateText: selectedDay.dateText,
      roundText: round.roundText,
      products: round.normalItems || [],
      voteSummary: round.voteSummary,
      hasVotes: Boolean(round.voteSummary && round.voteSummary.total > 0)
    }
    this.setData({
      voteDetailVisible: true,
      selectedRoundVoteDetail: detail
    })
    this.setStatsTabBarVisible(false)
    this.refreshCurrentRoundVoteDetail(detail)
  },

  refreshCurrentRoundVoteDetail(detail) {
    const roundKey = detail && detail.roundKey
    if (!roundKey || roundKey !== getCurrentRoundKey()) return
    if (!this.voteRefreshAtByRoundKey) this.voteRefreshAtByRoundKey = {}
    if (Date.now() - Number(this.voteRefreshAtByRoundKey[roundKey] || 0) < CURRENT_VOTE_REFRESH_MS) return
    this.voteRefreshAtByRoundKey[roundKey] = Date.now()
    callCloudApi('merchant.voteSummary', { roundKey }).then(result => {
      const summary = result && result.success && result.data && result.data.summary
      const currentDetail = this.data.selectedRoundVoteDetail
      if (!summary || !currentDetail || currentDetail.roundKey !== roundKey) return
      const normalizedSummary = normalizeRoundVoteSummary(summary)
      this.setData({
        'selectedRoundVoteDetail.voteSummary': normalizedSummary,
        'selectedRoundVoteDetail.hasVotes': Boolean(normalizedSummary && normalizedSummary.total > 0)
      })
    }).catch(() => {})
  },

  closeRoundVoteDetail() {
    this.setData({
      voteDetailVisible: false,
      selectedRoundVoteDetail: null
    })
    this.setStatsTabBarVisible(true)
  },

  stopTap() {},

  shareRoundVotePoster() {
    if (this.data.voteShareGenerating) return
    const detail = this.data.selectedRoundVoteDetail
    if (!detail || !detail.hasVotes || !detail.voteSummary) {
      wx.showToast({ title: '暂无印象可分享', icon: 'none' })
      return
    }

    this.setData({ voteShareGenerating: true })
    wx.showLoading({ title: '生成中', mask: true })

    this.buildVoteSharePoster(detail)
      .then(filePath => {
        return this.openVoteShareImage(filePath)
      })
      .catch(error => {
        console.error('[stats] share poster failed', error)
        wx.showToast({ title: error && error.userMessage ? error.userMessage : '分享图生成失败', icon: 'none' })
      })
      .finally(() => {
        wx.hideLoading()
        this.setData({ voteShareGenerating: false })
      })
  },

  sharePrismPoster(e) {
    if (this.data.voteShareGenerating) return
    const dataset = e.currentTarget.dataset || {}
    const detail = {
      name: dataset.name || PRISM_BALL_NAME,
      image: dataset.image || '',
      dateText: dataset.dateText || (this.data.selectedDay && this.data.selectedDay.dateText) || '',
      roundText: dataset.roundText || ''
    }

    this.setData({ voteShareGenerating: true })
    wx.showLoading({ title: '生成中', mask: true })

    this.buildPrismSharePoster(detail)
      .then(filePath => {
        return this.openVoteShareImage(filePath)
      })
      .catch(error => {
        console.error('[stats] prism poster failed', error)
        wx.showToast({ title: error && error.userMessage ? error.userMessage : '分享图生成失败', icon: 'none' })
      })
      .finally(() => {
        wx.hideLoading()
        this.setData({ voteShareGenerating: false })
      })
  },

  buildVoteSharePoster(detail) {
    const products = (detail.products || []).slice(0, 6)
    return Promise.all([
      this.resolvePosterProducts(products),
      this.getShareWxacodePath()
    ])
      .then(([posterProducts, wxacodePath]) => {
        const imageTasks = posterProducts.map(product => this.getDrawableImagePath([product.posterImage, product.image]))

        return Promise.all(imageTasks).then(productImagePaths => {
          return this.drawVoteSharePoster({
            detail,
            products: posterProducts,
            productImagePaths,
            wxacodePath
          })
        })
      })
  },

  buildPrismSharePoster(detail) {
    return Promise.all([
      this.getDrawableImagePath(PRISM_SHARE_HERO_IMAGE),
      this.getShareWxacodePath()
    ])
      .then(([heroPath, wxacodePath]) => {
        if (!heroPath) {
          const error = new Error('prism_hero_unavailable')
          error.userMessage = '分享图生成失败'
          throw error
        }
        return this.drawPrismSharePoster({
          detail,
          heroPath,
          wxacodePath
        })
      })
  },

  resolvePosterProducts(products) {
    const imageItems = buildPosterProductImageItems(products)
    if (!imageItems.length) return Promise.resolve(products)

    const cache = readShareGoodsImageCache()
    const missingItems = imageItems.filter(item => !cache[item.image])
    const fetchMissing = missingItems.length
      ? callCloudApi('share.goodsImages', { items: missingItems })
      : Promise.resolve({ success: true, data: { items: [] } })

    return fetchMissing
      .then(result => {
        if (result && result.success && result.data && Array.isArray(result.data.items)) {
          result.data.items.forEach(item => {
            if (item && item.sourceUrl && item.fileID) {
              cache[item.sourceUrl] = item.fileID
            }
          })
          writeShareGoodsImageCache(cache)
        }

        return products.map(product => {
          if (!/^https:\/\//.test(product.image || '')) return product
          return cache[product.image]
            ? { ...product, posterImage: cache[product.image] }
            : product
        })
      })
      .catch(error => {
        console.warn('[stats] share goods images fallback', error)
        return products
      })
  },

  getShareWxacodePath() {
    if (this.shareWxacodePath) return Promise.resolve(this.shareWxacodePath)
    if (!wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) {
      const error = new Error('wxacode_unavailable')
      error.userMessage = '小程序码生成失败'
      return Promise.reject(error)
    }

    const filePath = `${wx.env.USER_DATA_PATH}/roco-stats-wxacode.png`
    const fileSystem = wx.getFileSystemManager()

    return new Promise((resolve, reject) => {
      fileSystem.access({
        path: filePath,
        success: () => {
          this.shareWxacodePath = filePath
          resolve(filePath)
        },
        fail: () => {
          callCloudApi('share.wxacode')
            .then(result => {
              const base64 = result && result.success && result.data ? result.data.base64 : ''
              if (!base64) {
                const error = new Error(result && result.message ? result.message : 'wxacode_empty')
                error.userMessage = '小程序码生成失败'
                throw error
              }

              return new Promise((writeResolve, writeReject) => {
                fileSystem.writeFile({
                  filePath,
                  data: base64,
                  encoding: 'base64',
                  success: () => writeResolve(filePath),
                  fail: writeReject
                })
              })
            })
            .then(path => {
              this.shareWxacodePath = path
              resolve(path)
            })
            .catch(rawError => {
              const error = rawError instanceof Error
                ? rawError
                : new Error(rawError && rawError.message ? rawError.message : 'wxacode_failed')
              error.userMessage = error.userMessage || '小程序码生成失败'
              reject(error)
            })
        }
      })
    })
  },

  getDrawableImagePath(src) {
    const imageCandidates = (Array.isArray(src) ? src : [src])
      .reduce((candidates, item) => candidates.concat(getCanvasImageCandidates(item)), [])
      .filter(Boolean)
    if (!imageCandidates.length) return Promise.resolve('')
    return new Promise(resolve => {
      let settled = false
      let index = 0
      const finish = path => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(path)
      }
      const tryNext = () => {
        if (settled) return
        const imageSrc = imageCandidates[index]
        index += 1
        if (!imageSrc) {
          finish('')
          return
        }
        if (/^cloud:\/\//.test(imageSrc)) {
          if (!wx.cloud || !wx.cloud.downloadFile) {
            tryNext()
            return
          }
          wx.cloud.downloadFile({
            fileID: imageSrc,
            success: res => {
              finish(res.tempFilePath || '')
            },
            fail: () => {
              tryNext()
            }
          })
          return
        }
        wx.getImageInfo({
          src: imageSrc,
          success: res => {
            finish(res.path || imageSrc)
          },
          fail: () => {
            tryNext()
          }
        })
      }
      const timer = setTimeout(() => {
        finish('')
      }, VOTE_SHARE_POSTER_TIMEOUT_MS)
      tryNext()
    })
  },

  drawVoteSharePoster(options) {
    if (!options.wxacodePath) {
      const error = new Error('wxacode_missing')
      error.userMessage = '小程序码生成失败'
      return Promise.reject(error)
    }

    const detail = options.detail
    const voteSummary = detail.voteSummary || {}
    const products = options.products || []
    const productImagePaths = options.productImagePaths || []
    const ctx = wx.createCanvasContext(VOTE_SHARE_CANVAS_ID, this)
    const width = VOTE_SHARE_POSTER_WIDTH
    const height = VOTE_SHARE_POSTER_HEIGHT

    ctx.setFillStyle('#fff8ed')
    ctx.fillRect(0, 0, width, height)

    this.drawPosterRoundRect(ctx, 36, 30, 678, 930, 34, '#fffdf8')
    this.drawPosterRoundRect(ctx, 36, 30, 678, 112, 34, '#fff3dc')
    ctx.setFillStyle('#8a6629')
    ctx.setFontSize(30)
    ctx.fillText(`${detail.dateText || ''} ${detail.roundText || ''}`, 66, 84)

    this.drawPosterRoundRect(ctx, 66, 204, 350, 188, 20, '#fff8ed')
    products.forEach((product, index) => {
      const row = Math.floor(index / 3)
      const col = index % 3
      const size = 70
      const x = 94 + col * 104
      const y = 226 + row * 82
      if (productImagePaths[index]) {
        this.drawPosterImage(ctx, productImagePaths[index], x, y, size, size)
      } else {
        ctx.setFillStyle('#744b00')
        ctx.setFontSize(30)
        ctx.fillText(product.icon || (product.name ? product.name.slice(0, 1) : '物'), x + 20, y + 47)
      }
    })

    this.drawPosterRoundRect(ctx, 438, 204, 246, 188, 20, '#fff8ed')
    ctx.setFillStyle('#786b5c')
    ctx.setFontSize(22)
    ctx.fillText('当前综合印象', 464, 268)
    ctx.setFillStyle('#c86a12')
    ctx.setFontSize(46)
    ctx.fillText(voteSummary.topLabel || '', 464, 330)

    const rowStartY = 456
    ;(voteSummary.options || []).forEach((option, index) => {
      const y = rowStartY + index * 78
      ctx.setFillStyle(option.isTop ? '#c86a12' : '#514532')
      ctx.setFontSize(26)
      ctx.fillText(option.label || '', 66, y)
      this.drawPosterRoundRect(ctx, 178, y - 20, 336, 12, 6, '#ead9bf')
      this.drawPosterRoundRect(ctx, 178, y - 20, Math.round(336 * Number(option.percent || 0) / 100), 12, 6, option.isTop ? '#167f5b' : '#d4bd98')
      ctx.setFillStyle(option.isTop ? '#c86a12' : '#8a6629')
      ctx.setFontSize(24)
      ctx.fillText(`${Number(option.percent || 0)}%`, 542, y)
      ctx.setFillStyle('#857765')
      ctx.setFontSize(22)
      ctx.fillText(`${Number(option.count || 0)}人`, 628, y)
    })

    ctx.setStrokeStyle('#ead9bf')
    ctx.setLineWidth(1)
    ctx.beginPath()
    ctx.moveTo(66, 760)
    ctx.lineTo(684, 760)
    ctx.stroke()

    this.drawPosterImage(ctx, options.wxacodePath, 306, 790, 138, 138)
    ctx.setFillStyle('#514532')
    ctx.setFontSize(22)
    ctx.fillText('扫码查看远行商人记录本', 250, 950)

    return this.exportSharePosterCanvas(ctx, width, height)
  },

  drawPrismSharePoster(options) {
    if (!options.wxacodePath) {
      const error = new Error('wxacode_missing')
      error.userMessage = '小程序码生成失败'
      return Promise.reject(error)
    }

    const detail = options.detail || {}
    const ctx = wx.createCanvasContext(VOTE_SHARE_CANVAS_ID, this)
    const width = VOTE_SHARE_POSTER_WIDTH
    const height = VOTE_SHARE_POSTER_HEIGHT
    const dateLine = detail.dateText || ''

    ctx.setFillStyle('#fff8ed')
    ctx.fillRect(0, 0, width, height)

    this.drawPosterRoundRect(ctx, 36, 30, 678, 930, 34, '#fffdf8')
    this.drawPosterRoundRect(ctx, 126, 38, 498, 86, 30, '#fff3dc')
    ctx.setTextAlign('center')
    ctx.setFillStyle('#8a6629')
    ctx.setFontSize(28)
    ctx.fillText(dateLine || '远行商人稀有商品', 375, 92)
    ctx.setTextAlign('left')

    this.drawPosterRoundRect(ctx, 66, 150, 618, 568, 28, '#fff8ed')
    this.drawPosterImage(ctx, options.heroPath, 170, 160, 410, 546)

    ctx.setTextAlign('center')
    ctx.setFillStyle('#514532')
    ctx.setFontSize(28)
    ctx.fillText('棱镜球出现啦，快分享给朋友看看。', 375, 775)
    ctx.setTextAlign('left')

    ctx.setStrokeStyle('#ead9bf')
    ctx.setLineWidth(1)
    ctx.beginPath()
    ctx.moveTo(66, 820)
    ctx.lineTo(684, 820)
    ctx.stroke()

    this.drawPosterImage(ctx, options.wxacodePath, 327, 838, 96, 96)
    ctx.setFillStyle('#514532')
    ctx.setFontSize(22)
    ctx.fillText('扫码查看远行商人记录本', 250, 954)

    return this.exportSharePosterCanvas(ctx, width, height)
  },

  exportSharePosterCanvas(ctx, width, height) {
    return new Promise((resolve, reject) => {
      let settled = false
      let exporting = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const exportPoster = () => {
        if (settled || exporting) return
        exporting = true
        wx.canvasToTempFilePath({
          canvasId: VOTE_SHARE_CANVAS_ID,
          width,
          height,
          destWidth: width,
          destHeight: height,
          success: res => finish(resolve, res.tempFilePath),
          fail: error => {
            exporting = false
            if (settled) return
            reject(error)
          }
        }, this)
      }
      const timer = setTimeout(() => {
        finish(reject, new Error('分享图生成超时'))
      }, VOTE_SHARE_POSTER_TIMEOUT_MS)
      ctx.draw(false, () => {
        setTimeout(exportPoster, 100)
      })
    })
  },

  drawPosterRoundRect(ctx, x, y, width, height, radius, color) {
    const right = x + width
    const bottom = y + height
    ctx.setFillStyle(color)
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(right - radius, y)
    ctx.quadraticCurveTo(right, y, right, y + radius)
    ctx.lineTo(right, bottom - radius)
    ctx.quadraticCurveTo(right, bottom, right - radius, bottom)
    ctx.lineTo(x + radius, bottom)
    ctx.quadraticCurveTo(x, bottom, x, bottom - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
    ctx.fill()
  },

  drawPosterImage(ctx, path, x, y, width, height) {
    if (!path) return false
    try {
      ctx.drawImage(path, x, y, width, height)
      return true
    } catch (error) {
      console.warn('[stats] poster image skipped', path, error)
      return false
    }
  },

  openVoteShareImage(filePath) {
    const previewImage = () => {
      wx.previewImage({ urls: [filePath] })
      wx.showToast({ title: '长按图片可保存', icon: 'none' })
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: filePath,
        fail: () => {
          previewImage()
        }
      })
      return Promise.resolve()
    }
    previewImage()
    return Promise.resolve()
  },

  loadStats(options = {}) {
    if (this.data.productGroups.length && options.force !== true) {
      this.cacheProductGroup('重点商品')
      return
    }
    this.catalogImageStateByKey = {}
    this.catalogImageCacheRetrySources = new Set()
    getAllProducts().forEach(product => {
      const key = product.product_id || product.title
      if (key) this.catalogImageStateByKey[key] = product
    })
    this.setData({
      productGroups: buildProductGroups(this.data.productGroups)
    })
    this.cacheProductGroup('重点商品')
  },

  cacheProductGroup(groupName) {
    const group = this.data.productGroups.find(item => item.name === groupName)
    if (!group) return Promise.resolve()
    const products = group.items.map(item => {
      const key = item.product_id || item.title
      return this.catalogImageStateByKey && this.catalogImageStateByKey[key]
    }).filter(Boolean)
    return this.cacheProductImages(products)
  },

  cacheProductImages(products) {
    const previousBatch = this.productImageCacheBatchPromise || Promise.resolve()
    const nextBatch = previousBatch
      .catch(() => {})
      .then(() => {
        const queue = []
        ;(products || []).forEach(product => {
          if (!getProductImageSource(product)) return
          const cachedPath = getCachedProductImage(product)
          if (cachedPath) {
            this.updateCatalogProductImage(product, cachedPath, true)
            return
          }
          queue.push(product)
        })
        if (!queue.length) return undefined
        let nextIndex = 0
        const worker = () => {
          const product = queue[nextIndex]
          nextIndex += 1
          if (!product) return Promise.resolve()
          return ensureProductImageCached(product)
            .then(localPath => {
              if (localPath) this.updateCatalogProductImage(product, localPath, true)
            })
            .then(worker)
        }
        return Promise.all([worker(), worker()])
      })
    this.productImageCacheBatchPromise = nextBatch
    return nextBatch.finally(() => {
      if (this.productImageCacheBatchPromise === nextBatch) {
        this.productImageCacheBatchPromise = null
      }
    })
  },

  updateCatalogProductImage(product, image, hasImage) {
    const updates = {}
    this.data.productGroups.forEach((group, groupIndex) => {
      group.items.forEach((item, itemIndex) => {
        const matched = product.product_id
          ? item.product_id === product.product_id
          : item.title === product.title
        if (!matched || (item.image === image && item.hasImage === hasImage)) return
        updates[`productGroups[${groupIndex}].items[${itemIndex}].image`] = image
        updates[`productGroups[${groupIndex}].items[${itemIndex}].hasImage`] = hasImage
      })
    })
    if (Object.keys(updates).length) this.setData(updates)
  },

  toggleProductGroup(e) {
    const groupName = e.currentTarget.dataset.groupName || ''
    if (!groupName || groupName === PRODUCT_GROUP_ORDER[0]) return
    const groupIndex = this.data.productGroups.findIndex(group => group.name === groupName)
    if (groupIndex < 0) return
    const group = this.data.productGroups[groupIndex]
    const isExpanded = group.isExpanded !== true
    const updates = {
      [`productGroups[${groupIndex}].isExpanded`]: isExpanded
    }
    if (isExpanded && group.isLoaded !== true) {
      updates[`productGroups[${groupIndex}].isLoaded`] = true
    }
    this.setData(updates)
    if (isExpanded) this.cacheProductGroup(groupName)
  },

  handleCatalogImageError(e) {
    const productId = e.currentTarget.dataset.productId || ''
    const title = e.currentTarget.dataset.title || ''
    if (!productId && !title) return
    const key = productId || title
    const currentItem = this.catalogImageStateByKey && this.catalogImageStateByKey[key]
    if (!currentItem) return
    const imageSource = getProductImageSource(currentItem)
    if (imageSource) {
      this.updateCatalogProductImage(currentItem, '', false)
      const shouldRetry = !this.catalogImageCacheRetrySources.has(imageSource)
      this.catalogImageCacheRetrySources.add(imageSource)
      invalidateProductImageCache(imageSource)
        .then(() => shouldRetry ? ensureProductImageCached(currentItem) : '')
        .then(localPath => {
          if (localPath) this.updateCatalogProductImage(currentItem, localPath, true)
        })
      return
    }
    const nextImageState = advanceProductImage(currentItem)
    this.catalogImageStateByKey[key] = nextImageState
    this.updateCatalogProductImage(nextImageState, nextImageState.image, nextImageState.hasImage)
  },

  openProduct(e) {
    const productId = e.currentTarget.dataset.productId || ''
    const title = e.currentTarget.dataset.title || ''
    wx.navigateTo({
      url: productId
        ? `/pages/product-detail/index?product_id=${encodeURIComponent(productId)}`
        : `/pages/product-detail/index?title=${encodeURIComponent(title)}`
    })
  }
})
