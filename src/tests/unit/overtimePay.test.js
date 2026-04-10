import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateShiftPayWithOT,
  calculateWeeklyPayWithOT,
  formatPayBreakdownWithOT,
  parseTimeToDecimalHours,
} from '../../payroll/payCalculator.js'

const baseSettings = {
  overtime_enabled: true,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_overtime_enabled: false,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

const noOTSettings = { ...baseSettings, overtime_enabled: false }

const dailySettings = {
  ...baseSettings,
  daily_overtime_enabled: true,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

const bothSettings = {
  ...dailySettings,
  overtime_enabled: true,
  weekly_threshold: 40,
}

const role = { roleName: 'Cook', hourlyRate: 15 }

function shift(name, day, start, end) {
  return { name, dayOfWeek: day, startTime: start, endTime: end }
}

// ── Time parsing ───────────────────────────────────────────────────────
test('parseTimeToDecimalHours: 11am → 11.0', () => {
  assert.equal(parseTimeToDecimalHours('11am'), 11.0)
})
test('parseTimeToDecimalHours: 5pm → 17.0', () => {
  assert.equal(parseTimeToDecimalHours('5pm'), 17.0)
})
test('parseTimeToDecimalHours: 11:30pm → 23.5', () => {
  assert.equal(parseTimeToDecimalHours('11:30pm'), 23.5)
})
test('parseTimeToDecimalHours: 23:00 → 23.0', () => {
  assert.equal(parseTimeToDecimalHours('23:00'), 23.0)
})
test('parseTimeToDecimalHours: 12am → 0.0', () => {
  assert.equal(parseTimeToDecimalHours('12am'), 0.0)
})
test('parseTimeToDecimalHours: 12pm → 12.0', () => {
  assert.equal(parseTimeToDecimalHours('12pm'), 12.0)
})
test('midnight crossing: 10pm–2am → 4hrs', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '10pm', '2am'), role, 0, noOTSettings)
  assert.equal(r.hoursScheduled, 4)
})

// ── No OT settings ─────────────────────────────────────────────────────
test('no OT: 45hr week → all regular, no OT pay', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 45, noOTSettings)
  assert.equal(r.weeklyOTHours, 0)
  assert.equal(r.regularHours, r.effectiveHours)
})
test('no OT: gross = regularHours * rate', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 45, noOTSettings)
  assert.equal(r.grossPay, r.regularHours * 15)
})

// ── Weekly OT ──────────────────────────────────────────────────────────
test('38hrs before + 4hr shift → 2reg + 2weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '11am', '3pm'), role, 38, baseSettings)
  assert.equal(r.regularHours, 2)
  assert.equal(r.weeklyOTHours, 2)
})
test('40hrs before + 4hr shift → 0reg + 4weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '11am', '3pm'), role, 40, baseSettings)
  assert.equal(r.regularHours, 0)
  assert.equal(r.weeklyOTHours, 4)
})
test('0hrs before + 8hr shift → 8reg + 0OT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 0, baseSettings)
  assert.equal(r.regularHours, 8)
  assert.equal(r.weeklyOTHours, 0)
})
test('39hrs before + 2hr shift → 1reg + 1weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '11am', '1pm'), role, 39, baseSettings)
  assert.equal(r.regularHours, 1)
  assert.equal(r.weeklyOTHours, 1)
})

// ── Daily OT ───────────────────────────────────────────────────────────
test('9hr shift with daily OT at 8: 8 reg + 1 dailyOT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '6pm'), role, 0, dailySettings)
  assert.equal(r.dailyOTHours, 1)
  assert.equal(r.regularHours, 8)
})
test('7hr shift with daily OT: 7reg + 0 dailyOT', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '4pm'), role, 0, dailySettings)
  assert.equal(r.dailyOTHours, 0)
  assert.equal(r.regularHours, 7)
})

// ── Both OT types ──────────────────────────────────────────────────────
test('39hr week + 10hr shift (both OT): hours sum to effectiveHours', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '7pm'), role, 39, bothSettings)
  const total = Math.round((r.regularHours + r.weeklyOTHours + r.dailyOTHours) * 100)
  assert.equal(total, Math.round(r.effectiveHours * 100))
})
test('both OT: no hours double-counted', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '7pm'), role, 39, bothSettings)
  assert.ok(r.weeklyOTHours >= 0 && r.dailyOTHours >= 0 && r.regularHours >= 0)
  const sumHours = Math.round((r.regularHours + r.weeklyOTHours + r.dailyOTHours) * 100)
  assert.equal(sumHours, Math.round(r.effectiveHours * 100))
})

// ── Late deduction ─────────────────────────────────────────────────────
test('0 late: no deduction, full effective hours', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 0, baseSettings, 0)
  assert.equal(r.lateDeduction, 0)
  assert.equal(r.effectiveHours, 8)
})
test('30min late on 8hr shift → 7.5 effective hours', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 0, baseSettings, 30)
  assert.equal(r.effectiveHours, 7.5)
})
test('late deduction = lateHours * hourlyRate', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '5pm'), role, 0, baseSettings, 60)
  assert.equal(r.lateDeduction, 15.00)
})
test('grossPay never negative when late > shift length', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '9am', '9:30am'), role, 0, baseSettings, 60)
  assert.ok(r.grossPay >= 0)
  assert.equal(r.effectiveHours, 0)
})

// ── Partial shift ──────────────────────────────────────────────────────
test('partial from 11 to 14 of 11am–5pm shift → 3hrs worked', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '11am', '5pm'), role, 0, baseSettings, 0, 11, 14)
  assert.equal(r.hoursWorked, 3)
})
test('partial shift: OT calculated on partial hours only', () => {
  const r = calculateShiftPayWithOT(shift('S', 'Mon', '11am', '5pm'), role, 38, baseSettings, 0, 11, 14)
  // 3hrs partial, 38 already worked → 2reg + 1weeklyOT
  assert.equal(r.regularHours, 2)
  assert.equal(r.weeklyOTHours, 1)
})

// ── Weekly calculation ─────────────────────────────────────────────────
test('calculateWeeklyPayWithOT: shifts sorted Mon → Sun correctly', () => {
  const assignments = [
    { staffId:'1', staffName:'Alice', shiftId:'10', role:'Cook', dayOfWeek:'Friday',
      startTime:'9am', endTime:'5pm', shiftName:'Fri' },
    { staffId:'1', staffName:'Alice', shiftId:'11', role:'Cook', dayOfWeek:'Monday',
      startTime:'9am', endTime:'5pm', shiftName:'Mon' },
  ]
  const roles = [{ roleName:'Cook', hourlyRate:15 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  assert.equal(result.length, 1)
  assert.equal(result[0].totalEffectiveHours, 16)
  // With both shifts total 16hrs → no OT
  assert.equal(result[0].totalWeeklyOTHours, 0)
})

test('calculateWeeklyPayWithOT: empty assignments → empty array', () => {
  const result = calculateWeeklyPayWithOT([], [], [], baseSettings)
  assert.deepEqual(result, [])
})

test('calculateWeeklyPayWithOT: different roles use own hourlyRate', () => {
  const assignments = [
    { staffId:'1', staffName:'Alice', shiftId:'1', role:'Cook',   dayOfWeek:'Monday', startTime:'9am', endTime:'5pm', shiftName:'S1' },
    { staffId:'2', staffName:'Bob',   shiftId:'2', role:'Server', dayOfWeek:'Monday', startTime:'9am', endTime:'5pm', shiftName:'S2' },
  ]
  const roles = [{ roleName:'Cook', hourlyRate:15 }, { roleName:'Server', hourlyRate:12 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  const alice = result.find(r => r.staffName === 'Alice')
  const bob   = result.find(r => r.staffName === 'Bob')
  assert.equal(alice.totalRegularPay, 120)
  assert.equal(bob.totalRegularPay, 96)
})

test('calculateWeeklyPayWithOT: running hours accumulate — 5×8hr week hits OT', () => {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday']
  const assignments = days.map((day, i) => ({
    staffId:'1', staffName:'Alice', shiftId:String(i), role:'Cook',
    dayOfWeek: day, startTime:'9am', endTime:'5pm', shiftName:`${day} Shift`,
  }))
  const roles = [{ roleName:'Cook', hourlyRate:15 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  assert.equal(result[0].totalWeeklyOTHours, 0) // exactly 40hrs
})

test('calculateWeeklyPayWithOT: 6th shift triggers weekly OT', () => {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const assignments = days.map((day, i) => ({
    staffId:'1', staffName:'Alice', shiftId:String(i), role:'Cook',
    dayOfWeek: day, startTime:'9am', endTime:'5pm', shiftName:`${day} Shift`,
  }))
  const roles = [{ roleName:'Cook', hourlyRate:15 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  assert.equal(result[0].totalWeeklyOTHours, 8) // 48hrs total → 8 OT
})

// ── Formatting ─────────────────────────────────────────────────────────
test('formatPayBreakdownWithOT: contains staff name', () => {
  const summary = {
    staffName: 'Marcus', roleName: 'Chef', hourlyRate: 15,
    shifts: [{ shiftName:'Lunch', dayOfWeek:'Monday', startTime:'11am', endTime:'5pm',
               regularHours:6, dailyOTHours:0, weeklyOTHours:0,
               regularPay:90, dailyOTPay:0, weeklyOTPay:0,
               lateMinutes:0, lateDeduction:0, grossPay:90 }],
    totalEffectiveHours: 6, totalGrossPay: 90,
  }
  assert.ok(formatPayBreakdownWithOT(summary, baseSettings).includes('Marcus'))
})

test('formatPayBreakdownWithOT: no OT lines when no OT', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName:'S', dayOfWeek:'Mon', startTime:'9am', endTime:'5pm',
               regularHours:8, dailyOTHours:0, weeklyOTHours:0,
               regularPay:120, dailyOTPay:0, weeklyOTPay:0,
               lateMinutes:0, lateDeduction:0, grossPay:120 }],
    totalEffectiveHours: 8, totalGrossPay: 120,
  }
  const text = formatPayBreakdownWithOT(summary, baseSettings)
  assert.ok(!text.includes('Daily OT'))
  assert.ok(!text.includes('Weekly OT'))
})

test('formatPayBreakdownWithOT: daily OT line when dailyOT > 0', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName:'S', dayOfWeek:'Mon', startTime:'9am', endTime:'6pm',
               regularHours:8, dailyOTHours:1, weeklyOTHours:0,
               regularPay:120, dailyOTPay:22.5, weeklyOTPay:0,
               lateMinutes:0, lateDeduction:0, grossPay:142.5 }],
    totalEffectiveHours: 9, totalGrossPay: 142.5,
  }
  assert.ok(formatPayBreakdownWithOT(summary, dailySettings).includes('Daily OT'))
})

test('formatPayBreakdownWithOT: weekly OT line when weeklyOT > 0', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName:'S', dayOfWeek:'Mon', startTime:'9am', endTime:'5pm',
               regularHours:0, dailyOTHours:0, weeklyOTHours:8,
               regularPay:0, dailyOTPay:0, weeklyOTPay:180,
               lateMinutes:0, lateDeduction:0, grossPay:180 }],
    totalEffectiveHours: 8, totalGrossPay: 180,
  }
  assert.ok(formatPayBreakdownWithOT(summary, baseSettings).includes('Weekly OT'))
})

test('formatPayBreakdownWithOT: late line when lateMinutes > 0', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName:'S', dayOfWeek:'Mon', startTime:'9am', endTime:'5pm',
               regularHours:7.5, dailyOTHours:0, weeklyOTHours:0,
               regularPay:112.5, dailyOTPay:0, weeklyOTPay:0,
               lateMinutes:30, lateDeduction:7.5, grossPay:112.5 }],
    totalEffectiveHours: 7.5, totalGrossPay: 112.5,
  }
  const text = formatPayBreakdownWithOT(summary, baseSettings)
  assert.ok(text.toLowerCase().includes('late'))
})

test('formatPayBreakdownWithOT: total = sum of all pay types', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName:'S', dayOfWeek:'Mon', startTime:'9am', endTime:'6pm',
               regularHours:8, dailyOTHours:1, weeklyOTHours:0,
               regularPay:120, dailyOTPay:22.5, weeklyOTPay:0,
               lateMinutes:0, lateDeduction:0, grossPay:142.5 }],
    totalEffectiveHours: 9, totalGrossPay: 142.5,
  }
  const text = formatPayBreakdownWithOT(summary, dailySettings)
  assert.ok(text.includes('142.50'))
})
