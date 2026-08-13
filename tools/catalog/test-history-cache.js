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

const {
  HISTORY_CACHE_KEY,
  mergeHistoryRecords,
  readHistoryCache,
  writeHistoryCache
} = require(path.join(ROOT, 'utils/history-cache'))

storage[HISTORY_CACHE_KEY] = {
  records: [{
    roundKey: '2026-08-01_round_1',
    date: '2026-08-01',
    round: 1,
    dateText: '2026年8月1日',
    items: [
      { name: '普通粉尘', historyDateText: '2026年8月1日', hasImage: true },
      { name: '普通粉尘', historyDateText: '2026年8月1日', hasImage: true }
    ]
  }],
  checkedUntilRoundKey: '2026-08-01_round_1'
}

const legacyCache = readHistoryCache()
assert.strictEqual(legacyCache.records.length, 1)
assert.strictEqual(legacyCache.records[0].items.length, 1)
assert.strictEqual(legacyCache.records[0].dateText, undefined)
assert.strictEqual(legacyCache.records[0].items[0].historyDateText, undefined)
assert.strictEqual(legacyCache.metadata.checkedUntilRoundKey, '2026-08-01_round_1')

const identicalMerge = mergeHistoryRecords(legacyCache.records, legacyCache.records)
assert.strictEqual(identicalMerge.changed, false)
assert.deepStrictEqual(identicalMerge.changedDates, [])

const replacementMerge = mergeHistoryRecords(legacyCache.records, [{
  date: '2026-08-01',
  round: 1,
  items: [{ name: '黑晶琉璃' }]
}])
assert.strictEqual(replacementMerge.changed, true)
assert.deepStrictEqual(replacementMerge.changedRoundKeys, ['2026-08-01_round_1'])
assert.deepStrictEqual(replacementMerge.changedDates, ['2026-08-01'])
assert.deepStrictEqual(replacementMerge.records[0].items.map(item => item.name), ['黑晶琉璃'])

const written = writeHistoryCache(replacementMerge.records, {
  checkedUntilRoundKey: '2026-08-01_round_1',
  lastAttemptRoundKey: '2026-08-01_round_2',
  lastAttemptAt: 123
})
assert.strictEqual(written.records.length, 1)
assert.strictEqual(written.metadata.lastAttemptRoundKey, '2026-08-01_round_2')
assert.strictEqual(storage[HISTORY_CACHE_KEY].records[0].dateText, undefined)
assert.strictEqual(storage[HISTORY_CACHE_KEY].lastAttemptAt, 123)

process.stdout.write('history cache tests passed\n')
