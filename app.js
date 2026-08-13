const deployment = require('./deployment.config')
const CLOUD_ENV = deployment.cloudEnv || ''
const CLOUD_APP_ID = deployment.cloudAppId || ''

App({
  onLaunch() {
    if (wx.cloud) {
      const cloudOptions = { traceUser: true }
      if (CLOUD_ENV) cloudOptions.env = CLOUD_ENV
      wx.cloud.init(cloudOptions)
    }
  },

  globalData: {
    appName: '远行商人记录本',
    version: '2.0.0',
    cloudAppId: CLOUD_APP_ID,
    cloudEnv: CLOUD_ENV,
    catalogVersion: '',
    statsVersion: '',
    adminStatusFetched: false,
    isAdmin: false,
    storageKey: 'follow_item_ids_v1',
    followInitializedKey: 'follow_initialized_v1',
    followDetailKey: 'follow_item_details_v1',
    pushSettingKey: 'merchant_push_settings_v1',
    merchantSubscribeTemplateId: deployment.subscribeTemplates[0].templateId,
    merchantSubscribeTemplates: deployment.subscribeTemplates
  }
})
