// Sales forecaster (Epic 3 / WP-3.6) — PURE.
//
// Demand-matched scheduling input: forecast a day's sales from the trailing
// average of the same weekday, and translate that into a suggested labor-hours
// budget via a configurable sales-per-labor-hour target. No DB — operates on
// injected history so it's fully deterministic + testable. The POS connectors
// that supply real history (Toast/Square, WP-3.2–3.5) are blocked-on-human.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_MS = 86400000

/** Weekday name for a 'YYYY-MM-DD' date (UTC), or null if invalid. */
export function weekdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  return WEEKDAYS[d.getUTCDay()]
}

/**
 * Forecast one day's net sales (cents) = average of the most recent `weeks`
 * occurrences of the same weekday strictly before targetDate.
 * @param {Array<{date:string, dayOfWeek?:string, netSalesCents:number}>} history
 * @param {string} targetDate 'YYYY-MM-DD'
 * @param {{weeks?:number}} [opts]
 * @returns {number|null} forecast cents, or null with no matching history
 */
export function forecastDay(history, targetDate, opts = {}) {
  const { weeks = 4 } = opts
  const wd = weekdayOf(targetDate)
  if (!wd) return null
  const target = new Date(`${targetDate}T00:00:00Z`).getTime()

  const sameWeekday = (history ?? [])
    .filter(h => h && h.netSalesCents != null && h.date)
    .filter(h => (h.dayOfWeek ?? weekdayOf(h.date)) === wd)
    .filter(h => {
      const t = new Date(`${h.date}T00:00:00Z`).getTime()
      return !isNaN(t) && t < target
    })
    .sort((a, b) => new Date(`${b.date}T00:00:00Z`) - new Date(`${a.date}T00:00:00Z`))
    .slice(0, weeks)

  if (sameWeekday.length === 0) return null
  const avg = sameWeekday.reduce((s, h) => s + Number(h.netSalesCents), 0) / sameWeekday.length
  return Math.round(avg)
}

/** Forecast all 7 days from weekStartDate. */
export function forecastWeek(history, weekStartDate, opts = {}) {
  const start = new Date(`${weekStartDate}T00:00:00Z`)
  if (isNaN(start.getTime())) return []
  const out = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
    const ds = d.toISOString().slice(0, 10)
    out.push({ date: ds, dayOfWeek: WEEKDAYS[d.getUTCDay()], forecastCents: forecastDay(history, ds, opts) })
  }
  return out
}

/** Suggested labor hours for a forecast, via a sales-per-labor-hour target. */
export function staffingHint(forecastCents, opts = {}) {
  const { salesPerLaborHourCents = 0 } = opts
  if (!(forecastCents > 0) || !(salesPerLaborHourCents > 0)) return null
  return Math.round((forecastCents / salesPerLaborHourCents) * 10) / 10
}

/** Forecast a week and attach a suggested labor-hours budget per day. */
export function forecastWithStaffing(history, weekStartDate, opts = {}) {
  return forecastWeek(history, weekStartDate, opts).map(d => ({
    ...d,
    suggestedLaborHours: d.forecastCents != null ? staffingHint(d.forecastCents, opts) : null,
  }))
}
