import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectClopenings, formatClopeningWarning } from '../../schedule/clopen.js'

function assignment(staffId, staffName, shiftId, day, startTime, endTime, shiftName = 'Shift') {
  return { staffId, staffName, shiftId, dayOfWeek: day, startTime, endTime, shiftName }
}

await Promise.all([
  test('closes 11pm Mon, opens 6am Tue → 7 hours rest, flagged', () => {
    const assignments = [
      assignment(1, 'Alice', 'a', 'Monday', '5:00 PM', '11pm', 'Evening'),
      assignment(1, 'Alice', 'b', 'Tuesday', '6am', '2:00 PM', 'Morning'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 1)
    assert.equal(result[0].staffName, 'Alice')
    assert.equal(result[0].hoursBetween, 7)
  }),

  test('12hrs rest between consecutive days → not flagged', () => {
    // Mon 20:00 close, Tue 08:00 open = exactly 12h
    const assignments = [
      assignment(1, 'Bob', 'c', 'Monday', '12:00 PM', '8:00 PM', 'Day'),
      assignment(1, 'Bob', 'd', 'Tuesday', '8:00 AM', '4:00 PM', 'Morning'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 0)
  }),

  test('exactly 10hrs rest → not flagged', () => {
    // Mon 22:00 close, Tue 08:00 open = 10h exactly
    const assignments = [
      assignment(1, 'Carol', 'e', 'Monday', '2:00 PM', '22:00', 'Evening'),
      assignment(1, 'Carol', 'f', 'Tuesday', '8:00 AM', '4:00 PM', 'Morning'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 0)
  }),

  test('9.9hrs rest → flagged', () => {
    // Mon 22:06 close, Tue 08:00 open = (480+1440-1326)/60 = 594/60 = 9.9h
    const assignments = [
      assignment(1, 'Dave', 'g', 'Monday', '2:00 PM', '22:06', 'Evening'),
      assignment(1, 'Dave', 'h', 'Tuesday', '8:00 AM', '4:00 PM', 'Morning'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 1)
    assert.ok(result[0].hoursBetween < 10, `Expected < 10h, got ${result[0].hoursBetween}`)
  }),

  test('non-consecutive days (Mon close, Wed open) → not flagged', () => {
    const assignments = [
      assignment(1, 'Eve', 'i', 'Monday', '5:00 PM', '11:00 PM', 'Evening'),
      assignment(1, 'Eve', 'j', 'Wednesday', '6:00 AM', '2:00 PM', 'Morning'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 0)
  }),

  test('staff with only one shift → empty array, no crash', () => {
    const assignments = [
      assignment(1, 'Frank', 'k', 'Monday', '9:00 AM', '5:00 PM', 'Day'),
    ]
    const result = detectClopenings(assignments, [])
    assert.equal(result.length, 0)
  }),

  test('formatClopeningWarning with empty array → empty string', () => {
    assert.equal(formatClopeningWarning([]), '')
    assert.equal(formatClopeningWarning(null), '')
  }),

  test('formatClopeningWarning with 2 clopenings → contains both names', () => {
    const assignments1 = [
      assignment(1, 'Grace', 'l', 'Monday', '5:00 PM', '11:00 PM', 'Evening'),
      assignment(1, 'Grace', 'm', 'Tuesday', '6:00 AM', '2:00 PM', 'Morning'),
    ]
    const assignments2 = [
      assignment(2, 'Hank', 'n', 'Wednesday', '5:00 PM', '11:00 PM', 'Evening'),
      assignment(2, 'Hank', 'o', 'Thursday', '6:00 AM', '2:00 PM', 'Morning'),
    ]
    const clopenings = detectClopenings([...assignments1, ...assignments2], [])
    const warning = formatClopeningWarning(clopenings)
    assert.ok(warning.includes('Grace'), 'Should mention Grace')
    assert.ok(warning.includes('Hank'), 'Should mention Hank')
  }),

  test('formatClopeningWarning output contains ⚠️', () => {
    const assignments = [
      assignment(1, 'Iris', 'p', 'Monday', '5:00 PM', '11:00 PM', 'Evening'),
      assignment(1, 'Iris', 'q', 'Tuesday', '6:00 AM', '2:00 PM', 'Morning'),
    ]
    const clopenings = detectClopenings(assignments, [])
    const warning = formatClopeningWarning(clopenings)
    assert.ok(warning.includes('⚠️'), 'Should contain warning emoji')
  }),

  test('time parsing handles multiple formats: 11:00pm, 23:00, 11pm', () => {
    // All these should be treated as 11 PM / 23:00
    // Test by using them as end times and computing the same hoursBetween
    function clopen(endTime) {
      return detectClopenings([
        assignment(1, 'Jack', 'r', 'Monday', '5:00 PM', endTime, 'Evening'),
        assignment(1, 'Jack', 's', 'Tuesday', '6:00 AM', '2:00 PM', 'Morning'),
      ], [])
    }

    const r1 = clopen('11:00 PM')
    const r2 = clopen('23:00')
    const r3 = clopen('11pm')

    assert.equal(r1.length, 1, '11:00 PM should be parsed')
    assert.equal(r2.length, 1, '23:00 should be parsed')
    assert.equal(r3.length, 1, '11pm should be parsed')
    assert.equal(r1[0].hoursBetween, r2[0].hoursBetween, '11:00 PM and 23:00 should give same result')
    assert.equal(r2[0].hoursBetween, r3[0].hoursBetween, '23:00 and 11pm should give same result')
    assert.equal(r1[0].hoursBetween, 7)
  }),
])
