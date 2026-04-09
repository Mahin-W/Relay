import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  handleStaffPayQuery,
  handleStaffHistoryQuery,
  isPayQuery,
  isHistoryQuery,
} from '../../payroll/staffPayService.js'

const DM_CHAT_ID = '12345'
const GROUP_ID = '-100888'
const WEEK = '2026-04-07'

function makeDM(overrides = {}) {
  return {
    chat: { id: DM_CHAT_ID, type: 'private' },
    from: { id: 12345, first_name: 'Alice' },
    text: 'my pay',
    ...overrides,
  }
}

function makeDb(overrides = {}) {
  return {
    getStaffByDmChatId: async () => null,
    getPayrollForWeek: async () => null,
    getPayrollHistory: async () => [],
    getGroupIdForStaff: async () => null,
    ...overrides,
  }
}

const ALICE_RECORD = {
  staffId: 10,
  staffName: 'Alice',
  role: 'Server',
  shifts: [
    { shiftName: 'Morning', dayOfWeek: 'Monday', hoursWorked: 5, hourlyRate: 15, lateMinutes: 0, lateDeduction: 0, grossPay: 75 },
  ],
  totalHours: 5,
  totalLateMinutes: 0,
  totalLateDeduction: 0,
  totalGrossPay: 75,
}

await Promise.all([
  // ── isPayQuery ────────────────────────────────────────────────────────────

  test('isPayQuery: detects "my pay"', () => {
    assert.equal(isPayQuery('my pay'), true)
    assert.equal(isPayQuery('My Pay'), true)
    assert.equal(isPayQuery('my paycheck'), true)
    assert.equal(isPayQuery('what do I make this week'), true)
    assert.equal(isPayQuery('how much do I get paid'), true)
    assert.equal(isPayQuery('my earnings'), true)
    assert.equal(isPayQuery('how much am I owed'), true)
  }),

  test('isPayQuery: does not trigger on unrelated text', () => {
    assert.equal(isPayQuery('my schedule'), false)
    assert.equal(isPayQuery('yes'), false)
    assert.equal(isPayQuery('hey'), false)
    assert.equal(isPayQuery(''), false)
  }),

  test('isHistoryQuery: detects "my pay history"', () => {
    assert.equal(isHistoryQuery('my pay history'), true)
    assert.equal(isHistoryQuery('last few weeks pay'), true)
    assert.equal(isHistoryQuery('pay history'), true)
  }),

  test('isHistoryQuery: does not trigger on "my pay"', () => {
    assert.equal(isHistoryQuery('my pay'), false)
    assert.equal(isHistoryQuery(''), false)
  }),

  // ── handleStaffPayQuery ───────────────────────────────────────────────────

  test('handleStaffPayQuery: returns own pay stub', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [ALICE_RECORD],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    bot.assertSent(DM_CHAT_ID, 'Alice')
    bot.assertSent(DM_CHAT_ID, '75')
  }),

  test('handleStaffPayQuery: shows each shift separately', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [ALICE_RECORD],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    bot.assertSent(DM_CHAT_ID, 'Morning')
  }),

  test('handleStaffPayQuery: shows late deduction if applicable', async () => {
    const bot = new MockBot()
    const lateRecord = {
      ...ALICE_RECORD,
      shifts: [
        { shiftName: 'Morning', dayOfWeek: 'Monday', hoursWorked: 4, hourlyRate: 15, lateMinutes: 60, lateDeduction: 15, grossPay: 60 },
      ],
      totalLateMinutes: 60,
      totalLateDeduction: 15,
      totalGrossPay: 60,
    }
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [lateRecord],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(msg.text.includes('late') || msg.text.includes('Late') || msg.text.includes('⚠️'), 'should mention late')
  }),

  test('handleStaffPayQuery: no late line if not late', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [ALICE_RECORD],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(!msg.text.toLowerCase().includes('late deduct'), 'should not show late deduction when not late')
  }),

  test('handleStaffPayQuery: unregistered user → helpful message', async () => {
    const bot = new MockBot()
    const db = makeDb({ getStaffByDmChatId: async () => null })
    await handleStaffPayQuery(bot, makeDM(), db)
    bot.assertSent(DM_CHAT_ID, 'register')
  }),

  test('handleStaffPayQuery: no payroll yet → helpful message', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => null,
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    bot.assertSent(DM_CHAT_ID, 'schedule')
  }),

  test('handleStaffPayQuery: ONLY shows requesting staff pay (not others)', async () => {
    const bot = new MockBot()
    const bobRecord = { ...ALICE_RECORD, staffId: 99, staffName: 'Bob', totalGrossPay: 999 }
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [ALICE_RECORD, bobRecord],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(!msg.text.includes('Bob'), 'should not reveal other staff names')
    assert.ok(!msg.text.includes('999'), 'should not reveal other staff pay')
  }),

  test('handleStaffPayQuery: does not reveal other staff pay', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollForWeek: async () => [ALICE_RECORD, { ...ALICE_RECORD, staffId: 99, staffName: 'Charlie', totalGrossPay: 500 }],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffPayQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(!msg.text.includes('Charlie'))
    assert.ok(!msg.text.includes('500'))
  }),

  // ── handleStaffHistoryQuery ───────────────────────────────────────────────

  test('handleStaffHistoryQuery: shows 4 weeks of history', async () => {
    const bot = new MockBot()
    const history = [
      { week_start: '2026-03-31', total_hours: 5, total_gross_pay: 75, total_late_minutes: 0 },
      { week_start: '2026-03-24', total_hours: 8, total_gross_pay: 120, total_late_minutes: 0 },
      { week_start: '2026-03-17', total_hours: 6, total_gross_pay: 90, total_late_minutes: 0 },
      { week_start: '2026-03-10', total_hours: 4, total_gross_pay: 60, total_late_minutes: 0 },
    ]
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollHistory: async () => history,
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffHistoryQuery(bot, makeDM({ text: 'my pay history' }), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(msg.text.includes('2026-03-31'), 'should include first week')
    assert.ok(msg.text.includes('2026-03-10'), 'should include last week')
  }),

  test('handleStaffHistoryQuery: correct format with amounts', async () => {
    const bot = new MockBot()
    const history = [
      { week_start: '2026-03-31', total_hours: 5, total_gross_pay: 75, total_late_minutes: 0 },
    ]
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollHistory: async () => history,
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffHistoryQuery(bot, makeDM({ text: 'pay history' }), db)
    bot.assertSent(DM_CHAT_ID, '75')
    bot.assertSent(DM_CHAT_ID, '5')
  }),

  test('handleStaffHistoryQuery: handles weeks with no data (empty)', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ({ id: 10, name: 'Alice', groupId: GROUP_ID }),
      getPayrollHistory: async () => [],
      getGroupIdForStaff: async () => GROUP_ID,
    })
    await handleStaffHistoryQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(DM_CHAT_ID)
    assert.ok(msg, 'should send a message even with no data')
    assert.ok(typeof msg.text === 'string', 'message should be a string')
  }),

  test('handleStaffHistoryQuery: unregistered user → helpful message', async () => {
    const bot = new MockBot()
    const db = makeDb({ getStaffByDmChatId: async () => null })
    await handleStaffHistoryQuery(bot, makeDM(), db)
    bot.assertSent(DM_CHAT_ID, 'register')
  }),
])
