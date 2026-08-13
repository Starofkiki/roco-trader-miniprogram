async function callRocoApi(cloud, data) {
  const result = await cloud.callFunction({
    name: 'rocoApi',
    data
  }, {
    timeout: 60000
  })

  return result && result.result ? result.result : result
}

async function runAdminOperation(cloud, event = {}) {
  const operation = String(event.operation || '').trim()
  const maintenanceSecret = event.maintenanceSecret || ''

  if (!operation) {
    throw new Error('operation is required')
  }

  if (operation === 'forceSyncCurrent') {
    return callRocoApi(cloud, {
      action: 'admin.forceSyncCurrent',
      maintenanceSecret,
      notify: event.notify === true
    })
  }

  if (operation === 'notifyCurrent') {
    return callRocoApi(cloud, {
      action: 'merchant.notifyCurrent',
      force: true,
      maintenanceSecret
    })
  }

  if (operation === 'notifyRoundPending') {
    return callRocoApi(cloud, {
      action: 'admin.notifyRoundPending',
      maintenanceSecret,
      roundKey: event.roundKey || '',
      batchLimit: event.batchLimit
    })
  }

  if (operation === 'resetTesterData') {
    return callRocoApi(cloud, {
      action: 'admin.resetTesterData',
      maintenanceSecret,
      openids: event.openids || []
    })
  }

  if (operation === 'backfillWechatRejectedQuotas') {
    return callRocoApi(cloud, {
      action: 'admin.backfillWechatRejectedQuotas',
      maintenanceSecret,
      roundKey: event.roundKey || ''
    })
  }

  if (operation === 'repairQuotaConsumePending') {
    return callRocoApi(cloud, {
      action: 'admin.repairQuotaConsumePending',
      maintenanceSecret,
      roundKey: event.roundKey || ''
    })
  }

  if (operation === 'repairQuotaRefundPending') {
    return callRocoApi(cloud, {
      action: 'admin.repairQuotaRefundPending',
      maintenanceSecret,
      roundKey: event.roundKey || ''
    })
  }

  if (operation === 'backfillSubscriptionTargets') {
    return callRocoApi(cloud, {
      action: 'admin.backfillSubscriptionTargets',
      maintenanceSecret
    })
  }

  if (operation === 'clearLegacyNotificationCollections') {
    return callRocoApi(cloud, {
      action: 'admin.clearLegacyNotificationCollections',
      maintenanceSecret
    })
  }

  if (operation === 'loadTestSeed') {
    return callRocoApi(cloud, {
      action: 'admin.loadTest.seed',
      maintenanceSecret,
      confirmLoadTestCost: event.confirmLoadTestCost,
      userCount: event.userCount,
      includeLastRecipient: event.includeLastRecipient,
      templateId: event.templateId
    })
  }

  if (operation === 'loadTestRunRound') {
    return callRocoApi(cloud, {
      action: 'admin.loadTest.runRound',
      maintenanceSecret,
      confirmLoadTestCost: event.confirmLoadTestCost,
      roundKey: event.roundKey,
      date: event.date,
      round: event.round,
      items: event.items,
      timeoutRate: event.timeoutRate,
      rejectRate: event.rejectRate,
      stuckRate: event.stuckRate,
      delayMinMs: event.delayMinMs,
      delayMaxMs: event.delayMaxMs,
      batchLimit: event.batchLimit,
      timeBudgetMs: event.timeBudgetMs,
      concurrency: event.concurrency,
      includeLastRecipient: event.includeLastRecipient,
      templateId: event.templateId
    })
  }

  if (operation === 'loadTestSummary') {
    return callRocoApi(cloud, {
      action: 'admin.loadTest.summary',
      maintenanceSecret,
      roundKey: event.roundKey
    })
  }

  if (operation === 'loadTestCleanup') {
    return callRocoApi(cloud, {
      action: 'admin.loadTest.cleanup',
      maintenanceSecret
    })
  }

  throw new Error(`unknown admin operation: ${operation}`)
}

module.exports = {
  runAdminOperation
}
