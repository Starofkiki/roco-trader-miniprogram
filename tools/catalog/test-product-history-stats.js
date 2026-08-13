const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const products = require(path.join(ROOT, 'utils/products'))
const {
  buildProductDetailHistoryStats,
  buildProductHistoryStats,
  getHistoryRefreshKey,
  normalizeUniqueRecords
} = require(path.join(ROOT, 'utils/product-history-stats'))

const product = products.getProductByTitle('普通粉尘')
const now = new Date(2026, 7, 2, 12, 15, 0)
const records = [
  { date: '2026-08-02', round: 2, items: [{ name: '普通粉尘' }] },
  { date: '2026-08-02', round: 2, items: [{ product_id: product.product_id, name: '普通粉尘' }] },
  { date: '2026-08-02', round: 1, items: [{ name: '普通粉尘' }] },
  { date: '2026-07-28', round: 3, items: [{ name: '普通粉尘' }] },
  { date: '2026-07-10', round: 4, items: [{ name: '普通粉尘' }] },
  { date: '2026-07-03', round: 4, items: [{ name: '普通粉尘' }] },
  { date: '2026-08-02', round: 3, items: [{ name: '黑晶琉璃' }] }
]

assert.strictEqual(normalizeUniqueRecords(records).length, 6)
assert.deepStrictEqual(normalizeUniqueRecords([{
  roundKey: '2026-08-01_round_4',
  items: [{ name: '普通粉尘' }]
}]).map(record => ({ date: record.date, round: record.round })), [{ date: '2026-08-01', round: 4 }])
assert.deepStrictEqual(buildProductHistoryStats(product, records, { now }), {
  lastSeenDateText: '8月2日',
  lastSeenRoundText: '第一轮',
  sevenDayCount: 3,
  sevenDayCountText: '3次',
  thirtyDayCount: 4,
  thirtyDayCountText: '4次'
})
assert.deepStrictEqual(buildProductHistoryStats(product, [], { now }), {
  lastSeenDateText: '暂无记录',
  lastSeenRoundText: '',
  sevenDayCount: 0,
  sevenDayCountText: '0次',
  thirtyDayCount: 0,
  thirtyDayCountText: '0次'
})
assert.strictEqual(getHistoryRefreshKey(new Date(2026, 7, 2, 12, 9, 0)), '2026-08-02_round_1')
assert.strictEqual(getHistoryRefreshKey(new Date(2026, 7, 2, 12, 10, 0)), '2026-08-02_round_2')

function buildWeekendRecords(name) {
  return ['2026-08-07', '2026-08-08', '2026-08-09'].flatMap(date => {
    return [1, 2, 3, 4].map(round => ({ date, round, items: [{ name }] }))
  })
}

const weekendNow = new Date(2026, 7, 9, 21, 0, 0)
const dailyHotStats = buildProductHistoryStats(
  products.getProductByTitle('绝缘球'),
  buildWeekendRecords('绝缘球'),
  { now: weekendNow, saleGroup: 'daily-hot' }
)
assert.strictEqual(dailyHotStats.sevenDayCountText, '3次')
assert.strictEqual(dailyHotStats.thirtyDayCountText, '3次')

const fixedHotStats = buildProductHistoryStats(
  products.getProductByTitle('残缺魔镜'),
  buildWeekendRecords('残缺魔镜'),
  { now: weekendNow, saleGroup: 'fixed-hot' }
)
assert.strictEqual(fixedHotStats.sevenDayCountText, '1次')
assert.strictEqual(fixedHotStats.thirtyDayCountText, '1次')

const regularStats = buildProductHistoryStats(
  product,
  buildWeekendRecords('普通粉尘'),
  { now: weekendNow, saleGroup: 'normal' }
)
assert.strictEqual(regularStats.sevenDayCountText, '12次')

const prismStats = buildProductHistoryStats(
  products.getProductByTitle('棱镜球'),
  buildWeekendRecords('棱镜球'),
  { now: weekendNow, saleGroup: 'normal' }
)
assert.strictEqual(prismStats.sevenDayCountText, '3次')

const snapshotProduct = {
  ...product,
  has_rolling_stats: true,
  stats_updated_round_key: '2026-08-02_round_2',
  appear_count_7d: 9,
  appear_count_30d: 21,
  last_occurrences: [
    { date: '2026-08-02', round: 2, round_key: '2026-08-02_round_2' },
    { date: '2026-08-01', round: 4, round_key: '2026-08-01_round_4' }
  ],
  appear_rate_current_season: 4,
  appear_rate_last_season: 3.25,
  appear_rate_s1: 0,
  season_rate_scope: 'group',
  season_rate_scope_label: '血脉秘药'
}
const snapshotStats = buildProductDetailHistoryStats(snapshotProduct, [], {
  now,
  saleGroup: 'normal',
  currentRoundKey: '2026-08-02_round_2'
})
assert.strictEqual(snapshotStats.lastSeenDateText, '8月1日')
assert.strictEqual(snapshotStats.lastSeenRoundText, '第四轮')
assert.strictEqual(snapshotStats.sevenDayCountText, '9次')
assert.strictEqual(snapshotStats.thirtyDayCountText, '21次')
assert.deepStrictEqual(snapshotStats.seasonRateRows.map(item => item.valueText), ['4.0%', '3.3%', '0.0%'])
assert.strictEqual(snapshotStats.showSeasonRates, true)
assert.strictEqual(snapshotStats.seasonRateTitle, '赛季出现频率（血脉秘药）')
assert.strictEqual(snapshotStats.showS1DataNote, true)

const individualSnapshotStats = buildProductDetailHistoryStats({
  ...snapshotProduct,
  season_rate_scope: 'product',
  season_rate_scope_label: ''
}, [], { now, saleGroup: 'normal' })
assert.strictEqual(individualSnapshotStats.seasonRateTitle, '赛季出现频率')

const hotSnapshotStats = buildProductDetailHistoryStats(snapshotProduct, [], {
  now,
  saleGroup: 'daily-hot'
})
assert.strictEqual(hotSnapshotStats.showSeasonRates, false)
assert.deepStrictEqual(hotSnapshotStats.seasonRateRows, [])
assert.strictEqual(hotSnapshotStats.showS1DataNote, false)

const detailWxml = fs.readFileSync(path.join(ROOT, 'pages/product-detail/index.wxml'), 'utf8')
assert(detailWxml.includes('{{historyStats.seasonRateTitle}}'))
assert(detailWxml.includes('S1数据存在遗漏，出现频率可能不准确，仅供参考。'))

process.stdout.write('product history stats tests passed\n')
