import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  formatStaffList,
  detectStaffRemoval,
  fuzzyFindStaff,
  handleViewStaff,
  handleRemoveStaff,
  deactivateStaff,
  cancelFutureAssignments,
} from '../../setup/staffManager.js'

// ── formatStaffList ────────────────────────────────────────────────────────────

test('formatStaffList: 2 staff members → numbered with name and role, shows count', () => {
  const staff = [
    { id: 1, name: 'Marcus', role: 'Chef' },
    { id: 2, name: 'Sarah', role: 'Server' },
  ]
  const result = formatStaffList(staff)
  assert.ok(result.includes('2'), 'should show count')
  assert.ok(result.includes('Marcus'), 'should include Marcus')
  assert.ok(result.includes('Chef'), 'should include Chef role')
  assert.ok(result.includes('Sarah'), 'should include Sarah')
  assert.ok(result.includes('Server'), 'should include Server role')
  assert.ok(result.includes('1.'), 'should be numbered')
  assert.ok(result.includes('2.'), 'should be numbered')
})

test('formatStaffList: empty → "No staff registered yet."', () => {
  const result = formatStaffList([])
  assert.ok(result.includes('No staff registered yet.'))
})

test('formatStaffList: contains /removestaff instruction', () => {
  const staff = [{ id: 1, name: 'Marcus', role: 'Chef' }]
  const result = formatStaffList(staff)
  assert.ok(result.includes('/removestaff'), 'should include /removestaff')
})

// ── detectStaffRemoval ─────────────────────────────────────────────────────────

test('detectStaffRemoval: "Marcus quit" → Marcus', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('Marcus quit', staffNames), 'Marcus')
})

test('detectStaffRemoval: "remove Sarah from the team" → Sarah', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('remove Sarah from the team', staffNames), 'Sarah')
})

test('detectStaffRemoval: "Jake no longer works here" → Jake', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('Jake no longer works here', staffNames), 'Jake')
})

test('detectStaffRemoval: "fire Emma" → Emma', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('fire Emma', staffNames), 'Emma')
})

test('detectStaffRemoval: "can anyone cover" → null', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('can anyone cover', staffNames), null)
})

test('detectStaffRemoval: "my schedule" → null', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('my schedule', staffNames), null)
})

test('detectStaffRemoval: case insensitive "REMOVE MARCUS" → Marcus', () => {
  const staffNames = ['Marcus', 'Sarah', 'Jake', 'Emma']
  assert.equal(detectStaffRemoval('REMOVE MARCUS', staffNames), 'Marcus')
})

// ── fuzzyFindStaff ─────────────────────────────────────────────────────────────

const STAFF_LIST = [
  { id: 1, name: 'Marcus', role: 'Chef' },
  { id: 2, name: 'Sarah', role: 'Server' },
]

test('fuzzyFindStaff: "1" → first staff in list', () => {
  const result = fuzzyFindStaff('1', STAFF_LIST)
  assert.equal(result?.id, 1)
  assert.equal(result?.name, 'Marcus')
})

test('fuzzyFindStaff: "marc" → finds Marcus', () => {
  const result = fuzzyFindStaff('marc', STAFF_LIST)
  assert.equal(result?.name, 'Marcus')
})

test('fuzzyFindStaff: "SARAH" → finds Sarah (case insensitive)', () => {
  const result = fuzzyFindStaff('SARAH', STAFF_LIST)
  assert.equal(result?.name, 'Sarah')
})

test('fuzzyFindStaff: "xyz" → null', () => {
  const result = fuzzyFindStaff('xyz', STAFF_LIST)
  assert.equal(result, null)
})

test('fuzzyFindStaff: "3" when only 2 staff → null', () => {
  const result = fuzzyFindStaff('3', STAFF_LIST)
  assert.equal(result, null)
})

// ── handleViewStaff ────────────────────────────────────────────────────────────

test('handleViewStaff: sends message containing staff name', async () => {
  const bot = new MockBot()
  const msg = { chat: { id: '-100' }, from: { id: 1 } }
  const db = { getActiveStaff: async () => [{ id: 1, name: 'Marcus', role: 'Chef' }] }
  await handleViewStaff(bot, msg, db)
  bot.assertSent('-100', 'Marcus')
})

test('handleViewStaff: sends to msg.chat.id', async () => {
  const bot = new MockBot()
  const msg = { chat: { id: '-100' }, from: { id: 1 } }
  const db = { getActiveStaff: async () => [{ id: 1, name: 'Marcus', role: 'Chef' }] }
  await handleViewStaff(bot, msg, db)
  const msgs = bot.messagesTo('-100')
  assert.ok(msgs.length > 0, 'should send to msg.chat.id')
})

// ── handleRemoveStaff ──────────────────────────────────────────────────────────

test('handleRemoveStaff: no match → sends "Couldn\'t find" message', async () => {
  const bot = new MockBot()
  const msg = { chat: { id: '9001' }, from: { id: 1 } }
  const db = {
    getActiveStaff: async () => [{ id: 1, name: 'Marcus', role: 'Chef' }],
    deactivateStaff: async () => {},
    cancelFutureAssignments: async () => {},
  }
  await handleRemoveStaff(bot, msg, 'xyz', db)
  bot.assertSent('9001', "Couldn't find")
})

test('handleRemoveStaff: valid match → sends confirmation prompt containing name', async () => {
  const bot = new MockBot()
  const msg = { chat: { id: '9001' }, from: { id: 1 } }
  const db = {
    getActiveStaff: async () => [{ id: 1, name: 'Marcus', role: 'Chef' }],
    deactivateStaff: async () => {},
    cancelFutureAssignments: async () => {},
  }
  await handleRemoveStaff(bot, msg, 'Marcus', db)
  bot.assertSent('9001', 'Marcus')
})

test('handleRemoveStaff: sends to manager DM (msg.chat.id)', async () => {
  const bot = new MockBot()
  const msg = { chat: { id: '9001' }, from: { id: 1 } }
  const db = {
    getActiveStaff: async () => [{ id: 1, name: 'Marcus', role: 'Chef' }],
    deactivateStaff: async () => {},
    cancelFutureAssignments: async () => {},
  }
  await handleRemoveStaff(bot, msg, 'Marcus', db)
  const msgs = bot.messagesTo('9001')
  assert.ok(msgs.length > 0, 'should send to manager DM')
})

// ── deactivateStaff ────────────────────────────────────────────────────────────

test('deactivateStaff: calls update with active=false for correct staff/group', async () => {
  const calls = []
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }
  await deactivateStaff(42, '-100', db)
  assert.ok(calls.length > 0, 'should call db query')
  const call = calls[0]
  assert.ok(call.sql.toLowerCase().includes('active'), 'SQL should reference active column')
  assert.ok(call.params.includes(42), 'should pass staffId=42')
  assert.ok(call.params.includes('-100'), 'should pass groupId=-100')
})

test('deactivateStaff: only updates correct group_id', async () => {
  const calls = []
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }
  await deactivateStaff(1, '-999', db)
  const call = calls[0]
  assert.ok(call.params.includes('-999'), 'should use the provided groupId')
  assert.ok(!call.params.includes('-100'), 'should not use wrong groupId')
})

// ── cancelFutureAssignments ────────────────────────────────────────────────────

test('cancelFutureAssignments: calls update with status=cancelled for correct staff_id', async () => {
  const calls = []
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }
  await cancelFutureAssignments(42, db)
  assert.ok(calls.length > 0, 'should call db query')
  const call = calls[0]
  assert.ok(call.sql.toLowerCase().includes('cancelled'), 'SQL should set status=cancelled')
  assert.ok(call.params.includes(42), 'should pass staffId=42')
})

test('cancelFutureAssignments: only cancels for correct staff_id', async () => {
  const calls = []
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [] }
    },
  }
  await cancelFutureAssignments(77, db)
  const call = calls[0]
  assert.ok(call.params.includes(77), 'should use provided staffId')
  assert.ok(!call.params.includes(42), 'should not use wrong staffId')
})
