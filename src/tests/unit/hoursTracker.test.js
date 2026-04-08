import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateWeeklyHours, detectHoursIssues, formatHoursWarning } from '../../schedule/hoursTracker.js'

function assignment(staffId, staffName, shiftId, startTime, endTime) {
  return { staffId, staffName, shiftId, startTime, endTime }
}

await Promise.all([
  test('calculateWeeklyHours: 11am–4pm shift = 5.0 hrs', () => {
    const assignments = [assignment(1, 'Alice', 'a', '11:00 AM', '4:00 PM')]
    const result = calculateWeeklyHours(assignments, [])
    assert.equal(result['1'].totalHours, 5.0)
  }),

  test('calculateWeeklyHours: 9pm–2am shift crosses midnight = 5.0 hrs', () => {
    const assignments = [assignment(1, 'Bob', 'b', '9:00 PM', '2:00 AM')]
    const result = calculateWeeklyHours(assignments, [])
    assert.equal(result['1'].totalHours, 5.0)
  }),

  test('calculateWeeklyHours: staff with 3 shifts sums correctly', () => {
    // 5 + 4 + 6 = 15 hrs
    const assignments = [
      assignment(1, 'Carol', 'c1', '9:00 AM', '2:00 PM'),   // 5h
      assignment(1, 'Carol', 'c2', '1:00 PM', '5:00 PM'),   // 4h
      assignment(1, 'Carol', 'c3', '6:00 PM', '12:00 AM'),  // 6h
    ]
    const result = calculateWeeklyHours(assignments, [])
    assert.equal(result['1'].totalHours, 15)
    assert.equal(result['1'].shiftCount, 3)
  }),

  test('calculateWeeklyHours: empty assignments → empty map', () => {
    const result = calculateWeeklyHours([], [])
    assert.deepEqual(result, {})
  }),

  test('detectHoursIssues: 42hr staff → in overtime array', () => {
    const hoursMap = { '1': { staffName: 'Dave', totalHours: 42, shiftCount: 7 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.overtime.length, 1)
    assert.equal(result.overtime[0].staffName, 'Dave')
  }),

  test('detectHoursIssues: 40hr staff → in overtime (at threshold)', () => {
    const hoursMap = { '1': { staffName: 'Eve', totalHours: 40, shiftCount: 5 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.overtime.length, 1)
    assert.equal(result.overtime[0].staffName, 'Eve')
  }),

  test('detectHoursIssues: 39hr staff → not in overtime', () => {
    const hoursMap = { '1': { staffName: 'Frank', totalHours: 39, shiftCount: 5 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.overtime.length, 0)
  }),

  test('detectHoursIssues: 6hr staff → in underScheduled', () => {
    const hoursMap = { '1': { staffName: 'Grace', totalHours: 6, shiftCount: 1 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.underScheduled.length, 1)
    assert.equal(result.underScheduled[0].staffName, 'Grace')
  }),

  test('detectHoursIssues: 8hr staff → not in underScheduled (at threshold)', () => {
    const hoursMap = { '1': { staffName: 'Hank', totalHours: 8, shiftCount: 1 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.underScheduled.length, 0)
  }),

  test('detectHoursIssues: 20hr staff → in neither array', () => {
    const hoursMap = { '1': { staffName: 'Iris', totalHours: 20, shiftCount: 4 } }
    const result = detectHoursIssues(hoursMap)
    assert.equal(result.overtime.length, 0)
    assert.equal(result.underScheduled.length, 0)
  }),

  test('formatHoursWarning: no issues → empty string', () => {
    assert.equal(formatHoursWarning({ overtime: [], underScheduled: [] }), '')
    assert.equal(formatHoursWarning(null), '')
  }),

  test('formatHoursWarning: overtime only → contains ⚠️ not 📊', () => {
    const issues = { overtime: [{ staffName: 'Jack', totalHours: 42 }], underScheduled: [] }
    const result = formatHoursWarning(issues)
    assert.ok(result.includes('⚠️'), 'Should contain ⚠️')
    assert.ok(!result.includes('📊'), 'Should not contain 📊 if no under-scheduling')
  }),

  test('formatHoursWarning: both issues → contains both sections', () => {
    const issues = {
      overtime: [{ staffName: 'Kyle', totalHours: 45 }],
      underScheduled: [{ staffName: 'Lena', totalHours: 4 }],
    }
    const result = formatHoursWarning(issues)
    assert.ok(result.includes('⚠️'), 'Should contain overtime warning')
    assert.ok(result.includes('📊'), 'Should contain under-scheduling section')
  }),

  test('formatHoursWarning: names appear in output', () => {
    const issues = {
      overtime: [{ staffName: 'Mike', totalHours: 41 }],
      underScheduled: [{ staffName: 'Nina', totalHours: 3 }],
    }
    const result = formatHoursWarning(issues)
    assert.ok(result.includes('Mike'), 'Should include overtime name')
    assert.ok(result.includes('Nina'), 'Should include under-scheduled name')
  }),
])
