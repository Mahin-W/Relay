import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBotAdmins,
  isBotAdminInData,
  addBotAdminToData,
  removeBotAdminFromData,
} from '../../setup/setupDb.js'

// ── parseBotAdmins ───────────────────────────────────────────────────────────

test('parseBotAdmins: returns empty array when setup_data is null', () => {
  assert.deepEqual(parseBotAdmins(null), [])
})

test('parseBotAdmins: returns empty array when bot_admins not set', () => {
  assert.deepEqual(parseBotAdmins({}), [])
})

test('parseBotAdmins: normalizes userId to string', () => {
  const result = parseBotAdmins({ bot_admins: [{ userId: 1234, firstName: 'Alice' }] })
  assert.equal(result[0].userId, '1234')
})

// ── isBotAdminInData ─────────────────────────────────────────────────────────

test('isBotAdminInData: returns true for existing admin', () => {
  const setupData = { bot_admins: [{ userId: '42', firstName: 'Bob' }] }
  assert.equal(isBotAdminInData(setupData, '42'), true)
})

test('isBotAdminInData: returns true when userId is a number (coercion)', () => {
  const setupData = { bot_admins: [{ userId: '42', firstName: 'Bob' }] }
  assert.equal(isBotAdminInData(setupData, 42), true)
})

test('isBotAdminInData: returns false for non-admin', () => {
  const setupData = { bot_admins: [{ userId: '42', firstName: 'Bob' }] }
  assert.equal(isBotAdminInData(setupData, '99'), false)
})

test('isBotAdminInData: returns false when setup_data has no bot_admins', () => {
  assert.equal(isBotAdminInData({}, '42'), false)
})

// ── addBotAdminToData ────────────────────────────────────────────────────────

test('addBotAdminToData: adds new admin', () => {
  const { status, setupData } = addBotAdminToData({}, '10', 'Alice')
  assert.equal(status, 'added')
  assert.ok(setupData.bot_admins.some(a => a.userId === '10' && a.firstName === 'Alice'))
})

test('addBotAdminToData: preserves existing admins', () => {
  const existing = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  const { setupData } = addBotAdminToData(existing, '20', 'Bob')
  assert.equal(setupData.bot_admins.length, 2)
})

test('addBotAdminToData: returns already when duplicate userId', () => {
  const existing = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  const { status } = addBotAdminToData(existing, '10', 'Alice')
  assert.equal(status, 'already')
})

test('addBotAdminToData: does not mutate original setupData', () => {
  const original = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  addBotAdminToData(original, '20', 'Bob')
  assert.equal(original.bot_admins.length, 1)
})

// ── removeBotAdminFromData ───────────────────────────────────────────────────

test('removeBotAdminFromData: removes existing admin', () => {
  const existing = { bot_admins: [{ userId: '10', firstName: 'Alice' }, { userId: '20', firstName: 'Bob' }] }
  const { status, setupData } = removeBotAdminFromData(existing, '10')
  assert.equal(status, 'removed')
  assert.equal(setupData.bot_admins.length, 1)
  assert.equal(setupData.bot_admins[0].userId, '20')
})

test('removeBotAdminFromData: returns not_found when userId not in list', () => {
  const existing = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  const { status } = removeBotAdminFromData(existing, '99')
  assert.equal(status, 'not_found')
})

test('removeBotAdminFromData: handles number userId (coercion)', () => {
  const existing = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  const { status } = removeBotAdminFromData(existing, 10)
  assert.equal(status, 'removed')
})

test('removeBotAdminFromData: does not mutate original setupData', () => {
  const original = { bot_admins: [{ userId: '10', firstName: 'Alice' }] }
  removeBotAdminFromData(original, '10')
  assert.equal(original.bot_admins.length, 1)
})
