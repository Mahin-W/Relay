import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAvailabilityResponse } from '../../availability/collectAvailability.js'

// A sample shiftMap with 6 shifts (rich-object form)
const shiftMap = {
  '1': { id: 101, name: 'Monday Morning',    day_of_week: 'Monday',    start_time: '8:00 AM',  end_time: '12:00 PM' },
  '2': { id: 102, name: 'Monday Evening',    day_of_week: 'Monday',    start_time: '5:00 PM',  end_time: '9:00 PM'  },
  '3': { id: 103, name: 'Wednesday Lunch',   day_of_week: 'Wednesday', start_time: '12:00 PM', end_time: '4:00 PM'  },
  '4': { id: 104, name: 'Friday Evening',    day_of_week: 'Friday',    start_time: '5:00 PM',  end_time: '9:00 PM'  },
  '5': { id: 105, name: 'Saturday Brunch',   day_of_week: 'Saturday',  start_time: '10:00 AM', end_time: '2:00 PM'  },
  '6': { id: 106, name: 'Sunday Dinner',     day_of_week: 'Sunday',    start_time: '5:00 PM',  end_time: '9:00 PM'  },
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
  assert.deepEqual(parseAvailabilityResponse('9', shiftMap), { type: 'unclear' })
})

test('random text → unclear', () => {
  assert.deepEqual(parseAvailabilityResponse('maybe', shiftMap), { type: 'unclear' })
})

// ── C1: Day-name parsing (Bug 1.03b) ────────────────────────────────────────

test('C1: "fri sat sun" → specific_shifts [4, 5, 6]', () => {
  const result = parseAvailabilityResponse('fri sat sun', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual([...result.numbers].sort(), ['4', '5', '6'])
})

test('C1: "friday saturday sunday" full names → specific_shifts [4, 5, 6]', () => {
  const result = parseAvailabilityResponse('friday saturday sunday', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual([...result.numbers].sort(), ['4', '5', '6'])
})

test('C1: "mon wed" → specific_shifts keys 1, 2, 3', () => {
  const result = parseAvailabilityResponse('mon wed', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  // Monday = keys 1,2; Wednesday = key 3
  assert.deepEqual([...result.numbers].sort(), ['1', '2', '3'])
})

test('C1: day name not in shiftMap → unclear', () => {
  // shiftMap has no Tuesday shift
  assert.deepEqual(parseAvailabilityResponse('tue', shiftMap), { type: 'unclear' })
})

// ── C2: Typo-tolerant "all except" (Bug 1.03d) ──────────────────────────────

test('C2: "all excpet monday" → specific_shifts [3,4,5,6]', () => {
  const result = parseAvailabilityResponse('all excpet monday', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.deepEqual([...result.numbers].sort(), ['3', '4', '5', '6'])
})

test('C2: "all except friday" → excludes key 4', () => {
  const result = parseAvailabilityResponse('all except friday', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.ok(!result.numbers.includes('4'), 'Friday key (4) should be excluded')
  assert.ok(result.numbers.includes('5'), 'Saturday key (5) should be included')
})

test('C2: "all but saturday" → excludes key 5', () => {
  const result = parseAvailabilityResponse('all but saturday', shiftMap)
  assert.equal(result.type, 'specific_shifts')
  assert.ok(!result.numbers.includes('5'), 'Saturday key (5) should be excluded')
})

test('C2: "not all" → unclear (negative case)', () => {
  assert.deepEqual(parseAvailabilityResponse('not all', shiftMap), { type: 'unclear' })
})

// ── C3: Loose all_week matching (Bug 1.03e) ──────────────────────────────────

test('C3: "yeah all good" → all_week', () => {
  assert.deepEqual(parseAvailabilityResponse('yeah all good', shiftMap), { type: 'all_week' })
})

test('C3: "all works" → all_week', () => {
  assert.deepEqual(parseAvailabilityResponse('all works', shiftMap), { type: 'all_week' })
})

test('C3: "yeah all fine" → all_week', () => {
  assert.deepEqual(parseAvailabilityResponse('yeah all fine', shiftMap), { type: 'all_week' })
})

test('C3: "none" → unavailable (not mismatched as all_week)', () => {
  assert.deepEqual(parseAvailabilityResponse('none', shiftMap), { type: 'unavailable' })
})
