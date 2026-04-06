import { getShiftsForGroup, getShiftRequirements, getStaffForGroup, getSetupSession } from '../setup/setupDb.js'
import { getAvailabilityForGroup, saveGeneratedSchedule } from '../availability/availabilityDb.js'
import { getGroupMembersWithDm, getGroupMemberName } from '../db.js'
import { logger } from '../logger.js'

const DAY_ORDER = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

// Returns the ISO date string (YYYY-MM-DD) of next week's Monday
export function getNextWeekStart() {
  const today = new Date()
  const day = today.getDay() // 0=Sun, 1=Mon ... 6=Sat
  const daysUntilMonday = day === 0 ? 1 : 8 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysUntilMonday)
  monday.setHours(0, 0, 0, 0)
  return monday.toISOString().split('T')[0]
}

// "Apr 7 – Apr 13"
export function formatWeekLabel(weekStart) {
  // Normalize to YYYY-MM-DD regardless of whether it has a timestamp
  const dateStr = String(weekStart).slice(0, 10)
  const start = new Date(`${dateStr}T12:00:00`)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  const opts = { month: 'short', day: 'numeric' }
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`
}

// Core scheduling algorithm.
// Returns { assignments, gaps, weekStart, scheduleId }
// Never throws — gaps are surfaced, never silently dropped.
export async function generateWeeklySchedule(groupId, weekStart) {
  try {
    // ── Load all data ─────────────────────────────────────────────────────────
    const [shifts, staff, availabilityRecords, dmPoolBase, setupSession] = await Promise.all([
      getShiftsForGroup(groupId),
      getStaffForGroup(groupId),
      getAvailabilityForGroup(groupId, weekStart),
      getGroupMembersWithDm(groupId),
      getSetupSession(groupId),
    ])

    // Always include the manager in the pool (they may not be in staff_dms)
    const dmPool = [...dmPoolBase]
    if (setupSession?.manager_id && setupSession?.dm_chat_id) {
      const alreadyIn = dmPool.some(m => m.userId === setupSession.manager_id)
      if (!alreadyIn) {
        const managerMember = await getGroupMemberName(setupSession.manager_id, groupId)
        dmPool.push({ userId: setupSession.manager_id, firstName: managerMember, dmChatId: setupSession.dm_chat_id })
      }
    }

    // Load requirements for every shift in parallel
    const reqArrays = await Promise.all(
      shifts.map(s => getShiftRequirements(s.id).then(reqs => reqs.map(r => ({ ...r, shift_id: s.id }))))
    )
    const requirements = reqArrays.flat()

    // ── Resolve staff: match staff records to Telegram users by first name ───
    // This links staff.role to a user_id so we can check their availability.
    const resolvedStaff = staff.map(s => {
      const nameLower = (s.name || '').toLowerCase().trim()
      const matched = dmPool.find(m => {
        const mLower = (m.firstName || '').toLowerCase().trim()
        return mLower === nameLower || nameLower.startsWith(mLower) || mLower.startsWith(nameLower)
      })
      return {
        staffId: s.id,
        name: s.name,
        role: s.role,
        userId: matched?.userId ?? null,
        dmChatId: matched?.dmChatId ?? null,
      }
    })

    // ── Availability lookup ───────────────────────────────────────────────────
    const availMap = {}
    for (const av of availabilityRecords) {
      availMap[av.user_id] = av
    }

    function isAvailable(userId, shiftId) {
      if (!userId) return false
      const av = availMap[userId]
      if (!av) return false // no response = not available
      if (av.unavailable) return false
      if (av.available_all) return true
      // Coerce both sides to Number — Supabase returns BIGINT[] as strings
      const ids = (av.available_shift_ids ?? []).map(Number)
      return ids.includes(Number(shiftId))
    }

    // ── Greedy scheduling ─────────────────────────────────────────────────────
    const sortedShifts = [...shifts].sort(
      (a, b) => (DAY_ORDER[a.day_of_week] ?? 8) - (DAY_ORDER[b.day_of_week] ?? 8)
    )

    const assignments = []
    const gaps = []
    const assignedOnDay = {} // userId → Set<dayOfWeek>
    const assignmentCount = {} // staffId → number

    for (const shift of sortedShifts) {
      const shiftReqs = requirements.filter(r => r.shift_id === shift.id)

      // If no requirements are defined, skip the shift for scheduling purposes
      if (shiftReqs.length === 0) continue

      for (const req of shiftReqs) {
        const roleLower = (req.role || '').toLowerCase()

        const candidates = resolvedStaff.filter(s => {
          if ((s.role || '').toLowerCase() !== roleLower) return false
          if (!isAvailable(s.userId, shift.id)) return false
          if (assignedOnDay[s.userId]?.has(shift.day_of_week)) return false
          return true
        })

        // Fairness: prefer staff with fewer assignments this week
        candidates.sort((a, b) => (assignmentCount[a.staffId] ?? 0) - (assignmentCount[b.staffId] ?? 0))

        const picked = candidates.slice(0, req.count)

        for (const p of picked) {
          assignments.push({
            shiftId: shift.id,
            shiftName: shift.name,
            dayOfWeek: shift.day_of_week,
            startTime: shift.start_time,
            endTime: shift.end_time,
            staffId: p.staffId,
            staffName: p.name,
            roleName: p.role,
            userId: p.userId,
            dmChatId: p.dmChatId,
          })
          if (p.userId) {
            if (!assignedOnDay[p.userId]) assignedOnDay[p.userId] = new Set()
            assignedOnDay[p.userId].add(shift.day_of_week)
          }
          assignmentCount[p.staffId] = (assignmentCount[p.staffId] ?? 0) + 1
        }

        if (picked.length < req.count) {
          gaps.push({
            shiftName: shift.name,
            dayOfWeek: shift.day_of_week,
            startTime: shift.start_time,
            endTime: shift.end_time,
            roleName: req.role,
            needed: req.count,
            found: picked.length,
            shortfall: req.count - picked.length,
          })
        }
      }
    }

    logger.bot(`Schedule generated: ${assignments.length} assignments, ${gaps.length} gaps`)

    // ── Persist draft ─────────────────────────────────────────────────────────
    const saved = await saveGeneratedSchedule(groupId, weekStart, assignments, gaps)

    return { assignments, gaps, weekStart, scheduleId: saved?.id ?? null }
  } catch (err) {
    logger.error(`generateWeeklySchedule failed: ${err.message}`)
    return { assignments: [], gaps: [], weekStart, scheduleId: null }
  }
}

// Formats a schedule into Telegram markdown.
// Works on raw assignment/gap arrays (from either live generation or JSONB DB read).
export function formatScheduleMessage(assignments, gaps, weekStart) {
  const weekLabel = formatWeekLabel(weekStart)
  let out = `📅 *Schedule: Week of ${weekLabel}*\n`

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

  for (const day of days) {
    const dayRows = assignments.filter(a => a.dayOfWeek === day)
    if (dayRows.length === 0) continue

    out += `\n*${day}*\n`

    // Group by shift within the day
    const shiftGroups = new Map()
    for (const a of dayRows) {
      const key = String(a.shiftId)
      if (!shiftGroups.has(key)) {
        shiftGroups.set(key, { name: a.shiftName, startTime: a.startTime, endTime: a.endTime, byRole: {} })
      }
      const sg = shiftGroups.get(key)
      if (!sg.byRole[a.roleName]) sg.byRole[a.roleName] = []
      sg.byRole[a.roleName].push(a.staffName)
    }

    for (const sg of shiftGroups.values()) {
      out += `• *${sg.name}* (${sg.startTime}–${sg.endTime})\n`
      for (const [role, names] of Object.entries(sg.byRole)) {
        out += `  └ ${role}: ${names.join(', ')}\n`
      }
    }
  }

  if (assignments.length === 0) {
    out += `\n_No shifts could be filled — check that staff have submitted availability and shift requirements are configured._\n`
  }

  if (gaps.length > 0) {
    out += `\n⚠️ *Unfilled positions:*\n`
    for (const g of gaps) {
      out += `• ${g.shiftName} (${g.dayOfWeek}) — need ${g.shortfall} more ${g.roleName}\n`
    }
  }

  return out
}
