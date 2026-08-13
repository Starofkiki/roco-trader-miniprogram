const CACHE_STORAGE_KEY = 'product_image_file_cache_v1'
const CACHE_VERSION = 1
const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024

let cacheState = null
const pendingDownloads = {}

function getImageSource(productOrSource) {
  const source = typeof productOrSource === 'string'
    ? productOrSource
    : productOrSource && productOrSource.image_file_id
  const normalized = String(source || '').trim()
  return normalized.startsWith('cloud://') ? normalized : ''
}

function readCacheState() {
  if (cacheState) return cacheState
  let stored = null
  try {
    stored = typeof wx !== 'undefined' && wx.getStorageSync
      ? wx.getStorageSync(CACHE_STORAGE_KEY)
      : null
  } catch (error) {}
  cacheState = stored && stored.version === CACHE_VERSION && stored.entries
    ? { version: CACHE_VERSION, entries: { ...stored.entries } }
    : { version: CACHE_VERSION, entries: {} }
  return cacheState
}

function writeCacheState() {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      wx.setStorageSync(CACHE_STORAGE_KEY, readCacheState())
    }
  } catch (error) {}
}

function fileExists(filePath) {
  if (!filePath) return false
  try {
    if (typeof wx === 'undefined') return false
    const fileSystem = wx.getFileSystemManager && wx.getFileSystemManager()
    if (!fileSystem || typeof fileSystem.accessSync !== 'function') return true
    fileSystem.accessSync(filePath)
    return true
  } catch (error) {
    return false
  }
}

function removeSavedFile(filePath) {
  if (!filePath || typeof wx === 'undefined' || typeof wx.removeSavedFile !== 'function') return Promise.resolve()
  return new Promise(resolve => {
    wx.removeSavedFile({
      filePath,
      complete: resolve
    })
  })
}

function removeEntry(source, options = {}) {
  const state = readCacheState()
  const entry = state.entries[source]
  if (!entry) return Promise.resolve(false)
  delete state.entries[source]
  writeCacheState()
  if (options.removeFile === false) return Promise.resolve(true)
  return removeSavedFile(entry.path).then(() => true)
}

function getCachedProductImage(productOrSource) {
  const source = getImageSource(productOrSource)
  if (!source) return ''
  const state = readCacheState()
  const entry = state.entries[source]
  if (!entry || !entry.path) return ''
  if (!fileExists(entry.path)) {
    delete state.entries[source]
    writeCacheState()
    return ''
  }
  const now = Date.now()
  if (now - Number(entry.lastUsedAt || 0) > 60 * 1000) {
    entry.lastUsedAt = now
    writeCacheState()
  }
  return entry.path
}

function downloadCloudFile(source) {
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.downloadFile !== 'function') return Promise.resolve('')
  return new Promise(resolve => {
    wx.cloud.downloadFile({
      fileID: source,
      success: result => resolve(result && result.tempFilePath ? result.tempFilePath : ''),
      fail: () => resolve('')
    })
  })
}

function saveTempFile(tempFilePath) {
  if (!tempFilePath || typeof wx === 'undefined' || typeof wx.saveFile !== 'function') return Promise.resolve('')
  return new Promise(resolve => {
    wx.saveFile({
      tempFilePath,
      success: result => resolve(result && result.savedFilePath ? result.savedFilePath : ''),
      fail: () => resolve('')
    })
  })
}

function removeTempFile(filePath) {
  if (!filePath || typeof wx === 'undefined' || !wx.getFileSystemManager) return
  try {
    const fileSystem = wx.getFileSystemManager()
    if (fileSystem && typeof fileSystem.unlinkSync === 'function') fileSystem.unlinkSync(filePath)
  } catch (error) {}
}

function getFileSize(filePath) {
  if (!filePath || typeof wx === 'undefined' || typeof wx.getFileInfo !== 'function') return Promise.resolve(0)
  return new Promise(resolve => {
    wx.getFileInfo({
      filePath,
      success: result => resolve(Math.max(0, Number(result && result.size || 0))),
      fail: () => resolve(0)
    })
  })
}

function pruneCache(preservedSource, maxBytes = DEFAULT_MAX_CACHE_BYTES) {
  const state = readCacheState()
  const entries = Object.keys(state.entries).map(source => ({
    source,
    ...state.entries[source]
  }))
  let totalBytes = entries.reduce((total, entry) => total + Math.max(0, Number(entry.size || 0)), 0)
  const removable = entries
    .filter(entry => entry.source !== preservedSource)
    .sort((left, right) => Number(left.lastUsedAt || 0) - Number(right.lastUsedAt || 0))
  const removals = []
  while (totalBytes > maxBytes && removable.length) {
    const entry = removable.shift()
    totalBytes -= Math.max(0, Number(entry.size || 0))
    delete state.entries[entry.source]
    removals.push(removeSavedFile(entry.path))
  }
  if (removals.length) writeCacheState()
  return Promise.all(removals)
}

function ensureProductImageCached(productOrSource, options = {}) {
  const source = getImageSource(productOrSource)
  if (!source) return Promise.resolve('')
  const cachedPath = getCachedProductImage(source)
  if (cachedPath) return Promise.resolve(cachedPath)
  if (pendingDownloads[source]) return pendingDownloads[source]

  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_CACHE_BYTES)
  pendingDownloads[source] = downloadCloudFile(source)
    .then(tempFilePath => {
      if (!tempFilePath) return null
      return getFileSize(tempFilePath).then(size => {
        if (size > maxBytes) {
          removeTempFile(tempFilePath)
          return { savedFilePath: '', size: 0 }
        }
        return pruneCache('', Math.max(0, maxBytes - size))
          .then(() => saveTempFile(tempFilePath))
          .then(savedFilePath => ({ savedFilePath, size }))
      })
    })
    .then(saved => {
      if (!saved || !saved.savedFilePath) return ''
      const savedFilePath = saved.savedFilePath
      const size = saved.size
      return Promise.resolve().then(() => {
        const state = readCacheState()
        state.entries[source] = {
          path: savedFilePath,
          size,
          lastUsedAt: Date.now()
        }
        writeCacheState()
        return pruneCache(source, maxBytes)
          .then(() => savedFilePath)
      })
    })
    .finally(() => {
      delete pendingDownloads[source]
    })
  return pendingDownloads[source]
}

function invalidateProductImageCache(productOrSource) {
  const source = getImageSource(productOrSource)
  if (!source) return Promise.resolve(false)
  return removeEntry(source)
}

module.exports = {
  DEFAULT_MAX_CACHE_BYTES,
  ensureProductImageCached,
  getCachedProductImage,
  getProductImageSource: getImageSource,
  invalidateProductImageCache
}
