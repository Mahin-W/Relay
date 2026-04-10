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

/**
 * Calculate a single shift's pay with overtime support.
 * Pure function — no DB, no Groq, no side effects.
 */
export function calculateShiftPayWithOT(shift, role, hoursWorkedThisWeekBefore, overtimeSettings, lateMinutes = 0, partialFrom = null, partialUntil = null) {
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
  if (overtimeSettings.daily_overtime_enabled) {
    dailyRegular = Math.min(effectiveHours, overtimeSettings.daily_threshold)
    dailyOTHours = Math.max(0, effectiveHours - overtimeSettings.daily_threshold)
  } else {
    dailyRegular = effectiveHours
    dailyOTHours = 0
  }

  // Step 3 — weekly OT split
  let regularHours, weeklyOTHours
  if (overtimeSettings.overtime_enabled) {
    const weeklyRemaining = Math.max(0, overtimeSettings.weekly_threshold - (hoursWorkedThisWeekBefore ?? 0))
    regularHours  = Math.min(dailyRegular, weeklyRemaining)
    weeklyOTHours = Math.max(0, dailyRegular - weeklyRemaining)
  } else {
    regularHours  = dailyRegular
    weeklyOTHours = 0
  }

  // Step 4 — pay amounts
  const regularPay  = round2(regularHours  * hourlyRate)
  const dailyOTPay  = round2(dailyOTHours  * hourlyRate * (overtimeSettings.daily_multiplier  ?? 1.5))
  const weeklyOTPay = round2(weeklyOTHours * hourlyRate * (overtimeSettings.weekly_multiplier ?? 1.5))
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
export function calculateWeeklyPayWithOT(assignments, shifts, roles, overtimeSettings, lateEvents = [], partialCoverages = []) {
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
      staffMap[staffId] = { staffId, staffName, roleName, hourlyRate: roleObj.hourlyRate, rawAssignments: [] }
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
      const pr = calculateShiftPayWithOT(
        shiftObj, roleObj, runningHours, overtimeSettings,
        lateMinutes,
        partial?.partialFrom ?? null,
        partial?.partialUntil ?? null,
      )
      runningHours = round2(runningHours + pr.effectiveHours)
      shiftResults.push(pr)
    }

    result.push({
      staffId:             entry.staffId,
      staffName:           entry.staffName,
      roleName:            entry.roleName,
      hourlyRate:          entry.hourlyRate,
      shifts:              shiftResults,
      totalHours:          round2(shiftResults.reduce((s, r) => s + r.hoursWorked, 0)),
      totalEffectiveHours: round2(shiftResults.reduce((s, r) => s + r.effectiveHours, 0)),
      totalRegularHours:   round2(shiftResults.reduce((s, r) => s + r.regularHours, 0)),
      totalDailyOTHours:   round2(shiftResults.reduce((s, r) => s + r.dailyOTHours, 0)),
      totalWeeklyOTHours:  round2(shiftResults.reduce((s, r) => s + r.weeklyOTHours, 0)),
      totalLateMinutes:    shiftResults.reduce((s, r) => s + r.lateMinutes, 0),
      totalLateDeduction:  round2(shiftResults.reduce((s, r) => s + r.lateDeduction, 0)),
      totalRegularPay:     round2(shiftResults.reduce((s, r) => s + r.regularPay, 0)),
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
  const { staffName, roleName, hourlyRate, shifts, totalGrossPay, totalEffectiveHours } = staffSummary
  let text = `${staffName} (${roleName}) — $${hourlyRate}/hr\n\n`

  for (const s of (shifts ?? [])) {
    text += `${s.shiftName} (${s.dayOfWeek}, ${s.startTime}–${s.endTime})\n`
    text += `  Regular: ${s.regularHours.toFixed(1)}hrs = $${s.regularPay.toFixed(2)}\n`
    if ((s.dailyOTHours ?? 0) > 0) {
      text += `  Daily OT: ${s.dailyOTHours.toFixed(1)}hrs @ ${overtimeSettings.daily_multiplier}x = $${s.dailyOTPay.toFixed(2)}\n`
    }
    if ((s.weeklyOTHours ?? 0) > 0) {
      text += `  Weekly OT: ${s.weeklyOTHours.toFixed(1)}hrs @ ${overtimeSettings.weekly_multiplier}x = $${s.weeklyOTPay.toFixed(2)}\n`
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
