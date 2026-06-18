import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  isShiftStartingSoon,
  formatTimeUntilShift,
  checkUpcomingShifts,
} from '../../noshow/noShowWarning.js'

// Helper: build a time string X minutes from now.
// Rounds `now` to the start of the current minute so there are no sub-minute
// precision gaps between the returned string and the `now` used in assertions.
function timeInMinutes(offsetMinutes, now = new Date()) {
  const base = new Date(now)
  base.setSeconds(0, 0) // eliminate sub-minute drift
  const target = new Date(base.getTime() + offsetMinutes * 60 * 1000)
  return `${target.getHours()}:${String(target.getMinutes()).padStart(2, '0')}`
}

// Round `now` to the minute boundary for use in pure-function tests.
function minuteNow() {
  const d = new Date()
  d.setSeconds(0, 0)
  return d
}

function makeDb(overrides = {}) {
  const warned = new Set()
  return {
    getConfiguredGroups: async () => ['g1'],
    getUpcomingShifts: async () => [],
    wasWarned: async (id) => warned.has(id),
    markWarned: async (id) => { warned.add(id) },
    getSetupSession: async () => ({ dm_chat_id: '99999' }),
    ...overrides,
  }
}

await Promise.all([
  // ── pure: isShiftStartingSoon ──────────────────────────────────────────
  test('isShiftStartingSoon: shift in 25min is within window', () => {
    const now = minuteNow()
    assert.equal(isShiftStartingSoon(timeInMinutes(25, now), 30, now), true)
  }),

  test('isShiftStartingSoon: shift in 35min is within window', () => {
    const now = minuteNow()
    assert.equal(isShiftStartingSoon(timeInMinutes(35, now), 30, now), true)
  }),

  test('isShiftStartingSoon: shift in 60min is outside window', () => {
    const now = minuteNow()
    assert.equal(isShiftStartingSoon(timeInMinutes(60, now), 30, now), false)
  }),

  test('isShiftStartingSoon: shift in 5min is outside window (past warning)', () => {
    const now = minuteNow()
    assert.equal(isShiftStartingSoon(timeInMinutes(5, now), 30, now), false)
  }),

  test('isShiftStartingSoon: handles "6am" format', () => {
    const result = isShiftStartingSoon('6am', 30, minuteNow())
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "06:00" format', () => {
    const result = isShiftStartingSoon('06:00', 30, minuteNow())
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "6:00am" format', () => {
    const result = isShiftStartingSoon('6:00am', 30, minuteNow())
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "18:00" format', () => {
    const result = isShiftStartingSoon('18:00', 30, minuteNow())
    assert.equal(typeof result, 'boolean')
  }),

  // ── pure: formatTimeUntilShift ────────────────────────────────────────
  test('formatTimeUntilShift: 30min → "~30 minutes"', () => {
    const now = minuteNow()
    assert.equal(formatTimeUntilShift(timeInMinutes(30, now), now), '~30 minutes')
  }),

  test('formatTimeUntilShift: 45min → "~45 minutes"', () => {
    const now = minuteNow()
    assert.equal(formatTimeUntilShift(timeInMinutes(45, now), now), '~45 minutes')
  }),

  // ── checkUpcomingShifts ────────────────────────────────────────────────
  test('checkUpcomingShifts sends manager DM for upcoming shift', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 1, staff_name: 'Alice', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    const result = await checkUpcomingShifts(bot, db, now)
    bot.assertSent('99999', 'Alice')
    assert.equal(result.warned, 1)
  }),

  test('checkUpcomingShifts DM contains staff name', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 2, staff_name: 'Bob', shift_name: 'Dinner',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db, now)
    bot.assertSent('99999', 'Bob')
  }),

  test('checkUpcomingShifts DM contains shift name', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 3, staff_name: 'Carol', shift_name: 'MorningShift',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db, now)
    bot.assertSent('99999', 'MorningShift')
  }),

  test('checkUpcomingShifts DM contains start time', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const startTime = timeInMinutes(30, now)
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 4, staff_name: 'Dave', shift_name: 'Lunch',
        start_time: startTime, group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db, now)
    bot.assertSent('99999', startTime)
  }),

  test('checkUpcomingShifts marks assignment as warned', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const warned = []
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 5, staff_name: 'Eve', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      markWarned: async (id) => { warned.push(id) },
    })
    await checkUpcomingShifts(bot, db, now)
    assert.deepEqual(warned, [5])
  }),

  test('checkUpcomingShifts skips already warned assignments', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 6, staff_name: 'Frank', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      wasWarned: async () => true,
    })
    const result = await checkUpcomingShifts(bot, db, now)
    bot.assertSilent()
    assert.equal(result.skipped, 1)
  }),

  test('checkUpcomingShifts skips groups with no manager DM', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 7, staff_name: 'Grace', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      getSetupSession: async () => null,
    })
    const result = await checkUpcomingShifts(bot, db, now)
    bot.assertSilent()
    assert.equal(result.skipped, 1)
  }),

  test('checkUpcomingShifts returns correct { checked, warned }', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    const db = makeDb({
      getUpcomingShifts: async () => [
        { id: 8, staff_name: 'Hank', shift_name: 'Lunch', start_time: timeInMinutes(30, now), group_id: 'g1' },
        { id: 9, staff_name: 'Iris', shift_name: 'Dinner', start_time: timeInMinutes(31, now), group_id: 'g1' },
      ],
    })
    const result = await checkUpcomingShifts(bot, db, now)
    assert.equal(result.warned, 2)
    assert.equal(result.checked, 2)
  }),

  test('checkUpcomingShifts handles empty upcoming shifts', async () => {
    const bot = new MockBot()
    const db = makeDb({ getUpcomingShifts: async () => [] })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.checked, 0)
    assert.equal(result.warned, 0)
  }),

  test('checkUpcomingShifts handles zero configured groups', async () => {
    const bot = new MockBot()
    const db = makeDb({ getConfiguredGroups: async () => [] })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.warned, 0)
  }),

  // ── P1-9: per-group noshow_window_min ─────────────────────────────────
  test('checkUpcomingShifts uses noshow_window_min from setup_data when set', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    // Shift in 50 min — well inside a 55-min group window (50±5 range)
    // but outside the default 30-min window (30±5 range)
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 10, staff_name: 'Nia', shift_name: 'Brunch',
        start_time: timeInMinutes(50, now), group_id: 'g1',
      }],
      getSetupSession: async () => ({ dm_chat_id: '99999', setup_data: { noshow_window_min: 55 } }),
    })
    const result = await checkUpcomingShifts(bot, db, now)
    assert.equal(result.warned, 1, 'Should warn when shift is within the group-configured 55-min window')
  }),

  test('checkUpcomingShifts defaults to 30-min window when noshow_window_min not set', async () => {
    const bot = new MockBot()
    const now = minuteNow()
    // Shift in 50 min — outside default 30-min window (25-35 range)
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 11, staff_name: 'Omar', shift_name: 'Lunch',
        start_time: timeInMinutes(50, now), group_id: 'g1',
      }],
      getSetupSession: async () => ({ dm_chat_id: '99999', setup_data: {} }),
    })
    const result = await checkUpcomingShifts(bot, db, now)
    assert.equal(result.warned, 0, 'Should NOT warn when shift is outside the default 30-min window')
  }),
])
