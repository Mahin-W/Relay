import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  getMissedClockOuts,
  sendMissedClockOutAlert,
  handleMissedClockOutCheck,
} from '../../timeclock/missedClockOut.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockDb(entries) {
  return {
    getMissedClockOuts: async () => entries,
  }
}

function makeEntry(overrides = {}) {
  return {
    staffId: 1,
    staffName: 'Marcus',
    dmChatId: 999,
    shiftName: 'Friday Dinner',
    shiftEndTime: '22:00',
    clockInTime: new Date(Date.now() - 7200000), // 2h ago
    clockEntryId: 42,
    ...overrides,
  }
}

// ── getMissedClockOuts ────────────────────────────────────────────────────────

test('getMissedClockOuts: returns entry when shift ended 60min ago and not alerted', async () => {
  const entry = makeEntry()
  const db = makeMockDb([entry])
  const result = await getMissedClockOuts('group-1', new Date(), db)
  assert.equal(result.length, 1)
  assert.equal(result[0].staffName, 'Marcus')
})

test('getMissedClockOuts: returns empty array when no entries', async () => {
  const db = makeMockDb([])
  const result = await getMissedClockOuts('group-1', new Date(), db)
  assert.deepEqual(result, [])
})

test('getMissedClockOuts: passes groupId to db method', async () => {
  let capturedGroupId = null
  const db = {
    getMissedClockOuts: async (gId) => {
      capturedGroupId = gId
      return []
    },
  }
  await getMissedClockOuts('group-XYZ', new Date(), db)
  assert.equal(capturedGroupId, 'group-XYZ')
})

test('getMissedClockOuts: returns multiple entries', async () => {
  const entries = [
    makeEntry({ staffId: 1, staffName: 'Marcus', clockEntryId: 42 }),
    makeEntry({ staffId: 2, staffName: 'Jade', dmChatId: 888, clockEntryId: 43 }),
  ]
  const db = makeMockDb(entries)
  const result = await getMissedClockOuts('group-1', new Date(), db)
  assert.equal(result.length, 2)
})

test('getMissedClockOuts: does not crash on empty entries', async () => {
  const db = makeMockDb([])
  await assert.doesNotReject(() => getMissedClockOuts('group-1', new Date(), db))
})

// ── sendMissedClockOutAlert ───────────────────────────────────────────────────

test('sendMissedClockOutAlert: sends DM to entry.dmChatId', async () => {
  const bot = new MockBot()
  const entry = makeEntry()
  const alertCalls = []
  const db = { markAlerted: async (id) => { alertCalls.push(id) } }

  await sendMissedClockOutAlert(bot, entry, db)

  const msgs = bot.messagesTo(999)
  assert.ok(msgs.length > 0, 'Expected a message to dmChatId 999')
})

test('sendMissedClockOutAlert: message contains shift name', async () => {
  const bot = new MockBot()
  const entry = makeEntry({ shiftName: 'Friday Dinner' })
  const db = { markAlerted: async () => {} }

  await sendMissedClockOutAlert(bot, entry, db)

  const msg = bot.lastMessage(999)
  assert.ok(msg.text.includes('Friday Dinner'), `Expected "Friday Dinner" in: ${msg.text}`)
})

test('sendMissedClockOutAlert: message contains "clock out"', async () => {
  const bot = new MockBot()
  const entry = makeEntry()
  const db = { markAlerted: async () => {} }

  await sendMissedClockOutAlert(bot, entry, db)

  const msg = bot.lastMessage(999)
  assert.ok(
    msg.text.toLowerCase().includes('clock out'),
    `Expected "clock out" in: ${msg.text}`
  )
})

test('sendMissedClockOutAlert: message contains "still working"', async () => {
  const bot = new MockBot()
  const entry = makeEntry()
  const db = { markAlerted: async () => {} }

  await sendMissedClockOutAlert(bot, entry, db)

  const msg = bot.lastMessage(999)
  assert.ok(
    msg.text.toLowerCase().includes('still working'),
    `Expected "still working" in: ${msg.text}`
  )
})

test('sendMissedClockOutAlert: calls db.markAlerted with clockEntryId', async () => {
  const bot = new MockBot()
  const entry = makeEntry({ clockEntryId: 42 })
  const alertCalls = []
  const db = { markAlerted: async (id) => { alertCalls.push(id) } }

  await sendMissedClockOutAlert(bot, entry, db)

  assert.ok(alertCalls.includes(42), `Expected markAlerted(42), got: ${JSON.stringify(alertCalls)}`)
})

test('sendMissedClockOutAlert: does not throw on missing dmChatId', async () => {
  const bot = new MockBot()
  const entry = makeEntry({ dmChatId: null })
  const db = { markAlerted: async () => {} }

  await assert.doesNotReject(() => sendMissedClockOutAlert(bot, entry, db))
})

// ── handleMissedClockOutCheck ─────────────────────────────────────────────────

test('handleMissedClockOutCheck: sends alert to staff DM', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [makeEntry({ dmChatId: 999 })],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  const msgs = bot.messagesTo(999)
  assert.ok(msgs.length > 0, 'Expected a DM to staff at chat 999')
})

test('handleMissedClockOutCheck: sends summary to manager DM', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [makeEntry({ dmChatId: 999 })],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  const msgs = bot.messagesTo(888)
  assert.ok(msgs.length > 0, 'Expected a summary DM to manager at chat 888')
})

test('handleMissedClockOutCheck: manager summary contains staff name', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [makeEntry({ staffName: 'Marcus', dmChatId: 999 })],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  const msg = bot.lastMessage(888)
  assert.ok(msg.text.includes('Marcus'), `Expected "Marcus" in manager summary: ${msg.text}`)
})

test('handleMissedClockOutCheck: no messages sent when no missed entries', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  assert.equal(bot.sentMessages.length, 0, 'Expected no messages when no missed entries')
})

test('handleMissedClockOutCheck: handles multiple missed entries', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [
      makeEntry({ staffId: 1, staffName: 'Marcus', dmChatId: 999, clockEntryId: 42 }),
      makeEntry({ staffId: 2, staffName: 'Jade', dmChatId: 777, clockEntryId: 43 }),
    ],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  assert.ok(bot.messagesTo(999).length > 0, 'Expected DM to Marcus (999)')
  assert.ok(bot.messagesTo(777).length > 0, 'Expected DM to Jade (777)')

  const managerMsg = bot.lastMessage(888)
  assert.ok(managerMsg.text.includes('Marcus'), 'Manager summary should mention Marcus')
  assert.ok(managerMsg.text.includes('Jade'), 'Manager summary should mention Jade')
})

test('handleMissedClockOutCheck: does not crash when manager DM unavailable', async () => {
  const bot = new MockBot()
  const db = {
    getMissedClockOuts: async () => [makeEntry({ dmChatId: 999 })],
    markAlerted: async () => {},
    getManagerDmChatId: async () => null,
  }

  await assert.doesNotReject(() => handleMissedClockOutCheck(bot, 'group-1', db))
})
