import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateWeeklySchedule } from '../../schedule/generateSchedule.js'

const WEEK = '2025-04-14'

// Minimal mock data builders
function shift(id, name, day) {
  return { id, name, day_of_week: day, start_time: '9:00 AM', end_time: '5:00 PM' }
}

function staff(id, name, role, userId) {
  return { id, name, role, userId }
}

function availability(userId, shiftIds, opts = {}) {
  return { user_id: userId, available_shift_ids: shiftIds, available_all: opts.all ?? false, unavailable: opts.unavailable ?? false }
}

function req(shiftId, role, count) {
  return { shift_id: shiftId, role, count }
}

test('all shifts filled when everyone is available', async () => {
  const mockData = {
    shifts: [shift(1, 'Monday Morning', 'Monday'), shift(2, 'Tuesday Morning', 'Tuesday')],
    staff: [staff(10, 'Alice', 'Server', 'u1'), staff(11, 'Bob', 'Server', 'u2')],
    availability: [availability('u1', [1, 2]), availability('u2', [1, 2])],
    requirements: [req(1, 'server', 1), req(2, 'server', 1)],
  }
  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 2)
  assert.equal(result.gaps.length, 0)
})

test('gap reported when nobody available for a shift', async () => {
  const mockData = {
    shifts: [shift(1, 'Monday Morning', 'Monday')],
    staff: [staff(10, 'Alice', 'Server', 'u1')],
    availability: [availability('u1', [])], // Alice has no availability
    requirements: [req(1, 'server', 1)],
  }
  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 0)
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].shortfall, 1)
})

test('available_all fills every shift', async () => {
  const mockData = {
    shifts: [shift(1, 'Monday', 'Monday'), shift(2, 'Wednesday', 'Wednesday')],
    staff: [staff(10, 'Alice', 'Server', 'u1')],
    availability: [availability('u1', [], { all: true })],
    requirements: [req(1, 'server', 1), req(2, 'server', 1)],
  }
  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 2)
})

test('unavailable person gets no assignments', async () => {
  const mockData = {
    shifts: [shift(1, 'Monday', 'Monday')],
    staff: [staff(10, 'Alice', 'Server', 'u1'), staff(11, 'Bob', 'Server', 'u2')],
    availability: [
      availability('u1', [], { unavailable: true }),
      availability('u2', [1]),
    ],
    requirements: [req(1, 'server', 1)],
  }
  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 1)
  assert.equal(result.assignments[0].staffName, 'Bob')
})

test('role mismatch creates gap', async () => {
  const mockData = {
    shifts: [shift(1, 'Monday', 'Monday')],
    staff: [staff(10, 'Alice', 'Cook', 'u1')],  // Cook, but shift needs Server
    availability: [availability('u1', [1])],
    requirements: [req(1, 'server', 1)],
  }
  const result = await generateWeeklySchedule('g1', WEEK, mockData)
  assert.equal(result.assignments.length, 0)
  assert.equal(result.gaps.length, 1)
})
