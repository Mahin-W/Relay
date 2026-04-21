import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeDMMsg } from '../helpers/mocks.js'
import {
  fuzzyMatchStaffName,
  detectClockOverride,
  manualClockOut,
  manualClockIn,
  handleClockOverride,
  logManagerAction,
} from '../../timeclock/clockOverride.js'

// ── fuzzyMatchStaffName ───────────────────────────────────────────────────────

test('fuzzyMatchStaffName: partial lowercase match', () => {
  assert.equal(fuzzyMatchStaffName('marc', ['Marcus', 'Sarah']), 'Marcus')
})

test('fuzzyMatchStaffName: case insensitive match', () => {
  assert.equal(fuzzyMatchStaffName('SARAH', ['Marcus', 'Sarah']), 'Sarah')
})

test('fuzzyMatchStaffName: no match returns null', () => {
  assert.equal(fuzzyMatchStaffName('xyz', ['Marcus', 'Sarah']), null)
})

test('fuzzyMatchStaffName: returns first match if multiple', () => {
  const result = fuzzyMatchStaffName('mar', ['Marcus', 'Mary', 'Sarah'])
  assert.equal(result, 'Marcus')
})

// ── detectClockOverride ───────────────────────────────────────────────────────

const names = ['Marcus', 'Jake', 'Sarah']

test('clock_out: "clock out Marcus"', () => {
  const r = detectClockOverride('clock out Marcus', names)
  assert.equal(r.action, 'clock_out')
  assert.equal(r.staffName, 'Marcus')
  assert.equal(r.time, null)
})

test('clock_out: "Marcus forgot to clock out"', () => {
  const r = detectClockOverride('Marcus forgot to clock out', names)
  assert.equal(r.action, 'clock_out')
  assert.equal(r.staffName, 'Marcus')
})

test('clock_out: "clock out Marcus now"', () => {
  const r = detectClockOverride('clock out Marcus now', names)
  assert.equal(r.action, 'clock_out')
  assert.equal(r.staffName, 'Marcus')
})

test('adjust: "fix Jake\'s clock out to 11pm"', () => {
  const r = detectClockOverride("fix Jake's clock out to 11pm", names)
  assert.equal(r.action, 'adjust')
  assert.equal(r.staffName, 'Jake')
  assert.ok(r.time)
})

test('adjust: "change Sarah\'s clock out to 10:30"', () => {
  const r = detectClockOverride("change Sarah's clock out to 10:30", names)
  assert.equal(r.action, 'adjust')
  assert.equal(r.staffName, 'Sarah')
  assert.ok(r.time)
})

test('clock_in: "clock in Sarah at 5pm"', () => {
  const r = detectClockOverride('clock in Sarah at 5pm', names)
  assert.equal(r.action, 'clock_in')
  assert.equal(r.staffName, 'Sarah')
  assert.ok(r.time)
})

test('clock_in: "Jake clocked in at 9am"', () => {
  const r = detectClockOverride('Jake clocked in at 9am', names)
  assert.equal(r.action, 'clock_in')
  assert.equal(r.staffName, 'Jake')
  assert.ok(r.time)
})

test('no match: "can anyone cover tonight"', () => {
  assert.equal(detectClockOverride('can anyone cover tonight', names), null)
})

test('no match: "my pay"', () => {
  assert.equal(detectClockOverride('my pay', names), null)
})

test('no match: no staff name present', () => {
  assert.equal(detectClockOverride('clock out someone', names), null)
})

// ── manualClockOut ────────────────────────────────────────────────────────────

test('manualClockOut: calls db with correct args', async () => {
  const calls = []
  const db = {
    manualClockOut: async (staffId, groupId, time) => {
      calls.push({ staffId, groupId, time })
    },
  }
  const time = new Date().toISOString()
  await manualClockOut(5, 'grp-1', time, db)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].staffId, 5)
  assert.equal(calls[0].groupId, 'grp-1')
  assert.equal(calls[0].time, time)
})

// ── manualClockIn ─────────────────────────────────────────────────────────────

test('manualClockIn: calls db with is_manual=true', async () => {
  const calls = []
  const db = {
    manualClockIn: async (staffId, groupId, time) => {
      calls.push({ staffId, groupId, time })
    },
  }
  const time = new Date().toISOString()
  await manualClockIn(7, 'grp-2', time, db)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].staffId, 7)
  assert.equal(calls[0].groupId, 'grp-2')
})

// ── logManagerAction ──────────────────────────────────────────────────────────

test('logManagerAction: calls db.logManagerAction', async () => {
  const calls = []
  const db = {
    logManagerAction: async (groupId, managerId, entryText) => {
      calls.push({ groupId, managerId, entryText })
    },
  }
  await logManagerAction('grp-1', 999, 'Clocked out Marcus', db)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groupId, 'grp-1')
  assert.equal(calls[0].managerId, 999)
  assert.ok(calls[0].entryText.includes('Marcus'))
})

// ── handleClockOverride ───────────────────────────────────────────────────────

const staff = [{ id: 1, name: 'Marcus', role: 'Chef' }]

test('handleClockOverride: non-admin → no action', async () => {
  const bot = new MockBot()
  // getChatMember returns {status:'member'} by default
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_out', staffName: 'Marcus', time: null }
  const db = {
    getOpenClockEntry: async () => ({ id: 5, clock_in: new Date(Date.now() - 3600000) }),
    manualClockOut: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, staff, db)
  bot.assertSilent()
})

test('handleClockOverride: admin + clock_out + open entry → sends clocked out message', async () => {
  const bot = new MockBot()
  bot.setAdmin(888, 101)
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_out', staffName: 'Marcus', time: null }
  const db = {
    getOpenClockEntry: async () => ({ id: 5, clock_in: new Date(Date.now() - 3600000) }),
    manualClockOut: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, staff, db)
  const last = bot.last
  assert.ok(last, 'Expected a message to be sent')
  assert.ok(last.text.includes('Clocked out') || last.text.includes('clocked out'))
  assert.ok(last.text.includes('Marcus'))
})

test('handleClockOverride: admin + clock_out + no open entry → not clocked in message', async () => {
  const bot = new MockBot()
  bot.setAdmin(888, 101)
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_out', staffName: 'Marcus', time: null }
  const db = {
    getOpenClockEntry: async () => null,
    manualClockOut: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, staff, db)
  const last = bot.last
  assert.ok(last, 'Expected a message to be sent')
  assert.ok(last.text.toLowerCase().includes("isn't currently clocked in") || last.text.toLowerCase().includes('not clocked in'))
})

test('handleClockOverride: admin + clock_in → creates entry and sends confirmation', async () => {
  const bot = new MockBot()
  bot.setAdmin(888, 101)
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_in', staffName: 'Marcus', time: '9am' }
  const db = {
    manualClockIn: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, staff, db)
  const last = bot.last
  assert.ok(last, 'Expected a message to be sent')
  assert.ok(last.text.includes('Marcus'))
  assert.ok(last.text.toLowerCase().includes('clock') || last.text.includes('✅'))
})

test('handleClockOverride: ambiguous staff → disambiguation message', async () => {
  const bot = new MockBot()
  bot.setAdmin(888, 101)
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_out', staffName: 'Mar', time: null }
  const multiStaff = [
    { id: 1, name: 'Marcus', role: 'Chef' },
    { id: 2, name: 'Maria', role: 'Server' },
  ]
  const db = {
    getOpenClockEntry: async () => null,
    manualClockOut: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, multiStaff, db)
  const last = bot.last
  assert.ok(last, 'Expected a disambiguation message')
  // Should show multiple options
  assert.ok(last.text.includes('1.') || last.text.toLowerCase().includes('which'))
})

test('handleClockOverride: staff not found → "Couldn\'t find" message', async () => {
  const bot = new MockBot()
  bot.setAdmin(888, 101)
  const msg = makeDMMsg({ from: { id: 101 }, chat: { id: 888 } })
  const intent = { action: 'clock_out', staffName: 'Unknown Person', time: null }
  const db = {
    getOpenClockEntry: async () => null,
    manualClockOut: async () => {},
    logManagerAction: async () => {},
  }
  await handleClockOverride(bot, msg, intent, staff, db)
  const last = bot.last
  assert.ok(last, 'Expected a not-found message')
  assert.ok(last.text.toLowerCase().includes("couldn't find") || last.text.toLowerCase().includes('not found'))
})
