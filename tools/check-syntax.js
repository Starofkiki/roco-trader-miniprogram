const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const INCLUDED_DIRS = ['cloudfunctions', 'custom-tab-bar', 'pages', 'tools', 'utils']
const EXCLUDED_DIRS = new Set(['cache', 'node_modules', '.npm-cache'])

function collectJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return []

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return EXCLUDED_DIRS.has(entry.name) ? [] : collectJavaScriptFiles(entryPath)
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : []
  })
}

const files = [path.join(ROOT, 'app.js')]
  .concat(INCLUDED_DIRS.flatMap(directory => collectJavaScriptFiles(path.join(ROOT, directory))))

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `语法检查失败：${file}\n`)
    process.exit(result.status || 1)
  }
}

console.log(`JavaScript 语法检查通过：${files.length} 个文件。`)
