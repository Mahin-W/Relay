// coverageAtomic.test.js — BH.05 + E2 (1.20)
// Tests: atomic markCovered (first-writer-wins) and role validation on coverage confirm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockDB, MockBot } from '../helpers/mocks.js'
import { handleCoverageConfirmation } from '../../coverage/confirmationHandler.js'

// ── BH.05: atomic markCovered ──────────────────────────────────────────────

await test('BH.05: concurrent markCovered — exactly one returns truthy, one returns null', async () => {
  const db = new MockDB()
  const req = await db.saveRequest('-100', 'Test Group', 'Saturday Dinner', 'Alice')

  const [r1, r2] = await Promise.all([
    db.markCovered(req.id, 'Bob'),
    db.markCovered(req.id, 'Carol'),
  ])

  // Exactly one must win, one must return null
  const truthy = [r1, r2].filter(Boolean)
  const nulls = [r1, r2].filter(r => r === null)
  assert.equal(truthy.length, 1, `Expected exactly 1 winner, got ${truthy.length}`)
  assert.equal(nulls.length, 1, `Expected exactly 1 null return, got ${nulls.length}`)

  // The final DB state should have exactly one covered_by
  const final = db.coverageRequests.find(r => r.id === req.id)
  assert.equal(final.status, 'covered')
  assert.ok(['Bob', 'Carol'].includes(final.covered_by), `Unexpected covered_by: ${final.covered_by}`)
})

await test('BH.05: 10 concurrent markCovered — exactly 1 wins', async () => {
  const db = new MockDB()
  const req = await db.saveRequest('-100', 'Test Group', 'Sunday Brunch', 'Alice')

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => db.markCovered(req.id, `Person${i}`))
  )

  const winners = results.filter(Boolean)
  const losers = results.filter(r => r === null)
  assert.equal(winners.length, 1, `Expected 1 winner, got ${winners.length}`)
  assert.equal(losers.length, 9, `Expected 9 nulls, got ${losers.length}`)

  const final = db.coverageRequests.find(r => r.id === req.id)
  assert.equal(final.status, 'covered')
})

await test('BH.05: markCovered on already-covered request returns null', async () => {
  const db = new MockDB()
  const req = await db.saveRequest('-100', 'Test Group', 'Lunch', 'Alice')

  const first = await db.markCovered(req.id, 'Bob')
  assert.ok(first, 'First call should succeed')

  const second = await db.markCovered(req.id, 'Carol')
  assert.equal(second, null, 'Second call on already-covered request must return null')

  const final = db.coverageRequests.find(r => r.id === req.id)
  assert.equal(final.covered_by, 'Bob', 'First winner must be preserved')
})

// ── E2 (1.20): role validation on coverage confirm ─────────────────────────

function makeMsg({ userId = 1001, firstName = 'Jordan', chatId = '-100' } = {}) {
  return {
    chat: { id: chatId, type: 'supergroup', title: 'Test Group' },
    from: { id: userId, first_name: firstName },
    text: 'I can cover',
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
  }
}

function makeDbWithRoleCheck({ volunteerRole = null, requiredRoles = ['Cook'], crossTraining = [], managerDmChatId = '9001' } = {}) {
  const db = new MockDB()

  // Seed a coverage request (already open)
  const req = {
    id: db._nextId(),
    group_id: '-100',
    group_name: 'Test Group',
    shift_description: 'Friday Dinner',
    requested_by: 'Alice',
    requester_telegram_id: '9999',
    matched_shift_id: 42,
    week_start: '2025-02-03',
    status: 'open',
    covered_by: null,
    created_at: new Date().toISOString(),
    manager_approved_volunteers: [],
  }
  db.coverageRequests.push(req)

  // Seed volunteer staff
  db.staff.push({
    id: db._nextId(),
    group_id: '-100',
    name: 'Jordan',
    role: volunteerRole,
    cross_training: crossTraining,
    dm_chat_id: 1001,
    user_id: 1001,
    active: true,
  })

  // Override db methods used by confirmationHandler
  db.getOpenRequest = async (groupId) =>
    db.coverageRequests.find(r => r.group_id === String(groupId) && r.status === 'open') ?? null

  db.getShiftRequirements = async (_shiftId) =>
    requiredRoles.map(role => ({ role, count: 1 }))

  db.getStaffForGroup = async (_groupId) => db.staff

  db.getManagerDmChatId = async (_groupId) => managerDmChatId

  return db
}

await test('E2/1.20: volunteer with null role is blocked — markCovered not called, manager DMed', async () => {
  const db = makeDbWithRoleCheck({ volunteerRole: null, requiredRoles: ['Cook'], managerDmChatId: '9001' })
  const bot = new MockBot()
  let markCoveredCalled = false
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (...args) => {
    markCoveredCalled = true
    return origMarkCovered(...args)
  }

  const msg = makeMsg({ userId: 1001, firstName: 'Jordan', chatId: '-100' })
  await handleCoverageConfirmation(bot, msg, { person: 'Jordan' }, db)

  assert.equal(markCoveredCalled, false, 'markCovered must NOT be called when volunteer has no role')

  // Volunteer should be told to ask for role assignment
  const volunteerDMs = bot.sentMessages.filter(m => String(m.chatId) === '1001' || String(m.chatId) === '-100')
  const hasRoleMsg = volunteerDMs.some(m => /role/i.test(m.text))
  assert.ok(hasRoleMsg, `Expected role message to volunteer, got: ${volunteerDMs.map(m => m.text).join(' | ')}`)

  // Manager should be notified
  const managerDMs = bot.sentMessages.filter(m => String(m.chatId) === '9001')
  assert.ok(managerDMs.length > 0, 'Manager must be DMed when volunteer has no role')
})

await test('E2/1.20: volunteer with mismatched role is blocked — manager DMed', async () => {
  const db = makeDbWithRoleCheck({ volunteerRole: 'Server', requiredRoles: ['Cook'], crossTraining: [], managerDmChatId: '9001' })
  const bot = new MockBot()
  let markCoveredCalled = false
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (...args) => {
    markCoveredCalled = true
    return origMarkCovered(...args)
  }

  const msg = makeMsg({ userId: 1001, firstName: 'Jordan', chatId: '-100' })
  await handleCoverageConfirmation(bot, msg, { person: 'Jordan' }, db)

  assert.equal(markCoveredCalled, false, 'markCovered must NOT be called for role mismatch without manager approval')

  const managerDMs = bot.sentMessages.filter(m => String(m.chatId) === '9001')
  assert.ok(managerDMs.length > 0, 'Manager must be DMed about role mismatch')

  const mismatchMsg = bot.sentMessages.some(m => /Server|Cook|role/i.test(m.text))
  assert.ok(mismatchMsg, 'At least one message should mention the role mismatch')
})

await test('E2/1.20: volunteer with matching role proceeds normally', async () => {
  const db = makeDbWithRoleCheck({ volunteerRole: 'Cook', requiredRoles: ['Cook'], managerDmChatId: '9001' })
  const bot = new MockBot()
  let markCoveredCalled = false
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (...args) => {
    markCoveredCalled = true
    return origMarkCovered(...args)
  }

  const msg = makeMsg({ userId: 1001, firstName: 'Jordan', chatId: '-100' })
  await handleCoverageConfirmation(bot, msg, { person: 'Jordan' }, db)

  assert.equal(markCoveredCalled, true, 'markCovered MUST be called when role matches')
})

await test('E2/1.20: cross-trained volunteer is allowed to cover', async () => {
  const db = makeDbWithRoleCheck({ volunteerRole: 'Server', requiredRoles: ['Cook'], crossTraining: ['Cook'], managerDmChatId: '9001' })
  const bot = new MockBot()
  let markCoveredCalled = false
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (...args) => {
    markCoveredCalled = true
    return origMarkCovered(...args)
  }

  const msg = makeMsg({ userId: 1001, firstName: 'Jordan', chatId: '-100' })
  await handleCoverageConfirmation(bot, msg, { person: 'Jordan' }, db)

  assert.equal(markCoveredCalled, true, 'markCovered MUST be called when volunteer is cross-trained for the required role')
})

await test('E2/1.20: manager pre-approved volunteer bypasses role check', async () => {
  const db = makeDbWithRoleCheck({ volunteerRole: 'Server', requiredRoles: ['Cook'], crossTraining: [], managerDmChatId: '9001' })
  // Add manager pre-approval
  db.coverageRequests[0].manager_approved_volunteers = ['Jordan']
  const bot = new MockBot()
  let markCoveredCalled = false
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (...args) => {
    markCoveredCalled = true
    return origMarkCovered(...args)
  }

  const msg = makeMsg({ userId: 1001, firstName: 'Jordan', chatId: '-100' })
  await handleCoverageConfirmation(bot, msg, { person: 'Jordan' }, db)

  assert.equal(markCoveredCalled, true, 'markCovered MUST be called when manager pre-approved the volunteer')
})

// ── P1-25: concurrent confirmations — loser must not post to group ─────────

await test('P1-25: second concurrent confirmation gets DM only, group sees exactly one covered message', async () => {
  const GROUP_ID = '-100'
  const BOB_DM = '2001'
  const CAROL_DM = '3001'

  // Shared DB with two staff members that have DM chat IDs
  const db = new MockDB()
  const req = await db.saveRequest(GROUP_ID, 'Test Group', 'Saturday Dinner', 'Alice')

  // Add dm_chat_id resolution — confirmationHandler uses msg.from?.id for DMs
  // We test via two sequential calls: Bob wins, Carol loses.

  // Override markCovered so the second call returns null (simulating real atomic race)
  let callCount = 0
  const origMarkCovered = db.markCovered.bind(db)
  db.markCovered = async (id, coveredBy) => {
    callCount++
    if (callCount === 1) return origMarkCovered(id, coveredBy)   // Bob wins
    return null  // Carol loses
  }

  // Also expose getOpenRequest so both calls see the same open request
  db.getOpenRequest = async (groupId) =>
    db.coverageRequests.find(r => r.group_id === String(groupId) && r.status === 'open') ?? req

  const bot = new MockBot()

  // Bob's message — winner
  const bobMsg = {
    chat: { id: GROUP_ID, type: 'supergroup', title: 'Test Group' },
    from: { id: 2001, first_name: 'Bob' },
    text: 'I can cover',
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
  }

  // Carol's message — loser
  const carolMsg = {
    chat: { id: GROUP_ID, type: 'supergroup', title: 'Test Group' },
    from: { id: 3001, first_name: 'Carol' },
    text: 'I can cover',
    message_id: 2,
    date: Math.floor(Date.now() / 1000),
  }

  await handleCoverageConfirmation(bot, bobMsg, { person: 'Bob' }, db)
  await handleCoverageConfirmation(bot, carolMsg, { person: 'Carol' }, db)

  // The group should receive exactly ONE "covered/Covered/✅" message (from Bob winning)
  const groupMsgs = bot.messagesTo(GROUP_ID)
  const coveredMsgs = groupMsgs.filter(m =>
    /covered|✅|Shift Covered/i.test(m.text)
  )
  assert.equal(coveredMsgs.length, 1, `Group should see exactly 1 covered message, got ${coveredMsgs.length}:\n${groupMsgs.map(m => m.text).join('\n---\n')}`)

  // Carol's loser message must be sent as a DM to Carol (chatId === Carol's userId)
  const carolDMs = bot.messagesTo(String(carolMsg.from.id))
  assert.ok(carolDMs.length > 0, 'Carol should receive a DM when she loses the race')
  const carolDMText = carolDMs.map(m => m.text).join(' ')
  assert.ok(
    /covered by someone else|just covered|already covered/i.test(carolDMText),
    `Carol's DM should mention "covered by someone else", got: ${carolDMText}`
  )

  // The group must NOT see a second "already covered" or duplicate message from Carol's losing path
  const groupNonCoveredMsgs = groupMsgs.filter(m =>
    /already covered|someone else/i.test(m.text)
  )
  assert.equal(groupNonCoveredMsgs.length, 0, `No "already covered" messages should go to the group, got:\n${groupNonCoveredMsgs.map(m => m.text).join('\n---\n')}`)
})
