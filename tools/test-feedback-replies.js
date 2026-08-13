const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

function createMockDb(initialDocs) {
  const docs = new Map((initialDocs || []).map(doc => [doc._id, { ...doc }]))
  return {
    docs,
    collection() {
      let offset = 0
      let pageSize = 100
      return {
        skip(value) {
          offset = value
          return this
        },
        limit(value) {
          pageSize = value
          return this
        },
        get() {
          return Promise.resolve({ data: Array.from(docs.values()).slice(offset, offset + pageSize) })
        },
        doc(id) {
          return {
            get() {
              return docs.has(id)
                ? Promise.resolve({ data: { ...docs.get(id) } })
                : Promise.reject(new Error('not found'))
            },
            set({ data }) {
              docs.set(id, { _id: id, ...data })
              return Promise.resolve()
            }
          }
        }
      }
    }
  }
}

function createPageContext(pageConfig) {
  return {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(nextData) {
      Object.keys(nextData).forEach(key => {
        if (!key.includes('[') && !key.includes('.')) {
          this.data[key] = nextData[key]
          return
        }
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
        let target = this.data
        parts.slice(0, -1).forEach(part => {
          target = target[part]
        })
        target[parts[parts.length - 1]] = nextData[key]
      })
    }
  }
}

async function testAdminReply() {
  const { runMiniProgramAdminAction } = require(path.join(ROOT, 'cloudfunctions/rocoAdminApi/miniProgramService'))
  const db = createMockDb([{
    _id: 'feedback_1',
    openid: 'user_1',
    type: '功能建议',
    content: '希望可以查看回复',
    status: 'new',
    adminNote: '',
    createdAt: new Date('2026-08-10T08:00:00.000Z'),
    publicReply: '旧回复',
    replyUpdatedAt: new Date('2026-08-10T09:00:00.000Z'),
    replyReadAt: new Date('2026-08-10T10:00:00.000Z')
  }])

  await runMiniProgramAdminAction({
    db,
    action: 'admin.feedback.update',
    event: {
      id: 'feedback_1',
      handled: false,
      adminNote: '内部记录',
      publicReply: '新回复'
    },
    adminOpenid: 'admin_1'
  })

  const replied = db.docs.get('feedback_1')
  assert.strictEqual(replied.publicReply, '新回复')
  assert.strictEqual(replied.adminNote, '内部记录')
  assert.strictEqual(replied.status, 'handled')
  assert.strictEqual(replied.replyReadAt, null)
  assert(replied.replyUpdatedAt instanceof Date)
  const replyUpdatedAt = replied.replyUpdatedAt

  await runMiniProgramAdminAction({
    db,
    action: 'admin.feedback.update',
    event: {
      id: 'feedback_1',
      handled: true,
      adminNote: '更新内部记录',
      publicReply: ''
    },
    adminOpenid: 'admin_1'
  })

  const preserved = db.docs.get('feedback_1')
  assert.strictEqual(preserved.publicReply, '新回复')
  assert.strictEqual(preserved.replyUpdatedAt, replyUpdatedAt)
  assert.strictEqual(preserved.adminNote, '更新内部记录')
}

async function testFeedbackPage() {
  const cloudCalls = []
  global.wx = {
    cloud: {
      callFunction({ data }) {
        cloudCalls.push(data)
        if (data.action === 'feedback.mine') {
          return Promise.resolve({
            result: {
              success: true,
              data: {
                items: [{
                  id: 'feedback_1',
                  type: '功能建议',
                  content: '希望可以查看回复',
                  status: 'handled',
                  publicReply: '已经支持查看回复',
                  createdAt: '2026-08-10T08:00:00.000Z',
                  replyUpdatedAt: '2026-08-10T09:00:00.000Z',
                  unread: true
                }],
                page: 1,
                unreadCount: 1,
                hasMore: false
              }
            }
          })
        }
        if (data.action === 'feedback.markRead') {
          return Promise.resolve({ result: { success: true, data: { id: data.id, unread: false } } })
        }
        return Promise.resolve({ result: { success: false } })
      }
    },
    showToast() {}
  }

  let pageConfig = null
  global.Page = config => {
    pageConfig = config
  }
  require(path.join(ROOT, 'pages/feedback/feedback'))
  const context = createPageContext(pageConfig)
  await pageConfig.loadMyFeedback.call(context, true)
  assert.strictEqual(context.data.myFeedbackItems.length, 1)
  assert.strictEqual(context.data.myFeedbackItems[0].statusText, '已回复')
  assert.strictEqual(context.data.myFeedbackItems[0].unread, true)
  assert.strictEqual(context.data.feedbackUnreadCount, 1)

  await pageConfig.toggleFeedback.call(context, { currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(context.data.myFeedbackItems[0].expanded, true)
  assert.strictEqual(context.data.myFeedbackItems[0].unread, false)
  assert.strictEqual(context.data.feedbackUnreadCount, 0)
  assert(cloudCalls.some(call => call.action === 'feedback.markRead' && call.id === 'feedback_1'))
}

function testPublicApiBoundaries() {
  const apiSource = fs.readFileSync(path.join(ROOT, 'cloudfunctions/rocoApi/index.js'), 'utf8')
  const normalizerStart = apiSource.indexOf('function normalizeUserFeedback')
  const normalizerEnd = apiSource.indexOf('async function getMyFeedback', normalizerStart)
  const normalizerSource = apiSource.slice(normalizerStart, normalizerEnd)
  assert(normalizerStart >= 0 && normalizerEnd > normalizerStart)
  assert(!normalizerSource.includes('adminNote'))
  assert(!normalizerSource.includes('openid:'))
  assert(apiSource.includes('queryCursorPage('))
  assert(apiSource.includes("COLLECTIONS.feedback,\n    { openid },\n    'createdAt'"))
  assert(apiSource.includes('query.limit(pageSize + 1).get()'))
  assert(apiSource.includes("String(existing.openid || '') !== String(openid || '')"))
  assert(apiSource.includes("case 'feedback.mine':"))
  assert(apiSource.includes("case 'feedback.markRead':"))

  const wxml = fs.readFileSync(path.join(ROOT, 'pages/feedback/feedback.wxml'), 'utf8')
  assert(wxml.includes('我的反馈'))
  assert(wxml.includes('新回复'))
  assert(wxml.includes('bindtap="toggleFeedback"'))

  const adminWxml = fs.readFileSync(path.join(ROOT, 'pages/admin/admin.wxml'), 'utf8')
  assert(adminWxml.includes('回复用户（用户可见）'))
  assert(adminWxml.includes('内部备注（用户不可见）'))
  assert(adminWxml.includes('bindinput="onFeedbackReply"'))
}

async function main() {
  await testAdminReply()
  await testFeedbackPage()
  testPublicApiBoundaries()
  process.stdout.write('feedback reply tests passed\n')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
