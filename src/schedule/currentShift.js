// Current Shift Awareness — who's on shift right now, upcoming, ended today.
// Pure functions (no DB, no LLM) except getCurrentShifts which uses DB injection.

import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// ── parseShiftTime ───────────────────────────────────────────────────────────
// Converts shift time string + date → Date object. Returns null on invalid input.

export function parseShiftTime(timeStr, date) {
  if (!timeStr || typeof timeStr !== 'string') return null
  const s = timeStr.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null

  let hours = null
  let minutes = 0

  // Pure 24h: "23:00", "9:00"
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) {
    hours = parseInt(m24[1])
    minutes = parseInt(m24[2])
    if (hours > 23 || minutes > 59) return null
  }

  // 12h: "9:00 am", "9:00am", "11 pm", "11pm", "9am", "2:30pm"
  if (hours === null) {
    const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
    if (m12) {
      hours = parseInt(m12[1])
      minutes = parseInt(m12[2] ?? '0')
      const period = m12[3]
      if (hours > 12 || hours < 1 || minutes > 59) return null
      if (period === 'pm' && hours !== 12) hours += 12
      if (period === 'am' && hours === 12) hours = 0
    }
  }

  if (hours === null) return null

  const result = new Date(date)
  result.setHours(hours, minutes, 0, 0)
  return result
}

// ── Internal: parse start/end into Date objects for a given now ───────────────

function parseShiftWindow(shift, now) {
  const refDate = new Date(now)
  refDate.setHours(0, 0, 0, 0)

  const start = parseShiftTime(shift.startTime, refDate)
  let end = parseShiftTime(shift.endTime, refDate)
  if (!start || !end) return null

  // Midnight crossing: if end <= start, end is next day
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  }

  return { start, end }
}

// ── isShiftActive ────────────────────────────────────────────────────────────
// Returns true if now falls STRICTLY between start and end (exclusive endpoints).
// Handles midnight crossing and dayOfWeek matching.

export function isShiftActive(shift, now = new Date()) {
  const dayName = shift.dayOfWeek
  const nowDay = DAY_NAMES[now.getDay()]

  // For midnight-crossing shifts, we need to check both the shift's day and the next day
  const window = parseShiftWindow(shift, now)
  if (!window) return false

  const { start, end } = window
  const crossesMidnight = end.getDate() !== start.getDate()

  // Check if current day matches shift day
  if (nowDay === dayName) {
    const nowTime = now.getTime()
    return nowTime > start.getTime() && nowTime < end.getTime()
  }

  // For midnight-crossing shifts: check if we're past midnight into the next day
  if (crossesMidnight) {
    const prevDayIndex = (now.getDay() + 6) % 7
    const prevDayName = DAY_NAMES[prevDayIndex]
    if (prevDayName === dayName) {
      // Reconstruct window relative to previous day
      const prevRefDate = new Date(now)
      prevRefDate.setDate(prevRefDate.getDate() - 1)
      prevRefDate.setHours(0, 0, 0, 0)

      const prevStart = parseShiftTime(shift.startTime, prevRefDate)
      let prevEnd = parseShiftTime(shift.endTime, prevRefDate)
      if (prevEnd.getTime() <= prevStart.getTime()) {
        prevEnd = new Date(prevEnd.getTime() + 24 * 60 * 60 * 1000)
      }

      const nowTime = now.getTime()
      return nowTime > prevStart.getTime() && nowTime < prevEnd.getTime()
    }
  }

  return false
}

// ── getMinutesIntoShift ──────────────────────────────────────────────────────

export function getMinutesIntoShift(shift, now = new Date()) {
  if (!isShiftActive(shift, now)) return null

  // Find the actual start time
  const dayName = shift.dayOfWeek
  const nowDay = DAY_NAMES[now.getDay()]

  let refDate = new Date(now)
  refDate.setHours(0, 0, 0, 0)

  // If we're past midnight on next day
  if (nowDay !== dayName) {
    refDate.setDate(refDate.getDate() - 1)
  }

  const start = parseShiftTime(shift.startTime, refDate)
  return Math.round((now.getTime() - start.getTime()) / (60 * 1000))
}

// ── getMinutesUntilShiftEnd ──────────────────────────────────────────────────

export function getMinutesUntilShiftEnd(shift, now = new Date()) {
  if (!isShiftActive(shift, now)) return null

  const dayName = shift.dayOfWeek
  const nowDay = DAY_NAMES[now.getDay()]

  let refDate = new Date(now)
  refDate.setHours(0, 0, 0, 0)

  if (nowDay !== dayName) {
    refDate.setDate(refDate.getDate() - 1)
  }

  const start = parseShiftTime(shift.startTime, refDate)
  let end = parseShiftTime(shift.endTime, refDate)
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  }

  return Math.round((end.getTime() - now.getTime()) / (60 * 1000))
}

// ── getHoursRemainingFormatted ───────────────────────────────────────────────

export function getHoursRemainingFormatted(minutes) {
  const hrs = Math.floor(minutes / 60)
  const min = minutes % 60

  if (hrs === 0) return `${min}min`
  if (min === 0) return `${hrs}hrs`
  return `${hrs}hr ${min}min`
}

// ── getCurrentShifts (DB function) ───────────────────────────────────────────
// Queries schedule_assignments JOIN shifts JOIN staff.
// Returns all shifts for today with computed status.

export async function getCurrentShifts(groupId, now = new Date(), db = null) {
  let rawShifts
  if (db?.getCurrentShifts) {
    rawShifts = await db.getCurrentShifts(groupId)
  } else {
    // Real Supabase query
    const todayDay = DAY_NAMES[now.getDay()]
    const { data, error } = await supabase
      .from('schedule_assignments')
      .select(`
        shift_id,
        staff_id,
        staff:members!schedule_assignments_staff_id_fkey(name, role),
        shift:shifts!schedule_assignments_shift_id_fkey(name, start_time, end_time, day_of_week)
      `)
      .eq('group_id', groupId)
      .eq('status', 'scheduled')
    if (error) throw error

    rawShifts = (data ?? [])
      .filter(row => (row.shift?.day_of_week ?? '') === todayDay)
      .map(row => ({
        shiftId: row.shift_id,
        shiftName: row.shift?.name,
        staffId: row.staff_id,
        staffName: row.staff?.name,
        roleName: row.staff?.role ?? 'Staff',
        startTime: row.shift?.start_time,
        endTime: row.shift?.end_time,
        dayOfWeek: row.shift?.day_of_week,
      }))
  }

  // Compute status for each shift
  const enriched = rawShifts.map(s => {
    const active = isShiftActive(s, now)
    const minutesIn = active ? getMinutesIntoShift(s, now) : null
    const minutesRemaining = active ? getMinutesUntilShiftEnd(s, now) : null

    // Compute startsInMinutes for upcoming shifts
    let startsInMinutes = null
    let status = 'ended'

    if (active) {
      status = 'active'
    } else {
      // Check if upcoming: start time is after now today
      const refDate = new Date(now)
      refDate.setHours(0, 0, 0, 0)
      const startDate = parseShiftTime(s.startTime, refDate)

      if (startDate && startDate.getTime() > now.getTime()) {
        status = 'upcoming'
        startsInMinutes = Math.round((startDate.getTime() - now.getTime()) / (60 * 1000))
      }
    }

    return { ...s, status, minutesIn, minutesRemaining, startsInMinutes }
  })

  // Sort by startTime ASC (parse to compare)
  const refDate = new Date(now)
  refDate.setHours(0, 0, 0, 0)
  enriched.sort((a, b) => {
    const aStart = parseShiftTime(a.startTime, refDate)
    const bStart = parseShiftTime(b.startTime, refDate)
    return (aStart?.getTime() ?? 0) - (bStart?.getTime() ?? 0)
  })

  return enriched
}

// ── getActiveShifts ──────────────────────────────────────────────────────────

export async function getActiveShifts(groupId, now = new Date(), db = null) {
  const all = await getCurrentShifts(groupId, now, db)
  return all.filter(s => s.status === 'active')
}

// ── getUpcomingShifts ────────────────────────────────────────────────────────

export async function getUpcomingShifts(groupId, withinMinutes = 120, now = new Date(), db = null) {
  const all = await getCurrentShifts(groupId, now, db)
  return all.filter(s => s.status === 'upcoming' && s.startsInMinutes <= withinMinutes)
}

// ── formatCurrentRoster ──────────────────────────────────────────────────────

export function formatCurrentRoster(shifts, now = new Date()) {
  if (!shifts || shifts.length === 0) return 'No shifts scheduled today.'

  const active = shifts.filter(s => s.status === 'active')
  const upcoming = shifts.filter(s => s.status === 'upcoming')
  const ended = shifts.filter(s => s.status === 'ended')

  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const lines = [`\u{1F465} *Right now \u2014 ${timeStr}*`]

  if (active.length > 0) {
    lines.push('')
    lines.push('*On shift:*')
    for (const s of active) {
      const inStr = getHoursRemainingFormatted(s.minutesIn)
      lines.push(`\u2022 ${s.staffName} (${s.roleName}) \u2014 ${s.shiftName} (${inStr} in)`)
    }
  }

  if (upcoming.length > 0) {
    lines.push('')
    lines.push('*Starting soon (within 2hrs):*')
    for (const s of upcoming) {
      const inStr = getHoursRemainingFormatted(s.startsInMinutes)
      lines.push(`\u2022 ${s.staffName} (${s.roleName}) \u2014 ${s.shiftName} in ${inStr}`)
    }
  }

  if (ended.length > 0) {
    lines.push('')
    lines.push('*Ended today:*')
    for (const s of ended) {
      // Calculate how long ago it ended
      const refDate = new Date(now)
      refDate.setHours(0, 0, 0, 0)
      const endDate = parseShiftTime(s.endTime, refDate)
      if (endDate) {
        const agoMin = Math.round((now.getTime() - endDate.getTime()) / (60 * 1000))
        const agoStr = getHoursRemainingFormatted(agoMin)
        lines.push(`\u2022 ${s.staffName} (${s.roleName}) \u2014 ${s.shiftName} (ended ${agoStr} ago)`)
      } else {
        lines.push(`\u2022 ${s.staffName} (${s.roleName}) \u2014 ${s.shiftName} (ended)`)
      }
    }
  }

  return lines.join('\n')
}

// ── handleWhoIsWorkingQuery ──────────────────────────────────────────────────

export async function handleWhoIsWorkingQuery(bot, msg, db = null, now = new Date()) {
  const groupId = String(msg.chat.id)
  const shifts = await getCurrentShifts(groupId, now, db)
  const text = formatCurrentRoster(shifts, now)
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
}
