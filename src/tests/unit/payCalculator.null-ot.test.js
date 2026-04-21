// BUG A1 (BH.33): null/undefined overtimeSettings must never crash calculateWeeklyPayWithOT
// or calculateShiftPayWithOT — they must fall back to safe defaults.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateWeeklyPayWithOT, calculateShiftPayWithOT } from '../../payroll/payCalculator.js'

const SHIFTS = [
  { id: 1, name: 'Morning', dayOfWeek: 'Monday', startTime: '09:00', endTime: '17:00' },
]
const ROLES = [{ roleName: 'X', hourlyRate: 20 }]
const ASSIGNS = [{ staffId: 1, staffName: 'T', shiftId: 1, role: 'X', dayOfWeek: 'Monday' }]

await Promise.all([

  test('calculateWeeklyPayWithOT: null overtimeSettings → no throw, returns results', () => {
    let result
    assert.doesNotThrow(() => {
      result = calculateWeeklyPayWithOT(ASSIGNS, SHIFTS, ROLES, null, [], [], [])
    })
    assert.equal(Array.isArray(result), true)
    assert.equal(result.length, 1)
  }),

  test('calculateWeeklyPayWithOT: null overtimeSettings → zero OT hours', () => {
    const result = calculateWeeklyPayWithOT(ASSIGNS, SHIFTS, ROLES, null, [], [], [])
    const staff = result[0]
    assert.equal(staff.totalDailyOTHours, 0, 'no daily OT expected with null settings (defaults disable it)')
    assert.equal(staff.totalWeeklyOTHours, 0, 'no weekly OT expected with null settings (defaults disable it)')
  }),

  test('calculateWeeklyPayWithOT: null overtimeSettings → correct regular pay', () => {
    const result = calculateWeeklyPayWithOT(ASSIGNS, SHIFTS, ROLES, null, [], [], [])
    const staff = result[0]
    // 8hrs @ $20 = $160, all regular
    assert.ok(Math.abs(staff.totalGrossPay - 160) < 0.01, `Expected 160, got ${staff.totalGrossPay}`)
    assert.ok(Math.abs(staff.totalRegularPay - 160) < 0.01, `Expected regular 160, got ${staff.totalRegularPay}`)
  }),

  test('calculateWeeklyPayWithOT: undefined overtimeSettings → no throw', () => {
    assert.doesNotThrow(() => {
      calculateWeeklyPayWithOT(ASSIGNS, SHIFTS, ROLES, undefined, [], [], [])
    })
  }),

  test('calculateShiftPayWithOT: null overtimeSettings → no throw, correct pay', () => {
    const shift = { name: 'Morning', dayOfWeek: 'Monday', startTime: '09:00', endTime: '17:00' }
    const role = { roleName: 'X', hourlyRate: 20 }
    let result
    assert.doesNotThrow(() => {
      result = calculateShiftPayWithOT(shift, role, 0, null)
    })
    // 8hrs @ $20 = $160
    assert.ok(Math.abs(result.grossPay - 160) < 0.01, `Expected 160, got ${result.grossPay}`)
    assert.equal(result.dailyOTHours, 0)
    assert.equal(result.weeklyOTHours, 0)
  }),

  test('calculateShiftPayWithOT: undefined overtimeSettings → no throw', () => {
    const shift = { name: 'Morning', dayOfWeek: 'Monday', startTime: '09:00', endTime: '17:00' }
    const role = { roleName: 'X', hourlyRate: 20 }
    assert.doesNotThrow(() => {
      calculateShiftPayWithOT(shift, role, 0, undefined)
    })
  }),

  test('calculateWeeklyPayWithOT: valid overtimeSettings still works (regression)', () => {
    const otSettings = {
      overtime_enabled: true,
      weekly_threshold: 8,
      weekly_multiplier: 1.5,
      daily_overtime_enabled: false,
      daily_threshold: 0,
      daily_multiplier: 1.5,
    }
    const result = calculateWeeklyPayWithOT(ASSIGNS, SHIFTS, ROLES, otSettings, [], [], [])
    const staff = result[0]
    // 8hrs — exactly at threshold, 0 OT
    assert.equal(staff.totalWeeklyOTHours, 0, 'exactly at threshold = no OT')
    assert.ok(Math.abs(staff.totalGrossPay - 160) < 0.01)
  }),

])
