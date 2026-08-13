const {
  advanceProductImage,
  getAllProducts,
  getCatalogVersion,
  getFollowItems,
  loadProductCatalog
} = require('../../utils/products')

const GROUP_ORDER = ['重点商品', '精灵蛋', '养成材料', '咕噜球', '血脉秘药', '矿石', '粉尘']

function normalizeCategory(category) {
  return category === '养成道具' ? '养成材料' : category
}

function buildProductCard(product) {
  return {
    product_id: product.product_id || '',
    title: product.title || '未知商品',
    image: product.image || '',
    imageCandidates: product.imageCandidates || [],
    imageCandidateIndex: Number(product.imageCandidateIndex || 0),
    hasImage: Boolean(product.image),
    fallbackIcon: (product.title || '物').slice(0, 1)
  }
}

function buildProductGroups() {
  const products = getAllProducts()
  const recommendedIds = new Set(getFollowItems()
    .filter(item => item.group === 'recommended')
    .flatMap(item => item.product_ids || []))
  const focusIds = new Set(products
    .filter(product => product.rarity === 'rare' || recommendedIds.has(product.product_id))
    .map(product => product.product_id))

  return GROUP_ORDER.map(name => {
    const items = name === '重点商品'
      ? products.filter(product => focusIds.has(product.product_id))
      : products.filter(product => {
        return normalizeCategory(product.category) === name
      })
    return {
      name,
      isFocus: name === '重点商品',
      items: items.map(buildProductCard)
    }
  }).filter(group => group.items.length > 0)
}

Page({
  data: {
    groups: buildProductGroups(),
    expandedProductGroup: ''
  },

  onLoad() {
    const initialCatalogVersion = getCatalogVersion()
    loadProductCatalog().then(() => {
      if (getCatalogVersion() === initialCatalogVersion) return
      this.setData({ groups: buildProductGroups() })
    })
  },

  onShareAppMessage() {
    return {
      title: '远行商人商品清单',
      path: '/pages/products/index'
    }
  },

  onShareTimeline() {
    return {
      title: '远行商人商品清单'
    }
  },

  toggleProductGroup(e) {
    const groupName = e.currentTarget.dataset.groupName || ''
    if (!groupName || groupName === GROUP_ORDER[0]) return
    this.setData({
      expandedProductGroup: this.data.expandedProductGroup === groupName ? '' : groupName
    })
  },

  handleProductImageError(e) {
    const productId = e.currentTarget.dataset.productId || ''
    const title = e.currentTarget.dataset.title || ''
    if (!productId && !title) return
    const currentItem = this.data.groups
      .flatMap(group => group.items)
      .find(item => productId ? item.product_id === productId : item.title === title)
    if (!currentItem) return
    const nextImageState = advanceProductImage(currentItem)
    const groups = this.data.groups.map(group => ({
      ...group,
      items: group.items.map(item => {
        const matched = productId ? item.product_id === productId : item.title === title
        return matched ? {
          ...item,
          image: nextImageState.image,
          imageCandidateIndex: nextImageState.imageCandidateIndex,
          hasImage: nextImageState.hasImage
        } : item
      })
    }))
    this.setData({ groups })
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
