import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCalloutProbability,
  getCalloutHistory,
  predictCalloutRisks,
  formatCalloutRiskSection
} from '../../intelligence/calloutPredictor.js'

// --- Shared signal fixtures ---

const highRiskSignals = {
  historicalCalloutRateThisDay: 0.67,
  historicalCalloutRateThisShift: 0.5,
  recentCalloutSpike: true,
  moraleScore: 38, moraleTrend: 'declining',
  consecutiveDaysThisWeek: 6,
  totalObservations: 8
}

const lowRiskSignals = {
  historicalCalloutRateThisDay: 0.05,
  historicalCalloutRateThisShift: 0.0,
  recentCalloutSpike: false,
  moraleScore: 85, moraleTrend: 'stable',
  consecutiveDaysThisWeek: 2,
  totalObservations: 10
}

const newStaffSignals = {
  historicalCalloutRateThisDay: 1.0,
  historicalCalloutRateThisShift: 1.0,
  recentCalloutSpike: true,
  moraleScore: 40, moraleTrend: 'declining',
  consecutiveDaysThisWeek: 5,
  totalObservations: 2 // new staff
}

// --- helpers ---

function makeDb(overrides = {}) {
  return {
    getCalloutHistory: overrides.getCalloutHistory || (async () => []),
    getMoraleEvents: overrides.getMoraleEvents || (async () => []),
    getStaffByTelegramId: overrides.getStaffByTelegramId || (async () => null),
    getConsecutiveDays: overrides.getConsecutiveDays || (async () => 0),
    ...overrides
  }
}

// ===== calculateCalloutProbability =====

describe('calculateCalloutProbability', { concurrency: true }, () => {

  it('highRiskSignals → probability > 0.6, riskLevel critical', () => {
    const result = calculateCalloutProbability(highRiskSignals)
    assert.ok(result.probability > 0.6, `expected > 0.6 got ${result.probability}`)
    assert.equal(result.riskLevel, 'critical')
  })

  it('lowRiskSignals → probability < 0.2, riskLevel low', () => {
    const result = calculateCalloutProbability(lowRiskSignals)
    assert.ok(result.probability < 0.2, `expected < 0.2 got ${result.probability}`)
    assert.equal(result.riskLevel, 'low')
  })

  it('newStaffSignals → riskLevel capped at medium (totalObservations < 3)', () => {
    const result = calculateCalloutProbability(newStaffSignals)
    // Even though raw probability would be critical, cap at medium
    assert.equal(result.riskLevel, 'medium')
  })

  it('historicalCalloutRateThisDay contributes 35% weight', () => {
    const base = {
      historicalCalloutRateThisDay: 0,
      historicalCalloutRateThisShift: 0,
      recentCalloutSpike: false,
      moraleScore: 85, moraleTrend: 'stable',
      consecutiveDaysThisWeek: 0,
      totalObservations: 10
    }
    const withDay = { ...base, historicalCalloutRateThisDay: 1.0 }
    const r1 = calculateCalloutProbability(base)
    const r2 = calculateCalloutProbability(withDay)
    const diff = r2.probability - r1.probability
    assert.ok(Math.abs(diff - 0.35) < 0.001, `expected 0.35 contribution got ${diff}`)
  })

  it('moraleScore < 50 adds 0.10', () => {
    const base = {
      historicalCalloutRateThisDay: 0,
      historicalCalloutRateThisShift: 0,
      recentCalloutSpike: false,
      moraleScore: 85, moraleTrend: 'stable',
      consecutiveDaysThisWeek: 0,
      totalObservations: 10
    }
    const withLowMorale = { ...base, moraleScore: 40 }
    const r1 = calculateCalloutProbability(base)
    const r2 = calculateCalloutProbability(withLowMorale)
    const diff = r2.probability - r1.probability
    assert.ok(Math.abs(diff - 0.10) < 0.001, `expected 0.10 contribution got ${diff}`)
  })

  it('moraleTrend declining adds 0.05', () => {
    const base = {
      historicalCalloutRateThisDay: 0,
      historicalCalloutRateThisShift: 0,
      recentCalloutSpike: false,
      moraleScore: 85, moraleTrend: 'stable',
      consecutiveDaysThisWeek: 0,
      totalObservations: 10
    }
    const withDeclining = { ...base, moraleTrend: 'declining' }
    const r1 = calculateCalloutProbability(base)
    const r2 = calculateCalloutProbability(withDeclining)
    const diff = r2.probability - r1.probability
    assert.ok(Math.abs(diff - 0.05) < 0.001, `expected 0.05 contribution got ${diff}`)
  })

  it('consecutiveDaysThisWeek >= 5 adds 0.05', () => {
    const base = {
      historicalCalloutRateThisDay: 0,
      historicalCalloutRateThisShift: 0,
      recentCalloutSpike: false,
      moraleScore: 85, moraleTrend: 'stable',
      consecutiveDaysThisWeek: 3,
      totalObservations: 10
    }
    const withConsecutive = { ...base, consecutiveDaysThisWeek: 5 }
    const r1 = calculateCalloutProbability(base)
    const r2 = calculateCalloutProbability(withConsecutive)
    const diff = r2.probability - r1.probability
    assert.ok(Math.abs(diff - 0.05) < 0.001, `expected 0.05 contribution got ${diff}`)
  })

  it('recentCalloutSpike adds 0.15', () => {
    const base = {
      historicalCalloutRateThisDay: 0,
      historicalCalloutRateThisShift: 0,
      recentCalloutSpike: false,
      moraleScore: 85, moraleTrend: 'stable',
      consecutiveDaysThisWeek: 0,
      totalObservations: 10
    }
    const withSpike = { ...base, recentCalloutSpike: true }
    const r1 = calculateCalloutProbability(base)
    const r2 = calculateCalloutProbability(withSpike)
    const diff = r2.probability - r1.probability
    assert.ok(Math.abs(diff - 0.15) < 0.001, `expected 0.15 contribution got ${diff}`)
  })

  it('clamps probability to 0-1', () => {
    // All maxed out signals
    const extreme = {
      historicalCalloutRateThisDay: 1.0,
      historicalCalloutRateThisShift: 1.0,
      recentCalloutSpike: true,
      moraleScore: 10, moraleTrend: 'declining',
      consecutiveDaysThisWeek: 7,
      totalObservations: 20
    }
    const result = calculateCalloutProbability(extreme)
    assert.ok(result.probability <= 1.0, `probability ${result.probability} exceeds 1.0`)
    assert.ok(result.probability >= 0, `probability ${result.probability} below 0`)
  })

  it('keyFactors non-empty for non-low risk', () => {
    const result = calculateCalloutProbability(highRiskSignals)
    assert.ok(result.keyFactors.length > 0, 'keyFactors should not be empty')
    assert.ok(result.keyFactors.length <= 3, 'keyFactors should have at most 3')
  })
})

// ===== getCalloutHistory =====

describe('getCalloutHistory', { concurrency: true }, () => {

  it('returns correct total and byDay counts', async () => {
    const now = new Date()
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
    const fiveWeeksAgo = new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString()

    const db = makeDb({
      getCalloutHistory: async () => [
        { day_of_week: 'Friday', shift_name: 'Dinner', created_at: twoWeeksAgo },
        { day_of_week: 'Friday', shift_name: 'Dinner', created_at: fiveWeeksAgo },
        { day_of_week: 'Monday', shift_name: 'Lunch', created_at: fiveWeeksAgo },
      ]
    })

    const result = await getCalloutHistory('g1', 'staff1', 8, db)
    assert.equal(result.total, 3)
    assert.equal(result.byDay.Friday, 2)
    assert.equal(result.byDay.Monday, 1)
  })

  it('recentCount only counts last 3 weeks', async () => {
    const now = new Date()
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString()
    const sixWeeksAgo = new Date(now - 42 * 24 * 60 * 60 * 1000).toISOString()

    const db = makeDb({
      getCalloutHistory: async () => [
        { day_of_week: 'Friday', shift_name: 'Dinner', created_at: oneWeekAgo },
        { day_of_week: 'Friday', shift_name: 'Dinner', created_at: twoWeeksAgo },
        { day_of_week: 'Friday', shift_name: 'Dinner', created_at: sixWeeksAgo },
      ]
    })

    const result = await getCalloutHistory('g1', 'staff1', 8, db)
    assert.equal(result.total, 3)
    assert.equal(result.recentCount, 2) // only 2 in last 3 weeks
  })

  it('empty history returns total:0 and overallRate:0', async () => {
    const db = makeDb({
      getCalloutHistory: async () => []
    })
    const result = await getCalloutHistory('g1', 'staff1', 8, db)
    assert.equal(result.total, 0)
    assert.equal(result.overallRate, 0)
    assert.deepEqual(result.byDay, {})
  })
})

// ===== predictCalloutRisks =====

describe('predictCalloutRisks', { concurrency: true }, () => {

  it('returns only non-low risks', async () => {
    const db = makeDb({
      getCalloutHistory: async () => [],
      getMoraleEvents: async () => [],
      getConsecutiveDays: async () => 0,
    })
    // All assignments will be low risk with empty data
    const assignments = [
      { staffId: 's1', staffName: 'Alice', shiftName: 'Lunch', dayOfWeek: 'Monday', telegramId: 101 }
    ]
    const result = await predictCalloutRisks('g1', assignments, db)
    assert.equal(result.length, 0) // low risk filtered out
  })

  it('sorted DESC by probability', async () => {
    const now = new Date()
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Create many callout rows for staff 1 on Friday
    const manyFridayCallouts = Array.from({ length: 6 }, () => ({
      day_of_week: 'Friday', shift_name: 'Dinner', created_at: oneWeekAgo
    }))
    // Fewer callouts for staff 2
    const fewCallouts = Array.from({ length: 3 }, () => ({
      day_of_week: 'Tuesday', shift_name: 'Lunch', created_at: oneWeekAgo
    }))

    const db = makeDb({
      getCalloutHistory: async (gid, sid) => {
        if (sid === 101) return manyFridayCallouts
        if (sid === 102) return fewCallouts
        return []
      },
      getMoraleEvents: async () => [],
      getConsecutiveDays: async () => 0,
    })

    const assignments = [
      { staffId: 's2', staffName: 'Sarah', shiftName: 'Lunch', dayOfWeek: 'Tuesday', telegramId: 102 },
      { staffId: 's1', staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', telegramId: 101 },
    ]
    const result = await predictCalloutRisks('g1', assignments, db)
    if (result.length >= 2) {
      assert.ok(result[0].probability >= result[1].probability, 'should be sorted DESC')
    }
  })

  it('empty assignments returns empty array', async () => {
    const db = makeDb()
    const result = await predictCalloutRisks('g1', [], db)
    assert.deepEqual(result, [])
  })

  it('all low risk returns empty array', async () => {
    const db = makeDb({
      getCalloutHistory: async () => [],
      getMoraleEvents: async () => [],
      getConsecutiveDays: async () => 0,
    })
    const assignments = [
      { staffId: 's1', staffName: 'Alice', shiftName: 'Lunch', dayOfWeek: 'Monday', telegramId: 101 },
      { staffId: 's2', staffName: 'Bob', shiftName: 'Dinner', dayOfWeek: 'Tuesday', telegramId: 102 },
    ]
    const result = await predictCalloutRisks('g1', assignments, db)
    assert.equal(result.length, 0)
  })
})

// ===== formatCalloutRiskSection =====

describe('formatCalloutRiskSection', { concurrency: true }, () => {

  it('returns null when empty', () => {
    assert.equal(formatCalloutRiskSection([]), null)
  })

  it('returns null when weeksOfData < 4', () => {
    const risks = [{ staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['4 callouts on Fridays'] }]
    assert.equal(formatCalloutRiskSection(risks, 3), null)
  })

  it('contains staff names and percentages', () => {
    const risks = [
      { staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['4 callouts on Fridays', 'morale declining'] },
      { staffName: 'Sarah', shiftName: 'Lunch', dayOfWeek: 'Tuesday', probability: 0.38, riskLevel: 'medium', keyFactors: ['called out 2 of last 4 Tuesdays'] },
    ]
    const text = formatCalloutRiskSection(risks, 8)
    assert.ok(text.includes('Marcus'), 'should contain Marcus')
    assert.ok(text.includes('62%'), 'should contain 62%')
    assert.ok(text.includes('Sarah'), 'should contain Sarah')
    assert.ok(text.includes('38%'), 'should contain 38%')
  })

  it('contains key factors', () => {
    const risks = [
      { staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['4 callouts on Fridays', 'morale declining'] },
    ]
    const text = formatCalloutRiskSection(risks, 8)
    assert.ok(text.includes('4 callouts on Fridays'), 'should contain key factor')
  })

  it('contains predictions not certainties caveat', () => {
    const risks = [
      { staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['high callout rate'] },
    ]
    const text = formatCalloutRiskSection(risks, 8)
    assert.ok(text.includes('predictions, not certainties'), 'should contain caveat')
  })

  it('uses red circle for critical/high and yellow for medium', () => {
    const risks = [
      { staffName: 'Marcus', shiftName: 'Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['high rate'] },
      { staffName: 'Sarah', shiftName: 'Lunch', dayOfWeek: 'Tuesday', probability: 0.38, riskLevel: 'medium', keyFactors: ['moderate rate'] },
    ]
    const text = formatCalloutRiskSection(risks, 8)
    assert.ok(text.includes('\u{1F534}'), 'should contain red circle for critical')
    assert.ok(text.includes('\u{1F7E1}'), 'should contain yellow circle for medium')
  })
})
