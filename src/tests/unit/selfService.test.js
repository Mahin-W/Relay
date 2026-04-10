import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { handleScheduleQuery, handleHoursQuery, isScheduleQuery } from '../../schedule/selfService.js'

const USER_ID = 42
const GROUP_ID = '-100888777'
const WEEK = '2026-04-14' // Monday

function makeDM(overrides = {}) {
  return {
    chat: { id: String(USER_ID), type: 'private' },
    from: { id: USER_ID, first_name: 'Alice' },
    text: 'my schedule',
    ...overrides,
  }
}

function makeDb(overrides = {}) {
  return {
    getStaffByDmChatId: async () => null,
    getPublishedSchedule: async () => null,
    ...overrides,
  }
}

const ALICE_STAFF = { userId: USER_ID, firstName: 'Alice', dmChatId: String(USER_ID), groupId: GROUP_ID }

const SAMPLE_ASSIGNMENTS = [
  {
    staffId: 10, staffName: 'Alice', userId: USER_ID,
    shiftId: 'sh1', shiftName: 'Morning', dayOfWeek: 'Monday',
    startTime: '9:00 AM', endTime: '5:00 PM',
  },
  {
    staffId: 10, staffName: 'Alice', userId: USER_ID,
    shiftId: 'sh2', shiftName: 'Lunch', dayOfWeek: 'Wednesday',
    startTime: '11:00 AM', endTime: '3:00 PM',
  },
  {
    staffId: 99, staffName: 'Bob', userId: 99,
    shiftId: 'sh3', shiftName: 'Evening', dayOfWeek: 'Monday',
    startTime: '5:00 PM', endTime: '10:00 PM',
  },
]

await Promise.all([
  test('sends shift list when staff has shifts this week', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: SAMPLE_ASSIGNMENTS }),
    })
    await handleScheduleQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), 'Your shifts this week')
    bot.assertSent(String(USER_ID), 'Monday')
    bot.assertSent(String(USER_ID), 'Morning')
  }),

  test('includes day and shift name and times in schedule message', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: SAMPLE_ASSIGNMENTS }),
    })
    await handleScheduleQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(String(USER_ID))
    assert.ok(msg.text.includes('9:00 AM') || msg.text.includes('9:00'), 'should include start time')
    assert.ok(msg.text.includes('Wednesday') || msg.text.includes('Lunch'), 'should include second shift')
  }),

  test('only shows shifts for this staff member not others', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: SAMPLE_ASSIGNMENTS }),
    })
    await handleScheduleQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(String(USER_ID))
    assert.ok(!msg.text.includes('Bob'), 'should not show Bob\'s shifts')
    assert.ok(!msg.text.includes('Evening'), 'should not show Evening shift (Bob\'s)')
  }),

  test('handles staff with no shifts this week', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({
        week_start: WEEK,
        assignments: [
          { staffId: 99, staffName: 'Bob', userId: 99, shiftId: 'sh3', shiftName: 'Evening', dayOfWeek: 'Monday', startTime: '5:00 PM', endTime: '10:00 PM' },
        ],
      }),
    })
    await handleScheduleQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), "not scheduled")
    bot.assertSent(String(USER_ID), 'manager')
  }),

  test('handles unregistered user gracefully', async () => {
    const bot = new MockBot()
    const db = makeDb({ getStaffByDmChatId: async () => null })
    await handleScheduleQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), 'not registered')
    bot.assertSent(String(USER_ID), '/register')
  }),

  test('handles no published schedule', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => null,
    })
    await handleScheduleQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), 'schedule')
  }),

  test('includes week date in response', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: SAMPLE_ASSIGNMENTS }),
    })
    await handleScheduleQuery(bot, makeDM(), db)
    const msg = bot.lastMessage(String(USER_ID))
    // Should mention the week somehow (date or "week of")
    assert.ok(
      msg.text.includes('week') || msg.text.includes('Apr') || msg.text.includes(WEEK),
      'should mention the week'
    )
  }),

  test('handleHoursQuery returns total shift count and hours', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: SAMPLE_ASSIGNMENTS }),
    })
    await handleHoursQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), '2') // 2 shifts
    bot.assertSent(String(USER_ID), 'hours')
  }),

  test('handleHoursQuery handles zero shifts', async () => {
    const bot = new MockBot()
    const db = makeDb({
      getStaffByDmChatId: async () => ALICE_STAFF,
      getPublishedSchedule: async () => ({ week_start: WEEK, assignments: [] }),
    })
    await handleHoursQuery(bot, makeDM(), db)
    bot.assertSent(String(USER_ID), '0')
  }),

  test('isScheduleQuery detects "my schedule"', () => {
    assert.equal(isScheduleQuery('my schedule'), true)
    assert.equal(isScheduleQuery('My Schedule'), true)
    assert.equal(isScheduleQuery('what are my shifts'), true)
    assert.equal(isScheduleQuery('when do I work'), true)
    assert.equal(isScheduleQuery('my shifts'), true)
    assert.equal(isScheduleQuery('am I working this week'), true)
    assert.equal(isScheduleQuery('what days am I working'), true)
    assert.equal(isScheduleQuery('schedule'), true)
    assert.equal(isScheduleQuery('what shift am I on'), true)
  }),

  test('isScheduleQuery does not trigger on unrelated text', () => {
    assert.equal(isScheduleQuery('yes'), false)
    assert.equal(isScheduleQuery('can anyone cover my friday'), false)
    assert.equal(isScheduleQuery('hey'), false)
    assert.equal(isScheduleQuery(''), false)
    assert.equal(isScheduleQuery('how many hours'), false)
  }),

  test('DM from unregistered user gets registration message', async () => {
    const bot = new MockBot()
    const db = makeDb({ getStaffByDmChatId: async () => null })
    const msg = makeDM({ chat: { id: '77777', type: 'private' }, from: { id: 77777, first_name: 'Stranger' } })
    await handleScheduleQuery(bot, msg, db)
    bot.assertSent('77777', 'not registered')
  }),
])
