import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySentiment,
  calculateMoraleScore,
  detectDisengagement,
  generateMoraleReport,
  formatMoraleAlert,
  formatMoraleReport,
} from '../../intelligence/moraleTracker.js'
import { saveMoraleEvent, getMoraleEvents } from '../../intelligence/moraleDb.js'

// Helper: create an event with defaults
function evt(type, opts = {}) {
  const now = new Date()
  const weeksAgo = opts.weeksAgo ?? 0
  const d = new Date(now)
  d.setDate(d.getDate() - weeksAgo * 7)
  return {
    type,
    sentiment: opts.sentiment ?? 'neutral',
    response_minutes: opts.responseMinutes ?? 30,
    week_start: opts.weekStart ?? '2026-04-06',
    created_at: d.toISOString(),
  }
}

function makeDb(staffEvents = {}) {
  return {
    getMoraleEvents: async (groupId, staffId) => staffEvents[staffId] || [],
  }
}

await Promise.all([
  // ── classifySentiment ──
  test('classifySentiment: "bet" → positive', () => {
    assert.equal(classifySentiment('bet'), 'positive')
  }),

  test('classifySentiment: "say less" → positive', () => {
    assert.equal(classifySentiment('say less'), 'positive')
  }),

  test('classifySentiment: "I guess if I have to" → negative', () => {
    assert.equal(classifySentiment('I guess if I have to'), 'negative')
  }),

  test('classifySentiment: "ok" → neutral', () => {
    assert.equal(classifySentiment('ok'), 'neutral')
  }),

  test('classifySentiment: "absolutely!" → positive', () => {
    assert.equal(classifySentiment('absolutely!'), 'positive')
  }),

  test('classifySentiment: "ugh fine" → negative', () => {
    assert.equal(classifySentiment('ugh fine'), 'negative')
  }),

  test('classifySentiment: empty string → neutral', () => {
    assert.equal(classifySentiment(''), 'neutral')
  }),

  test('classifySentiment: "Sure thing!" → positive (! makes it positive)', () => {
    assert.equal(classifySentiment('Sure thing!'), 'positive')
  }),

  // ── calculateMoraleScore ──
  test('calculateMoraleScore: all coverage_accept + positive → score > 65', () => {
    const events = Array.from({ length: 5 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 }))
    const result = calculateMoraleScore(events)
    assert.ok(result.score > 65, `Expected score > 65, got ${result.score}`)
  }),

  test('calculateMoraleScore: all coverage_decline + no_response → score < 40', () => {
    const events = [
      ...Array.from({ length: 3 }, () => evt('coverage_decline', { weeksAgo: 1 })),
      ...Array.from({ length: 3 }, () => evt('no_response', { weeksAgo: 1 })),
    ]
    const result = calculateMoraleScore(events)
    assert.ok(result.score < 40, `Expected score < 40, got ${result.score}`)
  }),

  test('calculateMoraleScore: mixed → 40-65 range', () => {
    const events = [
      evt('coverage_accept', { sentiment: 'neutral', weeksAgo: 1 }),
      evt('coverage_decline', { weeksAgo: 1 }),
      evt('coverage_decline', { weeksAgo: 3 }),
      evt('no_response', { weeksAgo: 3 }),
    ]
    const result = calculateMoraleScore(events)
    assert.ok(result.score >= 40 && result.score <= 65, `Expected 40-65, got ${result.score}`)
  }),

  test('calculateMoraleScore: recent negatives weighted more', () => {
    // Same events but recent vs old — recent negatives should hurt more
    const recentNeg = [
      evt('coverage_decline', { weeksAgo: 0 }),
      evt('coverage_decline', { weeksAgo: 0 }),
      evt('coverage_accept', { sentiment: 'positive', weeksAgo: 5 }),
    ]
    const oldNeg = [
      evt('coverage_decline', { weeksAgo: 5 }),
      evt('coverage_decline', { weeksAgo: 5 }),
      evt('coverage_accept', { sentiment: 'positive', weeksAgo: 0 }),
    ]
    const recentResult = calculateMoraleScore(recentNeg)
    const oldResult = calculateMoraleScore(oldNeg)
    assert.ok(recentResult.score < oldResult.score, `Recent negatives (${recentResult.score}) should score lower than old (${oldResult.score})`)
  }),

  test('calculateMoraleScore: empty events → { score: 50, trend: stable, signals: [] }', () => {
    const result = calculateMoraleScore([])
    assert.deepEqual(result, { score: 50, trend: 'stable', signals: [] })
  }),

  test('calculateMoraleScore: trend improving when recent > historical by 5+', () => {
    const events = [
      // Recent (last 2 weeks) — all positive
      ...Array.from({ length: 4 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 0 })),
      // Historical (2-4 weeks ago) — all negative
      ...Array.from({ length: 4 }, () => evt('coverage_decline', { weeksAgo: 3 })),
    ]
    const result = calculateMoraleScore(events)
    assert.equal(result.trend, 'improving', `Expected improving, got ${result.trend}`)
  }),

  // ── detectDisengagement ──
  test('detectDisengagement: 3 consecutive coverage_decline → flagged', () => {
    const events = [
      evt('coverage_decline', { weeksAgo: 0 }),
      evt('coverage_decline', { weeksAgo: 0 }),
      evt('coverage_decline', { weeksAgo: 1 }),
    ]
    const result = detectDisengagement('s1', events)
    assert.equal(result.flagged, true)
    assert.ok(result.reasons.some(r => r.toLowerCase().includes('consecutive decline')), `Reasons should mention consecutive declines: ${result.reasons}`)
  }),

  test('detectDisengagement: score 35 declining → flagged', () => {
    // Create events that produce score < 40 and declining trend
    const events = [
      ...Array.from({ length: 4 }, () => evt('no_response', { weeksAgo: 0 })),
      evt('coverage_accept', { sentiment: 'positive', weeksAgo: 3 }),
      evt('coverage_accept', { sentiment: 'positive', weeksAgo: 3 }),
    ]
    const result = detectDisengagement('s1', events)
    assert.equal(result.flagged, true)
  }),

  test('detectDisengagement: score 45 stable → NOT flagged', () => {
    const events = [
      evt('coverage_accept', { sentiment: 'neutral', weeksAgo: 1 }),
      evt('coverage_decline', { weeksAgo: 1 }),
      evt('schedule_confirm', { responseMinutes: 30, weeksAgo: 0 }),
    ]
    const result = detectDisengagement('s1', events)
    assert.equal(result.flagged, false)
  }),

  test('detectDisengagement: 3 no_response in 4 weeks → flagged', () => {
    const events = [
      evt('no_response', { weeksAgo: 0 }),
      evt('no_response', { weeksAgo: 1 }),
      evt('no_response', { weeksAgo: 3 }),
      evt('coverage_accept', { sentiment: 'neutral', weeksAgo: 1 }),
    ]
    const result = detectDisengagement('s1', events)
    assert.equal(result.flagged, true)
  }),

  test('detectDisengagement: strong performer → NOT flagged', () => {
    const events = Array.from({ length: 5 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 }))
    events.push(evt('schedule_confirm', { responseMinutes: 10, weeksAgo: 0 }))
    const result = detectDisengagement('s1', events)
    assert.equal(result.flagged, false)
  }),

  test('detectDisengagement: no events → NOT flagged', () => {
    const result = detectDisengagement('s1', [])
    assert.equal(result.flagged, false)
  }),

  // ── generateMoraleReport ──
  test('generateMoraleReport: returns alerts only for flagged staff', async () => {
    const db = makeDb({
      s1: [
        ...Array.from({ length: 5 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 })),
        evt('schedule_confirm', { responseMinutes: 10, weeksAgo: 0 }),
      ],
      s2: [
        ...Array.from({ length: 4 }, () => evt('no_response', { weeksAgo: 0 })),
        ...Array.from({ length: 2 }, () => evt('coverage_decline', { weeksAgo: 0 })),
      ],
    })
    const staffList = [
      { id: 's1', name: 'Alice' },
      { id: 's2', name: 'Bob' },
    ]
    const report = await generateMoraleReport('g1', staffList, db)
    assert.ok(report.alerts.length > 0, 'Should have alerts')
    assert.ok(report.alerts.every(a => a.staffId === 's2'), 'Only Bob should be flagged')
  }),

  test('generateMoraleReport: returns topPerformer correctly', async () => {
    const db = makeDb({
      s1: Array.from({ length: 5 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 })),
      s2: [evt('coverage_accept', { sentiment: 'neutral', weeksAgo: 1 })],
    })
    const staffList = [
      { id: 's1', name: 'Alice' },
      { id: 's2', name: 'Bob' },
    ]
    const report = await generateMoraleReport('g1', staffList, db)
    assert.equal(report.topPerformer.staffName, 'Alice')
  }),

  test('generateMoraleReport: teamAverage calculated', async () => {
    const db = makeDb({
      s1: Array.from({ length: 3 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 })),
      s2: Array.from({ length: 3 }, () => evt('coverage_accept', { sentiment: 'positive', weeksAgo: 1 })),
    })
    const staffList = [
      { id: 's1', name: 'Alice' },
      { id: 's2', name: 'Bob' },
    ]
    const report = await generateMoraleReport('g1', staffList, db)
    assert.equal(typeof report.teamAverage, 'number')
    assert.ok(report.teamAverage > 50, 'Average should be above baseline with positive events')
  }),

  test('generateMoraleReport: empty staff → graceful', async () => {
    const report = await generateMoraleReport('g1', [], makeDb())
    assert.deepEqual(report.alerts, [])
    assert.equal(report.topPerformer, null)
    assert.equal(report.teamAverage, 50)
    assert.deepEqual(report.snapshots, [])
  }),

  // ── formatMoraleAlert ──
  test('formatMoraleAlert: contains staff names and reasons', () => {
    const alerts = [
      { staffId: 's1', staffName: 'Alice', score: 30, trend: 'declining', reasons: ['3 consecutive declines'] },
    ]
    const result = formatMoraleAlert(alerts)
    assert.ok(result.includes('Alice'), 'Should contain staff name')
    assert.ok(result.includes('consecutive decline'), 'Should contain reason')
  }),

  test('formatMoraleAlert: empty → null', () => {
    assert.equal(formatMoraleAlert([]), null)
  }),

  // ── formatMoraleReport ──
  test('formatMoraleReport: color coding green/yellow/red', () => {
    const report = {
      alerts: [{ staffId: 's3', staffName: 'Charlie', score: 30, trend: 'declining', reasons: ['Low score'] }],
      topPerformer: { staffId: 's1', staffName: 'Alice', score: 80 },
      teamAverage: 55,
      snapshots: [
        { staffId: 's1', staffName: 'Alice', score: 80, trend: 'improving' },
        { staffId: 's2', staffName: 'Bob', score: 55, trend: 'stable' },
        { staffId: 's3', staffName: 'Charlie', score: 30, trend: 'declining' },
      ],
    }
    const result = formatMoraleReport(report)
    assert.ok(result.includes('\u{1F7E2}'), 'Should contain green circle for high score')
    assert.ok(result.includes('\u{1F7E1}'), 'Should contain yellow circle for mid score')
    assert.ok(result.includes('\u{1F534}'), 'Should contain red circle for low score')
  }),

  test('formatMoraleReport: score and trend for each', () => {
    const report = {
      alerts: [],
      topPerformer: { staffId: 's1', staffName: 'Alice', score: 70 },
      teamAverage: 70,
      snapshots: [
        { staffId: 's1', staffName: 'Alice', score: 70, trend: 'improving' },
      ],
    }
    const result = formatMoraleReport(report)
    assert.ok(result.includes('70'), 'Should contain score')
    assert.ok(result.includes('improving'), 'Should contain trend')
  }),

  test('formatMoraleReport: flagged show reasons', () => {
    const report = {
      alerts: [{ staffId: 's1', staffName: 'Alice', score: 30, trend: 'declining', reasons: ['Too many no-responses'] }],
      topPerformer: null,
      teamAverage: 30,
      snapshots: [
        { staffId: 's1', staffName: 'Alice', score: 30, trend: 'declining' },
      ],
    }
    const result = formatMoraleReport(report)
    assert.ok(result.includes('Too many no-responses'), 'Should show reason for flagged staff')
  }),

  test('formatMoraleReport: contains "Internal" disclaimer', () => {
    const report = {
      alerts: [],
      topPerformer: null,
      teamAverage: 50,
      snapshots: [],
    }
    const result = formatMoraleReport(report)
    assert.ok(result.includes('Internal'), 'Should contain Internal disclaimer')
  }),

  // ── saveMoraleEvent / getMoraleEvents mock tests ──
  test('saveMoraleEvent: saves all fields via DB injection', async () => {
    let saved = null
    const db = {
      saveMoraleEvent: async (groupId, staffId, event) => {
        saved = { groupId, staffId, event }
        return { id: 1, ...event }
      },
    }
    const event = { type: 'coverage_accept', responseMinutes: 5, sentiment: 'positive', weekStart: '2026-04-06' }
    await saveMoraleEvent('g1', 's1', event, db)
    assert.equal(saved.groupId, 'g1')
    assert.equal(saved.staffId, 's1')
    assert.equal(saved.event.type, 'coverage_accept')
    assert.equal(saved.event.responseMinutes, 5)
    assert.equal(saved.event.sentiment, 'positive')
    assert.equal(saved.event.weekStart, '2026-04-06')
  }),

  test('getMoraleEvents: returns ordered DESC via DB injection', async () => {
    const db = {
      getMoraleEvents: async (groupId, staffId) => [
        { id: 2, created_at: '2026-04-10T00:00:00Z' },
        { id: 1, created_at: '2026-04-05T00:00:00Z' },
      ],
    }
    const events = await getMoraleEvents('g1', 's1', 8, db)
    assert.equal(events.length, 2)
    assert.ok(events[0].created_at > events[1].created_at, 'Should be ordered DESC')
  }),
])
