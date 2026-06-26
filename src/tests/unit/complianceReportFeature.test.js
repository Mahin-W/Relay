import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerComplianceReportFeature } from '../../compliance/complianceReportFeature.js'
import { resolveRuleset } from '../../compliance/complianceProfiles.js'
import { getCommand, dispatchCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'
import { _resetIntentsForTesting, getIntent } from '../../parsers/intentRegistry.js'

const CA = resolveRuleset('CA')
const owner = { isAuthorized: async () => true }

function baseDeps(overrides = {}) {
  return {
    getRuleset: async () => CA,
    getProfile: async () => ({ state: 'CA', city: 'San Francisco' }),
    getStaff: async () => [{ id: 1, name: 'Sam', dob: '2009-01-01' }], // 17 (asOf now ≈ 2026)
    loadSchedule: async () => ({
      week_start: '2026-06-22',
      assignments: [{ staffId: 1, staffName: 'Sam', dayOfWeek: 'Monday', startTime: '16:00', endTime: '23:00', shiftName: 'Close' }],
    }),
    recordViolations: async () => [{ id: 1 }],
    getEvents: async () => [
      { event_type: 'minor_violation', code: 'after_latest', severity: 'block', created_at: '2026-06-22T10:00:00Z', meta: { message: 'Sam too late' } },
    ],
    ...overrides,
  }
}

describe('registerComplianceReportFeature', () => {
  beforeEach(() => { _resetCommandsForTesting(); _resetIntentsForTesting() })

  it('registers /compliance, /complianceaudit (owner) and the intent', () => {
    registerComplianceReportFeature(baseDeps())
    assert.equal(getCommand('compliance').role, 'owner')
    assert.equal(getCommand('complianceaudit').role, 'owner')
    assert.ok(getIntent('compliance_check'))
  })

  it('/compliance reports violations on the live schedule', async () => {
    const replies = []
    const recorded = []
    registerComplianceReportFeature(baseDeps({ recordViolations: async (r, ctx) => { recorded.push(ctx); return [{ id: 1 }] } }))
    const res = await dispatchCommand('compliance', { groupId: 'g1', userId: 7, reply: (m) => replies.push(m) }, owner)
    assert.equal(res.handled, true)
    assert.match(replies[0], /compliance/i)
    assert.match(replies[0], /Sam/)
    assert.equal(recorded.length, 1) // violations persisted
  })

  it('/compliance handles an empty schedule gracefully', async () => {
    const replies = []
    registerComplianceReportFeature(baseDeps({ loadSchedule: async () => ({ assignments: [] }) }))
    const res = await dispatchCommand('compliance', { groupId: 'g1', userId: 7, reply: (m) => replies.push(m) }, owner)
    assert.equal(res.handled, true)
    assert.match(replies[0], /No published schedule/)
  })

  it('/complianceaudit renders the audit log', async () => {
    const replies = []
    registerComplianceReportFeature(baseDeps())
    await dispatchCommand('complianceaudit', { groupId: 'g1', userId: 7, reply: (m) => replies.push(m) }, owner)
    assert.match(replies[0], /audit/i)
    assert.match(replies[0], /minor_violation/)
  })

  it('non-owner is denied /compliance', async () => {
    let ran = false
    registerComplianceReportFeature(baseDeps({ loadSchedule: async () => { ran = true; return { assignments: [] } } }))
    const res = await dispatchCommand('compliance', { groupId: 'g1', userId: 7 }, { isAuthorized: async () => false })
    assert.equal(res.denied, true)
    assert.equal(ran, false)
  })
})
