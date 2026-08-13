const state = {
  summaryCache: null,
  selectedRoundKey: '',
  latestRoundKey: ''
}

const $ = selector => document.querySelector(selector)

function setTopMessage(message, ok = false) {
  const element = $('#topMessage')
  if (!element) return
  element.textContent = message || ''
  element.classList.toggle('ok', Boolean(ok))
}

function formatDateTime(value) {
  if (!value) return '未缓存'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function maskOpenid(openid) {
  const text = String(openid || '')
  if (text.length <= 12) return text
  return `${text.slice(0, 8)}...${text.slice(-4)}`
}

async function requestJson(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `HTTP ${res.status}`)
  }
  return data
}

async function checkSession() {
  const session = await requestJson('/api/session')
  $('#nextRefresh').textContent = formatDateTime(session.nextAutoRefreshAt)
  if (session.authenticated) {
    $('#loginPanel').classList.add('is-hidden')
    $('#dashboard').classList.remove('is-hidden')
    await loadCache()
    await loadAnnouncement()
  } else {
    $('#loginPanel').classList.remove('is-hidden')
    $('#dashboard').classList.add('is-hidden')
  }
}

async function login(event) {
  event.preventDefault()
  $('#loginMessage').textContent = ''
  try {
    await requestJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#passwordInput').value })
    })
    await checkSession()
  } catch (error) {
    $('#loginMessage').textContent = error.message
  }
}

async function logout() {
  await requestJson('/api/logout', { method: 'POST', body: '{}' })
  location.reload()
}

async function loadCache() {
  setTopMessage('')
  try {
    const result = await requestJson('/api/cache')
    state.summaryCache = result.cache
    $('#cachedAt').textContent = formatDateTime(result.cache.cachedAt)
    $('#nextRefresh').textContent = formatDateTime(result.nextAutoRefreshAt)
    renderSummary(result.cache.response && result.cache.response.data, result.cache.subscriptionHistory)
    setTopMessage('已读取本地缓存', true)
  } catch (error) {
    setTopMessage(error.message)
    if (/未登录|401/i.test(error.message)) {
      $('#loginPanel').classList.remove('is-hidden')
      $('#dashboard').classList.add('is-hidden')
    }
  }
}

async function forceRefresh() {
  const days = Number($('#daysSelect').value || 3)
  const confirmed = window.confirm('这会立即调用云函数 rocoAdminApi 拉取最新数据。确认继续？')
  if (!confirmed) return

  setTopMessage('正在调用云函数...')
  try {
    const result = await requestJson('/api/cloud-refresh', {
      method: 'POST',
      body: JSON.stringify({ confirmCloudCall: true, days })
    })
    state.summaryCache = result.cache
    $('#cachedAt').textContent = formatDateTime(result.cache.cachedAt)
    $('#nextRefresh').textContent = formatDateTime(result.nextAutoRefreshAt)
    renderSummary(result.cache.response && result.cache.response.data, result.cache.subscriptionHistory)
    setTopMessage('云端数据已更新', true)
  } catch (error) {
    setTopMessage(error.message)
    if (/未登录|401/i.test(error.message)) {
      $('#loginPanel').classList.remove('is-hidden')
      $('#dashboard').classList.add('is-hidden')
    }
  }
}

function getAnnouncementData(result) {
  return result &&
    result.announcement &&
    result.announcement.response &&
    result.announcement.response.data &&
    result.announcement.response.data.announcement
    ? result.announcement.response.data.announcement
    : null
}

function renderAnnouncement(announcement, fetchedAt = '') {
  $('#announcementTitle').value = announcement && announcement.title ? announcement.title : '公告'
  $('#announcementContent').value = announcement && announcement.content ? announcement.content : ''
  $('#announcementEnabled').checked = Boolean(announcement && announcement.enabled)
  $('#announcementUpdatedAt').textContent = announcement && announcement.updatedAt
    ? `更新 ${formatDateTime(announcement.updatedAt)}`
    : (fetchedAt ? `读取 ${formatDateTime(fetchedAt)}` : '未保存')
}

async function loadAnnouncement() {
  $('#announcementMessage').textContent = '读取中...'
  try {
    const result = await requestJson('/api/announcement')
    renderAnnouncement(getAnnouncementData(result), result.announcement && result.announcement.fetchedAt)
    $('#announcementMessage').textContent = '已读取公告'
  } catch (error) {
    $('#announcementMessage').textContent = error.message
  }
}

async function saveAnnouncement(event) {
  event.preventDefault()
  const title = $('#announcementTitle').value.trim() || '公告'
  const content = $('#announcementContent').value.trim()
  const enabled = $('#announcementEnabled').checked

  if (enabled && !content) {
    $('#announcementMessage').textContent = '启用公告前请填写内容'
    return
  }

  const confirmed = window.confirm('这会保存公告到云数据库，首页会读取这里的内容。确认继续？')
  if (!confirmed) return

  $('#announcementMessage').textContent = '保存中...'
  try {
    const result = await requestJson('/api/announcement', {
      method: 'POST',
      body: JSON.stringify({
        title,
        content,
        enabled,
        confirmCloudCall: true
      })
    })
    renderAnnouncement(getAnnouncementData(result), result.announcement && result.announcement.updatedAt)
    $('#announcementMessage').textContent = '公告已保存'
  } catch (error) {
    $('#announcementMessage').textContent = error.message
  }
}

function renderSummary(data, subscriptionHistory = null) {
  if (!data) {
    $('#roundRows').innerHTML = '<tr><td colspan="9">暂无缓存数据</td></tr>'
    $('#errorList').innerHTML = '<div class="list-item"><span>暂无错误缓存</span><b>0</b></div>'
    $('#subscriptionBox').innerHTML = '<span>暂无订阅缓存</span>'
    $('#feedbackBox').innerHTML = '<span>暂无反馈缓存</span>'
    $('#roundCount').textContent = '--'
    return
  }

  const rows = data.rows || []
  state.latestRoundKey = rows[0] && rows[0].roundKey ? rows[0].roundKey : ''
  if ($('#traceRoundKey') && !$('#traceRoundKey').value) {
    $('#traceRoundKey').placeholder = state.latestRoundKey || '默认最近一轮'
  }
  $('#roundCount').textContent = `${rows.length} 个轮次`
  $('#roundRows').innerHTML = rows.map(rowHtml).join('') || '<tr><td colspan="9">暂无轮次</td></tr>'
  $('#errorList').innerHTML = (data.errors || []).slice(0, 8).map(error => (
    `<div class="list-item"><span>${escapeHtml(error.message)}</span><b>${error.count}</b></div>`
  )).join('') || '<div class="list-item"><span>暂无错误</span><b>0</b></div>'
  renderSubscriptions(data.subscriptions || {}, subscriptionHistory)
  renderFeedback(data.feedback || {})
}

function rowHtml(row) {
  const flags = rowFlags(row)
  const job = translateJobStatus(row.jobStatus)
  const notification = translateNotificationStatus(row)
  const sent = (row.deliveries && row.deliveries.sent) || (row.logs && row.logs.sent) || 0
  const retry = row.deliveries ? row.deliveries.retryableFailed : 0
  const finalFailed = hasNumber(row.flags && row.flags.otherFinalFailedCount)
    ? Number(row.flags.otherFinalFailedCount || 0)
    : Number(row.queue && row.queue.finalFailed || 0)
  const roundItems = roundItemsHtml(row.roundItems || [], row.roundItemTotals)
  const queue = queueProgressHtml({ ...(row.queue || {}), finalFailed })

  return `
    <tr data-round-key="${escapeAttr(row.roundKey)}">
      <td><strong>${escapeHtml(row.date)} #${row.round}</strong><br><span>${escapeHtml(row.roundKey)}</span></td>
      <td>${badge(job.text, job.type)}<br><span>${row.itemCount || 0} 件</span></td>
      <td>${badge(notification.text, notification.type)}<br><span>${formatAttemptMinutes(row.attemptMinutes)}</span>${deadlineHtml(row)}</td>
      <td>${roundItems}</td>
      <td>${queue}</td>
      <td>${sent}</td>
      <td>${retry}</td>
      <td>${finalFailed}</td>
      <td>${flags.join('') || badge(emptyRound(row) ? '未触发/无数据' : '正常', emptyRound(row) ? '' : 'good')}</td>
    </tr>
  `
}

function rowFlags(row) {
  const flags = []
  const deliveries = row.deliveries || {}
  const rowFlagData = row.flags || {}
  if (row.flags && (row.flags.hasLogsWithoutJob || row.flags.hasDeliveriesWithoutJob)) flags.push('<span class="badge warn">历史缺 Job</span>')
  if (row.flags && row.flags.candidateUnmaterialized) flags.push('<span class="badge bad">候选未完整记录</span>')
  if (rowFlagData.queueNotDrained) flags.push('<span class="badge warn">队列未清空</span>')
  if ((rowFlagData.quotaConsumePendingCount || 0) > 0) flags.push(`<span class="badge warn">待补扣次数 ${rowFlagData.quotaConsumePendingCount}</span>`)
  if ((rowFlagData.quotaRefundPendingCount || 0) > 0) flags.push(`<span class="badge warn">待退回次数 ${rowFlagData.quotaRefundPendingCount}</span>`)
  if ((rowFlagData.activeSendingCount || 0) > 0) flags.push(`<span class="badge warn">处理中 ${rowFlagData.activeSendingCount}</span>`)
  if ((rowFlagData.staleSendingCount || 0) > 0) flags.push(`<span class="badge bad">发送中残留 ${rowFlagData.staleSendingCount}</span>`)
  if ((rowFlagData.secondAttemptCount || 0) > 0) flags.push(`<span class="badge warn">二次尝试 ${rowFlagData.secondAttemptCount}</span>`)
  if ((deliveries.pending || 0) > 0) flags.push(`<span class="badge warn">待处理 ${deliveries.pending}</span>`)
  if ((deliveries.retryableFailed || 0) > 0) flags.push(`<span class="badge warn">待补偿 ${deliveries.retryableFailed}</span>`)
  if ((rowFlagData.wechatRejectedCount || 0) > 0) flags.push(`<span class="badge bad">微信拒收 ${rowFlagData.wechatRejectedCount}</span>`)
  if ((rowFlagData.otherFinalFailedCount || 0) > 0) flags.push(`<span class="badge bad">最终失败 ${rowFlagData.otherFinalFailedCount}</span>`)
  if (row.jobStatus === 'processing' && !(rowFlagData.activeSendingCount || 0)) flags.push('<span class="badge warn">处理中</span>')
  return Array.from(new Set(flags))
}

function deadlineHtml(row) {
  const capturedAt = row.capturedAt ? formatDateTime(row.capturedAt) : ''
  const deadline = row.dispatchDeadlineAt ? formatDateTime(row.dispatchDeadlineAt) : ''
  if (!capturedAt && !deadline) return ''
  return `
    <div class="deadline-lines">
      ${capturedAt ? `<span>采集 ${escapeHtml(capturedAt)}</span>` : ''}
      ${deadline ? `<span>期限 ${escapeHtml(deadline)}</span>` : ''}
    </div>
  `
}

function emptyRound(row) {
  const deliveries = row.deliveries || {}
  const logs = row.logs || {}
  return row.jobStatus === 'missing' &&
    Object.values(deliveries).every(value => !value) &&
    Object.values(logs).every(value => !value)
}

function translateJobStatus(status) {
  if (status === 'success') return { text: '已完成', type: 'good' }
  if (status === 'processing') return { text: '处理中', type: 'warn' }
  if (status === 'retrying') return { text: '待重试', type: 'warn' }
  if (status === 'missing') return { text: '未创建', type: '' }
  return { text: status || '异常', type: 'bad' }
}

function translateNotificationStatus(row) {
  const status = row.notificationStatus || ''
  const flags = row.flags || {}
  if (!status) return { text: '无任务', type: '' }
  if (status === 'completed') return { text: '提醒完成', type: 'good' }
  if (status === 'completed_with_final_failures') {
    return (flags.otherFinalFailedCount || 0) > 0
      ? { text: '部分失败', type: 'bad' }
      : { text: '提醒完成', type: 'good' }
  }
  if (status === 'processing') return { text: '处理中', type: 'warn' }
  if (status === 'retrying') return { text: '等待补偿', type: 'warn' }
  if (status === 'pending') return { text: row.jobStatus === 'missing' ? '无任务' : '待处理', type: '' }
  return { text: status, type: '' }
}

function translateDeliveryStatus(status) {
  if (status === 'pending') return '待处理'
  if (status === 'sent') return '已发'
  if (status === 'sending') return '发送中'
  if (status === 'retryable_failed' || status === 'failed') return '可重试失败'
  if (status === 'final_failed') return '最终失败'
  if (status === 'no_quota') return '无额度'
  return status || '无记录'
}

function formatAttemptMinutes(minutes) {
  return minutes && minutes.length ? `${minutes.join(',')} 分` : '-- 分'
}

function roundItemsHtml(items, totals = null) {
  if (!items.length) {
    return totals && totals.recorded === true
      ? '<span class="muted">无订阅命中</span>'
      : '<span class="muted">历史未记录</span>'
  }
  const visibleItems = items.filter(item => {
    const subscriptionCount = Number(item.subscriptionCount || 0)
    const pushableCount = Number(item.pushableCount || 0)
    return subscriptionCount > 0 || pushableCount > 0
  })
  if (!visibleItems.length) return '<span class="muted">无订阅命中</span>'
  const subscriptionCount = Number(totals && totals.subscriptionCount ? totals.subscriptionCount : 0)
  const pushableCount = Number(totals && totals.pushableCount ? totals.pushableCount : 0)
  const totalBadge = subscriptionCount > 0 || pushableCount > 0
    ? `<span class="badge strong">合计 ${subscriptionCount} / 可推 ${pushableCount}</span>`
    : ''
  return `<div class="round-items">${totalBadge}${visibleItems.map(item => (
    `<span class="badge">${escapeHtml(item.name)} ${item.subscriptionCount || 0} / 可推 ${item.pushableCount || 0}</span>`
  )).join('')}</div>`
}

function queueProgressHtml(queue = {}) {
  const total = Number(queue.total || 0)
  if (!total) return '<span class="muted">无队列</span>'

  const pending = Number(queue.pending || 0)
  const retry = Number(queue.retryableFailed || 0)
  const finalFailed = Number(queue.finalFailed || 0)
  const remainingBatches = Number(queue.remainingBatches || 0)
  const batchLimit = Number(queue.batchLimit || 0)

  return `
    <div class="queue-progress">
      <span>总 ${total} / 已发 ${Number(queue.sent || 0)}</span>
      <span>待处理 ${pending} / 可重试 ${retry}</span>
      <span>最终失败 ${finalFailed} / 无额度 ${Number(queue.noQuota || 0)}</span>
      <span>${remainingBatches > 0 ? `剩余约 ${remainingBatches} 批` : '队列已清空'}${batchLimit ? ` · 批量 ${batchLimit}` : ''}</span>
    </div>
  `
}

function badge(text, type = '') {
  return `<span class="badge ${type}">${escapeHtml(text || '--')}</span>`
}

function hasNumber(value) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value))
}

function renderSubscriptions(data, history = null) {
  const snapshots = history && Array.isArray(history.snapshots) ? history.snapshots : []
  $('#subscriptionBox').innerHTML = `
    <div class="subscription-current">
      <div>用户数 <b>${data.userCount || 0}</b></div>
      <div>启用订阅 <b>${data.enabledSubscriptionCount || 0}</b></div>
      <div>可推送订阅 <b>${data.quotaEligibleSubscriptionCount || 0}</b></div>
      <div>待用户重新授权 <b>${data.wechatRejectedQuotaCount || 0}</b></div>
      <div>有剩余次数用户 <b>${data.usersWithQuota || 0}</b></div>
      <div>剩余次数总量 <b>${data.totalQuota || 0}</b></div>
    </div>
    <p class="subscription-note">用户重新点“增加次数”并允许后会自动恢复；回填只修正历史拒收标记。</p>
    <div class="subscription-history">
      <strong>每轮变化</strong>
      ${snapshots.slice(0, 12).map(subscriptionSnapshotHtml).join('') || '<span class="muted">暂无历史快照</span>'}
    </div>
  `
}

function subscriptionSnapshotHtml(item) {
  const [year, month, day] = String(item.date || '').split('-').map(Number)
  const label = month && day ? `${month}月${day}日 ${Number(item.hour || 0)}点` : escapeHtml(item.slotKey || '--')
  return `
    <div class="subscription-snapshot">
      <span>${escapeHtml(label)}</span>
      <b>用户 ${Number(item.userCount || 0)}</b>
      <b>有次数 ${Number(item.usersWithQuota || 0)}</b>
      <b>拒收 ${Number(item.wechatRejectedQuotaCount || 0)}</b>
    </div>
  `
}

function renderFeedback(data) {
  const items = data.recentItems || []
  $('#feedbackBox').innerHTML = `
    <div class="feedback-summary">
      <span>总数 <b>${data.totalCount || 0}</b></span>
      <span>未处理 <b>${data.newCount || 0}</b></span>
    </div>
    <div class="feedback-list">
      ${items.map(feedbackHtml).join('') || '<span class="muted">暂无反馈</span>'}
    </div>
  `
}

function feedbackHtml(item) {
  const content = String(item.content || '').trim()
  const clipped = content.length > 72 ? `${content.slice(0, 72)}...` : content
  return `
    <div class="feedback-item">
      <div>
        <span class="badge ${item.status === 'new' ? 'warn' : ''}">${escapeHtml(item.type || '反馈')}</span>
        <span class="feedback-time">${escapeHtml(formatDateTime(item.createdAt))}</span>
      </div>
      <p>${escapeHtml(clipped || '--')}</p>
      <code>${escapeHtml(maskOpenid(item.openid))}</code>
    </div>
  `
}

async function traceUser(event) {
  event.preventDefault()
  const openid = $('#traceOpenid').value.trim()
  const roundKey = $('#traceRoundKey').value.trim() || state.selectedRoundKey || state.latestRoundKey
  if (!openid) {
    $('#userTraceResult').innerHTML = '<span class="form-message">请先输入 openid</span>'
    return
  }
  if (!roundKey) {
    $('#userTraceResult').innerHTML = '<span class="form-message">请先输入 roundKey，或先读取缓存</span>'
    return
  }
  const confirmed = window.confirm('这会调用云函数查询该用户推送链路。确认继续？')
  if (!confirmed) return

  $('#userTraceResult').innerHTML = '<span class="muted">查询中...</span>'
  try {
    const result = await requestJson('/api/user-trace', {
      method: 'POST',
      body: JSON.stringify({
        openid,
        roundKey,
        confirmCloudCall: true
      })
    })
    renderUserTrace(result.trace && result.trace.response && result.trace.response.data)
  } catch (error) {
    $('#userTraceResult').innerHTML = `<span class="form-message">${escapeHtml(error.message)}</span>`
  }
}

function renderUserTrace(data) {
  if (!data) {
    $('#userTraceResult').innerHTML = '<span class="form-message">暂无诊断数据</span>'
    return
  }
  const diagnosis = data.diagnosis || {}
  const delivery = data.delivery || null
  $('#userTraceResult').innerHTML = `
    <div class="trace-card">
      <div>${badge(diagnosis.text || '暂无结论', diagnosis.level || '')}</div>
      <div class="trace-line"><span>轮次</span><b>${escapeHtml(data.roundKey || '--')}</b></div>
      <div class="trace-line"><span>openid</span><code>${escapeHtml(data.openid || '--')}</code></div>
      <div class="trace-line"><span>命中商品</span><b>${escapeHtml((data.matchedItems || []).join('、') || '--')}</b></div>
      <div class="trace-line"><span>delivery</span><b>${escapeHtml(translateDeliveryStatus(delivery && delivery.status))}</b></div>
      ${delivery && delivery.errorMsg ? `<p class="trace-error">${escapeHtml(delivery.errorMsg)}</p>` : ''}
      <div class="trace-section">
        <strong>订阅 / 次数</strong>
        ${(data.subscriptions || []).map(item => (
          `<div class="trace-line"><span>${escapeHtml(item.itemName || '--')}${item.wechatRejected ? ' · 微信拒收' : ''}</span><b>${Number(item.remainingCount || 0)} 次${item.previousRemainingCount ? ` / 原 ${Number(item.previousRemainingCount)} 次` : ''}</b></div>`
        )).join('') || '<div class="muted">无启用订阅</div>'}
      </div>
      <div class="trace-section">
        <strong>attempts / events</strong>
        <div class="trace-line"><span>attempts</span><b>${(data.attempts || []).length}</b></div>
        <div class="trace-line"><span>events</span><b>${(data.logs || []).length}</b></div>
      </div>
    </div>
  `
}

async function openRoundDetail(roundKey) {
  state.selectedRoundKey = roundKey
  if ($('#traceRoundKey')) $('#traceRoundKey').value = roundKey
  updateSelectedRoundText()
  $('#detailTitle').textContent = roundKey
  $('#detailDrawer').classList.add('open')
  await loadRoundDetail(false)
}

async function loadRoundDetail(forceCloud) {
  if (!state.selectedRoundKey) return
  if (forceCloud) {
    const confirmed = window.confirm('这会立即调用云函数拉取该轮明细。确认继续？')
    if (!confirmed) return
  }
  $('#detailBody').innerHTML = '<p class="form-message">加载中...</p>'
  try {
    const result = await requestJson('/api/round-detail', {
      method: 'POST',
      body: JSON.stringify({
        roundKey: state.selectedRoundKey,
        forceCloud,
        confirmCloudCall: forceCloud
      })
    })
    if (result.requiresCloudFetch) {
      $('#detailBody').innerHTML = '<p class="form-message">本地没有该轮详情缓存，需要点击“拉取详情云端”。</p>'
      return
    }
    renderRoundDetail(result.cache && result.cache.response && result.cache.response.data)
  } catch (error) {
    $('#detailBody').innerHTML = `<p class="form-message">${escapeHtml(error.message)}</p>`
  }
}

function renderRoundDetail(data) {
  if (!data) {
    $('#detailBody').innerHTML = '<p class="form-message">暂无详情数据</p>'
    return
  }
  const users = data.users || []
  const summary = data.summary || {}
  const deliveries = summary.deliveries || {}
  const coverage = summary.coverage || {}
  const detailFinalFailed = hasNumber(summary.flags && summary.flags.otherFinalFailedCount)
    ? Number(summary.flags.otherFinalFailedCount || 0)
    : Number(summary.queue && summary.queue.finalFailed || 0)
  const queue = { ...(summary.queue || {}), finalFailed: detailFinalFailed }
  $('#detailBody').innerHTML = `
    <div class="list-item"><span>用户数</span><b>${users.length}</b></div>
    <div class="list-item"><span>本轮商品</span><b>${escapeHtml(stripHtml(roundItemsHtml(summary.roundItems || [], summary.roundItemTotals)))}</b></div>
    <div class="list-item"><span>队列总数 / 已发 / 待处理</span><b>${queue.total || 0} / ${queue.sent || 0} / ${queue.pending || 0}</b></div>
    <div class="list-item"><span>可重试 / 最终失败 / 剩余批次</span><b>${queue.retryableFailed || 0} / ${queue.finalFailed || 0} / ${queue.remainingBatches || 0}</b></div>
    <div class="list-item"><span>采集时间 / 10分钟期限</span><b>${escapeHtml(formatDateTime(summary.capturedAt))} / ${escapeHtml(formatDateTime(summary.dispatchDeadlineAt))}</b></div>
    <div class="list-item"><span>候选 / delivery 覆盖</span><b>${coverage.matched || 0} / ${coverage.deliveries || 0}</b></div>
    <div class="list-item"><span>待处理 / 已处理 / 并发 / 批量</span><b>${coverage.pending || 0} / ${coverage.processed || 0} / ${coverage.concurrency || '--'} / ${coverage.batchLimit || '--'}</b></div>
    <div class="list-item"><span>deliveries / attempts / events</span><b>${data.rawCounts.deliveries} / ${data.rawCounts.attempts} / ${data.rawCounts.logs}</b></div>
    <div class="list-item"><span>待处理 delivery</span><b>${deliveries.pending || 0}</b></div>
    <div class="list-item"><span>发送中 delivery</span><b>${deliveries.sending || 0}</b></div>
    ${users.map(userDetailHtml).join('') || '<p>暂无用户明细</p>'}
  `
}

function userDetailHtml(user) {
  const delivery = user.delivery || null
  const attempts = (user.attempts || []).map(item => (
    `<div>${escapeHtml(item.createdAt || '--')} · 模板 <code>${escapeHtml(shortTemplateId(item.templateId))}</code> · ${escapeHtml(item.source || '--')} · ${escapeHtml(translateDeliveryStatus(item.status))}<code class="status-code">${escapeHtml(item.status || '')}</code> · ${escapeHtml(item.errorMsg || '')}</div>`
  )).join('')
  const logs = (user.logs || []).map(item => (
    `<div>${escapeHtml(item.sentAt || '--')} · 模板 <code>${escapeHtml(shortTemplateId(item.templateId))}</code> · ${escapeHtml(item.itemName || '--')} · ${escapeHtml(translateDeliveryStatus(item.status))}<code class="status-code">${escapeHtml(item.status || '')}</code> · ${escapeHtml(item.errorMsg || '')}</div>`
  )).join('')

  return `
    <div class="user-row">
      <strong>${escapeHtml(maskOpenid(user.openid))}</strong>
      <code>${escapeHtml(user.openid)}</code>
      <div>${(user.itemNames || []).map(name => `<span class="badge">${escapeHtml(name)}</span>`).join('')}</div>
      <div>${badge(translateDeliveryStatus(user.deliveryStatus), deliveryBadgeType(user.deliveryStatus))}<code class="status-code">${escapeHtml(user.deliveryStatus || '')}</code></div>
      ${delivery ? deliveryDetailHtml(delivery) : ''}
      <div class="timeline">${attempts || '<div>无 attempts</div>'}</div>
      <div class="timeline">${logs || '<div>无 events</div>'}</div>
    </div>
  `
}

function stripHtml(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text || '历史未记录'
}

function deliveryBadgeType(status) {
  if (status === 'sent') return 'good'
  if (status === 'pending' || status === 'sending' || status === 'no_quota') return 'warn'
  if (status === 'final_failed' || status === 'retryable_failed') return 'bad'
  return ''
}

function deliveryDetailHtml(delivery) {
  const postSend = delivery.postSend || null
  const quotaError = postSend && (postSend.quotaError || postSend.quotaRefundError || ((postSend.errors || []).find(error => String(error).includes('quota')) || ''))
  const candidates = (delivery.candidateTemplateIds || []).map(shortTemplateId).join(' → ') || '--'
  const rejected = (delivery.rejectedTemplateIds || []).map(shortTemplateId).join('、') || '--'
  return `
    <div class="delivery-meta">
      <span>发送 <b>${escapeHtml(translateDeliveryStatus(delivery.status))}</b></span>
      <span>扣次数 <b>${escapeHtml(quotaAuditText(delivery, postSend))}</b></span>
      <span>候选模板 <b>${escapeHtml(candidates)}</b></span>
      <span>拒收模板 <b>${escapeHtml(rejected)}</b></span>
      <span>delivery attempts <b>${Number(delivery.attemptCount || 0)}</b></span>
      <span>last ${escapeHtml(formatDateTime(delivery.lastAttemptAt))}</span>
      <span>lock ${escapeHtml(formatDateTime(delivery.lockedUntil))}</span>
    </div>
    ${quotaError ? `<p class="trace-error">${escapeHtml(quotaError)}</p>` : ''}
  `
}

function shortTemplateId(templateId) {
  const value = String(templateId || '').trim()
  if (!value) return '--'
  return value.length > 12 ? `…${value.slice(-12)}` : value
}

function quotaAuditText(delivery, postSend) {
  if (!delivery) return '--'
  if (delivery.status === 'final_failed' && isWechatRejectedText(delivery.errorMsg)) return '拒收归零'
  if (!postSend) return delivery.status === 'sent' ? '待补记' : '--'
  if (postSend.quotaRefundPending === true) return '待退回'
  if (postSend.quotaRefunded === true) return '已退回'
  if (delivery.status === 'sent' && postSend.quotaConsumed === true) return 'OK'
  if (postSend.quotaConsumed === true) return '已扣'
  if (postSend.quotaConsumePending === true) return '待补记'
  if (postSend.quotaError || postSend.quotaRefundError) return '失败'
  return delivery.status === 'sent' ? '待补记' : '--'
}

function isWechatRejectedText(text) {
  const value = String(text || '').toLowerCase()
  return value.includes('43101') || value.includes('user refuse') || value.includes('refuse to accept')
}

function updateSelectedRoundText() {
  const element = $('#selectedRoundText')
  if (!element) return
  element.textContent = state.selectedRoundKey
    ? `当前轮次：${state.selectedRoundKey}`
    : '当前轮次：未选择，请先点击左侧轮次行'
  element.classList.toggle('empty', !state.selectedRoundKey)
}

function operationConfirmText(operation, payload = {}) {
  if (operation === 'backfillWechatRejectedQuotas') {
    return payload.roundKey
      ? `这会回填选中轮次 ${payload.roundKey} 的微信拒收标记，不会替用户授权。确认继续？`
      : '这会扫描全部历史最终失败记录并回填微信拒收标记，可能耗时更久，不会替用户授权。确认继续？'
  }
  return '这会调用云函数执行运维操作。确认继续？'
}

function formatOperationResult(operation, response) {
  const data = response && response.data && response.data.data
    ? response.data.data
    : (response && response.data ? response.data : response)
  if (operation === 'backfillWechatRejectedQuotas' && data) {
    return `回填完成：扫描 ${Number(data.scanned || 0)} / 拒收 ${Number(data.rejectedDeliveries || 0)} / 更新 ${Number(data.updated || 0)}。请点“强制拉云端”刷新概览数字。`
  }
  return `完成：${JSON.stringify(response).slice(0, 800)}`
}

async function runOperation(operation, payload = {}) {
  const confirmed = window.confirm(operationConfirmText(operation, payload))
  if (!confirmed) return
  $('#operationMessage').textContent = '执行中...'
  try {
    const result = await requestJson('/api/admin/operation', {
      method: 'POST',
      body: JSON.stringify({
        operation,
        payload,
        confirmOperation: true
      })
    })
    $('#operationMessage').textContent = formatOperationResult(operation, result.response)
  } catch (error) {
    $('#operationMessage').textContent = error.message
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;')
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', login)
  $('#logoutBtn').addEventListener('click', logout)
  $('#reloadCacheBtn').addEventListener('click', loadCache)
  $('#forceRefreshBtn').addEventListener('click', forceRefresh)
  $('#closeDrawerBtn').addEventListener('click', () => $('#detailDrawer').classList.remove('open'))
  $('#loadDetailCacheBtn').addEventListener('click', () => loadRoundDetail(false))
  $('#loadDetailCloudBtn').addEventListener('click', () => loadRoundDetail(true))
  $('#userTraceForm').addEventListener('submit', traceUser)
  $('#loadAnnouncementBtn').addEventListener('click', loadAnnouncement)
  $('#announcementForm').addEventListener('submit', saveAnnouncement)
  $('#roundRows').addEventListener('click', event => {
    const row = event.target.closest('tr[data-round-key]')
    if (row) openRoundDetail(row.dataset.roundKey)
  })
  document.querySelectorAll('[data-operation]').forEach(button => {
    button.addEventListener('click', () => {
      const operation = button.dataset.operation
      const notify = button.dataset.notify
      let payload = {}
      if (button.dataset.payload) {
        try {
          payload = JSON.parse(button.dataset.payload)
        } catch (error) {
          $('#operationMessage').textContent = `按钮参数错误：${error.message}`
          return
        }
      }
      if (notify !== undefined) payload.notify = notify === 'true'
      if (button.dataset.round === 'selected') {
        if (!state.selectedRoundKey) {
          $('#operationMessage').textContent = '请先点击左侧轮次行。'
          return
        }
        payload.roundKey = state.selectedRoundKey
      }
      runOperation(operation, payload)
    })
  })
  $('#resetTesterBtn').addEventListener('click', () => {
    const openids = $('#resetOpenids').value.split(',').map(item => item.trim()).filter(Boolean)
    runOperation('resetTesterData', { openids })
  })
}

bindEvents()
updateSelectedRoundText()
checkSession().catch(error => {
  $('#loginPanel').classList.remove('is-hidden')
  $('#loginMessage').textContent = error.message
})
