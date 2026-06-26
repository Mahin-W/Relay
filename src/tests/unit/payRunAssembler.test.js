import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePayRun, formatPayRunPreview, formatMoney } from '../../payouts/payRunAssembler.js'

const payroll = [
  { staff_id: 1, name: 'Maria', total_gross_pay: 500.00 },
  { staff_id: 2, name: 'Jordan', total_gross_pay: 333.33 },
]

describe('assemblePayRun', () => {
  it('builds cent-based items from dollar payroll, default tips 0, tax type w2', async () => {
    const r = await assemblePayRun('g1', '2026-06-22', {
      getPayroll: async () => payroll,
      getTaxType: async () => 'w2',
    })
    assert.equal(r.items.length, 2)
    assert.equal(r.items[0].wageCents, 50000)
    assert.equal(r.items[1].wageCents, 33333) // 333.33 → 33333 cents
    assert.ok(r.items.every(i => i.tipCents === 0 && i.taxType === 'w2'))
    assert.equal(r.totalCents, 50000 + 33333)
  })

  it('includes non-cash tips when a resolver is provided', async () => {
    const r = await assemblePayRun('g1', '2026-06-22', {
      getPayroll: async () => [payroll[0]],
      getTaxType: async () => 'w2',
      getTipCents: async (staffId) => (staffId === 1 ? 8400 : 0),
    })
    assert.equal(r.items[0].tipCents, 8400)
    assert.equal(r.items[0].netCents, 50000 + 8400)
    assert.equal(r.totalCents, 58400)
  })

  it('reflects per-employee tax type from the resolver', async () => {
    const r = await assemblePayRun('g1', '2026-06-22', {
      getPayroll: async () => payroll,
      getTaxType: async (g, s) => (s === 2 ? '1099' : 'w2'),
    })
    assert.equal(r.items.find(i => i.staffId === 2).taxType, '1099')
  })

  it('returns an empty result + message when there is no payroll', async () => {
    const r = await assemblePayRun('g1', '2026-06-22', { getPayroll: async () => [] })
    assert.equal(r.items.length, 0)
    assert.equal(r.totalCents, 0)
    assert.match(r.preview, /No payroll records/)
  })

  it('fails safe when the payroll read throws', async () => {
    const r = await assemblePayRun('g1', '2026-06-22', { getPayroll: async () => { throw new Error('db down') } })
    assert.equal(r.items.length, 0)
    assert.match(r.preview, /Could not load/)
  })
})

describe('formatPayRunPreview', () => {
  it('shows total, per-line net, tips and 1099 tag', () => {
    const out = formatPayRunPreview({
      items: [
        { staffId: 1, name: 'Maria', netCents: 58400, tipCents: 8400, taxType: 'w2' },
        { staffId: 2, name: 'Jordan', netCents: 33333, tipCents: 0, taxType: '1099' },
      ],
      totalCents: 91733,
    }, '2026-06-22')
    assert.match(out, /Pay 2 staff for week of 2026-06-22 — \$917\.33 total/)
    assert.match(out, /Maria: \$584\.00 \(\+\$84\.00 tips\)/)
    assert.match(out, /Jordan \[1099\]: \$333\.33/)
  })

  it('falls back to Staff #id when no name', () => {
    const out = formatPayRunPreview({ items: [{ staffId: 9, netCents: 100, tipCents: 0, taxType: 'w2' }], totalCents: 100 })
    assert.match(out, /Staff #9: \$1\.00/)
  })

  it('handles an empty run', () => {
    assert.match(formatPayRunPreview({ items: [], totalCents: 0 }), /No one to pay/)
  })
})

describe('formatMoney', () => {
  it('formats cents as dollars', () => {
    assert.equal(formatMoney(0), '$0.00')
    assert.equal(formatMoney(58400), '$584.00')
    assert.equal(formatMoney(5), '$0.05')
  })
})
