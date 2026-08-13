const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const TEST_FILES = [
  'tools/catalog/test-history-cache.js',
  'tools/catalog/test-product-catalog.js',
  'tools/catalog/test-product-detail-render.js',
  'tools/catalog/test-product-history-stats.js',
  'tools/catalog/test-product-image-cache.js',
  'tools/catalog/test-product-list-page.js',
  'tools/catalog/test-product-stats-catalog-fields.js',
  'tools/catalog/test-product-stats-snapshots.js',
  'tools/catalog/test-stats-history-performance.js',
  'tools/catalog/test-stats-history-sync.js',
  'tools/catalog/test-stats-product-list.js',
  'tools/simulations/notify-flow-sim.js',
  'tools/test-cloud-io-optimizations.js',
  'tools/test-feedback-replies.js'
]

for (const relativePath of TEST_FILES) {
  console.log(`\n> node ${relativePath}`)
  const result = spawnSync(process.execPath, [path.join(ROOT, relativePath)], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(`\n全部 ${TEST_FILES.length} 个回归脚本通过。`)
