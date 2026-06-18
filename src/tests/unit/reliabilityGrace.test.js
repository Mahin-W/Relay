import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipNegativeEvent, formatMyScore } from '../../reliability/reliabilityScore.js'

// ── shouldSkipNegativeEvent ────────────────────────────────────────────────────

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

await Promise.all([
  // Grace period — new hire
  test('negative event < 14 days → skip (return true)', () => {
    assert.equal(shouldSkipNegativeEvent(daysAgo(0)), true)
  }),

  test('negative event 13 days ago → skip', () => {
    assert.equal(shouldSkipNegativeEvent(daysAgo(13)), true)
  }),

  test('negative event exactly 14 days ago → do NOT skip', () => {
    assert.equal(shouldSkipNegativeEvent(daysAgo(14)), false)
  }),

  test('negative event 15 days ago → do NOT skip', () => {
    assert.equal(shouldSkipNegativeEvent(daysAgo(15)), false)
  }),

  test('negative event 30 days ago → do NOT skip', () => {
    assert.equal(shouldSkipNegativeEvent(daysAgo(30)), false)
  }),

  test('null created_at → do NOT skip (conservative, record the event)', () => {
    assert.equal(shouldSkipNegativeEvent(null), false)
  }),

  test('undefined created_at → do NOT skip', () => {
    assert.equal(shouldSkipNegativeEvent(undefined), false)
  }),

  // ── formatMyScore ──────────────────────────────────────────────────────────

  test('formatMyScore: 90 excellent includes score and label', () => {
    const text = formatMyScore(90, 'excellent')
    assert.ok(text.includes('90'), `expected "90" in: ${text}`)
    assert.ok(text.toLowerCase().includes('excellent'), `expected "excellent" in: ${text}`)
  }),

  test('formatMyScore: 50 fair includes fair label', () => {
    const text = formatMyScore(50, 'fair')
    assert.ok(text.includes('50'))
    assert.ok(text.toLowerCase().includes('fair'))
  }),

  test('formatMyScore: 30 poor includes poor label', () => {
    const text = formatMyScore(30, 'poor')
    assert.ok(text.includes('30'))
    assert.ok(text.toLowerCase().includes('poor'))
  }),

  test('formatMyScore: 70 good returns non-empty string', () => {
    const text = formatMyScore(70, 'good')
    assert.ok(typeof text === 'string' && text.length > 0)
  }),
])
