import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  getMissedClockOuts,
  sendMissedClockOutAlert,
  handleMissedClockOutCheck,
  autoClosePunch,
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

// ── P1-9: per-group clockout_grace_min ───────────────────────────────────────

test('getMissedClockOuts: respects clockout_grace_min from setup_data (short grace)', async () => {
  // Shift ended 20 min ago. Default grace=30 → would NOT appear.
  // With grace=15 → should appear.
  const now = new Date('2025-01-06T22:20:00') // 10:20 PM
  const entry = {
    staffId: 1,
    staffName: 'Petra',
    dmChatId: 111,
    shiftName: 'Late',
    shiftEndTime: '22:00', // ended at 22:00 → 20 min ago
    clockInTime: new Date('2025-01-06T18:00:00'),
    clockEntryId: 55,
  }
  // Real filter path (no db.getMissedClockOuts shortcut), inject rows+grace
  const rows = [
    {
      id: 55,
      user_id: 1,
      staff_id: 1,
      shift_id: 10,
      clock_in: new Date('2025-01-06T18:00:00').toISOString(),
      alerted_at: null,
      shifts: { name: 'Late', end_time: '22:00', day_of_week: 'Monday' },
      staff: { name: 'Petra' },
      staff_dms: { dm_chat_id: 111 },
    },
  ]
  const db = {
    _fetchOpenEntries: async () => rows,
    getSetupSession: async () => ({ setup_data: { clockout_grace_min: 15 } }),
  }
  const result = await getMissedClockOuts('group-1', now, db)
  assert.equal(result.length, 1, 'Grace=15 → 20-min-late entry should be returned')
})

test('getMissedClockOuts: respects clockout_grace_min from setup_data (long grace)', async () => {
  // Shift ended 20 min ago. Grace=60 → should NOT appear yet.
  const now = new Date('2025-01-06T22:20:00')
  const rows = [
    {
      id: 56,
      user_id: 1,
      staff_id: 1,
      shift_id: 10,
      clock_in: new Date('2025-01-06T18:00:00').toISOString(),
      alerted_at: null,
      shifts: { name: 'Late', end_time: '22:00', day_of_week: 'Monday' },
      staff: { name: 'Raj' },
      staff_dms: { dm_chat_id: 222 },
    },
  ]
  const db = {
    _fetchOpenEntries: async () => rows,
    getSetupSession: async () => ({ setup_data: { clockout_grace_min: 60 } }),
  }
  const result = await getMissedClockOuts('group-1', now, db)
  assert.equal(result.length, 0, 'Grace=60 → 20-min-late entry should NOT be returned')
})

test('getMissedClockOuts: falls back to 30-min grace when clockout_grace_min unset', async () => {
  // Shift ended 20 min ago → outside default 30-min grace.
  const now = new Date('2025-01-06T22:20:00')
  const rows = [
    {
      id: 57,
      user_id: 1,
      staff_id: 1,
      shift_id: 10,
      clock_in: new Date('2025-01-06T18:00:00').toISOString(),
      alerted_at: null,
      shifts: { name: 'Late', end_time: '22:00', day_of_week: 'Monday' },
      staff: { name: 'Sam' },
      staff_dms: { dm_chat_id: 333 },
    },
  ]
  const db = {
    _fetchOpenEntries: async () => rows,
    getSetupSession: async () => ({ setup_data: {} }),
  }
  const result = await getMissedClockOuts('group-1', now, db)
  assert.equal(result.length, 0, 'Default grace=30 → 20-min-late entry should NOT be returned')
})

// ── P1-11: auto-close missed clock-outs ──────────────────────────────────────

test('autoClosePunch: sets clock_out to shift end time', async () => {
  const closedRows = []
  const db = {
    autoClosePunch: async (entryId, clockOutTime, rawNote) => {
      closedRows.push({ entryId, clockOutTime, rawNote })
    },
  }
  const entry = makeEntry({ clockEntryId: 99, shiftEndTime: '22:00' })
  await autoClosePunch(entry, db)
  assert.equal(closedRows.length, 1, 'autoClosePunch should call db.autoClosePunch')
  assert.equal(closedRows[0].entryId, 99)
  // clock_out should be a Date or ISO string at 22:00
  const dt = new Date(closedRows[0].clockOutTime)
  assert.equal(dt.getHours(), 22, 'clock_out should be at shift end hour (22)')
  assert.equal(dt.getMinutes(), 0)
})

test('autoClosePunch: raw note contains "(auto-closed)"', async () => {
  const closedRows = []
  const db = {
    autoClosePunch: async (entryId, clockOutTime, rawNote) => {
      closedRows.push({ rawNote })
    },
  }
  await autoClosePunch(makeEntry({ clockEntryId: 100, shiftEndTime: '18:30' }), db)
  assert.ok(
    closedRows[0].rawNote.includes('auto-closed'),
    `Expected "(auto-closed)" in rawNote, got: "${closedRows[0].rawNote}"`
  )
})

test('handleMissedClockOutCheck: auto-closes open punch past end+grace and notifies manager', async () => {
  const bot = new MockBot()
  const closedEntries = []
  const db = {
    getMissedClockOuts: async () => [makeEntry({ dmChatId: 999, clockEntryId: 77, shiftEndTime: '22:00' })],
    markAlerted: async () => {},
    getManagerDmChatId: async () => 888,
    autoClosePunch: async (entryId, clockOutTime, rawNote) => {
      closedEntries.push({ entryId, clockOutTime, rawNote })
    },
  }

  await handleMissedClockOutCheck(bot, 'group-1', db)

  // Punch should be auto-closed
  assert.equal(closedEntries.length, 1, 'Expected autoClosePunch to be called once')
  assert.equal(closedEntries[0].entryId, 77)

  // Manager should be notified about auto-close
  const managerMsg = bot.lastMessage(888)
  assert.ok(managerMsg, 'Expected manager notification')
  assert.ok(
    managerMsg.text.toLowerCase().includes('auto') || managerMsg.text.toLowerCase().includes('closed'),
    `Expected auto-close mention in manager message: "${managerMsg.text}"`
  )
})
