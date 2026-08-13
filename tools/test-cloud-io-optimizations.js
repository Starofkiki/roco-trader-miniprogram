const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const apiSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions/rocoApi/index.js'), 'utf8')
const homeSource = fs.readFileSync(path.join(ROOT, 'pages/home/home.js'), 'utf8')

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0, `missing ${startMarker}`)
  assert(end > start, `missing end marker ${endMarker}`)
  return source.slice(start, end)
}

const currentMerchant = functionSource(
  apiSource,
  'async function getCurrentMerchant(',
  'async function getHistoryRecords('
)
assert(!currentMerchant.includes('fetchRocomMerchantInfo'))
assert(!currentMerchant.includes('recordMerchantSnapshot'))
assert(currentMerchant.includes('pending: true'))

const historyBundle = functionSource(
  apiSource,
  'async function getHistoryBundle(',
  'async function getHistoryRecordsByKeys('
)
assert(!historyBundle.includes('collectCurrentMerchant'))
assert(!historyBundle.includes('recordMerchantSnapshot'))
assert(!historyBundle.includes('setDoc('))

const dispatcher = functionSource(
  apiSource,
  'async function dispatchRocoAction(',
  'exports.main = async ('
)
assert(!dispatcher.includes('await loadProductCatalogRuntime()'))
assert(dispatcher.includes("case 'home.bootstrap':"))
assert(dispatcher.includes("case 'products.catalogV2':"))
assert(dispatcher.includes("case 'products.statsSnapshots':"))

const homeOnShow = functionSource(homeSource, '  onShow() {', '  onHide() {')
assert(homeOnShow.includes('this.loadHomeBootstrap()'))
assert(!homeOnShow.includes('callCloudApi('))

assert(apiSource.includes("query = query.orderBy(orderField, 'desc').orderBy('_id', 'desc')"))
assert(apiSource.includes('query.limit(pageSize + 1).get()'))
assert(apiSource.includes("selectionSignature: getFollowedItemsSignature(followedItems)"))
assert(!apiSource.includes('existingRoundDeliveries'))

process.stdout.write('cloud IO optimization boundary tests passed\n')
