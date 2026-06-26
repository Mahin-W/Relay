// Pay-run engine (Epic 1 / WP-1.3).
//
// Owner-initiated: given a list of per-employee line items, pay each one through
// the configured provider. Properties this guarantees:
//   • Idempotent per employee — a retried run replays the cached payment
//     (withIdempotency keyed by group+week+staff) instead of double-paying.
//   • Isolated failures — one employee's payment failing does NOT block the
//     rest; the run finishes 'completed_with_errors' and the failed item is
//     recorded for retry/inspection.
//   • Audited — run start + completion are written to the audit log.
//
// Net pay = wages + non-cash tips − deductions (cash tips are out of scope).
// deps are injectable for tests: { provider, store, idemStore, auditDb }.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { withIdempotency } from '../lib/idempotency.js'
import { logEvent } from '../lib/audit.js'
import { getPaymentProvider } from '../lib/money/providers.js'

/**
 * @param {object} p
 * @param {string|number} p.groupId
 * @param {string|null} [p.weekStart]
 * @param {Array<{staffId:(string|number), wageCents:number, tipCents?:number, deductionCents?:number, taxType?:('w2'|'1099')}>} p.items
 * @param {string|number|null} [p.initiatedBy]
 * @param {object} [deps] - { provider, store, idemStore, auditDb }
 */
export async function runPayRun({ groupId, weekStart = null, items = [], initiatedBy = null }, deps = {}) {
  if (!groupId || !Array.isArray(items) || items.length === 0) {
    logger.error('runPayRun: groupId and a non-empty items array are required')
    return { ok: false, error: 'invalid_input' }
  }
  const provider = deps.provider ?? getPaymentProvider()
  const store = deps.store ?? defaultRunStore
  const idemStore = deps.idemStore ?? null
  const auditDb = deps.auditDb ?? null

  await logEvent({ groupId, actorId: initiatedBy, actorType: 'owner', action: 'payroll.run.start', meta: { weekStart, count: items.length } }, auditDb)

  const run = await store.createRun({
    group_id: String(groupId), week_start: weekStart, status: 'processing',
    initiated_by: initiatedBy != null ? String(initiatedBy) : null,
  })
  if (!run) { logger.error('runPayRun: failed to create pay run'); return { ok: false, error: 'create_failed' } }

  const results = []
  let paidTotal = 0, paid = 0, failed = 0

  for (const it of items) {
    const wage = it.wageCents ?? 0
    const tip = it.tipCents ?? 0
    const ded = it.deductionCents ?? 0
    const net = wage + tip - ded
    const taxType = it.taxType ?? 'w2'
    const idemKey = `payrun:${groupId}:${weekStart ?? 'adhoc'}:${it.staffId}`

    try {
      const payRes = await withIdempotency(
        idemKey,
        () => provider.payEmployee({ groupId, staffId: it.staffId, grossCents: wage, tipCents: tip, taxType, idemKey }),
        idemStore,
      )
      await store.addItem({
        pay_run_id: run.id, group_id: String(groupId), staff_id: it.staffId,
        wage_cents: wage, tip_cents: tip, deduction_cents: ded, net_cents: net,
        tax_type: taxType, status: 'paid', provider_ref: payRes?.paymentRef ?? null, idem_key: idemKey,
      })
      paidTotal += net; paid++
      results.push({ staffId: it.staffId, status: 'paid', netCents: net, providerRef: payRes?.paymentRef ?? null })
    } catch (err) {
      logger.error(`runPayRun: payEmployee failed for staff ${it.staffId}: ${err.message}`)
      await store.addItem({
        pay_run_id: run.id, group_id: String(groupId), staff_id: it.staffId,
        wage_cents: wage, tip_cents: tip, deduction_cents: ded, net_cents: net,
        tax_type: taxType, status: 'failed', idem_key: idemKey, error: err.message,
      })
      failed++
      results.push({ staffId: it.staffId, status: 'failed', error: err.message })
    }
  }

  const status = failed === 0 ? 'completed' : (paid > 0 ? 'completed_with_errors' : 'failed')
  await store.finishRun(run.id, { status, total_cents: paidTotal, completed_at: new Date().toISOString() })
  await logEvent({ groupId, actorId: initiatedBy, actorType: 'owner', action: 'payroll.run.complete', target: run.id, meta: { status, paid, failed, totalCents: paidTotal } }, auditDb)

  return { ok: true, payRunId: run.id, status, totalCents: paidTotal, paid, failed, items: results }
}

// ── default Supabase-backed run store ─────────────────────────────────────────
const defaultRunStore = {
  async createRun(run) {
    try {
      const { data, error } = await getDb().from('pay_runs').insert([run]).select().single()
      if (error) { logger.error(`createRun failed: ${error.message}`); return null }
      return data
    } catch (err) { logger.error(`createRun error: ${err.message}`); return null }
  },
  async addItem(item) {
    try {
      const { error } = await getDb().from('pay_run_items').insert([item])
      if (error) logger.error(`addItem failed: ${error.message}`)
    } catch (err) { logger.error(`addItem error: ${err.message}`) }
  },
  async finishRun(id, fields) {
    try {
      const { error } = await getDb().from('pay_runs').update(fields).eq('id', id)
      if (error) logger.error(`finishRun failed: ${error.message}`)
    } catch (err) { logger.error(`finishRun error: ${err.message}`) }
  },
}
