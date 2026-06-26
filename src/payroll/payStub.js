// Pay stub formatter (Epic 2 / WP-2.1).
//
// A plain-text/markdown summary stub from existing payroll_records data — no new
// dependency. Mirrors payReport's presentation: total_gross_pay is the headline
// pay (late deductions already reflected), shown informationally alongside.
// Official tax-filed W-2/1099 stubs come with Check payroll (blocked-on-human).

export function formatPayStub(record, opts = {}) {
  if (!record) return '🧾 No pay data found for that period yet.'
  const d = (n) => `$${Number(n ?? 0).toFixed(2)}`
  const name = opts.name ?? record.name ?? null
  const hours = Number(record.total_hours ?? 0)
  const gross = Number(record.total_gross_pay ?? 0)
  const lateMin = Number(record.total_late_minutes ?? 0)
  const lateDed = Number(record.total_late_deduction ?? 0)
  const week = record.week_start ?? 'recent period'

  const lines = [`🧾 *Pay Stub — week of ${week}*`]
  if (name) lines.push(`Employee: ${name}`)
  lines.push(`Hours: ${hours.toFixed(1)}`)
  if (lateDed > 0) lines.push(`Late deductions: ${lateMin}min (−${d(lateDed)})`)
  lines.push(`Pay: *${d(gross)}*`)
  lines.push(`\n_Summary stub. Official tax-filed pay stubs (W-2/1099) come with payroll setup._`)
  return lines.join('\n')
}
