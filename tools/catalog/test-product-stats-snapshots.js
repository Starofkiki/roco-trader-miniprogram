const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const {
  SEASONS,
  buildRollingSnapshot,
  buildSeasonSnapshot,
  getSeasonMonths,
  getSeasonRateScope,
  mergeRollingSnapshot
} = require(path.join(ROOT, 'cloudfunctions/rocoApi/product-stats-snapshots'))

const catalog = {
  normal_a: { product_id: 'normal_a', title: '普通商品A', category: '养成材料', sale_group: 'normal' },
  normal_b: { product_id: 'normal_b', title: '普通商品B', category: '养成材料', sale_group: 'normal' },
  prism: { product_id: 'prism', title: '棱镜球', category: '咕噜球', sale_group: 'normal' },
  ore_a: { product_id: 'ore_a', title: '矿石A', category: '矿石', sale_group: 'normal' },
  ore_b: { product_id: 'ore_b', title: '矿石B', category: '矿石', sale_group: 'normal' },
  dust_a: { product_id: 'dust_a', title: '粉尘A', category: '粉尘', sale_group: 'normal' },
  blood_common: { product_id: 'blood_common', title: '机械血脉秘药', category: '血脉秘药', sale_group: 'normal' },
  blood_strange: { product_id: 'blood_strange', title: '奇异血脉秘药', category: '血脉秘药', sale_group: 'normal' },
  blood_leader: { product_id: 'blood_leader', title: '首领血脉秘药', category: '血脉秘药', sale_group: 'normal' },
  daily: { product_id: 'daily', title: '热购球', category: '咕噜球', sale_group: 'daily-hot' },
  fixed: { product_id: 'fixed', title: '固定限购', category: '养成材料', sale_group: 'fixed-hot' }
}

function resolveProduct(item) {
  return catalog[item.product_id] || null
}

function record(date, round, productIds) {
  return {
    roundKey: `${date}_round_${round}`,
    date,
    round,
    items: productIds.map(product_id => ({ product_id }))
  }
}

const s1Records = [
  record('2026-04-28', 1, ['normal_a', 'normal_a', 'prism', 'daily']),
  record('2026-04-28', 2, ['prism']),
  record('2026-04-28', 3, ['prism']),
  record('2026-04-28', 4, ['prism']),
  record('2026-05-20', 4, ['normal_a']),
  record('2026-05-21', 1, ['normal_b'])
]
const s1 = buildSeasonSnapshot(SEASONS[0], s1Records, resolveProduct, {
  countOverrides: { prism: 2 },
  manualCorrections: { prism: 'S1棱镜球固定校正为2次' }
})
assert.strictEqual(s1.source_record_count, 5)
assert.strictEqual(s1.products.normal_a.occurrence_count, 2)
assert.strictEqual(s1.products.prism.occurrence_count, 2)
assert.strictEqual(s1.total_normal_occurrences, 4)
assert.strictEqual(s1.products.normal_a.appear_rate, 50)
assert.strictEqual(s1.products.prism.appear_rate, 50)
assert.strictEqual('daily' in s1.products, false)

const s2 = buildSeasonSnapshot(SEASONS[1], [
  record('2026-05-20', 4, ['normal_a']),
  record('2026-05-21', 1, ['normal_b']),
  record('2026-07-15', 4, ['normal_a']),
  record('2026-07-16', 1, ['normal_a'])
], resolveProduct)
assert.strictEqual(s2.source_record_count, 2)
assert.strictEqual(s2.total_normal_occurrences, 2)
assert.strictEqual(s2.products.normal_a.appear_rate, 50)
assert.strictEqual(s2.products.normal_b.appear_rate, 50)

const s3 = buildSeasonSnapshot(SEASONS[2], [
  record('2026-07-15', 4, ['normal_a']),
  record('2026-07-16', 1, ['normal_a', 'ore_a', 'blood_common', 'blood_strange']),
  record('2026-09-10', 1, ['normal_b', 'ore_b', 'blood_leader', 'dust_a']),
  record('2026-09-10', 2, ['normal_b', 'blood_common']),
  record('2026-09-10', 3, ['normal_a']),
  record('2026-09-11', 1, ['normal_a'])
], resolveProduct)
assert.strictEqual(s3.source_record_count, 4)
assert.strictEqual(s3.total_normal_occurrences, 11)
assert.strictEqual(s3.products.normal_a.appear_rate, 18.2)
assert.strictEqual(s3.products.normal_b.appear_rate, 18.2)
assert.deepStrictEqual(s3.groups.矿石, { occurrence_count: 2, appear_rate: 18.2 })
assert.deepStrictEqual(s3.groups.粉尘, { occurrence_count: 1, appear_rate: 9.1 })
assert.deepStrictEqual(s3.groups.血脉秘药, { occurrence_count: 4, appear_rate: 36.4 })
assert.deepStrictEqual(getSeasonRateScope(catalog.ore_a), { type: 'group', key: '矿石', label: '矿石' })
assert.deepStrictEqual(getSeasonRateScope(catalog.blood_common), { type: 'group', key: '血脉秘药', label: '血脉秘药' })
assert.deepStrictEqual(getSeasonRateScope(catalog.blood_strange), { type: 'product', key: 'blood_strange', label: '' })
assert.deepStrictEqual(getSeasonRateScope(catalog.blood_leader), { type: 'product', key: 'blood_leader', label: '' })

const rollingRecords = [
  record('2026-08-01', 1, ['normal_a', 'daily', 'fixed', 'prism']),
  record('2026-08-01', 2, ['daily', 'prism']),
  record('2026-08-01', 3, ['daily', 'prism']),
  record('2026-08-01', 4, ['daily', 'prism']),
  record('2026-08-02', 1, ['normal_a', 'fixed']),
  record('2026-08-03', 1, ['fixed'])
]
const rolling = buildRollingSnapshot(rollingRecords, resolveProduct)
assert.strictEqual(rolling.products.normal_a.appear_count_7d, 2)
assert.strictEqual(rolling.products.prism.appear_count_7d, 1)
assert.strictEqual(rolling.products.daily.appear_count_7d, 1)
assert.strictEqual(rolling.products.fixed.appear_count_7d, 2)
assert.deepStrictEqual(rolling.products.normal_a.last_occurrences.map(item => item.round_key), [
  '2026-08-02_round_1',
  '2026-08-01_round_1'
])

const merged = mergeRollingSnapshot({
  products: {
    normal_b: {
      appear_count_7d: 1,
      appear_count_30d: 1,
      last_occurrences: [{ date: '2026-06-01', round: 1, round_key: '2026-06-01_round_1' }]
    }
  }
}, rolling)
assert.strictEqual(merged.products.normal_b.appear_count_7d, 0)
assert.strictEqual(merged.products.normal_b.appear_count_30d, 0)
assert.strictEqual(merged.products.normal_b.last_occurrences[0].round_key, '2026-06-01_round_1')

assert.deepStrictEqual(getSeasonMonths(SEASONS[0]), ['2026-03', '2026-04', '2026-05'])
assert.deepStrictEqual(getSeasonMonths(SEASONS[2]), ['2026-07', '2026-08', '2026-09'])

process.stdout.write('product stats snapshot tests passed\n')
