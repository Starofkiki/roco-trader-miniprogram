const { callCloudApi, callAdminApi } = require('../../utils/cloud-api')

const TABS = [
  { key: 'manual', label: '人工兜底', short: '兜底' },
  { key: 'notify', label: '重点推送', short: '推送' },
  { key: 'notice', label: '公告管理', short: '公告' },
  { key: 'feedback', label: '用户反馈', short: '反馈' },
  { key: 'overview', label: '订阅概览', short: '概览' }
]

function formatDateTime(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function getResultError(result, fallback) {
  return result && result.message ? result.message : fallback
}

function showConfirm(content, title = '请确认') {
  return new Promise(resolve => {
    wx.showModal({
      title,
      content,
      confirmColor: '#b87913',
      success: result => resolve(result.confirm === true),
      fail: () => resolve(false)
    })
  })
}

function normalizeCurrent(data = {}) {
  return {
    roundKey: data.roundKey || '',
    round: Number(data.round || 0),
    timeRange: data.timeRange || '',
    status: data.status || 'inactive',
    hasData: data.hasData === true,
    source: data.source || '',
    sourceText: data.source === 'admin_manual' ? '人工兜底已锁定' : (data.hasData ? '远程/历史数据' : '尚无数据'),
    manualOverride: data.manualOverride === true,
    manualAtText: formatDateTime(data.manualAt),
    timeMetaText: `${data.timeRange || ''}${data.manualOverride === true ? ` · ${formatDateTime(data.manualAt)}` : ''}`,
    items: (data.items || []).map(item => ({
      ...item,
      productId: item.product_id || '',
      image: item.image || ''
    }))
  }
}

function decorateProducts(products, selectedIds, query = '') {
  const selectedSet = new Set(selectedIds || [])
  const normalizedQuery = String(query || '').trim().toLowerCase()
  return (products || []).map(product => ({
    ...product,
    productId: product.product_id,
    image: product.image_file_id || product.image_url || '',
    icon: String(product.title || '商').slice(0, 1),
    selected: selectedSet.has(product.product_id)
  })).filter(product => {
    if (!normalizedQuery) return true
    const searchText = [product.title].concat(product.aliases || []).join('|').toLowerCase()
    return searchText.includes(normalizedQuery)
  })
}

Page({
  data: {
    tabs: TABS,
    activeTab: 'manual',
    authChecking: true,
    isAdmin: false,
    pageLoading: false,
    actionLoading: false,
    current: normalizeCurrent(),
    catalog: [],
    filteredProducts: [],
    productQuery: '',
    selectedProductIds: [],
    overwriteCurrent: false,
    notifyProductId: '',
    notifyPreview: null,
    overview: {
      totalFollowUsers: 0,
      usersWithRemaining: 0,
      colorfulEggFollowers: 0,
      kingBallFollowers: 0,
      prismBallFollowers: 0,
      totalRemainingQuota: 0,
      unavailableUsers: 0
    },
    announcements: [],
    noticeTitle: '',
    noticeContent: '',
    noticePinned: false,
    editingNoticeId: '',
    feedbackItems: [],
    feedbackPage: 1,
    feedbackCursor: '',
    feedbackHasMore: false,
    feedbackStatus: 'all'
  },

  onLoad() {
    this.verifyAdmin()
  },

  verifyAdmin() {
    const app = getApp()
    if (app.globalData.adminStatusFetched === true) {
      const isAdmin = app.globalData.isAdmin === true
      this.setData({ isAdmin, authChecking: false })
      if (!isAdmin) {
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      this.loadDashboard()
      return
    }
    callAdminApi('admin.status').then(result => {
      const isAdmin = Boolean(result && result.success && result.data && result.data.isAdmin)
      app.globalData.adminStatusFetched = true
      app.globalData.isAdmin = isAdmin
      this.setData({ isAdmin, authChecking: false })
      if (!isAdmin) {
        wx.showToast({ title: '无管理员权限', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      this.loadDashboard()
    })
  },

  loadDashboard() {
    this.setData({ pageLoading: true })
    Promise.all([
      this.loadCurrent(),
      this.loadCatalog(),
      this.loadOverview(),
      this.loadAnnouncements(),
      this.loadFeedback(true)
    ]).finally(() => this.setData({ pageLoading: false }))
  },

  switchTab(event) {
    const key = event.currentTarget.dataset.key
    if (key) this.setData({ activeTab: key })
  },

  loadCurrent() {
    return callAdminApi('admin.current.get').then(result => {
      if (!result || !result.success) return
      const current = normalizeCurrent(result.data)
      this.setData({
        current,
        notifyProductId: current.items.some(item => item.productId === this.data.notifyProductId)
          ? this.data.notifyProductId
          : '',
        notifyPreview: null
      })
    })
  },

  loadCatalog() {
    return callCloudApi('products.catalog').then(result => {
      if (!result || !result.success) return
      const catalog = (result.data && result.data.products || []).filter(product => product.status !== 'inactive')
      this.setData({
        catalog,
        filteredProducts: decorateProducts(catalog, this.data.selectedProductIds, this.data.productQuery)
      })
    })
  },

  onProductSearch(event) {
    const productQuery = event.detail.value || ''
    this.setData({
      productQuery,
      filteredProducts: decorateProducts(this.data.catalog, this.data.selectedProductIds, productQuery)
    })
  },

  toggleProduct(event) {
    const productId = event.currentTarget.dataset.id
    if (!productId) return
    const selected = new Set(this.data.selectedProductIds)
    if (selected.has(productId)) selected.delete(productId)
    else selected.add(productId)
    const selectedProductIds = Array.from(selected)
    this.setData({
      selectedProductIds,
      filteredProducts: decorateProducts(this.data.catalog, selectedProductIds, this.data.productQuery)
    })
  },

  onOverwriteChange(event) {
    this.setData({ overwriteCurrent: event.detail.value === true })
  },

  async saveManualCurrent() {
    if (this.data.actionLoading) return
    if (!this.data.current.roundKey) {
      wx.showToast({ title: '当前不在开放轮次', icon: 'none' })
      return
    }
    if (!this.data.selectedProductIds.length) {
      wx.showToast({ title: '请至少选择一个商品', icon: 'none' })
      return
    }
    if (this.data.current.hasData && !this.data.overwriteCurrent) {
      wx.showToast({ title: '请先开启覆盖确认', icon: 'none' })
      return
    }
    const names = this.data.catalog
      .filter(product => this.data.selectedProductIds.includes(product.product_id))
      .map(product => product.title)
    const confirmed = await showConfirm(
      `将用「${names.join('、')}」覆盖 ${this.data.current.roundKey}，并锁定到本轮结束。是否继续？`,
      '保存人工兜底'
    )
    if (!confirmed) return

    this.setData({ actionLoading: true })
    const result = await callAdminApi('admin.current.saveManual', {
      roundKey: this.data.current.roundKey,
      productIds: this.data.selectedProductIds,
      overwrite: this.data.overwriteCurrent
    })
    this.setData({ actionLoading: false })
    if (!result || !result.success) {
      wx.showToast({ title: getResultError(result, '保存失败'), icon: 'none' })
      return
    }
    wx.showToast({ title: '本轮已锁定', icon: 'success' })
    this.setData({ overwriteCurrent: false, selectedProductIds: [] })
    await this.loadCurrent()
    this.setData({ filteredProducts: decorateProducts(this.data.catalog, [], this.data.productQuery) })
  },

  selectNotifyProduct(event) {
    const productId = event.currentTarget.dataset.id || ''
    this.setData({ notifyProductId: productId, notifyPreview: null })
  },

  previewNotification() {
    if (!this.data.notifyProductId || !this.data.current.roundKey || this.data.actionLoading) return
    this.setData({ actionLoading: true, notifyPreview: null })
    callAdminApi('admin.notification.preview', {
      roundKey: this.data.current.roundKey,
      productId: this.data.notifyProductId
    }).then(result => {
      if (!result || !result.success) {
        wx.showToast({ title: getResultError(result, '预览失败'), icon: 'none' })
        return
      }
      this.setData({ notifyPreview: result.data })
    }).finally(() => this.setData({ actionLoading: false }))
  },

  async sendNotification() {
    const preview = this.data.notifyPreview
    if (!preview || this.data.actionLoading) return
    const confirmed = await showConfirm(
      `本次将向关注${preview.itemName}且仍有提醒次数的用户发送提醒，当前预计可发送 ${preview.eligibleCount} 人，是否确认？`,
      '二次确认'
    )
    if (!confirmed) return
    this.setData({ actionLoading: true })
    const result = await callAdminApi('admin.notification.send', {
      roundKey: this.data.current.roundKey,
      productId: this.data.notifyProductId,
      confirmSend: true
    })
    this.setData({ actionLoading: false })
    if (!result || !result.success) {
      wx.showToast({ title: getResultError(result, '发送失败'), icon: 'none' })
      return
    }
    const notification = result.data && result.data.notification || {}
    wx.showModal({
      title: '推送处理完成',
      content: `成功 ${Number(notification.sent || 0)}，待处理 ${Number(notification.pending || 0)}，失败 ${Number(notification.failed || 0)}。`,
      showCancel: false,
      confirmColor: '#b87913'
    })
    this.setData({ notifyPreview: null })
    this.loadOverview()
  },

  loadOverview() {
    return callAdminApi('admin.overview').then(result => {
      if (result && result.success) this.setData({ overview: result.data || {} })
    })
  },

  loadAnnouncements() {
    return callAdminApi('admin.announcements.list', { page: 1, pageSize: 50 }).then(result => {
      if (!result || !result.success) return
      const announcements = (result.data.items || []).map(item => ({
        ...item,
        timeText: formatDateTime(item.publishedAt)
      }))
      this.setData({ announcements })
    })
  },

  onNoticeTitle(event) {
    this.setData({ noticeTitle: event.detail.value })
  },

  onNoticeContent(event) {
    this.setData({ noticeContent: event.detail.value })
  },

  onNoticePinned(event) {
    this.setData({ noticePinned: event.detail.value === true })
  },

  editNotice(event) {
    const item = this.data.announcements.find(notice => notice.id === event.currentTarget.dataset.id)
    if (!item) return
    this.setData({
      editingNoticeId: item.id,
      noticeTitle: item.title,
      noticeContent: item.content,
      noticePinned: item.pinned === true
    })
  },

  cancelNoticeEdit() {
    this.setData({ editingNoticeId: '', noticeTitle: '', noticeContent: '', noticePinned: false })
  },

  async saveNotice() {
    if (this.data.actionLoading) return
    const title = this.data.noticeTitle.trim()
    const content = this.data.noticeContent.trim()
    if (!title || !content) {
      wx.showToast({ title: '请填写标题和正文', icon: 'none' })
      return
    }
    const editing = Boolean(this.data.editingNoticeId)
    const confirmed = await showConfirm(
      editing ? '保存后会同步更新普通用户可见的公告内容。' : '发布后普通用户可在首页和历史公告页看到这条公告。',
      editing ? '编辑公告' : '发布公告'
    )
    if (!confirmed) return
    this.setData({ actionLoading: true })
    const result = await callAdminApi(editing ? 'admin.announcements.update' : 'admin.announcements.create', {
      id: this.data.editingNoticeId,
      title,
      content,
      pinned: this.data.noticePinned
    })
    this.setData({ actionLoading: false })
    if (!result || !result.success) {
      wx.showToast({ title: getResultError(result, '保存失败'), icon: 'none' })
      return
    }
    wx.showToast({ title: editing ? '公告已更新' : '公告已发布', icon: 'success' })
    this.cancelNoticeEdit()
    this.loadAnnouncements()
  },

  async toggleNoticeDeleted(event) {
    const id = event.currentTarget.dataset.id
    const deleted = event.currentTarget.dataset.deleted === true || event.currentTarget.dataset.deleted === 'true'
    const confirmed = await showConfirm(deleted ? '恢复后普通用户会重新看到这条公告。' : '删除采用可恢复方式，普通用户将立即看不到这条公告。', deleted ? '恢复公告' : '删除公告')
    if (!confirmed) return
    this.setData({ actionLoading: true })
    const result = await callAdminApi(deleted ? 'admin.announcements.restore' : 'admin.announcements.delete', { id })
    this.setData({ actionLoading: false })
    if (!result || !result.success) {
      wx.showToast({ title: getResultError(result, '操作失败'), icon: 'none' })
      return
    }
    this.loadAnnouncements()
  },

  setFeedbackStatus(event) {
    const status = event.currentTarget.dataset.status || 'all'
    this.setData({ feedbackStatus: status })
    this.loadFeedback(true)
  },

  loadFeedback(reset = false) {
    const page = reset ? 1 : this.data.feedbackPage + 1
    return callAdminApi('admin.feedback.list', {
      page,
      pageSize: 20,
      cursor: reset ? '' : this.data.feedbackCursor,
      status: this.data.feedbackStatus
    }).then(result => {
      if (!result || !result.success) return
      const items = (result.data.items || []).map(item => ({
        ...item,
        handled: item.status === 'handled',
        timeText: formatDateTime(item.createdAt)
      }))
      this.setData({
        feedbackItems: reset ? items : this.data.feedbackItems.concat(items),
        feedbackPage: page,
        feedbackCursor: result.data.nextCursor || '',
        feedbackHasMore: result.data.hasMore === true
      })
    })
  },

  loadMoreFeedback() {
    if (this.data.feedbackHasMore) this.loadFeedback(false)
  },

  onFeedbackHandled(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ [`feedbackItems[${index}].handled`]: event.detail.value === true })
  },

  onFeedbackNote(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ [`feedbackItems[${index}].adminNote`]: event.detail.value })
  },

  onFeedbackReply(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ [`feedbackItems[${index}].publicReply`]: event.detail.value })
  },

  saveFeedback(event) {
    const index = Number(event.currentTarget.dataset.index)
    const item = this.data.feedbackItems[index]
    if (!item || this.data.actionLoading) return
    this.setData({ actionLoading: true })
    callAdminApi('admin.feedback.update', {
      id: item.id,
      handled: item.handled === true,
      adminNote: item.adminNote || '',
      publicReply: item.publicReply || ''
    }).then(result => {
      if (!result || !result.success) {
        wx.showToast({ title: getResultError(result, '保存失败'), icon: 'none' })
        return
      }
      wx.showToast({ title: '反馈已更新', icon: 'success' })
      this.loadFeedback(true)
    }).finally(() => this.setData({ actionLoading: false }))
  }
})
