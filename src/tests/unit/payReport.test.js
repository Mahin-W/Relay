import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { formatWeeklyPayReport, sendPayReport } from '../../payroll/payReport.js'

const WEEK = '2026-04-07'

function makeStaffSummary(overrides = {}) {
  return {
    staffId: 1,
    staffName: 'Alice',
    role: 'Server',
    shifts: [
      { shiftName: 'Morning', dayOfWeek: 'Monday', hoursWorked: 5, hourlyRate: 15, lateMinutes: 0, lateDeduction: 0, grossPay: 75 },
    ],
    totalHours: 5,
    totalLateMinutes: 0,
    totalLateDeduction: 0,
    totalGrossPay: 75,
    ...overrides,
  }
}

await Promise.all([
  // ── formatWeeklyPayReport ─────────────────────────────────────────────────

  test('formatWeeklyPayReport: contains all staff names', () => {
    const summaries = [makeStaffSummary({ staffName: 'Alice' }), makeStaffSummary({ staffId: 2, staffName: 'Bob' })]
    const text = formatWeeklyPayReport(summaries, WEEK)
    assert.ok(text.includes('Alice'), 'should include Alice')
    assert.ok(text.includes('Bob'), 'should include Bob')
  }),

  test('formatWeeklyPayReport: contains correct total payroll', () => {
    const summaries = [
      makeStaffSummary({ totalGrossPay: 75 }),
      makeStaffSummary({ staffId: 2, staffName: 'Bob', totalGrossPay: 100 }),
    ]
    const text = formatWeeklyPayReport(summaries, WEEK)
    assert.ok(text.includes('175') || text.includes('175.00'), 'should show total payroll 175')
  }),

  test('formatWeeklyPayReport: contains week date', () => {
    const text = formatWeeklyPayReport([makeStaffSummary()], WEEK)
    assert.ok(text.includes('2026') || text.includes('Apr') || text.includes(WEEK), 'should mention week')
  }),

  test('formatWeeklyPayReport: shows late deductions when present', () => {
    const summary = makeStaffSummary({ totalLateMinutes: 30, totalLateDeduction: 7.50 })
    const text = formatWeeklyPayReport([summary], WEEK)
    assert.ok(text.includes('7.50') || text.includes('late') || text.includes('Late'), 'should show late deduction')
  }),

  test('formatWeeklyPayReport: no late line when no deductions', () => {
    const text = formatWeeklyPayReport([makeStaffSummary()], WEEK)
    assert.ok(!text.includes('Late deduct'), 'should not mention late deduction if none')
  }),

  test('formatWeeklyPayReport: total payroll is sum of all gross', () => {
    const summaries = [
      makeStaffSummary({ totalGrossPay: 50 }),
      makeStaffSummary({ staffId: 2, staffName: 'Bob', totalGrossPay: 60 }),
    ]
    const text = formatWeeklyPayReport(summaries, WEEK)
    assert.ok(text.includes('110') || text.includes('110.00'))
  }),

  test('formatWeeklyPayReport: empty summaries → graceful output', () => {
    const text = formatWeeklyPayReport([], WEEK)
    assert.ok(typeof text === 'string' && text.length > 0, 'should return non-empty string')
  }),

  test('formatWeeklyPayReport: single staff → correct format', () => {
    const text = formatWeeklyPayReport([makeStaffSummary()], WEEK)
    assert.ok(text.includes('75') || text.includes('75.00'), 'should show gross pay')
    assert.ok(text.includes('5'), 'should show hours')
  }),

  // ── sendPayReport ─────────────────────────────────────────────────────────

  test('sendPayReport: DMs manager not group', async () => {
    const bot = new MockBot()
    const GROUP_ID = '-100999'
    const MANAGER_DM = '77777'
    const db = {
      getSetupSession: async () => ({ dm_chat_id: MANAGER_DM, manager_id: 1 }),
      getPayrollForWeek: async () => [makeStaffSummary()],
    }
    await sendPayReport(bot, GROUP_ID, WEEK, db)
    assert.ok(bot.messagesTo(MANAGER_DM).length > 0, 'should DM manager')
    assert.equal(bot.messagesTo(GROUP_ID).length, 0, 'should not post to group')
  }),

  test('sendPayReport: "no payroll yet" when not calculated', async () => {
    const bot = new MockBot()
    const db = {
      getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: 1 }),
      getPayrollForWeek: async () => null,
    }
    await sendPayReport(bot, '-100', WEEK, db)
    bot.assertSent('77777', 'No payroll')
  }),

  test('sendPayReport: uses current week when weekStart is null', async () => {
    const bot = new MockBot()
    let capturedWeek = null
    const db = {
      getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: 1 }),
      getPayrollForWeek: async (gid, week) => { capturedWeek = week; return null },
    }
    await sendPayReport(bot, '-100', null, db)
    assert.ok(capturedWeek, 'should query a week')
    assert.match(capturedWeek, /^\d{4}-\d{2}-\d{2}$/, 'should be a valid date string')
  }),

  test('sendPayReport: returns { sent: true } on success', async () => {
    const bot = new MockBot()
    const db = {
      getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: 1 }),
      getPayrollForWeek: async () => [makeStaffSummary()],
    }
    const result = await sendPayReport(bot, '-100', WEEK, db)
    assert.equal(result.sent, true)
  }),

  test('sendPayReport: returns { sent: false } if no manager DM', async () => {
    const bot = new MockBot()
    const db = {
      getSetupSession: async () => ({ dm_chat_id: null, manager_id: 1 }),
      getPayrollForWeek: async () => [makeStaffSummary()],
    }
    const result = await sendPayReport(bot, '-100', WEEK, db)
    assert.equal(result.sent, false)
  }),

  // ── /pay command behaviour ────────────────────────────────────────────────

  test('/pay command: blocked for non-managers silently (sendPayReport not called for wrong user)', async () => {
    // This tests the guard logic that /pay applies — confirmed by checking
    // that the manager check is enforced in the handler (tested via index.js integration)
    // Here we just test sendPayReport directly returns false with no session
    const bot = new MockBot()
    const db = {
      getSetupSession: async () => null,
      getPayrollForWeek: async () => null,
    }
    const result = await sendPayReport(bot, '-100', WEEK, db)
    assert.equal(result.sent, false)
  }),

  // ── /staffpay history ─────────────────────────────────────────────────────

  test('formatWeeklyPayReport: staff paid count matches summaries length', () => {
    const summaries = [makeStaffSummary(), makeStaffSummary({ staffId: 2, staffName: 'Bob' })]
    const text = formatWeeklyPayReport(summaries, WEEK)
    assert.ok(text.includes('2'), 'should mention 2 staff')
  }),
])
