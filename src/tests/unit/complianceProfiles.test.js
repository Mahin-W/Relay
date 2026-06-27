import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getProfile, setProfile, getRuleset, resolveRuleset,
  FEDERAL_RULESET, STATE_RULESETS, FAIR_WORKWEEK_CITIES,
  isFeatureEnabled, normalizeFeatures, COMPLIANCE_FEATURES,
} from '../../compliance/complianceProfiles.js'

// Mock db implements compliance-profile methods AND insertAuditEvent so
// logEvent (lib/audit.js) stays mocked.
function makeDb(seedRow = null) {
  const state = { row: seedRow, audits: [] }
  return {
    state,
    getComplianceProfile: async () => state.row,
    upsertComplianceProfile: async (row) => { state.row = { id: 1, ...row }; return state.row },
    insertAuditEvent: async (row) => { state.audits.push(row); return { id: state.audits.length, ...row } },
  }
}

describe('resolveRuleset', () => {
  it('returns the federal baseline for an unknown/empty state', () => {
    const rs = resolveRuleset(null)
    assert.equal(rs.meal.afterHours, null)
    assert.equal(rs.rest.perHours, null)
    assert.equal(rs.fairWorkweek, false)
  })

  it('layers CA meal/rest rules over federal', () => {
    const rs = resolveRuleset('ca')
    assert.equal(rs.meal.afterHours, 5)
    assert.equal(rs.rest.perHours, 4)
    assert.equal(rs.rest.paid, true)
  })

  it('applies a Fair-Workweek city overlay (and flips fairWorkweek on)', () => {
    const rs = resolveRuleset('CA', 'San Francisco')
    assert.equal(rs.fairWorkweek, true)
    assert.equal(rs.advanceNoticeDays, 14)
    assert.equal(rs.meal.afterHours, 5) // CA state rule preserved
  })

  it('does not mutate the frozen FEDERAL_RULESET when merging', () => {
    resolveRuleset('CA')
    assert.equal(FEDERAL_RULESET.meal.afterHours, null)
    assert.equal(Object.isFrozen(FEDERAL_RULESET), true)
  })

  it('seeds the required Fair-Workweek cities', () => {
    for (const c of ['new york', 'chicago', 'philadelphia', 'san francisco', 'los angeles', 'seattle']) {
      assert.ok(FAIR_WORKWEEK_CITIES[c], `missing FW city ${c}`)
    }
    assert.ok(STATE_RULESETS.OR.fairWorkweek, 'Oregon should be a Fair-Workweek state')
  })
})

describe('feature toggles', () => {
  it('defaults every guardrail to enabled when unset', () => {
    for (const f of COMPLIANCE_FEATURES) assert.equal(isFeatureEnabled({}, f), true)
    assert.equal(isFeatureEnabled(undefined, 'breaks'), true)
  })
  it('respects an explicit false', () => {
    const rs = { enabled: { minorLabor: false } }
    assert.equal(isFeatureEnabled(rs, 'minorLabor'), false)
    assert.equal(isFeatureEnabled(rs, 'breaks'), true) // unset ⇒ on
  })
  it('normalizeFeatures fills all known keys with booleans', () => {
    const n = normalizeFeatures({ breaks: false })
    assert.deepEqual(n, { breaks: false, minorLabor: true, fairWorkweek: true })
  })
})

describe('getProfile / getRuleset', () => {
  it('returns null when no profile is stored', async () => {
    assert.equal(await getProfile('g1', makeDb(null)), null)
  })

  it('getRuleset falls back to federal when unset', async () => {
    const rs = await getRuleset('g1', makeDb(null))
    assert.equal(rs.meal.afterHours, null)
  })

  it('getRuleset returns the stored ruleset when present', async () => {
    const db = makeDb({ group_id: 'g1', state: 'CA', ruleset: { meal: { afterHours: 5 } } })
    const rs = await getRuleset('g1', db)
    assert.equal(rs.meal.afterHours, 5)
  })

  it('getRuleset resolves from state when ruleset is empty', async () => {
    const db = makeDb({ group_id: 'g1', state: 'CA', city: null, ruleset: {} })
    const rs = await getRuleset('g1', db)
    assert.equal(rs.meal.afterHours, 5)
  })
})

describe('setProfile', () => {
  it('saves a resolved ruleset and audits the change', async () => {
    const db = makeDb(null)
    const saved = await setProfile('g1', { state: 'ca', city: 'San Francisco' }, 999, db)
    assert.equal(saved.state, 'CA')
    assert.equal(saved.city, 'San Francisco')
    assert.equal(saved.ruleset.fairWorkweek, true)
    assert.equal(saved.updated_by, '999')
    assert.equal(db.state.audits.length, 1)
    assert.equal(db.state.audits[0].action, 'compliance.location.change')
    assert.deepEqual(db.state.audits[0].meta.to, { state: 'CA', city: 'San Francisco' })
  })

  it('accepts an explicit ruleset override', async () => {
    const db = makeDb(null)
    const saved = await setProfile('g1', { state: 'TX', ruleset: { meal: { afterHours: 9 } } }, 1, db)
    assert.equal(saved.ruleset.meal.afterHours, 9)
  })

  it('does not audit a no-op (same state & city)', async () => {
    const db = makeDb({ group_id: 'g1', state: 'CA', city: null })
    await setProfile('g1', { state: 'CA' }, 1, db)
    assert.equal(db.state.audits.length, 0)
  })

  it('returns null without a groupId', async () => {
    const db = makeDb(null)
    assert.equal(await setProfile(null, { state: 'CA' }, 1, db), null)
    assert.equal(db.state.audits.length, 0)
  })
})
