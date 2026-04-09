import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handleCoverageRequest, handleCoverageConfirmation } from '../../handleCoverage.js'
import { MockBot, MockDB, makeMockDb, makeMsg, makeGroupMsg, OutputVerifier } from '../helpers/mocks.js'

const GROUP_ID = '-100'
const SHIFT = { id: 1, name: 'Friday Morning', day_of_week: 'Friday', start_time: '8:00 AM', end_time: '12:00 PM', low_confidence: false }

// ── handleCoverageRequest ────────────────────────────────────────────────────

test('posts coverage request message to group', async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  const intent = {
    type: 'coverage_request',
    shift: 'friday morning',
    person: 'Alice',
    _preResolvedShift: SHIFT,
    _preResolvedWeekStart: '2025-04-11',
  }
  const msg = makeMsg({ text: "I can't make friday morning", firstName: 'Alice', chatId: GROUP_ID })

  await handleCoverageRequest(bot, msg, intent, db)

  const groupMsgs = bot.messagesTo(GROUP_ID)
  assert.ok(groupMsgs.length >= 1, 'should have sent at least 1 group message')
  assert.ok(groupMsgs[0].text.includes('Coverage'), `expected Coverage in message, got: ${groupMsgs[0].text}`)
})

test('DMs registered staff when members exist', async () => {
  const bot = new MockBot()
  const STAFF_DM_ID = '9001'
  const db = makeMockDb({
    getGroupMembersWithDm: async () => [{ userId: 2001, firstName: 'Bob', dmChatId: STAFF_DM_ID }],
  })
  const intent = {
    type: 'coverage_request',
    shift: 'friday morning',
    person: 'Alice',
    _preResolvedShift: SHIFT,
    _preResolvedWeekStart: '2025-04-11',
  }
  const msg = makeMsg({ firstName: 'Alice', userId: 1001, chatId: GROUP_ID })

  await handleCoverageRequest(bot, msg, intent, db)

  const staffMsgs = bot.messagesTo(STAFF_DM_ID)
  assert.ok(staffMsgs.length >= 1, 'should DM registered staff')
  assert.ok(staffMsgs[0].text.includes('Coverage'), `expected Coverage Needed in DM`)
})

test('does not DM the requester themselves', async () => {
  const bot = new MockBot()
  const REQUESTER_DM = '1001'
  const db = makeMockDb({
    getGroupMembersWithDm: async () => [{ userId: 1001, firstName: 'Alice', dmChatId: REQUESTER_DM }],
  })
  const intent = {
    type: 'coverage_request',
    shift: 'friday morning',
    person: 'Alice',
    _preResolvedShift: SHIFT,
    _preResolvedWeekStart: '2025-04-11',
  }
  const msg = makeMsg({ firstName: 'Alice', userId: 1001, chatId: GROUP_ID })

  await handleCoverageRequest(bot, msg, intent, db)

  const requesterMsgs = bot.messagesTo(REQUESTER_DM)
  assert.equal(requesterMsgs.length, 0, 'should not DM the person requesting coverage')
})

test('no DMs sent when getGroupMembersWithDm returns empty array', async () => {
  const db = {
    saveRequest: async () => ({ id: 1, shift_description: 'Morning', requested_by: 'Alice', status: 'open' }),
    getGroupMembersWithDm: async () => [],
    saveOutreach: async () => {},
    updateCoverageRequestShift: async () => {},
    getShiftRoster: async () => [],
    getOnCallStaff: async () => [],
    recordEvent: async () => {},
  }
  const mockBotLocal = { messages: [], sendMessage: async (id, text) => mockBotLocal.messages.push({ chatId: id, text }) }
  const msg = {
    chat: { id: -500, title: 'Test Group', type: 'group' },
    from: { id: 1001, first_name: 'Alice' },
    text: 'can someone cover my morning shift',
  }
  const intent = {
    type: 'coverage_request', shift: 'Morning', person: 'Alice',
    _preResolvedShift: { id: 'shift-1', name: 'Morning', day_of_week: 'Monday', start_time: '9:00', end_time: '17:00' },
    _preResolvedWeekStart: '2026-04-13',
  }
  await handleCoverageRequest(mockBotLocal, msg, intent, db)
  const dms = mockBotLocal.messages.filter(m => m.chatId !== msg.chat.id)
  assert.strictEqual(dms.length, 0, 'No DMs should be sent when staff list is empty')
})

// ── handleCoverageConfirmation ───────────────────────────────────────────────

test('confirmation posts covered message when open request exists', async () => {
  const bot = new MockBot()
  const db = makeMockDb({
    getOpenRequest: async () => ({
      id: 'req-1',
      shift_description: 'friday morning',
      requested_by: 'Alice',
      group_id: GROUP_ID,
      matched_shift_id: null,
      week_start: null,
    }),
    markCovered: async () => true,
  })
  const intent = { type: 'coverage_confirmation', person: 'Bob' }
  const msg = makeMsg({ firstName: 'Bob', userId: 2001, chatId: GROUP_ID })

  await handleCoverageConfirmation(bot, msg, intent, db)

  const msgs = bot.messagesTo(GROUP_ID)
  assert.ok(msgs.some(m => m.text.includes('Covered') || m.text.includes('covered')), 'expected covered message')
})

test('confirmation rejected when no open request', async () => {
  const bot = new MockBot()
  const db = makeMockDb({ getOpenRequest: async () => null })
  const intent = { type: 'coverage_confirmation', person: 'Bob' }
  const msg = makeMsg({ firstName: 'Bob', chatId: GROUP_ID })

  await handleCoverageConfirmation(bot, msg, intent, db)

  const msgs = bot.messagesTo(GROUP_ID)
  assert.ok(msgs.some(m => m.text.includes('No open')), 'expected "No open" message')
})

test("can't cover own shift", async () => {
  const bot = new MockBot()
  const db = makeMockDb({
    getOpenRequest: async () => ({
      id: 'req-1',
      shift_description: 'friday morning',
      requested_by: 'Alice',
      group_id: GROUP_ID,
      matched_shift_id: null,
    }),
  })
  const intent = { type: 'coverage_confirmation', person: 'Alice' }
  const msg = makeMsg({ firstName: 'Alice', chatId: GROUP_ID })

  await handleCoverageConfirmation(bot, msg, intent, db)

  const msgs = bot.messagesTo(GROUP_ID)
  assert.ok(msgs.some(m => m.text.includes("can't cover your own")), 'expected self-cover rejection')
})

test('self-cover NOT blocked when same name but different telegram ID', async () => {
  const bot = new MockBot()
  const db = makeMockDb({
    getOpenRequest: async () => ({
      id: 'req-2',
      shift_description: 'friday morning',
      requested_by: 'Alex',
      requester_telegram_id: 9001,  // original requester's ID
      group_id: GROUP_ID,
      matched_shift_id: null,
    }),
    markCovered: async () => true,
  })
  // Different person also named Alex (different Telegram ID)
  const intent = { type: 'coverage_confirmation', person: 'Alex' }
  const msg = makeMsg({ firstName: 'Alex', userId: 9002, chatId: GROUP_ID })  // different ID

  await handleCoverageConfirmation(bot, msg, intent, db)

  const msgs = bot.messagesTo(GROUP_ID)
  assert.ok(
    !msgs.some(m => m.text.includes("can't cover your own")),
    'different ID should NOT be blocked even with same name'
  )
  assert.ok(
    msgs.some(m => m.text.includes('Covered') || m.text.includes('covered')),
    'volunteer with same name but different ID should succeed'
  )
})

test('self-cover blocked when same telegram ID', async () => {
  const bot = new MockBot()
  const db = makeMockDb({
    getOpenRequest: async () => ({
      id: 'req-3',
      shift_description: 'friday morning',
      requested_by: 'Alice',
      requester_telegram_id: 1001,
      group_id: GROUP_ID,
      matched_shift_id: null,
    }),
  })
  const intent = { type: 'coverage_confirmation', person: 'Alice' }
  const msg = makeMsg({ firstName: 'Alice', userId: 1001, chatId: GROUP_ID })  // same ID

  await handleCoverageConfirmation(bot, msg, intent, db)

  const msgs = bot.messagesTo(GROUP_ID)
  assert.ok(msgs.some(m => m.text.includes("can't cover your own")), 'same telegram ID should be blocked')
})

// ── Full-cycle integration test ───────────────────────────────────────────────

describe('Coverage — full request → confirmation cycle', () => {

  test('request in group then volunteer in group → DB updated, messages correct', async () => {
    const bot = new MockBot()
    const db = new MockDB()
    const verifier = new OutputVerifier(bot, db)

    const groupId = '-100555666'
    const SHIFT = {
      id: 7,
      name: 'Saturday Lunch',
      day_of_week: 'Saturday',
      start_time: '11:00 AM',
      end_time: '4:00 PM',
      low_confidence: false,
    }

    // Seed two staff members so handleCoverageRequest can DM them
    db.seedStaff({ id: 11111, group_id: groupId, name: 'Mike', dm_chat_id: '11111', role: 'Server' })
    db.seedStaff({ id: 22222, group_id: groupId, name: 'Sarah', dm_chat_id: '22222', role: 'Server' })

    // STEP 1: Mike requests coverage in group
    const requestMsg = makeGroupMsg({
      text: "can anyone cover my saturday lunch",
      from: { id: 11111, first_name: 'Mike' },
      chat: { id: groupId, type: 'group', title: 'Test Kitchen' },
    })

    await handleCoverageRequest(bot, requestMsg, {
      type: 'coverage_request',
      shift: 'Saturday lunch',
      person: 'Mike',
      _preResolvedShift: SHIFT,
      _preResolvedWeekStart: '2025-01-06',
    }, db)

    // Verify group message was posted
    verifier.verifyCoverageRequest(groupId, 'Saturday', 'Mike')

    // Sarah should be DM'd; Mike should not DM himself
    const sarahDMs = bot.messagesTo('22222')
    const mikeDMs = bot.messagesTo('11111')
    assert.ok(sarahDMs.length > 0, 'Sarah should receive a DM about coverage')
    assert.equal(mikeDMs.length, 0, 'Mike should not be DM\'d about his own shift')

    // STEP 2: Sarah says "I can cover" in the group
    bot.clear()

    const volunteerMsg = makeGroupMsg({
      text: 'I can cover',
      from: { id: 22222, first_name: 'Sarah' },
      chat: { id: groupId, type: 'group', title: 'Test Kitchen' },
    })

    await handleCoverageConfirmation(bot, volunteerMsg, {
      type: 'coverage_confirmation',
      person: 'Sarah',
    }, db)

    // Verify confirmation message
    verifier.verifyCoverageConfirmed(groupId, 'Sarah', 'Saturday')

    // DB should show request covered by Sarah
    const req = db.coverageRequests.find(r => r.status === 'covered')
    assert.ok(req, 'Request should be marked covered')
    assert.equal(req.covered_by, 'Sarah', 'Covered by Sarah')
  })

  test('no open request → volunteer gets a helpful response', async () => {
    const bot = new MockBot()
    const db = new MockDB() // empty — no requests

    const groupId = '-100777888'
    const msg = makeGroupMsg({
      text: 'I can cover',
      from: { id: 12345, first_name: 'Sarah' },
      chat: { id: groupId, type: 'group', title: 'Test Kitchen' },
    })

    await handleCoverageConfirmation(bot, msg, { type: 'coverage_confirmation', person: 'Sarah' }, db)

    const reply = bot.lastMessage(groupId)
    assert.ok(reply, 'Bot should respond to volunteer with no open request')
    assert.ok(
      reply.text.toLowerCase().includes('no') ||
      reply.text.toLowerCase().includes('nothing') ||
      reply.text.includes('👍'),
      `Response should indicate no open request. Got: ${reply.text}`
    )
    // No request should have been created
    assert.equal(db.coverageRequests.filter(r => r.status === 'open').length, 0)
  })

})
