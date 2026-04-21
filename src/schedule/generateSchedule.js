import { getShiftsForGroup, getShiftRequirements, getStaffForGroup, getSetupSession } from '../setup/setupDb.js'
import { buildRotationPriorityMap, applyRotationToAssignments } from '../fairness/rotationTracker.js'
import { getAvailabilityForGroup, saveGeneratedSchedule } from '../availability/availabilityDb.js'
import { getGroupMembersWithDm, getGroupMemberName } from '../db.js'
import { logger } from '../logger.js'
import { detectClopenings } from './clopen.js'
import { calculateWeeklyHours, detectHoursIssues } from './hoursTracker.js'
import { getCrossTrainedForRole } from '../intelligence/crossTrainingDb.js'

const DAY_ORDER = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

// ── Concurrent-call deduplication ─────────────────────────────────────────────
const _inProgress = new Map() // concurrency lock — serializes generateWeeklySchedule calls per group+week

// Returns the ISO date string (YYYY-MM-DD) of this week's Monday (current week)
export function getCurrentWeekStart() {
  const today = new Date()
  const day = today.getDay() // 0=Sun, 1=Mon ... 6=Sat
  const daysToMonday = day === 0 ? -6 : 1 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysToMonday)
  monday.setHours(0, 0, 0, 0)
  return monday.toISOString().split('T')[0]
}

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
//
// mockData bypasses all DB calls (for tests):
//   { shifts, staff, availability, requirements }
//   staff must include userId already resolved (no DM-pool name matching needed)
export async function generateWeeklySchedule(groupId, weekStart, mockData = null) {
  // ── BH.06: serialize concurrent calls for the same group+week ─────────────
  const _key = `${groupId}:${weekStart}`
  if (_inProgress.has(_key)) return _inProgress.get(_key)
  const _promise = (async () => {
  try {
    let shifts, resolvedStaff, availabilityRecords, requirements, maxShiftsPerDay = 0, mockRules = null

    if (mockData) {
      // ── Test path: use provided data directly ─────────────────────────────
      shifts = mockData.shifts ?? []
      requirements = mockData.requirements ?? []
      availabilityRecords = mockData.availability ?? []
      maxShiftsPerDay = mockData.maxShiftsPerDay ?? 0
      mockRules = mockData.rules ?? null
      resolvedStaff = (mockData.staff ?? []).map(s => ({
        staffId: s.id,
        name: s.name,
        role: s.role,
        userId: s.userId ?? null,
        dmChatId: s.dmChatId ?? null,
      }))
    } else {
      // ── Live path: load all data from DB ──────────────────────────────────
      const [liveShifts, liveStaff, liveAvail, dmPoolBase, setupSession] = await Promise.all([
        getShiftsForGroup(groupId),
        getStaffForGroup(groupId),
        getAvailabilityForGroup(groupId, weekStart),
        getGroupMembersWithDm(groupId),
        getSetupSession(groupId),
      ])

      shifts = liveShifts
      availabilityRecords = liveAvail

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
        liveShifts.map(s => getShiftRequirements(s.id).then(reqs => reqs.map(r => ({ ...r, shift_id: s.id }))))
      )
      requirements = reqArrays.flat()

      // Resolve staff: match staff records to Telegram users by first name
      resolvedStaff = liveStaff.map(s => {
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

      maxShiftsPerDay = setupSession?.setup_data?.max_shifts_per_day ?? 0
    }

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

    // ── Load business rules for scheduling (day_off filtering) ───────────────
    let schedulingRules = []
    if (mockRules) {
      schedulingRules = mockRules
    } else if (!mockData) {
      try {
        const { getRules } = await import('../rules/rulesDb.js')
        schedulingRules = await getRules(groupId)
      } catch { /* non-fatal */ }
    }

    // Build fast lookup: staffId → Set of day-off days
    const dayOffByStaff = new Map()
    for (const rule of schedulingRules) {
      if (rule.active === false) continue
      if (rule.type === 'day_off') {
        const sid = rule.subjectStaffId ?? rule.subject_staff_id
        const day = rule.dayOfWeek ?? rule.day_of_week
        if (sid && day) {
          if (!dayOffByStaff.has(sid)) dayOffByStaff.set(sid, new Set())
          dayOffByStaff.get(sid).add(day)
        }
      }
    }

    function hasDateOff(staffId, dayOfWeek) {
      return dayOffByStaff.get(staffId)?.has(dayOfWeek) ?? false
    }

    // ── Greedy scheduling ─────────────────────────────────────────────────────
    const sortedShifts = [...shifts].sort(
      (a, b) => (DAY_ORDER[a.day_of_week] ?? 8) - (DAY_ORDER[b.day_of_week] ?? 8)
    )

    const assignments = []
    const gaps = []
    const shiftsOnDay = {} // userId → Map<dayOfWeek, count>
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
          // G1: enforce day_off business rules during candidate filtering
          if (hasDateOff(s.staffId, shift.day_of_week)) return false
          // Enforce max shifts per day (0 = no limit)
          if (s.userId && maxShiftsPerDay > 0) {
            const dayCount = shiftsOnDay[s.userId]?.get(shift.day_of_week) ?? 0
            if (dayCount >= maxShiftsPerDay) return false
          }
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
            if (!shiftsOnDay[p.userId]) shiftsOnDay[p.userId] = new Map()
            const current = shiftsOnDay[p.userId].get(shift.day_of_week) ?? 0
            shiftsOnDay[p.userId].set(shift.day_of_week, current + 1)
          }
          assignmentCount[p.staffId] = (assignmentCount[p.staffId] ?? 0) + 1
        }

        if (picked.length < req.count) {
          gaps.push({
            shiftId: shift.id,
            shiftName: shift.name,
            dayOfWeek: shift.day_of_week,
            startTime: shift.start_time,
            endTime: shift.end_time,
            roleName: req.role,
            roleId: req.roleId ?? null,
            needed: req.count,
            found: picked.length,
            shortfall: req.count - picked.length,
          })
        }
      }
    }

    // ── Cross-training gap-filling ──────────────────────────────────────────────
    const crossTrainingUsed = []
    const ctDb = mockData?.crossTrainingDb ?? null
    for (const gap of gaps) {
      if (gap.shortfall <= 0) continue
      // Need roleId to look up cross-trained staff; use gap.roleId if available
      const roleId = gap.roleId
      if (!roleId) continue
      let crossTrained
      try {
        crossTrained = await getCrossTrainedForRole(groupId, roleId, ctDb)
      } catch { continue }
      for (const ct of crossTrained) {
        if (gap.shortfall <= 0) break
        // Check: not already assigned this shift+day
        const alreadyAssigned = assignments.some(a =>
          a.staffId === ct.staffId && a.dayOfWeek === gap.dayOfWeek && a.shiftId === gap.shiftId
        )
        if (alreadyAssigned) continue
        // Check availability
        const ctStaff = resolvedStaff.find(s => s.staffId === ct.staffId)
        if (!ctStaff) continue
        if (!isAvailable(ctStaff.userId, gap.shiftId)) continue
        // Assign via cross-training
        assignments.push({
          shiftId: gap.shiftId,
          shiftName: gap.shiftName,
          dayOfWeek: gap.dayOfWeek,
          startTime: gap.startTime,
          endTime: gap.endTime,
          staffId: ct.staffId,
          staffName: ct.staffName,
          roleName: gap.roleName,
          userId: ctStaff.userId,
          dmChatId: ctStaff.dmChatId,
        })
        gap.shortfall--
        gap.found++
        crossTrainingUsed.push(`${ct.staffName} assigned as ${gap.roleName} via cross-training`)
      }
    }

    // ── Apply rotation fairness (live mode only) ───────────────────────────────
    if (!mockData && assignments.length > 0) {
      try {
        const priorityMap = await buildRotationPriorityMap(groupId, shifts, resolvedStaff)
        const fairAssignments = applyRotationToAssignments(assignments, priorityMap, shifts)
        assignments.length = 0
        assignments.push(...fairAssignments)
      } catch (fairErr) {
        logger.error(`Rotation fairness failed (non-fatal): ${fairErr.message}`)
      }
    }

    logger.bot(`Schedule generated: ${assignments.length} assignments, ${gaps.length} gaps`)

    // ── Detect scheduling issues ───────────────────────────────────────────────
    const clopenings = detectClopenings(assignments, shifts)
    const hoursMap = calculateWeeklyHours(assignments, shifts)
    const hoursIssues = detectHoursIssues(hoursMap)
    if (clopenings.length > 0) logger.bot(`Clopening warnings: ${clopenings.length}`)
    if (hoursIssues.overtime.length > 0) logger.bot(`Overtime warnings: ${hoursIssues.overtime.length}`)

    // ── Business rules check (live mode only) ─────────────────────────────────
    let ruleConflicts = []
    if (!mockData && assignments.length > 0) {
      try {
        const { getRules } = await import('../rules/rulesDb.js')
        const { applyRulesToAssignments } = await import('../rules/businessRules.js')
        const rules = await getRules(groupId)
        if (rules.length > 0) {
          const mappedShifts = shifts.map(s => ({ id: s.id, name: s.name, dayOfWeek: s.day_of_week, startTime: s.start_time, endTime: s.end_time }))
          const mappedStaff = resolvedStaff.map(s => ({ id: s.staffId, name: s.name }))
          const result = applyRulesToAssignments(assignments, mappedShifts, mappedStaff, rules)
          ruleConflicts = result.conflicts
          if (ruleConflicts.length > 0) logger.bot(`Rule conflicts: ${ruleConflicts.length}`)
        }
      } catch (ruleErr) {
        logger.error(`Business rules check failed (non-fatal): ${ruleErr.message}`)
      }
    }

    // ── Persist draft (skipped in test/mock mode) ─────────────────────────────
    const saved = mockData ? null : await saveGeneratedSchedule(groupId, weekStart, assignments, gaps)

    return { assignments, gaps, weekStart, scheduleId: saved?.id ?? null, clopenings, hoursIssues, ruleConflicts, crossTrainingUsed }
  } catch (err) {
    logger.error(`generateWeeklySchedule failed: ${err.message}`)
    return { assignments: [], gaps: [], weekStart, scheduleId: null }
  }
  })()
  _inProgress.set(_key, _promise)
  try { return await _promise } finally { _inProgress.delete(_key) }
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
