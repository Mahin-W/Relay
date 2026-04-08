import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAvailabilityResponse } from '../../availability/collectAvailability.js'

// A sample shiftMap with 3 shifts
const shiftMap = {
  '1': { id: 101, name: 'Monday Morning', day_of_week: 'Monday', start_time: '8:00 AM', end_time: '12:00 PM' },
  '2': { id: 102, name: 'Wednesday Afternoon', day_of_week: 'Wednesday', start_time: '12:00 PM', end_time: '4:00 PM' },
  '3': { id: 103, name: 'Friday Evening', day_of_week: 'Friday', start_time: '5:00 PM', end_time: '9:00 PM' },
}

// ── Unavailable ──────────────────────────────────────────────────────────────

test('off → unavailable', () => {
  assert.deepEqual(parseAvailabilityResponse('off', shiftMap), { type: 'unavailable' })
})

test("can't → unavailable", () => {
  assert.deepEqual(parseAvailabilityResponse("can't", shiftMap), { type: 'unavailable' })
})

test('no → unavailable', () => {
  assert.deepEqual(parseAvailabilityResponse('no', shiftMap), { type: 'unavailable' })
})

test('unavailable → unavailable', () => {
  assert.deepEqual(parseAvailabilityResponse('unavailable', shiftMap), { type: 'unavailable' })
})

// ── All shifts ───────────────────────────────────────────────────────────────

test('all → all_week', () => {
  assert.deepEqual(parseAvailabilityResponse('all', shiftMap), { type: 'all_week' })
})

test('all shifts → all_week', () => {
  assert.deepEqual(parseAvailabilityResponse('all shifts', shiftMap), { type: 'all_week' })
})

// ── Numbered selection ───────────────────────────────────────────────────────

test('1 3 → specific_shifts [1, 3]', () => {
  const result = parseAvailabilityResponse('1 3', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual(result.numbers, ['1', '3'])
})

test('2 → specific_shifts [2]', () => {
  const result = parseAvailabilityResponse('2', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual(result.numbers, ['2'])
})

test('1 2 3 → specific_shifts [1, 2, 3]', () => {
  const result = parseAvailabilityResponse('1 2 3', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual(result.numbers, ['1', '2', '3'])
})

// ── Out of range / unclear ───────────────────────────────────────────────────

test('number not in shiftMap → unclear', () => {
  assert.deepEqual(parseAvailabilityResponse('4', shiftMap), { type: 'unclear' })
})

test('random text → unclear', () => {
  assert.deepEqual(parseAvailabilityResponse('maybe', shiftMap), { type: 'unclear' })
})
