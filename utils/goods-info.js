const { buildImageCandidates, getPrimaryProductOffer, matchProduct, matchProductByName } = require('./products')
const { IMAGE_BY_NAME } = require('./goods-image-catalog')

const SALE_GROUPS = {
  fixedHot: 'fixed-hot',
  dailyHot: 'daily-hot',
  normal: 'normal'
}

function normalizeName(name) {
  return String(name || '').trim()
}

function getGoodsImage(name) {
  const product = matchProductByName(name)
  return product.is_unknown ? (IMAGE_BY_NAME[normalizeName(name)] || '') : product.image
}

function isFixedHotSaleName(name) {
  const product = matchProductByName(name)
  const offer = product.is_unknown ? null : getPrimaryProductOffer(product.product_id)
  return Boolean(offer && offer.sale_group === SALE_GROUPS.fixedHot)
}

function isConditionBallName(name) {
  const normalized = normalizeName(name)
  const product = matchProductByName(normalized)
  if (!product.is_unknown) {
    const offer = getPrimaryProductOffer(product.product_id)
    return Boolean(offer && offer.sale_group === SALE_GROUPS.dailyHot)
  }
  return normalized.endsWith('球')
}

function getSaleGroup(name) {
  const product = matchProductByName(name)
  const offer = product.is_unknown ? null : getPrimaryProductOffer(product.product_id)
  if (offer && offer.sale_group) return offer.sale_group
  if (isConditionBallName(name)) return SALE_GROUPS.dailyHot
  return SALE_GROUPS.normal
}

function formatGold(price) {
  const value = Number(price || 0)
  if (!value) return ''
  if (value >= 10000 && value % 10000 === 0) {
    return `${value / 10000}万`
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function getGoodsMeta(name) {
  const normalized = normalizeName(name)
  const product = matchProductByName(normalized)
  const productOffer = product.is_unknown ? null : getPrimaryProductOffer(product.product_id)
  const shouldUseBallFallback = !productOffer && isConditionBallName(normalized)
  const row = productOffer || (shouldUseBallFallback
    ? {
      price: 3000,
      buy_limit: 100,
      sale_group: SALE_GROUPS.dailyHot
    }
    : null)
  const priceText = row ? formatGold(row.price) : ''
  const limit = row ? Number(row.buy_limit || 0) : 0
  const limitText = limit ? `限购 ${limit}` : ''

  return {
    image: getGoodsImage(name),
    price: row ? Number(row.price || 0) : 0,
    priceText,
    buyLimit: limit,
    limitText,
    saleGroup: row && row.sale_group ? row.sale_group : getSaleGroup(name),
    goodsInfoText: [priceText ? `${priceText}洛克贝` : '', limitText].filter(Boolean).join(' · ')
  }
}

function attachGoodsMeta(item) {
  const source = item || {}
  const product = matchProduct(source)
  const meta = getGoodsMeta(product.is_unknown ? source.name : product.title)
  const sourceImage = source.image || source.icon_url || ''
  const imageCandidates = buildImageCandidates(
    product.image_file_id,
    product.image_url,
    product.image,
    [sourceImage, meta.image].concat(product.imageCandidates || [])
  )
  const image = imageCandidates[0] || ''
  return {
    ...item,
    ...meta,
    product_id: product.product_id || source.product_id || '',
    image,
    imageCandidates,
    imageCandidateIndex: 0,
    hasImage: Boolean(image)
  }
}

module.exports = {
  SALE_GROUPS,
  attachGoodsMeta,
  getGoodsImage,
  getGoodsMeta,
  getSaleGroup,
  isConditionBallName,
  isFixedHotSaleName
}
