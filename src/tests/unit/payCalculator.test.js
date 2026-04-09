import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateShiftPay,
  formatPayBreakdown,
  calculateWeeklyPay,
} from '../../payroll/payCalculator.js'

function shift(name, dayOfWeek, startTime, endTime) {
  return { name, dayOfWeek, startTime, endTime }
}

function role(roleName, hourlyRate) {
  return { roleName, hourlyRate }
}

await Promise.all([
  // ── calculateShiftPay ─────────────────────────────────────────────────────

  test('calculateShiftPay: 11am–4pm @ $15/hr → $75.00', () => {
    const result = calculateShiftPay(shift('Lunch', 'Monday', '11:00 AM', '4:00 PM'), role('Server', 15))
    assert.equal(result.grossPay, 75.00)
    assert.equal(result.hoursScheduled, 5)
  }),

  test('calculateShiftPay: 9pm–2am @ $13/hr → $65.00 (midnight crossing)', () => {
    const result = calculateShiftPay(shift('Close', 'Friday', '9:00 PM', '2:00 AM'), role('Server', 13))
    assert.equal(result.grossPay, 65.00)
    assert.equal(result.hoursScheduled, 5)
  }),

  test('calculateShiftPay: 0 late minutes → no deduction', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15), 0)
    assert.equal(result.lateDeduction, 0)
    assert.equal(result.hoursWorked, 8)
  }),

  test('calculateShiftPay: 20 late minutes @ $15/hr → deducts $5.00', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15), 20)
    assert.equal(result.lateMinutes, 20)
    // 20/60 * 15 = 5.00
    assert.ok(Math.abs(result.lateDeduction - 5.00) < 0.01, `expected ~5.00, got ${result.lateDeduction}`)
    assert.ok(Math.abs(result.grossPay - 115.00) < 0.01, `expected ~115.00, got ${result.grossPay}`)
  }),

  test('calculateShiftPay: 60 late minutes deducts 1hr pay', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15), 60)
    assert.ok(Math.abs(result.lateDeduction - 15.00) < 0.01)
    assert.ok(Math.abs(result.grossPay - 105.00) < 0.01)
  }),

  test('calculateShiftPay: late > shift length → grossPay = 0, not negative', () => {
    const result = calculateShiftPay(shift('Short', 'Monday', '9:00 AM', '10:00 AM'), role('Chef', 15), 120)
    assert.equal(result.grossPay, 0)
    assert.ok(result.hoursWorked >= 0, 'hoursWorked should not be negative')
  }),

  test('calculateShiftPay: partial 11am–2pm of 11am–5pm shift → 3hrs not 6hrs', () => {
    const result = calculateShiftPay(
      shift('Lunch', 'Monday', '11:00 AM', '5:00 PM'),
      role('Server', 15),
      0,
      '11:00 AM', '2:00 PM'
    )
    assert.equal(result.hoursWorked, 3)
    assert.equal(result.grossPay, 45.00)
  }),

  test('calculateShiftPay: returns correct breakdown string', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15))
    assert.ok(typeof result.breakdown === 'string')
    assert.ok(result.breakdown.length > 0)
  }),

  test('calculateShiftPay: lateDeduction = lateHours * hourlyRate', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 20), 30)
    // 30/60 * 20 = 10.00
    assert.ok(Math.abs(result.lateDeduction - 10.00) < 0.01)
  }),

  // ── formatPayBreakdown ────────────────────────────────────────────────────

  test('formatPayBreakdown: contains shift name', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15))
    const text = formatPayBreakdown(result)
    assert.ok(text.includes('Morning'), `should include shift name, got: ${text}`)
  }),

  test('formatPayBreakdown: contains hours', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15))
    const text = formatPayBreakdown(result)
    assert.ok(text.includes('8') || text.includes('hrs'), `should include hours, got: ${text}`)
  }),

  test('formatPayBreakdown: contains rate', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15))
    const text = formatPayBreakdown(result)
    assert.ok(text.includes('15') || text.includes('$'), `should include rate, got: ${text}`)
  }),

  test('formatPayBreakdown: contains gross pay', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15))
    const text = formatPayBreakdown(result)
    assert.ok(text.includes('120') || text.includes('Gross'), `should include gross pay, got: ${text}`)
  }),

  test('formatPayBreakdown: shows late deduction when late', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15), 30)
    const text = formatPayBreakdown(result)
    assert.ok(text.includes('late') || text.includes('Late') || text.includes('-$'), `should mention late, got: ${text}`)
  }),

  test('formatPayBreakdown: no late line when not late', () => {
    const result = calculateShiftPay(shift('Morning', 'Monday', '9:00 AM', '5:00 PM'), role('Chef', 15), 0)
    const text = formatPayBreakdown(result)
    assert.ok(!text.toLowerCase().includes('late deduct'), `should not mention late deduction, got: ${text}`)
  }),

  // ── calculateWeeklyPay ────────────────────────────────────────────────────

  test('calculateWeeklyPay: correct total per staff member', () => {
    const assignments = [
      { staffId: 1, staffName: 'Alice', shiftId: 's1', role: 'Server', startTime: '9:00 AM', endTime: '5:00 PM', dayOfWeek: 'Monday', shiftName: 'Morning' },
    ]
    const shifts = [{ id: 's1', name: 'Morning', dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '5:00 PM' }]
    const roles = [{ roleName: 'Server', hourlyRate: 15 }]
    const result = calculateWeeklyPay(assignments, shifts, roles)
    assert.equal(result.length, 1)
    assert.ok(Math.abs(result[0].totalGrossPay - 120.00) < 0.01)
  }),

  test('calculateWeeklyPay: multiple shifts summed correctly', () => {
    const assignments = [
      { staffId: 1, staffName: 'Alice', shiftId: 's1', role: 'Server', startTime: '9:00 AM', endTime: '1:00 PM', dayOfWeek: 'Monday', shiftName: 'Morning' },
      { staffId: 1, staffName: 'Alice', shiftId: 's2', role: 'Server', startTime: '5:00 PM', endTime: '9:00 PM', dayOfWeek: 'Tuesday', shiftName: 'Evening' },
    ]
    const shifts = [
      { id: 's1', name: 'Morning', dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '1:00 PM' },
      { id: 's2', name: 'Evening', dayOfWeek: 'Tuesday', startTime: '5:00 PM', endTime: '9:00 PM' },
    ]
    const roles = [{ roleName: 'Server', hourlyRate: 10 }]
    const result = calculateWeeklyPay(assignments, shifts, roles)
    assert.equal(result[0].totalHours, 8)
    assert.ok(Math.abs(result[0].totalGrossPay - 80.00) < 0.01)
  }),

  test('calculateWeeklyPay: late events matched to correct staff', () => {
    const assignments = [
      { staffId: 1, staffName: 'Alice', shiftId: 's1', role: 'Server', startTime: '9:00 AM', endTime: '5:00 PM', dayOfWeek: 'Monday', shiftName: 'Morning' },
    ]
    const shifts = [{ id: 's1', name: 'Morning', dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '5:00 PM' }]
    const roles = [{ roleName: 'Server', hourlyRate: 15 }]
    const lateEvents = [{ staffId: 1, minutesLate: 60, shiftId: 's1' }]
    const result = calculateWeeklyPay(assignments, shifts, roles, lateEvents)
    assert.equal(result[0].totalLateMinutes, 60)
    // 8hrs - 1hr = 7hrs * 15 = 105
    assert.ok(Math.abs(result[0].totalGrossPay - 105.00) < 0.01)
  }),

  test('calculateWeeklyPay: sorted by staffName ASC', () => {
    const assignments = [
      { staffId: 2, staffName: 'Zara', shiftId: 's1', role: 'Server', startTime: '9:00 AM', endTime: '1:00 PM', dayOfWeek: 'Monday', shiftName: 'Morning' },
      { staffId: 1, staffName: 'Alice', shiftId: 's2', role: 'Server', startTime: '9:00 AM', endTime: '1:00 PM', dayOfWeek: 'Tuesday', shiftName: 'Lunch' },
    ]
    const shifts = [
      { id: 's1', name: 'Morning', dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '1:00 PM' },
      { id: 's2', name: 'Lunch', dayOfWeek: 'Tuesday', startTime: '9:00 AM', endTime: '1:00 PM' },
    ]
    const roles = [{ roleName: 'Server', hourlyRate: 10 }]
    const result = calculateWeeklyPay(assignments, shifts, roles)
    assert.equal(result[0].staffName, 'Alice')
    assert.equal(result[1].staffName, 'Zara')
  }),

  test('calculateWeeklyPay: empty assignments → empty array', () => {
    const result = calculateWeeklyPay([], [], [])
    assert.deepEqual(result, [])
  }),

  test('calculateWeeklyPay: staff with no shifts excluded', () => {
    const result = calculateWeeklyPay([], [], [{ roleName: 'Server', hourlyRate: 15 }])
    assert.equal(result.length, 0)
  }),
])
