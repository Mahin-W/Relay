import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_WAGE, minWageWarning } from '../../payroll/minWage.js'

describe('minWageWarning (P1-23)', () => {
  test('warns for a real rate below the floor', () => {
    const w = minWageWarning(5)
    assert.ok(w && w.includes('below'), `expected a warning, got ${w}`)
  })
  test('no warning at or above the floor', () => {
    assert.equal(minWageWarning(MIN_WAGE), null)
    assert.equal(minWageWarning(16.5), null)
  })
  test('no warning for zero / blank / non-numeric (unset rate)', () => {
    assert.equal(minWageWarning(0), null)
    assert.equal(minWageWarning(''), null)
    assert.equal(minWageWarning(undefined), null)
  })
})
