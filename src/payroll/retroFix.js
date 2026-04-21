// Retroactive payroll recomputation after rate changes.
// BUG A2 (2.05b / 4.04): recalculate past weeks when staff hourly rate changes.
//
// DB functions are loaded lazily to avoid requiring Supabase env at import time.

import { calculateWeeklyPayWithOT } from './payCalculator.js'

// Lazy-load DB helpers so tests can run without Supabase env vars set.
async function loadPayDb() {
  const { savePeriodPayroll, getPayrollHistory } = await import('./payDb.js')
  return { savePeriodPayroll, getPayrollHistory }
}

async function loadScheduleDb() {
  const { getPublishedSchedule } = await import('../availability/db/schedules.js')
  return { getPublishedSchedule }
}

/**
 * Recompute payroll for one staff member for a specific week.
 * Tries to recalculate from schedule assignments; falls back to scaling stored total_hours by new rate.
 *
 * @param {string}        groupId
 * @param {string}        weekStart  - ISO date e.g. '2025-02-03'
 * @param {string|number} staffId
 * @param {object|null}   db         - injectable MockDB / SimulationDb (optional)
 * @returns {Promise<Array<{ staffId, oldGrossPay, newGrossPay, delta }>>}
 */
export async function recomputeWeekPayroll(groupId, weekStart, staffId, db = null) {
  try {
    // ── 1. Load existing payroll record(s) for this week ───────────────────
    let payHistory
    if (db?.getPayrollHistory) {
      payHistory = await db.getPayrollHistory(groupId, staffId)
    } else {
      const { getPayrollHistory } = await loadPayDb()
      payHistory = await getPayrollHistory(staffId, groupId, 52)
    }

    const weekRecord = (payHistory ?? []).find(r => r.week_start === weekStart)
    if (!weekRecord) return []

    const oldGrossPay = weekRecord.total_gross_pay ?? 0

    // ── 2. Load schedule assignments ──────────────────────────────────────
    let assignments
    if (db?.getPublishedSchedule) {
      assignments = await db.getPublishedSchedule(groupId, weekStart)
    } else {
      const { getPublishedSchedule } = await loadScheduleDb()
      assignments = await getPublishedSchedule(groupId)
    }

    const staffAssignments = (assignments ?? []).filter(a =>
      String(a.staffId ?? a.staff_id) === String(staffId)
    )

    // ── 3. Get staff's current hourly rate ────────────────────────────────
    let newRate = null
    if (db?.getStaffMember) {
      const sm = await db.getStaffMember(staffId)
      newRate = sm?.hourlyRate ?? null
    }

    // ── 4. Compute new gross pay ──────────────────────────────────────────
    let newGrossPay = null

    if (staffAssignments.length > 0 && newRate != null) {
      // Full recalculation from shift assignments
      const shifts = db?.getShiftsForGroup
        ? await db.getShiftsForGroup(groupId)
        : []

      const allRoles = db?.getRolesForGroup
        ? await db.getRolesForGroup(groupId)
        : []

      const otSettings = db?.getOvertimeSettings
        ? await db.getOvertimeSettings(groupId)
        : null

      // Build role objects — apply new rate for this staff's role
      const roleMap = {}
      for (const r of (allRoles ?? [])) {
        const key = typeof r === 'string' ? r : (r.role ?? r.roleName ?? '')
        if (key) {
          const rate = typeof r === 'string' ? 0 : (r.rate ?? r.hourlyRate ?? 0)
          roleMap[key.toLowerCase()] = { roleName: key, hourlyRate: rate }
        }
      }

      // Override the role rate for this staff member
      if (newRate != null) {
        const staffObj = db?.staff?.find?.(s => String(s.id) === String(staffId))
        if (staffObj?.role) {
          roleMap[staffObj.role.toLowerCase()] = { roleName: staffObj.role, hourlyRate: newRate }
        }
      }

      const roleArray = Object.values(roleMap)
      const weekPayroll = calculateWeeklyPayWithOT(
        staffAssignments, shifts, roleArray, otSettings, [], [], []
      )

      const staffResult = weekPayroll.find(r => String(r.staffId) === String(staffId))
      if (staffResult && staffResult.totalGrossPay > 0) {
        newGrossPay = staffResult.totalGrossPay
      }
    }

    // Fallback: scale stored hours by new rate (simple, OT-free)
    if (newGrossPay == null) {
      if (newRate != null && weekRecord.total_hours != null) {
        newGrossPay = Math.round(weekRecord.total_hours * newRate * 100) / 100
      } else {
        newGrossPay = oldGrossPay
      }
    }

    const delta = Math.round((newGrossPay - oldGrossPay) * 100) / 100

    // ── 5. Upsert updated payroll record ──────────────────────────────────
    const updatedRow = {
      group_id: groupId,
      staff_id: staffId,
      week_start: weekStart,
      total_hours: weekRecord.total_hours ?? 0,
      total_late_minutes: weekRecord.total_late_minutes ?? 0,
      total_late_deduction: weekRecord.total_late_deduction ?? 0,
      total_gross_pay: newGrossPay,
      shift_breakdown: weekRecord.shift_breakdown ?? [],
    }

    if (db?.savePeriodPayroll) {
      await db.savePeriodPayroll(updatedRow)
    } else {
      const { savePeriodPayroll } = await loadPayDb()
      await savePeriodPayroll(groupId, weekStart, [
        { staffId, totalHours: updatedRow.total_hours, totalLateMinutes: 0,
          totalLateDeduction: 0, totalGrossPay: newGrossPay, shifts: [] }
      ])
    }

    return [{ staffId, oldGrossPay, newGrossPay, delta }]
  } catch (err) {
    // Never crash — always recover (CLAUDE.md rule)
    console.error(`recomputeWeekPayroll error: ${err.message}`)
    return []
  }
}

/**
 * Recompute payroll for ALL weeks a staff member has a payroll_records row.
 *
 * @param {string}        groupId
 * @param {string|number} staffId
 * @param {object|null}   db
 * @returns {Promise<Array<{ staffId, week_start, oldGrossPay, newGrossPay, delta }>>}
 */
export async function recomputeAllWeeksForStaff(groupId, staffId, db = null) {
  try {
    let payHistory
    if (db?.getPayrollHistory) {
      payHistory = await db.getPayrollHistory(groupId, staffId)
    } else {
      const { getPayrollHistory } = await loadPayDb()
      payHistory = await getPayrollHistory(staffId, groupId, 52)
    }

    if (!payHistory || payHistory.length === 0) return []

    const results = []
    for (const record of payHistory) {
      const weekResults = await recomputeWeekPayroll(groupId, record.week_start, staffId, db)
      for (const r of weekResults) {
        results.push({ ...r, week_start: record.week_start })
      }
    }
    return results
  } catch (err) {
    console.error(`recomputeAllWeeksForStaff error: ${err.message}`)
    return []
  }
}
