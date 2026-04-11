import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateCoverageScore,
  getCoverageResponseStats,
  getTopResponders,
  formatCoverageSpeedNotice,
} from '../../intelligence/coverageSpeed.js'

const mockCoverageHistory = [
  { covered_by: 'Marcus', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:07:00Z' }, // 7min
  { covered_by: 'Marcus', created_at: '2025-01-08T16:00:00Z', covered_at: '2025-01-08T16:05:00Z' }, // 5min
  { covered_by: 'Marcus', created_at: '2025-01-15T16:00:00Z', covered_at: '2025-01-15T16:08:00Z' }, // 8min
  { covered_by: 'Sarah', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:25:00Z' }, // 25min
  { covered_by: 'Sarah', created_at: '2025-01-08T16:00:00Z', covered_at: '2025-01-08T16:20:00Z' }, // 20min
  { covered_by: 'Jake', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:30:00Z' },  // 1 only
]

function makeDb(coverageHistory = [], noShows = []) {
  return {
    getCoveredRequests: async (groupId) => coverageHistory,
    getNoShowAfterConfirm: async (groupId) => noShows,
  }
}

await Promise.all([
  // ── calculateCoverageScore ──
  test('calculateCoverageScore: fast (5min), reliable (100%) → score > 0.8', () => {
    const score = calculateCoverageScore(5, 1.0, 3)
    assert.ok(score > 0.8, `expected > 0.8, got ${score}`)
  }),

  test('calculateCoverageScore: slow (45min), reliable (100%) → score well below fast+reliable', () => {
    const score = calculateCoverageScore(45, 1.0, 3)
    // speedScore = 0.25, score = 0.6 + 0.1 = 0.7
    assert.ok(score < 0.75, `expected < 0.75, got ${score}`)
    assert.ok(score > 0, `expected > 0, got ${score}`)
    // Much lower than fast+reliable
    const fastScore = calculateCoverageScore(5, 1.0, 3)
    assert.ok(score < fastScore, 'slow should score lower than fast')
  }),

  test('calculateCoverageScore: fast but unreliable (50%) → score below reliable', () => {
    const score = calculateCoverageScore(5, 0.5, 3)
    // speedScore = 0.917, score = 0.3 + 0.367 = 0.667
    assert.ok(score < 0.7, `expected < 0.7, got ${score}`)
    const reliableScore = calculateCoverageScore(5, 1.0, 3)
    assert.ok(score < reliableScore, 'unreliable should score lower than reliable')
  }),

  test('calculateCoverageScore: always returns 0-1 range', () => {
    // Extreme values
    assert.ok(calculateCoverageScore(0, 1.0, 100) <= 1.0)
    assert.ok(calculateCoverageScore(0, 1.0, 100) >= 0)
    assert.ok(calculateCoverageScore(999, 0, 0) >= 0)
    assert.ok(calculateCoverageScore(999, 0, 0) <= 1.0)
    // With bonus cap
    const maxScore = calculateCoverageScore(0, 1.0, 10)
    assert.ok(maxScore <= 1.0, `expected <= 1.0, got ${maxScore}`)
  }),

  // ── getCoverageResponseStats ──
  test('getCoverageResponseStats: Marcus 3 coverages avg ~6.67min, ranked first', async () => {
    const db = makeDb(mockCoverageHistory)
    const stats = await getCoverageResponseStats('group1', db)
    assert.ok(stats.length >= 1)
    assert.equal(stats[0].name, 'Marcus')
    // avg of 7, 5, 8 = 6.67
    assert.ok(Math.abs(stats[0].avgResponseMinutes - 6.67) < 0.1)
  }),

  test('getCoverageResponseStats: Sarah ranked below Marcus', async () => {
    const db = makeDb(mockCoverageHistory)
    const stats = await getCoverageResponseStats('group1', db)
    const names = stats.map(s => s.name)
    assert.ok(names.indexOf('Marcus') < names.indexOf('Sarah'))
    // avg of 25, 20 = 22.5
    assert.ok(Math.abs(stats[1].avgResponseMinutes - 22.5) < 0.1)
  }),

  test('getCoverageResponseStats: Jake excluded (only 1 coverage)', async () => {
    const db = makeDb(mockCoverageHistory)
    const stats = await getCoverageResponseStats('group1', db)
    const names = stats.map(s => s.name)
    assert.ok(!names.includes('Jake'))
  }),

  test('getCoverageResponseStats: empty history → empty array', async () => {
    const db = makeDb([])
    const stats = await getCoverageResponseStats('group1', db)
    assert.deepEqual(stats, [])
  }),

  // ── getTopResponders ──
  test('getTopResponders: returns top N (max 3)', async () => {
    const db = makeDb(mockCoverageHistory)
    const top = await getTopResponders('group1', 3, db)
    assert.ok(top.length <= 3)
    assert.equal(top[0].name, 'Marcus')
  }),

  test('getTopResponders: if only 2 qualify → returns 2', async () => {
    const db = makeDb(mockCoverageHistory)
    const top = await getTopResponders('group1', 5, db)
    assert.equal(top.length, 2) // Marcus and Sarah only
  }),

  // ── formatCoverageSpeedNotice ──
  test('formatCoverageSpeedNotice: contains names and avg times', () => {
    const responders = [
      { name: 'Marcus', avgResponseMinutes: 6.67 },
      { name: 'Sarah', avgResponseMinutes: 22.5 },
    ]
    const result = formatCoverageSpeedNotice(responders, 15)
    assert.ok(result !== null)
    assert.ok(result.includes('Marcus'))
    assert.ok(result.includes('Sarah'))
    assert.ok(result.includes('7min') || result.includes('6min') || result.includes('6.67'))
    assert.ok(result.includes('15min') || result.includes('15'))
  }),

  test('formatCoverageSpeedNotice: null when fewer than 2 responders', () => {
    const result = formatCoverageSpeedNotice([{ name: 'Marcus', avgResponseMinutes: 5 }], 10)
    assert.equal(result, null)
  }),

  test('formatCoverageSpeedNotice: null when empty array', () => {
    const result = formatCoverageSpeedNotice([], 10)
    assert.equal(result, null)
  }),
])
