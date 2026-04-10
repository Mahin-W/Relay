import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCopiedSchedule, detectStaleAssignments, getNextWeekStart } from '../../schedule/copySchedule.js'

// ── getNextWeekStart ──────────────────────────────────────────────────────────

test('getNextWeekStart returns a Monday (day index 1)', () => {
  const result = getNextWeekStart()
  const d = new Date(result + 'T12:00:00')
  assert.equal(d.getDay(), 1, 'should be Monday')
})

test('getNextWeekStart returns a future date', () => {
  const result = getNextWeekStart()
  const today = new Date().toISOString().split('T')[0]
  assert.ok(result > today, 'should be after today')
})

// ── buildCopiedSchedule ───────────────────────────────────────────────────────

const PREV_ASSIGNMENTS = [
  { shiftId: 'shift-1', shiftName: 'Monday Lunch', dayOfWeek: 'Monday', staffId: 10, staffName: 'Alice', roleName: 'server', userId: 101, dmChatId: 1001, startTime: '11am', endTime: '3pm' },
  { shiftId: 'shift-2', shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 20, staffName: 'Bob', roleName: 'server', userId: 102, dmChatId: 1002, startTime: '6pm', endTime: '11pm' },
]
const NEW_WEEK = '2025-02-03'

test('buildCopiedSchedule: weekStart updated to newWeekStart on all assignments', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  for (const a of result) assert.equal(a.weekStart, NEW_WEEK)
})

test('buildCopiedSchedule: same staffId/shiftId pairs preserved', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  assert.equal(result[0].staffId, 10)
  assert.equal(result[0].shiftId, 'shift-1')
  assert.equal(result[1].staffId, 20)
  assert.equal(result[1].shiftId, 'shift-2')
})

test('buildCopiedSchedule: status set to "scheduled" on all', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  for (const a of result) assert.equal(a.status, 'scheduled')
})

test('buildCopiedSchedule: empty array → empty result', () => {
  assert.deepEqual(buildCopiedSchedule([], NEW_WEEK), [])
})

// ── detectStaleAssignments ────────────────────────────────────────────────────

const COPIED = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
const ACTIVE_STAFF = [{ id: 10, name: 'Alice' }, { id: 20, name: 'Bob' }]

test('detectStaleAssignments: active staff → valid', () => {
  const { valid, stale } = detectStaleAssignments(COPIED, ACTIVE_STAFF)
  assert.equal(valid.length, 2)
  assert.equal(stale.length, 0)
})

test('detectStaleAssignments: removed staff → stale', () => {
  const { valid, stale } = detectStaleAssignments(COPIED, [{ id: 10, name: 'Alice' }])
  assert.equal(valid.length, 1)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].staffId, 20)
})

test('detectStaleAssignments: all active → stale is empty', () => {
  const { stale } = detectStaleAssignments(COPIED, ACTIVE_STAFF)
  assert.deepEqual(stale, [])
})

test('detectStaleAssignments: all removed → valid is empty', () => {
  const { valid } = detectStaleAssignments(COPIED, [])
  assert.deepEqual(valid, [])
})

// ── handleCopySchedule (MockBot + mock DB) ────────────────────────────────────

const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
const { handleCopySchedule } = await import('../../schedule/copySchedule.js')

function makeMsg() {
  return makeGroupMsg({ text: '/copyschedule', from: { id: 101, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
}

function makeDb(overrides = {}) {
  let savedStatus = null
  return {
    getPreviousWeekSchedule: async () => ({ assignments: PREV_ASSIGNMENTS, weekStart: '2025-01-27', id: 42 }),
    saveGeneratedSchedule: async (gId, wk, assigns, gaps, status) => { savedStatus = status ?? 'draft'; return { id: 99 } },
    getStaffForGroup: async () => ACTIVE_STAFF,
    getSetupSession: async () => ({ manager_id: 101, dm_chat_id: 9001 }),
    _getSavedStatus: () => savedStatus,
    ...overrides,
  }
}

test('handleCopySchedule: sends draft to manager DM', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  assert.ok(bot.messagesTo(9001).length > 0, 'should DM the manager')
})

test('handleCopySchedule: DM contains schedule content', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  const dm = bot.messagesTo(9001)[0]
  assert.ok(dm.text.includes('Monday Lunch') || dm.text.includes('Alice'), 'should include schedule content')
})

test('handleCopySchedule: shows stale warning when inactive staff', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb({ getStaffForGroup: async () => [{ id: 10, name: 'Alice' }] }))
  const dm = bot.messagesTo(9001)[0]
  assert.ok(dm.text.includes('Bob') || dm.text.includes('Removed') || dm.text.includes('no longer'), 'should warn about stale staff')
})

test('handleCopySchedule: no stale warning when all staff active', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  const dm = bot.messagesTo(9001)[0]
  assert.ok(!dm.text.includes('Removed') && !dm.text.includes('no longer'), 'no stale warning needed')
})

test('handleCopySchedule: saves as draft', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const db = makeDb()
  await handleCopySchedule(bot, makeMsg(), db)
  assert.equal(db._getSavedStatus(), 'draft')
})

test('handleCopySchedule: "no schedule found" message when no previous schedule', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb({ getPreviousWeekSchedule: async () => null }))
  const groupMsg = bot.messagesTo('-100')[0]
  assert.ok(groupMsg?.text.includes('No published') || groupMsg?.text.includes('generate'), 'should explain no schedule')
})

test('handleCopySchedule: blocked for non-admins', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: '/copyschedule', from: { id: 999, first_name: 'Rando' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
  await handleCopySchedule(bot, msg, makeDb())
  const groupMsgs = bot.messagesTo('-100')
  assert.ok(groupMsgs.some(m => m.text.includes('admin') || m.text.includes('Only')), 'non-admin should get blocked message')
})

test('handleCopySchedule: silent in DMs', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: '/copyschedule', from: { id: 101 }, chat: { id: '-100', type: 'private' } })
  await handleCopySchedule(bot, msg, makeDb())
  assert.ok(!bot.lastMessage('-100'), 'should be silent in DMs')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "same as last week" → copy_schedule_request', async () => {
  const r = await parseMessage('same as last week', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "copy last weeks schedule" → copy_schedule_request', async () => {
  const r = await parseMessage("copy last week's schedule", 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "just repeat the schedule" → copy_schedule_request', async () => {
  const r = await parseMessage('just repeat the schedule from last week', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "can anyone cover my shift" → NOT copy_schedule_request', async () => {
  const r = await parseMessage('can anyone cover my shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'copy_schedule_request')
})

test('[LLM] "my schedule" → NOT copy_schedule_request', async () => {
  const r = await parseMessage('what is my schedule', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'copy_schedule_request')
})
