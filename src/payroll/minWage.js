// P1-23/P1-24: a single minimum-wage floor used for late-deduction capping and
// for warning managers when a role rate is saved below the legal minimum.
// US federal default; override per-deployment with the MIN_WAGE env var.
export const MIN_WAGE = Number(process.env.MIN_WAGE) || 7.25

// Returns a warning string when `rate` is a real value below MIN_WAGE, else null.
// Non-blocking — managers can still save (e.g. tipped sub-minimums), but they're
// told loudly so a typo like $5 instead of $15 doesn't silently underpay staff.
export function minWageWarning(rate) {
  const r = Number(rate)
  if (Number.isFinite(r) && r > 0 && r < MIN_WAGE) {
    return `$${r.toFixed(2)}/hr is below the $${MIN_WAGE.toFixed(2)} minimum wage — double-check this rate.`
  }
  return null
}
