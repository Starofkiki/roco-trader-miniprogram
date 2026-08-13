const fallbackCatalog = require('./product-data')
const { callCloudApi } = require('./cloud-api')
const { IMAGE_BY_NAME } = require('./goods-image-catalog')

const CATALOG_CACHE_KEY = 'product_catalog_cache_v1'
const PRODUCT_STATS_CACHE_KEY = 'product_stats_cache_v1'
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000
const PRODUCT_STATS_REFRESH_MS = 4 * 60 * 60 * 1000
const UNKNOWN_DESCRIPTION = '该商品资料暂未收录。'
const CATEGORY_ORDER = ['精灵蛋', '咕噜球', '血脉秘药', '矿石', '粉尘', '养成道具', '养成材料']
const BUNDLED_IMAGE_FILE_ID_BY_PRODUCT_ID = {}
const BUNDLED_IMAGE_FILE_ID_BY_TITLE = {}

;(fallbackCatalog.products || []).forEach(product => {
  const imageFileId = String(product.image_file_id || '').trim()
  if (!imageFileId) return
  if (product.product_id) BUNDLED_IMAGE_FILE_ID_BY_PRODUCT_ID[product.product_id] = imageFileId
  if (product.title) BUNDLED_IMAGE_FILE_ID_BY_TITLE[product.title] = imageFileId
})

let runtimeCatalog = null
let productList = []
let productById = {}
let productByTitle = {}
let productByAlias = {}
let offerByProductId = {}
let followTargets = []
let loadPromise = null
let statsLoadPromise = null
let lastCloudLoadAt = 0
let lastStatsLoadAt = 0
let statsVersion = ''
const failedImageCandidates = new Set()

function normalizeName(name) {
  return String(name || '')
    .replace(/[\s*＊·・\-_/\\|｜]+/g, '')
    .trim()
}

function normalizeStringList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)))
}

function isCloudStorageImage(image) {
  return /^cloud:\/\//.test(image) || /(?:cloudstatic\.cn|\/cloudstatic\/)/.test(image)
}

function uniqueImageCandidates(values) {
  return Array.from(new Set((values || [])
    .map(value => String(value || '').trim())
    .filter(Boolean)))
}

function buildImageCandidates(imageFileId, imageUrl, catalogImage, extraCandidates = []) {
  const values = [imageFileId, imageUrl, catalogImage].concat(extraCandidates || [])
  const cloudCandidates = uniqueImageCandidates(values.filter(isCloudStorageImage))
  const externalCandidate = values.find(value => value && !isCloudStorageImage(value)) || ''
  return uniqueImageCandidates(cloudCandidates.concat(externalCandidate))
    .filter(candidate => !failedImageCandidates.has(candidate))
}

function advanceProductImage(item = {}) {
  if (item.image) failedImageCandidates.add(item.image)
  const candidates = uniqueImageCandidates(item.imageCandidates)
  let currentIndex = Number(item.imageCandidateIndex || 0)
  if (candidates[currentIndex] !== item.image) {
    const matchedIndex = candidates.indexOf(item.image)
    currentIndex = matchedIndex >= 0 ? matchedIndex : currentIndex
  }
  let nextIndex = currentIndex + 1
  while (nextIndex < candidates.length && failedImageCandidates.has(candidates[nextIndex])) {
    nextIndex += 1
  }
  if (nextIndex < candidates.length) {
    return {
      ...item,
      image: candidates[nextIndex],
      imageCandidateIndex: nextIndex,
      hasImage: true
    }
  }
  return {
    ...item,
    image: '',
    imageCandidateIndex: candidates.length,
    hasImage: false
  }
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeLastOccurrences(values) {
  return (Array.isArray(values) ? values : []).map(item => ({
    date: String(item && item.date || ''),
    round: Number(item && item.round || 0),
    round_key: String(item && (item.round_key || item.roundKey) || '')
  })).filter(item => item.date && item.round >= 1 && item.round <= 4 && item.round_key)
}

function normalizeProduct(product) {
  const aliases = normalizeStringList(product.aliases || (product.alias ? [product.alias] : []))
  const imageFileId = String(product.image_file_id ||
    BUNDLED_IMAGE_FILE_ID_BY_PRODUCT_ID[product.product_id] ||
    BUNDLED_IMAGE_FILE_ID_BY_TITLE[product.title] || '').trim()
  const imageUrl = String(product.image_url || product.image || '').trim()
  const catalogImage = String(IMAGE_BY_NAME[product.title] || '').trim()
  const imageCandidates = buildImageCandidates(imageFileId, imageUrl, catalogImage)
  return {
    product_id: String(product.product_id || product._id || '').trim(),
    title: String(product.title || '').trim(),
    aliases,
    alias: aliases.join('、'),
    category: product.category || '未知',
    description: product.description || '',
    obtain: product.obtain || '',
    image_file_id: imageFileId,
    image_url: imageUrl,
    image: imageCandidates[0] || '',
    imageCandidates,
    imageCandidateIndex: 0,
    rarity: product.rarity === 'rare' ? 'rare' : 'normal',
    default_score: Number(product.default_score || 0),
    has_rolling_stats: product.has_rolling_stats === true,
    stats_updated_round_key: String(product.stats_updated_round_key || ''),
    stats_as_of_date: String(product.stats_as_of_date || ''),
    appear_count_7d: Math.max(0, Number(product.appear_count_7d || 0)),
    appear_count_30d: Math.max(0, Number(product.appear_count_30d || 0)),
    last_occurrences: normalizeLastOccurrences(product.last_occurrences),
    has_season_rates: product.has_season_rates === true,
    season_rate_scope: product.season_rate_scope === 'group' ? 'group' : 'product',
    season_rate_scope_label: String(product.season_rate_scope_label || ''),
    appear_rate_current_season: normalizeOptionalNumber(product.appear_rate_current_season),
    appear_rate_last_season: normalizeOptionalNumber(product.appear_rate_last_season),
    appear_rate_s1: normalizeOptionalNumber(product.appear_rate_s1),
    season_stats_updated_round_key: String(product.season_stats_updated_round_key || ''),
    status: product.status || 'active',
    is_unknown: false
  }
}

function normalizeOffer(offer) {
  return {
    offer_id: String(offer.offer_id || offer._id || '').trim(),
    product_id: String(offer.product_id || '').trim(),
    raw_name: String(offer.raw_name || '').trim(),
    sale_group: offer.sale_group || 'normal',
    offer_type: offer.offer_type || 'normal_pool',
    price: Number(offer.price || 0),
    buy_limit: Number(offer.buy_limit || offer.buy_limit_num || 0),
    enable: offer.enable !== false,
    source_row_id: offer.source_row_id === null ? null : Number(offer.source_row_id || 0),
    external_item_id: offer.external_item_id === null ? null : Number(offer.external_item_id || 0)
  }
}

function normalizeFollowTarget(target) {
  return {
    id: String(target.id || '').trim(),
    name: String(target.name || '').trim(),
    group: target.group === 'recommended' ? 'recommended' : 'other',
    icon: String(target.icon || '').trim(),
    tip: String(target.tip || '').trim(),
    all_day: target.all_day === true,
    reminder_policy: String(target.reminder_policy || '').trim(),
    display_product_id: String(target.display_product_id || '').trim(),
    product_ids: normalizeStringList(target.product_ids),
    keywords: normalizeStringList(target.keywords)
  }
}

function normalizeCatalog(catalog) {
  const source = catalog && Array.isArray(catalog.products) ? catalog : fallbackCatalog
  const fallbackTargets = fallbackCatalog.follow_targets || []
  const fixedHotFallback = fallbackTargets.find(target => target && target.id === 'fixed_hot_bundle')
  const sourceTargets = (Array.isArray(source.follow_targets) ? source.follow_targets : []).map(target => {
    if (!fixedHotFallback || !target || target.id !== 'fixed_hot_bundle') return target
    return {
      ...target,
      name: fixedHotFallback.name,
      icon: fixedHotFallback.icon,
      reminder_policy: fixedHotFallback.reminder_policy,
      display_product_id: fixedHotFallback.display_product_id,
      keywords: normalizeStringList([].concat(target.keywords || [], fixedHotFallback.keywords || []))
    }
  })
  const sourceTargetIds = new Set(sourceTargets.map(target => target && target.id).filter(Boolean))
  const followTargetSource = sourceTargets.concat(fallbackTargets
    .filter(target => target && !sourceTargetIds.has(target.id)))
  return {
    version: String(source.version || 'bundled').trim(),
    products: (source.products || []).map(normalizeProduct).filter(product => product.title && product.status !== 'inactive'),
    offers: (source.offers || []).map(normalizeOffer).filter(offer => offer.offer_id && offer.enable),
    follow_targets: followTargetSource.map(normalizeFollowTarget).filter(target => target.id && target.name)
  }
}

function compareProduct(a, b) {
  if (a.rarity !== b.rarity) return a.rarity === 'rare' ? -1 : 1
  const aCategory = CATEGORY_ORDER.indexOf(a.category)
  const bCategory = CATEGORY_ORDER.indexOf(b.category)
  const categoryDiff = (aCategory === -1 ? CATEGORY_ORDER.length : aCategory) -
    (bCategory === -1 ? CATEGORY_ORDER.length : bCategory)
  if (categoryDiff !== 0) return categoryDiff
  const scoreDiff = Number(b.default_score || 0) - Number(a.default_score || 0)
  if (scoreDiff !== 0) return scoreDiff
  return String(a.title).localeCompare(String(b.title))
}

function applyCatalog(catalog) {
  runtimeCatalog = normalizeCatalog(catalog)
  productList = runtimeCatalog.products.slice().sort(compareProduct)
  productById = {}
  productByTitle = {}
  productByAlias = {}
  offerByProductId = {}

  const aliasCounts = {}
  productList.forEach(product => {
    const titleKey = normalizeName(product.title)
    if (product.product_id) productById[product.product_id] = product
    if (titleKey && !productByTitle[titleKey]) productByTitle[titleKey] = product
    product.aliases.forEach(alias => {
      const key = normalizeName(alias)
      if (key) aliasCounts[key] = Number(aliasCounts[key] || 0) + 1
    })
  })
  productList.forEach(product => {
    product.aliases.forEach(alias => {
      const key = normalizeName(alias)
      if (key && aliasCounts[key] === 1) productByAlias[key] = product
    })
  })
  runtimeCatalog.offers.forEach(offer => {
    if (!offer.product_id) return
    if (!offerByProductId[offer.product_id]) offerByProductId[offer.product_id] = []
    offerByProductId[offer.product_id].push(offer)
  })
  Object.keys(offerByProductId).forEach(productId => {
    offerByProductId[productId].sort((a, b) => {
      if (a.offer_type === 'fixed_hot' && b.offer_type !== 'fixed_hot') return -1
      if (a.offer_type === 'special_pool' && b.offer_type === 'normal_pool') return -1
      return Number(a.source_row_id || 0) - Number(b.source_row_id || 0)
    })
  })
  followTargets = runtimeCatalog.follow_targets.slice()
}

function readCachedCatalog() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return null
  try {
    const cached = wx.getStorageSync(CATALOG_CACHE_KEY)
    return cached && Array.isArray(cached.products) && cached.products.length ? cached : null
  } catch (error) {
    return null
  }
}

function writeCachedCatalog(catalog) {
  if (typeof wx === 'undefined' || !wx.setStorageSync) return
  try {
    wx.setStorageSync(CATALOG_CACHE_KEY, { ...catalog, _cachedAt: Date.now() })
  } catch (error) {}
}

function readCachedProductStats() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return null
  try {
    const cached = wx.getStorageSync(PRODUCT_STATS_CACHE_KEY)
    return cached && Array.isArray(cached.products) ? cached : null
  } catch (error) {
    return null
  }
}

function applyProductStats(payload) {
  if (!payload || !Array.isArray(payload.products) || !runtimeCatalog) return
  const statsById = new Map(payload.products.map(item => [item.product_id, item]))
  applyCatalog({
    ...runtimeCatalog,
    products: runtimeCatalog.products.map(product => ({
      ...product,
      ...(statsById.get(product.product_id) || {})
    }))
  })
  statsVersion = String(payload.version || '')
  lastStatsLoadAt = Number(payload._cachedAt || Date.now())
}

function writeCachedProductStats(payload) {
  if (typeof wx === 'undefined' || !wx.setStorageSync) return
  try {
    wx.setStorageSync(PRODUCT_STATS_CACHE_KEY, { ...payload, _cachedAt: Date.now() })
  } catch (error) {}
}

function buildUnknownProduct(rawName) {
  return {
    product_id: '',
    title: String(rawName || '').trim() || '未知商品',
    aliases: [],
    alias: '',
    category: '未知',
    description: UNKNOWN_DESCRIPTION,
    obtain: '',
    image_file_id: '',
    image_url: '',
    image: '',
    imageCandidates: [],
    imageCandidateIndex: 0,
    rarity: 'normal',
    default_score: 0,
    has_rolling_stats: false,
    stats_updated_round_key: '',
    stats_as_of_date: '',
    appear_count_7d: 0,
    appear_count_30d: 0,
    last_occurrences: [],
    has_season_rates: false,
    season_rate_scope: 'product',
    season_rate_scope_label: '',
    appear_rate_current_season: null,
    appear_rate_last_season: null,
    appear_rate_s1: null,
    season_stats_updated_round_key: '',
    status: 'active',
    is_unknown: true
  }
}

function getAllProducts() {
  return productList.slice()
}

function getProductById(productId) {
  return productById[String(productId || '').trim()] || null
}

function getProductByTitle(title) {
  return productByTitle[normalizeName(title)] || null
}

function matchProductByName(rawName) {
  const key = normalizeName(rawName)
  if (!key) return buildUnknownProduct(rawName)
  return productByTitle[key] || productByAlias[key] || buildUnknownProduct(rawName)
}

function matchProduct(item) {
  const source = item || {}
  const byId = getProductById(source.product_id)
  if (byId) return byId
  return matchProductByName(source.raw_name || source.name || source.title)
}

function getProductOffers(productId) {
  return (offerByProductId[String(productId || '').trim()] || []).slice()
}

function getPrimaryProductOffer(productId) {
  return getProductOffers(productId)[0] || null
}

function getFollowItems() {
  return followTargets.map(target => ({ ...target, product_ids: target.product_ids.slice(), keywords: target.keywords.slice() }))
}

function getCatalogVersion() {
  return runtimeCatalog ? runtimeCatalog.version : ''
}

function loadProductCatalog(options = {}) {
  const knownVersion = String(options.knownVersion || '')
  if (options.force !== true && knownVersion && getCatalogVersion() === knownVersion) {
    return Promise.resolve(runtimeCatalog)
  }
  if (options.force !== true && lastCloudLoadAt && Date.now() - lastCloudLoadAt < CATALOG_REFRESH_MS) {
    return Promise.resolve(runtimeCatalog)
  }
  if (loadPromise && options.force !== true) return loadPromise
  loadPromise = callCloudApi('products.catalogV2', { ifVersion: getCatalogVersion() })
    .then(result => {
      const catalog = result && result.success ? result.data : null
      if (catalog && catalog.notModified === true) {
        lastCloudLoadAt = Date.now()
        writeCachedCatalog(runtimeCatalog)
        return runtimeCatalog
      }
      if (!catalog || !Array.isArray(catalog.products) || !catalog.products.length) return runtimeCatalog
      applyCatalog(catalog)
      writeCachedCatalog(catalog)
      lastCloudLoadAt = Date.now()
      return runtimeCatalog
    })
    .catch(() => runtimeCatalog)
    .finally(() => {
      loadPromise = null
    })
  return loadPromise
}

function loadProductStatsSnapshots(options = {}) {
  const knownVersion = String(options.knownVersion || '')
  if (options.force !== true && knownVersion && statsVersion === knownVersion) {
    return Promise.resolve(runtimeCatalog)
  }
  if (options.force !== true && lastStatsLoadAt && Date.now() - lastStatsLoadAt < PRODUCT_STATS_REFRESH_MS) {
    return Promise.resolve(runtimeCatalog)
  }
  if (statsLoadPromise && options.force !== true) return statsLoadPromise
  statsLoadPromise = callCloudApi('products.statsSnapshots', { ifVersion: statsVersion })
    .then(result => {
      const payload = result && result.success ? result.data : null
      if (!payload) return runtimeCatalog
      if (payload.notModified === true) {
        lastStatsLoadAt = Date.now()
        return runtimeCatalog
      }
      applyProductStats(payload)
      writeCachedProductStats(payload)
      return runtimeCatalog
    })
    .catch(() => runtimeCatalog)
    .finally(() => {
      statsLoadPromise = null
    })
  return statsLoadPromise
}

function isColorfulEgg(product) {
  if (!product) return false
  const colorfulTarget = followTargets.find(target => target.id === 'colorful_egg')
  return Boolean(
    colorfulTarget && product.product_id && colorfulTarget.product_ids.includes(product.product_id)
  ) || normalizeName(product.title).includes('炫彩蛋')
}

const initialCachedCatalog = readCachedCatalog()
applyCatalog(initialCachedCatalog || fallbackCatalog)
lastCloudLoadAt = Number(initialCachedCatalog && initialCachedCatalog._cachedAt || 0)
const initialCachedStats = readCachedProductStats()
if (initialCachedStats) applyProductStats(initialCachedStats)

module.exports = {
  advanceProductImage,
  buildImageCandidates,
  getAllProducts,
  getCatalogVersion,
  getFollowItems,
  getPrimaryProductOffer,
  getProductById,
  getProductByTitle,
  getProductOffers,
  isColorfulEgg,
  loadProductCatalog,
  loadProductStatsSnapshots,
  matchProduct,
  matchProductByName
}
