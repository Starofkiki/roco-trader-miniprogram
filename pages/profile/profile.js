const { callAdminApi } = require('../../utils/cloud-api')
const { officialAccountQrCode: OFFICIAL_ACCOUNT_QR_CODE } = require('../../deployment.config')

Page({
  data: {
    isAdmin: false,
    showOfficialAccountGuide: false,
    officialAccountQrCode: OFFICIAL_ACCOUNT_QR_CODE
  },

  onShareAppMessage() {
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
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.data.selected !== 3) {
      tabBar.setData({ selected: 3 })
    }
    const app = getApp()
    if (app.globalData.adminStatusFetched === true) {
      this.setData({ isAdmin: app.globalData.isAdmin === true })
      return
    }
    this.setData({ isAdmin: false })
    callAdminApi('admin.status').then(result => {
      const isAdmin = Boolean(result && result.success && result.data && result.data.isAdmin)
      app.globalData.adminStatusFetched = true
      app.globalData.isAdmin = isAdmin
      this.setData({ isAdmin })
    })
  },

  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  openOfficialAccountGuide() {
    if (!OFFICIAL_ACCOUNT_QR_CODE) {
      wx.showToast({ title: '维护者尚未配置公众号二维码', icon: 'none' })
      return
    }
    this.setData({ showOfficialAccountGuide: true })
  },

  closeOfficialAccountGuide() {
    this.setData({ showOfficialAccountGuide: false })
  },

  stopPropagation() {},

  previewOfficialAccountQr() {
    if (!OFFICIAL_ACCOUNT_QR_CODE) return
    if (this.officialAccountQrTempPath) {
      wx.previewImage({
        current: this.officialAccountQrTempPath,
        urls: [this.officialAccountQrTempPath]
      })
      return
    }

    wx.showLoading({ title: '加载中', mask: true })
    wx.cloud.downloadFile({
      fileID: OFFICIAL_ACCOUNT_QR_CODE,
      success: result => {
        this.officialAccountQrTempPath = result.tempFilePath
        wx.previewImage({
          current: result.tempFilePath,
          urls: [result.tempFilePath]
        })
      },
      fail: () => {
        wx.showToast({ title: '二维码加载失败，请重试', icon: 'none' })
      },
      complete: () => {
        wx.hideLoading()
      }
    })
  },

  goAnnouncements() {
    wx.navigateTo({ url: '/pages/announcements/announcements' })
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  },

  goAdmin() {
    if (!this.data.isAdmin) return
    wx.navigateTo({ url: '/pages/admin/admin' })
  }
})
