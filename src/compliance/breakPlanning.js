// Break-planning engine (Epic 4 / WP-4.2) — PURE, no I/O.
//
// Given a shift length (hours, or start/end clock times) and a jurisdiction
// `ruleset` (from complianceProfiles.resolveRuleset / getRuleset), compute the
// required meal (unpaid) and rest (paid) breaks and where they fall, so the
// scheduler (WP-4.5) can insert them and pay code can net out unpaid time.
//
// The rules are pragmatic baselines: one 30-min unpaid meal per `meal.afterHours`
// worked, one paid `rest.durationMin` rest per `rest.perHours` worked. A null
// threshold in the ruleset means that break type isn't mandated (no breaks).

const HHMM = /^(\d{1,2}):(\d{2})$/

/** 'HH:MM' → minutes since midnight, or null if unparseable. */
function toMinutes(hhmm) {
  const m = HHMM.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Hours worked for a shift given {hours} or {start,end} (overnight aware). */
export function shiftHours({ hours = null, start = null, end = null } = {}) {
  if (typeof hours === 'number' && Number.isFinite(hours)) return Math.max(0, hours)
  const s = toMinutes(start); const e = toMinutes(end)
  if (s == null || e == null) return 0
  let span = e - s
  if (span < 0) span += 24 * 60 // crosses midnight
  return span / 60
}

/**
 * Plan breaks for one shift.
 * @param {object} shift - { hours } OR { start:'HH:MM', end:'HH:MM' }
 * @param {object} ruleset - jurisdiction ruleset with .meal and .rest
 * @returns {{
 *   hours:number, meals:object[], rests:object[], breaks:object[],
 *   unpaidMinutes:number, paidMinutes:number, notes:string[]
 * }}
 */
export function planBreaks(shift = {}, ruleset = {}) {
  const hours = shiftHours(shift)
  const meal = ruleset.meal ?? {}
  const rest = ruleset.rest ?? {}
  const notes = []

  const meals = []
  if (meal.afterHours != null && hours >= meal.afterHours) {
    const count = Math.floor(hours / meal.afterHours)
    for (let i = 1; i <= count; i++) {
      meals.push({
        type: 'meal', paid: meal.paid === true, durationMin: meal.durationMin ?? 30,
        // A meal is due as the i-th `afterHours` block completes.
        dueAfterHours: meal.afterHours * i,
      })
    }
    notes.push(`${count} meal break${count > 1 ? 's' : ''} (${meal.durationMin ?? 30} min, ${meal.paid ? 'paid' : 'unpaid'}) required after ${meal.afterHours}h`)
  }

  const rests = []
  if (rest.perHours != null && hours >= rest.perHours) {
    const count = Math.floor(hours / rest.perHours)
    for (let j = 1; j <= count; j++) {
      rests.push({
        type: 'rest', paid: rest.paid !== false, durationMin: rest.durationMin ?? 10,
        // Rests fall mid-block.
        dueAfterHours: Number((rest.perHours * (j - 0.5)).toFixed(2)),
      })
    }
    notes.push(`${count} rest break${count > 1 ? 's' : ''} (${rest.durationMin ?? 10} min, paid) per ${rest.perHours}h`)
  }

  const breaks = [...meals, ...rests].sort((a, b) => a.dueAfterHours - b.dueAfterHours)
  const unpaidMinutes = breaks.filter(b => !b.paid).reduce((s, b) => s + b.durationMin, 0)
  const paidMinutes = breaks.filter(b => b.paid).reduce((s, b) => s + b.durationMin, 0)

  return { hours, meals, rests, breaks, unpaidMinutes, paidMinutes, notes }
}
