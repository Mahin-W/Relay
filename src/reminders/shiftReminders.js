import cron from 'node-cron'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

// Tracks sent reminders to avoid double-sending within a day
// Key: `staffName:shiftId:date`
const sentToday = new Set()

// Tracks night-before reminders sent to avoid double-sending if cron fires twice
// Key: `dmChatId:shiftId:night`
const sentNightBefore = new Set()

function timeToMinutes(timeStr) {
  if (!timeStr) return 0
  // HH:MM format
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(':').map(Number)
    return h * 60 + m
  }
  // "9:00 AM" / "1:30 PM" format
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (match) {
    let h = parseInt(match[1])
    const m = parseInt(match[2])
    const period = match[3].toUpperCase()
    if (period === 'PM' && h !== 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  return 0
}

function getDayName(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

async function fetchScheduledShiftsForReminder() {
  try {
    const { data: schedules } = await getDb()
      .from('generated_schedules')
      .select('assignments, week_start, group_id, status')
      .eq('status', 'published')

    if (!schedules?.length) return []

    const allAssignments = schedules.flatMap(s =>
      (s.assignments ?? []).map(a => ({
        ...a,
        week_start: s.week_start,
        group_id: s.group_id,
        schedule_published: true,
      }))
    )

    const shiftIds = [...new Set(allAssignments.map(a => a.shiftId).filter(Boolean))]
    if (!shiftIds.length) return []

    const { data: shifts } = await getDb().from('shifts').select('*').in('id', shiftIds)
    const shiftMap = Object.fromEntries((shifts ?? []).map(s => [s.id, s]))

    const { data: staffDms } = await getDb().from('staff_dms').select('user_id, first_name, dm_chat_id')
    const dmByName = Object.fromEntries(
      (staffDms ?? []).map(d => [d.first_name?.toLowerCase(), d.dm_chat_id])
    )

    return allAssignments
      .map(a => {
        const shift = shiftMap[a.shiftId]
        if (!shift) return null
        const dmChatId = dmByName[a.staffName?.toLowerCase()] ?? null
        return {
          shift_id: shift.id,
          shift_name: shift.name,
          day_of_week: shift.day_of_week,
          start_time: shift.start_time,
          end_time: shift.end_time,
          staff_name: a.staffName,
          staff_id: a.staffId,
          dm_chat_id: dmChatId,
          week_start: a.week_start,
          group_id: a.group_id,
          schedule_published: true,
        }
      })
      .filter(Boolean)
  } catch (err) {
    logger.error(`fetchScheduledShiftsForReminder failed: ${err.message}`)
    return []
  }
}

// Pure filtering function — testable with mock data
export async function getShiftsForReminder(targetDayName, windowStart, windowEnd, db = null) {
  let assignments
  if (Array.isArray(db)) {
    // Test mode: direct data injection
    assignments = db
  } else {
    const _fetch = db?.fetchScheduledShiftsForReminder ?? fetchScheduledShiftsForReminder
    assignments = await _fetch()
  }

  const wStart = timeToMinutes(windowStart)
  const wEnd = timeToMinutes(windowEnd)

  return assignments.filter(a => {
    if (a.day_of_week !== targetDayName) return false
    if (!a.dm_chat_id) return false
    if (a.schedule_published !== true) return false
    const t = timeToMinutes(a.start_time)
    return t >= wStart && t <= wEnd
  })
}

export function startReminderJobs(bot) {
  logger.bot('Starting shift reminder cron jobs')

  // Clear the dedup set at midnight
  cron.schedule('0 0 * * *', () => {
    sentToday.clear()
    sentNightBefore.clear()
    logger.bot('Reminder dedup set cleared for new day')
  })

  // Job 1 — Night before reminder (8pm server time)
  cron.schedule('0 20 * * *', async () => {
    try {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowDay = getDayName(tomorrow)

      const allAssignments = await fetchScheduledShiftsForReminder()
      const toRemind = allAssignments.filter(
        a => a.day_of_week === tomorrowDay && a.dm_chat_id
      )

      let sent = 0
      for (const a of toRemind) {
        const nightKey = `${a.dm_chat_id}:${a.shift_id}:night`
        if (sentNightBefore.has(nightKey)) continue
        sentNightBefore.add(nightKey)

        try {
          await bot.sendMessage(
            a.dm_chat_id,
            `👋 Hey ${a.staff_name}! Reminder — you're on tomorrow for ${a.shift_name}, ${a.start_time}–${a.end_time}. See you then!`
          )
          sent++
        } catch (err) {
          logger.error(`Night-before reminder failed for ${a.staff_name}: ${err.message}`)
        }
      }
      logger.bot(`Night-before reminders sent: ${sent}`)
    } catch (err) {
      logger.error(`Night-before reminder job failed: ${err.message}`)
    }
  })

  // Job 2 — 2-hour warning (every 30 min)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const now = new Date()
      const todayDay = getDayName(now)
      const todayDateStr = now.toISOString().split('T')[0]

      // Target window: shifts starting in ~2 hours (±15 min)
      const targetMins = now.getHours() * 60 + now.getMinutes() + 120
      const windowStart = targetMins - 15
      const windowEnd = targetMins + 15

      // Format as HH:MM for comparison
      const pad = n => String(n).padStart(2, '0')
      const wsStr = `${pad(Math.floor(windowStart / 60))}:${pad(windowStart % 60)}`
      const weStr = `${pad(Math.floor(windowEnd / 60))}:${pad(windowEnd % 60)}`

      const toRemind = await getShiftsForReminder(todayDay, wsStr, weStr)

      for (const a of toRemind) {
        const key = `${a.staff_name}:${a.shift_id}:${todayDateStr}`
        if (sentToday.has(key)) continue

        try {
          await bot.sendMessage(
            a.dm_chat_id,
            `⏰ Heads up ${a.staff_name} — your ${a.shift_name} shift starts in about 2 hours at ${a.start_time}. See you soon!`
          )
          sentToday.add(key)
        } catch (err) {
          logger.error(`2hr reminder failed for ${a.staff_name}: ${err.message}`)
        }
      }
    } catch (err) {
      logger.error(`2hr reminder job failed: ${err.message}`)
    }
  })

  logger.bot('Reminder jobs scheduled (night-before 8pm, 2hr warning every 30min)')
}
