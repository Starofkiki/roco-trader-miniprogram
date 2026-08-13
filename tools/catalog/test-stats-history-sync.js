const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const storage = {}
global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
  }
}
global.Page = config => {
  global.__statsPageConfig = config
}

const cloudApi = require(path.join(ROOT, 'utils/cloud-api'))
const cloudCalls = []
cloudApi.callCloudApi = (action, data) => {
  cloudCalls.push({ action, data })
  return Promise.resolve({ success: true, data: global.__historyBundleResult })
}

require(path.join(ROOT, 'pages/stats/stats'))
const pageConfig = global.__statsPageConfig

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function buildRoundKey(date, round) {
  return `${formatDate(date)}_round_${round}`
}

function getRoundKeys(now) {
  const hour = now.getHours()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (hour < 8) return { current: '', completed: buildRoundKey(yesterday, 4) }
  const currentRound = Math.floor((hour - 8) / 4) + 1
  const current = currentRound <= 4 ? buildRoundKey(today, currentRound) : ''
  if (hour < 12) return { current, completed: buildRoundKey(yesterday, 4) }
  return { current, completed: buildRoundKey(today, Math.min(3, currentRound - 1)) }
}

function recordFromRoundKey(roundKey) {
  const match = roundKey.match(/^(\d{4}-\d{2}-\d{2})_round_([1-4])$/)
  return {
    roundKey,
    date: match[1],
    round: Number(match[2]),
    items: [{ name: '普通粉尘' }]
  }
}

async function run() {
  const keys = getRoundKeys(new Date())
  const records = [recordFromRoundKey(keys.completed)]
  if (keys.current) records.unshift(recordFromRoundKey(keys.current))
  const freshState = {
    records,
    metadata: {
      checkedUntilRoundKey: keys.current || keys.completed,
      includedCurrentRoundKey: keys.current,
      currentRoundKey: keys.current,
      backfillComplete: true
    }
  }

  const freshResult = await pageConfig.loadCachedHistory.call({}, {
    cacheState: freshState,
    automatic: true
  })
  assert.strictEqual(cloudCalls.length, 0)
  assert.strictEqual(freshResult.changed, false)

  if (keys.current) {
    const coolingState = {
      records: [recordFromRoundKey(keys.completed)],
      metadata: {
        checkedUntilRoundKey: keys.completed,
        includedCurrentRoundKey: '',
        lastAttemptRoundKey: keys.current,
        lastAttemptAt: Date.now(),
        backfillComplete: true
      }
    }
    await pageConfig.loadCachedHistory.call({}, {
      cacheState: coolingState,
      automatic: true
    })
    assert.strictEqual(cloudCalls.length, 0)

    global.__historyBundleResult = {
      records,
      latestRoundKey: keys.current,
      oldestRoundKey: keys.completed,
      currentRoundKey: keys.current,
      includedCurrentRoundKey: keys.current
    }
    const synced = await pageConfig.loadCachedHistory.call({}, {
      cacheState: coolingState,
      force: true
    })
    assert.strictEqual(cloudCalls.length, 1)
    assert.strictEqual(synced.cacheState.metadata.includedCurrentRoundKey, keys.current)

    await pageConfig.loadCachedHistory.call({}, {
      cacheState: synced.cacheState,
      automatic: true
    })
    assert.strictEqual(cloudCalls.length, 1)
  }

  let resolveRefresh
  let refreshCalls = 0
  const refreshContext = {
    data: { historyRefreshing: false },
    setData(patch) {
      Object.assign(this.data, patch)
    },
    loadHistory(options) {
      refreshCalls += 1
      assert.deepStrictEqual(options, { force: true })
      return new Promise(resolve => {
        resolveRefresh = resolve
      })
    }
  }
  const firstRefresh = pageConfig.refreshHistoryFromButton.call(refreshContext)
  const repeatedRefresh = pageConfig.refreshHistoryFromButton.call(refreshContext)
  assert.strictEqual(refreshContext.data.historyRefreshing, true)
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(repeatedRefresh, firstRefresh)
  resolveRefresh()
  await firstRefresh
  assert.strictEqual(refreshContext.data.historyRefreshing, false)

  process.stdout.write('stats history sync tests passed\n')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
