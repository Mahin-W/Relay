import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileWeeklyStats,
  generateNarrativeBriefing,
  formatSundayBriefing,
} from '../../intelligence/narrativeBriefing.js'

// ── Mock DB that returns realistic data ──
function makeMockDb(overrides = {}) {
  return {
    getCoverageStatsForWeek: async () => overrides.coverage ?? {
      total: 3, avgFillMinutes: 45, fastestFillMinutes: 12,
      fullyFilled: 2, partial: 1,
    },
    getLateArrivalsForWeek: async () => overrides.lateArrivals ?? {
      count: 2, totalMinutes: 35, worstOffender: 'Jake',
    },
    getNoShowsForWeek: async () => overrides.noShows ?? { count: 1, names: ['Sam'] },
    getTopReliableStaff: async () => overrides.topReliable ?? [
      { name: 'Maria', score: 95 },
      { name: 'Alex', score: 88 },
    ],
    getUnconfirmedSchedules: async () => overrides.unconfirmed ?? ['Jake', 'Sam'],
    getUnderstaffedShifts: async () => overrides.understaffed ?? [
      { shiftName: 'Dinner', dayOfWeek: 'Friday', scheduledCount: 2, requiredCount: 4 },
    ],
    getOvertimeStaff: async () => overrides.overtime ?? [{ name: 'Maria', hours: 44 }],
    getPayrollTotal: async () => overrides.payrollTotal ?? 8500,
    getLaborPercent: async () => overrides.laborPercent ?? 28.5,
    getMoraleAlertsForWeek: async () => overrides.moraleAlerts ?? [
      { staffName: 'Jake', reasons: ['3 consecutive declines', 'low morale score'] },
    ],
    getTotalShifts: async () => overrides.totalShifts ?? 42,
  }
}

// ── Empty mock DB (all zeros/empty) ──
function makeEmptyDb() {
  return {
    getCoverageStatsForWeek: async () => ({
      total: 0, avgFillMinutes: 0, fastestFillMinutes: 0, fullyFilled: 0, partial: 0,
    }),
    getLateArrivalsForWeek: async () => ({ count: 0, totalMinutes: 0, worstOffender: null }),
    getNoShowsForWeek: async () => ({ count: 0, names: [] }),
    getTopReliableStaff: async () => [],
    getUnconfirmedSchedules: async () => [],
    getUnderstaffedShifts: async () => [],
    getOvertimeStaff: async () => [],
    getPayrollTotal: async () => 0,
    getLaborPercent: async () => null,
    getMoraleAlertsForWeek: async () => [],
    getTotalShifts: async () => 0,
  }
}

await Promise.all([
  // ── compileWeeklyStats ──
  describe('compileWeeklyStats', () => Promise.all([
    test('returns correct coverage count, fill time, unconfirmed, understaffed from mock db', async () => {
      const stats = await compileWeeklyStats('g1', '2026-04-06', makeMockDb())
      assert.equal(stats.weekStart, '2026-04-06')
      assert.equal(stats.totalShifts, 42)
      assert.equal(stats.coverageRequests.total, 3)
      assert.equal(stats.coverageRequests.avgFillMinutes, 45)
      assert.equal(stats.coverageRequests.fastestFillMinutes, 12)
      assert.equal(stats.coverageRequests.fullyFilled, 2)
      assert.equal(stats.coverageRequests.partial, 1)
      assert.equal(stats.lateArrivals.count, 2)
      assert.equal(stats.lateArrivals.worstOffender, 'Jake')
      assert.equal(stats.noShows.count, 1)
      assert.deepEqual(stats.noShows.names, ['Sam'])
      assert.equal(stats.topReliableStaff.length, 2)
      assert.equal(stats.topReliableStaff[0].name, 'Maria')
      assert.deepEqual(stats.unconfirmedSchedules, ['Jake', 'Sam'])
      assert.equal(stats.understaffedShifts.length, 1)
      assert.equal(stats.understaffedShifts[0].shiftName, 'Dinner')
      assert.deepEqual(stats.overtimeStaff, [{ name: 'Maria', hours: 44 }])
      assert.equal(stats.payrollTotal, 8500)
      assert.equal(stats.laborPercent, 28.5)
      assert.equal(stats.moraleAlerts.length, 1)
      assert.equal(stats.moraleAlerts[0].staffName, 'Jake')
    }),

    test('empty week returns zeroed stats, not crash', async () => {
      const stats = await compileWeeklyStats('g1', '2026-04-06', makeEmptyDb())
      assert.equal(stats.totalShifts, 0)
      assert.equal(stats.coverageRequests.total, 0)
      assert.equal(stats.lateArrivals.count, 0)
      assert.equal(stats.noShows.count, 0)
      assert.deepEqual(stats.topReliableStaff, [])
      assert.deepEqual(stats.unconfirmedSchedules, [])
      assert.deepEqual(stats.understaffedShifts, [])
      assert.deepEqual(stats.overtimeStaff, [])
      assert.equal(stats.payrollTotal, 0)
      assert.equal(stats.laborPercent, null)
      assert.deepEqual(stats.moraleAlerts, [])
    }),
  ])),

  // ── formatSundayBriefing ──
  describe('formatSundayBriefing', () => Promise.all([
    test('contains narrative text', () => {
      const result = formatSundayBriefing('Great week overall.', { weekStart: '2026-04-06', unconfirmedSchedules: [], moraleAlerts: [] })
      assert.ok(result.includes('Great week overall.'))
    }),

    test('shows unconfirmed names when present', () => {
      const result = formatSundayBriefing('Solid week.', {
        weekStart: '2026-04-06',
        unconfirmedSchedules: ['Jake', 'Sam'],
        moraleAlerts: [],
      })
      assert.ok(result.includes('Jake'), 'Should include Jake')
      assert.ok(result.includes('Sam'), 'Should include Sam')
      assert.ok(result.includes('unconfirmed'), 'Should mention unconfirmed')
    }),

    test('no unconfirmed section when empty', () => {
      const result = formatSundayBriefing('All good.', {
        weekStart: '2026-04-06',
        unconfirmedSchedules: [],
        moraleAlerts: [],
      })
      assert.ok(!result.includes('unconfirmed'), 'Should not mention unconfirmed')
    }),

    test('shows morale alert when present', () => {
      const result = formatSundayBriefing('Decent week.', {
        weekStart: '2026-04-06',
        unconfirmedSchedules: [],
        moraleAlerts: [{ staffName: 'Jake', reasons: ['3 consecutive declines'] }],
      })
      assert.ok(result.includes('Jake'), 'Should include staff name')
      assert.ok(result.includes('3 consecutive declines'), 'Should include reason')
    }),

    test('has "Have a good week" sign-off', () => {
      const result = formatSundayBriefing('Test.', { weekStart: '2026-04-06', unconfirmedSchedules: [], moraleAlerts: [] })
      assert.ok(result.includes('Have a good week'))
    }),
  ])),

  // ── generateNarrativeBriefing (LLM) ──
  describe('generateNarrativeBriefing (LLM)', { timeout: 30000 }, () => Promise.all([
    test('returns narrative string from stats', async () => {
      const result = await generateNarrativeBriefing('g1', '2026-04-06', makeMockDb())
      assert.ok(result !== null, 'Should not return null for non-empty week')
      assert.equal(typeof result.narrative, 'string')
      assert.ok(result.stats, 'Should include stats')
    }),

    test('narrative has content (length > 20, < 1000)', async () => {
      const result = await generateNarrativeBriefing('g1', '2026-04-06', makeMockDb())
      assert.ok(result.narrative.length > 20, `Narrative too short: ${result.narrative.length}`)
      assert.ok(result.narrative.length < 1000, `Narrative too long: ${result.narrative.length}`)
    }),
  ])),
])
