import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { formatPayStub } from '../../payroll/payStub.js'
import { registerPayStubFeature } from '../../payroll/payStubFeature.js'
import { matchIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'

describe('formatPayStub', () => {
  it('formats hours, pay, and week', () => {
    const out = formatPayStub({ week_start: '2026-06-22', total_hours: 32.5, total_gross_pay: 487.50 }, { name: 'Maria' })
    assert.match(out, /week of 2026-06-22/)
    assert.match(out, /Employee: Maria/)
    assert.match(out, /Hours: 32\.5/)
    assert.match(out, /Pay: \*\$487\.50\*/)
  })

  it('shows a late-deduction line only when there is one', () => {
    const withLate = formatPayStub({ total_gross_pay: 100, total_late_minutes: 15, total_late_deduction: 7.5 })
    assert.match(withLate, /Late deductions: 15min \(−\$7\.50\)/)
    const noLate = formatPayStub({ total_gross_pay: 100, total_late_deduction: 0 })
    assert.doesNotMatch(noLate, /Late deductions/)
  })

  it('handles a missing record', () => {
    assert.match(formatPayStub(null), /No pay data/)
  })
})

describe('registerPayStubFeature', () => {
  beforeEach(() => { _resetIntentsForTesting(); _resetCommandsForTesting() })

  it('registers /paystub (role any) + intent', () => {
    registerPayStubFeature()
    const cmd = getCommand('paystub')
    assert.ok(cmd)
    assert.equal(cmd.role, 'any')
    assert.equal(matchIntent('can i get my pay stub')?.name, 'pay_stub_request')
  })

  it('replies with the latest stub', async () => {
    let replied = null
    registerPayStubFeature({ getLatestPayroll: async () => ({ week_start: '2026-06-22', total_hours: 40, total_gross_pay: 600 }) })
    await getCommand('paystub').handler({ groupId: 'g1', userId: 5, name: 'Sam', reply: async (t) => { replied = t } })
    assert.match(replied, /Pay: \*\$600\.00\*/)
  })

  it('replies with a no-data stub when there is no record', async () => {
    let replied = null
    registerPayStubFeature({ getLatestPayroll: async () => null })
    const r = await getCommand('paystub').handler({ groupId: 'g1', userId: 5, reply: async (t) => { replied = t } })
    assert.equal(r.hasData, false)
    assert.match(replied, /No pay data/)
  })
})
