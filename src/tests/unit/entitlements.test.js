import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { can, requireFeature, getTier, FeatureNotEntitledError } from '../../lib/entitlements.js'

// db mock returning a fixed entitlement row.
function dbWith(row) {
  return { getEntitlementRow: async () => row }
}

describe('can — base features', () => {
  it('always allows a non-paid (base) feature, even with no row', async () => {
    assert.equal(await can('g1', 'scheduling', dbWith(null)), true)
    assert.equal(await can('g1', 'coverage', dbWith(null)), true)
  })

  it('returns false for an empty feature', async () => {
    assert.equal(await can('g1', '', dbWith(null)), false)
  })
})

describe('can — paid features by tier', () => {
  it('denies paid features on free (default when no row)', async () => {
    assert.equal(await can('g1', 'payroll', dbWith(null)), false)
    assert.equal(await can('g1', 'payouts', dbWith(null)), false)
  })

  it('grants starter-tier features but not pro-only ones', async () => {
    const db = dbWith({ tier: 'starter', overrides: {} })
    assert.equal(await can('g1', 'documents', db), true)
    assert.equal(await can('g1', 'pto', db), true)
    assert.equal(await can('g1', 'payroll', db), false) // pro-only
    assert.equal(await can('g1', 'payouts', db), false)
  })

  it('grants all paid features on pro', async () => {
    const db = dbWith({ tier: 'pro', overrides: {} })
    assert.equal(await can('g1', 'payroll', db), true)
    assert.equal(await can('g1', 'payouts', db), true)
    assert.equal(await can('g1', 'pos', db), true)
  })
})

describe('can — overrides', () => {
  it('override can enable a paid feature on free', async () => {
    const db = dbWith({ tier: 'free', overrides: { payouts: true } })
    assert.equal(await can('g1', 'payouts', db), true)
  })

  it('override can disable a feature the tier would otherwise grant', async () => {
    const db = dbWith({ tier: 'pro', overrides: { pos: false } })
    assert.equal(await can('g1', 'pos', db), false)
    assert.equal(await can('g1', 'payroll', db), true) // others unaffected
  })
})

describe('requireFeature', () => {
  it('throws FeatureNotEntitledError when denied', async () => {
    await assert.rejects(
      requireFeature('g1', 'payroll', dbWith({ tier: 'free', overrides: {} })),
      (err) => err instanceof FeatureNotEntitledError && err.feature === 'payroll'
    )
  })

  it('resolves when allowed', async () => {
    await assert.doesNotReject(
      requireFeature('g1', 'payroll', dbWith({ tier: 'pro', overrides: {} }))
    )
  })
})

describe('getTier', () => {
  it('defaults to free when no row', async () => {
    assert.equal(await getTier('g1', dbWith(null)), 'free')
  })

  it('returns the stored tier', async () => {
    assert.equal(await getTier('g1', dbWith({ tier: 'pro' })), 'pro')
  })
})
