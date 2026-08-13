const GITHUB_URL = 'https://github.com/Entropy-Increase-Team'
const MAGIC_BOOK_URL = 'https://rocom.shallow.ink/'

Page({
  onShareAppMessage() {
    return {
      title: '洛克王国世界远行商人记录本',
      path: '/pages/home/home'
    }
  },

  copyGithubLink() {
    wx.setClipboardData({
      data: GITHUB_URL,
      success() {
        wx.showToast({ title: 'GitHub 链接已复制', icon: 'none' })
      }
    })
  },

  copyMagicBookLink() {
    wx.setClipboardData({
      data: MAGIC_BOOK_URL,
      success() {
        wx.showToast({ title: '洛克魔法书链接已复制', icon: 'none' })
      }
    })
  }
})
