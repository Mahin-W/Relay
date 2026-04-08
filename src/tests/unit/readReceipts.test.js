import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  sendPersonalSchedule,
  handleReceiptConfirmation,
  getUnconfirmedStaff,
  sendReceiptReminders,
  isReceiptConfirmation,
} from '../../schedule/readReceipts.js'

const WEEK = '2025-04-14'

function makeDb(overrides = {}) {
  const receipts = []
  return {
    receipts,
    saveReceipt: async (groupId, staffId, weekStart, dmChatId) => {
      const existing = receipts.find(r => r.staff_id === staffId && r.week_start === weekStart)
      if (existing) {
        existing.status = 'sent'
      } else {
        receipts.push({ staff_id: staffId, week_start: weekStart, dm_chat_id: String(dmChatId ?? ''), status: 'sent' })
      }
      return receipts.at(-1)
    },
    updateReceiptStatus: async (staffId, weekStart, status) => {
      const r = receipts.find(r => r.staff_id === staffId && r.week_start === weekStart && r.status === 'sent')
      if (r) r.status = status
      return r ?? null
    },
    getPendingReceipt: async (chatId) =>
      receipts.find(r => r.dm_chat_id === String(chatId) && r.status === 'sent') ?? null,
    getUnconfirmedStaff: async (groupId, weekStart) =>
      receipts
        .filter(r => r.status === 'sent' && r.week_start === weekStart)
        .map(r => ({ id: r.staff_id, name: r.name ?? 'Staff', dmChatId: r.dm_chat_id })),
    ...overrides,
  }
}

await Promise.all([
  test('sendPersonalSchedule DMs staff with their shifts listed', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const staffMember = { id: 10, name: 'Alice', dmChatId: '9001' }
    const assignments = [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Morning', dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '5:00 PM' },
    ]
    await sendPersonalSchedule(bot, 'g1', staffMember, assignments, WEEK, db)
    bot.assertSent('9001', 'Your schedule for week of')
    bot.assertSent('9001', 'Monday')
    bot.assertSent('9001', 'Morning')
    bot.assertSent('9001', 'got it')
  }),

  test('sendPersonalSchedule DMs no-shifts message when none assigned', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const staffMember = { id: 20, name: 'Bob', dmChatId: '9002' }
    await sendPersonalSchedule(bot, 'g1', staffMember, [], WEEK, db)
    bot.assertSent('9002', "You're not scheduled next week")
    bot.assertSent('9002', 'time off')
  }),

  test('sendPersonalSchedule saves receipt record with status sent', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const staffMember = { id: 30, name: 'Carol', dmChatId: '9003' }
    await sendPersonalSchedule(bot, 'g1', staffMember, [], WEEK, db)
    const saved = db.receipts.find(r => r.staff_id === 30)
    assert.ok(saved, 'receipt should be saved')
    assert.equal(saved.status, 'sent')
  }),

  test('handleReceiptConfirmation updates status to confirmed', async () => {
    const bot = new MockBot()
    const db = makeDb()
    // Pre-seed a pending receipt
    db.receipts.push({ staff_id: 40, week_start: WEEK, dm_chat_id: '9004', status: 'sent' })
    const msg = { chat: { id: '9004' } }
    await handleReceiptConfirmation(bot, msg, db)
    const r = db.receipts.find(r => r.staff_id === 40)
    assert.equal(r.status, 'confirmed')
  }),

  test('handleReceiptConfirmation replies with confirmation message', async () => {
    const bot = new MockBot()
    const db = makeDb()
    db.receipts.push({ staff_id: 41, week_start: WEEK, dm_chat_id: '9005', status: 'sent' })
    const msg = { chat: { id: '9005' } }
    await handleReceiptConfirmation(bot, msg, db)
    bot.assertSent('9005', "Got it! You're confirmed")
  }),

  test('handleReceiptConfirmation ignores if no pending receipt', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const msg = { chat: { id: '9999' } }
    await handleReceiptConfirmation(bot, msg, db)
    bot.assertSilent()
  }),

  test('getUnconfirmedStaff returns only status=sent not confirmed', async () => {
    const db = makeDb()
    db.receipts.push({ staff_id: 50, week_start: WEEK, dm_chat_id: '9010', status: 'sent', name: 'Dave' })
    db.receipts.push({ staff_id: 51, week_start: WEEK, dm_chat_id: '9011', status: 'confirmed', name: 'Eve' })
    const result = await getUnconfirmedStaff('g1', WEEK, db)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 50)
  }),

  test('sendReceiptReminders sends DM to each unconfirmed staff member', async () => {
    const bot = new MockBot()
    const db = makeDb()
    db.receipts.push({ staff_id: 60, week_start: WEEK, dm_chat_id: '9020', status: 'sent', name: 'Frank' })
    db.receipts.push({ staff_id: 61, week_start: WEEK, dm_chat_id: '9021', status: 'sent', name: 'Grace' })
    await sendReceiptReminders(bot, 'g1', WEEK, db)
    bot.assertSent('9020', 'reminder')
    bot.assertSent('9021', 'reminder')
  }),

  test('sendReceiptReminders returns correct count', async () => {
    const bot = new MockBot()
    const db = makeDb()
    db.receipts.push({ staff_id: 70, week_start: WEEK, dm_chat_id: '9030', status: 'sent', name: 'Hank' })
    db.receipts.push({ staff_id: 71, week_start: WEEK, dm_chat_id: '9031', status: 'sent', name: 'Iris' })
    const count = await sendReceiptReminders(bot, 'g1', WEEK, db)
    assert.equal(count, 2)
  }),

  test('"got it" triggers confirmation check', () => {
    assert.equal(isReceiptConfirmation('got it'), true)
    assert.equal(isReceiptConfirmation('Got It'), true)
    assert.equal(isReceiptConfirmation('GOT IT'), true)
  }),

  test('"👍" triggers confirmation check', () => {
    assert.equal(isReceiptConfirmation('👍'), true)
    assert.equal(isReceiptConfirmation('confirmed'), true)
    assert.equal(isReceiptConfirmation('gotit'), true)
  }),

  test('random DM text does not trigger confirmation', () => {
    assert.equal(isReceiptConfirmation('hello'), false)
    assert.equal(isReceiptConfirmation('yes please'), false)
    assert.equal(isReceiptConfirmation(''), false)
    assert.equal(isReceiptConfirmation('can you cover my shift'), false)
  }),
])
