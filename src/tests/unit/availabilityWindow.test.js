import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  extractAvailabilityWindow,
  formatWindowDescription,
  saveAvailabilityWindow,
  getAvailabilityWindow,
  handleAvailabilityWindowUpdate,
} from '../../availability/availabilityWindow.js'

// ── Phase 1: Pure function tests — no LLM ─────────────────────────────────────

test('formatWindowDescription: weekends only', () => {
  const r = formatWindowDescription({ daysAvailable: ['Saturday', 'Sunday'] })
  assert.ok(r.includes('weekend') || r.includes('Sat'), `Got: "${r}"`)
})

test('formatWindowDescription: available after 2pm', () => {
  const r = formatWindowDescription({ afterTime: '14:00' })
  assert.ok(r.includes('2pm') || r.includes('after'), `Got: "${r}"`)
})

test('formatWindowDescription: not available before 10am', () => {
  const r = formatWindowDescription({ beforeTime: '10:00' })
  assert.ok(r.includes('10am') || r.includes('before'), `Got: "${r}"`)
})

test('formatWindowDescription: Mon-Fri only', () => {
  const r = formatWindowDescription({ daysAvailable: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] })
  assert.ok(r.includes('Mon') || r.includes('weekday'), `Got: "${r}"`)
})

test('formatWindowDescription: afterTime 9:00 → 9am', () => {
  const r = formatWindowDescription({ afterTime: '09:00' })
  assert.ok(r.includes('9am') || r.includes('after'), `Got: "${r}"`)
})

test('formatWindowDescription: beforeTime 12:00 → 12pm', () => {
  const r = formatWindowDescription({ beforeTime: '12:00' })
  assert.ok(r.includes('12') || r.includes('noon') || r.includes('before'), `Got: "${r}"`)
})

test('formatWindowDescription: single day', () => {
  const r = formatWindowDescription({ daysAvailable: ['Saturday'] })
  assert.ok(r.includes('Sat') || r.includes('Saturday'), `Got: "${r}"`)
})

test('formatWindowDescription: combined days and afterTime', () => {
  const r = formatWindowDescription({ daysAvailable: ['Monday', 'Tuesday'], afterTime: '10:00' })
  assert.ok(r.length > 0, 'Should return non-empty string')
})

// ── saveAvailabilityWindow with MockDB ────────────────────────────────────────

test('saveAvailabilityWindow: calls injected db function', async () => {
  const calls = []
  const db = { saveAvailabilityWindow: async (...args) => { calls.push(args); return {} } }
  await saveAvailabilityWindow(1, 'group123', { daysAvailable: ['Saturday'] }, db)
  assert.equal(calls.length, 1)
})

test('saveAvailabilityWindow: passes correct staffId and groupId', async () => {
  const calls = []
  const db = { saveAvailabilityWindow: async (...args) => { calls.push(args); return {} } }
  await saveAvailabilityWindow(42, 'group-abc', { daysAvailable: ['Sunday'] }, db)
  assert.equal(calls[0][0], 42)
  assert.equal(calls[0][1], 'group-abc')
})

test('saveAvailabilityWindow: second save is upsert (only one call per save)', async () => {
  const calls = []
  const db = { saveAvailabilityWindow: async (...args) => { calls.push(args); return {} } }
  await saveAvailabilityWindow(1, 'g1', { daysAvailable: ['Monday'] }, db)
  await saveAvailabilityWindow(1, 'g1', { daysAvailable: ['Tuesday'] }, db)
  // Each call should result in exactly one DB call (not duplicates)
  assert.equal(calls.length, 2)
})

// ── getAvailabilityWindow with MockDB ─────────────────────────────────────────

test('getAvailabilityWindow: returns row from injected db', async () => {
  const mockRow = { staff_id: 5, days_available: ['Monday'], before_time: null, after_time: '14:00' }
  const db = { getAvailabilityWindow: async () => mockRow }
  const result = await getAvailabilityWindow(5, db)
  assert.deepEqual(result, mockRow)
})

test('getAvailabilityWindow: returns null when not found', async () => {
  const db = { getAvailabilityWindow: async () => null }
  const result = await getAvailabilityWindow(99, db)
  assert.equal(result, null)
})

// ── handleAvailabilityWindowUpdate: non-window message returns false ──────────

test('handleAvailabilityWindowUpdate: returns false and sends nothing for non-window messages', async () => {
  const bot = new MockBot()
  const msg = {
    chat: { id: '12345', type: 'private' },
    from: { id: 101, first_name: 'Alice' },
    text: 'what time does my shift start',
  }
  // inject extractAvailabilityWindow that returns isWindowUpdate: false
  const db = {
    extractAvailabilityWindow: async () => ({ isWindowUpdate: false }),
    getStaffByUserId: async () => null,
    getAvailabilityWindow: async () => null,
    saveAvailabilityWindow: async () => {},
  }
  const result = await handleAvailabilityWindowUpdate(bot, msg, db)
  assert.equal(result, false)
  bot.assertSilent()
})

test('handleAvailabilityWindowUpdate: returns false for shift coverage messages', async () => {
  const bot = new MockBot()
  const msg = {
    chat: { id: '12345', type: 'private' },
    from: { id: 102, first_name: 'Bob' },
    text: 'I can cover tonight',
  }
  const db = {
    extractAvailabilityWindow: async () => ({ isWindowUpdate: false }),
    getStaffByUserId: async () => null,
    getAvailabilityWindow: async () => null,
    saveAvailabilityWindow: async () => {},
  }
  const result = await handleAvailabilityWindowUpdate(bot, msg, db)
  assert.equal(result, false)
  bot.assertSilent()
})

// ── handleAvailabilityWindowUpdate: window message sends confirmation ─────────

test('handleAvailabilityWindowUpdate: returns true and DMs staff when isWindowUpdate is true', async () => {
  const bot = new MockBot()
  const msg = {
    chat: { id: '55555', type: 'private' },
    from: { id: 201, first_name: 'Sam' },
    text: "I'm not available before 10am",
  }
  const db = {
    extractAvailabilityWindow: async () => ({
      isWindowUpdate: true,
      daysAvailable: null,
      beforeTime: '10:00',
      afterTime: null,
    }),
    getStaffByUserId: async () => ({ id: 5, name: 'Sam', group_id: 'g1' }),
    getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: 999 }),
    pendingWindow: {},
    saveAvailabilityWindow: async () => {},
    getAvailabilityWindow: async () => null,
  }
  const result = await handleAvailabilityWindowUpdate(bot, msg, db)
  assert.equal(result, true)
  // Should send a confirmation message to staff
  assert.ok(bot.sentMessages.length > 0, 'Expected at least one message sent')
  const staffMsg = bot.lastMessage('55555')
  assert.ok(staffMsg, 'Expected message sent to staff DM')
  assert.ok(
    staffMsg.text.toLowerCase().includes('yes') || staffMsg.text.toLowerCase().includes('save') || staffMsg.text.toLowerCase().includes('got it'),
    `Expected confirmation prompt, got: "${staffMsg.text}"`
  )
})

// ── Phase 2: LLM tests ────────────────────────────────────────────────────────

test('extractAvailabilityWindow: "I\'m not available before 10am"', async () => {
  const r = await extractAvailabilityWindow("I'm not available before 10am")
  assert.equal(r.isWindowUpdate, true)
  assert.ok(r.beforeTime, `Expected beforeTime, got: ${JSON.stringify(r)}`)
})

test('extractAvailabilityWindow: "I can only work weekends"', async () => {
  const r = await extractAvailabilityWindow("I can only work weekends")
  assert.equal(r.isWindowUpdate, true)
  assert.ok(r.daysAvailable, `Expected daysAvailable, got: ${JSON.stringify(r)}`)
  assert.ok(
    r.daysAvailable.some(d => d.toLowerCase().includes('sat') || d.toLowerCase().includes('sun')),
    `Expected weekend days, got: ${JSON.stringify(r.daysAvailable)}`
  )
})

test('extractAvailabilityWindow: "available Mon-Fri"', async () => {
  const r = await extractAvailabilityWindow("available Mon-Fri")
  assert.equal(r.isWindowUpdate, true)
  assert.ok(r.daysAvailable, `Expected daysAvailable, got: ${JSON.stringify(r)}`)
  assert.ok(r.daysAvailable.length >= 5, `Expected 5+ days, got: ${JSON.stringify(r.daysAvailable)}`)
})

test('extractAvailabilityWindow: "I can work any time after 2pm"', async () => {
  const r = await extractAvailabilityWindow("I can work any time after 2pm")
  assert.equal(r.isWindowUpdate, true)
  assert.ok(r.afterTime, `Expected afterTime, got: ${JSON.stringify(r)}`)
})

test('extractAvailabilityWindow: "I can cover tonight" → false', async () => {
  const r = await extractAvailabilityWindow("I can cover tonight")
  assert.equal(r.isWindowUpdate, false)
})

test('extractAvailabilityWindow: "my schedule" → false', async () => {
  const r = await extractAvailabilityWindow("my schedule")
  assert.equal(r.isWindowUpdate, false)
})

test('extractAvailabilityWindow: "I need Friday off" → false (one-time request)', async () => {
  const r = await extractAvailabilityWindow("I need Friday off")
  assert.equal(r.isWindowUpdate, false)
})
