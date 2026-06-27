import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { computeAccrual, clampBalance, accrue, deduct, getBalance, adjustBalance } from '../../hr/ptoAccrual.js'
import { registerPtoFeature } from '../../hr/ptoFeature.js'
import { matchIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'

function makeDb(policy = { accrual_hours_per_period: 4, max_balance_hours: 80 }, balance = 0) {
  const state = { policy, balance, ledger: [], audits: [] }
  return {
    state,
    getPtoPolicy: async () => state.policy,
    getPtoBalance: async () => ({ balance_hours: state.balance }),
    upsertPtoBalance: async (row) => { state.balance = row.balance_hours },
    insertPtoLedger: async (row) => { state.ledger.push(row) },
    insertAuditEvent: async (row) => { state.audits.push(row) },
  }
}

describe('computeAccrual (pure)', () => {
  it('multiplies rate by periods', () => {
    assert.equal(computeAccrual({ accrual_hours_per_period: 4 }, 2), 8)
    assert.equal(computeAccrual({ accrual_hours_per_period: 1.5 }, 3), 4.5)
  })
  it('returns 0 for no policy/periods', () => {
    assert.equal(computeAccrual(null, 5), 0)
    assert.equal(computeAccrual({ accrual_hours_per_period: 4 }, 0), 0)
  })
})

describe('clampBalance (pure)', () => {
  it('floors at 0', () => assert.equal(clampBalance(2, -5), 0))
  it('caps at max', () => assert.equal(clampBalance(78, 10, 80), 80))
  it('passes through within range', () => assert.equal(clampBalance(10, 4, 80), 14))
})

describe('accrue', () => {
  it('adds the period accrual to the balance + writes ledger + audit', async () => {
    const db = makeDb({ accrual_hours_per_period: 4, max_balance_hours: 80 }, 10)
    const r = await accrue('g1', 5, 1, db)
    assert.equal(r.balance, 14)
    assert.equal(db.state.ledger[0].delta_hours, 4)
    assert.equal(db.state.ledger[0].balance_after, 14)
    assert.ok(db.state.audits.some(a => a.action === 'pto.adjust'))
  })
  it('respects the max balance cap', async () => {
    const db = makeDb({ accrual_hours_per_period: 4, max_balance_hours: 80 }, 78)
    const r = await accrue('g1', 5, 1, db)
    assert.equal(r.balance, 80)
    assert.equal(r.applied, 2) // only 2 of the 4 fit under the cap
  })
})

describe('deduct', () => {
  it('subtracts hours from the balance', async () => {
    const db = makeDb({ accrual_hours_per_period: 4 }, 20)
    const r = await deduct('g1', 5, 8, 99, db)
    assert.equal(r.balance, 12)
    assert.equal(r.shortfall, 0)
  })
  it('floors at 0 and reports shortfall', async () => {
    const db = makeDb({ accrual_hours_per_period: 4 }, 5)
    const r = await deduct('g1', 5, 8, 99, db)
    assert.equal(r.balance, 0)
    assert.equal(r.shortfall, 3) // wanted 8, only had 5
  })
})

describe('getBalance', () => {
  it('returns 0 when no balance row', async () => {
    assert.equal(await getBalance('g1', 5, { getPtoBalance: async () => null }), 0)
  })
})

describe('registerPtoFeature', () => {
  beforeEach(() => { _resetIntentsForTesting(); _resetCommandsForTesting() })

  it('registers /pto + intent', () => {
    registerPtoFeature()
    assert.ok(getCommand('pto'))
    assert.equal(getCommand('pto').role, 'any')
    assert.equal(matchIntent('how much pto do i have')?.name, 'pto_balance_query')
  })

  it('replies with the balance', async () => {
    let replied = null
    registerPtoFeature({ getBalance: async () => 23.5 })
    await getCommand('pto').handler({ groupId: 'g1', userId: 5, reply: async (t) => { replied = t } })
    assert.match(replied, /23\.5 hours/)
  })
})
