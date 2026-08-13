const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const cachePath = path.join(ROOT, 'utils/product-image-cache.js')
const storage = {}
const existingFiles = new Set()
const removedFiles = []
let downloadCount = 0
let saveCount = 0

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = JSON.parse(JSON.stringify(value))
  },
  getFileSystemManager() {
    return {
      accessSync(filePath) {
        if (!existingFiles.has(filePath)) throw new Error('missing')
      }
    }
  },
  cloud: {
    downloadFile({ success }) {
      downloadCount += 1
      const tempFilePath = `temp-${downloadCount}`
      existingFiles.add(tempFilePath)
      success({ tempFilePath })
    }
  },
  getFileInfo({ filePath, success }) {
    success({ size: filePath.includes('large') ? 6 * 1024 * 1024 : 3 * 1024 * 1024 })
  },
  saveFile({ tempFilePath, success }) {
    saveCount += 1
    const savedFilePath = `saved-${saveCount}`
    existingFiles.delete(tempFilePath)
    existingFiles.add(savedFilePath)
    success({ savedFilePath })
  },
  removeSavedFile({ filePath, complete }) {
    existingFiles.delete(filePath)
    removedFiles.push(filePath)
    complete()
  }
}

const imageCache = require(cachePath)

async function run() {
  const firstSource = 'cloud://env/first.png'
  const concurrent = await Promise.all([
    imageCache.ensureProductImageCached(firstSource),
    imageCache.ensureProductImageCached(firstSource)
  ])
  assert.strictEqual(downloadCount, 1)
  assert.strictEqual(concurrent[0], concurrent[1])
  assert.strictEqual(imageCache.getCachedProductImage(firstSource), concurrent[0])

  const secondPath = await imageCache.ensureProductImageCached('cloud://env/second.png')
  assert(secondPath)
  assert.strictEqual(downloadCount, 2)
  assert(existingFiles.has(concurrent[0]))

  await imageCache.ensureProductImageCached('cloud://env/third.png')
  assert.strictEqual(downloadCount, 3)
  assert(removedFiles.includes(concurrent[0]))
  assert.strictEqual(imageCache.getCachedProductImage(firstSource), '')

  existingFiles.delete(secondPath)
  assert.strictEqual(imageCache.getCachedProductImage('cloud://env/second.png'), '')
  await imageCache.ensureProductImageCached('cloud://env/second.png')
  assert.strictEqual(downloadCount, 4)

  assert.strictEqual(await imageCache.ensureProductImageCached('https://example.com/image.png'), '')
  process.stdout.write('product image cache tests passed\n')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
