// Minor-labor rules engine (Epic 4 / WP-4.3) — PURE, no I/O.
//
// Given a worker's age (or DOB) and a proposed shift (start/end/day), decide
// whether it's legal for a minor and list any violations, using the jurisdiction
// `ruleset.minor` bands (from complianceProfiles). Drives scheduling blocks and
// the chat warning "⚠️ Sam is 17, can't work past 10pm on a school night" (WP-4.5).
//
// Bands: ages 14–15 use the '14' band, 16–17 use the '16' band, <14 is barred,
// 18+ is unrestricted. School context (night/day/week) selects the stricter
// limits; it's derived from the weekday + whether school is in session, with
// explicit overrides for callers that know better.

const HHMM = /^(\d{1,2}):(\d{2})$/
const SCHOOL_DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
// Nights before a school day: Sun→Mon … Thu→Fri.
const SCHOOL_NIGHTS = new Set(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'])

function toMinutes(hhmm) {
  const m = HHMM.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Whole years between dob and asOf (default today). */
export function ageFromDob(dob, asOf = new Date()) {
  const b = new Date(dob)
  const ref = asOf instanceof Date ? asOf : new Date(asOf)
  if (Number.isNaN(b.getTime()) || Number.isNaN(ref.getTime())) return null
  let age = ref.getUTCFullYear() - b.getUTCFullYear()
  const mo = ref.getUTCMonth() - b.getUTCMonth()
  if (mo < 0 || (mo === 0 && ref.getUTCDate() < b.getUTCDate())) age--
  return age
}

/** Pick the rule band for an age, or null if unrestricted/barred. */
export function bandForAge(age) {
  if (age == null) return null
  if (age >= 18 || age < 14) return null
  return age <= 15 ? '14' : '16'
}

function deriveSchoolContext(day, schoolInSession) {
  const d = String(day ?? '').trim().toLowerCase()
  if (!schoolInSession) return { schoolNight: false, schoolDay: false, schoolWeek: false }
  return {
    schoolNight: SCHOOL_NIGHTS.has(d),
    schoolDay: SCHOOL_DAYS.has(d),
    schoolWeek: true,
  }
}

/**
 * Evaluate a proposed shift for a minor.
 * @param {object} input
 * @param {number} [input.age]                 - age in years (or provide dob)
 * @param {string|Date} [input.dob]            - date of birth
 * @param {string|Date} [input.asOf]           - reference date for age (default now)
 * @param {string} [input.start]               - 'HH:MM'
 * @param {string} [input.end]                 - 'HH:MM' (may cross midnight)
 * @param {string} [input.day]                 - weekday name
 * @param {boolean} [input.schoolInSession=true]
 * @param {boolean} [input.schoolNight]        - override derived value
 * @param {boolean} [input.schoolDay]          - override derived value
 * @param {boolean} [input.schoolWeek]         - override derived value
 * @param {number} [input.weeklyHoursSoFar=0]  - already-scheduled hours this week
 * @param {object} ruleset                     - jurisdiction ruleset (.minor bands)
 * @returns {{age:number|null, band:string|null, isMinor:boolean, allowed:boolean,
 *           hours:number|null, violations:object[], limits:object|null}}
 */
export function checkMinorShift(input = {}, ruleset = {}) {
  const age = input.age != null ? input.age : (input.dob != null ? ageFromDob(input.dob, input.asOf ? new Date(input.asOf) : new Date()) : null)
  const band = bandForAge(age)
  const violations = []

  // Adults (or unknown-but-clearly-adult) — nothing to enforce here.
  if (age == null) return { age: null, band: null, isMinor: false, allowed: true, hours: null, violations: [], limits: null }
  if (age >= 18) return { age, band: null, isMinor: false, allowed: true, hours: null, violations: [], limits: null }

  // Under the minimum working age.
  if (age < 14) {
    violations.push({ code: 'under_minimum_age', message: `Workers under 14 can't be scheduled (age ${age}).` })
    return { age, band: null, isMinor: true, allowed: false, hours: null, violations, limits: null }
  }

  const limits = ruleset?.minor?.[band] ?? null
  const startMin = toMinutes(input.start)
  let endMin = toMinutes(input.end)
  let hours = null
  if (startMin != null && endMin != null) {
    if (endMin <= startMin) endMin += 24 * 60 // overnight
    hours = (endMin - startMin) / 60
  }

  if (!limits) {
    // No band-specific rules in this jurisdiction — allow but flag as a minor.
    return { age, band, isMinor: true, allowed: true, hours, violations, limits: null }
  }

  const sc = {
    schoolNight: input.schoolNight ?? deriveSchoolContext(input.day, input.schoolInSession ?? true).schoolNight,
    schoolDay: input.schoolDay ?? deriveSchoolContext(input.day, input.schoolInSession ?? true).schoolDay,
    schoolWeek: input.schoolWeek ?? deriveSchoolContext(input.day, input.schoolInSession ?? true).schoolWeek,
  }

  // Time-of-day window.
  if (startMin != null && endMin != null) {
    const earliestMin = toMinutes(limits.earliest)
    if (earliestMin != null && startMin < earliestMin) {
      violations.push({ code: 'before_earliest', message: `Can't start before ${limits.earliest} (starts ${input.start}).`, limit: limits.earliest })
    }
    const latestStr = sc.schoolNight ? limits.latestSchoolNight : limits.latestNonSchool
    let latestMin = toMinutes(latestStr)
    if (latestMin != null) {
      // A past-midnight latest (e.g. '00:30') is earlier on the clock than the
      // start, so roll it into the next day for comparison.
      if (latestMin < (toMinutes(limits.earliest) ?? 0)) latestMin += 24 * 60
      if (endMin > latestMin) {
        violations.push({ code: 'after_latest', message: `Can't work past ${latestStr}${sc.schoolNight ? ' on a school night' : ''} (ends ${input.end}).`, limit: latestStr })
      }
    }
  }

  // Daily hours.
  if (hours != null) {
    const maxDaily = sc.schoolDay ? limits.maxDailySchool : limits.maxDailyNonSchool
    if (maxDaily != null && hours > maxDaily + 1e-9) {
      violations.push({ code: 'over_daily_max', message: `Max ${maxDaily}h on a ${sc.schoolDay ? 'school' : 'non-school'} day (this shift is ${Number(hours.toFixed(2))}h).`, limit: maxDaily })
    }
  }

  // Weekly hours (only when caller tracks the running total).
  if (typeof input.weeklyHoursSoFar === 'number' && hours != null) {
    const maxWeekly = sc.schoolWeek ? limits.maxWeeklySchool : limits.maxWeeklyNonSchool
    if (maxWeekly != null && input.weeklyHoursSoFar + hours > maxWeekly + 1e-9) {
      violations.push({ code: 'over_weekly_max', message: `Max ${maxWeekly}h/week in a ${sc.schoolWeek ? 'school' : 'non-school'} week (would reach ${Number((input.weeklyHoursSoFar + hours).toFixed(2))}h).`, limit: maxWeekly })
    }
  }

  return { age, band, isMinor: true, allowed: violations.length === 0, hours, violations, limits }
}
