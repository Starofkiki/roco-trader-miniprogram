const CLOUD_ENV = 'cloud1-d7ga0y9wyc4ee559d'
const CLOUD_APP_ID = 'wx665ff8ce8ec2a184'

App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: CLOUD_ENV,
        traceUser: true
      })
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
    // 填写微信公众平台“订阅消息”里的模板 ID，供 wx.requestSubscribeMessage 使用。
    merchantSubscribeTemplateId: 'ZT-hSLIk-muFnlIZ-VACBoNpxKKGrGb31fsWn4XaGxY',
    merchantSubscribeTemplates: [
      { key: 'merchant_primary', label: '新商品上架提醒', templateId: 'ZT-hSLIk-muFnlIZ-VACBoNpxKKGrGb31fsWn4XaGxY' },
      { key: 'merchant_arrival', label: '商品到货提醒', templateId: 'x1IzmXjI0iUa8d2AEou0bPm72oBDVXwCzara5zBwk0M' },
      { key: 'merchant_activity', label: '活动进度提醒', templateId: 'y0kmCnjN496miwcs73YNlzY6Fi47LxCKhekWGCqb-og' }
    ]
  }
})
