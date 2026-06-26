import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTaxType, setTaxType, getPayrollSettings } from '../../payroll/payrollSettings.js'

// Mock db implements payroll-settings methods AND insertAuditEvent (so logEvent
// stays mocked too — see lib/audit.js which checks db?.insertAuditEvent).
function makeDb(seedRow = null) {
  const state = { row: seedRow, audits: [] }
  return {
    state,
    getPayrollSettings: async () => state.row,
    upsertPayrollSettings: async (row) => { state.row = { id: 1, ...row }; return state.row },
    insertAuditEvent: async (row) => { state.audits.push(row); return { id: state.audits.length, ...row } },
  }
}

describe('getTaxType', () => {
  it('defaults to w2 when no settings row exists', async () => {
    assert.equal(await getTaxType('g1', 10, makeDb(null)), 'w2')
  })
  it('returns the stored tax type', async () => {
    assert.equal(await getTaxType('g1', 10, makeDb({ tax_type: '1099' })), '1099')
  })
})

describe('setTaxType', () => {
  it('switches an employee to 1099 and audits the change', async () => {
    const db = makeDb(null) // currently default w2
    const saved = await setTaxType('g1', 10, '1099', 555, db)
    assert.equal(saved.tax_type, '1099')
    assert.equal(saved.updated_by, '555')
    assert.equal(db.state.audits.length, 1)
    const audit = db.state.audits[0]
    assert.equal(audit.action, 'payroll.tax_type.change')
    assert.equal(audit.target, '10')
    assert.deepEqual(audit.meta, { from: 'w2', to: '1099' })
  })

  it('rejects an invalid tax type without writing', async () => {
    const db = makeDb(null)
    const saved = await setTaxType('g1', 10, 'contractor', 555, db)
    assert.equal(saved, null)
    assert.equal(db.state.audits.length, 0)
  })

  it('does not audit a no-op (same tax type)', async () => {
    const db = makeDb({ tax_type: '1099' })
    await setTaxType('g1', 10, '1099', 555, db)
    assert.equal(db.state.audits.length, 0)
  })

  it('persists the row via upsert', async () => {
    const db = makeDb(null)
    await setTaxType('g1', 10, '1099', 555, db)
    assert.equal(db.state.row.tax_type, '1099')
    const settings = await getPayrollSettings('g1', 10, db)
    assert.equal(settings.tax_type, '1099')
  })
})
