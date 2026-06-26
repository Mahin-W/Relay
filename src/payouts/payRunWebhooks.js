// Pay-run webhook reconciliation (Epic 1 / WP-1.5).
//
// The provider confirms payments asynchronously. These handlers reconcile those
// events against pay_run_items (matched by provider_ref):
//   • payment.paid   → confirm the item as paid (idempotent).
//   • payment.failed → mark the item failed and DM the owner (once).
//
// Signature VERIFICATION is the provider's verifyWebhook() — blocked on a real
// Check/Stripe key. These handlers operate on already-verified event objects, so
// the routing + reconciliation logic is fully testable now. Wire the verified
// feed in once the provider key exists.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'
import { notifyGroup } from '../lib/notify.js'

function extractRef(event) {
  return event?.data?.providerRef ?? event?.data?.provider_ref ?? event?.providerRef ?? null
}

export async function handlePaymentPaid(event, deps = {}) {
  const ref = extractRef(event)
  if (!ref) return { handled: false, reason: 'no_ref' }
  const store = deps.store ?? defaultStore
  const item = await store.confirmItemPaid(ref)
  if (item) {
    await logEvent({ groupId: item.group_id, actorType: 'provider', action: 'payout.payment.paid', target: ref }, deps.auditDb ?? null)
  }
  return { handled: true, itemFound: !!item }
}

export async function handlePaymentFailed(event, deps = {}) {
  const ref = extractRef(event)
  if (!ref) return { handled: false, reason: 'no_ref' }
  const store = deps.store ?? defaultStore
  const send = deps.send ?? notifyGroup
  const reason = event?.data?.reason ?? 'payment failed'

  const { item, transitioned } = await store.failItem(ref, reason)
  if (item) {
    await logEvent({ groupId: item.group_id, actorType: 'provider', action: 'payout.payment.failed', target: ref, meta: { staffId: item.staff_id, reason } }, deps.auditDb ?? null)
    if (transitioned) {
      const ownerDm = await store.getRunOwnerDm(item.pay_run_id)
      if (ownerDm) await send(ownerDm, `⚠️ A payroll payment failed and was reversed. Please review the pay run.`, {})
    }
  }
  return { handled: true, itemFound: !!item, transitioned: !!(item && transitioned) }
}

/** Register both handlers on a webhookRouter (from lib/money/webhookRouter.js). */
export function registerPayRunWebhooks(router, deps = {}) {
  router.on('payment.paid', (evt) => handlePaymentPaid(evt, deps))
  router.on('payment.failed', (evt) => handlePaymentFailed(evt, deps))
  return router
}

// ── default Supabase-backed store ─────────────────────────────────────────────
const defaultStore = {
  async confirmItemPaid(ref) {
    try {
      const { data, error } = await getDb().from('pay_run_items')
        .update({ status: 'paid' }).eq('provider_ref', ref).select().maybeSingle()
      if (error) { logger.error(`confirmItemPaid failed: ${error.message}`); return null }
      return data ?? null
    } catch (err) { logger.error(`confirmItemPaid error: ${err.message}`); return null }
  },
  async failItem(ref, reason) {
    try {
      const { data: cur } = await getDb().from('pay_run_items')
        .select('id, group_id, staff_id, pay_run_id, status').eq('provider_ref', ref).maybeSingle()
      if (!cur) return { item: null, transitioned: false }
      if (cur.status === 'failed') return { item: cur, transitioned: false }
      const { error } = await getDb().from('pay_run_items')
        .update({ status: 'failed', error: reason }).eq('id', cur.id)
      if (error) { logger.error(`failItem update failed: ${error.message}`); return { item: cur, transitioned: false } }
      return { item: cur, transitioned: true }
    } catch (err) { logger.error(`failItem error: ${err.message}`); return { item: null, transitioned: false } }
  },
  async getRunOwnerDm(payRunId) {
    try {
      const { data: run } = await getDb().from('pay_runs').select('initiated_by').eq('id', payRunId).maybeSingle()
      if (!run?.initiated_by) return null
      const { data: sess } = await getDb().from('setup_sessions').select('dm_chat_id').eq('manager_id', run.initiated_by).maybeSingle()
      return sess?.dm_chat_id ?? null
    } catch (err) { logger.error(`getRunOwnerDm error: ${err.message}`); return null }
  },
}
