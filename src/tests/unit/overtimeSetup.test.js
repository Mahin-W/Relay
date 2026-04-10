import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { handleOvertimeStep, startOvertimeStep } from '../../setup/overtimeSteps.js'

function makeSession(stage, extraData = {}) {
  return {
    group_id: '-100',
    setup_data: { overtime_stage: stage, ...extraData },
    from: { first_name: 'TestMgr' },
  }
}

function makeMsg(text, chatId = '999') {
  return { text, chat: { id: chatId }, from: { first_name: 'TestMgr' } }
}

function makeMockDb(overrides = {}) {
  return {
    updateSetupSession: async () => ({}),
    saveOvertimeSettings: async (groupId, settings) => ({ group_id: groupId, ...settings }),
    getOvertimeSettings: async () => null,
    ...overrides,
  }
}

// ── startOvertimeStep ──────────────────────────────────────────────────
test('startOvertimeStep: sends overtime question', async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await startOvertimeStep(bot, '999', '-100', {}, db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('overtime'))
})

test('startOvertimeStep: sets session step to overtime_setup', async () => {
  const bot = new MockBot()
  let savedStep = null
  const db = makeMockDb({ updateSetupSession: async (gid, fields) => { savedStep = fields.step } })
  await startOvertimeStep(bot, '999', '-100', {}, db)
  assert.equal(savedStep, 'overtime_setup')
})

// ── enabled question ───────────────────────────────────────────────────
test("overtime 'no' → saves overtime_enabled:false", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_enabled')
  await handleOvertimeStep(bot, makeMsg('no'), session, 'no', db)
  assert.equal(saved.overtime_enabled, false)
})

test("overtime 'no' → sends confirmation message", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('no'), makeSession('ask_enabled'), 'no', db)
  const msgs = bot.sentMessages.map(m => m.text).join(' ')
  assert.ok(msgs.includes('saved') || msgs.includes('overtime') || msgs.includes('complete') || msgs.includes('Overtime'))
})

test("overtime 'yes' → asks weekly threshold", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('yes'), makeSession('ask_enabled'), 'yes', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('week') || last.text.toLowerCase().includes('hours'))
})

test("overtime invalid answer → asks again", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('maybe'), makeSession('ask_enabled'), 'maybe', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('yes') || last.text.toLowerCase().includes('no'))
})

// ── weekly threshold ───────────────────────────────────────────────────
test("weekly threshold '40' → saved as 40", async () => {
  const bot = new MockBot()
  let savedData = null
  const db = makeMockDb({ updateSetupSession: async (gid, fields) => { if (fields.setup_data) savedData = fields.setup_data } })
  await handleOvertimeStep(bot, makeMsg('40'), makeSession('ask_weekly_threshold'), '40', db)
  assert.equal(savedData?.overtime_weekly_threshold, 40)
})

test("weekly threshold '0' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('0'), makeSession('ask_weekly_threshold'), '0', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('1') && last.text.includes('80'))
})

test("weekly threshold '81' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('81'), makeSession('ask_weekly_threshold'), '81', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('80') || last.text.includes('between'))
})

test("weekly threshold 'abc' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('abc'), makeSession('ask_weekly_threshold'), 'abc', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('number') || last.text.includes('between'))
})

// ── weekly multiplier ──────────────────────────────────────────────────
test("multiplier '1.5' → saved as 1.5", async () => {
  const bot = new MockBot()
  let savedData = null
  const db = makeMockDb({ updateSetupSession: async (gid, f) => { if (f.setup_data) savedData = f.setup_data } })
  const session = makeSession('ask_weekly_multiplier', { overtime_weekly_threshold: 40 })
  await handleOvertimeStep(bot, makeMsg('1.5'), session, '1.5', db)
  assert.equal(savedData?.overtime_weekly_multiplier, 1.5)
})

test("multiplier '1.0' → validation error (must be > 1.0)", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('1.0'), makeSession('ask_weekly_multiplier'), '1.0', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('1.0') || last.text.includes('more than'))
})

test("multiplier '3.1' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('3.1'), makeSession('ask_weekly_multiplier'), '3.1', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('3.0') || last.text.includes('number') || last.text.includes('like'))
})

test("multiplier 'abc' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('abc'), makeSession('ask_weekly_multiplier'), 'abc', db)
  assert.ok(bot.lastMessage().text.includes('number') || bot.lastMessage().text.includes('like'))
})

// ── daily question ─────────────────────────────────────────────────────
test("daily 'yes' → asks daily threshold", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  const session = makeSession('ask_daily', { overtime_weekly_threshold: 40, overtime_weekly_multiplier: 1.5 })
  await handleOvertimeStep(bot, makeMsg('yes'), session, 'yes', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('day') || last.text.toLowerCase().includes('hours'))
})

test("daily 'no' → saves daily_overtime_enabled:false", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_daily', {
    overtime_enabled: true, overtime_weekly_threshold: 40, overtime_weekly_multiplier: 1.5,
  })
  await handleOvertimeStep(bot, makeMsg('no'), session, 'no', db)
  assert.equal(saved.daily_overtime_enabled, false)
})

// ── daily threshold ────────────────────────────────────────────────────
test("daily threshold '8' → saved as 8", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_daily_threshold', {
    overtime_enabled: true, overtime_weekly_threshold: 40,
    overtime_weekly_multiplier: 1.5, overtime_daily_enabled: true,
  })
  await handleOvertimeStep(bot, makeMsg('8'), session, '8', db)
  assert.equal(saved.daily_threshold, 8)
})

test("daily threshold '25' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('25'), makeSession('ask_daily_threshold'), '25', db)
  assert.ok(bot.lastMessage().text.includes('24') || bot.lastMessage().text.includes('between'))
})

// ── saveOvertimeSettings DB ────────────────────────────────────────────
test('saveOvertimeSettings: upserts correctly (via mock)', async () => {
  const { saveOvertimeSettings } = await import('../../setup/db/overtime.js')
  let upserted = null
  const db = { saveOvertimeSettings: async (gid, s) => { upserted = { gid, ...s }; return upserted } }
  await saveOvertimeSettings('-100', { overtime_enabled: true, weekly_threshold: 40 }, db)
  assert.equal(upserted.gid, '-100')
  assert.equal(upserted.overtime_enabled, true)
  assert.equal(upserted.weekly_threshold, 40)
})

test('saveOvertimeSettings: second save uses same groupId (upsert pattern)', async () => {
  let callCount = 0
  const db = { saveOvertimeSettings: async () => { callCount++; return {} } }
  const { saveOvertimeSettings } = await import('../../setup/db/overtime.js')
  await saveOvertimeSettings('-100', { overtime_enabled: true }, db)
  await saveOvertimeSettings('-100', { overtime_enabled: false }, db)
  assert.equal(callCount, 2)
})

test('getOvertimeSettings: returns defaults when no record', async () => {
  const { getOvertimeSettings } = await import('../../setup/db/overtime.js')
  const db = { getOvertimeSettings: async () => null }
  const result = await getOvertimeSettings('-100', db)
  assert.equal(result.weekly_threshold, 40)
  assert.equal(result.weekly_multiplier, 1.5)
  assert.equal(result.daily_overtime_enabled, false)
})

test('getOvertimeSettings: returns saved values when record exists', async () => {
  const { getOvertimeSettings } = await import('../../setup/db/overtime.js')
  const db = {
    getOvertimeSettings: async () => ({
      overtime_enabled: true, weekly_threshold: 35,
      weekly_multiplier: 2.0, daily_overtime_enabled: true,
      daily_threshold: 10, daily_multiplier: 1.5,
    }),
  }
  const result = await getOvertimeSettings('-100', db)
  assert.equal(result.weekly_threshold, 35)
  assert.equal(result.weekly_multiplier, 2.0)
  assert.equal(result.daily_overtime_enabled, true)
})
