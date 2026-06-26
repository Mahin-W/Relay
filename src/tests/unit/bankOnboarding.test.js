import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startOnboarding, getOnboardingStatus } from '../../payouts/bankOnboarding.js'
import { registerBankOnboardingFeature } from '../../payouts/bankOnboardingFeature.js'
import { matchIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'

function makeDb() {
  const state = { rows: [], audits: [] }
  return {
    state,
    upsertBankAccount: async (row) => { state.rows.push(row); return row },
    insertAuditEvent: async (row) => { state.audits.push(row); return row },
    getBankAccount: async () => state.rows[state.rows.length - 1] ?? null,
  }
}
const mockProvider = { name: 'mock', ensurePayee: async () => ({ payeeRef: 'py_1' }), getOnboardingLink: async () => 'https://onboard.example/abc' }
function errProvider(code) {
  return { name: 'check', ensurePayee: async () => { const e = new Error('nope'); e.code = code; throw e }, getOnboardingLink: async () => 'x' }
}

describe('startOnboarding', () => {
  it('returns the hosted link and records pending status + audit (mock provider)', async () => {
    const db = makeDb()
    const res = await startOnboarding({ groupId: 'g1', staffId: 5 }, { provider: mockProvider, db })
    assert.equal(res.ok, true)
    assert.equal(res.link, 'https://onboard.example/abc')
    assert.equal(db.state.rows[0].kyc_status, 'pending')
    assert.equal(db.state.rows[0].provider_ref, 'py_1')
    assert.equal(db.state.rows[0].provider, 'mock')
    assert.ok(db.state.audits.some(a => a.action === 'payout.onboarding.start'))
  })

  it('returns not_configured when the provider is not implemented yet', async () => {
    const db = makeDb()
    const res = await startOnboarding({ groupId: 'g1', staffId: 5 }, { provider: errProvider('PROVIDER_NOT_IMPLEMENTED'), db })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'not_configured')
    assert.equal(db.state.rows.length, 0) // nothing recorded
  })

  it('returns not_configured when no provider is configured', async () => {
    const res = await startOnboarding({ groupId: 'g1', staffId: 5 }, { provider: errProvider('PROVIDER_NOT_CONFIGURED'), db: makeDb() })
    assert.equal(res.reason, 'not_configured')
  })

  it('surfaces an unexpected provider error', async () => {
    const res = await startOnboarding({ groupId: 'g1', staffId: 5 }, { provider: errProvider('SOMETHING_ELSE'), db: makeDb() })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'error')
  })
})

describe('getOnboardingStatus', () => {
  it("returns 'none' when there's no record", async () => {
    assert.equal(await getOnboardingStatus('g1', 5, { getBankAccount: async () => null }), 'none')
  })
  it('returns the stored kyc_status', async () => {
    assert.equal(await getOnboardingStatus('g1', 5, { getBankAccount: async () => ({ kyc_status: 'verified' }) }), 'verified')
  })
})

describe('registerBankOnboardingFeature', () => {
  beforeEach(() => { _resetIntentsForTesting(); _resetCommandsForTesting() })

  it('registers /setuppay (role any) and the intent', () => {
    registerBankOnboardingFeature()
    const cmd = getCommand('setuppay')
    assert.ok(cmd)
    assert.equal(cmd.role, 'any')
    assert.equal(matchIntent('how do i set up my direct deposit')?.name, 'direct_deposit_setup')
  })

  it('replies with the link on success', async () => {
    let replied = null
    registerBankOnboardingFeature({ startOnboarding: async () => ({ ok: true, link: 'https://x' }) })
    await getCommand('setuppay').handler({ groupId: 'g1', userId: 5, reply: async (t) => { replied = t } })
    assert.match(replied, /https:\/\/x/)
  })

  it('replies gracefully when payouts are not configured', async () => {
    let replied = null
    registerBankOnboardingFeature({ startOnboarding: async () => ({ ok: false, reason: 'not_configured' }) })
    await getCommand('setuppay').handler({ groupId: 'g1', userId: 5, reply: async (t) => { replied = t } })
    assert.match(replied, /isn't enabled/)
  })
})
