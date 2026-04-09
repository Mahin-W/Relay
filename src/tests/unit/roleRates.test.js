import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  parseRateInput,
  handleRoleRatesStep,
  moveToRoleRatesStep,
} from '../../setup/roleRatesSteps.js'

// ── parseRateInput ────────────────────────────────────────────────────────────

await Promise.all([
  test('parseRateInput: "15" → 15.00', () => {
    assert.equal(parseRateInput('15'), 15.00)
  }),

  test('parseRateInput: "15.50" → 15.50', () => {
    assert.equal(parseRateInput('15.50'), 15.50)
  }),

  test('parseRateInput: "13" → 13.00', () => {
    assert.equal(parseRateInput('13'), 13.00)
  }),

  test('parseRateInput: "$15" → 15 (strips dollar sign)', () => {
    assert.equal(parseRateInput('$15'), 15.00)
  }),

  test('parseRateInput: "abc" → null', () => {
    assert.equal(parseRateInput('abc'), null)
  }),

  test('parseRateInput: "-5" → null (negative)', () => {
    assert.equal(parseRateInput('-5'), null)
  }),

  test('parseRateInput: "0" → null (zero not allowed)', () => {
    assert.equal(parseRateInput('0'), null)
  }),

  test('parseRateInput: "" → null (empty)', () => {
    assert.equal(parseRateInput(''), null)
  }),

  test('parseRateInput: "  15  " → 15.00 (trims whitespace)', () => {
    assert.equal(parseRateInput('  15  '), 15.00)
  }),

  // ── moveToRoleRatesStep ───────────────────────────────────────────────────

  test('moveToRoleRatesStep: skips to add_staff when no roles defined', async () => {
    const bot = new MockBot()
    const session = { group_id: 'g1', setup_data: {} }
    const db = {
      getUniqueRolesForGroup: async () => [],
      updateSetupSession: async (gid, updates) => ({ ...session, ...updates }),
    }
    await moveToRoleRatesStep(bot, { chat: { id: '111' } }, session, db)
    // Should send add_staff prompt, not role_rates prompt
    const msg = bot.lastMessage('111')
    assert.ok(msg, 'should send a message')
    assert.ok(!msg.text.includes('hourly rate'), 'should not ask for rate when no roles')
  }),

  test('moveToRoleRatesStep: asks rate for first role when roles exist', async () => {
    const bot = new MockBot()
    const session = { group_id: 'g1', setup_data: {} }
    const db = {
      getUniqueRolesForGroup: async () => ['Chef', 'Server'],
      updateSetupSession: async () => {},
    }
    await moveToRoleRatesStep(bot, { chat: { id: '111' } }, session, db)
    bot.assertSent('111', 'Chef')
    bot.assertSent('111', 'hourly rate')
  }),

  // ── handleRoleRatesStep ───────────────────────────────────────────────────

  test('handleRoleRatesStep: valid input saves rate and asks for next role', async () => {
    const bot = new MockBot()
    const saved = []
    const session = {
      group_id: 'g1',
      setup_data: { role_rates_pending: ['Chef', 'Server'] },
    }
    const db = {
      updateRoleRate: async (gid, role, rate) => { saved.push({ role, rate }) },
      updateSetupSession: async () => {},
    }
    await handleRoleRatesStep(bot, { chat: { id: '111' } }, session, '15', db)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].role, 'Chef')
    assert.equal(saved[0].rate, 15)
    bot.assertSent('111', 'Server')
  }),

  test('handleRoleRatesStep: invalid input shows error and stays on step', async () => {
    const bot = new MockBot()
    const saved = []
    const session = {
      group_id: 'g1',
      setup_data: { role_rates_pending: ['Chef'] },
    }
    const db = {
      updateRoleRate: async (gid, role, rate) => { saved.push({ role, rate }) },
      updateSetupSession: async () => {},
    }
    await handleRoleRatesStep(bot, { chat: { id: '111' } }, session, 'abc', db)
    assert.equal(saved.length, 0, 'should not save on invalid input')
    const msg = bot.lastMessage('111')
    assert.ok(msg.text.toLowerCase().includes('number') || msg.text.includes('15') || msg.text.includes("doesn't look right"),
      'should show error message')
  }),

  test('handleRoleRatesStep: invalid negative shows error', async () => {
    const bot = new MockBot()
    const session = { group_id: 'g1', setup_data: { role_rates_pending: ['Chef'] } }
    const db = { updateRoleRate: async () => {}, updateSetupSession: async () => {} }
    await handleRoleRatesStep(bot, { chat: { id: '111' } }, session, '-5', db)
    const msg = bot.lastMessage('111')
    assert.ok(msg.text.toLowerCase().includes('number') || msg.text.includes('15') || msg.text.includes("doesn't look right"))
  }),

  test('handleRoleRatesStep: after all roles set, shows confirmation message', async () => {
    const bot = new MockBot()
    const updatedSession = {}
    const session = {
      group_id: 'g1',
      setup_data: {
        role_rates_pending: ['Server'],
        role_rates_saved: [{ roleName: 'Chef', hourlyRate: 15.00 }],
      },
    }
    const db = {
      updateRoleRate: async () => {},
      updateSetupSession: async (gid, updates) => { Object.assign(updatedSession, updates) },
    }
    await handleRoleRatesStep(bot, { chat: { id: '111' } }, session, '13.50', db)
    const msg = bot.lastMessage('111')
    // Confirmation should list all rates
    assert.ok(msg.text.includes('Chef') || msg.text.includes('Server'), 'should mention role names')
    assert.ok(msg.text.includes('15') || msg.text.includes('13.50'), 'should show rates')
    assert.ok(msg.text.includes('✅'), 'should have checkmark')
  }),

  test('handleRoleRatesStep: confirmation mentions /setrate', async () => {
    const bot = new MockBot()
    const session = {
      group_id: 'g1',
      setup_data: {
        role_rates_pending: ['Server'],
        role_rates_saved: [],
      },
    }
    const db = {
      updateRoleRate: async () => {},
      updateSetupSession: async () => {},
    }
    await handleRoleRatesStep(bot, { chat: { id: '111' } }, session, '13.50', db)
    const msg = bot.lastMessage('111')
    assert.ok(msg.text.includes('/setrate'), 'should mention /setrate command')
  }),

  // ── /setrate validation ───────────────────────────────────────────────────

  test('parseRateInput: "16.50" → 16.50', () => {
    assert.equal(parseRateInput('16.50'), 16.50)
  }),

  test('parseRateInput: rate stored as decimal, not string', () => {
    const result = parseRateInput('15')
    assert.equal(typeof result, 'number')
  }),

  test('getRatesForGroup: returns all roles with rates (via db mock)', async () => {
    const { getRatesForGroup } = await import('../../setup/db/roles.js')
    const db = {
      getRatesForGroup: async () => [
        { role_name: 'Chef', hourly_rate: 15.00 },
        { role_name: 'Server', hourly_rate: 13.50 },
      ],
    }
    const rates = await getRatesForGroup('g1', db)
    assert.equal(rates.length, 2)
    assert.equal(rates[0].roleName, 'Chef')
    assert.equal(rates[0].hourlyRate, 15.00)
  }),
])
