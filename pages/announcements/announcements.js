const { callCloudApi } = require('../../utils/cloud-api')

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
}

Page({
  data: {
    announcements: [],
    page: 1,
    cursor: '',
    total: 0,
    hasMore: false,
    loading: false,
    initialLoading: true,
    errorMessage: '',
    retryReset: false
  },

  onLoad() {
    this.loadAnnouncements(true)
  },

  loadAnnouncements(reset = false, options = {}) {
    if (this.data.loading) return Promise.resolve(false)
    const page = reset ? 1 : this.data.page + 1
    this.setData({
      loading: true,
      initialLoading: reset && options.showInitial !== false,
      errorMessage: reset ? '' : this.data.errorMessage
    })
    return callCloudApi('announcement.list', {
      page,
      pageSize: 10,
      cursor: reset ? '' : this.data.cursor
    })
      .then(result => {
        if (!result || !result.success) {
          this.setData({
            errorMessage: (result && result.message) || '公告加载失败，请稍后重试',
            retryReset: reset
          })
          return
        }
        const data = result.data || {}
        const items = (data.items || []).map(item => ({
          ...item,
          dateText: formatDate(item.publishedAt)
        }))
        const announcements = reset
          ? items
          : this.data.announcements.concat(items.filter(item => {
            return !this.data.announcements.some(existing => existing.id === item.id)
          }))
        this.setData({
          announcements,
          page,
          cursor: data.nextCursor || '',
          total: announcements.length,
          hasMore: data.hasMore === true,
          errorMessage: '',
          retryReset: false
        })
      })
      .finally(() => this.setData({ loading: false, initialLoading: false }))
  },

  retryLoad() {
    const reset = this.data.retryReset || this.data.announcements.length === 0
    this.loadAnnouncements(reset, { showInitial: this.data.announcements.length === 0 })
  },

  loadMore() {
    if (this.data.hasMore) this.loadAnnouncements(false)
  },

  onReachBottom() {
    this.loadMore()
  },

  onPullDownRefresh() {
    this.loadAnnouncements(true, { showInitial: false })
      .finally(() => wx.stopPullDownRefresh())
  },

  openAnnouncement(event) {
    const id = String(event.currentTarget.dataset.id || '').trim()
    if (!id) return
    wx.navigateTo({ url: `/pages/announcements/detail?id=${encodeURIComponent(id)}` })
  },

  onShareAppMessage() {
    return {
      title: '远行商人记录本 · 历史公告',
      path: '/pages/announcements/announcements'
    }
  }
})
