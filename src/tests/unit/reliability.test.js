import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeScore,
  getReliabilityLabel,
  formatReliabilityReport,
} from '../../reliability/reliabilityScore.js'
import { handleCoverageRequest } from '../../coverage/requestHandler.js'
import { handleCoverageConfirmation } from '../../coverage/confirmationHandler.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'

// Helper: create N events of a type without recorded_at (treated as old, 1x weight)
function makeEvents(type, count) {
  return Array.from({ length: count }, () => ({ event_type: type }))
}

// Helper: create a recent event (recorded_at = now)
function recentEvent(type) {
  return { event_type: type, recorded_at: new Date().toISOString() }
}

// Helper: create an old event (recorded_at = 60 days ago)
function oldEvent(type) {
  const d = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  return { event_type: type, recorded_at: d.toISOString() }
}

await Promise.all([
  // ── computeScore ──────────────────────────────────────────────────────
  test('computeScore: no events → 70 (baseline)', () => {
    assert.equal(computeScore([]), 70)
  }),

  test('computeScore: 2 covered_someone → 80', () => {
    assert.equal(computeScore(makeEvents('covered_someone', 2)), 80)
  }),

  test('computeScore: 3 no_call_no_show → 10 (clamped near floor)', () => {
    assert.equal(computeScore(makeEvents('no_call_no_show', 3)), 10)
  }),

  test('computeScore: mixed events → correct weighted sum', () => {
    const events = [
      ...makeEvents('covered_someone', 2), // +10
      ...makeEvents('called_out', 1),      // -10
    ]
    assert.equal(computeScore(events), 70) // 70 + 10 - 10 = 70
  }),

  test('computeScore: recent events weighted 2x vs old', () => {
    const oldScore = computeScore([oldEvent('covered_someone')])    // 70 + 5 = 75
    const recentScore = computeScore([recentEvent('covered_someone')]) // 70 + 10 = 80
    assert.ok(recentScore > oldScore, 'recent should score higher than old')
  }),

  test('computeScore: result always 0-100', () => {
    const score1 = computeScore(makeEvents('covered_someone', 100))
    const score2 = computeScore(makeEvents('no_call_no_show', 100))
    assert.ok(score1 >= 0 && score1 <= 100)
    assert.ok(score2 >= 0 && score2 <= 100)
  }),

  test('computeScore: all positive events → max 100', () => {
    assert.equal(computeScore(makeEvents('covered_someone', 100)), 100)
  }),

  test('computeScore: all negative events → min 0', () => {
    assert.equal(computeScore(makeEvents('no_call_no_show', 100)), 0)
  }),

  // ── getReliabilityLabel ───────────────────────────────────────────────
  test('getReliabilityLabel: 100 → "excellent"', () => {
    assert.equal(getReliabilityLabel(100), 'excellent')
  }),

  test('getReliabilityLabel: 85 → "excellent"', () => {
    assert.equal(getReliabilityLabel(85), 'excellent')
  }),

  test('getReliabilityLabel: 84 → "good"', () => {
    assert.equal(getReliabilityLabel(84), 'good')
  }),

  test('getReliabilityLabel: 70 → "good"', () => {
    assert.equal(getReliabilityLabel(70), 'good')
  }),

  test('getReliabilityLabel: 69 → "fair"', () => {
    assert.equal(getReliabilityLabel(69), 'fair')
  }),

  test('getReliabilityLabel: 50 → "fair"', () => {
    assert.equal(getReliabilityLabel(50), 'fair')
  }),

  test('getReliabilityLabel: 49 → "poor"', () => {
    assert.equal(getReliabilityLabel(49), 'poor')
  }),

  test('getReliabilityLabel: 0 → "poor"', () => {
    assert.equal(getReliabilityLabel(0), 'poor')
  }),

  // ── formatReliabilityReport ───────────────────────────────────────────
  test('formatReliabilityReport: contains staff names', () => {
    const report = formatReliabilityReport([
      { staffName: 'Alice', score: 90, label: 'excellent', eventCount: 5 },
    ])
    assert.ok(report.includes('Alice'))
  }),

  test('formatReliabilityReport: contains scores', () => {
    const report = formatReliabilityReport([
      { staffName: 'Bob', score: 75, label: 'good', eventCount: 3 },
    ])
    assert.ok(report.includes('75'))
  }),

  test('formatReliabilityReport: 🟢 for excellent/good', () => {
    const report = formatReliabilityReport([
      { staffName: 'Carol', score: 90, label: 'excellent', eventCount: 4 },
      { staffName: 'Dave', score: 72, label: 'good', eventCount: 2 },
    ])
    assert.ok(report.includes('🟢'))
  }),

  test('formatReliabilityReport: 🟡 for fair', () => {
    const report = formatReliabilityReport([
      { staffName: 'Eve', score: 60, label: 'fair', eventCount: 3 },
    ])
    assert.ok(report.includes('🟡'))
  }),

  test('formatReliabilityReport: 🔴 for poor', () => {
    const report = formatReliabilityReport([
      { staffName: 'Frank', score: 30, label: 'poor', eventCount: 6 },
    ])
    assert.ok(report.includes('🔴'))
  }),

  test('formatReliabilityReport: empty array → graceful empty report', () => {
    const report = formatReliabilityReport([])
    assert.equal(typeof report, 'string')
    assert.ok(report.length > 0)
  }),

  // ── recordEvent wiring ────────────────────────────────────────────────
  test('recordEvent wired: coverage request records "called_out"', async () => {
    const bot = new MockBot()
    const recorded = []
    const db = {
      saveRequest: async () => ({ id: 1, shift_description: 'morning shift' }),
      getGroupMembersWithDm: async () => [],
      saveOutreach: async () => {},
      updateCoverageRequestShift: async () => {},
      getShiftRoster: async () => [],
      getOnCallStaff: async () => [],
      recordEvent: async (staffId, groupId, eventType) => { recorded.push(eventType) },
      // resolveShift dependency: inject pre-resolved shift to avoid LLM call
    }
    const msg = makeGroupMsg({ text: 'can someone cover my shift', userId: 42, chatId: '-1001' })
    const intent = {
      type: 'coverage_request',
      person: 'Alice',
      shift: 'morning shift',
      _preResolvedShift: {
        id: 'shift-1', name: 'Morning', day_of_week: 'Monday',
        start_time: '9am', end_time: '5pm', low_confidence: false,
      },
      _preResolvedWeekStart: '2026-04-07',
    }
    await handleCoverageRequest(bot, msg, intent, db)
    assert.ok(recorded.includes('called_out'), `expected 'called_out' in ${JSON.stringify(recorded)}`)
  }),

  test('recordEvent wired: volunteer records "covered_someone"', async () => {
    const bot = new MockBot()
    const recorded = []
    const db = {
      getOpenRequest: async () => ({
        id: 1, shift_description: 'Morning shift',
        requested_by: 'Bob', matched_shift_id: null, week_start: null,
      }),
      markCovered: async () => ({ id: 1 }),
      recordEvent: async (staffId, groupId, eventType) => { recorded.push(eventType) },
    }
    const msg = makeGroupMsg({ text: 'I can cover', userId: 99, chatId: '-1001' })
    const intent = { type: 'coverage_confirmation', person: 'Alice' }
    await handleCoverageConfirmation(bot, msg, intent, db)
    assert.ok(recorded.includes('covered_someone'), `expected 'covered_someone' in ${JSON.stringify(recorded)}`)
  }),

  test('recordEvent failure does not crash coverage handler', async () => {
    const bot = new MockBot()
    const db = {
      getOpenRequest: async () => ({
        id: 1, shift_description: 'Morning shift',
        requested_by: 'Bob', matched_shift_id: null, week_start: null,
      }),
      markCovered: async () => ({ id: 1 }),
      recordEvent: async () => { throw new Error('DB down') }, // simulate failure
    }
    const msg = makeGroupMsg({ text: 'I can cover', userId: 99, chatId: '-1001' })
    const intent = { type: 'coverage_confirmation', person: 'Alice' }
    // Should not throw even though recordEvent throws
    await assert.doesNotReject(() => handleCoverageConfirmation(bot, msg, intent, db))
    bot.assertSent(String(msg.chat.id), 'Covered') // normal flow completed
  }),
])
