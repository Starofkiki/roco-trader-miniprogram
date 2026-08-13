// Public deployment template. Replace empty values for your own WeChat Cloud deployment.
module.exports = {
  cloudEnv: '',
  cloudAppId: '',
  officialAccountQrCode: '',
  prismShareHeroImage: '',
  subscribeTemplates: [
    { key: 'merchant_primary', label: '新商品上架提醒', templateId: '' },
    { key: 'merchant_arrival', label: '商品到货提醒', templateId: '' },
    { key: 'merchant_activity', label: '活动进度提醒', templateId: '' }
  ]
}
