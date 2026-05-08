// Earned Wage Visibility — lets staff DM the bot to see how much they've earned this week.
// Pure functions + DB-injected handler. No router modifications needed.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { getCurrentWeekStart } from '../schedule/generateSchedule.js'

// ── Day offset map (weekStart is always Monday) ─────────────────────────────

const DAY_OFFSETS = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
  Saturday: 5,
  Sunday: 6,
}

// ── parseShiftTime (local copy to avoid coupling) ────────────────────────────
// Converts "9am", "12pm", "4:30pm", "23:00" → Date with time set on given date.

function parseShiftTime(timeStr, date) {
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

  // 12h: "9:00am", "11 pm", "9am", "2:30pm", "12pm"
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

// ── isEarnedWageQuery ────────────────────────────────────────────────────────
// Pure keyword matching — no LLM needed.

const WAGE_PATTERNS = [
  'how much have i made',
  'my earnings',
  'what have i earned',
  'how much did i make',
  'my wages',
  'how much will i get paid',
  'my pay so far',
  'earnings this week',
  'made so far',
  'earned so far',
  'how much am i making',
  'my income this week',
  'what am i making',
  'how much so far',
]

export function isEarnedWageQuery(text) {
  if (!text || typeof text !== 'string') return false
  const lower = text.toLowerCase().trim()
  if (!lower) return false
  return WAGE_PATTERNS.some(pattern => lower.includes(pattern))
}

// ── calculateEarnedWages ─────────────────────────────────────────────────────

export async function calculateEarnedWages(staffId, groupId, weekStart, now = new Date(), db = null) {
  // 1. Get assignments for this staff this week
  let assignments
  if (db?.getAssignmentsForStaffWeek) {
    assignments = await db.getAssignmentsForStaffWeek(staffId, weekStart)
  } else {
    const { data, error } = await getDb()
      .from('schedule_assignments')
      .select(`
        shift_id,
        shifts!inner(id, name, day_of_week, start_time, end_time)
      `)
      .eq('staff_id', staffId)
      .eq('week_start', weekStart)
      .eq('status', 'scheduled')
    if (error) {
      logger.error(`calculateEarnedWages assignments query failed: ${error.message}`)
      assignments = []
    } else {
      assignments = (data ?? []).map(row => ({
        shift_id: row.shift_id,
        day_of_week: row.shifts.day_of_week,
        start_time: row.shifts.start_time,
        end_time: row.shifts.end_time,
        shift_name: row.shifts.name,
      }))
    }
  }

  // 2. Get staff info and hourly rate
  let staffName = 'Staff'
  let hourlyRate = 0

  if (db?.getStaffWithRole) {
    const staff = await db.getStaffWithRole(staffId)
    if (staff) {
      staffName = staff.name
      const roleName = staff.role ?? 'Staff'
      if (db?.getRoleRate) {
        hourlyRate = await db.getRoleRate(groupId, roleName)
      }
    }
  } else {
    // Real Supabase queries
    const { data: staff } = await getDb()
      .from('staff')
      .select('name, role')
      .eq('id', staffId)
      .maybeSingle()
    if (staff) {
      staffName = staff.name
      const { data: rate } = await getDb()
        .from('role_rates')
        .select('hourly_rate')
        .eq('group_id', groupId)
        .eq('role_name', staff.role ?? 'Staff')
        .maybeSingle()
      hourlyRate = rate?.hourly_rate ?? 0
    }
  }

  if (!assignments || assignments.length === 0) {
    return {
      staffName,
      weekStart,
      hourlyRate,
      shiftsCompleted: 0,
      shiftsInProgress: 0,
      shiftsUpcoming: 0,
      hoursWorked: 0,
      hoursScheduledTotal: 0,
      earnedSoFar: 0,
      currentShiftEarnings: null,
      projectedWeekTotal: 0,
      noShiftsThisWeek: true,
    }
  }

  // 3. Build date for "today" comparison
  const todayDate = new Date(now)
  todayDate.setHours(0, 0, 0, 0)

  let shiftsCompleted = 0
  let shiftsInProgress = 0
  let shiftsUpcoming = 0
  let completedHours = 0
  let inProgressHours = 0
  let totalScheduledHours = 0

  for (const a of assignments) {
    const dayOffset = DAY_OFFSETS[a.day_of_week]
    if (dayOffset === undefined) continue

    // Build shift date from weekStart + dayOffset
    const shiftDate = new Date(weekStart + 'T00:00:00')
    shiftDate.setDate(shiftDate.getDate() + dayOffset)

    // Parse start/end times for this shift
    const startTime = parseShiftTime(a.start_time, shiftDate)
    const endTime = parseShiftTime(a.end_time, shiftDate)
    if (!startTime || !endTime) continue

    // Handle midnight crossing
    if (endTime.getTime() <= startTime.getTime()) {
      endTime.setDate(endTime.getDate() + 1)
    }

    const shiftDurationHours = (endTime.getTime() - startTime.getTime()) / 3600000
    totalScheduledHours += shiftDurationHours

    // Compare shiftDate (midnight) to todayDate (midnight)
    const shiftDay = new Date(shiftDate)
    shiftDay.setHours(0, 0, 0, 0)
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)

    if (shiftDay.getTime() < today.getTime()) {
      // Past day — completed
      shiftsCompleted++
      completedHours += shiftDurationHours
    } else if (shiftDay.getTime() > today.getTime()) {
      // Future day — upcoming
      shiftsUpcoming++
    } else {
      // Same day — check time
      if (now.getTime() >= endTime.getTime()) {
        // Shift already ended today
        shiftsCompleted++
        completedHours += shiftDurationHours
      } else if (now.getTime() >= startTime.getTime() && now.getTime() <= endTime.getTime()) {
        // Currently in shift
        shiftsInProgress++
        inProgressHours += (now.getTime() - startTime.getTime()) / 3600000
      } else {
        // Shift hasn't started yet today
        shiftsUpcoming++
      }
    }
  }

  const hoursWorked = completedHours + inProgressHours
  const earnedSoFar = Math.round(completedHours * hourlyRate * 100) / 100
  const currentShiftEarnings = shiftsInProgress > 0
    ? Math.round(inProgressHours * hourlyRate * 100) / 100
    : null
  const projectedWeekTotal = Math.round(totalScheduledHours * hourlyRate * 100) / 100

  return {
    staffName,
    weekStart,
    hourlyRate,
    shiftsCompleted,
    shiftsInProgress,
    shiftsUpcoming,
    hoursWorked: Math.round(hoursWorked * 100) / 100,
    hoursScheduledTotal: Math.round(totalScheduledHours * 100) / 100,
    earnedSoFar,
    currentShiftEarnings,
    projectedWeekTotal,
    noShiftsThisWeek: false,
  }
}

// ── formatEarnedWageResponse ─────────────────────────────────────────────────

export function formatEarnedWageResponse(earned, showRate = true) {
  if (earned.noShiftsThisWeek) {
    return 'No shifts scheduled for you this week.'
  }

  const lines = []
  lines.push('\u{1F4B5} *Your earnings this week*')
  lines.push(`Week of ${earned.weekStart}`)

  if (showRate) {
    lines.push(`Rate: $${earned.hourlyRate}/hr`)
  }

  lines.push('')

  // Current shift (in-progress)
  if (earned.currentShiftEarnings !== null && earned.shiftsInProgress > 0) {
    const totalMinutesIn = Math.round((earned.hoursWorked - Math.floor(earned.hoursWorked / 1) * 0) * 60)
    // Calculate hours/minutes into current shift from in-progress hours
    const ipHours = earned.hoursWorked - (earned.hoursWorked - (earned.currentShiftEarnings / earned.hourlyRate))
    const inProgressHrs = earned.currentShiftEarnings / earned.hourlyRate
    const hrsIn = Math.floor(inProgressHrs)
    const minsIn = Math.round((inProgressHrs - hrsIn) * 60)
    const timeStr = hrsIn > 0 ? `${hrsIn}hr ${minsIn}min` : `${minsIn}min`

    lines.push(`\u{1F504} Right now: $${earned.currentShiftEarnings} and counting`)
    lines.push(`   (${timeStr} into your shift)`)
    lines.push('')
  }

  // Completed shifts
  const completedHrs = earned.shiftsCompleted > 0
    ? Math.round((earned.earnedSoFar / earned.hourlyRate) * 10) / 10
    : 0
  lines.push(`Completed: ${earned.shiftsCompleted} shift(s), ${completedHrs}hrs`)
  lines.push(`*Earned so far: $${earned.earnedSoFar}*`)

  // Upcoming shifts
  if (earned.shiftsUpcoming > 0) {
    lines.push('')
    lines.push(`Still to come: ${earned.shiftsUpcoming} shift(s) remaining`)
    lines.push(`Projected week total: ~$${earned.projectedWeekTotal}`)
  }

  return lines.join('\n')
}

// ── handleEarnedWageQuery ────────────────────────────────────────────────────

export async function handleEarnedWageQuery(bot, msg, db = null) {
  // DM only
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(msg.chat.id, 'Please DM me directly to check your earnings.', { parse_mode: 'Markdown' })
    return
  }

  const dmChatId = String(msg.chat.id)

  // Look up staff by dm_chat_id
  let staffInfo
  if (db?.getStaffByDmChatId) {
    staffInfo = await db.getStaffByDmChatId(dmChatId)
  } else {
    // Real Supabase: staff_dms → staff
    const { data: dm } = await getDb()
      .from('staff_dms')
      .select('user_id')
      .eq('dm_chat_id', dmChatId)
      .maybeSingle()
    if (dm) {
      const { data: staff } = await getDb()
        .from('staff')
        .select('id, name, role, group_id')
        .eq('telegram_id', dm.user_id)
        .maybeSingle()
      staffInfo = staff
    }
  }

  if (!staffInfo) {
    await bot.sendMessage(dmChatId, 'I don\'t have you registered yet. Please use /start to register first.')
    return
  }

  const weekStart = getCurrentWeekStart()
  const now = new Date()

  const earned = await calculateEarnedWages(
    staffInfo.staff_id ?? staffInfo.id,
    staffInfo.group_id,
    weekStart,
    now,
    db
  )

  const response = formatEarnedWageResponse(earned)
  await bot.sendMessage(dmChatId, response, { parse_mode: 'Markdown' })
}
