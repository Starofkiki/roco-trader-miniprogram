const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const sourceProducts = JSON.parse(fs.readFileSync(path.join(ROOT, 'rocom_target_items_with_scores.json'), 'utf8'))
const sourceOffers = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'RANDOM_GOODS_CONF.json'), 'utf8')).RocoDataRows || {})
const snapshot = require(path.join(ROOT, 'utils/product-data'))
const cloudSnapshot = require(path.join(ROOT, 'cloudfunctions/rocoApi/product-catalog-fallback'))
const adminCloudSnapshot = require(path.join(ROOT, 'cloudfunctions/rocoAdminApi/product-catalog-fallback'))
const products = require(path.join(ROOT, 'utils/products'))
const goodsInfo = require(path.join(ROOT, 'utils/goods-info'))
const inactiveProductTitles = [
  '黑白炫彩蛋',
  '赛季炫彩蛋',
  '织梦棱镜球',
  '捕光球',
  '高级咕噜球',
  '可可果球',
  '普通咕噜球',
  '万能血脉秘药',
  '魔法粉尘'
]

assert.strictEqual(sourceProducts.length, 67)
assert.strictEqual(snapshot.products.length, 69)
assert.strictEqual(new Set(snapshot.products.map(product => product.product_id)).size, snapshot.products.length)
assert.strictEqual(new Set(snapshot.products.map(product => product.title)).size, snapshot.products.length)
assert.strictEqual(snapshot.follow_targets.length, 11)
const fixedHotTarget = snapshot.follow_targets.find(item => item.id === 'fixed_hot_bundle')
assert(fixedHotTarget, 'missing fixed hot follow target')
const qualifiedKey = snapshot.products.find(item => item.title === '适格钥匙')
assert(qualifiedKey, 'missing qualified key product')
assert.strictEqual(fixedHotTarget.name, '钥匙镜子')
assert.strictEqual(fixedHotTarget.reminder_policy, 'weekly_friday_round_1')
assert.strictEqual(fixedHotTarget.display_product_id, qualifiedKey.product_id)
assert.deepStrictEqual(fixedHotTarget.keywords.slice().sort(), ['钥匙镜子', '三日固定限购', '残缺魔镜', '能力钥匙', '适格钥匙'].sort())
assert.deepStrictEqual(snapshot, cloudSnapshot)
assert.deepStrictEqual(snapshot, adminCloudSnapshot)

const removedProductFields = [
  'type_label',
  'tags',
  'page_url',
  'notes',
  'series_id',
  'external_ids',
  'schema_version',
  'source_index'
]
snapshot.products.forEach(product => {
  removedProductFields.forEach(field => assert.strictEqual(field in product, false, `${field} should not be in product`))
  assert.strictEqual(typeof product.status, 'string')
})
const activeProducts = snapshot.products.filter(product => product.status !== 'inactive')
assert.strictEqual(activeProducts.length, 60)
assert(activeProducts.every(product => product.image_file_id.startsWith('cloud://')), 'active products must use cloud images')
inactiveProductTitles.forEach(title => {
  const snapshotProduct = snapshot.products.find(product => product.title === title)
  assert(snapshotProduct, `missing inactive product ${title}`)
  assert.strictEqual(snapshotProduct.status, 'inactive')
  assert.strictEqual(products.getProductByTitle(title), null)
  assert.strictEqual(products.matchProductByName(title).is_unknown, true)
})
assert.strictEqual(products.getAllProducts().length, snapshot.products.length - inactiveProductTitles.length)
assert.strictEqual('schema_version' in snapshot, false)
assert(snapshot.offers.every(offer => !('schema_version' in offer)))

const sourceOfferIds = new Set(sourceOffers.map(offer => Number(offer.id)))
const generatedSourceOfferIds = new Set(snapshot.offers
  .map(offer => offer.source_row_id)
  .filter(value => value !== null)
  .map(Number))
assert.strictEqual(generatedSourceOfferIds.size, sourceOfferIds.size)
sourceOfferIds.forEach(id => assert(generatedSourceOfferIds.has(id), `missing source offer ${id}`))
assert(snapshot.offers.every(offer => offer.product_id), 'every offer must reference a product')

assert.strictEqual(products.matchProductByName('炫彩蛋').title, '炫彩精灵蛋')
assert.strictEqual(products.matchProductByName('黑白炫彩精灵蛋').is_unknown, true)
assert.strictEqual(products.matchProductByName('赛季炫彩精灵蛋').is_unknown, true)
assert.strictEqual(products.matchProductByName('国王咕噜球').title, '国王球')
assert.strictEqual(products.matchProductByName('织梦棱镜球').is_unknown, true)
assert.strictEqual(products.matchProductByName('炼金材料').is_unknown, true)
assert.strictEqual(products.matchProductByName('特制咕噜球').is_unknown, true)
assert.strictEqual(products.matchProductByName('未收录测试').is_unknown, true)

const colorfulTarget = products.getFollowItems().find(target => target.id === 'colorful_egg')
assert(colorfulTarget)
assert(colorfulTarget.keywords.includes('炫彩精灵蛋'))
assert.strictEqual(colorfulTarget.keywords.includes('黑白炫彩蛋'), false)
assert.strictEqual(colorfulTarget.keywords.includes('赛季炫彩蛋'), false)
assert.strictEqual(products.getFollowItems().find(target => target.id === 'prism_ball').all_day, true)
const runtimeFollowItems = products.getFollowItems()
const runtimeFixedHotTarget = runtimeFollowItems.find(target => target.id === 'fixed_hot_bundle')
const runtimeQualifiedKey = products.getProductByTitle('适格钥匙')
assert(runtimeFixedHotTarget && runtimeQualifiedKey)
assert.strictEqual(runtimeFixedHotTarget.name, '钥匙镜子')
assert.strictEqual(runtimeFixedHotTarget.display_product_id, runtimeQualifiedKey.product_id)
const attachedFixedHotTarget = goodsInfo.attachGoodsMeta({
  ...runtimeFixedHotTarget,
  product_id: runtimeFixedHotTarget.display_product_id
})
assert.strictEqual(attachedFixedHotTarget.product_id, runtimeQualifiedKey.product_id)
assert.strictEqual(attachedFixedHotTarget.image, runtimeQualifiedKey.image)
assert(runtimeFollowItems.findIndex(target => target.group === 'other') >
  runtimeFollowItems.map(target => target.group).lastIndexOf('recommended'))

const cloudImagePrefix = 'https://env-00jxhb62nv6n.normal.cloudstatic.cn/'
assert(goodsInfo.getGoodsImage('血脉秘药').startsWith(cloudImagePrefix))
assert(goodsInfo.getGoodsImage('粉尘').startsWith(cloudImagePrefix))
assert(goodsInfo.getGoodsImage('矿石').startsWith(cloudImagePrefix))
assert.strictEqual(goodsInfo.attachGoodsMeta({ name: '血脉秘药' }).hasImage, true)
assert.strictEqual(goodsInfo.attachGoodsMeta({ name: '粉尘' }).hasImage, true)
assert.strictEqual(goodsInfo.attachGoodsMeta({ name: '矿石' }).hasImage, true)
const ordinaryDust = products.matchProductByName('普通粉尘')
assert(ordinaryDust.image.startsWith('cloud://'))
assert(ordinaryDust.imageCandidates[0].startsWith('cloud://'))
assert(ordinaryDust.imageCandidates.some(image => image.startsWith('https://wiki.biligame.com/')))
const ordinaryDustFallback = products.advanceProductImage({ ...ordinaryDust, hasImage: true })
assert(ordinaryDustFallback.image.startsWith(cloudImagePrefix))
const ordinaryDustExternal = products.advanceProductImage(ordinaryDustFallback)
assert(ordinaryDustExternal.image.startsWith('https://wiki.biligame.com/'))
assert.strictEqual(products.advanceProductImage(ordinaryDustExternal).hasImage, false)
assert(products.matchProductByName('光合球').image.includes('/share-goods/800b4e018e9b4ee6a6abf48d379d0d4de0ca65de.png'))
const sourceCloudImage = `${cloudImagePrefix}source-priority-test.png`
const attachedBloodPotion = goodsInfo.attachGoodsMeta({ name: '火系血脉秘药', image: sourceCloudImage })
assert(attachedBloodPotion.image.startsWith('cloud://'))
assert(attachedBloodPotion.imageCandidates.includes(sourceCloudImage))

const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/product-detail/index.wxml'), 'utf8')
const homeWxml = fs.readFileSync(path.join(ROOT, 'pages/home/home.wxml'), 'utf8')
const followWxml = fs.readFileSync(path.join(ROOT, 'pages/follow/follow.wxml'), 'utf8')
assert(detailWxml.includes('binderror="handleProductImageError"'))
assert(homeWxml.includes('binderror="handleProductImageError"'))
assert(followWxml.includes('binderror="handleFollowImageError"'))
assert(followWxml.includes('lazy-load'))
assert(followWxml.includes('wx:for="{{followItems}}"'))
;['>已关注<', '>推荐关注<', '>其他商品<', 'savedItems', 'recommendedItems', 'otherItems']
  .forEach(value => assert.strictEqual(followWxml.includes(value), false, `obsolete follow markup: ${value}`))

process.stdout.write(`product catalog tests passed: ${snapshot.products.length} products, ${snapshot.offers.length} offers\n`)
