import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateRiskScore,
  calculateHoursVolatility,
  calculateTurnoverRisk,
  generateTurnoverRiskReport,
  formatTurnoverRiskAlert,
  formatTurnoverRiskCommand,
} from '../../intelligence/turnoverRisk.js'
import {
  compileWeeklyStats,
  formatSundayBriefing,
} from '../../intelligence/narrativeBriefing.js'

// ── Signal fixtures ──

const highRiskSignals = {
  moraleScore: 35, moraleTrend: 'declining',
  reliabilityScore: 48,
  recentHoursDrop: true, hoursTrend: 'dropping',
  coverageDeclineRate: 0.67,
  consecutiveDaysMax: 7,
  lateArrivalCount: 3,
  recognitionCount: 0,
  weeksOfData: 6,
}

const lowRiskSignals = {
  moraleScore: 85, moraleTrend: 'improving',
  reliabilityScore: 92,
  recentHoursDrop: false, hoursTrend: 'stable',
  coverageDeclineRate: 0.1,
  consecutiveDaysMax: 3,
  lateArrivalCount: 0,
  recognitionCount: 3,
  weeksOfData: 8,
}

const newStaffSignals = {
  moraleScore: 40, moraleTrend: 'declining',
  reliabilityScore: 50,
  recentHoursDrop: true, hoursTrend: 'dropping',
  coverageDeclineRate: 0.8,
  consecutiveDaysMax: 5,
  lateArrivalCount: 2,
  recognitionCount: 0,
  weeksOfData: 1,
}

// Neutral signals: everything at safe defaults
const neutralSignals = {
  moraleScore: 60, moraleTrend: 'stable',
  reliabilityScore: 70,
  recentHoursDrop: false, hoursTrend: 'stable',
  coverageDeclineRate: 0,
  consecutiveDaysMax: 3,
  lateArrivalCount: 0,
  recognitionCount: 0,
  weeksOfData: 6,
}

// ── Mock DB for hours volatility ──

function makeHoursDb(weeklyHours) {
  // weeklyHours: array of hours, index 0 = most recent week
  const assignments = []
  const now = new Date()
  for (let i = 0; i < weeklyHours.length; i++) {
    const weekStart = new Date(now)
    weekStart.setDate(weekStart.getDate() - (i * 7))
    const ws = weekStart.toISOString().slice(0, 10)
    // Each "hour" = 1 assignment with a shift spanning that many hours
    // We'll represent hours as number of assignments (1 assignment = 1 hour for simplicity)
    for (let h = 0; h < weeklyHours[i]; h++) {
      assignments.push({ staff_id: 's1', group_id: 'g1', week_start: ws, shift_id: `sh${h}` })
    }
  }
  return {
    getScheduleAssignmentsByStaff: async (staffId, groupId) => {
      return assignments.filter(a => a.staff_id === staffId && a.group_id === groupId)
    },
  }
}

// ── Mock DB for full turnover risk ──

function makeFullMockDb({ moraleEvents = [], reliabilityEvents = [], recognitionEvents = [], assignments = [], staff = [] } = {}) {
  return {
    getMoraleEvents: async () => moraleEvents,
    getReliabilityEvents: async () => reliabilityEvents,
    getRecognitionEvents: async () => recognitionEvents,
    getScheduleAssignmentsByStaff: async () => assignments,
    getActiveStaff: async () => staff,
    getReliabilityScores: async () => staff.map(s => ({
      staffId: s.id, staffName: s.name, score: 70, label: 'good', eventCount: 0,
    })),
    getMoraleSnapshot: async () => {
      const grouped = {}
      for (const e of moraleEvents) {
        const sid = e.staff_id ?? 's1'
        if (!grouped[sid]) grouped[sid] = []
        grouped[sid].push(e)
      }
      return grouped
    },
    // narrativeBriefing mock methods
    getCoverageStatsForWeek: async () => ({ total: 0, avgFillMinutes: 0, fastestFillMinutes: 0, fullyFilled: 0, partial: 0 }),
    getLateArrivalsForWeek: async () => ({ count: 0, totalMinutes: 0, worstOffender: null }),
    getNoShowsForWeek: async () => ({ count: 0, names: [] }),
    getTopReliableStaff: async () => [],
    getUnconfirmedSchedules: async () => [],
    getUnderstaffedShifts: async () => [],
    getOvertimeStaff: async () => [],
    getPayrollTotal: async () => 0,
    getLaborPercent: async () => null,
    getMoraleAlertsForWeek: async () => [],
    getTotalShifts: async () => 10,
  }
}

await Promise.all([
  // ── calculateRiskScore ──────────────────────────────────────────────
  describe('calculateRiskScore', { concurrency: true }, () => Promise.all([
    test('high risk signals produce score > 70 (critical)', () => {
      const result = calculateRiskScore(highRiskSignals)
      assert.ok(result.score > 70, `Expected score > 70, got ${result.score}`)
    }),

    test('low risk signals produce score < 30 (low)', () => {
      const result = calculateRiskScore(lowRiskSignals)
      assert.ok(result.score < 30, `Expected score < 30, got ${result.score}`)
    }),

    test('new staff signals capped at 30 (weeksOfData < 2)', () => {
      const result = calculateRiskScore(newStaffSignals)
      assert.ok(result.score <= 30, `Expected score <= 30, got ${result.score}`)
    }),

    test('only moraleScore < 40 (rest neutral) produces score = 20', () => {
      const signals = { ...neutralSignals, moraleScore: 35 }
      const result = calculateRiskScore(signals)
      assert.equal(result.score, 20)
    }),

    test('recognitionCount >= 2 reduces score by 10', () => {
      const withoutRecognition = calculateRiskScore({ ...neutralSignals, moraleScore: 35, recognitionCount: 0 })
      const withRecognition = calculateRiskScore({ ...neutralSignals, moraleScore: 35, recognitionCount: 2 })
      assert.equal(withoutRecognition.score - withRecognition.score, 10)
    }),

    test('score always clamped 0-100', () => {
      // Extreme high risk
      const extreme = calculateRiskScore({
        moraleScore: 10, moraleTrend: 'declining',
        reliabilityScore: 10,
        recentHoursDrop: true, hoursTrend: 'dropping',
        coverageDeclineRate: 0.9,
        consecutiveDaysMax: 10,
        lateArrivalCount: 5,
        recognitionCount: 0,
        weeksOfData: 10,
      })
      assert.ok(extreme.score <= 100, `Score ${extreme.score} exceeds 100`)
      assert.ok(extreme.score >= 0, `Score ${extreme.score} below 0`)

      // Extreme low risk
      const safe = calculateRiskScore({
        moraleScore: 95, moraleTrend: 'improving',
        reliabilityScore: 99,
        recentHoursDrop: false, hoursTrend: 'stable',
        coverageDeclineRate: 0,
        consecutiveDaysMax: 1,
        lateArrivalCount: 0,
        recognitionCount: 10,
        weeksOfData: 20,
      })
      assert.ok(safe.score >= 0, `Score ${safe.score} below 0`)
      assert.ok(safe.score <= 100, `Score ${safe.score} exceeds 100`)
    }),

    test('factors array non-empty for non-low scores', () => {
      const result = calculateRiskScore(highRiskSignals)
      assert.ok(result.factors.length > 0, 'Expected non-empty factors')
      assert.ok(result.factors.every(f => typeof f === 'string'), 'All factors should be strings')
    }),

    test('factors array can be empty for very low scores', () => {
      const result = calculateRiskScore(lowRiskSignals)
      // Low risk has negative factors, so the array describes subtractions
      assert.ok(Array.isArray(result.factors), 'factors should be an array')
    }),

    test('else-if: moraleScore < 40 gets +20, not +20 and +10', () => {
      const at35 = calculateRiskScore({ ...neutralSignals, moraleScore: 35 })
      const at55 = calculateRiskScore({ ...neutralSignals, moraleScore: 55 })
      // at35 should get +20, at55 should get +10
      assert.equal(at35.score, 20)
      assert.equal(at55.score, 10)
    }),

    test('else-if: reliabilityScore < 50 gets +15, not both +15 and +10', () => {
      const at45 = calculateRiskScore({ ...neutralSignals, reliabilityScore: 45 })
      const at65 = calculateRiskScore({ ...neutralSignals, reliabilityScore: 65 })
      assert.equal(at45.score, 15)
      assert.equal(at65.score, 10)
    }),
  ])),

  // ── calculateHoursVolatility ────────────────────────────────────────
  describe('calculateHoursVolatility', { concurrency: true }, () => Promise.all([
    test('dropping hours detected: [10,12,35,38,42,40]', async () => {
      const db = makeHoursDb([10, 12, 35, 38, 42, 40])
      const result = await calculateHoursVolatility('s1', 'g1', 6, db)
      assert.equal(result.recentDrop, true)
      assert.equal(result.trend, 'dropping')
    }),

    test('stable hours: [38,40,42,39,41,38]', async () => {
      const db = makeHoursDb([38, 40, 42, 39, 41, 38])
      const result = await calculateHoursVolatility('s1', 'g1', 6, db)
      assert.equal(result.recentDrop, false)
      assert.equal(result.trend, 'stable')
    }),

    test('empty history returns safe defaults', async () => {
      const db = makeHoursDb([])
      const result = await calculateHoursVolatility('s1', 'g1', 6, db)
      assert.equal(result.avgHours, 0)
      assert.equal(result.recentAvg, 0)
      assert.equal(result.priorAvg, 0)
      assert.equal(result.recentDrop, false)
      assert.equal(result.trend, 'stable')
    }),
  ])),

  // ── calculateTurnoverRisk ───────────────────────────────────────────
  describe('calculateTurnoverRisk', { concurrency: true }, () => Promise.all([
    test('high signals produce critical risk level with recommendation', async () => {
      // Build week_start values spanning 6+ weeks for weeksOfData
      const weeks = []
      const now = new Date()
      for (let i = 0; i < 6; i++) {
        const d = new Date(now)
        d.setDate(d.getDate() - i * 7)
        weeks.push(d.toISOString().slice(0, 10))
      }
      const moraleEvents = [
        { type: 'coverage_decline', created_at: now.toISOString(), week_start: weeks[0], staff_id: 's1' },
        { type: 'coverage_decline', created_at: now.toISOString(), week_start: weeks[1], staff_id: 's1' },
        { type: 'coverage_accept', created_at: now.toISOString(), week_start: weeks[2], staff_id: 's1' },
        { type: 'coverage_decline', created_at: now.toISOString(), week_start: weeks[3], staff_id: 's1' },
        { type: 'no_response', created_at: now.toISOString(), week_start: weeks[4], staff_id: 's1' },
        { type: 'no_response', created_at: now.toISOString(), week_start: weeks[5], staff_id: 's1' },
      ]
      const db = makeFullMockDb({
        moraleEvents,
        reliabilityEvents: [
          { event_type: 'late_arrival', recorded_at: now.toISOString() },
          { event_type: 'late_arrival', recorded_at: now.toISOString() },
          { event_type: 'late_arrival', recorded_at: now.toISOString() },
        ],
        assignments: [],
      })
      const result = await calculateTurnoverRisk('s1', 'Jake', 'g1', 35, 'declining', 48, db)
      assert.ok(['high', 'critical'].includes(result.riskLevel), `Expected high/critical, got ${result.riskLevel}`)
      assert.ok(result.recommendation !== null, 'High risk should have recommendation')
      assert.equal(result.staffName, 'Jake')
    }),

    test('low signals produce low risk level with null recommendation', async () => {
      const db = makeFullMockDb()
      const result = await calculateTurnoverRisk('s1', 'Maria', 'g1', 85, 'improving', 92, db)
      assert.equal(result.riskLevel, 'low')
      assert.equal(result.recommendation, null)
    }),

    test('new staff (1 week data) capped at medium even with bad signals', async () => {
      const oneWeekAgo = new Date()
      const db = makeFullMockDb({
        moraleEvents: [
          { type: 'coverage_decline', created_at: oneWeekAgo.toISOString(), week_start: oneWeekAgo.toISOString().slice(0, 10), staff_id: 's1' },
        ],
        reliabilityEvents: [
          { event_type: 'late_arrival', recorded_at: oneWeekAgo.toISOString() },
          { event_type: 'late_arrival', recorded_at: oneWeekAgo.toISOString() },
        ],
      })
      const result = await calculateTurnoverRisk('s1', 'Newbie', 'g1', 40, 'declining', 50, db)
      assert.ok(['low', 'medium'].includes(result.riskLevel), `Expected max medium for new staff, got ${result.riskLevel}`)
      assert.ok(result.score <= 30, `New staff score should be capped at 30, got ${result.score}`)
    }),
  ])),

  // ── generateTurnoverRiskReport ──────────────────────────────────────
  describe('generateTurnoverRiskReport', { concurrency: true }, () => Promise.all([
    test('groups staff by riskLevel correctly', async () => {
      const db = makeFullMockDb({
        staff: [
          { id: 's1', name: 'Jake', group_id: 'g1', active: true },
          { id: 's2', name: 'Maria', group_id: 'g1', active: true },
        ],
      })
      const report = await generateTurnoverRiskReport('g1', db)
      assert.ok('critical' in report)
      assert.ok('high' in report)
      assert.ok('medium' in report)
      assert.ok('low' in report)
    }),

    test('teamRiskAverage calculated', async () => {
      const db = makeFullMockDb({
        staff: [
          { id: 's1', name: 'Jake', group_id: 'g1', active: true },
        ],
      })
      const report = await generateTurnoverRiskReport('g1', db)
      assert.equal(typeof report.teamRiskAverage, 'number')
      assert.ok(report.teamRiskAverage >= 0 && report.teamRiskAverage <= 100)
    }),

    test('staffCount is correct', async () => {
      const db = makeFullMockDb({
        staff: [
          { id: 's1', name: 'A', group_id: 'g1', active: true },
          { id: 's2', name: 'B', group_id: 'g1', active: true },
          { id: 's3', name: 'C', group_id: 'g1', active: true },
        ],
      })
      const report = await generateTurnoverRiskReport('g1', db)
      assert.equal(report.staffCount, 3)
    }),

    test('empty staff list is graceful', async () => {
      const db = makeFullMockDb({ staff: [] })
      const report = await generateTurnoverRiskReport('g1', db)
      assert.equal(report.staffCount, 0)
      assert.equal(report.teamRiskAverage, 0)
      assert.deepEqual(report.critical, [])
      assert.deepEqual(report.high, [])
      assert.deepEqual(report.medium, [])
      assert.deepEqual(report.low, [])
    }),
  ])),

  // ── formatTurnoverRiskAlert ─────────────────────────────────────────
  describe('formatTurnoverRiskAlert', { concurrency: true }, () => Promise.all([
    test('returns null when no medium+ risks', () => {
      const report = { critical: [], high: [], medium: [], low: [{ staffName: 'Maria' }], teamRiskAverage: 10, staffCount: 1 }
      assert.equal(formatTurnoverRiskAlert(report), null)
    }),

    test('contains staff names for flagged staff', () => {
      const report = {
        critical: [{ staffName: 'Jake', factors: ['Low morale'], recommendation: 'Urgent check-in recommended' }],
        high: [],
        medium: [{ staffName: 'Sam', factors: ['Hours dropping'], recommendation: 'Worth keeping an eye on' }],
        low: [],
        teamRiskAverage: 55,
        staffCount: 3,
      }
      const alert = formatTurnoverRiskAlert(report)
      assert.ok(alert.includes('Jake'))
      assert.ok(alert.includes('Sam'))
    }),

    test('contains top factor for flagged staff', () => {
      const report = {
        critical: [{ staffName: 'Jake', factors: ['Low morale score'], recommendation: 'Urgent check-in recommended' }],
        high: [], medium: [], low: [],
        teamRiskAverage: 60, staffCount: 1,
      }
      const alert = formatTurnoverRiskAlert(report)
      assert.ok(alert.includes('Low morale score'), 'Should include the top factor')
    }),

    test('privacy note present', () => {
      const report = {
        critical: [{ staffName: 'Jake', factors: ['Low morale'], recommendation: 'Urgent check-in recommended' }],
        high: [], medium: [], low: [],
        teamRiskAverage: 60, staffCount: 1,
      }
      const alert = formatTurnoverRiskAlert(report)
      assert.ok(alert.includes('not visible to staff') || alert.includes('private'), 'Should have privacy note')
    }),

    test('uses red circle for critical, yellow for medium/high', () => {
      const report = {
        critical: [{ staffName: 'Jake', factors: ['Critical issue'], recommendation: 'Urgent' }],
        high: [{ staffName: 'Sam', factors: ['High issue'], recommendation: 'Consider 1:1' }],
        medium: [{ staffName: 'Alex', factors: ['Medium issue'], recommendation: 'Watch' }],
        low: [],
        teamRiskAverage: 50, staffCount: 3,
      }
      const alert = formatTurnoverRiskAlert(report)
      assert.ok(alert.includes('\u{1F534}'), 'Should have red circle for critical')
      assert.ok(alert.includes('\u{1F7E1}'), 'Should have yellow circle for medium/high')
    }),
  ])),

  // ── formatTurnoverRiskCommand ───────────────────────────────────────
  describe('formatTurnoverRiskCommand', { concurrency: true }, () => Promise.all([
    test('contains all staff including low', () => {
      const report = {
        critical: [],
        high: [{ staffName: 'Sam', score: 55, factors: ['Hours dropping'], recommendation: 'Consider 1:1' }],
        medium: [],
        low: [{ staffName: 'Maria', score: 15, factors: [], recommendation: null }],
        teamRiskAverage: 35, staffCount: 2,
      }
      const output = formatTurnoverRiskCommand(report)
      assert.ok(output.includes('Sam'))
      assert.ok(output.includes('Maria'))
    }),

    test('shows per-factor detail for high/critical', () => {
      const report = {
        critical: [{ staffName: 'Jake', score: 80, factors: ['Low morale', 'Hours dropping'], recommendation: 'Urgent' }],
        high: [], medium: [], low: [],
        teamRiskAverage: 80, staffCount: 1,
      }
      const output = formatTurnoverRiskCommand(report)
      assert.ok(output.includes('Low morale'))
      assert.ok(output.includes('Hours dropping'))
    }),

    test('internal disclaimer present', () => {
      const report = {
        critical: [], high: [], medium: [], low: [],
        teamRiskAverage: 20, staffCount: 0,
      }
      const output = formatTurnoverRiskCommand(report)
      assert.ok(
        output.toLowerCase().includes('internal') || output.toLowerCase().includes('not shared'),
        'Should have internal disclaimer'
      )
    }),
  ])),

  // ── narrativeBriefing modification ──────────────────────────────────
  describe('narrativeBriefing turnover risk integration', { concurrency: true }, () => Promise.all([
    test('compileWeeklyStats includes turnoverRisk field', async () => {
      const db = makeFullMockDb({
        staff: [{ id: 's1', name: 'Jake', group_id: 'g1', active: true }],
      })
      const stats = await compileWeeklyStats('g1', '2026-04-06', db)
      assert.ok('turnoverRisk' in stats, 'stats should have turnoverRisk field')
    }),

    test('formatSundayBriefing includes alert when risks exist', () => {
      const stats = {
        weekStart: '2026-04-06',
        unconfirmedSchedules: [],
        moraleAlerts: [],
        turnoverRisk: {
          critical: [{ staffName: 'Jake', factors: ['Low morale'], recommendation: 'Urgent check-in recommended' }],
          high: [], medium: [], low: [],
          teamRiskAverage: 60, staffCount: 1,
        },
      }
      const result = formatSundayBriefing('Good week.', stats)
      assert.ok(result.includes('Jake'), 'Should include at-risk staff name')
      assert.ok(result.includes('retention') || result.includes('Staff retention'), 'Should mention retention')
    }),

    test('alert absent when no medium+ risks', () => {
      const stats = {
        weekStart: '2026-04-06',
        unconfirmedSchedules: [],
        moraleAlerts: [],
        turnoverRisk: {
          critical: [], high: [], medium: [], low: [{ staffName: 'Maria' }],
          teamRiskAverage: 10, staffCount: 1,
        },
      }
      const result = formatSundayBriefing('Good week.', stats)
      assert.ok(!result.includes('retention'), 'Should not have retention alert for low-only risks')
    }),
  ])),
])
