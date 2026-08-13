const { callCloudApi } = require('../../utils/cloud-api')
const { attachGoodsMeta } = require('../../utils/goods-info')
const { advanceProductImage, getFollowItems, loadProductCatalog } = require('../../utils/products')
const app = getApp()

const REMINDER_QUOTA_LIMIT = 99
const FOLLOW_SYNC_DEBOUNCE_MS = 400
const FOLLOW_SYNC_PENDING_KEY = 'follow_sync_pending_v1'
const FOLLOW_SYNC_SIGNATURE_KEY = 'follow_sync_signature_v1'
const REMINDER_STATUS_REFRESH_MS = 60 * 1000
const REMINDER_ISSUE_DISMISSED_KEY = 'reminder_issue_dismissed_v1'
const REMINDER_RESET_MODAL_SEEN_KEY = 'reminder_reset_modal_seen_v1'

function attachChecked(items, checkedIds) {
  return items.map(item => {
    const displayItem = item.display_product_id
      ? { ...item, product_id: item.display_product_id }
      : item
    return {
      ...attachGoodsMeta(displayItem),
      checked: checkedIds.includes(item.id),
      isRecommended: item.group === 'recommended',
      isFixedHotBundle: item.reminder_policy === 'weekly_friday_round_1'
    }
  })
}

function getValidCheckedIds(checkedIds) {
  const validIds = new Set(getFollowItems().map(item => item.id))
  return Array.from(new Set((checkedIds || []).filter(id => validIds.has(id))))
}

function getSelectedItems(checkedIds) {
  return attachChecked(getFollowItems().filter(item => checkedIds.includes(item.id)), checkedIds)
}

function serializeFollowItems(items) {
  return items.map(item => ({
    name: item.name,
    keywords: item.keywords || []
  }))
}

function getFollowSelectionSignature(items) {
  return serializeFollowItems(items)
    .map(item => ({
      name: String(item.name || '').trim(),
      keywords: Array.from(new Set(item.keywords || [item.name])).map(value => String(value || '').trim()).filter(Boolean).sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(item => `${item.name}:${item.keywords.join(',')}`)
    .join('|')
}

function getFallbackTemplates() {
  const configured = Array.isArray(app.globalData.merchantSubscribeTemplates)
    ? app.globalData.merchantSubscribeTemplates
    : [{ key: 'merchant_primary', label: '商品提醒', templateId: app.globalData.merchantSubscribeTemplateId || '' }]
  return configured
    .map(item => ({
      key: String(item.key || '').trim(),
      label: String(item.label || '商品提醒').trim(),
      templateId: String(item.templateId || '').trim(),
      remainingCount: 0,
      wechatRejected: false
    }))
    .filter(item => item.templateId)
    .slice(0, 3)
}

function mergeSubscribeTemplates(serverTemplates) {
  const fallbackTemplates = getFallbackTemplates()
  const serverById = new Map((Array.isArray(serverTemplates) ? serverTemplates : [])
    .filter(item => item && item.templateId)
    .map(item => [item.templateId, item]))
  return fallbackTemplates.map(template => ({
    ...template,
    ...(serverById.get(template.templateId) || {}),
    key: template.key,
    label: template.label,
    templateId: template.templateId
  }))
}

function getReminderIssueKey(issue) {
  if (!issue) return ''
  return [issue.roundKey || '', issue.updatedAt || '', (issue.itemNames || []).join(',')].join('|')
}

function getQuotaActionText(reminderCount) {
  if (Number(reminderCount || 0) >= REMINDER_QUOTA_LIMIT) return '次数已满'
  return '增加次数'
}

function getQuotaStateClass(reminderCount, rejectedTemplateCount) {
  if (Number(rejectedTemplateCount || 0) > 0) return 'is-warning'
  if (Number(reminderCount || 0) <= 0) return 'is-empty'
  if (Number(reminderCount || 0) <= 2) return 'is-low'
  return ''
}

function formatReminderIssueItems(itemNames) {
  const names = Array.from(new Set((itemNames || []).map(name => String(name || '').trim()).filter(Boolean)))
  if (!names.length) return ''
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')}等${names.length}件商品`
}

function isWechatReminderIssue(issue) {
  return issue && (issue.type === 'wechat_rejected' || issue.type === 'wechat_rejected_reset')
}

function getSubscribeRejectState(templateIds) {
  return new Promise(resolve => {
    if (!wx.getSetting) {
      resolve({ blocked: false })
      return
    }
    wx.getSetting({
      withSubscriptions: true,
      success(res) {
        const setting = res.subscriptionsSetting || {}
        const itemSettings = setting.itemSettings || {}
        const blockedIds = (templateIds || []).filter(templateId => {
          return itemSettings[templateId] === 'reject' || itemSettings[templateId] === 'ban'
        })
        resolve({
          blocked: setting.mainSwitch === false || blockedIds.length > 0,
          blockedIds,
          mainSwitch: setting.mainSwitch
        })
      },
      fail() {
        resolve({ blocked: false })
      }
    })
  })
}

Page({
  data: {
    followItems: [],
    checkedIds: [],
    savedCount: 0,
    subscribeLoading: false,
    reminderEnabled: false,
    reminderCount: 0,
    rejectedTemplateCount: 0,
    configuredTemplateCount: 0,
    availableGrantCount: 0,
    quotaActionText: '增加次数',
    quotaStateClass: 'is-empty',
    hasRejectedTemplates: false,
    hasMultipleTemplates: false,
    quotaActionDisabled: false,
    subscribeTemplates: [],
    syncState: 'saved',
    syncText: '已保存',
    reminderIssueVisible: false,
    reminderIssueKey: '',
    reminderIssueText: ''
  },

  onShareAppMessage() {
    return { title: '远行商人稀有商品提醒记录本', path: '/pages/follow/follow' }
  },

  onShareTimeline() {
    return { title: '远行商人稀有商品提醒记录本' }
  },

  onLoad() {
    this.loadFollowSettings()
    loadProductCatalog().then(() => this.loadFollowSettings())
  },

  onShow() {
    this.loadFollowSettings()
    this.loadReminderStatus()
    if (wx.getStorageSync(FOLLOW_SYNC_PENDING_KEY)) this.scheduleFollowSync(0)
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.data.selected !== 1) tabBar.setData({ selected: 1 })
  },

  onHide() {
    this.flushFollowSync()
  },

  onUnload() {
    this.flushFollowSync()
  },

  loadFollowSettings() {
    const initializedKey = app.globalData.followInitializedKey || 'follow_initialized_v1'
    const storedIds = wx.getStorageSync(app.globalData.storageKey)
    const storedDetails = wx.getStorageSync(app.globalData.followDetailKey)
    const pushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    const hasExistingRecord = wx.getStorageSync(initializedKey) === true ||
      (Array.isArray(storedDetails) && storedDetails.length > 0) ||
      pushSettings.enabled === true
    const recommendedIds = getFollowItems().filter(item => item.group === 'recommended').map(item => item.id)
    const checkedIds = hasExistingRecord
      ? getValidCheckedIds(Array.isArray(storedIds) ? storedIds : [])
      : getValidCheckedIds(recommendedIds)

    if (!hasExistingRecord) this.persistFollowSelection(checkedIds)
    else wx.setStorageSync(initializedKey, true)

    this.updateFollowView({
      checkedIds,
      reminderEnabled: pushSettings.enabled === true && pushSettings.subscribeAccepted === true,
      reminderCount: Number(pushSettings.reminderCount || 0),
      rejectedTemplateCount: Number(pushSettings.rejectedTemplateCount || 0),
      configuredTemplateCount: Number(pushSettings.configuredTemplateCount || 0),
      availableGrantCount: Number(pushSettings.availableGrantCount || 0),
      quotaActionText: getQuotaActionText(pushSettings.reminderCount),
      quotaStateClass: getQuotaStateClass(pushSettings.reminderCount, pushSettings.rejectedTemplateCount),
      hasRejectedTemplates: Number(pushSettings.rejectedTemplateCount || 0) > 0,
      hasMultipleTemplates: Number(pushSettings.configuredTemplateCount || 0) > 1,
      quotaActionDisabled: Number(pushSettings.reminderCount || 0) >= REMINDER_QUOTA_LIMIT,
      subscribeTemplates: mergeSubscribeTemplates(pushSettings.subscribeTemplates)
    })
  },

  updateFollowView(extra = {}) {
    const checkedIds = getValidCheckedIds(extra.checkedIds || this.data.checkedIds)
    const followItems = getFollowItems()
    const orderedItems = followItems.filter(item => item.group === 'recommended')
      .concat(followItems.filter(item => item.group !== 'recommended'))
    this.setData({
      ...extra,
      checkedIds,
      savedCount: checkedIds.length,
      followItems: attachChecked(orderedItems, checkedIds)
    })
  },

  persistFollowSelection(checkedIds) {
    const selectedItems = getSelectedItems(checkedIds)
    wx.setStorageSync(app.globalData.storageKey, checkedIds)
    wx.setStorageSync(app.globalData.followDetailKey, selectedItems.map(item => ({
      id: item.id,
      name: item.name,
      keywords: item.keywords || []
    })))
    wx.setStorageSync(app.globalData.followInitializedKey || 'follow_initialized_v1', true)
    const pushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    wx.setStorageSync(app.globalData.pushSettingKey, {
      ...pushSettings,
      enabled: selectedItems.length > 0 ? pushSettings.enabled === true : false,
      updatedAt: Date.now()
    })
  },

  toggleItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const checked = new Set(this.data.checkedIds)
    if (checked.has(id)) checked.delete(id)
    else checked.add(id)
    const checkedIds = getValidCheckedIds(Array.from(checked))
    this.persistFollowSelection(checkedIds)
    wx.setStorageSync(FOLLOW_SYNC_PENDING_KEY, true)
    this.updateFollowView({ checkedIds, syncState: 'saving', syncText: '保存中' })
    this.scheduleFollowSync(FOLLOW_SYNC_DEBOUNCE_MS)
  },

  scheduleFollowSync(delay = FOLLOW_SYNC_DEBOUNCE_MS) {
    if (this.followSyncTimer) clearTimeout(this.followSyncTimer)
    this.followSyncTimer = setTimeout(() => {
      this.followSyncTimer = null
      this.syncSubscriptionItems(getSelectedItems(this.data.checkedIds))
    }, delay)
  },

  flushFollowSync() {
    if (!this.followSyncTimer) return
    clearTimeout(this.followSyncTimer)
    this.followSyncTimer = null
    this.syncSubscriptionItems(getSelectedItems(this.data.checkedIds))
  },

  syncSubscriptionItems(selectedItems) {
    const selectionSignature = getFollowSelectionSignature(selectedItems)
    const savedSignature = String(wx.getStorageSync(FOLLOW_SYNC_SIGNATURE_KEY) || '')
    if (this.followSyncPromise) {
      this.pendingFollowSyncItems = selectedItems
      return this.followSyncPromise
    }
    if (selectionSignature === savedSignature && !wx.getStorageSync(FOLLOW_SYNC_PENDING_KEY)) {
      this.setData({ syncState: 'saved', syncText: '已保存' })
      return Promise.resolve(true)
    }
    this.setData({ syncState: 'saving', syncText: '保存中' })
    this.followSyncPromise = callCloudApi('subscribe.updateItems', {
      followedItems: serializeFollowItems(selectedItems)
    }).then(result => {
      if (!result || !result.success) throw new Error((result && result.message) || '同步失败')
      const data = result.data || {}
      this.applySubscriptionStatus(data)
      wx.setStorageSync(FOLLOW_SYNC_SIGNATURE_KEY, data.selectionSignature || selectionSignature)
      wx.removeStorageSync(FOLLOW_SYNC_PENDING_KEY)
      this.setData({
        syncState: 'saved',
        syncText: '已保存',
        reminderEnabled: selectedItems.length > 0 && this.data.reminderEnabled
      })
      return true
    }).catch(() => {
      wx.setStorageSync(FOLLOW_SYNC_PENDING_KEY, true)
      this.setData({ syncState: 'error', syncText: '同步失败，点此重试' })
      return false
    }).finally(() => {
      this.followSyncPromise = null
      const pendingItems = this.pendingFollowSyncItems
      this.pendingFollowSyncItems = null
      if (pendingItems && getFollowSelectionSignature(pendingItems) !== String(wx.getStorageSync(FOLLOW_SYNC_SIGNATURE_KEY) || '')) {
        wx.setStorageSync(FOLLOW_SYNC_PENDING_KEY, true)
        this.syncSubscriptionItems(pendingItems)
      }
    })
    return this.followSyncPromise
  },

  retryFollowSync() {
    if (this.data.syncState !== 'error') return
    this.syncSubscriptionItems(getSelectedItems(this.data.checkedIds))
  },

  loadReminderStatus() {
    const pushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    if (pushSettings.reminderIssue) this.applyReminderIssue(pushSettings.reminderIssue)
    if (Date.now() - Number(pushSettings.reminderStatusFetchedAt || 0) < REMINDER_STATUS_REFRESH_MS) {
      return Promise.resolve()
    }
    return callCloudApi('subscribe.status').then(result => {
      if (!result || !result.success) return
      const data = result.data || {}
      this.applySubscriptionStatus(data)
      this.applyReminderIssue(data.reminderIssue || null)
    })
  },

  applySubscriptionStatus(data = {}) {
    const reminderCount = Number(data.reminderCount || 0)
    const templates = mergeSubscribeTemplates(data.templates)
    const latestPushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
    const configuredTemplateCount = templates.length
    const rejectedTemplateCount = Number(data.rejectedTemplateCount || 0)
    const availableGrantCount = Math.max(0, Math.min(configuredTemplateCount, REMINDER_QUOTA_LIMIT - reminderCount))
    const quotaActionText = getQuotaActionText(reminderCount)
    const quotaStateClass = getQuotaStateClass(reminderCount, rejectedTemplateCount)
    const hasRejectedTemplates = rejectedTemplateCount > 0
    const hasMultipleTemplates = configuredTemplateCount > 1
    const quotaActionDisabled = reminderCount >= REMINDER_QUOTA_LIMIT
    wx.setStorageSync(app.globalData.pushSettingKey, {
      ...latestPushSettings,
      reminderCount,
      rejectedTemplateCount,
      configuredTemplateCount,
      availableGrantCount,
      quotaActionText,
      quotaStateClass,
      hasRejectedTemplates,
      hasMultipleTemplates,
      quotaActionDisabled,
      subscribeTemplates: templates,
      reminderIssue: data.reminderIssue || latestPushSettings.reminderIssue || null,
      homeReminder: data.homeStatus || data.homeReminder || latestPushSettings.homeReminder || null,
      reminderStatusFetchedAt: Date.now(),
      updatedAt: Date.now()
    })
    this.setData({
      reminderCount,
      rejectedTemplateCount,
      configuredTemplateCount,
      availableGrantCount,
      quotaActionText,
      quotaStateClass,
      hasRejectedTemplates,
      hasMultipleTemplates,
      quotaActionDisabled,
      subscribeTemplates: templates,
      reminderEnabled: data.hasEnabledSubscription === undefined
        ? this.data.reminderEnabled
        : data.hasEnabledSubscription === true
    })
  },

  applyReminderIssue(issue) {
    const issueKey = getReminderIssueKey(issue)
    const dismissedKey = wx.getStorageSync(REMINDER_ISSUE_DISMISSED_KEY)
    if (!isWechatReminderIssue(issue) || !issueKey || dismissedKey === issueKey) {
      this.setData({ reminderIssueVisible: false, reminderIssueKey: '', reminderIssueText: '' })
      return
    }
    const itemText = formatReminderIssueItems(issue.itemNames)
    const reminderIssueText = itemText
      ? `上次 ${itemText} 的提醒没有送到，需要重新允许对应的订阅通道。`
      : '上次提醒没有送到，需要重新允许对应的订阅通道。'
    this.setData({ reminderIssueVisible: true, reminderIssueKey: issueKey, reminderIssueText })

    if (issue.type === 'wechat_rejected_reset' && wx.getStorageSync(REMINDER_RESET_MODAL_SEEN_KEY) !== issueKey) {
      wx.setStorageSync(REMINDER_RESET_MODAL_SEEN_KEY, issueKey)
      wx.showModal({
        title: '提醒需要重新开启',
        content: '上次提醒没有送到。点“增加次数”重新允许后，其他可用通道仍会继续工作。',
        confirmText: '增加次数',
        cancelText: '稍后',
        success: res => { if (res.confirm) this.enableWechatReminder() }
      })
    }
  },

  dismissReminderIssue() {
    if (this.data.reminderIssueKey) wx.setStorageSync(REMINDER_ISSUE_DISMISSED_KEY, this.data.reminderIssueKey)
    this.setData({ reminderIssueVisible: false, reminderIssueKey: '', reminderIssueText: '' })
  },

  handleFollowImageError(e) {
    const id = e.currentTarget.dataset.id || ''
    const name = e.currentTarget.dataset.name || ''
    if (!id && !name) return
    const currentItem = (this.data.followItems || [])
      .find(item => id ? item.id === id : item.name === name)
    if (!currentItem) return
    const nextImageState = advanceProductImage(currentItem)
    this.setData({
      followItems: (this.data.followItems || []).map(item => {
        const matched = id ? item.id === id : item.name === name
        return matched ? { ...item, ...nextImageState } : item
      })
    })
  },

  enableWechatReminder() {
    if (this.data.subscribeLoading) return
    const selectedItems = getSelectedItems(this.data.checkedIds)
    if (!selectedItems.length) {
      wx.showToast({ title: '请先选择关注商品', icon: 'none' })
      return
    }
    if (this.data.reminderCount >= REMINDER_QUOTA_LIMIT) {
      wx.showToast({ title: '次数已经很多了，之后再订阅吧', icon: 'none' })
      return
    }
    const capacity = Math.max(0, REMINDER_QUOTA_LIMIT - this.data.reminderCount)
    const templateIds = (this.data.subscribeTemplates.length ? this.data.subscribeTemplates : getFallbackTemplates())
      .map(item => item.templateId)
      .filter(Boolean)
      .slice(0, Math.min(3, capacity))
    if (!templateIds.length) {
      wx.showToast({ title: '请先配置订阅模板 ID', icon: 'none' })
      return
    }

    this.setData({ subscribeLoading: true })
    let runtimeInfo = {}
    try {
      const accountInfo = wx.getAccountInfoSync ? wx.getAccountInfoSync() : {}
      const systemInfo = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
      runtimeInfo = {
        appId: accountInfo.miniProgram && accountInfo.miniProgram.appId,
        envVersion: accountInfo.miniProgram && accountInfo.miniProgram.envVersion,
        platform: systemInfo.platform,
        system: systemInfo.system,
        wechatVersion: systemInfo.version,
        SDKVersion: systemInfo.SDKVersion
      }
    } catch (error) {
      runtimeInfo = { error: error.message || String(error) }
    }
    console.info('[follow] subscribe runtime', runtimeInfo)
    console.info('[follow] request subscribe templates', templateIds)
    wx.requestSubscribeMessage({
      tmplIds: templateIds,
      success: res => {
        console.info('[follow] subscribe result', res)
        const acceptedTemplateIds = templateIds.filter(templateId => res[templateId] === 'accept')
        const rejectedTemplateIds = templateIds.filter(templateId => ['reject', 'ban', 'filter'].includes(res[templateId]))
        const missingTemplateIds = templateIds.filter(templateId => !Object.prototype.hasOwnProperty.call(res, templateId))
        console.info('[follow] subscribe result detail', {
          acceptedTemplateIds,
          rejectedTemplateIds,
          missingTemplateIds
        })
        if (!acceptedTemplateIds.length) {
          if (missingTemplateIds.length) {
            this.setData({ subscribeLoading: false })
            wx.showModal({
              title: '部分模板未被微信识别',
              content: `微信没有返回 ${missingTemplateIds.length} 个模板的状态，并非用户拒绝。请先用手机真机预览；若真机仍出现，请检查公众平台“我的模板”中的模板 ID 和实际标题。`,
              showCancel: false
            })
            return
          }
          this.handleSubscribeRejected(templateIds)
          return
        }
        this.saveWechatReminderSubscription(acceptedTemplateIds, selectedItems, {
          rejectedCount: rejectedTemplateIds.length,
          missingCount: missingTemplateIds.length
        })
      },
      fail: error => {
        console.warn('[follow] request subscribe failed', error)
        this.handleSubscribeRejected(templateIds)
      }
    })
  },

  handleSubscribeRejected(templateIds) {
    getSubscribeRejectState(templateIds).then(setting => {
      this.setData({ subscribeLoading: false })
      if (!setting.blocked) {
        wx.showToast({ title: '本次没有增加提醒次数', icon: 'none' })
        return
      }
      wx.showModal({
        title: '部分提醒未允许',
        content: '可以去小程序设置中重新允许商品提醒，然后回来再次增加次数。',
        confirmText: '去设置',
        cancelText: '稍后',
        success(res) { if (res.confirm && wx.openSetting) wx.openSetting({}) }
      })
    })
  },

  saveWechatReminderSubscription(acceptedTemplateIds, selectedItems, resultSummary = {}) {
    callCloudApi('subscribe.save', {
      followedItems: serializeFollowItems(selectedItems),
      acceptedTemplateIds
    }).then(result => {
      if (!result || !result.success) throw new Error((result && result.message) || '微信提醒开启失败')
      const data = result.data || {}
      const addedCount = Number(data.addedCount || 0)
      const pushSettings = wx.getStorageSync(app.globalData.pushSettingKey) || {}
      wx.setStorageSync(app.globalData.pushSettingKey, {
        ...pushSettings,
        enabled: true,
        subscribeAccepted: true,
        reminderIssue: null,
        updatedAt: Date.now()
      })
      wx.removeStorageSync(REMINDER_ISSUE_DISMISSED_KEY)
      wx.setStorageSync(FOLLOW_SYNC_SIGNATURE_KEY, data.selectionSignature || getFollowSelectionSignature(selectedItems))
      wx.removeStorageSync(FOLLOW_SYNC_PENDING_KEY)
      this.applySubscriptionStatus({ ...data, hasEnabledSubscription: true, reminderIssue: null })
      this.setData({
        reminderEnabled: true,
        reminderIssueVisible: false,
        reminderIssueKey: '',
        reminderIssueText: ''
      })
      const rejectedCount = Number(resultSummary.rejectedCount || 0)
      const missingCount = Number(resultSummary.missingCount || 0)
      const suffix = missingCount > 0
        ? `，另 ${missingCount} 个未识别`
        : (rejectedCount > 0 ? `，${rejectedCount} 个未允许` : '')
      wx.showToast({
        title: addedCount > 0 ? `已增加 ${addedCount} 次${suffix}` : (result.message || '次数已满'),
        icon: addedCount > 0 && rejectedCount === 0 && missingCount === 0 ? 'success' : 'none'
      })
    }).catch(error => {
      wx.showToast({ title: error.message || '微信提醒开启失败', icon: 'none' })
    }).finally(() => {
      this.setData({ subscribeLoading: false })
    })
  },

  openReminderSettings() {
    if (wx.openSetting) wx.openSetting({})
    else wx.showToast({ title: '请从右上角进入小程序设置', icon: 'none' })
  }
})
