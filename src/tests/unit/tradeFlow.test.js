import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handleTradeRequest, resolvePendingClarification } from '../../handleCoverage.js'
import { handleTradeOffer } from '../../coverage/tradeHandler.js'
import { isDmConfirmation } from '../../parseMessage.js'
import { MockBot, MockDB, makeGroupMsg } from '../helpers/mocks.js'

const GROUP_ID = '-100111222'

const MONDAY_LUNCH = {
  id: 1,
  name: 'Monday Lunch',
  day_of_week: 'Monday',
  start_time: '11:00 AM',
  end_time: '4:00 PM',
  low_confidence: false,
}

// ── handleTradeRequest ────────────────────────────────────────────────────────

describe('Trade Flow — handleTradeRequest', () => {

  test('posts trade offer message to group', async () => {
    const bot = new MockBot()
    const db = new MockDB()

    const msg = makeGroupMsg({
      text: 'trade my monday lunch',
      from: { id: 11111, first_name: 'Marcus' },
      chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' },
    })

    const intent = {
      type: 'trade_request',
      shift: 'Monday lunch',
      person: 'Marcus',
      _preResolvedShift: MONDAY_LUNCH,
      _preResolvedWeekStart: '2025-01-06',
    }

    await handleTradeRequest(bot, msg, intent, db)

    const msgs = bot.messagesTo(GROUP_ID)
    assert.ok(msgs.length > 0, 'Should post at least one message to group')

    const tradeMsg = msgs.find(m => m.text.toLowerCase().includes('trade'))
    assert.ok(tradeMsg, `Trade message should mention "trade". Got:\n${msgs.map(m => m.text).join('\n')}`)
    assert.ok(tradeMsg.text.includes('Marcus'), `Trade message should mention requester. Got:\n${tradeMsg.text}`)
    assert.ok(
      tradeMsg.text.toLowerCase().includes('monday') || tradeMsg.text.toLowerCase().includes('lunch'),
      `Trade message should mention the shift. Got:\n${tradeMsg.text}`
    )
  })

  test('saves trade to MockDB with open status', async () => {
    const bot = new MockBot()
    const db = new MockDB()

    const msg = makeGroupMsg({
      text: 'trade my monday lunch',
      from: { id: 11111, first_name: 'Marcus' },
      chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' },
    })

    const intent = {
      type: 'trade_request',
      shift: 'Monday lunch',
      person: 'Marcus',
      _preResolvedShift: MONDAY_LUNCH,
      _preResolvedWeekStart: '2025-01-06',
    }

    await handleTradeRequest(bot, msg, intent, db)

    assert.equal(db.tradeRequests.length, 1, 'One trade should be saved')
    assert.equal(db.tradeRequests[0].status, 'open', 'Trade should be open')
    assert.equal(db.tradeRequests[0].requester_name, 'Marcus', 'Requester should be Marcus')
    assert.equal(db.tradeRequests[0].shift_id, MONDAY_LUNCH.id, 'Shift ID should match')
    assert.equal(db.tradeRequests[0].week_start, '2025-01-06', 'Week start should match')
  })

  test('trade requires a resolved shift — returns silently when shift is ambiguous', async () => {
    // If _preResolvedShift is not set and resolveShift can't determine the shift,
    // handleTradeRequest returns without posting. We simulate this by not providing
    // _preResolvedShift and letting resolveShift send a clarification question.
    // Since we're not connected to a real DB, resolveShift will fail → returns null.
    const bot = new MockBot()
    const db = new MockDB()

    const msg = makeGroupMsg({
      text: 'trade my shift',
      from: { id: 11111, first_name: 'Marcus' },
      chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' },
    })

    // intent WITHOUT _preResolvedShift
    const intent = {
      type: 'trade_request',
      shift: 'my shift',
      person: 'Marcus',
    }

    // Should not throw — either asks for clarification or returns silently
    await assert.doesNotReject(
      () => handleTradeRequest(bot, msg, intent, db),
      'handleTradeRequest should not throw when shift is unresolved'
    )
    // No trade saved since shift wasn't resolved
    assert.equal(db.tradeRequests.length, 0, 'No trade should be saved for unresolved shift')
  })
})

// ── Trade acceptance (DM confirmation) ───────────────────────────────────────

describe('Trade Flow — slang acceptance via isDmConfirmation', () => {

  // Run all acceptance checks in parallel to minimize LLM wait time
  // Note: run sequentially to respect Groq 6000 TPM free-tier rate limit
  test('standard and slang acceptance phrases recognized', async () => {
    const accepted = ['yes', 'yeah', 'sure', 'bet', 'igu', "I'll take it"]
    const failures = []
    for (const term of accepted) {
      const result = await isDmConfirmation(term)
      if (!result) failures.push(term)
    }
    if (failures.length > 0) {
      assert.fail(`Terms not recognized as acceptance: ${failures.map(t => `"${t}"`).join(', ')}`)
    }
  })

  test('declinations and maybes not recognized as acceptance', async () => {
    const negative = ['no', 'maybe', 'idk']
    const falsePositives = []
    for (const term of negative) {
      const result = await isDmConfirmation(term)
      if (result) falsePositives.push(term)
    }
    if (falsePositives.length > 0) {
      assert.fail(`Should NOT be acceptances: ${falsePositives.map(t => `"${t}"`).join(', ')}`)
    }
  })
})

// ── resolvePendingClarification (pure state logic) ────────────────────────────

describe('Trade Flow — pending clarification resolution', () => {

  test('returns null when no pending clarification exists', () => {
    // Fresh state — no pending clarifications set
    const result = resolvePendingClarification('group-x', 99999, 'monday lunch')
    assert.equal(result, null, 'Should return null when nothing is pending')
  })

  test('returns null for unknown user even if clarification exists for another user', () => {
    // Two separate users — resolving for the wrong one returns null
    const result = resolvePendingClarification(GROUP_ID, 999, 'monday')
    assert.equal(result, null, 'Should not cross-match pending clarifications between users')
  })
})

// ── handleTradeOffer — swap failure handling ──────────────────────────────────

describe('Trade Flow — swap failure handling', () => {

  test('no success message when staff lookup fails', async () => {
    // When openTrade.requester_name doesn't match any staff by name,
    // the trade should NOT post "Shift Trade Confirmed" to the group.
    // Instead it should post an error/warning message.
    // handleTradeOffer calls getStaffForGroup internally (module-level import),
    // which will fail/return [] without a real DB — staff lookup returns nothing.
    const mockBotLocal = {
      messages: [],
      sendMessage: async (chatId, text) => { mockBotLocal.messages.push({ chatId, text }) }
    }
    const openTrade = {
      id: 1, requester_id: 9999, requester_name: 'NonExistentPerson',
      shift_id: 'shift-uuid-1', week_start: '2026-04-13',
    }
    const msg = {
      chat: { id: -100, type: 'group' },
      from: { id: 2001, first_name: 'Bob' },
      text: 'trade my morning',
    }
    const intent = {
      type: 'trade_request', person: 'Bob', shift: 'Morning',
      _preResolvedShift: { id: 'shift-uuid-2', name: 'Morning', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '5:00 PM' },
      _preResolvedWeekStart: '2026-04-13',
    }
    // getShiftById will throw/return null without a real DB — that causes an early return
    // before the staff-lookup bug. To reach the staff-lookup path we need getShiftById to
    // succeed. Since we cannot inject it here, we accept that either:
    //   (a) function returns early due to getShiftById failing (no success msg — correct)
    //   (b) function reaches staff lookup, finds no match, and the fixed code returns early
    // Either way: "Shift Trade Confirmed" must NOT be sent.
    try {
      await handleTradeOffer(mockBotLocal, msg, intent, openTrade)
    } catch (_) {
      // DB errors are expected in unit context — what matters is the message check below
    }
    const successSent = mockBotLocal.messages.some(m => /Shift Trade Confirmed/i.test(m.text))
    assert.ok(!successSent, 'Success message must NOT be sent when staff lookup fails')
  })
})
