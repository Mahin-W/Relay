// Pay-run assembler (Epic 1 / WP-1.4).
//
// Turns a week of computed payroll into the line items payRunEngine consumes:
// wages (from payroll_records.total_gross_pay) + non-cash tips + per-employee
// tax type. Produces a human-readable preview for the owner confirm (DM) and
// the dashboard.
//
// Money note: existing payroll is stored in DOLLARS (NUMERIC); the engine works
// in integer CENTS, so we convert here. Cash tips are out of scope; non-cash
// tips come from an injectable resolver (defaults to 0 until verified non-cash
// tip data / POS auto-import lands in WP-3.4 — we never guess a tip amount).
//
// Pure transform with injectable deps so it unit-tests without a DB.

import { logger } from '../logger.js'
import { getPayrollForWeek } from '../payroll/payDb.js'
import { getTaxType } from '../payroll/payrollSettings.js'

const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100)
export const formatMoney = (cents) => `$${(Number(cents) / 100).toFixed(2)}`

/**
 * @param {string|number} groupId
 * @param {string} weekStart
 * @param {object} [deps] - { getPayroll, getTipCents(staffId), getTaxType, db }
 * @returns {Promise<{items:object[], totalCents:number, preview:string}>}
 */
export async function assemblePayRun(groupId, weekStart, deps = {}) {
  const getPayroll = deps.getPayroll ?? ((g, w) => getPayrollForWeek(g, w, deps.db ?? null))
  const taxTypeOf = deps.getTaxType ?? ((g, s) => getTaxType(g, s, deps.db ?? null))
  // TODO(WP-3.4): replace the default with verified non-cash/POS tip amounts.
  const tipCentsOf = deps.getTipCents ?? (async () => 0)

  let records
  try {
    records = await getPayroll(groupId, weekStart)
  } catch (err) {
    logger.error(`assemblePayRun: getPayroll failed: ${err.message}`)
    return { items: [], totalCents: 0, preview: 'Could not load payroll for this week.' }
  }
  if (!records || records.length === 0) {
    return { items: [], totalCents: 0, preview: 'No payroll records for this week.' }
  }

  const items = []
  for (const r of records) {
    const staffId = r.staff_id ?? r.staffId
    const wageCents = toCents(r.total_gross_pay ?? r.totalGrossPay ?? 0)
    const tipCents = await tipCentsOf(staffId)
    const taxType = await taxTypeOf(groupId, staffId)
    items.push({
      staffId,
      name: r.name ?? r.staff_name ?? null,
      wageCents,
      tipCents,
      deductionCents: 0, // late deductions already reflected in total_gross_pay
      taxType,
      netCents: wageCents + tipCents,
    })
  }
  const totalCents = items.reduce((s, i) => s + i.netCents, 0)
  return { items, totalCents, preview: formatPayRunPreview({ items, totalCents }, weekStart) }
}

/** Owner-facing preview text (used by the DM confirm and dashboard). */
export function formatPayRunPreview(assembly, weekStart = null) {
  const { items, totalCents } = assembly
  if (!items || items.length === 0) return 'No one to pay this week.'
  const lines = items.map(i => {
    const who = i.name ?? `Staff #${i.staffId}`
    const tip = i.tipCents ? ` (+${formatMoney(i.tipCents)} tips)` : ''
    const tag = i.taxType === '1099' ? ' [1099]' : ''
    return `• ${who}${tag}: ${formatMoney(i.netCents)}${tip}`
  })
  const header = weekStart
    ? `Pay ${items.length} staff for week of ${weekStart} — ${formatMoney(totalCents)} total`
    : `Pay ${items.length} staff — ${formatMoney(totalCents)} total`
  return `${header}\n${lines.join('\n')}`
}
