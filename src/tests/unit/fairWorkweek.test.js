import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  noticeDays, assessChange, summarizePredictabilityPay, checkAdvanceNotice,
} from '../../compliance/fairWorkweek.js'
import { resolveRuleset } from '../../compliance/complianceProfiles.js'

const FW = resolveRuleset('OR')          // Oregon: fairWorkweek, 14-day notice
const SF = resolveRuleset('CA', 'San Francisco') // FW city, 14-day notice
const TX = resolveRuleset('TX')          // not a FW jurisdiction

describe('noticeDays', () => {
  it('counts whole days between posting and shift', () => {
    assert.equal(noticeDays('2026-06-01', '2026-06-15'), 14)
    assert.equal(noticeDays('2026-06-10', '2026-06-12'), 2)
  })
  it('returns null for bad input', () => {
    assert.equal(noticeDays('nope', '2026-06-12'), null)
  })
})

describe('assessChange — non-FW jurisdiction', () => {
  it('never owes predictability pay', () => {
    const r = assessChange({ type: 'add_shift', noticeDays: 0 }, TX)
    assert.equal(r.owed, false)
    assert.equal(r.reason, 'not_a_fair_workweek_jurisdiction')
  })
})

describe('assessChange — FW jurisdiction', () => {
  it('sufficient notice owes nothing', () => {
    const r = assessChange({ type: 'add_shift', noticeDays: 14 }, FW)
    assert.equal(r.owed, false)
    assert.equal(r.reason, 'sufficient_notice')
  })

  it('late employer-added shift owes 1 hour', () => {
    const r = assessChange({ type: 'add_shift', noticeDays: 3 }, FW)
    assert.equal(r.owed, true)
    assert.equal(r.premiumHours, 1)
    assert.equal(r.reason, 'employer_added_or_moved')
  })

  it('late cancellation owes half the lost shift', () => {
    const r = assessChange({ type: 'cancel_shift', noticeDays: 1, shiftHours: 8 }, SF)
    assert.equal(r.owed, true)
    assert.equal(r.premiumHours, 4)
  })

  it('reduction owes half the lost hours', () => {
    const r = assessChange({ type: 'reduce_hours', noticeDays: 0, originalHours: 8, newHours: 5 }, FW)
    assert.equal(r.premiumHours, 1.5)
  })

  it('clopening on short notice owes 1 hour', () => {
    const r = assessChange({ type: 'clopening', noticeDays: 0 }, FW)
    assert.equal(r.owed, true)
    assert.equal(r.premiumHours, 1)
  })

  it('employee-initiated change owes nothing', () => {
    const r = assessChange({ type: 'add_shift', noticeDays: 0, employeeInitiated: true }, FW)
    assert.equal(r.owed, false)
    assert.equal(r.reason, 'employee_initiated')
  })

  it('derives notice from postedAt/shiftStart when noticeDays absent', () => {
    const r = assessChange({ type: 'add_shift', postedAt: '2026-06-10', shiftStart: '2026-06-12' }, FW)
    assert.equal(r.noticeDays, 2)
    assert.equal(r.owed, true)
  })
})

describe('summarizePredictabilityPay', () => {
  it('totals premium hours and dollars across changes', () => {
    const changes = [
      { type: 'add_shift', noticeDays: 1 },                     // 1h
      { type: 'cancel_shift', noticeDays: 0, shiftHours: 6 },   // 3h
      { type: 'add_shift', noticeDays: 20 },                    // sufficient notice → 0
    ]
    const s = summarizePredictabilityPay(changes, FW, 2000) // $20/hr
    assert.equal(s.totalPremiumHours, 4)
    assert.equal(s.owedCount, 2)
    assert.equal(s.totalPremiumCents, 8000)
  })

  it('omits dollar total when no rate given', () => {
    const s = summarizePredictabilityPay([{ type: 'add_shift', noticeDays: 0 }], FW)
    assert.equal(s.totalPremiumCents, null)
  })
})

describe('checkAdvanceNotice', () => {
  it('flags a schedule posted with too little notice', () => {
    const r = checkAdvanceNotice('2026-06-10', '2026-06-15', FW)
    assert.equal(r.required, 14)
    assert.equal(r.actual, 5)
    assert.equal(r.compliant, false)
  })
  it('is always compliant in non-FW jurisdictions', () => {
    const r = checkAdvanceNotice('2026-06-14', '2026-06-15', TX)
    assert.equal(r.compliant, true)
    assert.equal(r.fairWorkweek, false)
  })
})
