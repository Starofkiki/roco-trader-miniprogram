Component({
  data: {
    visible: true,
    selected: 0,
    list: [
      {
        pagePath: 'pages/home/home',
        text: '首页',
        iconPath: '/assets/tab/shouye.png',
        selectedIconPath: '/assets/tab/shouye.png'
      },
      {
        pagePath: 'pages/follow/follow',
        text: '关注',
        iconPath: '/assets/tab/guanzhu.png',
        selectedIconPath: '/assets/tab/guanzhu.png'
      },
      {
        pagePath: 'pages/stats/stats',
        text: '统计',
        iconPath: '/assets/tab/tongji.png',
        selectedIconPath: '/assets/tab/tongji.png'
      },
      {
        pagePath: 'pages/profile/profile',
        text: '我的',
        iconPath: '/assets/tab/wode.png',
        selectedIconPath: '/assets/tab/wode.png'
      }
    ]
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset
      const url = data.path
      wx.switchTab({ url })
      this.setData({ selected: data.index })
    }
  }
})
