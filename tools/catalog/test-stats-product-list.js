const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const imageCachePath = path.join(ROOT, 'utils/product-image-cache.js')
require.cache[require.resolve(imageCachePath)] = {
  id: imageCachePath,
  filename: imageCachePath,
  loaded: true,
  exports: {
    ensureProductImageCached: () => Promise.resolve(''),
    getCachedProductImage: () => '',
    getProductImageSource: () => '',
    invalidateProductImageCache: () => Promise.resolve(false)
  }
}
let pageConfig = null
global.Page = config => {
  pageConfig = config
}

require(path.join(ROOT, 'pages/stats/stats'))

const context = {
  data: { productGroups: [] },
  setData(nextData) {
    Object.keys(nextData).forEach(key => {
      if (!key.includes('[') && !key.includes('.')) {
        this.data[key] = nextData[key]
        return
      }
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      parts.slice(0, -1).forEach(part => {
        target = target[part]
      })
      target[parts[parts.length - 1]] = nextData[key]
    })
  }
}
Object.keys(pageConfig).forEach(key => {
  if (typeof pageConfig[key] === 'function') context[key] = pageConfig[key]
})
pageConfig.loadStats.call(context)

const groups = context.data.productGroups
assert(Buffer.byteLength(JSON.stringify(groups), 'utf8') < 100 * 1024)
assert(groups.every(group => group.items.every(item => item.imageCandidates === undefined)))
assert.deepStrictEqual(groups.map(group => group.name), [
  '重点商品',
  '精灵蛋',
  '养成材料',
  '咕噜球',
  '血脉秘药',
  '矿石',
  '粉尘'
])
const items = groups.flatMap(group => group.items)
assert.strictEqual(items.length, 69)
assert.strictEqual(new Set(items.map(item => item.product_id)).size, 60)
assert.strictEqual(groups[0].items.length, 9)
assert(groups.find(group => group.name === '养成材料').items.some(item => item.title === '残缺魔镜'))
assert.deepStrictEqual(Object.fromEntries(groups.slice(1).map(group => [group.name, group.items.length])), {
  精灵蛋: 2,
  养成材料: 5,
  咕噜球: 11,
  血脉秘药: 20,
  矿石: 4,
  粉尘: 18
})
const ordinaryProductIds = new Set(groups.slice(1).flatMap(group => group.items.map(item => item.product_id)))
groups[0].items.forEach(item => assert(ordinaryProductIds.has(item.product_id)))

const groupState = name => context.data.productGroups.find(group => group.name === name)
assert.strictEqual(groupState('重点商品').isExpanded, true)
assert.strictEqual(groupState('重点商品').isLoaded, true)
assert.strictEqual(groupState('养成材料').isExpanded, false)
assert.strictEqual(groupState('养成材料').isLoaded, false)

pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '养成材料' } } })
assert.strictEqual(groupState('养成材料').isExpanded, true)
assert.strictEqual(groupState('养成材料').isLoaded, true)
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '血脉秘药' } } })
assert.strictEqual(groupState('养成材料').isExpanded, true)
assert.strictEqual(groupState('血脉秘药').isExpanded, true)
assert.strictEqual(groupState('血脉秘药').isLoaded, true)
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '血脉秘药' } } })
assert.strictEqual(groupState('养成材料').isExpanded, true)
assert.strictEqual(groupState('血脉秘药').isExpanded, false)
assert.strictEqual(groupState('血脉秘药').isLoaded, true)
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '重点商品' } } })
assert.strictEqual(groupState('重点商品').isExpanded, true)

pageConfig.loadStats.call(context)
assert.strictEqual(groupState('养成材料').isExpanded, true)
assert.strictEqual(groupState('养成材料').isLoaded, true)
assert.strictEqual(groupState('血脉秘药').isExpanded, false)
assert.strictEqual(groupState('血脉秘药').isLoaded, true)

const failedProduct = context.data.productGroups[0].items[0]
pageConfig.handleCatalogImageError.call(context, {
  currentTarget: { dataset: { productId: failedProduct.product_id, title: failedProduct.title } }
})
const failedCopies = context.data.productGroups.flatMap(group => group.items)
  .filter(item => item.product_id === failedProduct.product_id)
assert.strictEqual(failedCopies.length, 2)
assert(failedCopies.every(item => item.hasImage === true))
assert(failedCopies.every(item => item.image === failedCopies[0].image))
while (context.data.productGroups.flatMap(group => group.items)
  .find(item => item.product_id === failedProduct.product_id).hasImage) {
  pageConfig.handleCatalogImageError.call(context, {
    currentTarget: { dataset: { productId: failedProduct.product_id, title: failedProduct.title } }
  })
}
assert(context.data.productGroups.flatMap(group => group.items)
  .filter(item => item.product_id === failedProduct.product_id)
  .every(item => item.hasImage === false))

const wxml = fs.readFileSync(path.join(ROOT, 'pages/stats/stats.wxml'), 'utf8')
assert(wxml.includes('wx:if="{{group.isFocus || group.isLoaded}}"'))
assert(wxml.includes('hidden="{{!group.isFocus && !group.isExpanded}}"'))
assert(wxml.includes('hidden="{{activeTab !== \'history\'}}"'))
assert(wxml.includes('hidden="{{activeTab !== \'stats\'}}"'))
assert(!wxml.includes('wx:if="{{activeTab === \'stats\'}}"'))
assert(wxml.includes('binderror="handleCatalogImageError"'))
assert(!wxml.includes('catalog-fallback'))

process.stdout.write('stats product list tests passed\n')
