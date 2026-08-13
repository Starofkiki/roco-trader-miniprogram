const { callCloudApi } = require('../../utils/cloud-api')
const { getGoodsMeta, SALE_GROUPS } = require('../../utils/goods-info')
const {
  advanceProductImage,
  getCatalogVersion,
  getProductById,
  getProductByTitle,
  loadProductCatalog,
  loadProductStatsSnapshots,
  matchProductByName
} = require('../../utils/products')
const app = typeof getApp === 'function' ? getApp() : { globalData: {} }
const {
  buildProductDetailHistoryStats,
  getCurrentRoundKey,
  getHistoryRefreshKey
} = require('../../utils/product-history-stats')
const {
  mergeHistoryRecords,
  readHistoryCache,
  writeHistoryCache
} = require('../../utils/history-cache')
const {
  ensureProductImageCached,
  getCachedProductImage,
  getProductImageSource,
  invalidateProductImageCache
} = require('../../utils/product-image-cache')

const DETAIL_HISTORY_SYNC_KEY = 'product_detail_history_sync_v1'
const DETAIL_HISTORY_RETRY_MS = 10 * 60 * 1000
const TYPE_BY_SALE_GROUP = {
  [SALE_GROUPS.normal]: { key: 'normal', text: '常规商品' },
  [SALE_GROUPS.dailyHot]: { key: 'daily-hot', text: '三日热购球' },
  [SALE_GROUPS.fixedHot]: { key: 'fixed-hot', text: '三日固定限购' }
}

function normalizeSaleGroup(value) {
  return TYPE_BY_SALE_GROUP[value] ? value : SALE_GROUPS.normal
}

function buildDisplayProduct(product, saleGroup = '', buyLimitOverride = 0) {
  const title = product.title || '未知商品'
  const description = String(product.description || '').trim()
  const obtainItems = String(product.obtain || '')
    .split(/[;；]/)
    .map(item => item.trim())
    .filter(Boolean)
  const goodsMeta = getGoodsMeta(title)
  const resolvedSaleGroup = normalizeSaleGroup(saleGroup || goodsMeta.saleGroup)
  const type = TYPE_BY_SALE_GROUP[resolvedSaleGroup]
  const buyLimit = Number(buyLimitOverride || goodsMeta.buyLimit || 0)
  const price = Number(goodsMeta.price || 0)
  const imageSource = getProductImageSource(product)
  const displayImage = imageSource ? getCachedProductImage(product) : product.image

  return {
    ...product,
    title,
    description,
    obtainItems,
    typeKey: type.key,
    typeText: type.text,
    image: displayImage || '',
    hasImage: Boolean(displayImage),
    fallbackIcon: title.slice(0, 1),
    showDescription: Boolean(description),
    showObtain: obtainItems.length > 0,
    showInfoCard: Boolean(description || obtainItems.length),
    hasLimit: buyLimit > 0,
    limitText: buyLimit > 0 ? `限购 ${buyLimit}个` : '',
    hasPrice: price > 0,
    priceText: price > 0 ? `${goodsMeta.priceText || price}` : ''
  }
}

const DISPLAY_PRODUCT_FIELDS = [
  'product_id',
  'image_file_id',
  'image_url',
  'title',
  'description',
  'obtainItems',
  'typeKey',
  'typeText',
  'image',
  'imageCandidates',
  'imageCandidateIndex',
  'hasImage',
  'fallbackIcon',
  'showDescription',
  'showObtain',
  'showInfoCard',
  'hasLimit',
  'limitText',
  'hasPrice',
  'priceText'
]

function areDisplayValuesEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return false
}

function preserveCurrentProductImage(nextProduct, currentProduct) {
  const currentImage = String(currentProduct && currentProduct.image || '')
  const currentImageIndex = Number(currentProduct && currentProduct.imageCandidateIndex || 0)
  if (!currentImage || currentImageIndex <= 0) return nextProduct
  const nextCandidates = Array.isArray(nextProduct.imageCandidates) ? nextProduct.imageCandidates : []
  const nextImageIndex = nextCandidates.indexOf(currentImage)
  if (nextImageIndex < 0) return nextProduct
  return {
    ...nextProduct,
    image: currentImage,
    imageCandidateIndex: nextImageIndex,
    hasImage: true
  }
}

function buildDisplayProductUpdates(currentProduct, nextProduct) {
  return DISPLAY_PRODUCT_FIELDS.reduce((updates, field) => {
    if (!areDisplayValuesEqual(currentProduct && currentProduct[field], nextProduct[field])) {
      updates[`product.${field}`] = nextProduct[field]
    }
    return updates
  }, {})
}

function getRecordRoundKey(record) {
  return record && (record.roundKey || (record.date && record.round ? `${record.date}_round_${record.round}` : ''))
}

function hasHistoryRound(records, roundKey) {
  return Boolean(roundKey && (records || []).some(record => getRecordRoundKey(record) === roundKey))
}

Page({
  data: {
    detailReady: false,
    product: buildDisplayProduct(matchProductByName('')),
    historyStats: buildProductDetailHistoryStats(matchProductByName(''), [])
  },

  onLoad(options = {}) {
    this.pageUnloaded = false
    this.productId = decodeURIComponent(options.product_id || '')
    this.rawTitle = decodeURIComponent(options.title || '')
    this.saleGroup = decodeURIComponent(options.sale_group || '')
    this.buyLimit = Number(decodeURIComponent(options.buy_limit || '')) || 0
    const initialCatalogVersion = getCatalogVersion()
    this.renderProduct()
    this.refreshHistoryIfNeeded()
    Promise.all([
      loadProductCatalog({ knownVersion: app.globalData.catalogVersion }),
      loadProductStatsSnapshots({ knownVersion: app.globalData.statsVersion })
    ]).then(() => {
      if (getCatalogVersion() !== initialCatalogVersion) {
        this.renderProduct()
        return
      }
      this.currentProduct = this.getCurrentProduct()
      this.renderHistoryStats()
    })
  },

  onUnload() {
    this.pageUnloaded = true
  },

  getCurrentProduct() {
    return getProductById(this.productId) ||
      getProductByTitle(this.rawTitle) ||
      matchProductByName(this.rawTitle)
  },

  renderProduct() {
    const product = this.getCurrentProduct()
    const nextDisplayProduct = buildDisplayProduct(product, this.saleGroup, this.buyLimit)
    const displayProduct = this.data.detailReady
      ? preserveCurrentProductImage(nextDisplayProduct, this.data.product)
      : nextDisplayProduct
    this.currentProduct = product
    this.currentSaleGroup = displayProduct.typeKey
    const historyStats = buildProductDetailHistoryStats(product, readHistoryCache().records, {
      saleGroup: displayProduct.typeKey
    })
    if (!this.data.detailReady) {
      this.setData({
        detailReady: true,
        product: displayProduct,
        historyStats
      })
    } else {
      this.setData({
        ...buildDisplayProductUpdates(this.data.product, displayProduct),
        historyStats
      })
    }
    wx.setNavigationBarTitle({
      title: product.is_unknown ? '商品详情' : product.title
    })
    this.ensureProductImage(product)
  },

  ensureProductImage(product) {
    const imageSource = getProductImageSource(product)
    if (!imageSource) return Promise.resolve('')
    if (this.currentImageSource !== imageSource) this.imageCacheRetrySource = ''
    this.currentImageSource = imageSource
    return ensureProductImageCached(product).then(localPath => {
      if (!localPath || this.pageUnloaded || this.currentImageSource !== imageSource) return localPath
      if (this.data.product.image === localPath && this.data.product.hasImage) return localPath
      this.setData({
        'product.image': localPath,
        'product.hasImage': true
      })
      return localPath
    })
  },

  handleProductImageError() {
    const imageSource = getProductImageSource(this.currentProduct)
    if (imageSource) {
      this.setData({
        'product.image': '',
        'product.hasImage': false
      })
      const shouldRetry = this.imageCacheRetrySource !== imageSource
      this.imageCacheRetrySource = imageSource
      invalidateProductImageCache(imageSource)
        .then(() => shouldRetry ? this.ensureProductImage(this.currentProduct) : '')
      return
    }
    const nextImageState = advanceProductImage(this.data.product)
    this.setData({
      'product.image': nextImageState.image,
      'product.hasImage': nextImageState.hasImage,
      'product.imageCandidateIndex': nextImageState.imageCandidateIndex
    })
  },

  renderHistoryStats() {
    const product = this.currentProduct || this.getCurrentProduct()
    this.setData({
      historyStats: buildProductDetailHistoryStats(product, readHistoryCache().records, {
        saleGroup: this.currentSaleGroup || SALE_GROUPS.normal
      })
    })
  },

  refreshHistoryIfNeeded() {
    const refreshKey = getHistoryRefreshKey()
    const cache = readHistoryCache()
    const syncState = wx.getStorageSync(DETAIL_HISTORY_SYNC_KEY) || {}
    const recentlyChecked = syncState.roundKey === refreshKey &&
      Date.now() - Number(syncState.checkedAt || 0) < DETAIL_HISTORY_RETRY_MS

    if (!refreshKey || hasHistoryRound(cache.records, refreshKey) || recentlyChecked) return

    wx.setStorageSync(DETAIL_HISTORY_SYNC_KEY, {
      roundKey: refreshKey,
      checkedAt: Date.now()
    })
    callCloudApi('merchant.historyBundle', {
      ensureRoundKey: refreshKey,
      includeCurrent: true
    }).then(result => {
      if (!result || !result.success) return
      const resultData = result.data || {}
      const latestCache = readHistoryCache()
      const merged = mergeHistoryRecords(latestCache.records, resultData.records || [])
      const metadata = latestCache.metadata || {}
      writeHistoryCache(merged.records, {
        ...metadata,
        checkedUntilRoundKey: resultData.latestRoundKey || metadata.checkedUntilRoundKey || '',
        currentRoundKey: resultData.currentRoundKey || metadata.currentRoundKey || '',
        includedCurrentRoundKey: resultData.includedCurrentRoundKey || '',
        backfillBeforeRoundKey: resultData.oldestRoundKey || metadata.backfillBeforeRoundKey || '',
        lastSuccessfulRoundKey: resultData.includedCurrentRoundKey || resultData.latestRoundKey || metadata.lastSuccessfulRoundKey || ''
      })
      if (merged.changed) this.renderHistoryStats()
      if (hasHistoryRound(merged.records, refreshKey)) {
        wx.setStorageSync(DETAIL_HISTORY_SYNC_KEY, {
          roundKey: refreshKey,
          checkedAt: Date.now(),
          synced: true
        })
      }
    }).catch(() => {})
  }
})
