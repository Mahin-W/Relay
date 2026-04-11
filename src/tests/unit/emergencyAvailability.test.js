import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  rankAvailableStaff,
  getAvailableNow,
  formatEmergencyResponse,
  handleEmergencyQuery,
} from '../../intelligence/emergencyAvailability.js'

const mockAllStaff = [
  { id: 1, name: 'Marcus', role_name: 'Chef' },
  { id: 2, name: 'Sarah', role_name: 'Server' },
  { id: 3, name: 'Jake', role_name: 'Server' },
  { id: 4, name: 'Amy', role_name: 'Server' },
]

// Sarah: fast responder (avg 8min, reliable), Jake: slower (avg 25min)
const mockCoverageStats = [
  { name: 'Sarah', avgResponseMinutes: 8, actualReliability: 0.95, confirmationCount: 6, score: 0.9 },
  { name: 'Jake', avgResponseMinutes: 25, actualReliability: 0.7, confirmationCount: 4, score: 0.5 },
]

function makeEmergencyDb(overrides = {}) {
  return {
    getAllStaffForGroup: async () => mockAllStaff,
    getActiveStaffIds: async () => [1],       // Marcus on shift
    getWeeklyHours: async () => ({ 1: 32, 2: 20, 3: 28, 4: 40 }), // Amy at 40hrs
    getCoveredRequests: async () => [],
    getNoShowAfterConfirm: async () => [],
    getManagerGroup: async () => 'group-1',
    getNextUpcomingShift: async () => ({ id: 's1', name: 'Dinner', start_time: '2026-04-11T18:00:00Z' }),
    getGroupMembersWithDm: async () => [
      { userId: 2, firstName: 'Sarah', dmChatId: '2002' },
      { userId: 3, firstName: 'Jake', dmChatId: '2003' },
    ],
    ...overrides,
  }
}

await Promise.all([
  // ── rankAvailableStaff ──
  test('rankAvailableStaff: Sarah ranked above Jake (faster, more reliable)', () => {
    const staff = [
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursThisWeek: 20 },
      { staffId: 3, staffName: 'Jake', roleName: 'Server', hoursThisWeek: 28 },
    ]
    const ranked = rankAvailableStaff(staff, mockCoverageStats)
    assert.equal(ranked[0].staffName, 'Sarah')
    assert.equal(ranked[1].staffName, 'Jake')
    assert.equal(ranked[0].rank, 1)
    assert.equal(ranked[1].rank, 2)
    assert.ok(ranked[0].score > ranked[1].score)
    assert.ok(typeof ranked[0].reason === 'string')
  }),

  test('rankAvailableStaff: no coverage stats → ranked by hours available', () => {
    const staff = [
      { staffId: 3, staffName: 'Jake', roleName: 'Server', hoursThisWeek: 28 },
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursThisWeek: 10 },
    ]
    const ranked = rankAvailableStaff(staff, [])
    // Sarah has fewer hours → higher hoursScore → ranked first (with equal defaults)
    assert.equal(ranked[0].staffName, 'Sarah')
    assert.equal(ranked[1].staffName, 'Jake')
  }),

  test('rankAvailableStaff: empty staff → empty array', () => {
    const ranked = rankAvailableStaff([], mockCoverageStats)
    assert.deepEqual(ranked, [])
  }),

  // ── getAvailableNow ──
  test('getAvailableNow: excludes Marcus (on shift) and Amy (40hrs)', async () => {
    const db = makeEmergencyDb()
    const result = await getAvailableNow('group-1', 's1', new Date(), db)
    const names = result.map(r => r.staffName)
    assert.ok(!names.includes('Marcus'), 'Marcus should be excluded (on shift)')
    assert.ok(!names.includes('Amy'), 'Amy should be excluded (40hrs)')
  }),

  test('getAvailableNow: returns Sarah and Jake', async () => {
    const db = makeEmergencyDb()
    const result = await getAvailableNow('group-1', 's1', new Date(), db)
    const names = result.map(r => r.staffName)
    assert.ok(names.includes('Sarah'))
    assert.ok(names.includes('Jake'))
    assert.equal(result.length, 2)
  }),

  test('getAvailableNow: empty staff → empty array', async () => {
    const db = makeEmergencyDb({
      getAllStaffForGroup: async () => [],
    })
    const result = await getAvailableNow('group-1', 's1', new Date(), db)
    assert.deepEqual(result, [])
  }),

  // ── formatEmergencyResponse ──
  test('formatEmergencyResponse: lists ranked staff with shift name and time', () => {
    const ranked = [
      { staffName: 'Sarah', roleName: 'Server', rank: 1, reason: 'fast responder', score: 0.8 },
      { staffName: 'Jake', roleName: 'Server', rank: 2, reason: 'available', score: 0.5 },
    ]
    const result = formatEmergencyResponse(ranked, 'Dinner', 45)
    assert.ok(result.includes('Dinner'))
    assert.ok(result.includes('45'))
    assert.ok(result.includes('Sarah'))
    assert.ok(result.includes('Jake'))
    assert.ok(result.includes('Server'))
    assert.ok(result.includes('1.'))
    assert.ok(result.includes('2.'))
  }),

  test('formatEmergencyResponse: no available staff → warning message', () => {
    const result = formatEmergencyResponse([], 'Dinner', 30)
    assert.ok(result.includes('⚠️'))
    assert.ok(result.includes('No staff'))
  }),

  // ── handleEmergencyQuery ──
  test('handleEmergencyQuery: sends response to manager + DMs to available staff', async () => {
    const bot = new MockBot()
    const msg = {
      from: { id: 999 },
      chat: { id: '999', type: 'private' },
    }
    const db = makeEmergencyDb()
    await handleEmergencyQuery(bot, msg, db)

    // Manager gets the ranked list
    const managerMsgs = bot.messagesTo('999')
    assert.ok(managerMsgs.length >= 1, 'manager should receive at least 1 message')
    const mainMsg = managerMsgs.find(m => m.text.includes('🚨'))
    assert.ok(mainMsg, 'manager should get emergency response with 🚨')

    // DMs sent to available staff
    const sarahDms = bot.messagesTo('2002')
    const jakeDms = bot.messagesTo('2003')
    assert.ok(sarahDms.length >= 1, 'Sarah should receive a DM')
    assert.ok(jakeDms.length >= 1, 'Jake should receive a DM')

    // Manager gets confirmation of who was contacted
    const confirmMsg = managerMsgs.find(m => m.text.includes('Coverage request sent'))
    assert.ok(confirmMsg, 'manager should get confirmation of DMs sent')
  }),

  test('handleEmergencyQuery: no upcoming shift → graceful message', async () => {
    const bot = new MockBot()
    const msg = {
      from: { id: 999 },
      chat: { id: '999', type: 'private' },
    }
    const db = makeEmergencyDb({
      getNextUpcomingShift: async () => null,
    })
    await handleEmergencyQuery(bot, msg, db)

    const managerMsgs = bot.messagesTo('999')
    assert.ok(managerMsgs.length >= 1)
    assert.ok(managerMsgs.some(m => m.text.includes('No shifts')), 'should mention no shifts')
  }),

  test('handleEmergencyQuery: no manager group → error message', async () => {
    const bot = new MockBot()
    const msg = {
      from: { id: 999 },
      chat: { id: '999', type: 'private' },
    }
    const db = makeEmergencyDb({
      getManagerGroup: async () => null,
    })
    await handleEmergencyQuery(bot, msg, db)

    const managerMsgs = bot.messagesTo('999')
    assert.ok(managerMsgs.length >= 1)
    // Should send an error about no group
    assert.ok(managerMsgs.some(m => m.text.toLowerCase().includes('group') || m.text.toLowerCase().includes('error')))
  }),
])
