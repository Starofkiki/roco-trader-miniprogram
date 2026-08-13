const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
let pageConfig = null
global.Page = config => {
  pageConfig = config
}

require(path.join(ROOT, 'pages/products/index'))

const groups = pageConfig && pageConfig.data && pageConfig.data.groups
assert(Array.isArray(groups))
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
items.forEach(item => {
  assert.strictEqual('category' in item, false)
  assert.strictEqual('scoreText' in item, false)
  assert.strictEqual('rarityText' in item, false)
})

const context = {
  data: JSON.parse(JSON.stringify(pageConfig.data)),
  setData(nextData) {
    this.data = { ...this.data, ...nextData }
  }
}
assert.strictEqual(context.data.expandedProductGroup, '')
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '精灵蛋' } } })
assert.strictEqual(context.data.expandedProductGroup, '精灵蛋')
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '粉尘' } } })
assert.strictEqual(context.data.expandedProductGroup, '粉尘')
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '粉尘' } } })
assert.strictEqual(context.data.expandedProductGroup, '')
pageConfig.toggleProductGroup.call(context, { currentTarget: { dataset: { groupName: '重点商品' } } })
assert.strictEqual(context.data.expandedProductGroup, '')

const failedProduct = context.data.groups[0].items[0]
pageConfig.handleProductImageError.call(context, {
  currentTarget: { dataset: { productId: failedProduct.product_id, title: failedProduct.title } }
})
const failedCopies = context.data.groups.flatMap(group => group.items)
  .filter(item => item.product_id === failedProduct.product_id)
assert.strictEqual(failedCopies.length, 2)
assert(failedCopies.every(item => item.hasImage === true))
assert(failedCopies.every(item => item.imageCandidateIndex === 1))
assert(failedCopies.every(item => item.image === failedCopies[0].image))
while (context.data.groups.flatMap(group => group.items)
  .find(item => item.product_id === failedProduct.product_id).hasImage) {
  pageConfig.handleProductImageError.call(context, {
    currentTarget: { dataset: { productId: failedProduct.product_id, title: failedProduct.title } }
  })
}
assert(context.data.groups.flatMap(group => group.items)
  .filter(item => item.product_id === failedProduct.product_id)
  .every(item => item.hasImage === false))

const wxml = fs.readFileSync(path.join(ROOT, 'pages/products/index.wxml'), 'utf8')
assert(wxml.includes('wx:if="{{group.isFocus || expandedProductGroup === group.name}}"'))
assert(wxml.includes('binderror="handleProductImageError"'))

const pageSource = fs.readFileSync(path.join(ROOT, 'pages/products/index.js'), 'utf8')
assert(pageSource.includes('const initialCatalogVersion = getCatalogVersion()'))
assert(pageSource.includes('if (getCatalogVersion() === initialCatalogVersion) return'))

process.stdout.write('product list page tests passed\n')
