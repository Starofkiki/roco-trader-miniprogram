let cloudInstance = null
let cloudInitPromise = null
const pendingReadRequests = {}
const DEDUPED_ACTIONS = {
  'announcement.current': true,
  'announcement.detail': true,
  'announcement.list': true,
  'feedback.mine': true,
  'merchant.current': true,
  'merchant.history': true,
  'merchant.historyBundle': true,
  'merchant.historyByKeys': true,
  'merchant.voteSummary': true,
  'products.catalog': true,
  'share.goodsImages': true,
  'share.wxacode': true,
  'subscribe.status': true
}

function getCloudConfig() {
  const app = getApp()
  const globalData = app && app.globalData ? app.globalData : {}

  return {
    resourceAppid: globalData.cloudAppId || 'wx665ff8ce8ec2a184',
    resourceEnv: globalData.cloudEnv || 'cloud1-d7ga0y9wyc4ee559d'
  }
}

function getCloudInstance() {
  if (!wx.cloud || !wx.cloud.Cloud) {
    return Promise.resolve(wx.cloud)
  }

  if (cloudInstance && cloudInitPromise) {
    return cloudInitPromise.then(() => cloudInstance)
  }

  const config = getCloudConfig()
  cloudInstance = new wx.cloud.Cloud({
    resourceAppid: config.resourceAppid,
    resourceEnv: config.resourceEnv
  })
  cloudInitPromise = cloudInstance.init()

  return cloudInitPromise.then(() => cloudInstance)
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function getRequestKey(action, data) {
  return `${action}:${stableStringify(data || {})}`
}

function callCloudApiRaw(action, data = {}) {
  return getCloudInstance()
    .then(cloud => {
      return cloud.callFunction({
        name: 'rocoApi',
        data: {
          action,
          ...data
        }
      })
    })
    .then(res => {
      const result = res && res.result
      if (!result) {
        return {
          success: false,
          message: '云函数未返回结果'
        }
      }
      return result
    }).catch(error => ({
      success: false,
      message: error && error.message ? error.message : '云函数调用失败'
    }))
}

function callCloudApi(action, data = {}) {
  if (!DEDUPED_ACTIONS[action]) {
    return callCloudApiRaw(action, data)
  }

  const requestKey = getRequestKey(action, data)
  if (pendingReadRequests[requestKey]) {
    return pendingReadRequests[requestKey]
  }

  pendingReadRequests[requestKey] = callCloudApiRaw(action, data)
    .finally(() => {
      delete pendingReadRequests[requestKey]
    })

  return pendingReadRequests[requestKey]
}

function callAdminApi(action, data = {}) {
  return getCloudInstance()
    .then(cloud => cloud.callFunction({
      name: 'rocoAdminApi',
      data: {
        action,
        ...data
      }
    }))
    .then(res => {
      const result = res && res.result
      if (!result) {
        return {
          success: false,
          message: '管理员云函数未返回结果'
        }
      }
      return result
    })
    .catch(error => ({
      success: false,
      message: error && error.message ? error.message : '管理员云函数调用失败'
    }))
}

module.exports = {
  callCloudApi,
  callAdminApi
}
