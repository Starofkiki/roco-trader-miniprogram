const { callCloudApi } = require('../../utils/cloud-api')

function formatDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

Page({
  data: {
    id: '',
    announcement: null,
    loading: true,
    errorMessage: ''
  },

  onLoad(options = {}) {
    const rawId = String(options.id || '').trim()
    let id = rawId
    try {
      id = decodeURIComponent(rawId)
    } catch (error) {
      id = rawId
    }
    this.setData({ id })
    this.loadAnnouncement()
  },

  loadAnnouncement() {
    if (!this.data.id) {
      this.setData({ loading: false, errorMessage: '公告地址无效' })
      return Promise.resolve(false)
    }
    this.setData({ loading: true, errorMessage: '' })
    return callCloudApi('announcement.detail', { id: this.data.id })
      .then(result => {
        if (!result || !result.success || !result.data || !result.data.announcement) {
          this.setData({ errorMessage: (result && result.message) || '公告不存在或已下架' })
          return false
        }
        const announcement = result.data.announcement
        this.setData({
          announcement: {
            ...announcement,
            dateText: formatDateTime(announcement.publishedAt)
          }
        })
        return true
      })
      .finally(() => this.setData({ loading: false }))
  },

  retryLoad() {
    this.loadAnnouncement()
  },

  goBackToList() {
    wx.navigateBack({
      fail() {
        wx.redirectTo({ url: '/pages/announcements/announcements' })
      }
    })
  },

  onShareAppMessage() {
    const announcement = this.data.announcement
    return {
      title: announcement ? announcement.title : '远行商人记录本 · 公告',
      path: `/pages/announcements/detail?id=${encodeURIComponent(this.data.id)}`
    }
  },

  onShareTimeline() {
    const announcement = this.data.announcement
    return {
      title: announcement ? announcement.title : '远行商人记录本 · 公告',
      query: `id=${encodeURIComponent(this.data.id)}`
    }
  }
})
