import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addBotAdminToData,
  removeBotAdminFromData,
  isBotAdminInData,
  parseBotAdmins,
} from '../../setup/setupDb.js'

// Integration-level tests: simulate the full add → verify → remove lifecycle
// using the pure data helpers (no DB). This validates the complete workflow
// that the /addadmin, /removeadmin, and /admins commands depend on.

test('full admin lifecycle: add, verify, remove', () => {
  let setupData = {}

  // Add first admin
  const add1 = addBotAdminToData(setupData, '100', 'Alice')
  assert.equal(add1.status, 'added')
  setupData = add1.setupData

  // Verify Alice is now an admin
  assert.equal(isBotAdminInData(setupData, '100'), true)

  // Add second admin
  const add2 = addBotAdminToData(setupData, '200', 'Bob')
  assert.equal(add2.status, 'added')
  setupData = add2.setupData

  // Both are admins
  assert.equal(isBotAdminInData(setupData, '100'), true)
  assert.equal(isBotAdminInData(setupData, '200'), true)

  // List shows 2 admins
  const list = parseBotAdmins(setupData)
  assert.equal(list.length, 2)

  // Duplicate add → already
  const addDup = addBotAdminToData(setupData, '100', 'Alice')
  assert.equal(addDup.status, 'already')
  assert.equal(parseBotAdmins(addDup.setupData).length, 2) // no duplicate added

  // Remove Alice
  const remove1 = removeBotAdminFromData(setupData, '100')
  assert.equal(remove1.status, 'removed')
  setupData = remove1.setupData

  // Alice gone, Bob remains
  assert.equal(isBotAdminInData(setupData, '100'), false)
  assert.equal(isBotAdminInData(setupData, '200'), true)

  // Remove someone who isn't an admin
  const removeGhost = removeBotAdminFromData(setupData, '999')
  assert.equal(removeGhost.status, 'not_found')
})

test('non-manager user is not a bot admin by default', () => {
  // Fresh setup_data (no bot_admins key)
  assert.equal(isBotAdminInData({}, '42'), false)
  assert.equal(isBotAdminInData(null, '42'), false)
})

test('bot admins list is empty after all removed', () => {
  let setupData = {}
  setupData = addBotAdminToData(setupData, '1', 'A').setupData
  setupData = addBotAdminToData(setupData, '2', 'B').setupData
  setupData = removeBotAdminFromData(setupData, '1').setupData
  setupData = removeBotAdminFromData(setupData, '2').setupData
  assert.equal(parseBotAdmins(setupData).length, 0)
})

test('userId coercion: number and string treated as same identity', () => {
  let setupData = addBotAdminToData({}, 123, 'Charlie').setupData
  // Verify with both number and string
  assert.equal(isBotAdminInData(setupData, 123), true)
  assert.equal(isBotAdminInData(setupData, '123'), true)
  // Remove with number
  const { status } = removeBotAdminFromData(setupData, 123)
  assert.equal(status, 'removed')
})
