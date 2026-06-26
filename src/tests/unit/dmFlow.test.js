import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  defineFlow, getFlow, _resetFlowsForTesting, parseYesNo, confirmStep,
  applyFlowInput, startFlow, handleFlowInput, cancelFlow,
} from '../../lib/dmFlow.js'

function makeStore() {
  const sessions = []
  let nextId = 1
  return {
    sessions,
    create: async ({ recipientId, groupId, flowName, context }) => {
      sessions.filter(s => s.recipient_id === recipientId && s.status === 'active').forEach(s => { s.status = 'cancelled' })
      const row = { id: nextId++, recipient_id: recipientId, group_id: groupId, flow_name: flowName, step_index: 0, answers: {}, context, status: 'active' }
      sessions.push(row)
      return row
    },
    getActive: async (recipientId) => sessions.find(s => s.recipient_id === recipientId && s.status === 'active') ?? null,
    update: async (id, fields) => { const s = sessions.find(x => x.id === id); if (s) Object.assign(s, fields) },
  }
}
function makeSend() {
  const sent = []
  return { sent, send: async (recipientId, message) => sent.push({ recipientId, message }) }
}

const numStep = { key: 'hours', prompt: 'How many hours?', parse: (t) => { const n = parseFloat(t); return isNaN(n) ? null : n }, errorPrompt: 'Enter a number' }

beforeEach(() => _resetFlowsForTesting())

describe('parseYesNo', () => {
  it('parses affirmatives', () => {
    for (const t of ['yes', 'y', 'Yeah', 'yep', 'sure', 'ok', '✅', '👍', 'confirm']) assert.equal(parseYesNo(t), true, t)
  })
  it('parses negatives', () => {
    for (const t of ['no', 'n', 'nope', 'nah', 'cancel', '❌']) assert.equal(parseYesNo(t), false, t)
  })
  it('returns null for ambiguous', () => {
    for (const t of ['maybe', 'idk', '', 'what']) assert.equal(parseYesNo(t), null, t)
  })
})

describe('applyFlowInput (pure)', () => {
  const flow = { steps: [numStep, { key: 'note', prompt: 'Any note?' }], completeMessage: 'done' }

  it('advances on valid input and emits next prompt', () => {
    const session = { step_index: 0, answers: {}, context: {} }
    const r = applyFlowInput(flow, session, '8')
    assert.equal(r.invalid, false)
    assert.equal(r.status, 'active')
    assert.equal(r.stepIndex, 1)
    assert.deepEqual(r.answers, { hours: 8 })
    assert.equal(r.reply, 'Any note?')
  })

  it('re-prompts on invalid input without advancing', () => {
    const session = { step_index: 0, answers: {}, context: {} }
    const r = applyFlowInput(flow, session, 'abc')
    assert.equal(r.invalid, true)
    assert.equal(r.reply, 'Enter a number')
  })

  it('completes after the last step', () => {
    const session = { step_index: 1, answers: { hours: 8 }, context: {} }
    const r = applyFlowInput(flow, session, 'all good')
    assert.equal(r.status, 'complete')
    assert.deepEqual(r.answers, { hours: 8, note: 'all good' })
    assert.equal(r.reply, 'done')
  })

  it('supports prompt functions using prior answers', () => {
    const f = { steps: [numStep, { key: 'confirm', prompt: ({ answers }) => `Confirm ${answers.hours}h?` }] }
    const r = applyFlowInput(f, { step_index: 0, answers: {}, context: {} }, '6')
    assert.equal(r.reply, 'Confirm 6h?')
  })
})

describe('startFlow + handleFlowInput (wired)', () => {
  it('runs a multi-step flow to completion and calls onComplete', async () => {
    let completed = null
    defineFlow('intake', {
      steps: [numStep, { key: 'note', prompt: 'Any note?' }],
      completeMessage: '✅ saved',
      onComplete: async (answers, ctx) => { completed = { answers, ctx } },
    })
    const store = makeStore()
    const { sent, send } = makeSend()
    const deps = { store, send }

    await startFlow({ recipientId: 's1', groupId: 'g1', flowName: 'intake', context: { src: 'test' } }, deps)
    assert.equal(sent[0].message, 'How many hours?')

    let r = await handleFlowInput({ recipientId: 's1', text: '8' }, deps)
    assert.equal(r.status, 'active')
    assert.equal(sent[1].message, 'Any note?')

    r = await handleFlowInput({ recipientId: 's1', text: 'busy night' }, deps)
    assert.equal(r.status, 'complete')
    assert.deepEqual(completed.answers, { hours: 8, note: 'busy night' })
    assert.equal(completed.ctx.src, 'test')
    assert.equal(store.sessions[0].status, 'complete')
  })

  it('re-prompts and stays active on invalid input', async () => {
    defineFlow('intake', { steps: [numStep] })
    const store = makeStore()
    const { sent, send } = makeSend()
    const deps = { store, send }
    await startFlow({ recipientId: 's1', flowName: 'intake' }, deps)
    const r = await handleFlowInput({ recipientId: 's1', text: 'nope' }, deps)
    assert.equal(r.status, 'active')
    assert.equal(sent[sent.length - 1].message, 'Enter a number')
    assert.equal(store.sessions[0].step_index, 0)
  })

  it('confirmStep yes runs onComplete with true', async () => {
    let result = null
    defineFlow('confirm_pay', {
      steps: [confirmStep('ok', 'Pay team? (yes/no)')],
      onComplete: async (answers) => { result = answers.ok },
    })
    const store = makeStore()
    const { send } = makeSend()
    await startFlow({ recipientId: 's1', flowName: 'confirm_pay' }, { store, send })
    await handleFlowInput({ recipientId: 's1', text: 'yes' }, { store, send })
    assert.equal(result, true)
  })

  it('confirmStep no runs onComplete with false', async () => {
    let result = null
    defineFlow('confirm_pay', {
      steps: [confirmStep('ok', 'Pay team? (yes/no)')],
      onComplete: async (answers) => { result = answers.ok },
    })
    const store = makeStore()
    const { send } = makeSend()
    await startFlow({ recipientId: 's1', flowName: 'confirm_pay' }, { store, send })
    await handleFlowInput({ recipientId: 's1', text: 'no' }, { store, send })
    assert.equal(result, false)
  })

  it('surfaces an onComplete failure and withholds the success message', async () => {
    defineFlow('payx', {
      steps: [confirmStep('ok', 'go? (yes/no)')],
      completeMessage: '✅ done',
      onComplete: async () => { throw new Error('provider down') },
    })
    const store = makeStore()
    const { sent, send } = makeSend()
    await startFlow({ recipientId: 's1', flowName: 'payx' }, { store, send })
    const r = await handleFlowInput({ recipientId: 's1', text: 'yes' }, { store, send })
    assert.equal(r.status, 'error')
    assert.match(r.error, /provider down/)
    assert.ok(!sent.some(m => m.message === '✅ done'), 'success message must NOT be sent')
    assert.ok(sent.some(m => /went wrong/.test(m.message)), 'error message must be sent')
    assert.equal(store.sessions[0].status, 'complete') // marked complete → no double-process
  })

  it('returns handled:false when no active flow', async () => {
    const store = makeStore()
    const { send } = makeSend()
    const r = await handleFlowInput({ recipientId: 's1', text: 'hi' }, { store, send })
    assert.equal(r.handled, false)
  })

  it('cancelFlow cancels an active flow', async () => {
    defineFlow('intake', { steps: [numStep] })
    const store = makeStore()
    const { send } = makeSend()
    await startFlow({ recipientId: 's1', flowName: 'intake' }, { store, send })
    const r = await cancelFlow('s1', { store })
    assert.equal(r.cancelled, true)
    assert.equal(store.sessions[0].status, 'cancelled')
  })

  it('startFlow on a second flow cancels the first active one', async () => {
    defineFlow('a', { steps: [numStep] })
    defineFlow('b', { steps: [numStep] })
    const store = makeStore()
    const { send } = makeSend()
    await startFlow({ recipientId: 's1', flowName: 'a' }, { store, send })
    await startFlow({ recipientId: 's1', flowName: 'b' }, { store, send })
    const active = store.sessions.filter(s => s.status === 'active')
    assert.equal(active.length, 1)
    assert.equal(active[0].flow_name, 'b')
  })
})

describe('defineFlow', () => {
  it('rejects a flow with no steps', () => {
    assert.throws(() => defineFlow('x', { steps: [] }), /steps required/)
  })
  it('stores and retrieves a definition', () => {
    defineFlow('x', { steps: [numStep] })
    assert.ok(getFlow('x'))
    assert.equal(getFlow('missing'), null)
  })
})
