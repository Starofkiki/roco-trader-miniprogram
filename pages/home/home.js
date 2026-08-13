const { roundRanges } = require('../../utils/merchant-config')
const { callCloudApi } = require('../../utils/cloud-api')
const { SALE_GROUPS, attachGoodsMeta } = require('../../utils/goods-info')
const { advanceProductImage, loadProductCatalog, matchProduct } = require('../../utils/products')
const app = getApp()
const HOME_CACHE_KEY = 'merchant_home_cache_v1'
const ANNOUNCEMENT_CACHE_KEY = 'merchant_home_announcement_cache_v1_0_8'
const ANNOUNCEMENT_DISMISSED_VERSION_KEY = 'merchant_home_announcement_dismissed_version_v2'
const ANNOUNCEMENT_REFRESH_MS = 10 * 60 * 1000
const REMINDER_STATUS_REFRESH_MS = 5 * 60 * 1000
const VOTE_SUMMARY_REFRESH_MS = 2 * 60 * 1000
const ROUND_VOTE_OPTIONS = [
  {
    key: 'amazing',
    label: '了不起',
    image: '/assets/feedback/merchant-amazing-reference-small.png',
    reply: '这轮货看起来真不错！'
  },
  {
    key: 'great',
    label: '相当好',
    image: '/assets/feedback/merchant-good.png',
    reply: '远行商人这次还挺会带货。'
  },
  {
    key: 'good',
    label: '还不错',
    image: '/assets/feedback/merchant-not-bad.png',
    reply: '有点东西，可以看一眼。'
  },
  {
    key: 'normal',
    label: '一般般',
    image: '/assets/feedback/merchant-average.png',
    reply: '那就当作看看风景吧。'
  }
]

function applyDailyHotLimit(products) {
  const dailyHotCount = products.filter(product => product.saleGroup === SALE_GROUPS.dailyHot).length
  if (!dailyHotCount) return products

  const limit = dailyHotCount === 1 ? 200 : 100
  return products.map(product => {
    if (product.saleGroup !== SALE_GROUPS.dailyHot) return product
    return {
      ...product,
      buyLimit: limit,
      limitText: `限购 ${limit}`,
      limitBadgeText: `限购 ${limit}`
    }
  })
}

function normalizeAnnouncement(announcement = {}) {
  const content = String(announcement.content || '').trim()
  return {
    id: String(announcement.id || announcement.announcementId || '').trim(),
    title: String(announcement.title || '公告').trim() || '公告',
    content,
    enabled: announcement.enabled !== false,
    publishedAt: announcement.publishedAt || '',
    pinned: announcement.pinned === true,
    updatedAt: announcement.updatedAt || ''
  }
}

function readAnnouncementCacheState() {
  const cache = wx.getStorageSync(ANNOUNCEMENT_CACHE_KEY)
  if (!cache || !cache.announcement) return null
  return {
    announcement: normalizeAnnouncement(cache.announcement),
    updatedAt: Number(cache.updatedAt || 0)
  }
}

function writeAnnouncementCache(announcement) {
  wx.setStorageSync(ANNOUNCEMENT_CACHE_KEY, {
    announcement: normalizeAnnouncement(announcement),
    updatedAt: Date.now()
  })
}

function clearAnnouncementCache() {
  wx.removeStorageSync(ANNOUNCEMENT_CACHE_KEY)
}

function getAnnouncementVersion(announcement) {
  const id = announcement && announcement.id ? String(announcement.id) : 'legacy'
  const updatedAt = announcement && announcement.updatedAt
  if (!updatedAt) {
    return announcement && (announcement.title || announcement.content)
      ? `${id}:content:${announcement.title || ''}\n${announcement.content || ''}`
      : ''
  }
  if (typeof updatedAt === 'string' || typeof updatedAt === 'number') return `${id}:${updatedAt}`
  if (typeof updatedAt.getTime === 'function') return `${id}:${updatedAt.getTime()}`
  try {
    return `${id}:${JSON.stringify(updatedAt)}`
  } catch (error) {
    return `${id}:${String(updatedAt)}`
  }
}

function isAnnouncementDismissed(announcement) {
  const version = getAnnouncementVersion(announcement)
  return Boolean(version && wx.getStorageSync(ANNOUNCEMENT_DISMISSED_VERSION_KEY) === version)
}

function pad(num) {
  return String(num).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function normalizeHomeReminder(homeReminder) {
  if (!homeReminder || !homeReminder.type || !homeReminder.title || !homeReminder.text) return null
  return {
    type: homeReminder.type,
    title: homeReminder.title,
    text: homeReminder.text,
    actionText: homeReminder.actionText || '去关注页',
    updatedAt: homeReminder.updatedAt || '',
    statusKey: homeReminder.statusKey || `${homeReminder.type}|${homeReminder.updatedAt || ''}`
  }
}

function buildLocalHomeReminder(pushSettings = {}) {
  const followedIds = wx.getStorageSync(app.globalData.storageKey)
  const hasFollow = Array.isArray(followedIds) && followedIds.length > 0
  const reminderCount = Number(pushSettings.reminderCount || 0)
  const rejectedTemplateCount = Number(pushSettings.rejectedTemplateCount || 0)
  if (!hasFollow) {
    return {
      type: 'not_following',
      title: '还未设置关注商品',
      text: '去关注页选择商品并开启提醒',
      actionText: '去关注页',
      statusKey: 'not_following'
    }
  }
  if (rejectedTemplateCount > 0) {
    return {
      type: 'wechat_rejected',
      title: '关注提醒',
      text: `剩余 ${reminderCount} 次 · ${rejectedTemplateCount} 个通道需重新授权`,
      actionText: '去处理',
      statusKey: `wechat_rejected|${reminderCount}|${rejectedTemplateCount}`
    }
  }
  if (reminderCount > 0) {
    return {
      type: reminderCount <= 2 ? 'low_quota' : 'normal',
      title: '关注提醒',
      text: `剩余 ${reminderCount} 次`,
      actionText: '去关注页',
      statusKey: `quota|${reminderCount}`
    }
  }
  return {
    type: 'no_quota',
    title: '提醒次数已用完',
    text: '去关注页增加次数',
    actionText: '去增加',
    statusKey: 'no_quota'
  }
}

function formatCountdown(target, now) {
  const seconds = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function getRoundInfo() {
  const now = new Date()
  const hour = now.getHours()

  if (hour < 8) {
    const nextStart = new Date(now)
    nextStart.setHours(8, 0, 0, 0)
    return {
      isOpen: false,
      no: '',
      roundLabel: '当前状态',
      roundDisplay: '商人休息中',
      statusText: '商人休息中',
      rangeText: '00:00 - 07:59',
      countdownLabel: '距离第1轮刷新',
      countdown: formatCountdown(nextStart, now)
    }
  }

  const index = Math.floor((hour - 8) / 4)
  const round = roundRanges[index]
  const end = new Date(now)
  end.setHours(round.endHour, 59, 59, 999)

  return {
    isOpen: true,
    no: round.no,
    roundLabel: '当前轮次',
    roundDisplay: `第 ${round.no}/4 轮`,
    statusText: `当前轮次：第${round.no}/4轮`,
    rangeText: `${round.start} - ${round.end}`,
    countdownLabel: '剩余时间',
    countdown: formatCountdown(end, now)
  }
}

function getCurrentRoundKey(now = new Date()) {
  const hour = now.getHours()
  if (hour < 8) return 'inactive'
  const index = Math.floor((hour - 8) / 4)
  const round = roundRanges[index]
  return round ? `${formatDate(now)}_round_${round.no}` : 'inactive'
}

function getMerchantRoundKey(merchantInfo) {
  if (merchantInfo && merchantInfo.date && merchantInfo.round) {
    return `${merchantInfo.date}_round_${merchantInfo.round}`
  }
  return getCurrentRoundKey()
}

function getCurrentRoundExpiresAt(now = new Date()) {
  const hour = now.getHours()
  if (hour < 8) return 0
  const index = Math.floor((hour - 8) / 4)
  const round = roundRanges[index]
  if (!round) return 0

  const end = new Date(now)
  end.setHours(round.endHour, 59, 59, 999)
  return end.getTime()
}

function readHomeCache(options = {}) {
  const cache = wx.getStorageSync(HOME_CACHE_KEY)
  if (!cache || !cache.merchantInfo || !cache.roundKey || !cache.expiresAt) return null
  if (cache.roundKey !== getCurrentRoundKey()) return null
  if (!options.allowExpired && Date.now() >= Number(cache.expiresAt)) return null
  return cache.merchantInfo
}

function writeHomeCache(merchantInfo) {
  if (!merchantInfo || merchantInfo.status !== 'active' || !merchantInfo.round) return
  const hasItems = Array.isArray(merchantInfo.items) && merchantInfo.items.length > 0
  if (merchantInfo.pending !== true && !hasItems) return
  wx.setStorageSync(HOME_CACHE_KEY, {
    merchantInfo,
    roundKey: getCurrentRoundKey(),
    expiresAt: getCurrentRoundExpiresAt(),
    updatedAt: Date.now()
  })
}

function getRoundInfoFromMerchant(merchantInfo) {
  if (!merchantInfo) return getRoundInfo()

  const now = new Date()

  if (merchantInfo.status !== 'active' || !merchantInfo.round) {
    const nextStart = new Date(now)
    nextStart.setHours(8, 0, 0, 0)
    return {
      isOpen: false,
      no: '',
      roundLabel: '当前状态',
      roundDisplay: '商人休息中',
      statusText: '商人休息中',
      rangeText: merchantInfo.timeRange || '00:00 - 07:59',
      countdownLabel: '距离第1轮刷新',
      countdown: formatCountdown(nextStart, now)
    }
  }

  const round = roundRanges.find(item => item.no === merchantInfo.round)
  const end = new Date(now)
  end.setHours(round ? round.endHour : now.getHours(), 59, 59, 999)

  return {
    isOpen: true,
    no: merchantInfo.round,
    roundLabel: '当前轮次',
    roundDisplay: `第 ${merchantInfo.round}/4 轮`,
    statusText: `当前轮次：第${merchantInfo.round}/4轮`,
    rangeText: merchantInfo.timeRange || (round ? `${round.start} - ${round.end}` : ''),
    countdownLabel: '剩余时间',
    countdown: formatCountdown(end, now)
  }
}

function getProductType(category) {
  if (category === 'rare') return 'rare'
  if (category === 'limited') return 'limited'
  return 'normal'
}

function formatProduct(item, index) {
  const product = attachGoodsMeta(item)
  const productInfo = matchProduct(product)
  const saleGroup = product.saleGroup || SALE_GROUPS.normal
  const displayName = productInfo.is_unknown ? (product.name || productInfo.title) : productInfo.title
  const image = product.image || productInfo.image || (item && item.image) || ''
  return {
    ...product,
    id: product.id || `${product.name || 'item'}_${index}`,
    productInfo,
    rawName: product.name || '',
    name: displayName,
    detailTitle: productInfo.title,
    isUnknown: productInfo.is_unknown,
    type: productInfo.rarity === 'rare' ? 'rare' : getProductType(product.category),
    categoryText: productInfo.category || product.category || '商品',
    rarityText: productInfo.rarity === 'rare' ? '稀有商品' : '普通商品',
    saleGroup,
    icon: product.icon || (displayName ? displayName.slice(0, 1) : '物'),
    image,
    hasImage: Boolean(image),
    limitBadgeText: product.limitText || '限购未知',
    priceBadgeText: product.priceText || '未知'
  }
}

function normalizeVoteSummary(summary = {}) {
  const optionMap = {}
  ;(summary.options || []).forEach(option => {
    if (option && option.key) optionMap[option.key] = option
  })
  const myChoice = summary.myChoice || ''
  const total = Number(summary.total || 0)
  const options = ROUND_VOTE_OPTIONS.map(option => {
    const item = optionMap[option.key] || {}
    return {
      ...option,
      count: Number(item.count || 0),
      percent: Number(item.percent || 0),
      selected: myChoice === option.key || item.selected === true
    }
  })
  const selectedOption = options.find(option => option.key === myChoice)

  return {
    roundKey: summary.roundKey || '',
    total,
    hasVotes: total > 0,
    myChoice,
    hasMyChoice: Boolean(myChoice),
    selectedLabel: selectedOption ? selectedOption.label : '',
    selectedImage: selectedOption ? selectedOption.image : '',
    selectedReply: selectedOption ? selectedOption.reply : '',
    options
  }
}

function getProductPriority(product) {
  if (!product || product.saleGroup === SALE_GROUPS.normal) return 0
  if (product.saleGroup === SALE_GROUPS.dailyHot) return 1
  if (product.saleGroup === SALE_GROUPS.fixedHot) return 2
  return 3
}

function sortProductsForHome(products) {
  return (products || [])
    .map((product, index) => ({ product, index }))
    .sort((a, b) => {
      const priorityDiff = getProductPriority(a.product) - getProductPriority(b.product)
      return priorityDiff || a.index - b.index
    })
    .map(item => item.product)
}

function buildRoundShareTitle(roundInfo, products) {
  const names = (products || [])
    .map((product, index) => ({ product, index }))
    .sort((a, b) => {
      const priorityDiff = getProductPriority(a.product) - getProductPriority(b.product)
      return priorityDiff || a.index - b.index
    })
    .map(item => item.product && item.product.name)
    .filter(Boolean)
  const prefix = roundInfo && roundInfo.no ? `第${roundInfo.no}轮远行商人` : '远行商人当前商品'
  if (!names.length) return '洛克王国世界远行商人记录本'
  const visibleNames = names.slice(0, 4).join('、')
  const suffix = names.length > 4 ? `等${names.length}件` : ''
  return `${prefix}：${visibleNames}${suffix}`
}

Page({
  data: {
    roundInfo: getRoundInfo(),
    products: [],
    merchantInfo: null,
    merchantPending: false,
    announcementBarVisible: false,
    announcementId: '',
    announcementTitle: '',
    announcementPinned: false,
    announcementVersion: '',
    homeReminderVisible: false,
    homeReminderType: 'normal',
    homeReminderTitle: '',
    homeReminderText: '',
    homeReminderActionText: '去关注页',
    homeReminderStatusKey: '',
    voteSummary: normalizeVoteSummary(),
    voteLoading: false,
    voteSubmitting: false,
    votePendingChoice: '',
    voteVisible: false,
    voteExpanded: false
  },

  onShareAppMessage(options = {}) {
    const shareType = options.target && options.target.dataset
      ? options.target.dataset.shareType
      : ''
    if (options.from === 'button' && shareType === 'round') {
      return {
        title: buildRoundShareTitle(this.data.roundInfo, this.data.products),
        path: `/pages/home/home?roundKey=${this.currentRoundKey || getCurrentRoundKey()}`
      }
    }

    return {
      title: '洛克王国世界远行商人记录本',
      path: '/pages/home/home'
    }
  },

  onShareTimeline() {
    return {
      title: '洛克王国世界远行商人记录本'
    }
  },

  onShow() {
    this.loadHomeBootstrap()
    this.startCountdownTimer()
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.data.selected !== 0) {
      tabBar.setData({ selected: 0 })
    }
  },

  onHide() {
    this.stopCountdownTimer()
  },

  onUnload() {
    this.stopCountdownTimer()
  },

  onPullDownRefresh() {
    this.loadHomeBootstrap({ force: true })
      .finally(() => wx.stopPullDownRefresh())
  },

  getPendingMerchantRetryKey(now = new Date()) {
    const minute = now.getMinutes()
    const checkpoint = minute >= 10 ? 10 : (minute >= 5 ? 5 : (minute >= 3 ? 3 : 0))
    return checkpoint ? `${getCurrentRoundKey(now)}|${checkpoint}` : ''
  },

  shouldRetryPendingMerchant() {
    if (!this.data.merchantPending) return false
    const retryKey = this.getPendingMerchantRetryKey()
    return Boolean(retryKey && retryKey !== this.lastPendingMerchantRetryKey)
  },

  loadHomeBootstrap(options = {}) {
    const force = options.force === true
    const cachedMerchant = !force ? readHomeCache() : null
    const announcementState = readAnnouncementCacheState()
    const pushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    const now = Date.now()

    if (cachedMerchant) this.applyMerchantInfo(cachedMerchant)
    if (announcementState && announcementState.announcement.enabled && announcementState.announcement.content) {
      this.applyHomeAnnouncement(announcementState.announcement)
    }
    this.applyHomeReminder(pushSettings.homeReminder || buildLocalHomeReminder(pushSettings))

    const sections = []
    if (force || !cachedMerchant || this.shouldRetryPendingMerchant()) sections.push('merchant')
    if (force || !announcementState || now - announcementState.updatedAt >= ANNOUNCEMENT_REFRESH_MS) sections.push('announcement')
    if (force || now - Number(pushSettings.reminderStatusFetchedAt || 0) >= REMINDER_STATUS_REFRESH_MS) sections.push('subscription')
    if (force || getCurrentRoundKey() !== 'inactive' && now - Number(this.lastVoteSummaryAt || 0) >= VOTE_SUMMARY_REFRESH_MS) {
      sections.push('vote')
    }
    if (!sections.length) return Promise.resolve({ cached: true })
    if (this.homeBootstrapPromise) return this.homeBootstrapPromise

    this.homeBootstrapPromise = callCloudApi('home.bootstrap', { sections })
      .then(result => {
        if (!result || !result.success || !result.data) throw new Error('首页数据加载失败')
        const data = result.data
        if (data.catalogVersion) {
          app.globalData.catalogVersion = data.catalogVersion
          loadProductCatalog({ knownVersion: data.catalogVersion }).then(() => {
            if (this.data.merchantInfo) this.applyMerchantInfo(this.data.merchantInfo)
          })
        }
        app.globalData.statsVersion = data.statsVersion || app.globalData.statsVersion || ''
        app.globalData.isAdmin = data.isAdmin === true
        app.globalData.adminStatusFetched = true

        if (data.merchant) {
          this.lastPendingMerchantRetryKey = data.merchant.pending === true
            ? (this.getPendingMerchantRetryKey() || `${getCurrentRoundKey()}|initial`)
            : ''
          writeHomeCache(data.merchant)
          this.applyMerchantInfo(data.merchant)
        }
        if (data.announcement) {
          writeAnnouncementCache(data.announcement)
          this.applyHomeAnnouncement(data.announcement)
        } else if (sections.includes('announcement')) {
          clearAnnouncementCache()
          this.setData({ announcementBarVisible: false })
        }
        if (data.subscriptionStatus) this.applySubscriptionStatusToHome(data.subscriptionStatus)
        if (data.voteSummary) {
          this.voteSummaryRoundKey = data.voteSummary.roundKey || data.roundKey || ''
          this.lastVoteSummaryAt = Date.now()
          this.setData({ voteSummary: normalizeVoteSummary(data.voteSummary), voteLoading: false })
        }
        return data
      })
      .catch(error => {
        if (force) wx.showToast({ title: error.message || '首页刷新失败', icon: 'none' })
        return null
      })
      .finally(() => {
        this.homeBootstrapPromise = null
      })
    return this.homeBootstrapPromise
  },

  applySubscriptionStatusToHome(data = {}) {
    const latestPushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    wx.setStorageSync(app.globalData.pushSettingKey, {
      ...latestPushSettings,
      reminderCount: Number(data.reminderCount || 0),
      rejectedTemplateCount: Number(data.rejectedTemplateCount || 0),
      configuredTemplateCount: Number(data.configuredTemplateCount || 0),
      availableGrantCount: Number(data.availableGrantCount || 0),
      subscribeTemplates: data.templates || [],
      reminderIssue: data.reminderIssue || null,
      homeReminder: data.homeStatus || data.homeReminder || null,
      reminderStatusFetchedAt: Date.now(),
      updatedAt: Date.now()
    })
    this.applyHomeReminder(data.homeStatus || data.homeReminder || null)
  },

  applyHomeReminder(homeReminder) {
    const reminder = normalizeHomeReminder(homeReminder)
    if (!reminder) {
      this.setData({
        homeReminderVisible: false,
        homeReminderType: 'normal',
        homeReminderTitle: '',
        homeReminderText: '',
        homeReminderActionText: '去关注页',
        homeReminderStatusKey: ''
      })
      return
    }

    this.setData({
      homeReminderVisible: true,
      homeReminderType: reminder.type,
      homeReminderTitle: reminder.title,
      homeReminderText: reminder.text,
      homeReminderActionText: reminder.actionText,
      homeReminderStatusKey: reminder.statusKey
    })
  },

  openFollowPageFromReminder() {
    wx.switchTab({ url: '/pages/follow/follow' })
  },

  openProductDetail(e) {
    const productId = e.currentTarget.dataset.productId || ''
    const title = e.currentTarget.dataset.title || ''
    const saleGroup = e.currentTarget.dataset.saleGroup || ''
    const buyLimit = Number(e.currentTarget.dataset.buyLimit || 0)
    const productQuery = productId
      ? `product_id=${encodeURIComponent(productId)}`
      : `title=${encodeURIComponent(title)}`
    const saleGroupQuery = saleGroup
      ? `&sale_group=${encodeURIComponent(saleGroup)}`
      : ''
    const buyLimitQuery = buyLimit > 0 ? `&buy_limit=${buyLimit}` : ''
    wx.navigateTo({
      url: `/pages/product-detail/index?${productQuery}${saleGroupQuery}${buyLimitQuery}`
    })
  },

  handleProductImageError(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.products.length) return
    const nextImageState = advanceProductImage(this.data.products[index])
    this.setData({
      [`products[${index}].image`]: nextImageState.image,
      [`products[${index}].imageCandidateIndex`]: nextImageState.imageCandidateIndex,
      [`products[${index}].hasImage`]: nextImageState.hasImage
    })
  },

  applyHomeAnnouncement(value) {
    const announcement = normalizeAnnouncement(value)
    const version = getAnnouncementVersion(announcement)
    this.setData({
      announcementBarVisible: Boolean(announcement.content && !isAnnouncementDismissed(announcement)),
      announcementId: announcement.id,
      announcementTitle: announcement.title,
      announcementPinned: announcement.pinned,
      announcementVersion: version
    })
  },

  openHomeAnnouncement() {
    const id = String(this.data.announcementId || '').trim()
    const url = id && id !== 'home'
      ? `/pages/announcements/detail?id=${encodeURIComponent(id)}`
      : '/pages/announcements/announcements'
    wx.navigateTo({ url })
  },

  dismissHomeAnnouncement() {
    if (this.data.announcementVersion) {
      wx.setStorageSync(ANNOUNCEMENT_DISMISSED_VERSION_KEY, this.data.announcementVersion)
    }
    this.setData({ announcementBarVisible: false })
  },

  applyMerchantInfo(merchantInfo) {
    const previousRoundKey = this.currentRoundKey
    this.currentRoundKey = getMerchantRoundKey(merchantInfo)
    const roundInfo = getRoundInfoFromMerchant(merchantInfo)
    const products = roundInfo.isOpen && merchantInfo
      ? (merchantInfo.items || []).map(formatProduct)
      : []
    const displayProducts = sortProductsForHome(applyDailyHotLimit(products))
    const voteVisible = roundInfo.isOpen && displayProducts.length > 0

    this.setData({
      merchantInfo,
      merchantPending: Boolean(merchantInfo && merchantInfo.pending === true),
      products: displayProducts,
      roundInfo,
      voteVisible,
      ...(previousRoundKey && previousRoundKey !== this.currentRoundKey ? { voteExpanded: false } : {})
    })

    if (!voteVisible) {
      this.voteSummaryRoundKey = ''
      this.setData({
        voteSummary: normalizeVoteSummary(),
        voteLoading: false,
        voteSubmitting: false,
        voteExpanded: false
      })
    }
  },

  submitVote(e) {
    if (this.data.voteSubmitting || this.data.voteSummary.myChoice) return
    const choice = e.currentTarget.dataset.choice
    if (!choice || !this.currentRoundKey || this.currentRoundKey === 'inactive') return

    this.setData({
      voteSubmitting: true,
      votePendingChoice: choice
    })
    callCloudApi('merchant.voteSubmit', {
      roundKey: this.currentRoundKey,
      choice
    }).then(result => {
      if (!result || !result.success) {
        wx.showToast({
          title: (result && result.message) || '记录失败',
          icon: 'none'
        })
        return
      }

      if (result.data && result.data.summary) {
        this.lastVoteSummaryAt = Date.now()
        this.setData({
          voteSummary: normalizeVoteSummary(result.data.summary),
          voteExpanded: false
        })
      }
      wx.showToast({
        title: result.data && result.data.created === false ? '本轮已记录过' : '印象已记录',
        icon: 'none'
      })
    }).catch(() => {
      wx.showToast({ title: '记录失败', icon: 'none' })
    }).finally(() => {
      this.setData({
        voteSubmitting: false,
        votePendingChoice: ''
      })
    })
  },

  toggleVoteDistribution() {
    if (!this.data.voteSummary.myChoice) return
    this.setData({
      voteExpanded: !this.data.voteExpanded
    })
  },

  startCountdownTimer() {
    if (this.countdownTimer) return

    this.countdownTimer = setInterval(() => {
      this.updateRoundInfo()
    }, 1000)
  },

  stopCountdownTimer() {
    if (!this.countdownTimer) return

    clearInterval(this.countdownTimer)
    this.countdownTimer = null
  },

  updateRoundInfo() {
    const nextRoundKey = getCurrentRoundKey()
    if (this.currentRoundKey && nextRoundKey !== this.currentRoundKey) {
      this.currentRoundKey = nextRoundKey
      this.lastVoteSummaryAt = 0
      this.lastPendingMerchantRetryKey = ''
      this.loadHomeBootstrap({ force: true })
      return
    }

    const nextRoundInfo = getRoundInfoFromMerchant(this.data.merchantInfo)
    const currentRoundInfo = this.data.roundInfo || {}

    const sameRoundState = nextRoundInfo.no === currentRoundInfo.no &&
      nextRoundInfo.isOpen === currentRoundInfo.isOpen &&
      nextRoundInfo.statusText === currentRoundInfo.statusText &&
      nextRoundInfo.rangeText === currentRoundInfo.rangeText &&
      nextRoundInfo.countdownLabel === currentRoundInfo.countdownLabel

    if (sameRoundState && nextRoundInfo.countdown === currentRoundInfo.countdown) {
      return
    }

    if (sameRoundState) {
      this.setData({
        'roundInfo.countdown': nextRoundInfo.countdown
      })
      return
    }

    this.setData({ roundInfo: nextRoundInfo })
  }
})
