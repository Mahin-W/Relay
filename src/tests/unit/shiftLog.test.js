import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeDMMsg } from '../helpers/mocks.js'
import { handleManagerLogEntry, formatLogEntries } from '../../managerLog/shiftLog.js'
import { saveLogEntry, getLogEntries } from '../../managerLog/shiftLogDb.js'

const groupId = '-100'
const managerId = 12345
const weekStart = '2025-01-06'

// formatLogEntries (pure):
test('formatLogEntries: shows "No log entries" for empty array', () => {
  const result = formatLogEntries([], weekStart)
  assert.ok(result.includes('No log entries'))
})

test('formatLogEntries: shows entries with numbering', () => {
  const entries = [
    { entry_text: 'Marcus called in sick', created_at: new Date().toISOString() },
    { entry_text: 'Short on bar staff', created_at: new Date().toISOString() },
  ]
  const result = formatLogEntries(entries, weekStart)
  assert.ok(result.includes('Marcus'))
  assert.ok(result.includes('Short on bar staff'))
  assert.ok(result.includes('2 entries') || result.includes('2'))
})

test('formatLogEntries: includes week date in header', () => {
  const result = formatLogEntries([], weekStart)
  assert.ok(result.includes(weekStart) || result.includes('2025'))
})

// saveLogEntry with mock DB:
test('saveLogEntry: calls db method when provided', async () => {
  let saved = null
  const db = { saveLogEntry: async (gid, mid, text, ws) => { saved = { gid, mid, text, ws }; return { id: 1 } } }
  await saveLogEntry(groupId, managerId, 'test entry', weekStart, db)
  assert.equal(saved.gid, groupId)
  assert.equal(saved.text, 'test entry')
})

// getLogEntries with mock DB:
test('getLogEntries: returns empty array when none', async () => {
  const db = { getLogEntries: async () => [] }
  const result = await getLogEntries(groupId, weekStart, db)
  assert.deepEqual(result, [])
})

test('getLogEntries: returns entries from db', async () => {
  const entries = [{ id: 1, entry_text: 'Test entry', created_at: new Date().toISOString() }]
  const db = { getLogEntries: async () => entries }
  const result = await getLogEntries(groupId, weekStart, db)
  assert.equal(result.length, 1)
})

// handleManagerLogEntry:
const mockGetManager = async (userId) => ({ group_id: groupId, dm_chat_id: '999' })
const mockGetManagerNull = async () => null

test('handleManagerLogEntry: returns false for non-manager', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ text: 'This is a long enough message' })
  const db = {}
  const result = await handleManagerLogEntry(bot, msg, db, mockGetManagerNull)
  assert.equal(result, false)
  bot.assertSilent()
})

test('handleManagerLogEntry: returns false for short text (<=10 chars)', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ text: 'short' })
  const db = {}
  const result = await handleManagerLogEntry(bot, msg, db, mockGetManager)
  assert.equal(result, false)
})

test('handleManagerLogEntry: saves entry and replies "Logged." for valid input', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ text: 'Marcus called in sick for Thursday dinner shift' })
  let savedEntry = null
  const db = { saveLogEntry: async (gid, mid, text, ws) => { savedEntry = text; return { id: 1 } } }
  const result = await handleManagerLogEntry(bot, msg, db, mockGetManager)
  assert.equal(result, true)
  assert.ok(savedEntry !== null)
  const reply = bot.lastMessage(msg.chat.id)
  assert.ok(reply?.text.includes('Logged'))
})

test('handleManagerLogEntry: returns true even if db save fails gracefully', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ text: 'Some long manager note about the evening shift' })
  const db = { saveLogEntry: async () => null } // simulates save failure
  const result = await handleManagerLogEntry(bot, msg, db, mockGetManager)
  assert.equal(result, true) // still returns true — we tried
})
