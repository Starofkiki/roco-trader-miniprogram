const { callCloudApi } = require('../../utils/cloud-api')

const FEEDBACK_PAGE_SIZE = 10

function formatDateTime(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function decorateFeedback(item, expandedIds = new Set()) {
  const publicReply = String(item.publicReply || '')
  const replied = Boolean(publicReply)
  const handled = item.status === 'handled'
  return {
    ...item,
    publicReply,
    expanded: expandedIds.has(item.id),
    unread: item.unread === true,
    statusText: replied ? '已回复' : (handled ? '已处理' : '待处理'),
    statusClass: replied ? 'replied' : (handled ? 'handled' : 'pending'),
    timeText: formatDateTime(item.createdAt),
    replyTimeText: formatDateTime(item.replyUpdatedAt),
    emptyReplyText: handled
      ? '这条反馈已处理，暂未留下公开回复。'
      : '管理员还在查看，回复后这里会显示“新回复”。'
  }
}

Page({
  data: {
    typeOptions: ['商品数据错误', '页面显示问题', '功能建议', '其他问题'],
    typeIndex: 0,
    content: '',
    submitting: false,
    myFeedbackItems: [],
    feedbackPage: 0,
    feedbackCursor: '',
    feedbackHasMore: false,
    feedbackUnreadCount: 0,
    feedbackLoading: false,
    feedbackLoadingMore: false,
    feedbackLoaded: false,
    feedbackError: false
  },

  onShow() {
    this.loadMyFeedback(true)
  },

  onShareAppMessage() {
    return {
      title: '洛克王国世界远行商人记录本',
      path: '/pages/home/home'
    }
  },

  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) })
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value })
  },

  submitFeedback() {
    const type = this.data.typeOptions[this.data.typeIndex]
    const content = this.data.content.trim()

    if (!type || !content) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' })
      return
    }

    if (this.data.submitting) return
    this.setData({ submitting: true })

    callCloudApi('feedback.submit', { type, content })
      .then(result => {
        if (result && result.success) {
          this.setData({
            typeIndex: 0,
            content: ''
          })
          wx.showToast({ title: '反馈已提交，感谢你的建议。', icon: 'none' })
          this.loadMyFeedback(true)
          return
        }
        wx.showToast({ title: '提交失败，请稍后再试。', icon: 'none' })
      })
      .catch(() => {
        wx.showToast({ title: '提交失败，请稍后再试。', icon: 'none' })
      })
      .finally(() => {
        this.setData({ submitting: false })
      })
  },

  loadMyFeedback(reset = false) {
    if ((reset && this.data.feedbackLoading) || (!reset && this.data.feedbackLoadingMore)) {
      return Promise.resolve()
    }
    const page = reset ? 1 : this.data.feedbackPage + 1
    this.setData(reset
      ? { feedbackLoading: true, feedbackError: false }
      : { feedbackLoadingMore: true })

    return callCloudApi('feedback.mine', {
      page,
      pageSize: FEEDBACK_PAGE_SIZE,
      cursor: reset ? '' : this.data.feedbackCursor
    })
      .then(result => {
        if (!result || !result.success || !result.data) throw new Error('反馈记录加载失败')
        const expandedIds = new Set((this.data.myFeedbackItems || [])
          .filter(item => item.expanded)
          .map(item => item.id))
        const incoming = (result.data.items || []).map(item => decorateFeedback(item, expandedIds))
        const items = reset
          ? incoming
          : this.data.myFeedbackItems.concat(incoming.filter(item => {
            return !this.data.myFeedbackItems.some(existing => existing.id === item.id)
          }))
        this.setData({
          myFeedbackItems: items,
          feedbackPage: page,
          feedbackCursor: result.data.nextCursor || '',
          feedbackHasMore: result.data.hasMore === true,
          feedbackUnreadCount: Math.max(0, (reset ? 0 : Number(this.data.feedbackUnreadCount || 0)) + Number(result.data.unreadCount || 0)),
          feedbackLoaded: true,
          feedbackError: false
        })
      })
      .catch(() => {
        if (reset) this.setData({ feedbackError: true, feedbackLoaded: true })
        else wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' })
      })
      .finally(() => {
        this.setData({ feedbackLoading: false, feedbackLoadingMore: false })
      })
  },

  retryMyFeedback() {
    this.loadMyFeedback(true)
  },

  loadMoreFeedback() {
    if (this.data.feedbackHasMore) this.loadMyFeedback(false)
  },

  toggleFeedback(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.myFeedbackItems[index]
    if (!item) return
    const expanded = item.expanded !== true
    this.setData({ [`myFeedbackItems[${index}].expanded`]: expanded })
    if (!expanded || !item.unread || !item.publicReply) return

    return callCloudApi('feedback.markRead', { id: item.id }).then(result => {
      if (!result || !result.success) return
      const currentIndex = this.data.myFeedbackItems.findIndex(feedback => feedback.id === item.id)
      if (currentIndex < 0 || this.data.myFeedbackItems[currentIndex].unread !== true) return
      this.setData({
        [`myFeedbackItems[${currentIndex}].unread`]: false,
        feedbackUnreadCount: Math.max(0, this.data.feedbackUnreadCount - 1)
      })
    })
  }
})
