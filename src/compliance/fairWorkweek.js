// Fair Workweek / predictive-scheduling engine (Epic 4 / WP-4.4) — PURE, no I/O.
//
// In Fair-Workweek jurisdictions (NYC, SF, Chicago, Philadelphia, Oregon, …)
// employers must post schedules in advance (typically 14 days) and owe
// "predictability pay" when they change a posted shift on short notice:
//   • employer ADDS a shift / hours / moves a shift  → 1 hour premium
//   • employer CUTS hours or cancels a shift         → half the lost hours
//   • back-to-back close→open ("clopening") <11h     → 1 hour premium
// Employee-requested changes (with consent) never trigger predictability pay.
//
// Everything here is a pure transform of change records + a jurisdiction ruleset
// (from complianceProfiles). Persistence/tracking of changes lives elsewhere
// (compliance_events, WP-4.6); this module decides what's owed.

const ADD_TYPES = new Set(['add_shift', 'add_hours', 'time_change'])
const LOSS_TYPES = new Set(['reduce_hours', 'cancel_shift', 'subtract_hours'])
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days of advance notice between posting and the shift start. */
export function noticeDays(postedAt, shiftStart) {
  const a = postedAt instanceof Date ? postedAt : new Date(postedAt)
  const b = shiftStart instanceof Date ? shiftStart : new Date(shiftStart)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS)
}

const round2 = (n) => Math.round(n * 100) / 100

/**
 * Assess one posted-schedule change for predictability pay.
 * @param {object} change
 * @param {string} change.type          - add_shift|add_hours|time_change|reduce_hours|cancel_shift|clopening
 * @param {string|Date} [change.postedAt]   - when the schedule was posted
 * @param {string|Date} [change.shiftStart] - when the affected shift starts
 * @param {number} [change.noticeDays]   - explicit advance-notice days (overrides postedAt/shiftStart)
 * @param {number} [change.shiftHours]   - length of a cancelled shift
 * @param {number} [change.originalHours]- hours before the change (for reductions)
 * @param {number} [change.newHours]     - hours after the change (for reductions)
 * @param {number} [change.lostHours]    - explicit lost hours (overrides original−new)
 * @param {boolean} [change.employeeInitiated] - employee asked for it ⇒ no premium
 * @param {object} ruleset               - jurisdiction ruleset (.fairWorkweek, .advanceNoticeDays)
 * @returns {{owed:boolean, premiumHours:number, reason:string, noticeDays:number|null, changeType:string}}
 */
export function assessChange(change = {}, ruleset = {}) {
  const changeType = String(change.type ?? 'unknown')
  const base = { owed: false, premiumHours: 0, noticeDays: null, changeType }

  if (!ruleset.fairWorkweek) return { ...base, reason: 'not_a_fair_workweek_jurisdiction' }
  if (change.employeeInitiated) return { ...base, reason: 'employee_initiated' }

  const days = change.noticeDays != null ? change.noticeDays : noticeDays(change.postedAt, change.shiftStart)
  base.noticeDays = days
  const threshold = ruleset.advanceNoticeDays ?? 14

  // Enough advance notice → no premium.
  if (days != null && days >= threshold) return { ...base, reason: 'sufficient_notice' }

  if (changeType === 'clopening') {
    return { ...base, owed: true, premiumHours: 1, reason: 'clopening_premium' }
  }
  if (ADD_TYPES.has(changeType)) {
    return { ...base, owed: true, premiumHours: 1, reason: 'employer_added_or_moved' }
  }
  if (LOSS_TYPES.has(changeType)) {
    const lost = change.lostHours != null
      ? change.lostHours
      : (changeType === 'cancel_shift'
          ? (change.shiftHours ?? 0)
          : Math.max(0, (change.originalHours ?? 0) - (change.newHours ?? 0)))
    return { ...base, owed: lost > 0, premiumHours: round2(lost * 0.5), reason: 'employer_reduced_hours', lostHours: lost }
  }

  return { ...base, reason: 'no_rule_for_change_type' }
}

/**
 * Aggregate predictability pay across many changes.
 * @param {object[]} changes
 * @param {object} ruleset
 * @param {number|null} [hourlyRateCents] - when provided, also totals premium $ owed
 * @returns {{totalPremiumHours:number, totalPremiumCents:number|null, owedCount:number, lineItems:object[]}}
 */
export function summarizePredictabilityPay(changes = [], ruleset = {}, hourlyRateCents = null) {
  const lineItems = (changes || []).map((c) => ({ ...c, assessment: assessChange(c, ruleset) }))
  const owed = lineItems.filter(li => li.assessment.owed)
  const totalPremiumHours = round2(owed.reduce((s, li) => s + li.assessment.premiumHours, 0))
  const totalPremiumCents = hourlyRateCents != null
    ? Math.round(totalPremiumHours * hourlyRateCents)
    : null
  return { totalPremiumHours, totalPremiumCents, owedCount: owed.length, lineItems }
}

/**
 * Whether a posted schedule meets the advance-notice requirement.
 * @returns {{compliant:boolean, required:number, actual:number|null, fairWorkweek:boolean}}
 */
export function checkAdvanceNotice(postedAt, earliestShiftStart, ruleset = {}) {
  const required = ruleset.advanceNoticeDays ?? 14
  if (!ruleset.fairWorkweek) return { compliant: true, required, actual: null, fairWorkweek: false }
  const actual = noticeDays(postedAt, earliestShiftStart)
  return { compliant: actual != null && actual >= required, required, actual, fairWorkweek: true }
}
