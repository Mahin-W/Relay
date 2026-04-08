import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage } from '../../parseMessage.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'
import { handleTimeOffRequest, handleManagerTimeOffReply } from '../../timeOff/handleTimeOff.js'

// ── parseMessage LLM cases (run sequentially via Promise.all staggering) ──────

test('time_off: "can I have Friday off" → time_off_request', async () => {
  const r = await parseMessage('can I have Friday off', 'Alice', 'Test Group')
  assert.equal(r.type, 'time_off_request')
})

test('time_off: "need next Saturday off, doctor appointment" → time_off_request', async () => {
  const r = await parseMessage('need next Saturday off, doctor appointment', 'Bob', 'Test Group')
  assert.equal(r.type, 'time_off_request')
})

test('time_off: "taking Monday off" → time_off_request', async () => {
  const r = await parseMessage('taking Monday off', 'Sam', 'Test Group')
  assert.equal(r.type, 'time_off_request')
})

test('time_off: "I can\'t work Sunday" → time_off_request (no urgency)', async () => {
  const r = await parseMessage("I can't work Sunday", 'Chris', 'Test Group')
  assert.equal(r.type, 'time_off_request')
})

test('time_off: "can anyone cover my Friday" → coverage_request NOT time_off_request', async () => {
  const r = await parseMessage('can anyone cover my Friday shift', 'Alice', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

test('time_off: "calling in sick today" → coverage_request NOT time_off_request', async () => {
  const r = await parseMessage('calling in sick today, need someone to cover', 'Bob', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

// ── Logic cases (MockBot + MockDB, no Groq) ───────────────────────────────────

function makeTimeOffDb(overrides = {}) {
  return {
    saveTimeOffRequest: async (groupId, staffId, name, date, weekStart) => ({
      id: 1,
      group_id: groupId,
      staff_telegram_id: staffId,
      staff_name: name,
      requested_date: date,
      week_start: weekStart,
      status: 'pending',
    }),
    getSetupSession: async () => ({
      dm_chat_id: '99999',
      group_id: '-100',
      group_name: 'Test Kitchen',
      manager_id: 777,
    }),
    getManagerGroup: async () => ({
      group_id: '-100',
      group_name: 'Test Kitchen',
      manager_id: 777,
      setup_data: { managerName: 'Chef Dave' },
    }),
    getPendingTimeOffByName: async (groupId, name) => ({
      id: 1,
      group_id: groupId,
      staff_telegram_id: 12345,
      staff_name: name,
      requested_date: 'Friday',
      week_start: '2026-04-13',
      status: 'pending',
    }),
    updateTimeOffStatus: async (id, status) => ({ id, status }),
    getStaffDmChatId: async () => ({ dm_chat_id: '12345', first_name: 'Alice' }),
    saveAvailability: async () => ({ id: 1 }),
    ...overrides,
  }
}

test('time_off logic: handleTimeOffRequest sends group message + manager DM', async () => {
  const bot = new MockBot()
  const db = makeTimeOffDb()
  const msg = makeGroupMsg({ text: 'can I have Friday off', from: { id: 12345, first_name: 'Alice' } })
  const intent = { type: 'time_off_request', person: 'Alice', date: 'Friday', shift: null }

  await handleTimeOffRequest(bot, msg, intent, db)

  // Group message sent
  bot.assertSent(msg.chat.id, 'Alice')
  bot.assertSent(msg.chat.id, 'Friday')

  // Manager DM sent
  bot.assertSent('99999', 'Alice')
  bot.assertSent('99999', 'Friday')
  bot.assertSent('99999', 'approve Alice')
})

test('time_off logic: handleTimeOffRequest saves record with status pending', async () => {
  const bot = new MockBot()
  let savedRecord = null
  const db = makeTimeOffDb({
    saveTimeOffRequest: async (groupId, staffId, name, date, weekStart) => {
      savedRecord = { groupId, staffId, name, date, weekStart, status: 'pending' }
      return { id: 1, ...savedRecord }
    },
  })
  const msg = makeGroupMsg({ text: 'taking Monday off', from: { id: 12345, first_name: 'Sam' } })
  const intent = { type: 'time_off_request', person: 'Sam', date: 'Monday', shift: null }

  await handleTimeOffRequest(bot, msg, intent, db)

  assert.ok(savedRecord !== null, 'record was not saved')
  assert.equal(savedRecord.status, 'pending')
  assert.equal(savedRecord.name, 'Sam')
  assert.equal(savedRecord.date, 'Monday')
})

test('time_off logic: handleManagerTimeOffReply approve → DM staff + DB updated', async () => {
  const bot = new MockBot()
  let updatedStatus = null
  const db = makeTimeOffDb({
    updateTimeOffStatus: async (id, status) => {
      updatedStatus = status
      return { id, status }
    },
  })
  const msg = makeGroupMsg({ text: 'approve Alice', from: { id: 777, first_name: 'Dave' }, chat: { id: '99999', type: 'private' } })

  const result = await handleManagerTimeOffReply(bot, msg, db)

  assert.equal(result, true)
  assert.equal(updatedStatus, 'approved')
  bot.assertSent('12345', '✅')
  bot.assertSent('12345', 'Friday')
})

test('time_off logic: handleManagerTimeOffReply deny → DM staff + DB updated', async () => {
  const bot = new MockBot()
  let updatedStatus = null
  const db = makeTimeOffDb({
    updateTimeOffStatus: async (id, status) => {
      updatedStatus = status
      return { id, status }
    },
  })
  const msg = makeGroupMsg({ text: 'deny Alice', from: { id: 777, first_name: 'Dave' }, chat: { id: '99999', type: 'private' } })

  const result = await handleManagerTimeOffReply(bot, msg, db)

  assert.equal(result, true)
  assert.equal(updatedStatus, 'denied')
  bot.assertSent('12345', '❌')
})

test('time_off logic: handleManagerTimeOffReply approve → availability record created', async () => {
  const bot = new MockBot()
  let availabilitySaved = false
  const db = makeTimeOffDb({
    saveAvailability: async (userId, groupId, weekStart, shiftIds, availAll, unavail, raw) => {
      availabilitySaved = true
      assert.equal(unavail, true)
      assert.equal(userId, 12345)
      return { id: 1 }
    },
  })
  const msg = makeGroupMsg({ text: 'approve Alice', from: { id: 777 }, chat: { id: '99999', type: 'private' } })

  await handleManagerTimeOffReply(bot, msg, db)

  assert.equal(availabilitySaved, true, 'availability record was not created')
})
