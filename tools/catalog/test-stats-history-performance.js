const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
let pageConfig = null
global.Page = config => {
  pageConfig = config
}
global.wx = {
  getStorageSync() {
    return null
  },
  setStorageSync() {}
}

require(path.join(ROOT, 'pages/stats/stats'))

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const records = []
const latestDate = new Date(2026, 7, 5)
for (let dayOffset = 0; dayOffset < 180; dayOffset += 1) {
  const date = new Date(latestDate)
  date.setDate(date.getDate() - dayOffset)
  const dateText = formatDate(date)
  for (let round = 1; round <= 4; round += 1) {
    records.push({
      roundKey: `${dateText}_round_${round}`,
      date: dateText,
      round,
      items: [
        { name: '普通粉尘' },
        { name: '棱镜球' },
        { name: '绝缘球' }
      ],
      voteSummary: {
        total: 3,
        topChoice: { key: 'great', label: '相当好', percent: 66.7 },
        options: [{ key: 'great', count: 2, percent: 66.7 }]
      }
    })
  }
}

const payloadSizes = []
const context = {
  data: {
    selectedDate: '',
    calendarMonthValue: ''
  },
  historyViewCache: null,
  setData(nextData) {
    payloadSizes.push(Buffer.byteLength(JSON.stringify(nextData), 'utf8'))
    this.data = { ...this.data, ...nextData }
  }
}

pageConfig.applyHistoryRecords.call(context, records, { selectLatest: true })
assert.strictEqual(context.data.hasHistoryData, true)
assert.strictEqual(context.data.selectedDate, '2026-08-05')
assert.strictEqual(context.historyViewCache.records.length, 720)
assert.strictEqual(context.data.historyDays, undefined)
assert.strictEqual(context.data.allHistoryRecords, undefined)
assert(payloadSizes[0] < 100 * 1024, `history setData payload too large: ${payloadSizes[0]} bytes`)
assert(context.data.calendarWeeks.length >= 5 && context.data.calendarWeeks.length <= 6)
assert.strictEqual(context.data.selectedDay.rounds.length, 4)
assert.strictEqual(context.data.selectedDay.rareItems.length, 1)
assert.strictEqual(context.data.selectedDay.hotItems.length, 1)

pageConfig.selectCalendarDate.call(context, {
  currentTarget: { dataset: { date: '2026-08-04' } }
})
assert.strictEqual(context.data.selectedDate, '2026-08-04')
assert(payloadSizes[payloadSizes.length - 1] < 100 * 1024)

const wxml = fs.readFileSync(path.join(ROOT, 'pages/stats/stats.wxml'), 'utf8')
assert(wxml.includes('!hasHistoryData'))
assert(!wxml.includes('historyDays'))

process.stdout.write(`stats history performance tests passed: max payload ${Math.max(...payloadSizes)} bytes\n`)
