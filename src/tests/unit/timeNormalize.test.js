import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeShiftTime } from '../../utils/time.js'

describe('normalizeShiftTime', () => {
  test('canonical HH:MM passes through padded', () => {
    assert.equal(normalizeShiftTime('9:05'), '09:05')
  })
  test('12-hour am/pm → 24h', () => {
    assert.equal(normalizeShiftTime('4:30 PM'), '16:30')
    assert.equal(normalizeShiftTime('11am'), '11:00')
    assert.equal(normalizeShiftTime('12am'), '00:00')
  })
  test('bare ambiguous hour left alone', () => {
    assert.equal(normalizeShiftTime('4'), '4')
  })
})
