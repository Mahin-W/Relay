// Clopening detection: flags staff scheduled to close one night and open the next
// with fewer than 10 hours between shifts.

const DAY_NUM = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

// Parses time strings to minutes from midnight.
// Handles: "23:00", "11:00 PM", "11pm", "9:00 AM", "9am"
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, ' ')

  // Pure 24h: "23:00" or "9:00"
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2])

  // 12h: "9:00 am", "9:00am", "11 pm", "11pm", "9am"
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

function minutesToDisplay(min) {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const displayH = h % 12 === 0 ? 12 : h % 12
  return `${displayH}:${String(m).padStart(2, '0')} ${period}`
}

// Pure function — no DB, no Groq.
// assignments: array of { staffId, staffName, shiftId, dayOfWeek, startTime, endTime, shiftName, ... }
// shifts: array of { id, dayOfWeek|day_of_week, startTime|start_time, endTime|end_time, name }
// (shift data already embedded in assignments from generateSchedule, but shifts param accepted for completeness)
export function detectClopenings(assignments, shifts) {
  // Build shift lookup by id for time data fallback
  const shiftMap = {}
  for (const s of (shifts ?? [])) {
    shiftMap[String(s.id)] = {
      dayNum: DAY_NUM[s.dayOfWeek ?? s.day_of_week] ?? 0,
      startMin: parseTimeToMinutes(s.startTime ?? s.start_time),
      endMin: parseTimeToMinutes(s.endTime ?? s.end_time),
      name: s.name,
      day: s.dayOfWeek ?? s.day_of_week,
    }
  }

  // Group assignments by staffId
  const byStaff = {}
  for (const a of assignments) {
    const sid = String(a.staffId ?? a.staff_id)
    if (!byStaff[sid]) byStaff[sid] = { name: a.staffName ?? a.name, shifts: [] }

    const shiftId = String(a.shiftId ?? a.shift_id ?? '')
    const fromMap = shiftMap[shiftId]
    const dayStr = a.dayOfWeek ?? a.day_of_week ?? fromMap?.day
    const dayNum = DAY_NUM[dayStr] ?? fromMap?.dayNum ?? 0
    const startMin = parseTimeToMinutes(a.startTime ?? a.start_time) || (fromMap?.startMin ?? 0)
    const endMin = parseTimeToMinutes(a.endTime ?? a.end_time) || (fromMap?.endMin ?? 0)

    byStaff[sid].shifts.push({
      dayNum,
      dayStr,
      startMin,
      endMin,
      shiftName: a.shiftName ?? a.name ?? fromMap?.name,
    })
  }

  const clopenings = []

  for (const staffData of Object.values(byStaff)) {
    const sorted = [...staffData.shifts].sort((a, b) => a.dayNum - b.dayNum || a.startMin - b.startMin)

    for (let i = 0; i < sorted.length - 1; i++) {
      const close = sorted[i]
      const open = sorted[i + 1]

      // Only flag consecutive days (day diff exactly 1)
      if (open.dayNum - close.dayNum !== 1) continue

      // Compute rest hours between end of close shift and start of open shift
      // Using absolute minutes: dayNum * 1440 + minutesFromMidnight
      const closeEndAbsolute = close.dayNum * 1440 + close.endMin
      const openStartAbsolute = open.dayNum * 1440 + open.startMin
      const hoursBetween = (openStartAbsolute - closeEndAbsolute) / 60

      if (hoursBetween < 10) {
        clopenings.push({
          staffName: staffData.name,
          closeShift: { name: close.shiftName, day: close.dayStr, endTime: minutesToDisplay(close.endMin) },
          openShift: { name: open.shiftName, day: open.dayStr, startTime: minutesToDisplay(open.startMin) },
          hoursBetween: Math.round(hoursBetween * 10) / 10,
        })
      }
    }
  }

  return clopenings
}

export function formatClopeningWarning(clopenings) {
  if (!clopenings || clopenings.length === 0) return ''

  const lines = clopenings.map(c =>
    `• ${c.staffName}: closes ${c.closeShift.name} ${c.closeShift.day} at ${c.closeShift.endTime}, ` +
    `opens ${c.openShift.name} next day at ${c.openShift.startTime} (${c.hoursBetween}hrs rest)`
  ).join('\n')

  return `\n⚠️ *Clopening warnings — review before approving:*\n\n${lines}\n`
}
