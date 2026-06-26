import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerPayRunFeature, startPayRun, onPayRunConfirm, PAY_RUN_FLOW,
} from '../../payouts/payRunFeature.js'
import { matchIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'
import {
  getFlow, startFlow, handleFlowInput, _resetFlowsForTesting,
} from '../../lib/dmFlow.js'

const assembled = {
  items: [{ staffId: 1, name: 'Maria', wageCents: 50000, tipCents: 8400, deductionCents: 0, taxType: 'w2', netCents: 58400 }],
  totalCents: 58400,
  preview: 'Pay 1 staff — $584.00 total',
}
function makeStore() {
  const state = { sessions: [] }; let id = 1
  return {
    state,
    create: async ({ recipientId, groupId, flowName, context }) => {
      state.sessions.filter(s => s.recipient_id === recipientId && s.status === 'active').forEach(s => { s.status = 'cancelled' })
      const row = { id: id++, recipient_id: recipientId, group_id: groupId, flow_name: flowName, step_index: 0, answers: {}, context, status: 'active' }
      state.sessions.push(row); return row
    },
    getActive: async (rid) => state.sessions.find(s => s.recipient_id === rid && s.status === 'active') ?? null,
    update: async (id2, fields) => { const s = state.sessions.find(x => x.id === id2); if (s) Object.assign(s, fields) },
  }
}
const makeSend = () => { const sent = []; return { sent, send: async (r, m) => sent.push({ r, m }) } }

beforeEach(() => { _resetIntentsForTesting(); _resetCommandsForTesting(); _resetFlowsForTesting() })

describe('registerPayRunFeature', () => {
  it('registers the intent, command, and flow', () => {
    registerPayRunFeature()
    assert.equal(matchIntent('can you pay everyone this week')?.name, 'pay_run_request')
    assert.equal(matchIntent('run payroll')?.name, 'pay_run_request')
    const cmd = getCommand('paypeople')
    assert.ok(cmd)
    assert.equal(cmd.role, 'owner')
    assert.ok(getCommand('runpayroll'), 'alias resolves')
    assert.ok(getFlow(PAY_RUN_FLOW))
  })
})

describe('startPayRun', () => {
  it('assembles, freezes items into context, and opens the confirm flow', async () => {
    let started = null
    const r = await startPayRun(
      { groupId: 'g1', weekStart: '2026-06-22', initiatedBy: 7, recipientId: 7 },
      { assemble: async () => assembled, startFlow: async (args) => { started = args } },
    )
    assert.equal(r.ok, true)
    assert.equal(started.flowName, PAY_RUN_FLOW)
    assert.deepEqual(started.context.items, assembled.items)
    assert.equal(started.context.totalCents, 58400)
  })

  it('does not open a flow when there is nothing to pay', async () => {
    let replied = null
    const r = await startPayRun(
      { groupId: 'g1', weekStart: '2026-06-22', initiatedBy: 7 },
      { assemble: async () => ({ items: [], totalCents: 0, preview: 'No payroll records for this week.' }), reply: async (t) => { replied = t } },
    )
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'nothing_to_pay')
    assert.match(replied, /No payroll records/)
  })
})

describe('onPayRunConfirm', () => {
  it('runs the frozen pay run on yes', async () => {
    let ranWith = null
    const out = await onPayRunConfirm(
      { ok: true },
      { groupId: 'g1', weekStart: '2026-06-22', items: assembled.items, initiatedBy: '7' },
      {},
      { runPayRun: async (args) => { ranWith = args; return { ok: true, status: 'completed', paid: 1 } } },
    )
    assert.equal(out.ran, true)
    assert.deepEqual(ranWith.items, assembled.items)
    assert.equal(ranWith.groupId, 'g1')
  })

  it('cancels on no without running', async () => {
    let called = false
    const out = await onPayRunConfirm({ ok: false }, { initiatedBy: '7' }, {}, { runPayRun: async () => { called = true } })
    assert.equal(out.ran, false)
    assert.equal(out.cancelled, true)
    assert.equal(called, false)
  })
})

describe('integration: confirm flow → engine', () => {
  it('a "yes" DM reply runs the frozen pay run via the engine', async () => {
    let ranItems = null
    registerPayRunFeature({ confirmDeps: { runPayRun: async (args) => { ranItems = args.items; return { ok: true, status: 'completed' } } } })

    const store = makeStore()
    const { send } = makeSend()
    await startFlow({
      recipientId: '7', groupId: 'g1', flowName: PAY_RUN_FLOW,
      context: { groupId: 'g1', weekStart: '2026-06-22', initiatedBy: '7', items: assembled.items, totalCents: 58400, preview: assembled.preview },
    }, { store, send })

    const r = await handleFlowInput({ recipientId: '7', text: 'yes' }, { store, send })
    assert.equal(r.status, 'complete')
    assert.deepEqual(ranItems, assembled.items)
  })

  it('a "no" DM reply does not run the pay run', async () => {
    let ran = false
    registerPayRunFeature({ confirmDeps: { runPayRun: async () => { ran = true } } })
    const store = makeStore()
    const { send } = makeSend()
    await startFlow({
      recipientId: '7', groupId: 'g1', flowName: PAY_RUN_FLOW,
      context: { groupId: 'g1', items: assembled.items, preview: assembled.preview },
    }, { store, send })
    await handleFlowInput({ recipientId: '7', text: 'no' }, { store, send })
    assert.equal(ran, false)
  })
})
