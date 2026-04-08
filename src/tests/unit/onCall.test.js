import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'
import { handleOnCallOffer } from '../../oncall/handleOnCall.js'
import { handleCoverageRequest } from '../../coverage/requestHandler.js'

// ── Mock DB factories ─────────────────────────────────────────────────────────

function makeOnCallDb(overrides = {}) {
  const records = []
  return {
    records,
    getStaffMember: async (userId) => ({ id: userId, name: 'Alice' }),
    saveOnCall: async (staffId, groupId, weekStart, days, allWeek) => {
      const idx = records.findIndex(r => r.staff_id === staffId && r.week_start === weekStart)
      if (idx !== -1) {
        records[idx] = { ...records[idx], days, all_week: allWeek }
        return records[idx]
      }
      const row = { staff_id: staffId, group_id: groupId, week_start: weekStart, days, all_week: allWeek }
      records.push(row)
      return row
    },
    getOnCallStaff: async (groupId, weekStart) =>
      records.filter(r => r.group_id === groupId && r.week_start === weekStart),
    clearWeekOnCall: async (groupId, weekStart) => {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].group_id === groupId && records[i].week_start === weekStart) {
          records.splice(i, 1)
        }
      }
    },
    ...overrides,
  }
}

const FAKE_SHIFT = {
  id: 'shift-1',
  name: 'Friday Close',
  day_of_week: 'Friday',
  start_time: '5:00 PM',
  end_time: '11:00 PM',
  low_confidence: false,
}

function makeCoverageDb({ onCallIds = [], groupMembers = [] } = {}) {
  return {
    _shift: FAKE_SHIFT,
    saveRequest: async () => ({ id: 1, shift_description: 'Friday close', requested_by: 'Manager', group_id: '-100' }),
    getOpenRequest: async () => null,
    markCovered: async () => true,
    updateCoverageRequestShift: async () => {},
    getGroupMembersWithDm: async () => groupMembers,
    saveOutreach: async () => {},
    getShiftRoster: async () => [],
    getOnCallStaff: async () => onCallIds.map(id => ({ staff_id: id })),
  }
}

await Promise.all([
  // ── handleOnCallOffer ───────────────────────────────────────────────────────

  test('handleOnCallOffer saves record to on_call table', async () => {
    const bot = new MockBot()
    const db = makeOnCallDb()
    const msg = makeGroupMsg({ from: { id: 1001, first_name: 'Alice' } })
    await handleOnCallOffer(bot, msg, { type: 'on_call_offer', all_week: true, days: [] }, db)
    assert.equal(db.records.length, 1)
    assert.equal(db.records[0].staff_id, 1001)
    assert.equal(db.records[0].all_week, true)
  }),

  test('handleOnCallOffer sends group confirmation with name', async () => {
    const bot = new MockBot()
    const db = makeOnCallDb({ getStaffMember: async () => ({ id: 1002, name: 'Bob' }) })
    const msg = makeGroupMsg({ from: { id: 1002, first_name: 'Bob' } })
    await handleOnCallOffer(bot, msg, { type: 'on_call_offer', all_week: true, days: [] }, db)
    bot.assertSent(msg.chat.id, 'Bob')
  }),

  test('handleOnCallOffer confirmation contains "on call"', async () => {
    const bot = new MockBot()
    const db = makeOnCallDb()
    const msg = makeGroupMsg({ from: { id: 1003, first_name: 'Carol' } })
    await handleOnCallOffer(bot, msg, { type: 'on_call_offer', all_week: true, days: [] }, db)
    const sent = bot.lastMessage()
    assert.ok(sent?.text.toLowerCase().includes('on call'), `Expected "on call" in: ${sent?.text}`)
  }),

  test('handleOnCallOffer silent if staff not found in DB', async () => {
    const bot = new MockBot()
    const db = makeOnCallDb({ getStaffMember: async () => null })
    const msg = makeGroupMsg({ from: { id: 9999, first_name: 'Ghost' } })
    await handleOnCallOffer(bot, msg, { type: 'on_call_offer', all_week: true, days: [] }, db)
    bot.assertSilent()
    assert.equal(db.records.length, 0)
  }),

  test('saveOnCall upserts — second call for same staff/week does not duplicate', async () => {
    const bot = new MockBot()
    const db = makeOnCallDb()
    const msg = makeGroupMsg({ from: { id: 1005, first_name: 'Eve' } })
    const intent = { type: 'on_call_offer', all_week: true, days: [] }
    await handleOnCallOffer(bot, msg, intent, db)
    await handleOnCallOffer(bot, msg, intent, db)
    assert.equal(db.records.length, 1, 'Should only have one record after two calls')
  }),

  // ── getOnCallStaff / clearOnCall ────────────────────────────────────────────

  test('getOnCallStaff returns only records for the correct week', async () => {
    const db = makeOnCallDb()
    db.records.push({ staff_id: 1, group_id: 'g1', week_start: '2025-04-14', all_week: true })
    db.records.push({ staff_id: 2, group_id: 'g1', week_start: '2025-04-21', all_week: true })
    const result = await db.getOnCallStaff('g1', '2025-04-14')
    assert.equal(result.length, 1)
    assert.equal(result[0].staff_id, 1)
  }),

  test('getOnCallStaff returns empty array when none registered', async () => {
    const db = makeOnCallDb()
    const result = await db.getOnCallStaff('g1', '2025-04-14')
    assert.deepEqual(result, [])
  }),

  test('clearOnCall removes all records for that week', async () => {
    const db = makeOnCallDb()
    db.records.push({ staff_id: 1, group_id: 'g1', week_start: '2025-04-14' })
    db.records.push({ staff_id: 2, group_id: 'g1', week_start: '2025-04-14' })
    await db.clearWeekOnCall('g1', '2025-04-14')
    assert.equal(db.records.length, 0)
  }),

  test('clearOnCall does not affect other weeks', async () => {
    const db = makeOnCallDb()
    db.records.push({ staff_id: 1, group_id: 'g1', week_start: '2025-04-14' })
    db.records.push({ staff_id: 2, group_id: 'g1', week_start: '2025-04-21' })
    await db.clearWeekOnCall('g1', '2025-04-14')
    assert.equal(db.records.length, 1)
    assert.equal(db.records[0].week_start, '2025-04-21')
  }),

  // ── Coverage request on-call integration ───────────────────────────────────

  test('coverage request DMs on-call staff with priority message', async () => {
    const bot = new MockBot()
    const db = makeCoverageDb({
      onCallIds: [1001],
      groupMembers: [
        { userId: 1001, firstName: 'Alice', dmChatId: '9001' },
        { userId: 1002, firstName: 'Bob', dmChatId: '9002' },
      ],
    })
    const msg = makeGroupMsg({ from: { id: 9999, first_name: 'Manager' } })
    const intent = {
      type: 'coverage_request',
      shift: 'Friday close',
      person: 'Manager',
      _preResolvedShift: db._shift,
      _preResolvedWeekStart: '2025-04-18',
    }
    await handleCoverageRequest(bot, msg, intent, db)
    const aliceText = bot.messagesTo('9001').map(m => m.text).join(' ')
    assert.ok(
      aliceText.toLowerCase().includes('first dibs') || aliceText.toLowerCase().includes('on call'),
      `Alice (on-call) should get priority message, got: ${aliceText}`
    )
  }),

  test('on-call priority message is different from regular coverage DM', async () => {
    const bot = new MockBot()
    const db = makeCoverageDb({
      onCallIds: [1001],
      groupMembers: [
        { userId: 1001, firstName: 'Alice', dmChatId: '9001' },
        { userId: 1002, firstName: 'Bob', dmChatId: '9002' },
      ],
    })
    const msg = makeGroupMsg({ from: { id: 9999, first_name: 'Manager' } })
    const intent = {
      type: 'coverage_request',
      shift: 'Friday close',
      person: 'Manager',
      _preResolvedShift: db._shift,
      _preResolvedWeekStart: '2025-04-18',
    }
    await handleCoverageRequest(bot, msg, intent, db)
    const aliceMsg = bot.lastMessage('9001')
    const bobMsg = bot.lastMessage('9002')
    assert.ok(aliceMsg, 'Alice should get a DM')
    assert.ok(bobMsg, 'Bob should get a DM')
    assert.notEqual(aliceMsg.text, bobMsg.text, 'On-call DM should differ from regular DM')
  }),

  test('coverage request still DMs all non-requester staff', async () => {
    const bot = new MockBot()
    const db = makeCoverageDb({
      onCallIds: [1001],
      groupMembers: [
        { userId: 1001, firstName: 'Alice', dmChatId: '9001' },
        { userId: 1002, firstName: 'Bob', dmChatId: '9002' },
        { userId: 1003, firstName: 'Carol', dmChatId: '9003' },
      ],
    })
    const msg = makeGroupMsg({ from: { id: 9999, first_name: 'Manager' } })
    const intent = {
      type: 'coverage_request',
      shift: 'Friday close',
      person: 'Manager',
      _preResolvedShift: db._shift,
      _preResolvedWeekStart: '2025-04-18',
    }
    await handleCoverageRequest(bot, msg, intent, db)
    assert.ok(bot.messagesTo('9001').length > 0, 'Alice should be DM\'d')
    assert.ok(bot.messagesTo('9002').length > 0, 'Bob should be DM\'d')
    assert.ok(bot.messagesTo('9003').length > 0, 'Carol should be DM\'d')
  }),

  test('on-call staff with no dmChatId: skip DM gracefully', async () => {
    const bot = new MockBot()
    const db = makeCoverageDb({
      onCallIds: [1001],
      groupMembers: [
        { userId: 1001, firstName: 'Alice', dmChatId: null },
        { userId: 1002, firstName: 'Bob', dmChatId: '9002' },
      ],
    })
    const msg = makeGroupMsg({ from: { id: 9999, first_name: 'Manager' } })
    const intent = {
      type: 'coverage_request',
      shift: 'Friday close',
      person: 'Manager',
      _preResolvedShift: db._shift,
      _preResolvedWeekStart: '2025-04-18',
    }
    await handleCoverageRequest(bot, msg, intent, db)
    assert.ok(bot.messagesTo('9002').length > 0, 'Bob should still be DM\'d')
  }),
])
