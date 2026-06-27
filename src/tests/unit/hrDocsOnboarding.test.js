import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { addDocument, listDocuments, missingDocuments } from '../../hr/documents.js'
import {
  buildChecklist, formatChecklist, onOnboardingComplete, registerOnboardingFeature, ONBOARDING_FLOW,
} from '../../hr/onboardingChecklist.js'
import { getFlow, startFlow, handleFlowInput, _resetFlowsForTesting } from '../../lib/dmFlow.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'

// ── documents ─────────────────────────────────────────────────────────────────
describe('documents', () => {
  it('addDocument stores metadata + audits', async () => {
    const state = { rows: [], audits: [] }
    const db = {
      insertDocument: async (row) => { state.rows.push(row); return { id: 1, ...row } },
      insertAuditEvent: async (row) => { state.audits.push(row) },
    }
    const saved = await addDocument('g1', 5, { docType: 'W-4', signedAt: '2026-06-26T00:00:00Z' }, 5, db)
    assert.equal(saved.doc_type, 'W-4')
    assert.equal(saved.signed_at, '2026-06-26T00:00:00Z')
    assert.ok(state.audits.some(a => a.action === 'document.add'))
  })

  it('listDocuments returns rows via mock', async () => {
    const db = { listDocuments: async () => [{ doc_type: 'I-9' }] }
    const docs = await listDocuments('g1', 5, db)
    assert.equal(docs[0].doc_type, 'I-9')
  })

  it('missingDocuments flags absent and unsigned required docs', () => {
    const docs = [
      { doc_type: 'W-4', signed_at: '2026-06-26T00:00:00Z' },
      { doc_type: 'I-9', signed_at: null },
    ]
    const missing = missingDocuments(docs, ['W-4', 'I-9', 'Direct Deposit'])
    assert.deepEqual(missing.sort(), ['Direct Deposit', 'I-9']) // W-4 signed; I-9 unsigned; DD absent
  })
})

// ── onboarding checklist ──────────────────────────────────────────────────────
describe('buildChecklist / formatChecklist', () => {
  it('all steps undone by default', () => {
    const cl = buildChecklist()
    assert.equal(cl.length, 3)
    assert.ok(cl.every(c => c.done === false))
  })
  it('marks steps done from flags', () => {
    const cl = buildChecklist({ detailsConfirmed: true, hasBankAccount: true, hasCerts: true })
    assert.ok(cl.every(c => c.done))
    assert.match(formatChecklist(cl), /All done/)
  })
  it('shows remaining steps with empty boxes', () => {
    const out = formatChecklist(buildChecklist({ detailsConfirmed: true }))
    assert.match(out, /✅ Confirm your details/)
    assert.match(out, /⬜ Set up direct deposit/)
    assert.doesNotMatch(out, /All done/)
  })
})

describe('onOnboardingComplete', () => {
  it('sends the checklist + nudges on yes', async () => {
    const sent = []
    const out = await onOnboardingComplete({ confirmed: true }, { recipientId: 5 }, {}, { send: async (to, msg) => sent.push({ to, msg }) })
    assert.equal(out.confirmed, true)
    assert.match(sent[0].msg, /\/setuppay/)
    assert.match(sent[0].msg, /\/certs/)
  })
  it('acknowledges on no', async () => {
    const sent = []
    const out = await onOnboardingComplete({ confirmed: false }, { recipientId: 5 }, {}, { send: async (to, msg) => sent.push({ to, msg }) })
    assert.equal(out.confirmed, false)
    assert.match(sent[0].msg, /ping your manager/)
  })
})

describe('registerOnboardingFeature (integration)', () => {
  beforeEach(() => { _resetFlowsForTesting(); _resetCommandsForTesting() })

  function makeStore() {
    const state = { sessions: [] }; let id = 1
    return {
      state,
      create: async ({ recipientId, groupId, flowName, context }) => {
        const row = { id: id++, recipient_id: recipientId, group_id: groupId, flow_name: flowName, step_index: 0, answers: {}, context, status: 'active' }
        state.sessions.push(row); return row
      },
      getActive: async (rid) => state.sessions.find(s => s.recipient_id === rid && s.status === 'active') ?? null,
      update: async (id2, fields) => { const s = state.sessions.find(x => x.id === id2); if (s) Object.assign(s, fields) },
    }
  }

  it('registers /onboarding + flow, and a yes reply sends the nudges', async () => {
    const sent = []
    registerOnboardingFeature({ confirmDeps: { send: async (to, msg) => sent.push({ to, msg }) } })
    assert.ok(getCommand('onboarding'))
    assert.ok(getFlow(ONBOARDING_FLOW))

    const store = makeStore()
    await startFlow({
      recipientId: '5', groupId: 'g1', flowName: ONBOARDING_FLOW,
      context: { recipientId: '5', staffId: '5', name: 'Sam', role: 'server' },
    }, { store, send: async () => {} })
    const r = await handleFlowInput({ recipientId: '5', text: 'yes' }, { store, send: async () => {} })
    assert.equal(r.status, 'complete')
    assert.ok(sent.some(m => /setuppay/.test(m.msg)))
  })
})
