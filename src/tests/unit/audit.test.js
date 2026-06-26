import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logEvent, getAuditLog } from '../../lib/audit.js'

function makeMockDb(overrides = {}) {
  const inserted = []
  return {
    inserted,
    insertAuditEvent: async (row) => { inserted.push(row); return { id: inserted.length, ...row } },
    getAuditLog: async (groupId, opts) => ([{ group_id: groupId, action: opts.action ?? 'any', _limit: opts.limit }]),
    ...overrides,
  }
}

describe('logEvent', () => {
  it('returns null when groupId is missing', async () => {
    const db = makeMockDb()
    const out = await logEvent({ action: 'payroll.run' }, db)
    assert.equal(out, null)
    assert.equal(db.inserted.length, 0)
  })

  it('returns null when action is missing', async () => {
    const db = makeMockDb()
    const out = await logEvent({ groupId: 'g1' }, db)
    assert.equal(out, null)
    assert.equal(db.inserted.length, 0)
  })

  it('writes a normalized row to the store', async () => {
    const db = makeMockDb()
    await logEvent({
      groupId: -100123,
      actorId: 555,
      actorType: 'owner',
      action: 'tax_type.change',
      target: 42,
      meta: { from: 'w2', to: '1099' },
    }, db)
    assert.equal(db.inserted.length, 1)
    const row = db.inserted[0]
    assert.equal(row.group_id, '-100123')   // stringified
    assert.equal(row.actor_id, '555')        // stringified
    assert.equal(row.actor_type, 'owner')
    assert.equal(row.action, 'tax_type.change')
    assert.equal(row.target, '42')           // stringified
    assert.deepEqual(row.meta, { from: 'w2', to: '1099' })
  })

  it('coerces an invalid actorType to system', async () => {
    const db = makeMockDb()
    await logEvent({ groupId: 'g1', action: 'x', actorType: 'hacker' }, db)
    assert.equal(db.inserted[0].actor_type, 'system')
  })

  it('defaults actorId/target to null and meta to {}', async () => {
    const db = makeMockDb()
    await logEvent({ groupId: 'g1', action: 'x' }, db)
    const row = db.inserted[0]
    assert.equal(row.actor_id, null)
    assert.equal(row.target, null)
    assert.deepEqual(row.meta, {})
  })
})

describe('getAuditLog', () => {
  it('returns [] when groupId missing', async () => {
    const db = makeMockDb()
    const out = await getAuditLog(undefined, {}, db)
    assert.deepEqual(out, [])
  })

  it('passes limit and action through to the store', async () => {
    let captured = null
    const db = makeMockDb({
      getAuditLog: async (groupId, opts) => { captured = { groupId, opts }; return [] },
    })
    await getAuditLog('g1', { limit: 10, action: 'payroll.run' }, db)
    assert.equal(captured.groupId, 'g1')
    assert.equal(captured.opts.limit, 10)
    assert.equal(captured.opts.action, 'payroll.run')
  })

  it('defaults limit to 50 and action to null', async () => {
    let captured = null
    const db = makeMockDb({
      getAuditLog: async (groupId, opts) => { captured = opts; return [] },
    })
    await getAuditLog('g1', {}, db)
    assert.equal(captured.limit, 50)
    assert.equal(captured.action, null)
  })
})
