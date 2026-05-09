// Pure pay calculation functions — no DB, no Groq.

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, ' ')

  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2])

  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (m12) {
    let h = parseInt(m12[1])
    const min = parseInt(m12[2] ?? '0')
    if (m12[3] === 'pm' && h !== 12) h += 12
    if (m12[3] === 'am' && h === 12) h = 0
    return h * 60 + min
  }
  return 0
}

function shiftDurationHours(startTime, endTime) {
  const startMin = parseTimeToMinutes(startTime)
  const endMin = parseTimeToMinutes(endTime)
  let diff = endMin - startMin
  if (diff <= 0) diff += 24 * 60
  return diff / 60
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * Calculate pay for a single shift assignment.
 *
 * @param {object} shift  - { name, dayOfWeek, startTime, endTime }
 * @param {object} role   - { roleName, hourlyRate }
 * @param {number} lateMinutes  - minutes late (default 0)
 * @param {string|null} partialFrom - partial shift start time override
 * @param {string|null} partialUntil - partial shift end time override
 */
export function calculateShiftPay(shift, role, lateMinutes = 0, partialFrom = null, partialUntil = null) {
  const hourlyRate = role.hourlyRate ?? 0

  // Step 1 — hours worked (full or partial)
  let hoursScheduled
  let hoursWorked
  if (partialFrom && partialUntil) {
    hoursScheduled = shiftDurationHours(shift.startTime ?? shift.start_time, shift.endTime ?? shift.end_time)
    hoursWorked = shiftDurationHours(partialFrom, partialUntil)
  } else {
    hoursScheduled = shiftDurationHours(shift.startTime ?? shift.start_time, shift.endTime ?? shift.end_time)
    hoursWorked = hoursScheduled
  }

  // Step 2 — deduct late time
  const lateHours = (lateMinutes ?? 0) / 60
  const effectiveHours = Math.max(0, hoursWorked - lateHours)
  const lateDeduction = round2((hoursWorked - effectiveHours) * hourlyRate)

  // Step 3 — gross pay
  const grossPay = round2(effectiveHours * hourlyRate)

  const breakdown = `${shift.name ?? 'Shift'} (${shift.dayOfWeek ?? ''}) — ${hoursScheduled.toFixed(1)}hrs @ $${hourlyRate}/hr`

  return {
    shiftName: shift.name ?? 'Shift',
    dayOfWeek: shift.dayOfWeek ?? '',
    hoursScheduled: round2(hoursScheduled),
    hoursWorked: round2(effectiveHours),
    lateMinutes: lateMinutes ?? 0,
    lateDeduction,
    hourlyRate,
    grossPay,
    breakdown,
  }
}

/**
 * Format a pay record as a readable string.
 */
export function formatPayBreakdown(payRecord) {
  const { shiftName, dayOfWeek, hoursWorked, hourlyRate, lateMinutes, lateDeduction, grossPay } = payRecord
  let text = `${shiftName} (${dayOfWeek})\n`
  text += `Hours: ${hoursWorked.toFixed(1)}hrs @ $${hourlyRate}/hr`
  if (lateMinutes > 0) {
    text += `\nLate deduction: ${lateMinutes}min (-$${lateDeduction.toFixed(2)})`
  }
  text += `\nGross: $${grossPay.toFixed(2)}`
  return text
}

/**
 * Calculate weekly pay for all staff.
 *
 * @param {Array} assignments   - [{ staffId, staffName, shiftId, role, startTime, endTime, dayOfWeek, shiftName }]
 * @param {Array} shifts        - [{ id, name, dayOfWeek, startTime, endTime }]
 * @param {Array} roles         - [{ roleName, hourlyRate }]
 * @param {Array} lateEvents    - [{ staffId, minutesLate, shiftId }] (optional)
 * @param {Array} partialCoverage - (optional, not yet used)
 * @returns {Array} sorted by staffName ASC
 */
export function calculateWeeklyPay(assignments, shifts, roles, lateEvents = [], partialCoverage = []) {
  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
  const roleMap = Object.fromEntries((roles ?? []).map(r => [r.roleName?.toLowerCase(), r]))

  // Index late events by staffId+shiftId for quick lookup
  const lateMap = {}
  for (const ev of (lateEvents ?? [])) {
    const key = `${ev.staffId}:${ev.shiftId}`
    lateMap[key] = (lateMap[key] ?? 0) + (ev.minutesLate ?? 0)
  }

  const staffMap = {}
  for (const a of (assignments ?? [])) {
    const staffId = String(a.staffId ?? a.staff_id)
    const staffName = a.staffName ?? a.name ?? 'Unknown'

    const shiftId = String(a.shiftId ?? a.shift_id ?? '')
    const shiftData = shiftMap[shiftId] ?? {}

    const shiftObj = {
      name: a.shiftName ?? shiftData.name ?? 'Shift',
      dayOfWeek: a.dayOfWeek ?? shiftData.dayOfWeek ?? shiftData.day_of_week ?? '',
      startTime: a.startTime ?? shiftData.startTime ?? shiftData.start_time,
      endTime: a.endTime ?? shiftData.endTime ?? shiftData.end_time,
    }

    const roleName = a.role ?? a.roleName ?? ''
    const roleObj = roleMap[roleName.toLowerCase()] ?? { roleName, hourlyRate: 0 }
    const lateMinutes = lateMap[`${staffId}:${shiftId}`] ?? 0

    const payRecord = calculateShiftPay(shiftObj, roleObj, lateMinutes)

    if (!staffMap[staffId]) {
      staffMap[staffId] = {
        staffId,
        staffName,
        shifts: [],
        totalHours: 0,
        totalLateMinutes: 0,
        totalLateDeduction: 0,
        totalGrossPay: 0,
      }
    }

    const entry = staffMap[staffId]
    entry.shifts.push(payRecord)
    entry.totalHours = round2(entry.totalHours + payRecord.hoursWorked)
    entry.totalLateMinutes += payRecord.lateMinutes
    entry.totalLateDeduction = round2(entry.totalLateDeduction + payRecord.lateDeduction)
    entry.totalGrossPay = round2(entry.totalGrossPay + payRecord.grossPay)
  }

  return Object.values(staffMap).sort((a, b) => a.staffName.localeCompare(b.staffName))
}

// ── Overtime-aware calculation ────────────────────────────────────────

/**
 * Parse time string to decimal hours.
 * Reuses internal parseTimeToMinutes helper.
 */
export function parseTimeToDecimalHours(timeStr) {
  return parseTimeToMinutes(timeStr) / 60
}

const DEFAULT_OT_SETTINGS = {
  overtime_enabled: false,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_threshold: 0,
  daily_overtime_enabled: false,
  daily_multiplier: 1.5,
}

/**
 * Calculate a single shift's pay with overtime support.
 * Pure function — no DB, no Groq, no side effects.
 */
export function calculateShiftPayWithOT(shift, role, hoursWorkedThisWeekBefore, overtimeSettings, lateMinutes = 0, partialFrom = null, partialUntil = null) {
  // BUG A1 (BH.33): coerce null/undefined overtimeSettings to safe defaults
  const ot = overtimeSettings != null ? overtimeSettings : { ...DEFAULT_OT_SETTINGS }

  const hourlyRate = role.hourlyRate ?? 0
  const startTime = shift.startTime ?? shift.start_time ?? '9am'
  const endTime   = shift.endTime   ?? shift.end_time   ?? '5pm'

  // Step 1 — effective hours
  const hoursScheduled = shiftDurationHours(startTime, endTime)
  let hoursWorked
  if (partialFrom != null && partialUntil != null) {
    hoursWorked = Math.max(0, partialUntil - partialFrom)
  } else {
    hoursWorked = hoursScheduled
  }
  const lateHours      = (lateMinutes ?? 0) / 60
  const effectiveHours = Math.max(0, hoursWorked - lateHours)
  const lateDeduction  = round2(lateHours * hourlyRate)

  // Step 2 — daily OT split
  let dailyRegular, dailyOTHours
  if (ot.daily_overtime_enabled) {
    dailyRegular = Math.min(effectiveHours, ot.daily_threshold)
    dailyOTHours = Math.max(0, effectiveHours - ot.daily_threshold)
  } else {
    dailyRegular = effectiveHours
    dailyOTHours = 0
  }

  // Step 3 — weekly OT split
  let regularHours, weeklyOTHours
  if (ot.overtime_enabled) {
    const weeklyRemaining = Math.max(0, ot.weekly_threshold - (hoursWorkedThisWeekBefore ?? 0))
    regularHours  = Math.min(dailyRegular, weeklyRemaining)
    weeklyOTHours = Math.max(0, dailyRegular - weeklyRemaining)
  } else {
    regularHours  = dailyRegular
    weeklyOTHours = 0
  }

  // Step 4 — pay amounts
  const regularPay  = round2(regularHours  * hourlyRate)
  const dailyOTPay  = round2(dailyOTHours  * hourlyRate * (ot.daily_multiplier  ?? 1.5))
  const weeklyOTPay = round2(weeklyOTHours * hourlyRate * (ot.weekly_multiplier ?? 1.5))
  const grossPay    = round2(regularPay + dailyOTPay + weeklyOTPay)

  return {
    shiftName:      shift.name ?? 'Shift',
    dayOfWeek:      shift.dayOfWeek ?? shift.day_of_week ?? '',
    startTime,
    endTime,
    hoursScheduled: round2(hoursScheduled),
    hoursWorked:    round2(hoursWorked),
    effectiveHours: round2(effectiveHours),
    regularHours:   round2(regularHours),
    dailyOTHours:   round2(dailyOTHours),
    weeklyOTHours:  round2(weeklyOTHours),
    regularPay,
    dailyOTPay,
    weeklyOTPay,
    lateMinutes:    lateMinutes ?? 0,
    lateDeduction,
    grossPay,
  }
}

const DAY_ORDER = {
  mon:1, tue:2, wed:3, thu:4, fri:5, sat:6, sun:7,
  monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:7,
}

function dayRank(dayOfWeek) {
  return DAY_ORDER[(dayOfWeek ?? '').toLowerCase()] ?? 99
}

/**
 * Calculate weekly pay for all staff with overtime support.
 * Returns array sorted by staffName ASC.
 */
export function calculateWeeklyPayWithOT(assignments, shifts, roles, overtimeSettings, lateEvents = [], partialCoverages = [], timeEntries = []) {
  // BUG A1 (BH.33): coerce null/undefined overtimeSettings to safe defaults
  const safeOT = overtimeSettings != null ? overtimeSettings : { ...DEFAULT_OT_SETTINGS }

  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
  const roleMap  = Object.fromEntries((roles ?? []).map(r => [r.roleName?.toLowerCase(), r]))

  const lateMap = {}
  for (const ev of (lateEvents ?? [])) {
    const key = `${ev.staffId}:${ev.shiftId}`
    lateMap[key] = (lateMap[key] ?? 0) + (ev.minutesLate ?? 0)
  }

  const partialMap = {}
  for (const p of (partialCoverages ?? [])) {
    partialMap[`${p.staffId}:${p.shiftId}`] = p
  }

  // Time entries: map by staff_id+shift_id for actual hours lookup
  const timeEntryMap = {}
  for (const te of (timeEntries ?? [])) {
    if (!te.clock_in || !te.clock_out) continue
    const key = `${te.staff_id}:${te.shift_id}`
    const ms = new Date(te.clock_out).getTime() - new Date(te.clock_in).getTime()
    timeEntryMap[key] = ms / 3600000 // hours
  }

  const staffMap = {}
  for (const a of (assignments ?? [])) {
    const staffId   = String(a.staffId ?? a.staff_id)
    const staffName = a.staffName ?? a.name ?? 'Unknown'
    const shiftId   = String(a.shiftId ?? a.shift_id ?? '')
    const shiftData = shiftMap[shiftId] ?? {}
    const shiftObj  = {
      name:      a.shiftName ?? shiftData.name ?? 'Shift',
      dayOfWeek: a.dayOfWeek ?? shiftData.dayOfWeek ?? shiftData.day_of_week ?? '',
      startTime: a.startTime ?? shiftData.startTime ?? shiftData.start_time,
      endTime:   a.endTime   ?? shiftData.endTime   ?? shiftData.end_time,
    }
    const roleName = a.role ?? a.roleName ?? ''
    const roleObj  = roleMap[roleName.toLowerCase()] ?? { roleName, hourlyRate: 0 }

    if (!staffMap[staffId]) {
      staffMap[staffId] = {
        staffId,
        staffName,
        // Track every distinct role this staff worked this week so multi-role
        // staff (server $15 + barback $20) get correct totals and displays.
        // The legacy `roleName`/`hourlyRate` fields below carry the FIRST role
        // for back-compat; consumers wanting accuracy should use rolesWorked /
        // weightedRegularRate / roleNameDisplay computed below.
        roleName,
        hourlyRate: roleObj.hourlyRate,
        rawAssignments: [],
      }
    }
    staffMap[staffId].rawAssignments.push({ shiftObj, shiftId, roleObj })
  }

  const result = []
  for (const entry of Object.values(staffMap)) {
    // Sort chronologically: day rank first, then by startTime within same day
    entry.rawAssignments.sort((x, y) => {
      const dayDiff = dayRank(x.shiftObj.dayOfWeek) - dayRank(y.shiftObj.dayOfWeek)
      if (dayDiff !== 0) return dayDiff
      return parseTimeToMinutes(x.shiftObj.startTime) - parseTimeToMinutes(y.shiftObj.startTime)
    })

    let runningHours = 0
    const shiftResults = []
    for (const { shiftObj, shiftId, roleObj } of entry.rawAssignments) {
      const lateMinutes = lateMap[`${entry.staffId}:${shiftId}`] ?? 0
      const partial     = partialMap[`${entry.staffId}:${shiftId}`]
      // Use actual hours from time clock if available
      const actualHours = timeEntryMap[`${entry.staffId}:${shiftId}`]
      const useActual   = actualHours != null
      const pr = calculateShiftPayWithOT(
        shiftObj, roleObj, runningHours, safeOT,
        lateMinutes,
        useActual ? 0 : (partial?.partialFrom ?? null),
        useActual ? actualHours : (partial?.partialUntil ?? null),
      )
      pr.hoursSource = useActual ? 'actual' : 'scheduled'
      runningHours = round2(runningHours + pr.effectiveHours)
      shiftResults.push(pr)
    }

    // Multi-role aggregation: build a per-role hours+pay map for this staff so
    // downstream consumers (spreadsheet, dashboard, audit log) can show accurate
    // breakdowns instead of pretending the staff only worked one role.
    const roleAgg = new Map()
    for (let i = 0; i < entry.rawAssignments.length; i++) {
      const { roleObj } = entry.rawAssignments[i]
      const pr = shiftResults[i]
      const key = (roleObj.roleName || '').toLowerCase()
      if (!roleAgg.has(key)) {
        roleAgg.set(key, {
          roleName: roleObj.roleName || '',
          hourlyRate: roleObj.hourlyRate ?? 0,
          regularHours: 0, dailyOTHours: 0, weeklyOTHours: 0,
          regularPay: 0, dailyOTPay: 0, weeklyOTPay: 0,
          totalHours: 0, totalGrossPay: 0,
        })
      }
      const a = roleAgg.get(key)
      a.regularHours  += pr.regularHours
      a.dailyOTHours  += pr.dailyOTHours
      a.weeklyOTHours += pr.weeklyOTHours
      a.regularPay    += pr.regularPay
      a.dailyOTPay    += pr.dailyOTPay
      a.weeklyOTPay   += pr.weeklyOTPay
      a.totalHours    += pr.effectiveHours
      a.totalGrossPay += pr.grossPay
    }
    const rolesWorked = Array.from(roleAgg.values()).map(a => ({
      roleName: a.roleName,
      hourlyRate: a.hourlyRate,
      regularHours: round2(a.regularHours),
      dailyOTHours: round2(a.dailyOTHours),
      weeklyOTHours: round2(a.weeklyOTHours),
      regularPay: round2(a.regularPay),
      dailyOTPay: round2(a.dailyOTPay),
      weeklyOTPay: round2(a.weeklyOTPay),
      totalHours: round2(a.totalHours),
      totalGrossPay: round2(a.totalGrossPay),
    }))

    const totalRegularHours = round2(shiftResults.reduce((s, r) => s + r.regularHours, 0))
    const totalRegularPay   = round2(shiftResults.reduce((s, r) => s + r.regularPay, 0))
    // Weighted-average regular rate for cross-trained staff. If they only worked
    // one role this is the same as their hourly rate; if they worked multiple
    // roles it's the rate that, multiplied by total regular hours, gives back
    // the correct total regular pay. Used by the spreadsheet so cell formulas
    // continue to balance across mixed-rate weeks.
    const weightedRegularRate = totalRegularHours > 0
      ? round2(totalRegularPay / totalRegularHours)
      : (entry.hourlyRate ?? 0)
    const roleNameDisplay = rolesWorked.length <= 1
      ? (rolesWorked[0]?.roleName ?? entry.roleName ?? '')
      : rolesWorked.map(r => r.roleName).filter(Boolean).join(' / ')

    result.push({
      staffId:             entry.staffId,
      staffName:           entry.staffName,
      roleName:            entry.roleName,        // legacy: first-seen role
      hourlyRate:          entry.hourlyRate,      // legacy: first-seen rate
      roleNameDisplay,                            // multi-role aware
      weightedRegularRate,                        // multi-role aware
      rolesWorked,                                // per-role breakdown
      shifts:              shiftResults,
      totalHours:          round2(shiftResults.reduce((s, r) => s + r.hoursWorked, 0)),
      totalEffectiveHours: round2(shiftResults.reduce((s, r) => s + r.effectiveHours, 0)),
      totalRegularHours,
      totalDailyOTHours:   round2(shiftResults.reduce((s, r) => s + r.dailyOTHours, 0)),
      totalWeeklyOTHours:  round2(shiftResults.reduce((s, r) => s + r.weeklyOTHours, 0)),
      totalLateMinutes:    shiftResults.reduce((s, r) => s + r.lateMinutes, 0),
      totalLateDeduction:  round2(shiftResults.reduce((s, r) => s + r.lateDeduction, 0)),
      totalRegularPay,
      totalDailyOTPay:     round2(shiftResults.reduce((s, r) => s + r.dailyOTPay, 0)),
      totalWeeklyOTPay:    round2(shiftResults.reduce((s, r) => s + r.weeklyOTPay, 0)),
      totalGrossPay:       round2(shiftResults.reduce((s, r) => s + r.grossPay, 0)),
    })
  }

  return result.sort((a, b) => a.staffName.localeCompare(b.staffName))
}

/**
 * Format pay breakdown with OT detail for manager view.
 */
export function formatPayBreakdownWithOT(staffSummary, overtimeSettings) {
  const ot = overtimeSettings != null ? overtimeSettings : { ...DEFAULT_OT_SETTINGS }
  const { staffName, shifts, totalGrossPay, totalEffectiveHours } = staffSummary
  // Prefer multi-role-aware display fields when present.
  const displayRole = staffSummary.roleNameDisplay ?? staffSummary.roleName ?? ''
  const displayRate = staffSummary.weightedRegularRate ?? staffSummary.hourlyRate ?? 0
  let text = `${staffName} (${displayRole}) — $${displayRate}/hr\n\n`

  for (const s of (shifts ?? [])) {
    text += `${s.shiftName} (${s.dayOfWeek}, ${s.startTime}–${s.endTime})\n`
    text += `  Regular: ${s.regularHours.toFixed(1)}hrs = $${s.regularPay.toFixed(2)}\n`
    if ((s.dailyOTHours ?? 0) > 0) {
      text += `  Daily OT: ${s.dailyOTHours.toFixed(1)}hrs @ ${ot.daily_multiplier}x = $${s.dailyOTPay.toFixed(2)}\n`
    }
    if ((s.weeklyOTHours ?? 0) > 0) {
      text += `  Weekly OT: ${s.weeklyOTHours.toFixed(1)}hrs @ ${ot.weekly_multiplier}x = $${s.weeklyOTPay.toFixed(2)}\n`
    }
    if ((s.lateMinutes ?? 0) > 0) {
      text += `  ⚠️ Late ${s.lateMinutes}min: -$${s.lateDeduction.toFixed(2)}\n`
    }
    text += `  Shift total: $${s.grossPay.toFixed(2)}\n\n`
  }

  text += `────────────────\n`
  text += `Total: ${(totalEffectiveHours ?? 0).toFixed(1)}hrs → *$${(totalGrossPay ?? 0).toFixed(2)}*`
  return text
}
