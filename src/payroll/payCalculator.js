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
