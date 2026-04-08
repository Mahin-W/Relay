import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage } from '../../parseMessage.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'
import { handleLateArrival } from '../../lateArrival/handleLateArrival.js'

// ── parseMessage LLM cases ─────────────────────────────────────────────────────

test('late: "running 20 min late" → running_late, minutes: 20', async () => {
  const r = await parseMessage('running 20 min late', 'Alice', 'Test Group')
  assert.equal(r.type, 'running_late')
  assert.equal(r.minutes, 20)
})

test('late: "stuck in traffic, be there by 6:30" → running_late, eta', async () => {
  const r = await parseMessage('stuck in traffic, be there by 6:30', 'Bob', 'Test Group')
  assert.equal(r.type, 'running_late')
  assert.ok(r.eta, `expected eta, got: ${JSON.stringify(r)}`)
})

test('late: "gonna be a bit late" → running_late, minutes null', async () => {
  const r = await parseMessage('gonna be a bit late', 'Sam', 'Test Group')
  assert.equal(r.type, 'running_late')
  assert.equal(r.minutes, null)
})

test('late: "running behind, maybe 15 min" → running_late, minutes 15', async () => {
  const r = await parseMessage('running behind, maybe 15 min', 'Chris', 'Test Group')
  assert.equal(r.type, 'running_late')
  assert.equal(r.minutes, 15)
})

test('late: "I was late last week" → irrelevant (past tense)', async () => {
  const r = await parseMessage('I was late last week, sorry', 'Alice', 'Test Group')
  assert.notEqual(r.type, 'running_late', `Expected not running_late, got ${r.type}`)
})

test('late: "sorry I was late yesterday" → irrelevant (past tense)', async () => {
  const r = await parseMessage('sorry I was late yesterday', 'Bob', 'Test Group')
  assert.notEqual(r.type, 'running_late')
})

test('late: "can anyone cover my shift" → coverage_request not running_late', async () => {
  const r = await parseMessage('can anyone cover my shift', 'Carol', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

test('late: "calling in sick" → coverage_request not running_late', async () => {
  const r = await parseMessage('calling in sick today', 'Dave', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

// ── Logic cases (MockBot + MockDB, no Groq) ───────────────────────────────────

function makeLatDb(overrides = {}) {
  return {
    getSetupSession: async () => ({
      dm_chat_id: '99999',
      group_id: '-100',
      group_name: 'Test Kitchen',
      manager_id: 777,
    }),
    findShiftForToday: async () => ({
      shift: { name: 'Morning', start_time: '9:00 AM' },
    }),
    ...overrides,
  }
}

test('late logic: handleLateArrival sends quiet group ack "Got it"', async () => {
  const bot = new MockBot()
  const db = makeLatDb()
  const msg = makeGroupMsg({ text: 'running 20 min late', from: { id: 12345, first_name: 'Alice' } })
  const intent = { type: 'running_late', person: 'Alice', minutes: 20, eta: null }

  await handleLateArrival(bot, msg, intent, db)

  bot.assertSent(msg.chat.id, 'Got it')
  bot.assertSent(msg.chat.id, 'Alice')
})

test('late logic: handleLateArrival DMs manager with name + original message', async () => {
  const bot = new MockBot()
  const db = makeLatDb()
  const msg = makeGroupMsg({ text: 'running 20 min late', from: { id: 12345, first_name: 'Alice' } })
  const intent = { type: 'running_late', person: 'Alice', minutes: 20, eta: null }

  await handleLateArrival(bot, msg, intent, db)

  bot.assertSent('99999', 'Alice')
  bot.assertSent('99999', 'running 20 min late')
})

test('late logic: handleLateArrival includes minutes in manager DM when present', async () => {
  const bot = new MockBot()
  const db = makeLatDb()
  const msg = makeGroupMsg({ text: 'running 30 min late', from: { id: 12345, first_name: 'Sam' } })
  const intent = { type: 'running_late', person: 'Sam', minutes: 30, eta: null }

  await handleLateArrival(bot, msg, intent, db)

  bot.assertSent('99999', '30')
})

test('late logic: handleLateArrival includes shift info when staff has shift today', async () => {
  const bot = new MockBot()
  const db = makeLatDb({
    findShiftForToday: async () => ({ shift: { name: 'Morning', start_time: '9:00 AM' } }),
  })
  const msg = makeGroupMsg({ text: 'gonna be late', from: { id: 12345, first_name: 'Alice' } })
  const intent = { type: 'running_late', person: 'Alice', minutes: null, eta: null }

  await handleLateArrival(bot, msg, intent, db)

  bot.assertSent('99999', 'Morning')
  bot.assertSent('99999', '9:00 AM')
})

test('late logic: handleLateArrival graceful when staff has no shift today', async () => {
  const bot = new MockBot()
  const db = makeLatDb({
    findShiftForToday: async () => null,
  })
  const msg = makeGroupMsg({ text: 'running late', from: { id: 12345, first_name: 'Bob' } })
  const intent = { type: 'running_late', person: 'Bob', minutes: null, eta: null }

  await handleLateArrival(bot, msg, intent, db)

  bot.assertSent('99999', 'No shift found')
})

test('late logic: handleLateArrival graceful when manager has no dm_chat_id', async () => {
  const bot = new MockBot()
  const db = makeLatDb({
    getSetupSession: async () => ({ dm_chat_id: null, group_id: '-100' }),
  })
  const msg = makeGroupMsg({ text: 'running late', from: { id: 12345, first_name: 'Carol' } })
  const intent = { type: 'running_late', person: 'Carol', minutes: null, eta: null }

  // Should not throw
  await handleLateArrival(bot, msg, intent, db)

  // Only group ack sent, no manager DM
  bot.assertSent(msg.chat.id, 'Got it')
  bot.assertSilent('99999')
})
