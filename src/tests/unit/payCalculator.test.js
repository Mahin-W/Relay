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

  // ── P1-24: late deduction must not pull gross below minimum-wage floor ────────

  test('calculateShiftPay: large lateMinutes floors grossPay at MIN_WAGE * hoursWorked (P1-24)', () => {
    // 4-hour shift at $10/hr = $40.00 full pay.
    // 180 late minutes (3 hrs) → effectiveHours=1, grossPay=1*10=$10.
    // MIN_WAGE default=7.25; floor=7.25*4=$29.00.
    // $10 < $29, so grossPay must be clamped to $29.00.
    // lateDeduction = round2(4*10 - 29) = $11.00 (not $30).
    const result = calculateShiftPay(
      shift('Morning', 'Wednesday', '8:00 AM', '12:00 PM'),
      role('Cook', 10),
      180  // 3 hrs late on a 4-hr shift → would normally pay only 1hr=$10
    )
    const hoursWorked = 4  // total shift hours (hoursScheduled)
    const minWage = Number(process.env.MIN_WAGE) || 7.25
    const floor = Math.round(minWage * hoursWorked * 100) / 100  // 29.00
    // grossPay must not drop below the min-wage floor
    assert.ok(
      result.grossPay >= floor - 0.005,
      `grossPay ${result.grossPay} should be >= min-wage floor ${floor}`
    )
    // lateDeduction must be correspondingly reduced (= fullPay - cappedGross)
    const fullPay = Math.round(hoursWorked * 10 * 100) / 100  // 40.00
    const expectedDeduction = Math.round((fullPay - result.grossPay) * 100) / 100
    assert.ok(
      Math.abs(result.lateDeduction - expectedDeduction) < 0.01,
      `lateDeduction should be ${expectedDeduction}, got ${result.lateDeduction}`
    )
    // grossPay + lateDeduction should equal full hours * rate
    const total = Math.round((result.grossPay + result.lateDeduction) * 100) / 100
    assert.ok(
      Math.abs(total - fullPay) < 0.01,
      `grossPay + lateDeduction should equal fullPay (${fullPay}), got ${total}`
    )
  }),

  test('calculateShiftPay: normal late deduction (not floored) still works (P1-24)', () => {
    // 8-hour shift at $15/hr, 30 min late. effectiveHours=7.5, grossPay=112.50.
    // floor=7.25*8=$58.00. 112.50 > 58.00 → no clamping. Same as before.
    const result = calculateShiftPay(
      shift('Morning', 'Monday', '9:00 AM', '5:00 PM'),
      role('Chef', 15),
      30
    )
    assert.ok(Math.abs(result.grossPay - 112.50) < 0.01, `expected 112.50, got ${result.grossPay}`)
    assert.ok(Math.abs(result.lateDeduction - 7.50) < 0.01, `expected 7.50, got ${result.lateDeduction}`)
  }),

  test('calculateShiftPay: hourlyRate below MIN_WAGE — floor never inflates above full pay (P1-24)', () => {
    // 4-hour shift at $5/hr (below min wage). Full pay = 4*5=$20.
    // floor = MIN_WAGE*4 = 7.25*4=$29. But we must never pay MORE than full hours×rate.
    // Guard: cappedGross = Math.min(floor, hoursWorked*hourlyRate) = min(29,20) = 20.
    // So even with a large late penalty, grossPay should not exceed $20.
    const result = calculateShiftPay(
      shift('Short', 'Monday', '9:00 AM', '1:00 PM'),
      role('Trainee', 5),
      60   // 1 hr late → effectiveHours=3, grossPay=15 without floor
    )
    const fullPay = 4 * 5  // 20.00 — full hours at rate
    assert.ok(
      result.grossPay <= fullPay + 0.005,
      `grossPay ${result.grossPay} must not exceed fullPay ${fullPay} even when hourlyRate < MIN_WAGE`
    )
  }),
])
