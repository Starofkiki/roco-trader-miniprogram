const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const cachedCatalog = {
  version: 'stats-test',
  products: [{
    product_id: 'product_stats_test',
    title: '统计测试商品',
    category: '养成材料',
    status: 'active',
    has_rolling_stats: true,
    stats_updated_round_key: '2026-08-04_round_2',
    stats_as_of_date: '2026-08-04',
    appear_count_7d: 0,
    appear_count_30d: 8,
    last_occurrences: [{ date: '2026-08-04', round: 2, round_key: '2026-08-04_round_2' }],
    has_season_rates: true,
    season_rate_scope: 'group',
    season_rate_scope_label: '矿石',
    appear_rate_current_season: 0,
    appear_rate_last_season: 3.25,
    appear_rate_s1: null,
    season_stats_updated_round_key: '2026-08-04_round_2'
  }],
  offers: [{
    offer_id: 'offer_stats_test',
    product_id: 'product_stats_test',
    sale_group: 'normal',
    offer_type: 'normal_pool',
    enable: true
  }],
  follow_targets: []
}

global.wx = {
  getStorageSync(key) {
    return key === 'product_catalog_cache_v1' ? cachedCatalog : null
  },
  setStorageSync() {}
}

const products = require(path.join(ROOT, 'utils/products'))
const product = products.getProductById('product_stats_test')
assert(product)
assert.strictEqual(product.has_rolling_stats, true)
assert.strictEqual(product.appear_count_7d, 0)
assert.strictEqual(product.appear_count_30d, 8)
assert.strictEqual(product.last_occurrences[0].round_key, '2026-08-04_round_2')
assert.strictEqual(product.appear_rate_current_season, 0)
assert.strictEqual(product.appear_rate_last_season, 3.25)
assert.strictEqual(product.appear_rate_s1, null)
assert.strictEqual(product.season_rate_scope, 'group')
assert.strictEqual(product.season_rate_scope_label, '矿石')

process.stdout.write('product stats catalog field tests passed\n')
