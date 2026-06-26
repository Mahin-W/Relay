// Schedule compliance evaluator (Epic 4 / WP-4.5) — PURE, no I/O.
//
// Runs a generated schedule's assignments against a jurisdiction ruleset and
// surfaces: (a) minor-labor violations to BLOCK/WARN on, and (b) the meal/rest
// breaks each shift requires. Used by generateSchedule.js (additive warnings)
// and the /compliance report. Pure: callers pass assignments + staff + ruleset.

import { checkMinorShift } from './minorLabor.js'
import { planBreaks, shiftHours } from './breakPlanning.js'

const DAY_ORDER = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

/**
 * @param {object[]} assignments - { staffId, staffName, dayOfWeek, startTime, endTime, shiftName }
 * @param {object[]} staff       - { id|staffId, name, dob?, age? }
 * @param {object} ruleset       - jurisdiction ruleset (complianceProfiles)
 * @param {object} [opts]        - { asOf, schoolInSession=true }
 * @returns {{issues:object[], breaks:object[], warnings:object[], hasViolations:boolean, violationCount:number}}
 */
export function evaluateScheduleCompliance(assignments = [], staff = [], ruleset = {}, opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date()
  const schoolInSession = opts.schoolInSession ?? true

  const byId = new Map()
  for (const s of staff || []) byId.set(String(s.id ?? s.staffId), s)

  // Deterministic weekly accumulation: order by weekday.
  const sorted = [...(assignments || [])].sort(
    (a, b) => (DAY_ORDER[a.dayOfWeek] ?? 8) - (DAY_ORDER[b.dayOfWeek] ?? 8),
  )

  const weekHoursByStaff = new Map()
  const issues = []
  const breaks = []

  for (const a of sorted) {
    const s = byId.get(String(a.staffId)) ?? {}
    const dur = shiftHours({ start: a.startTime, end: a.endTime })
    const prior = weekHoursByStaff.get(String(a.staffId)) ?? 0

    const minor = checkMinorShift(
      { dob: s.dob, age: s.age, asOf, start: a.startTime, end: a.endTime, day: a.dayOfWeek, schoolInSession, weeklyHoursSoFar: prior },
      ruleset,
    )
    if (minor.isMinor && minor.violations.length > 0) {
      for (const v of minor.violations) {
        issues.push({
          staffId: a.staffId, staffName: a.staffName ?? s.name ?? null,
          day: a.dayOfWeek, shiftName: a.shiftName ?? null,
          age: minor.age, code: v.code,
          message: `${a.staffName ?? s.name ?? 'Staff'} (age ${minor.age}): ${v.message}`,
          severity: 'block',
        })
      }
    }
    weekHoursByStaff.set(String(a.staffId), prior + dur)

    // Required breaks for this shift (informational — for insertion / reports).
    const bp = planBreaks({ start: a.startTime, end: a.endTime }, ruleset)
    if (bp.breaks.length > 0) {
      breaks.push({ staffId: a.staffId, staffName: a.staffName ?? s.name ?? null, day: a.dayOfWeek, shiftName: a.shiftName ?? null, ...bp })
    }
  }

  // De-dupe identical warning messages (same staff can trip the same rule twice).
  const seen = new Set()
  const warnings = []
  for (const i of issues) {
    const msg = `⚠️ ${i.message}`
    if (seen.has(msg)) continue
    seen.add(msg)
    warnings.push({ type: 'compliance', message: msg })
  }

  return { issues, breaks, warnings, hasViolations: issues.length > 0, violationCount: issues.length }
}

/** Render a human-readable compliance report (pure). */
export function formatComplianceReport(result, opts = {}) {
  const where = opts.location ? ` — ${opts.location}` : ''
  const lines = [`🛡️ *Labor-law compliance${where}*`]

  if (!result || (result.violationCount === 0 && (!result.breaks || result.breaks.length === 0))) {
    lines.push('\n✅ No compliance issues detected for this schedule.')
    return lines.join('\n')
  }

  if (result.violationCount > 0) {
    lines.push(`\n🚫 *${result.violationCount} violation${result.violationCount === 1 ? '' : 's'} to fix:*`)
    for (const i of result.issues) lines.push(`• ${i.day}: ${i.message}`)
  } else {
    lines.push('\n✅ No minor-labor violations.')
  }

  if (result.breaks && result.breaks.length > 0) {
    lines.push(`\n☕ *Required breaks (${result.breaks.length} shift${result.breaks.length === 1 ? '' : 's'}):*`)
    for (const b of result.breaks) {
      const meal = b.meals.length ? `${b.meals.length}×meal` : ''
      const rest = b.rests.length ? `${b.rests.length}×rest` : ''
      const parts = [meal, rest].filter(Boolean).join(', ')
      lines.push(`• ${b.staffName ?? 'Staff'} ${b.day} (${Number(b.hours)}h): ${parts}`)
    }
  }
  return lines.join('\n')
}
