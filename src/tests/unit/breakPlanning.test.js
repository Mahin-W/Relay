import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planBreaks, shiftHours } from '../../compliance/breakPlanning.js'
import { resolveRuleset } from '../../compliance/complianceProfiles.js'

const CA = resolveRuleset('CA')      // meal after 5h, rest per 4h
const FED = resolveRuleset(null)     // no mandated breaks

describe('shiftHours', () => {
  it('uses an explicit hours value', () => {
    assert.equal(shiftHours({ hours: 7.5 }), 7.5)
  })
  it('computes from start/end clock times', () => {
    assert.equal(shiftHours({ start: '09:00', end: '17:00' }), 8)
  })
  it('handles shifts crossing midnight', () => {
    assert.equal(shiftHours({ start: '22:00', end: '02:00' }), 4)
  })
  it('returns 0 for unparseable input', () => {
    assert.equal(shiftHours({ start: 'noon', end: '5pm' }), 0)
  })
})

describe('planBreaks — California', () => {
  it('an 8h shift gets 1 unpaid meal and 2 paid rests', () => {
    const p = planBreaks({ hours: 8 }, CA)
    assert.equal(p.meals.length, 1)
    assert.equal(p.rests.length, 2)
    assert.equal(p.meals[0].paid, false)
    assert.equal(p.meals[0].durationMin, 30)
    assert.equal(p.rests[0].paid, true)
    assert.equal(p.unpaidMinutes, 30)
    assert.equal(p.paidMinutes, 20)
  })

  it('a 10h shift triggers a second meal', () => {
    const p = planBreaks({ hours: 10 }, CA)
    assert.equal(p.meals.length, 2)
    assert.equal(p.unpaidMinutes, 60)
  })

  it('a 4h shift gets a rest but no meal', () => {
    const p = planBreaks({ hours: 4 }, CA)
    assert.equal(p.meals.length, 0)
    assert.equal(p.rests.length, 1)
  })

  it('a short 3h shift gets nothing', () => {
    const p = planBreaks({ hours: 3 }, CA)
    assert.equal(p.breaks.length, 0)
    assert.equal(p.unpaidMinutes, 0)
    assert.equal(p.paidMinutes, 0)
  })

  it('breaks are returned sorted by when they fall in the shift', () => {
    const p = planBreaks({ start: '09:00', end: '19:00' }, CA) // 10h
    const offsets = p.breaks.map(b => b.dueAfterHours)
    const sorted = [...offsets].sort((a, b) => a - b)
    assert.deepEqual(offsets, sorted)
  })
})

describe('planBreaks — federal (no mandate)', () => {
  it('produces no breaks regardless of length', () => {
    const p = planBreaks({ hours: 12 }, FED)
    assert.equal(p.breaks.length, 0)
    assert.equal(p.notes.length, 0)
  })
})
