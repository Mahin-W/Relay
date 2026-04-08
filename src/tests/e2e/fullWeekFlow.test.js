import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateWeeklySchedule, formatScheduleMessage } from '../../schedule/generateSchedule.js'

// Full scheduling cycle: availability collected → schedule generated → formatted
// Uses mockData so no DB or API calls.

const WEEK = '2025-04-14'

test('full week: schedule generated and formatted with real assignments', async () => {
  const mockData = {
    shifts: [
      { id: 1, name: 'Monday Morning', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '1:00 PM' },
      { id: 2, name: 'Wednesday Evening', day_of_week: 'Wednesday', start_time: '5:00 PM', end_time: '9:00 PM' },
      { id: 3, name: 'Friday Lunch', day_of_week: 'Friday', start_time: '11:00 AM', end_time: '3:00 PM' },
    ],
    staff: [
      { id: 10, name: 'Alice', role: 'Server', userId: 'u1' },
      { id: 11, name: 'Bob', role: 'Server', userId: 'u2' },
      { id: 12, name: 'Carlos', role: 'Cook', userId: 'u3' },
    ],
    availability: [
      { user_id: 'u1', available_shift_ids: [1, 2, 3], available_all: false, unavailable: false },
      { user_id: 'u2', available_shift_ids: [1, 3], available_all: false, unavailable: false },
      { user_id: 'u3', available_all: true, available_shift_ids: [], unavailable: false },
    ],
    requirements: [
      { shift_id: 1, role: 'Server', count: 1 },
      { shift_id: 1, role: 'Cook', count: 1 },
      { shift_id: 2, role: 'Server', count: 1 },
      { shift_id: 3, role: 'Server', count: 1 },
      { shift_id: 3, role: 'Cook', count: 1 },
    ],
  }

  const result = await generateWeeklySchedule('g1', WEEK, mockData)

  assert.ok(result.assignments.length > 0, 'should have assignments')
  assert.ok(result.gaps.length < mockData.requirements.length, 'should not have all gaps')
  assert.equal(result.weekStart, WEEK)

  // Verify formatScheduleMessage doesn't throw and contains expected content
  const formatted = formatScheduleMessage(result.assignments, result.gaps, WEEK)
  assert.ok(typeof formatted === 'string', 'formatted should be a string')
  assert.ok(formatted.includes('Schedule'), 'should include Schedule header')
  assert.ok(formatted.includes('Apr'), 'should include month abbreviation')
})

test('full week: fairness — staff with fewer shifts get priority', async () => {
  const mockData = {
    shifts: [
      { id: 1, name: 'Monday', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '5:00 PM' },
      { id: 2, name: 'Tuesday', day_of_week: 'Tuesday', start_time: '9:00 AM', end_time: '5:00 PM' },
    ],
    staff: [
      { id: 10, name: 'Alice', role: 'Server', userId: 'u1' },
      { id: 11, name: 'Bob', role: 'Server', userId: 'u2' },
    ],
    availability: [
      { user_id: 'u1', available_all: true, available_shift_ids: [], unavailable: false },
      { user_id: 'u2', available_all: true, available_shift_ids: [], unavailable: false },
    ],
    requirements: [
      { shift_id: 1, role: 'Server', count: 1 },
      { shift_id: 2, role: 'Server', count: 1 },
    ],
  }

  const result = await generateWeeklySchedule('g1', WEEK, mockData)

  // Both shifts should be filled
  assert.equal(result.assignments.length, 2)
  assert.equal(result.gaps.length, 0)

  // Different people should be assigned (fairness)
  const assignedNames = result.assignments.map(a => a.staffName)
  const unique = new Set(assignedNames)
  assert.equal(unique.size, 2, 'fairness: both staff should each get one shift')
})

test('full week: partial coverage creates gaps', async () => {
  const mockData = {
    shifts: [
      { id: 1, name: 'Saturday', day_of_week: 'Saturday', start_time: '10:00 AM', end_time: '6:00 PM' },
    ],
    staff: [
      { id: 10, name: 'Alice', role: 'Server', userId: 'u1' },
    ],
    availability: [
      { user_id: 'u1', available_all: true, available_shift_ids: [], unavailable: false },
    ],
    requirements: [
      { shift_id: 1, role: 'Server', count: 2 }, // needs 2 servers, only 1 available
    ],
  }

  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 1)
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].shortfall, 1)
})
