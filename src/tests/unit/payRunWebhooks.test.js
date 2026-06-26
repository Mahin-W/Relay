import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handlePaymentPaid, handlePaymentFailed, registerPayRunWebhooks } from '../../payouts/payRunWebhooks.js'
import { createWebhookRouter } from '../../lib/money/webhookRouter.js'

const auditDb = { insertAuditEvent: async () => ({}) }

function makeStore(opts = {}) {
  const calls = { confirmed: [], failed: [] }
  return {
    calls,
    confirmItemPaid: async (ref) => { calls.confirmed.push(ref); return opts.item ?? { id: 1, group_id: 'g1', staff_id: 5, pay_run_id: 9 } },
    failItem: async (ref, reason) => { calls.failed.push({ ref, reason }); return opts.failResult ?? { item: { id: 1, group_id: 'g1', staff_id: 5, pay_run_id: 9 }, transitioned: true } },
    getRunOwnerDm: async () => opts.ownerDm ?? '12345',
  }
}

describe('handlePaymentPaid', () => {
  it('confirms the matching item and audits', async () => {
    const store = makeStore()
    const r = await handlePaymentPaid({ type: 'payment.paid', data: { providerRef: 'pr_5' } }, { store, auditDb })
    assert.equal(r.handled, true)
    assert.equal(r.itemFound, true)
    assert.deepEqual(store.calls.confirmed, ['pr_5'])
  })
  it('returns handled:false when no provider ref', async () => {
    const r = await handlePaymentPaid({ type: 'payment.paid', data: {} }, { store: makeStore(), auditDb })
    assert.equal(r.handled, false)
    assert.equal(r.reason, 'no_ref')
  })
})

describe('handlePaymentFailed', () => {
  it('fails the item and DMs the owner on a real transition', async () => {
    const sent = []
    const store = makeStore()
    const r = await handlePaymentFailed(
      { type: 'payment.failed', data: { providerRef: 'pr_5', reason: 'insufficient funds' } },
      { store, auditDb, send: async (to, msg) => sent.push({ to, msg }) },
    )
    assert.equal(r.transitioned, true)
    assert.equal(store.calls.failed[0].reason, 'insufficient funds')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].to, '12345')
    assert.match(sent[0].msg, /failed/)
  })

  it('does NOT re-notify when the item was already failed (idempotent)', async () => {
    const sent = []
    const store = makeStore({ failResult: { item: { id: 1, group_id: 'g1', pay_run_id: 9 }, transitioned: false } })
    const r = await handlePaymentFailed(
      { type: 'payment.failed', data: { providerRef: 'pr_5' } },
      { store, auditDb, send: async (...a) => sent.push(a) },
    )
    assert.equal(r.transitioned, false)
    assert.equal(sent.length, 0)
  })

  it('handles an unknown provider ref (no item) without notifying', async () => {
    const sent = []
    const store = makeStore({ failResult: { item: null, transitioned: false } })
    const r = await handlePaymentFailed(
      { type: 'payment.failed', data: { providerRef: 'pr_x' } },
      { store, auditDb, send: async (...a) => sent.push(a) },
    )
    assert.equal(r.itemFound, false)
    assert.equal(sent.length, 0)
  })
})

describe('registerPayRunWebhooks + router', () => {
  it('routes verified events to the handlers', async () => {
    const router = createWebhookRouter()
    const store = makeStore()
    const sent = []
    registerPayRunWebhooks(router, { store, auditDb, send: async (to, msg) => sent.push({ to, msg }) })
    assert.deepEqual(router.listTypes().sort(), ['payment.failed', 'payment.paid'])

    const paid = await router.dispatch({ type: 'payment.paid', data: { providerRef: 'pr_5' } })
    assert.equal(paid.handled, true)

    await router.dispatch({ type: 'payment.failed', data: { providerRef: 'pr_5' } })
    assert.equal(sent.length, 1)
  })

  it('ingest verifies (mock) then reconciles', async () => {
    const router = createWebhookRouter()
    registerPayRunWebhooks(router, { store: makeStore(), auditDb })
    const verify = (body) => JSON.parse(body)
    const r = await router.ingest(JSON.stringify({ type: 'payment.paid', data: { providerRef: 'pr_5' } }), 'sig', verify)
    assert.equal(r.verified, true)
    assert.equal(r.handled, true)
  })
})
