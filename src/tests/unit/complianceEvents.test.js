import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordEvent, recordScheduleViolations, getEvents,
  buildComplianceAuditReport, formatComplianceAuditReport,
} from '../../compliance/complianceEvents.js'

function makeDb(seed = []) {
  const state = { rows: [...seed] }
  return {
    state,
    insertComplianceEvent: async (row) => { const r = { id: state.rows.length + 1, created_at: '2026-06-25T10:00:00Z', ...row }; state.rows.push(r); return r },
    getComplianceEvents: async (gid, { eventType } = {}) =>
      state.rows.filter(r => r.group_id === gid && (!eventType || r.event_type === eventType)),
  }
}

describe('recordEvent', () => {
  it('records a valid event', async () => {
    const db = makeDb()
    const r = await recordEvent({ groupId: 'g1', staffId: 5, eventType: 'minor_violation', code: 'after_latest', severity: 'block' }, db)
    assert.equal(r.event_type, 'minor_violation')
    assert.equal(r.severity, 'block')
    assert.equal(db.state.rows.length, 1)
  })
  it('defaults an unknown severity to info', async () => {
    const db = makeDb()
    const r = await recordEvent({ groupId: 'g1', eventType: 'override', severity: 'nope' }, db)
    assert.equal(r.severity, 'info')
  })
  it('rejects missing groupId/eventType', async () => {
    const db = makeDb()
    assert.equal(await recordEvent({ eventType: 'override' }, db), null)
    assert.equal(await recordEvent({ groupId: 'g1' }, db), null)
    assert.equal(db.state.rows.length, 0)
  })
})

describe('recordScheduleViolations', () => {
  it('persists each issue from an eval result', async () => {
    const db = makeDb()
    const evalResult = {
      issues: [
        { staffId: 1, code: 'after_latest', day: 'Monday', age: 17, message: 'Sam ...', severity: 'block' },
        { staffId: 1, code: 'over_daily_max', day: 'Monday', age: 17, message: 'Sam ...', severity: 'block' },
      ],
    }
    const saved = await recordScheduleViolations(evalResult, { groupId: 'g1', weekStart: '2026-06-22' }, db)
    assert.equal(saved.length, 2)
    assert.equal(db.state.rows[0].event_type, 'minor_violation')
    assert.equal(db.state.rows[0].week_start, '2026-06-22')
  })
})

describe('getEvents', () => {
  it('filters by event type', async () => {
    const db = makeDb([
      { group_id: 'g1', event_type: 'minor_violation', code: 'x' },
      { group_id: 'g1', event_type: 'override', code: 'y' },
    ])
    const res = await getEvents('g1', { eventType: 'override' }, db)
    assert.equal(res.length, 1)
    assert.equal(res[0].event_type, 'override')
  })
})

describe('buildComplianceAuditReport / format', () => {
  const events = [
    { event_type: 'minor_violation', code: 'after_latest', severity: 'block', created_at: '2026-06-20T10:00:00Z', meta: { message: 'Sam too late' } },
    { event_type: 'minor_violation', code: 'over_daily_max', severity: 'block', created_at: '2026-06-22T10:00:00Z', meta: {} },
    { event_type: 'override', code: null, severity: 'info', created_at: '2026-06-25T10:00:00Z', meta: {} },
  ]
  it('aggregates by type/code/severity', () => {
    const r = buildComplianceAuditReport(events)
    assert.equal(r.totalEvents, 3)
    assert.equal(r.byType.minor_violation, 2)
    assert.equal(r.byCode.after_latest, 1)
    assert.equal(r.blocks, 2)
    assert.equal(r.periodStart.slice(0, 10), '2026-06-20')
    assert.equal(r.periodEnd.slice(0, 10), '2026-06-25')
  })
  it('formats a non-empty report', () => {
    const r = buildComplianceAuditReport(events)
    const out = formatComplianceAuditReport(r, events)
    assert.match(out, /3 events/)
    assert.match(out, /2 blocking/)
    assert.match(out, /minor_violation/)
  })
  it('formats an empty report cleanly', () => {
    const out = formatComplianceAuditReport(buildComplianceAuditReport([]), [])
    assert.match(out, /No compliance events/)
  })
})
