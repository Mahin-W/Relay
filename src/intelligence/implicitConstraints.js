import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// ── Core analysis ──────────────────────────────────────────────────────────

export async function analyzeAssignmentPatterns(groupId, weeksBack = 10, db = null) {
  const assignments = db?.getAssignments
    ? await db.getAssignments(groupId, weeksBack)
    : await fetchAssignments(groupId, weeksBack)

  const staff = db?.getStaff
    ? await db.getStaff(groupId)
    : await fetchStaff(groupId)

  const shifts = db?.getShifts
    ? await db.getShifts(groupId)
    : await fetchShifts(groupId)

  const availability = db?.getAvailability
    ? await db.getAvailability(groupId)
    : await fetchAvailability(groupId)

  // Only published assignments
  const published = assignments.filter(a => a.status === 'published')

  // Determine unique weeks
  const uniqueWeeks = [...new Set(published.map(a => a.week_start))]
  const weeksAnalyzed = uniqueWeeks.length

  const staffMap = new Map(staff.map(s => [s.id, s]))
  const shiftMap = new Map(shifts.map(s => [s.id, s]))

  // Build unavailability lookup: staffId -> Set of days
  const unavailableDays = new Map()
  for (const av of availability) {
    if (av.available === false) {
      if (!unavailableDays.has(av.staff_id)) unavailableDays.set(av.staff_id, new Set())
      unavailableDays.get(av.staff_id).add(av.day_of_week)
    }
  }

  const patterns = []

  // ── NEVER_TOGETHER ─────────────────────────────────────────────────────
  if (weeksAnalyzed >= 8) {
    // For each pair of staff, check if they ever share a shift+day in any week
    const staffIds = staff.map(s => s.id)
    for (let i = 0; i < staffIds.length; i++) {
      for (let j = i + 1; j < staffIds.length; j++) {
        const idA = staffIds[i]
        const idB = staffIds[j]

        // Check both are active enough (at least 4 weeks each)
        const weeksA = new Set(published.filter(a => a.staff_id === idA).map(a => a.week_start))
        const weeksB = new Set(published.filter(a => a.staff_id === idB).map(a => a.week_start))
        if (weeksA.size < 4 || weeksB.size < 4) continue

        // Check if they ever share a shift+day in any week
        let everTogether = false
        for (const a of published) {
          if (a.staff_id !== idA) continue
          for (const b of published) {
            if (b.staff_id !== idB) continue
            if (a.shift_id === b.shift_id && a.day_of_week === b.day_of_week && a.week_start === b.week_start) {
              everTogether = true
              break
            }
          }
          if (everTogether) break
        }

        if (!everTogether) {
          const sA = staffMap.get(idA)
          const sB = staffMap.get(idB)
          patterns.push({
            type: 'never_together',
            confidence: 1.0,
            weeksAnalyzed,
            staffIdA: idA,
            staffNameA: sA?.name,
            staffIdB: idB,
            staffNameB: sB?.name,
            shiftId: null,
            shiftName: null,
            dayOfWeek: null,
            description: `${sA?.name} and ${sB?.name} have never been scheduled on the same shift+day in ${weeksAnalyzed} weeks`,
          })
        }
      }
    }
  }

  // ── ALWAYS_ON_SHIFT ────────────────────────────────────────────────────
  if (weeksAnalyzed >= 6) {
    for (const s of staff) {
      for (const shift of shifts) {
        // Count weeks where this staff was on this shift (any day)
        const staffShiftWeeks = new Set(
          published
            .filter(a => a.staff_id === s.id && a.shift_id === shift.id)
            .map(a => a.week_start)
        )
        const ratio = staffShiftWeeks.size / weeksAnalyzed
        if (ratio >= 0.8) {
          patterns.push({
            type: 'always_on_shift',
            confidence: Math.round(ratio * 100) / 100,
            weeksAnalyzed,
            staffIdA: s.id,
            staffNameA: s.name,
            staffIdB: null,
            staffNameB: null,
            shiftId: shift.id,
            shiftName: shift.name,
            dayOfWeek: shift.day_of_week || null,
            description: `${s.name} has been on ${shift.name} for ${staffShiftWeeks.size} of ${weeksAnalyzed} weeks`,
          })
        }
      }
    }
  }

  // ── NEVER_ON_DAY ───────────────────────────────────────────────────────
  if (weeksAnalyzed >= 6) {
    for (const s of staff) {
      // Check each day
      const staffAssignments = published.filter(a => a.staff_id === s.id)
      const staffWeeks = new Set(staffAssignments.map(a => a.week_start))
      if (staffWeeks.size < 4) continue // must be sufficiently active

      const staffDays = new Set(staffAssignments.map(a => a.day_of_week))

      for (const day of DAYS) {
        if (staffDays.has(day)) continue
        // Never scheduled on this day — but is it explicit unavailability?
        if (unavailableDays.get(s.id)?.has(day)) continue

        patterns.push({
          type: 'never_on_day',
          confidence: 1.0,
          weeksAnalyzed,
          staffIdA: s.id,
          staffNameA: s.name,
          staffIdB: null,
          staffNameB: null,
          shiftId: null,
          shiftName: null,
          dayOfWeek: day,
          description: `${s.name} has never been scheduled on ${day} in ${weeksAnalyzed} weeks`,
        })
      }
    }
  }

  // ── ALWAYS_TOGETHER ────────────────────────────────────────────────────
  if (weeksAnalyzed >= 6) {
    const staffIds = staff.map(s => s.id)
    for (let i = 0; i < staffIds.length; i++) {
      for (let j = i + 1; j < staffIds.length; j++) {
        const idA = staffIds[i]
        const idB = staffIds[j]

        for (const shift of shifts) {
          // Count weeks where both are on this shift on the same day
          const togetherWeeks = new Set()
          for (const week of uniqueWeeks) {
            const aOnShift = published.find(a =>
              a.staff_id === idA && a.shift_id === shift.id && a.week_start === week
            )
            const bOnShift = published.find(a =>
              a.staff_id === idB && a.shift_id === shift.id && a.week_start === week &&
              a.day_of_week === aOnShift?.day_of_week
            )
            if (aOnShift && bOnShift) {
              togetherWeeks.add(week)
            }
          }

          const ratio = togetherWeeks.size / weeksAnalyzed
          if (ratio >= 0.75) {
            const sA = staffMap.get(idA)
            const sB = staffMap.get(idB)
            patterns.push({
              type: 'always_together',
              confidence: Math.round(ratio * 100) / 100,
              weeksAnalyzed,
              staffIdA: idA,
              staffNameA: sA?.name,
              staffIdB: idB,
              staffNameB: sB?.name,
              shiftId: shift.id,
              shiftName: shift.name,
              dayOfWeek: null,
              description: `${sA?.name} and ${sB?.name} have been on ${shift.name} together ${togetherWeeks.size} of ${weeksAnalyzed} weeks`,
            })
          }
        }
      }
    }
  }

  // Only return patterns with confidence >= 0.7
  return patterns.filter(p => p.confidence >= 0.7)
}

// ── Filter known constraints ───────────────────────────────────────────────

export function filterAlreadyKnownConstraints(patterns, existingRules, dismissedPatterns = []) {
  return patterns.filter(pattern => {
    // Check against existing business rules
    for (const rule of existingRules) {
      if (pattern.type === 'never_together' && rule.type === 'staff_conflict') {
        const ruleIds = [rule.subject_staff_id, rule.object_staff_id].sort()
        const patternIds = [pattern.staffIdA, pattern.staffIdB].sort()
        if (ruleIds[0] === patternIds[0] && ruleIds[1] === patternIds[1]) return false
      }
      if (pattern.type === 'always_on_shift' && rule.type === 'shift_preference') {
        if (rule.subject_staff_id === pattern.staffIdA && rule.shift_id === pattern.shiftId) return false
      }
      if (pattern.type === 'never_on_day' && rule.type === 'day_off') {
        if (rule.subject_staff_id === pattern.staffIdA && rule.day_of_week === pattern.dayOfWeek) return false
      }
    }

    // Check against dismissed patterns
    for (const d of dismissedPatterns) {
      if (d.type !== pattern.type) continue
      if (pattern.type === 'never_together') {
        const dIds = [d.staff_id_a, d.staff_id_b].sort()
        const pIds = [pattern.staffIdA, pattern.staffIdB].sort()
        if (dIds[0] === pIds[0] && dIds[1] === pIds[1]) return false
      }
      if (pattern.type === 'always_on_shift') {
        if (d.staff_id_a === pattern.staffIdA && d.shift_id === pattern.shiftId) return false
      }
      if (pattern.type === 'never_on_day') {
        if (d.staff_id_a === pattern.staffIdA && d.day_of_week === pattern.dayOfWeek) return false
      }
      if (pattern.type === 'always_together') {
        const dIds = [d.staff_id_a, d.staff_id_b].sort()
        const pIds = [pattern.staffIdA, pattern.staffIdB].sort()
        if (dIds[0] === pIds[0] && dIds[1] === pIds[1] && d.shift_id === pattern.shiftId) return false
      }
    }

    return true
  })
}

// ── Generate discovery prompts ─────────────────────────────────────────────

export function generateDiscoveryPrompts(patterns) {
  // Max 2 prompts per run
  const limited = patterns.slice(0, 2)
  return limited.map((pattern, idx) => {
    const patternId = `disc_${Date.now()}_${idx}`
    let question

    switch (pattern.type) {
      case 'never_together':
        question = `I've noticed you never schedule ${pattern.staffNameA} and ${pattern.staffNameB} together. Should I add this as a permanent rule?`
        break
      case 'always_on_shift':
        question = `${pattern.staffNameA} has been on ${pattern.shiftName} every week for ${pattern.weeksAnalyzed} weeks. Should I keep prioritizing this?`
        break
      case 'never_on_day':
        question = `${pattern.staffNameA} hasn't worked ${pattern.dayOfWeek} in ${pattern.weeksAnalyzed} weeks. Should I treat ${pattern.dayOfWeek} as their day off?`
        break
      case 'always_together':
        question = `I've noticed you often pair ${pattern.staffNameA} and ${pattern.staffNameB} on shifts. Should I prioritize this pairing?`
        break
      default:
        question = `Detected pattern: ${pattern.description}`
    }

    return {
      patternId,
      question,
      type: pattern.type,
      patternData: pattern,
    }
  })
}

// ── DB operations ──────────────────────────────────────────────────────────

export async function saveDiscoveredPattern(groupId, pattern, db = null) {
  if (db?.saveDiscoveredPattern) return db.saveDiscoveredPattern(groupId, pattern)

  const { data, error } = await supabase
    .from('discovered_patterns')
    .insert({
      group_id: groupId,
      type: pattern.type,
      staff_id_a: pattern.staffIdA || null,
      staff_id_b: pattern.staffIdB || null,
      shift_id: pattern.shiftId || null,
      day_of_week: pattern.dayOfWeek || null,
      confidence: pattern.confidence,
      weeks_analyzed: pattern.weeksAnalyzed,
      status: 'pending',
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function dismissPattern(patternId, db = null) {
  if (db?.dismissPattern) return db.dismissPattern(patternId)

  const { data, error } = await supabase
    .from('discovered_patterns')
    .update({ status: 'dismissed', responded_at: new Date().toISOString() })
    .eq('id', patternId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getDismissedPatterns(groupId, db = null) {
  if (db?.getDismissedPatterns) return db.getDismissedPatterns(groupId)

  const { data, error } = await supabase
    .from('discovered_patterns')
    .select('*')
    .eq('group_id', groupId)
    .eq('status', 'dismissed')
  if (error) throw error
  return data
}

// ── Week number & discovery scheduling ─────────────────────────────────────

export function getWeekNumber(weekStart) {
  const date = new Date(weekStart + 'T00:00:00Z')
  // ISO week number calculation
  const target = new Date(date.valueOf())
  // Set to nearest Thursday (ISO weeks start Monday, week 1 contains Jan 4)
  const dayNum = (date.getUTCDay() + 6) % 7 // Monday=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3) // Thursday
  const jan4 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const dayDiff = (target - jan4) / 86400000
  return 1 + Math.round(dayDiff / 7)
}

export async function shouldRunDiscovery(groupId, weekStart, db = null) {
  const weekNum = getWeekNumber(weekStart)
  if (weekNum % 4 !== 0) return false

  // Check if discovery already ran this week
  const existing = db?.getDiscoveredPatternsThisWeek
    ? await db.getDiscoveredPatternsThisWeek(groupId, weekStart)
    : await fetchDiscoveredPatternsThisWeek(groupId, weekStart)

  return existing.length === 0
}

// ── Supabase fetch helpers (used when no db injected) ──────────────────────

async function fetchAssignments(groupId, weeksBack) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - weeksBack * 7)
  const { data, error } = await supabase
    .from('schedule_assignments')
    .select('*')
    .eq('group_id', groupId)
    .eq('status', 'published')
    .gte('week_start', cutoff.toISOString().split('T')[0])
  if (error) throw error
  return data
}

async function fetchStaff(groupId) {
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('group_id', groupId)
  if (error) throw error
  return data
}

async function fetchShifts(groupId) {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('group_id', groupId)
  if (error) throw error
  return data
}

async function fetchAvailability(groupId) {
  const { data, error } = await supabase
    .from('availability')
    .select('*')
    .eq('group_id', groupId)
  if (error) throw error
  return data || []
}

async function fetchDiscoveredPatternsThisWeek(groupId, weekStart) {
  const weekEnd = new Date(weekStart + 'T00:00:00Z')
  weekEnd.setDate(weekEnd.getDate() + 7)
  const { data, error } = await supabase
    .from('discovered_patterns')
    .select('*')
    .eq('group_id', groupId)
    .gte('created_at', weekStart)
    .lt('created_at', weekEnd.toISOString().split('T')[0])
  if (error) throw error
  return data || []
}
