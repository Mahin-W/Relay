// BUG A2 (2.05b / 4.04): retroactive payroll recomputation after rate change.
// Uses an extended MockDB that supports payroll operations.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockDB } from '../helpers/mocks.js'
import { recomputeWeekPayroll, recomputeAllWeeksForStaff } from '../../payroll/retroFix.js'

// ── Extended MockDB for payroll testing ────────────────────────────────────────

class PayrollMockDB extends MockDB {
  constructor() {
    super()
    this.payrollRecords = []
    this.roleRates = []
    this.overtimeSettingsMap = []
    this._id = 100

    this.savePeriodPayroll = this.savePeriodPayroll.bind(this)
    this.getPayrollHistory = this.getPayrollHistory.bind(this)
    this.getPayrollForWeek = this.getPayrollForWeek.bind(this)
    this.getPublishedSchedule = this.getPublishedSchedule.bind(this)
    this.getRolesForGroup = this.getRolesForGroup.bind(this)
    this.getOvertimeSettings = this.getOvertimeSettings.bind(this)
    this.getStaffMember = this.getStaffMember.bind(this)
    this.updateRoleRate = this.updateRoleRate.bind(this)
    this.getShiftsForGroup = this.getShiftsForGroup.bind(this)
  }

  async savePeriodPayroll(row) {
    const key = r => r.group_id === row.group_id && r.staff_id === row.staff_id && r.week_start === row.week_start
    const idx = this.payrollRecords.findIndex(key)
    if (idx >= 0) {
      this.payrollRecords[idx] = { ...this.payrollRecords[idx], ...row }
    } else {
      this.payrollRecords.push({ id: this._nextId(), ...row })
    }
    return this.payrollRecords[idx >= 0 ? idx : this.payrollRecords.length - 1]
  }

  async getPayrollHistory(groupId, staffId, weeksBack = 52) {
    return this.payrollRecords.filter(r =>
      r.group_id === String(groupId) &&
      (staffId == null || r.staff_id === staffId || String(r.staff_id) === String(staffId))
    )
  }

  async getPayrollForWeek(groupId, weekStart) {
    return this.payrollRecords.filter(r =>
      r.group_id === String(groupId) && r.week_start === weekStart
    )
  }

  async getPublishedSchedule(groupId, weekStart = null) {
    return this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) && (!weekStart || a.week_start === weekStart)
    )
  }

  async getShiftsForGroup(groupId) {
    return this.shifts.filter(s => s.group_id === String(groupId))
  }

  async getRolesForGroup(groupId) {
    return this.roleRates.filter(r => r.group_id === String(groupId))
  }

  async getOvertimeSettings(groupId) {
    return this.overtimeSettingsMap.find(s => s.group_id === String(groupId)) ?? {
      overtime_enabled: false,
      weekly_threshold: 40,
      weekly_multiplier: 1.5,
      daily_overtime_enabled: false,
      daily_threshold: 0,
      daily_multiplier: 1.5,
    }
  }

  async getStaffMember(staffId) {
    return this.staff.find(s => s.id === staffId || String(s.id) === String(staffId)) ?? null
  }

  async updateRoleRate(groupId, role, rate) {
    const idx = this.roleRates.findIndex(r => r.group_id === String(groupId) && r.role === role)
    if (idx >= 0) {
      this.roleRates[idx].rate = rate
    } else {
      this.roleRates.push({ id: this._nextId(), group_id: String(groupId), role, rate })
    }
  }

  _nextId() {
    return this._id++
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDb() {
  const db = new PayrollMockDB()
  // Seed staff member Sam with initial rate $19
  db.staff.push({ id: 1015, group_id: 'grp-1', name: 'Sam', role: 'Chef', hourlyRate: 19 })
  // Seed payroll records for Sam at $19
  db.payrollRecords.push({
    id: 1, group_id: 'grp-1', staff_id: 1015, week_start: '2025-01-27',
    total_hours: 25, total_late_minutes: 0, total_late_deduction: 0,
    total_gross_pay: 475.00, // 25 * 19
    shift_breakdown: [],
  })
  db.payrollRecords.push({
    id: 2, group_id: 'grp-1', staff_id: 1015, week_start: '2025-02-03',
    total_hours: 30, total_late_minutes: 0, total_late_deduction: 0,
    total_gross_pay: 570.00, // 30 * 19
    shift_breakdown: [],
  })
  return db
}

// ── Tests ──────────────────────────────────────────────────────────────────────

await Promise.all([

  test('recomputeWeekPayroll: returns delta array with correct values', async () => {
    const db = makeDb()
    // Update Sam's rate to $21
    db.staff[0].hourlyRate = 21
    const results = await recomputeWeekPayroll('grp-1', '2025-01-27', 1015, db)
    assert.equal(results.length, 1)
    assert.equal(results[0].staffId, 1015)
    assert.ok(Math.abs(results[0].oldGrossPay - 475.00) < 0.01, `oldGross should be 475, got ${results[0].oldGrossPay}`)
    assert.ok(Math.abs(results[0].newGrossPay - 525.00) < 0.01, `newGross should be 525, got ${results[0].newGrossPay}`)
    assert.ok(Math.abs(results[0].delta - 50.00) < 0.01, `delta should be 50, got ${results[0].delta}`)
  }),

  test('recomputeWeekPayroll: persists updated gross pay to DB', async () => {
    const db = makeDb()
    db.staff[0].hourlyRate = 21
    await recomputeWeekPayroll('grp-1', '2025-02-03', 1015, db)
    const updated = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-02-03')
    assert.ok(updated, 'payroll record should exist')
    assert.ok(Math.abs(updated.total_gross_pay - 630.00) < 0.01, `expected 630 (30h * 21), got ${updated.total_gross_pay}`)
  }),

  test('recomputeWeekPayroll: no-op when week has no payroll record', async () => {
    const db = makeDb()
    db.staff[0].hourlyRate = 21
    const results = await recomputeWeekPayroll('grp-1', '2099-01-01', 1015, db)
    assert.deepEqual(results, [], 'should return empty array for nonexistent week')
  }),

  test('recomputeWeekPayroll: never throws on any input', async () => {
    await assert.doesNotReject(recomputeWeekPayroll(null, null, null, null))
    await assert.doesNotReject(recomputeWeekPayroll('g', '2025-01-01', 999, null))
  }),

  test('recomputeAllWeeksForStaff: updates ALL historical weeks', async () => {
    const db = makeDb()
    // Simulate rate change to $21
    db.staff[0].hourlyRate = 21
    const results = await recomputeAllWeeksForStaff('grp-1', 1015, db)
    assert.equal(results.length, 2, 'should return delta for each payroll week')

    // Both weeks should now reflect $21 rate
    const w1 = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-01-27')
    const w2 = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-02-03')
    assert.ok(Math.abs(w1.total_gross_pay - 525.00) < 0.01, `w1 should be 525, got ${w1.total_gross_pay}`)
    assert.ok(Math.abs(w2.total_gross_pay - 630.00) < 0.01, `w2 should be 630, got ${w2.total_gross_pay}`)
  }),

  test('recomputeAllWeeksForStaff: implied rate matches new rate after update', async () => {
    const db = makeDb()
    db.staff[0].hourlyRate = 21
    await recomputeAllWeeksForStaff('grp-1', 1015, db)

    for (const rec of db.payrollRecords.filter(r => r.staff_id === 1015)) {
      const impliedRate = Math.round((rec.total_gross_pay / rec.total_hours) * 100) / 100
      assert.ok(
        Math.abs(impliedRate - 21) < 0.5,
        `implied rate should be ~21 for week ${rec.week_start}, got ${impliedRate}`
      )
    }
  }),

  test('recomputeAllWeeksForStaff: returns empty array when staff has no payroll', async () => {
    const db = makeDb()
    const results = await recomputeAllWeeksForStaff('grp-1', 9999, db)
    assert.deepEqual(results, [])
  }),

  test('recomputeAllWeeksForStaff: never throws with null db', async () => {
    await assert.doesNotReject(recomputeAllWeeksForStaff('grp-1', 1015, null))
  }),

  // ── P1-21: retroactive reprice must never lower already-worked pay ────────────

  test('P1-21: rate DECREASE does not reduce past-week gross pay (recomputeWeekPayroll)', async () => {
    // Sam was paid 25h * $19 = $475 for week 2025-01-27.
    // Rate drops to $15. New computed total = 25 * $15 = $375 < $475.
    // Guard must keep recorded total at $475 (never lower).
    const db = makeDb()
    db.staff[0].hourlyRate = 15  // rate DECREASE from $19 → $15
    const results = await recomputeWeekPayroll('grp-1', '2025-01-27', 1015, db)
    assert.equal(results.length, 1)
    // newGrossPay must not be lower than oldGrossPay
    assert.ok(
      results[0].newGrossPay >= results[0].oldGrossPay - 0.005,
      `newGrossPay (${results[0].newGrossPay}) must not be less than oldGrossPay (${results[0].oldGrossPay}) on rate decrease`
    )
    // The DB record must also retain the original (higher) value
    const record = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-01-27')
    assert.ok(
      record.total_gross_pay >= 475.00 - 0.005,
      `DB record (${record.total_gross_pay}) must not drop below original 475.00 on rate decrease`
    )
  }),

  test('P1-21: rate DECREASE across all weeks leaves past pay unchanged (recomputeAllWeeksForStaff)', async () => {
    // Both weeks were paid at $19. Rate drops to $15.
    // Neither week's recorded gross should be reduced.
    const db = makeDb()
    db.staff[0].hourlyRate = 15
    await recomputeAllWeeksForStaff('grp-1', 1015, db)

    const w1 = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-01-27')
    const w2 = db.payrollRecords.find(r => r.staff_id === 1015 && r.week_start === '2025-02-03')
    assert.ok(w1.total_gross_pay >= 475.00 - 0.005,
      `w1 should remain >= 475 on decrease, got ${w1.total_gross_pay}`)
    assert.ok(w2.total_gross_pay >= 570.00 - 0.005,
      `w2 should remain >= 570 on decrease, got ${w2.total_gross_pay}`)
  }),

  test('P1-21: rate INCREASE still applies correctly (recomputeWeekPayroll)', async () => {
    // This ensures the guard does not break the increase path.
    // Sam: 25h * $21 = $525 > $475 (old). Should apply.
    const db = makeDb()
    db.staff[0].hourlyRate = 21
    const results = await recomputeWeekPayroll('grp-1', '2025-01-27', 1015, db)
    assert.ok(
      Math.abs(results[0].newGrossPay - 525.00) < 0.01,
      `rate increase should apply: expected 525, got ${results[0].newGrossPay}`
    )
  }),

])
