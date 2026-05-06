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

/**
 * Build synthetic availability when no real availability was submitted.
 * Returns one record per staff with a Telegram userId, flagged available_all.
 * Staff without a userId are handled by the useFallback short-circuit in
 * isAvailable() — they become eligible based on role match alone.
 */
function buildFallbackAvailability(resolvedStaff, weekStart, groupId) {
  const records = []
  for (const s of resolvedStaff) {
    if (!s.userId) continue
    records.push({
      user_id: s.userId,
      group_id: groupId,
      week_start: weekStart,
      available_shift_ids: [],
      available_all: true,
      unavailable: false,
      raw_response: null,
      collected_at: null,
    })
  }
  return records
}

// Core scheduling algorithm.
// Returns { assignments, gaps, weekStart, scheduleId }
// Never throws — gaps are surfaced, never silently dropped.
//
// mockData bypasses all DB calls (for tests):
//   { shifts, staff, availability, requirements }
//   staff must include userId already resolved (no DM-pool name matching needed)
export async function generateWeeklySchedule(groupId, weekStart, mockData = null, extraRules = [], extraAvailability = []) {
  // ── BH.06: serialize concurrent calls for the same group+week ─────────────
  const _key = `${groupId}:${weekStart}`
  if (_inProgress.has(_key)) return _inProgress.get(_key)
  const _promise = (async () => {
  try {
    let shifts, resolvedStaff, availabilityRecords, requirements, maxShiftsPerDay = 0, mockRules = null
    let useFallback = false

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

    // ── Fallback: no availability submitted → synthesize from staff × role ────
    // In this mode isAvailable() short-circuits to true, so the greedy loop
    // picks candidates purely by role match + business rules.
    if (availabilityRecords.length === 0 && resolvedStaff.length > 0) {
      availabilityRecords = buildFallbackAvailability(resolvedStaff, weekStart, groupId)
      useFallback = true
    }

    // ── Manual availability overlay (from dashboard staff_availability table) ──
    // extraAvailability = [{ staffId, day, available }]
    // Build a fast lookup: staffId → Set<day> for available=true, Set<day> for available=false
    const manualAllowedDays = new Map()  // staffId → Set<day> (explicit available=true)
    const manualBlockedDays = new Map()  // staffId → Set<day> (explicit available=false)
    for (const row of (extraAvailability || [])) {
      if (row.available === true) {
        if (!manualAllowedDays.has(row.staffId)) manualAllowedDays.set(row.staffId, new Set())
        manualAllowedDays.get(row.staffId).add(row.day)
      } else if (row.available === false) {
        if (!manualBlockedDays.has(row.staffId)) manualBlockedDays.set(row.staffId, new Set())
        manualBlockedDays.get(row.staffId).add(row.day)
      }
    }

    // ── Fallback: no shift requirements configured → default to 1 any-role per shift ──
    // Previously a shift with zero requirements was silently skipped, producing empty
    // schedules whenever the manager hadn't done the shift_roles setup step.
    let useRequirementsFallback = false
    if (requirements.length === 0 && shifts.length > 0) {
      useRequirementsFallback = true
      requirements = shifts.map(s => ({ shift_id: s.id, role: '*', count: 1, roleId: null }))
    }

    // ── Availability lookup ───────────────────────────────────────────────────
    const availMap = {}
    for (const av of availabilityRecords) {
      availMap[av.user_id] = av
    }

    function isAvailable(userId, shiftId) {
      if (useFallback) return true // role-match-only mode, ignore availability
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
    // Merge in any extra rules passed by the caller (e.g. manual availability overrides)
    if (extraRules && extraRules.length > 0) {
      schedulingRules = [...schedulingRules, ...extraRules]
    }

    // Build fast lookup: staffId → Set of day-off days
    const dayOffByStaff = new Map()
    // Build pinned assignments: shiftId → Set<staffId> (shift_preference rules with a specific shift)
    const pinnedByShift = new Map()
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
      if (rule.type === 'shift_preference') {
        const sid = rule.subjectStaffId ?? rule.subject_staff_id
        const shiftId = rule.shift_id
        if (sid && shiftId) {
          if (!pinnedByShift.has(shiftId)) pinnedByShift.set(shiftId, new Set())
          pinnedByShift.get(shiftId).add(sid)
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
      let shiftReqs = requirements.filter(r => r.shift_id === shift.id)

      // If requirements are missing for THIS shift only, synthesize one "any role, 1 person"
      // so the shift still gets scheduled. The group-wide fallback above handles the
      // zero-requirements-total case; this covers a partial setup where some shifts got
      // requirements and others didn't.
      if (shiftReqs.length === 0) {
        shiftReqs = [{ shift_id: shift.id, role: '*', count: 1, roleId: null }]
      }

      for (const req of shiftReqs) {
        const roleLower = (req.role || '').toLowerCase()
        const matchAnyRole = roleLower === '*' || roleLower === ''

        const candidates = resolvedStaff.filter(s => {
          if (!matchAnyRole && (s.role || '').toLowerCase() !== roleLower) return false
          // Manual availability takes precedence over chat-collected availability:
          //   available=false → hard block regardless of chat response
          //   available=true  → override "no response" and allow scheduling on this day
          if (manualBlockedDays.get(s.staffId)?.has(shift.day_of_week)) return false
          const manuallyAllowed = manualAllowedDays.get(s.staffId)?.has(shift.day_of_week)
          if (!manuallyAllowed && !isAvailable(s.userId, shift.id)) return false
          // G1: enforce day_off business rules during candidate filtering
          if (hasDateOff(s.staffId, shift.day_of_week)) return false
          // Enforce max shifts per day (0 = no limit)
          if (s.userId && maxShiftsPerDay > 0) {
            const dayCount = shiftsOnDay[s.userId]?.get(shift.day_of_week) ?? 0
            if (dayCount >= maxShiftsPerDay) return false
          }
          return true
        })

        // Pinned staff (shift_preference rule for this specific shift) go first; then sort by fewest assignments
        const pinned = pinnedByShift.get(shift.id)
        if (pinned?.size) {
          candidates.sort((a, b) => {
            const aPin = pinned.has(a.staffId) ? 0 : 1
            const bPin = pinned.has(b.staffId) ? 0 : 1
            if (aPin !== bPin) return aPin - bPin
            return (assignmentCount[a.staffId] ?? 0) - (assignmentCount[b.staffId] ?? 0)
          })
        } else {
          candidates.sort((a, b) => (assignmentCount[a.staffId] ?? 0) - (assignmentCount[b.staffId] ?? 0))
        }

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
        // Check availability — manual availability takes precedence
        const ctStaff = resolvedStaff.find(s => s.staffId === ct.staffId)
        if (!ctStaff) continue
        if (manualBlockedDays.get(ct.staffId)?.has(gap.dayOfWeek)) continue
        const manuallyAllowed = manualAllowedDays.get(ct.staffId)?.has(gap.dayOfWeek)
        if (!manuallyAllowed && !isAvailable(ctStaff.userId, gap.shiftId)) continue
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

    // ── Enforce max-5-days/week business rule ─────────────────────────────────
    // Applies in both mock and live mode when the rule is present
    const hasMaxDaysRule = schedulingRules.some(r =>
      r.active !== false &&
      r.type === 'shift_preference' &&
      (r.subject === 'TEAM' || r.subjectStaffId == null) &&
      /5 days\/week/.test(r.constraint_text ?? '')
    ) || (mockRules && mockRules.some(r =>
      r.active !== false &&
      r.type === 'shift_preference' &&
      (r.subject === 'TEAM' || r.subjectStaffId == null) &&
      /5 days\/week/.test(r.constraint_text ?? '')
    ))
    if (hasMaxDaysRule) {
      // Count distinct days per staffId; remove excess assignments (last added = lowest priority).
      // Pinned assignments (from shift_preference rules) are kept regardless of day count.
      const daySetByStaff = new Map()
      const toRemove = new Set()
      // First pass: reserve days for pinned assignments so they aren't displaced
      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i]
        if (pinnedByShift.get(a.shiftId)?.has(a.staffId)) {
          if (!daySetByStaff.has(a.staffId)) daySetByStaff.set(a.staffId, new Set())
          daySetByStaff.get(a.staffId).add(a.dayOfWeek)
        }
      }
      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i]
        // Never remove a pinned assignment
        if (pinnedByShift.get(a.shiftId)?.has(a.staffId)) continue
        if (!daySetByStaff.has(a.staffId)) daySetByStaff.set(a.staffId, new Set())
        const ds = daySetByStaff.get(a.staffId)
        if (!ds.has(a.dayOfWeek)) {
          if (ds.size >= 5) {
            toRemove.add(i)
          } else {
            ds.add(a.dayOfWeek)
          }
        }
      }
      if (toRemove.size > 0) {
        const removed = assignments.filter((_, i) => toRemove.has(i))
        assignments.splice(0, assignments.length, ...assignments.filter((_, i) => !toRemove.has(i)))
        // Push removed slots to gaps
        for (const a of removed) {
          gaps.push({
            shiftId: a.shiftId,
            shiftName: a.shiftName,
            dayOfWeek: a.dayOfWeek,
            startTime: a.startTime,
            endTime: a.endTime,
            roleName: a.roleName,
            roleId: null,
            needed: 1,
            found: 0,
            shortfall: 1,
          })
        }
        logger.bot(`Max-5-days rule: removed ${toRemove.size} excess assignments`)
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

    // ── Business rules check (both live and mockData paths) ──────────────────
    let ruleConflicts = []
    if (assignments.length > 0) {
      try {
        const { applyRulesToAssignments } = await import('../rules/businessRules.js')
        let rules = mockRules
        if (!rules) {
          const { getRules } = await import('../rules/rulesDb.js')
          rules = await getRules(groupId)
        }
        if (rules?.length > 0) {
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

    // ── B.03: flag when regenerating for a week that already has published assignments ──
    const alreadyPublished = mockData
      ? (mockData.publishedCount != null ? mockData.publishedCount > 0 : false)
      : false  // live mode: caller should pass publishedCount via options if needed

    const warnings = []
    if (useFallback) {
      warnings.push({
        type: 'no_availability',
        message: 'No availability was submitted for this week — schedule generated without availability filtering. Please verify before publishing.',
      })
    }
    if (useRequirementsFallback) {
      warnings.push({
        type: 'no_requirements',
        message: 'No shift role requirements configured — defaulted to 1 staff per shift (any role). Configure role counts in Settings for better results.',
      })
    }

    return { assignments, gaps, weekStart, scheduleId: saved?.id ?? null, clopenings, hoursIssues, ruleConflicts, crossTrainingUsed, alreadyPublished, warnings }
  } catch (err) {
    logger.error(`generateWeeklySchedule failed: ${err.message}`)
    return { assignments: [], gaps: [], weekStart, scheduleId: null, warnings: [] }
  }
  })()
  _inProgress.set(_key, _promise)
  try { return await _promise } finally { _inProgress.delete(_key) }
}

// Formats a warnings[] array from generateWeeklySchedule into Telegram markdown.
// Returns '' if there are no warnings. Each warning becomes a single bullet.
export function formatWarningsSection(warnings) {
  if (!warnings || warnings.length === 0) return ''
  const lines = warnings.map(w => `• ${w.message}`).join('\n')
  return `\n\n⚠️ *Setup warnings:*\n${lines}`
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
