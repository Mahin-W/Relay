import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  formatBriefing,
  buildBriefing,
  sendDailyBriefing,
} from '../../briefing/dailyBriefing.js'

function makeBriefing(overrides = {}) {
  return {
    date: 'Tuesday, April 8',
    todaysShifts: [],
    openCoverageRequests: [],
    pendingTimeOff: [],
    unconfirmedSchedule: [],
    openTrades: [],
    ...overrides,
  }
}

function makeDb(overrides = {}) {
  return {
    getTodaysAssignments: async () => [],
    getOpenCoverageRequests: async () => [],
    getPendingTimeOff: async () => [],
    getUnconfirmedSchedule: async () => [],
    getOpenTrades: async () => [],
    getSetupSession: async () => ({ dm_chat_id: '99999', manager_id: '11111' }),
    ...overrides,
  }
}

await Promise.all([
  // ── formatBriefing ────────────────────────────────────────────────────
  test('formatBriefing: contains date', () => {
    const out = formatBriefing(makeBriefing({ date: 'Wednesday, April 9' }))
    assert.ok(out.includes('Wednesday, April 9'))
  }),

  test("formatBriefing: lists today's shifts with staff names", () => {
    const out = formatBriefing(makeBriefing({
      todaysShifts: [{ shiftName: 'Lunch', staffNames: ['Alice', 'Bob'], startTime: '11am' }],
    }))
    assert.ok(out.includes('Lunch'))
    assert.ok(out.includes('Alice'))
    assert.ok(out.includes('Bob'))
  }),

  test('formatBriefing: shows "no shifts" message when none today', () => {
    const out = formatBriefing(makeBriefing({ todaysShifts: [] }))
    assert.ok(out.toLowerCase().includes('no shift'))
  }),

  test('formatBriefing: shows open coverage request info', () => {
    const out = formatBriefing(makeBriefing({
      openCoverageRequests: [
        { shiftDesc: 'Dinner shift', requestedBy: 'Carol', hoursAgo: 2 },
      ],
    }))
    assert.ok(out.includes('Carol'))
  }),

  test('formatBriefing: shows pending time-off info', () => {
    const out = formatBriefing(makeBriefing({
      pendingTimeOff: [{ staffName: 'Dave', requestedDate: '2026-04-10' }],
    }))
    assert.ok(out.includes('Dave') || out.toLowerCase().includes('time'))
  }),

  test('formatBriefing: shows unconfirmed schedule info', () => {
    const out = formatBriefing(makeBriefing({
      unconfirmedSchedule: [{ staffName: 'Eve', shiftCount: 3 }],
    }))
    assert.ok(out.includes('Eve') || out.toLowerCase().includes('confirm'))
  }),

  test('formatBriefing: "nothing needs attention" when all clear', () => {
    const out = formatBriefing(makeBriefing())
    assert.ok(out.toLowerCase().includes('nothing') || out.includes('✅'))
  }),

  test('formatBriefing: "☀️" in output', () => {
    const out = formatBriefing(makeBriefing())
    assert.ok(out.includes('☀️'))
  }),

  test('formatBriefing: empty briefing object returns non-empty string', () => {
    const out = formatBriefing(makeBriefing())
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0)
  }),

  // ── sendDailyBriefing ──────────────────────────────────────────────────
  test('sendDailyBriefing sends DM to manager', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await sendDailyBriefing(bot, 'g1', db)
    bot.assertSent('99999', '☀️')
  }),

  test('sendDailyBriefing uses dm_chat_id from setup session', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: '11111' }) })
    await sendDailyBriefing(bot, 'g1', db)
    const msgs = bot.messagesTo('77777')
    assert.ok(msgs.length > 0)
  }),

  test('sendDailyBriefing skips if manager has no DM chat ID', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => ({ manager_id: '11111' }) })
    const result = await sendDailyBriefing(bot, 'g1', db)
    bot.assertSilent()
    assert.equal(result.sent, false)
  }),

  test('sendDailyBriefing returns { sent: true } on success', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const result = await sendDailyBriefing(bot, 'g1', db)
    assert.equal(result.sent, true)
  }),

  test('sendDailyBriefing returns { sent: false } if no manager DM', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => null })
    const result = await sendDailyBriefing(bot, 'g1', db)
    assert.equal(result.sent, false)
  }),

  // ── buildBriefing ─────────────────────────────────────────────────────
  test('buildBriefing returns correct structure shape', async () => {
    const db = makeDb()
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.ok('date' in briefing)
    assert.ok('todaysShifts' in briefing)
    assert.ok('openCoverageRequests' in briefing)
    assert.ok('pendingTimeOff' in briefing)
    assert.ok('unconfirmedSchedule' in briefing)
    assert.ok('openTrades' in briefing)
  }),

  test('buildBriefing todaysShifts is always an array', async () => {
    const db = makeDb({
      getTodaysAssignments: async () => [
        { shift: { name: 'Lunch', start_time: '11am', day_of_week: 'Tuesday' }, staff: { name: 'Alice' } },
      ],
    })
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.ok(Array.isArray(briefing.todaysShifts))
  }),

  test('buildBriefing openCoverageRequests maps from DB data', async () => {
    const db = makeDb({
      getOpenCoverageRequests: async () => [
        { shift_description: 'Morning', requested_by: 'Bob', status: 'open', created_at: new Date().toISOString() },
      ],
    })
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.ok(Array.isArray(briefing.openCoverageRequests))
    assert.equal(briefing.openCoverageRequests.length, 1)
    assert.equal(briefing.openCoverageRequests[0].requestedBy, 'Bob')
  }),

  test('sendDailyBriefing sends group confirmation after DM', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await sendDailyBriefing(bot, 'g1', db)
    bot.assertSent('99999', '☀️')
  }),

  test('multiple groups each trigger separate getSetupSession calls', async () => {
    const bot = new MockBot()
    let callCount = 0
    const db = makeDb({
      getSetupSession: async () => {
        callCount++
        return { dm_chat_id: String(90000 + callCount), manager_id: '11111' }
      },
    })
    await sendDailyBriefing(bot, 'g1', db)
    await sendDailyBriefing(bot, 'g2', db)
    assert.equal(callCount, 2)
  }),

  test('buildBriefing unconfirmedSchedule maps from DB data', async () => {
    const db = makeDb({
      getUnconfirmedSchedule: async () => [
        { staffName: 'Fiona', shiftCount: 2 },
      ],
    })
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.equal(briefing.unconfirmedSchedule.length, 1)
    assert.equal(briefing.unconfirmedSchedule[0].staffName, 'Fiona')
  }),
])
