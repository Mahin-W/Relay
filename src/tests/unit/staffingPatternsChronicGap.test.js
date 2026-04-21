// G4 (3.17): generateStaffingRecommendations must flag chronic (3+ weeks) unfilled shifts
// when given raw history records instead of pre-analyzed patterns.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateStaffingRecommendations } from '../../intelligence/staffingPatterns.js'

// Helper: build N weeks of history rows for a (shiftName, dayOfWeek, role)
function makeHistory(shiftName, dayOfWeek, role, weeks, scheduled, required) {
  return Array.from({ length: weeks }, (_, i) => ({
    shiftName, dayOfWeek, role,
    scheduled,
    required,
    weekStart: `2025-0${1 + Math.floor(i / 4)}-${String(((i % 4) * 7) + 6).padStart(2, '0')}`,
  }))
}

describe('generateStaffingRecommendations (raw history / G4 mode)', { concurrency: true }, () => {
  test('4 weeks Wed Cook gaps → recommendation produced', () => {
    const history = makeHistory('Mon-Fri Dinner', 'Wednesday', 'Cook', 4, 0, 1)
    const recs = generateStaffingRecommendations(history)
    assert.ok(Array.isArray(recs), `Expected array, got: ${JSON.stringify(recs)}`)
    assert.ok(recs.length >= 1, `Expected at least 1 recommendation for 4 weeks of gaps: ${JSON.stringify(recs)}`)
    const rec = recs[0]
    assert.equal(rec.dayOfWeek, 'Wednesday', 'dayOfWeek must be Wednesday')
    assert.equal(rec.role, 'Cook', 'role must be Cook')
    assert.ok(rec.weeksUnderfilled >= 3, `weeksUnderfilled must be >= 3, got ${rec.weeksUnderfilled}`)
    assert.ok(['critical', 'high'].includes(rec.severity), `severity must be critical or high, got ${rec.severity}`)
    assert.ok(typeof rec.suggestion === 'string' && rec.suggestion.length > 0, 'suggestion must be non-empty string')
  })

  test('severity critical when 4+ weeks underfilled', () => {
    const history = makeHistory('Dinner', 'Wednesday', 'Cook', 4, 0, 1)
    const recs = generateStaffingRecommendations(history)
    assert.ok(recs.length >= 1, 'recommendation exists')
    assert.equal(recs[0].severity, 'critical', `4 weeks should be critical, got ${recs[0].severity}`)
  })

  test('severity high when exactly 3 weeks underfilled', () => {
    const history = makeHistory('Dinner', 'Friday', 'Server', 3, 1, 2)
    const recs = generateStaffingRecommendations(history)
    assert.ok(recs.length >= 1, 'recommendation for 3 weeks exists')
    assert.equal(recs[0].severity, 'high', `3 weeks should be high, got ${recs[0].severity}`)
  })

  test('2 weeks underfilled → no recommendation (below threshold)', () => {
    const history = makeHistory('Lunch', 'Tuesday', 'Server', 2, 0, 1)
    const recs = generateStaffingRecommendations(history)
    assert.ok(Array.isArray(recs), 'returns array')
    assert.equal(recs.length, 0, `2 weeks should not trigger recommendation: ${JSON.stringify(recs)}`)
  })

  test('mixed roles: only chronic one flagged', () => {
    const history = [
      ...makeHistory('Dinner', 'Wednesday', 'Cook', 4, 0, 1),     // chronic
      ...makeHistory('Dinner', 'Wednesday', 'Server', 2, 2, 3),   // not chronic
    ]
    const recs = generateStaffingRecommendations(history)
    assert.equal(recs.length, 1, `Only Cook should be flagged: ${JSON.stringify(recs)}`)
    assert.equal(recs[0].role, 'Cook')
  })

  test('empty history → empty array', () => {
    const recs = generateStaffingRecommendations([])
    // Empty input: either [] (raw mode not triggered) or { recommendations: [] } — handle both
    if (Array.isArray(recs)) {
      assert.equal(recs.length, 0)
    } else {
      assert.equal(recs.recommendations.length, 0)
    }
  })

  test('pre-analyzed patterns still work (backward compat)', () => {
    const patterns = [{
      shiftId: 1, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 2.25,
      understaffedWeeks: 6, overstaffedWeeks: 0,
      understaffedRate: 0.75, overstaffedRate: 0,
      pattern: 'chronic_understaffing',
    }]
    const result = generateStaffingRecommendations(patterns)
    // Should return { recommendations, summary } (legacy shape)
    assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'legacy shape is object with recommendations')
    assert.ok(Array.isArray(result.recommendations), 'has recommendations array')
    assert.equal(result.recommendations.length, 1)
    assert.equal(result.recommendations[0].type, 'increase_requirement')
  })
})
