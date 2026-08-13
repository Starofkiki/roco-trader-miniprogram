const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const pagePath = path.join(ROOT, 'pages/product-detail/index.js')
const productsPath = path.join(ROOT, 'utils/products.js')
const cloudApiPath = path.join(ROOT, 'utils/cloud-api.js')
const historyStatsPath = path.join(ROOT, 'utils/product-history-stats.js')
const historyCachePath = path.join(ROOT, 'utils/history-cache.js')
const imageCachePath = path.join(ROOT, 'utils/product-image-cache.js')

let catalogVersion = 'catalog-v1'
let statsResolve = null
let currentProduct = {
  product_id: 'product_test',
  title: '测试商品',
  description: '介绍',
  obtain: '商店',
  image: 'cloud://primary.png',
  imageCandidates: ['cloud://primary.png', 'cloud://fallback.png'],
  imageCandidateIndex: 0,
  is_unknown: false
}

function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
}

installMock(productsPath, {
  advanceProductImage(product) {
    return {
      ...product,
      image: 'cloud://fallback.png',
      imageCandidateIndex: 1,
      hasImage: true
    }
  },
  getCatalogVersion: () => catalogVersion,
  getPrimaryProductOffer: () => null,
  getProductById: () => currentProduct,
  getProductByTitle: () => currentProduct,
  loadProductCatalog: () => Promise.resolve(),
  loadProductStatsSnapshots: () => new Promise(resolve => { statsResolve = resolve }),
  matchProductByName: () => currentProduct
})
installMock(cloudApiPath, { callCloudApi: () => Promise.resolve({ success: true, data: {} }) })
installMock(historyStatsPath, {
  buildProductDetailHistoryStats: product => ({ marker: product.appear_count_7d || 0 }),
  getCurrentRoundKey: () => '',
  getHistoryRefreshKey: () => ''
})
installMock(historyCachePath, {
  mergeHistoryRecords: () => ({ records: [], changed: false }),
  readHistoryCache: () => ({ records: [], metadata: {} }),
  writeHistoryCache() {}
})
installMock(imageCachePath, {
  ensureProductImageCached: () => Promise.resolve('saved-product.png'),
  getCachedProductImage: () => 'saved-product.png',
  getProductImageSource: product => String(product && product.image_file_id || ''),
  invalidateProductImageCache: () => Promise.resolve(false)
})

global.getApp = () => ({ globalData: { catalogVersion: 'catalog-v1', statsVersion: 'stats-v1' } })
global.wx = {
  getStorageSync: () => ({}),
  setStorageSync() {},
  setNavigationBarTitle() {}
}
let pageConfig = null
global.Page = config => { pageConfig = config }
require(pagePath)

function createContext() {
  const calls = []
  const context = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(value) {
      calls.push(value)
      Object.keys(value).forEach(key => {
        const pathParts = key.split('.')
        if (pathParts.length === 1) {
          this.data[key] = value[key]
          return
        }
        let target = this.data
        pathParts.slice(0, -1).forEach(pathPart => {
          if (!target[pathPart]) target[pathPart] = {}
          target = target[pathPart]
        })
        target[pathParts[pathParts.length - 1]] = value[key]
      })
    }
  }
  Object.keys(pageConfig).forEach(key => {
    if (typeof pageConfig[key] === 'function') context[key] = pageConfig[key]
  })
  return { context, calls }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

async function testUnchangedCatalogDoesNotRerenderProduct() {
  catalogVersion = 'catalog-v1'
  currentProduct = { ...currentProduct, appear_count_7d: 0 }
  const { context, calls } = createContext()
  assert.strictEqual(context.data.detailReady, false)
  context.onLoad({ product_id: 'product_test' })
  assert.strictEqual(context.data.detailReady, true)
  assert.strictEqual(calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product')).length, 1)

  context.handleProductImageError()
  assert.strictEqual(context.data.product.image, 'cloud://fallback.png')
  assert.strictEqual(calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product')).length, 1)
  currentProduct = { ...currentProduct, appear_count_7d: 9 }
  statsResolve()
  await flushPromises()

  assert.strictEqual(calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product')).length, 1)
  assert.strictEqual(context.data.product.image, 'cloud://fallback.png')
  assert.strictEqual(context.data.historyStats.marker, 9)
}

async function testChangedCatalogUpdatesOnlyChangedFields() {
  catalogVersion = 'catalog-v1'
  currentProduct = {
    ...currentProduct,
    description: '旧介绍',
    image: 'cloud://primary.png',
    imageCandidates: ['cloud://primary.png', 'cloud://fallback.png'],
    imageCandidateIndex: 0
  }
  const { context, calls } = createContext()
  context.onLoad({ product_id: 'product_test' })
  currentProduct = {
    ...currentProduct,
    description: '新介绍',
    image: 'cloud://new-primary.png',
    imageCandidates: ['cloud://new-primary.png', 'cloud://new-fallback.png'],
    imageCandidateIndex: 0
  }
  catalogVersion = 'catalog-v2'
  statsResolve()
  await flushPromises()
  assert.strictEqual(calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product')).length, 1)
  assert.strictEqual(context.data.product.description, '新介绍')
  assert.strictEqual(context.data.product.image, 'cloud://new-primary.png')
  assert.strictEqual(calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product.image')).length, 1)
}

async function testChangedCatalogPreservesWorkingFallbackImage() {
  catalogVersion = 'catalog-v1'
  currentProduct = {
    ...currentProduct,
    description: '旧介绍',
    image: 'cloud://primary.png',
    imageCandidates: ['cloud://primary.png', 'cloud://fallback.png'],
    imageCandidateIndex: 0
  }
  const { context, calls } = createContext()
  context.onLoad({ product_id: 'product_test' })
  context.handleProductImageError()
  const imageUpdateCount = calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product.image')).length
  currentProduct = { ...currentProduct, description: '目录新介绍' }
  catalogVersion = 'catalog-v2'
  statsResolve()
  await flushPromises()
  assert.strictEqual(context.data.product.image, 'cloud://fallback.png')
  assert.strictEqual(context.data.product.description, '目录新介绍')
  assert.strictEqual(
    calls.filter(call => Object.prototype.hasOwnProperty.call(call, 'product.image')).length,
    imageUpdateCount
  )
}

const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/product-detail/index.wxml'), 'utf8')
assert(detailWxml.includes('wx:if="{{detailReady}}"'))
assert(!detailWxml.includes('class="product-image" src="{{product.image}}" mode="aspectFit" lazy-load'))
assert(detailWxml.includes('class="coin-image" src="/assets/goods/roco_coin.png"'))
assert(!detailWxml.includes('product.fallbackIcon'))

Promise.resolve()
  .then(testUnchangedCatalogDoesNotRerenderProduct)
  .then(testChangedCatalogUpdatesOnlyChangedFields)
  .then(testChangedCatalogPreservesWorkingFallbackImage)
  .then(() => process.stdout.write('product detail render tests passed\n'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
