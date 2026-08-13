const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { getProductImageFileId } = require('./product-image-map')

const ROOT = path.resolve(__dirname, '../..')
const PRODUCT_SOURCE = path.join(ROOT, 'rocom_target_items_with_scores.json')
const OFFER_SOURCE = path.join(ROOT, 'RANDOM_GOODS_CONF.json')
const ID_MAP_PATH = path.join(ROOT, 'docs/data/product-id-map.json')
const REPORT_PATH = path.join(ROOT, 'docs/data/product-catalog-migration-report.json')
const OUTPUT_PATHS = [
  path.join(ROOT, 'utils/product-data.js'),
  path.join(ROOT, 'cloudfunctions/rocoApi/product-catalog-fallback.js'),
  path.join(ROOT, 'cloudfunctions/rocoAdminApi/product-catalog-fallback.js')
]

const CATEGORY_ORDER = ['精灵蛋', '咕噜球', '血脉秘药', '矿石', '粉尘', '养成道具', '养成材料']
const EXPLICIT_ALIASES = {
  '炫彩精灵蛋': ['炫彩蛋'],
  '黑白炫彩蛋': ['黑白炫彩精灵蛋'],
  '赛季炫彩蛋': ['赛季炫彩精灵蛋'],
  '国王球': ['国王咕噜球']
}
const INACTIVE_PRODUCT_TITLES = new Set([
  '黑白炫彩蛋',
  '赛季炫彩蛋',
  '织梦棱镜球',
  '捕光球',
  '高级咕噜球',
  '可可果球',
  '普通咕噜球',
  '万能血脉秘药',
  '魔法粉尘'
])
const FIXED_OFFERS = [
  { offer_id: 'fixed_hot_incomplete_mirror', title: '残缺魔镜', price: 480000, buy_limit: 1 },
  { offer_id: 'fixed_hot_qualified_key', title: '适格钥匙', price: 320000, buy_limit: 1 },
  { offer_id: 'fixed_hot_ability_key', title: '能力钥匙', price: 160000, buy_limit: 6 }
]
const FOLLOW_TARGET_DEFS = [
  { id: 'prism_ball', name: '棱镜球', group: 'recommended', icon: '球', titles: ['棱镜球'], all_day: true },
  { id: 'colorful_egg', name: '炫彩蛋', group: 'recommended', icon: '蛋', titles: ['炫彩精灵蛋', '黑白炫彩蛋', '赛季炫彩蛋'] },
  { id: 'blessing_pendant', name: '祝福项坠', group: 'recommended', icon: '坠', titles: ['祝福项坠'] },
  { id: 'leader_blood_potion', name: '首领血脉秘药', group: 'recommended', icon: '药', titles: ['首领血脉秘药'] },
  { id: 'king_ball', name: '国王球', group: 'recommended', icon: '王', titles: ['国王球'] },
  {
    id: 'fixed_hot_bundle',
    name: '钥匙镜子',
    group: 'recommended',
    icon: '钥',
    titles: FIXED_OFFERS.map(item => item.title),
    aliases: ['三日固定限购'],
    display_image_title: '适格钥匙',
    tip: '残缺魔镜、适格钥匙、能力钥匙',
    reminder_policy: 'weekly_friday_round_1'
  },
  { id: 'magic_egg', name: '神奇的蛋', group: 'other', icon: '蛋', titles: ['神奇的蛋'] },
  { id: 'element_blood_potion', name: '血脉秘药', group: 'other', icon: '药', category: '血脉秘药', tip: '包含多个同类商品关键词' },
  { id: 'ore', name: '矿石', group: 'other', icon: '矿', category: '矿石', tip: '包含多个同类商品关键词' },
  { id: 'dust', name: '粉尘', group: 'other', icon: '尘', category: '粉尘', tip: '包含多个同类商品关键词' },
  { id: 'magic_fruit', name: '魔力果', group: 'other', icon: '果', titles: ['魔力果'] }
]

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizeName(value) {
  return String(value || '').replace(/[\s*＊·・\-_/\\|｜]+/g, '').trim()
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function createId(title) {
  return `product_${crypto.createHash('sha1').update(title).digest('hex').slice(0, 12)}`
}

function loadIdMap() {
  return fs.existsSync(ID_MAP_PATH) ? readJson(ID_MAP_PATH) : {}
}

function createVariantProducts(sourceProducts) {
  const colorfulEgg = sourceProducts.find(product => product.title === '炫彩精灵蛋') || {}
  return [
    {
      title: '黑白炫彩蛋',
      alias: '黑白炫彩精灵蛋',
      category: '精灵蛋',
      description: '炫彩精灵蛋的黑白特殊类型，详细资料待补充。',
      obtain: '远行商人处购买获得',
      image: colorfulEgg.image || '',
      rarity: 'rare',
      default_score: 5
    },
    {
      title: '赛季炫彩蛋',
      alias: '赛季炫彩精灵蛋',
      category: '精灵蛋',
      description: '炫彩精灵蛋的赛季特殊类型，详细资料待补充。',
      obtain: '远行商人处购买获得',
      image: colorfulEgg.image || '',
      rarity: 'rare',
      default_score: 5
    }
  ]
}

function buildProducts(sourceProducts, idMap) {
  const allSourceProducts = sourceProducts.concat(createVariantProducts(sourceProducts))
  const titleCounts = allSourceProducts.reduce((counts, product) => {
    const key = normalizeName(product.title)
    counts[key] = Number(counts[key] || 0) + 1
    return counts
  }, {})
  const products = allSourceProducts.map(source => {
    const title = String(source.title || '').trim()
    if (!title || titleCounts[normalizeName(title)] !== 1) {
      throw new Error(`商品正式名称为空或重复: ${title || '(empty)'}`)
    }
    if (!idMap[title]) idMap[title] = createId(title)

    const explicitAliases = EXPLICIT_ALIASES[title] || []
    const aliases = unique(explicitAliases)

    return {
      product_id: idMap[title],
      title,
      aliases,
      category: source.category || '未知',
      description: source.description || '',
      obtain: source.obtain || '',
      rarity: source.rarity === 'rare' ? 'rare' : 'normal',
      default_score: Number(source.default_score || 0),
      image_file_id: getProductImageFileId(idMap[title]),
      image_url: source.image || '',
      status: INACTIVE_PRODUCT_TITLES.has(title) ? 'inactive' : 'active'
    }
  })

  return products.sort((a, b) => {
    if (a.rarity !== b.rarity) return a.rarity === 'rare' ? -1 : 1
    const categoryDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    if (categoryDiff !== 0) return categoryDiff
    const scoreDiff = b.default_score - a.default_score
    return scoreDiff || String(a.title).localeCompare(String(b.title))
  })
}

function buildProductIndex(products) {
  const byName = {}
  products.forEach(product => {
    ;[product.title].concat(product.aliases || []).forEach(name => {
      const key = normalizeName(name)
      if (key && !byName[key]) byName[key] = product
    })
  })
  return byName
}

function buildOffers(offerRows, products) {
  const productByName = buildProductIndex(products)
  const excludes = ['国王球', '棱镜球', '高级咕噜球', '普通咕噜球']
  const unmatched = []
  const offers = offerRows.map(row => {
    const rawName = String(row.goods_name || '').trim()
    const product = productByName[normalizeName(rawName)]
    if (!product) unmatched.push({ source_row_id: row.id, raw_name: rawName })
    const saleGroup = rawName.endsWith('球') && !excludes.includes(rawName) ? 'daily-hot' : 'normal'
    return {
      offer_id: `rocom_offer_${row.id}`,
      product_id: product ? product.product_id : '',
      raw_name: rawName,
      sale_group: saleGroup,
      offer_type: row.is_special_good ? 'special_pool' : 'normal_pool',
      price: Number(row.price || 0),
      buy_limit: Number(row.buy_limit_num || 0),
      enable: row.enable !== false,
      source_row_id: Number(row.id || 0),
      external_item_id: Number(row.item_id || 0) || null,
    }
  })

  FIXED_OFFERS.forEach(row => {
    const product = productByName[normalizeName(row.title)]
    offers.push({
      offer_id: row.offer_id,
      product_id: product ? product.product_id : '',
      raw_name: row.title,
      sale_group: 'fixed-hot',
      offer_type: 'fixed_hot',
      price: row.price,
      buy_limit: row.buy_limit,
      enable: true,
      source_row_id: null,
      external_item_id: null,
    })
  })

  const offeredProductIds = new Set(offers.map(offer => offer.product_id).filter(Boolean))
  products
    .filter(product => product.title.endsWith('球') && !excludes.includes(product.title) && !offeredProductIds.has(product.product_id))
    .forEach(product => {
      offers.push({
        offer_id: `derived_daily_hot_${product.product_id}`,
        product_id: product.product_id,
        raw_name: product.title,
        sale_group: 'daily-hot',
        offer_type: 'derived_daily_hot',
        price: 3000,
        buy_limit: 100,
        enable: true,
        source_row_id: null,
        external_item_id: null,
      })
    })

  return { offers, unmatched }
}

function buildFollowTargets(products) {
  return FOLLOW_TARGET_DEFS.map(def => {
    const matched = products.filter(product => {
      if (product.status === 'inactive') return false
      return (def.titles || []).includes(product.title) ||
        (def.category && product.category === def.category) ||
        false
    })
    const displayProduct = matched.find(product => product.title === def.display_image_title)
    return {
      id: def.id,
      name: def.name,
      group: def.group,
      icon: def.icon,
      tip: def.tip || '',
      all_day: def.all_day === true,
      reminder_policy: def.reminder_policy || '',
      display_product_id: displayProduct ? displayProduct.product_id : '',
      product_ids: matched.map(product => product.product_id),
      keywords: unique([def.name].concat(def.aliases || [], matched.flatMap(product => [product.title].concat(product.aliases || []))))
    }
  })
}

function compareCloudProducts(products, cloudProducts) {
  const byTitle = new Map(products.map(product => [normalizeName(product.title), product]))
  const conflicts = []
  const additions = []
  ;(cloudProducts || []).forEach(raw => {
    const title = String(raw.title || raw.name || '').trim()
    if (!title) return
    const existing = byTitle.get(normalizeName(title))
    if (!existing) {
      additions.push(title)
      return
    }
    ;['category', 'description', 'obtain', 'rarity', 'default_score'].forEach(field => {
      const incoming = raw[field]
      if (incoming !== undefined && incoming !== '' && String(incoming) !== String(existing[field])) {
        conflicts.push({ title, field, local: existing[field], cloud: incoming })
      }
    })
  })
  return { additions, conflicts }
}

function parseArgs(argv) {
  const args = { check: false, cloudJson: '' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') args.check = true
    if (argv[index] === '--cloud-json') args.cloudJson = argv[index + 1] || ''
  }
  return args
}

function serializeModule(snapshot) {
  return `module.exports = ${JSON.stringify(snapshot, null, 2)}\n`
}

function writeOrCheck(filePath, content, check) {
  if (check) {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
    if (current !== content) throw new Error(`生成文件已过期: ${path.relative(ROOT, filePath)}`)
    return
  }
  fs.writeFileSync(filePath, content)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceProducts = readJson(PRODUCT_SOURCE)
  const offerConfig = readJson(OFFER_SOURCE)
  const offerRows = Object.values(offerConfig.RocoDataRows || {})
  const idMap = loadIdMap()
  const products = buildProducts(sourceProducts, idMap)
  const missingCloudImages = products
    .filter(product => product.status !== 'inactive' && !product.image_file_id)
    .map(product => product.title)
  if (missingCloudImages.length) {
    throw new Error(`有效商品缺少云存储图片: ${missingCloudImages.join('、')}`)
  }
  const { offers, unmatched } = buildOffers(offerRows, products)
  const followTargets = buildFollowTargets(products)
  const checksumInput = JSON.stringify({ products, offers, followTargets })
  const version = crypto.createHash('sha256').update(checksumInput).digest('hex').slice(0, 16)
  const snapshot = {
    version,
    products,
    offers,
    follow_targets: followTargets
  }

  const aliasCounts = products.flatMap(product => product.aliases).reduce((counts, alias) => {
    const key = normalizeName(alias)
    counts[key] = Number(counts[key] || 0) + 1
    return counts
  }, {})
  const cloudProducts = args.cloudJson
    ? (() => {
      const raw = readJson(path.resolve(args.cloudJson))
      return Array.isArray(raw) ? raw : (raw.products || raw.data || [])
    })()
    : []
  const cloudComparison = compareCloudProducts(products, cloudProducts)
  const report = {
    generated_at: new Date().toISOString(),
    version,
    source_product_count: sourceProducts.length,
    catalog_product_count: products.length,
    source_offer_count: offerRows.length,
    catalog_offer_count: offers.length,
    duplicate_source_offer_names: Object.entries(offerRows.reduce((counts, row) => {
      counts[row.goods_name] = Number(counts[row.goods_name] || 0) + 1
      return counts
    }, {})).filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
    ambiguous_aliases: Object.entries(aliasCounts).filter(([, count]) => count > 1).map(([alias, count]) => ({ alias, count })),
    unmatched_offers: unmatched,
    missing_images: products.filter(product => !product.image_file_id && !product.image_url).map(product => product.title),
    missing_cloud_images: missingCloudImages,
    cloud_json: args.cloudJson || '',
    cloud_additions: cloudComparison.additions,
    cloud_conflicts: cloudComparison.conflicts
  }

  const moduleContent = serializeModule(snapshot)
  OUTPUT_PATHS.forEach(filePath => writeOrCheck(filePath, moduleContent, args.check))
  writeOrCheck(ID_MAP_PATH, `${JSON.stringify(idMap, null, 2)}\n`, args.check)
  if (!args.check) fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
