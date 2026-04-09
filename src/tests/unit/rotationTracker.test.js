import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDesirableShift, applyRotationToAssignments, buildRotationPriorityMap, getRotationReport } from '../../fairness/rotationTracker.js'

// ── isDesirableShift ─────────────────────────────────────────────────────────

test('isDesirableShift: Friday → true', () => {
  assert.equal(isDesirableShift({ name: 'Lunch', day_of_week: 'Friday', end_time: '3pm' }), true)
})

test('isDesirableShift: Saturday → true', () => {
  assert.equal(isDesirableShift({ name: 'Brunch', day_of_week: 'Saturday', end_time: '2pm' }), true)
})

test('isDesirableShift: Tuesday Dinner → true (name contains dinner)', () => {
  assert.equal(isDesirableShift({ name: 'Dinner Service', day_of_week: 'Tuesday', end_time: '10pm' }), true)
})

test('isDesirableShift: Monday Evening → true (name contains evening)', () => {
  assert.equal(isDesirableShift({ name: 'Evening Shift', day_of_week: 'Monday', end_time: '11pm' }), true)
})

test('isDesirableShift: Tuesday Lunch 3pm → false', () => {
  assert.equal(isDesirableShift({ name: 'Lunch', day_of_week: 'Tuesday', end_time: '3pm' }), false)
})

test('isDesirableShift: Wednesday ends 21:00 → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Wednesday', end_time: '21:00' }), true)
})

test('isDesirableShift: Thursday ends 20:59 → false', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Thursday', end_time: '20:59' }), false)
})

test('isDesirableShift: endTime 9pm → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '9pm' }), true)
})

test('isDesirableShift: endTime 21:00 → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '21:00' }), true)
})

test('isDesirableShift: endTime 9:00pm → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '9:00pm' }), true)
})

// ── applyRotationToAssignments ───────────────────────────────────────────────

const MOCK_SHIFTS = [
  { id: 1, name: 'Friday Dinner', day_of_week: 'Friday', end_time: '11pm' },
  { id: 2, name: 'Tuesday Lunch', day_of_week: 'Tuesday', end_time: '3pm' },
]

test('applyRotation: non-desirable shifts unchanged', () => {
  const assignments = [
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 10, staffName: 'Alice', roleName: 'server' },
  ]
  const priorityMap = new Map([[2, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  assert.equal(result[0].staffId, 10, 'non-desirable shift should not change')
})

test('applyRotation: staff with 0 recent desirable history gets priority over staff with 3', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  // priorityMap says Bob (20) should get shiftId 1 (Bob has 0 recent, Alice has 3)
  const priorityMap = new Map([
    [1, [20, 10]],
    [2, [10, 20]],
  ])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayA = result.find(a => a.shiftId === 1)
  assert.equal(fridayA.staffId, 20, 'Bob (0 recent) should be swapped onto Friday Dinner')
})

test('applyRotation: no double bookings introduced after rotation', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
    // Bob is also on Friday already — should NOT be swapped onto Friday Dinner (would be double-booking on Friday)
    { shiftId: 99, shiftName: 'Friday Lunch', dayOfWeek: 'Friday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  const priorityMap = new Map([[1, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayDinner = result.find(a => a.shiftId === 1)
  assert.equal(fridayDinner.staffId, 10, 'Alice should stay — Bob is already on Friday (double booking prevented)')
})

test('applyRotation: role constraints preserved (chef stays chef)', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'chef' },
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  // Bob (server) has higher priority for shiftId 1 but is wrong role
  const priorityMap = new Map([[1, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayA = result.find(a => a.shiftId === 1)
  assert.equal(fridayA.staffId, 10, 'Alice should keep Friday Dinner — Bob is server not chef')
  assert.equal(fridayA.roleName, 'chef')
})

test('applyRotation: empty assignments → empty result', () => {
  const result = applyRotationToAssignments([], new Map(), MOCK_SHIFTS)
  assert.deepEqual(result, [])
})

test('applyRotation: no priorityMap entry for shift → unchanged', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
  ]
  const result = applyRotationToAssignments(assignments, new Map(), MOCK_SHIFTS)
  assert.equal(result[0].staffId, 10)
})

// ── buildRotationPriorityMap (mock DB) ───────────────────────────────────────

test('buildRotationPriorityMap returns a Map', async () => {
  const mockDb = { getRotationScores: async () => [] }
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, [], mockDb)
  assert.ok(result instanceof Map)
})

test('buildRotationPriorityMap: Map key is shiftId, value is array of staffIds', async () => {
  const mockDb = { getRotationScores: async () => [] }
  const staff = [{ staffId: 10, name: 'Alice', role: 'server' }]
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, staff, mockDb)
  assert.ok(result.has(1))
  assert.ok(Array.isArray(result.get(1)))
})

test('buildRotationPriorityMap: staff with fewer recent = earlier in priority array', async () => {
  const mockDb = {
    getRotationScores: async (groupId, shiftId) => {
      if (shiftId === 1) return [
        { staffId: 20, staffName: 'Bob', recentCount: 0 },
        { staffId: 10, staffName: 'Alice', recentCount: 3 },
      ]
      return []
    },
  }
  const staff = [{ staffId: 10, name: 'Alice', role: 'server' }, { staffId: 20, name: 'Bob', role: 'server' }]
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, staff, mockDb)
  const order = result.get(1)
  assert.equal(order[0], 20, 'Bob (0 recent) should be index 0')
  assert.equal(order[1], 10, 'Alice (3 recent) should be index 1')
})

// ── getRotationReport (mock DB) ──────────────────────────────────────────────

test('getRotationReport returns array sorted DESC by desirableShiftsWorked', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-13' },
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-20' },
      { staffId: 20, staffName: 'Bob', shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', endTime: '3pm', weekStart: '2025-01-06' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].staffId, 10, 'Alice first (3 desirable shifts)')
  assert.equal(result[0].desirableShiftsWorked, 3)
  assert.equal(result[1].staffId, 20, 'Bob second (0 desirable shifts)')
  assert.equal(result[1].desirableShiftsWorked, 0)
})

test('getRotationReport: correct totalShiftsWorked count', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
      { staffId: 10, staffName: 'Alice', shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', endTime: '3pm', weekStart: '2025-01-06' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].totalShiftsWorked, 2)
})

test('getRotationReport: lastDesirableShiftName populated', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-13' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].lastDesirableShiftName, 'Friday Dinner')
  assert.equal(result[0].lastDesirableShiftDate, '2025-01-13')
})

// ── /rotation command (MockBot) ───────────────────────────────────────────────

const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
const { handleRotationCommand } = await import('../../fairness/rotationTracker.js')

test('/rotation: sends report to group', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 101, first_name: 'Alice' } })
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
    ],
  }
  await handleRotationCommand(bot, msg, mockDb)
  const sent = bot.lastMessage('-100')
  assert.ok(sent?.text.includes('Alice'), 'report should include staff name')
  assert.ok(sent?.text.includes('1'), 'should show desirable shift count')
})

test('/rotation: shows "No shift history" when empty', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 101, first_name: 'Alice' } })
  const mockDb = { getGroupShiftHistory: async () => [] }
  await handleRotationCommand(bot, msg, mockDb)
  const sent = bot.lastMessage('-100')
  assert.ok(sent?.text.includes('No shift history') || sent?.text.includes('publish a schedule'), 'empty state message')
})

test('/rotation: blocked for non-admins', async () => {
  const bot = new MockBot()
  // do NOT setAdmin
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 999, first_name: 'Rando' } })
  const mockDb = { getGroupShiftHistory: async () => [] }
  await handleRotationCommand(bot, msg, mockDb)
  assert.ok(!bot.lastMessage('-100'), 'non-admin should get no reply')
})
