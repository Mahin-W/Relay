import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runPayRun } from '../../payouts/payRunEngine.js'

function makeMemIdem() {
  const map = new Map()
  return {
    getIdempotencyKey: async (k) => map.get(k) ?? null,
    claimIdempotencyKey: async (k) => { if (map.has(k)) return false; map.set(k, { key: k, status: 'pending', result: null }); return true },
    completeIdempotencyKey: async (k, r) => { const x = map.get(k); if (x) { x.status = 'completed'; x.result = r } },
    failIdempotencyKey: async (k) => { const x = map.get(k); if (x && x.status === 'pending') map.delete(k) },
  }
}
function makeStore() {
  const state = { runs: [], items: [] }
  let nextId = 1
  return {
    state,
    createRun: async (run) => { const r = { id: nextId++, ...run }; state.runs.push(r); return r },
    addItem: async (item) => { state.items.push(item) },
    finishRun: async (id, fields) => { const r = state.runs.find(x => x.id === id); if (r) Object.assign(r, fields) },
  }
}
function makeProvider(opts = {}) {
  const calls = []
  return {
    calls,
    payEmployee: async (p) => {
      calls.push(p)
      if (opts.failFor && opts.failFor.includes(p.staffId)) throw new Error(`provider declined ${p.staffId}`)
      return { paymentRef: `pr_${p.staffId}`, status: 'paid' }
    },
  }
}
const auditDb = { insertAuditEvent: async () => ({}) }

describe('runPayRun', () => {
  it('pays every employee and totals net pay (wages + tips − deductions)', async () => {
    const provider = makeProvider()
    const store = makeStore()
    const r = await runPayRun({
      groupId: 'g1', weekStart: '2026-06-22', initiatedBy: 7,
      items: [
        { staffId: 1, wageCents: 50000, tipCents: 8400, deductionCents: 0, taxType: 'w2' },
        { staffId: 2, wageCents: 40000, tipCents: 0, deductionCents: 1000, taxType: '1099' },
      ],
    }, { provider, store, idemStore: makeMemIdem(), auditDb })

    assert.equal(r.ok, true)
    assert.equal(r.status, 'completed')
    assert.equal(r.paid, 2)
    assert.equal(r.failed, 0)
    assert.equal(r.totalCents, 50000 + 8400 + (40000 - 1000)) // 97400
    assert.equal(provider.calls.length, 2)
    assert.equal(store.state.items.length, 2)
    assert.ok(store.state.items.every(i => i.status === 'paid'))
    assert.equal(store.state.runs[0].status, 'completed')
  })

  it('isolates a failure: one employee fails, the rest still get paid', async () => {
    const provider = makeProvider({ failFor: [2] })
    const store = makeStore()
    const r = await runPayRun({
      groupId: 'g1', weekStart: '2026-06-22',
      items: [
        { staffId: 1, wageCents: 50000 },
        { staffId: 2, wageCents: 40000 },
        { staffId: 3, wageCents: 30000 },
      ],
    }, { provider, store, idemStore: makeMemIdem(), auditDb })

    assert.equal(r.status, 'completed_with_errors')
    assert.equal(r.paid, 2)
    assert.equal(r.failed, 1)
    assert.equal(r.totalCents, 80000) // only staff 1 + 3
    const failedItem = store.state.items.find(i => i.staff_id === 2)
    assert.equal(failedItem.status, 'failed')
    assert.match(failedItem.error, /declined 2/)
  })

  it('marks the whole run failed when every payment fails', async () => {
    const provider = makeProvider({ failFor: [1, 2] })
    const store = makeStore()
    const r = await runPayRun({
      groupId: 'g1', items: [{ staffId: 1, wageCents: 100 }, { staffId: 2, wageCents: 200 }],
    }, { provider, store, idemStore: makeMemIdem(), auditDb })
    assert.equal(r.status, 'failed')
    assert.equal(r.paid, 0)
    assert.equal(r.totalCents, 0)
  })

  it('is idempotent per employee across retried runs (no double pay)', async () => {
    const provider = makeProvider()
    const idem = makeMemIdem() // shared across both runs
    const items = [{ staffId: 1, wageCents: 50000 }, { staffId: 2, wageCents: 40000 }]
    await runPayRun({ groupId: 'g1', weekStart: '2026-06-22', items }, { provider, store: makeStore(), idemStore: idem, auditDb })
    await runPayRun({ groupId: 'g1', weekStart: '2026-06-22', items }, { provider, store: makeStore(), idemStore: idem, auditDb })
    // provider.payEmployee called once per staff total, not twice
    assert.equal(provider.calls.length, 2)
  })

  it('rejects invalid input', async () => {
    const r = await runPayRun({ groupId: '', items: [] }, { provider: makeProvider(), store: makeStore(), idemStore: makeMemIdem(), auditDb })
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid_input')
  })

  it('writes run start + completion audit events', async () => {
    const audits = []
    const r = await runPayRun({
      groupId: 'g1', items: [{ staffId: 1, wageCents: 100 }],
    }, { provider: makeProvider(), store: makeStore(), idemStore: makeMemIdem(), auditDb: { insertAuditEvent: async (row) => audits.push(row) } })
    assert.equal(r.ok, true)
    assert.ok(audits.some(a => a.action === 'payroll.run.start'))
    assert.ok(audits.some(a => a.action === 'payroll.run.complete'))
  })
})
