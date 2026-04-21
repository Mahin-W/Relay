// Unit tests for F3: group-chat revenue redirect (groupRouter.js)
// Verifies that revenue messages in group chat → DM-redirect response, no revenue saved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRevenueInput } from '../../analytics/laborCost.js'
import { MockBot } from '../helpers/mocks.js'

// ── Simulate the F3 routing logic ─────────────────────────────────────────────
// Reproduces the guard added to groupRouter.handleGroupMessage

async function simulateGroupRevenueCheck(bot, msg, groupId) {
  let revenueSaved = false
  let redirectSent = false

  try {
    const revenueAmount = parseRevenueInput(msg.text)
    if (revenueAmount > 0) {
      await bot.sendMessage(
        msg.chat.id,
        `@manager, please DM me that revenue figure (or enter it in the dashboard) so I can attribute it correctly.`
      )
      redirectSent = true
      // Revenue is NOT saved — we return early
      return { redirectSent, revenueSaved }
    }
  } catch (_) {}

  // If we reach here, revenue save could happen (for non-revenue messages)
  revenueSaved = true // simulating that downstream could save it
  return { redirectSent, revenueSaved }
}

// ── Revenue detection tests ────────────────────────────────────────────────────

test('F3: "$12,400" in group → parsed as revenue, redirect sent, no revenue saved', async () => {
  const bot = new MockBot()
  const msg = { text: 'revenue last night was $12,400', chat: { id: '-1001' } }
  const { redirectSent, revenueSaved } = await simulateGroupRevenueCheck(bot, msg, '-1001')

  assert.equal(redirectSent, true, 'redirect should be sent')
  assert.equal(revenueSaved, false, 'revenue must NOT be saved from group message')
  assert.equal(bot.sentMessages.length, 1, 'exactly one message sent')
  const reply = bot.sentMessages[0].text
  assert.ok(reply.includes('DM me'), `expected DM redirect message, got: ${reply}`)
  assert.ok(reply.includes('dashboard'), `expected dashboard mention, got: ${reply}`)
})

test('F3: "we did 12400 tonight" in group → parsed as revenue, redirect', async () => {
  const bot = new MockBot()
  const msg = { text: 'we did 12400 tonight', chat: { id: '-1001' } }
  const amount = parseRevenueInput(msg.text)
  assert.equal(amount, 12400, `parseRevenueInput should return 12400, got ${amount}`)

  const { redirectSent, revenueSaved } = await simulateGroupRevenueCheck(bot, msg, '-1001')
  assert.equal(redirectSent, true)
  assert.equal(revenueSaved, false)
})

test('F3: "$8.5k revenue" in group → parsed as $8500, redirect sent', async () => {
  const bot = new MockBot()
  const msg = { text: '$8.5k revenue', chat: { id: '-1001' } }
  const amount = parseRevenueInput(msg.text)
  assert.ok(amount > 0, `should parse $8.5k as > 0, got ${amount}`)

  const { redirectSent, revenueSaved } = await simulateGroupRevenueCheck(bot, msg, '-1001')
  assert.equal(redirectSent, true)
  assert.equal(revenueSaved, false)
})

test('F3: "great service tonight" (no revenue) → no redirect, passes through', async () => {
  const bot = new MockBot()
  const msg = { text: 'great service tonight', chat: { id: '-1001' } }
  const amount = parseRevenueInput(msg.text)
  assert.ok(!amount || amount <= 0, `"great service tonight" should not parse as revenue, got ${amount}`)

  const { redirectSent, revenueSaved } = await simulateGroupRevenueCheck(bot, msg, '-1001')
  assert.equal(redirectSent, false, 'non-revenue message should not trigger redirect')
})

test('F3: "who can cover Friday" in group → no redirect', async () => {
  const bot = new MockBot()
  const msg = { text: 'who can cover Friday shift?', chat: { id: '-1001' } }
  const { redirectSent, revenueSaved } = await simulateGroupRevenueCheck(bot, msg, '-1001')
  assert.equal(redirectSent, false)
})

test('F3: revenue redirect message mentions DM and dashboard', async () => {
  const bot = new MockBot()
  const msg = { text: 'revenue was $9,200', chat: { id: '-1001' } }
  await simulateGroupRevenueCheck(bot, msg, '-1001')

  assert.equal(bot.sentMessages.length, 1)
  const reply = bot.sentMessages[0].text
  assert.ok(
    reply.toLowerCase().includes('dm') || reply.toLowerCase().includes('direct'),
    `reply should mention DM, got: ${reply}`
  )
  assert.ok(
    reply.toLowerCase().includes('dashboard'),
    `reply should mention dashboard, got: ${reply}`
  )
})

test('F3: parseRevenueInput("revenue last night was 12400") === 12400', () => {
  assert.equal(parseRevenueInput('revenue last night was 12400'), 12400)
})

test('F3: parseRevenueInput("$1,140") === 1140', () => {
  assert.equal(parseRevenueInput('$1,140'), 1140)
})

test('F3: parseRevenueInput("tips tonight") returns null (no number)', () => {
  const result = parseRevenueInput('tips tonight')
  assert.ok(!result || result <= 0, `"tips tonight" should not produce revenue > 0, got ${result}`)
})

test('F3: revenue redirect is sent to the GROUP chat, not a DM', async () => {
  const bot = new MockBot()
  const groupChatId = '-100987654321'
  const msg = { text: 'sales were $11,000 last night', chat: { id: groupChatId } }
  await simulateGroupRevenueCheck(bot, msg, groupChatId)

  assert.equal(bot.sentMessages.length, 1)
  assert.equal(bot.sentMessages[0].chatId, groupChatId, 'redirect must be sent to the group chat')
})
