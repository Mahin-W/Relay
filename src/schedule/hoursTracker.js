// Weekly hours tracking: calculates scheduled hours per staff member
// and flags overtime (≥40h) or under-scheduling (<8h).

// Parses time strings to minutes from midnight.
// Handles: "23:00", "11:00 PM", "11pm", "9:00 AM", "9am"
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
  if (diff <= 0) diff += 24 * 60 // crosses midnight
  return diff / 60
}

// Pure function — no DB, no Groq.
// assignments: array of { staffId|staff_id, staffName|name, shiftId|shift_id, startTime|start_time, endTime|end_time }
// shifts: array of { id, startTime|start_time, endTime|end_time } (used as fallback)
// Returns: { [staffId]: { staffName, totalHours, shiftCount } }
export function calculateWeeklyHours(assignments, shifts) {
  const shiftMap = {}
  for (const s of (shifts ?? [])) {
    shiftMap[String(s.id)] = {
      startTime: s.startTime ?? s.start_time,
      endTime: s.endTime ?? s.end_time,
    }
  }

  const result = {}
  for (const a of assignments) {
    const staffId = String(a.staffId ?? a.staff_id)
    const staffName = a.staffName ?? a.name ?? 'Unknown'
    const shiftId = String(a.shiftId ?? a.shift_id ?? '')
    const fromMap = shiftMap[shiftId]

    const startTime = a.startTime ?? a.start_time ?? fromMap?.startTime
    const endTime = a.endTime ?? a.end_time ?? fromMap?.endTime
    const hours = shiftDurationHours(startTime, endTime)

    if (!result[staffId]) {
      result[staffId] = { staffName, totalHours: 0, shiftCount: 0 }
    }
    result[staffId].totalHours += hours
    result[staffId].shiftCount++
  }

  return result
}

// overtimeThreshold: hours at or above which staff is flagged (default 40, inclusive)
// underThreshold: hours strictly below which staff is flagged (default 8, exclusive)
export function detectHoursIssues(hoursMap, overtimeThreshold = 40, underThreshold = 8) {
  const overtime = []
  const underScheduled = []

  for (const { staffName, totalHours } of Object.values(hoursMap)) {
    if (totalHours >= overtimeThreshold) {
      overtime.push({ staffName, totalHours: Math.round(totalHours * 10) / 10 })
    } else if (totalHours < underThreshold) {
      underScheduled.push({ staffName, totalHours: Math.round(totalHours * 10) / 10 })
    }
  }

  return { overtime, underScheduled }
}

export function formatHoursWarning(issues) {
  if (!issues) return ''
  const { overtime = [], underScheduled = [] } = issues
  if (overtime.length === 0 && underScheduled.length === 0) return ''

  let out = ''

  if (overtime.length > 0) {
    const lines = overtime.map(s => `• ${s.staffName}: ${s.totalHours.toFixed(1)} hrs`).join('\n')
    out += `\n⚠️ *Overtime risk (40+ hrs):*\n${lines}\n`
  }

  if (underScheduled.length > 0) {
    const lines = underScheduled.map(s => `• ${s.staffName}: ${s.totalHours.toFixed(1)} hrs — is this intentional?`).join('\n')
    out += `\n📊 *Low hours (under 8hrs):*\n${lines}\n`
  }

  return out
}
