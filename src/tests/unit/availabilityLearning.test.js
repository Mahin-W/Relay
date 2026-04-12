import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateReliableAvailability,
  applyLearnedAvailability,
  formatAvailabilityInsight,
  formatAvailabilityRiskSection,
  detectStatedVsActualGap,
} from '../../intelligence/availabilityLearning.js'
import {
  saveAvailabilityOutcome,
  getAvailabilityHistory,
} from '../../intelligence/availabilityLearningDb.js'

// ── Mock data (snake_case to match DB column names) ────────────────────────
// Dates are computed relative to "now" so tests work regardless of when they run
function weeksAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n * 7)
  return d.toISOString().split('T')[0]
}

const mockHistory = [
  // Marcus stated available Monday 6 times, worked only 1
  { week_start: weeksAgo(7), day_of_week: 'Monday', stated_available: true, actual_outcome: 'worked' },
  { week_start: weeksAgo(6), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
  { week_start: weeksAgo(5), day_of_week: 'Monday', stated_available: true, actual_outcome: 'time_off' },
  { week_start: weeksAgo(4), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
  { week_start: weeksAgo(3), day_of_week: 'Monday', stated_available: true, actual_outcome: 'time_off' },
  { week_start: weeksAgo(2), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
  // Marcus Friday: 5/5 worked
  { week_start: weeksAgo(7), day_of_week: 'Friday', stated_available: true, actual_outcome: 'worked' },
  { week_start: weeksAgo(6), day_of_week: 'Friday', stated_available: true, actual_outcome: 'worked' },
  { week_start: weeksAgo(5), day_of_week: 'Friday', stated_available: true, actual_outcome: 'worked' },
  { week_start: weeksAgo(4), day_of_week: 'Friday', stated_available: true, actual_outcome: 'worked' },
  { week_start: weeksAgo(3), day_of_week: 'Friday', stated_available: true, actual_outcome: 'worked' },
]

// ── Mock DB builders ────────────────────────────────────────────────────────
// Helper: make an object that is both chainable and thenable (like Supabase PostgREST builder)
function makeThenableChain(resolveWith) {
  const obj = {
    eq: function (col, val) { obj['_' + col] = val; return obj },
    gte: function (col, val) { obj._gte_col = col; obj._gte_val = val; return obj },
    order: function () { return Promise.resolve(resolveWith(obj)) },
    then: function (onFulfilled, onRejected) {
      return Promise.resolve(resolveWith(obj)).then(onFulfilled, onRejected)
    },
  }
  return obj
}

function makeHistoryDb(history) {
  const staffData = [
    { telegram_id: 'marcus_1', name: 'Marcus' },
    { telegram_id: 'reliable_1', name: 'Sarah' },
  ]
  return {
    from: (table) => {
      if (table === 'availability_outcomes') {
        return {
          select: () => makeThenableChain((self) => {
            const gte = self._gte_val
            const rows = history.filter((r) => (!gte || r.week_start >= gte))
            return { data: rows, error: null }
          }),
        }
      }
      if (table === 'staff_members') {
        return {
          select: () => makeThenableChain(() => ({ data: staffData, error: null })),
        }
      }
      return null
    },
  }
}

function makeInsertDb() {
  const inserted = []
  return {
    inserted,
    from: (table) => {
      if (table === 'availability_outcomes') {
        return {
          insert: (rows) => {
            const arr = Array.isArray(rows) ? rows : [rows]
            inserted.push(...arr)
            return Promise.resolve({ data: arr, error: null })
          },
          select: () => makeThenableChain(() => ({ data: inserted, error: null })),
        }
      }
      return null
    },
  }
}

// Mock DB for detectStatedVsActualGap — returns per-staff histories
function makeGapDb(staffHistories) {
  const staffData = Object.entries(staffHistories).map(([id, h]) => ({
    telegram_id: id,
    name: h.name || id,
  }))
  return {
    from: (table) => {
      if (table === 'staff_members') {
        return {
          select: () => makeThenableChain(() => ({ data: staffData, error: null })),
        }
      }
      if (table === 'availability_outcomes') {
        return {
          select: () => makeThenableChain((self) => {
            const sid = self._staff_id
            const entry = staffHistories[sid]
            const history = entry?.records || []
            return { data: history, error: null }
          }),
        }
      }
      return null
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────
await Promise.all([
  // ── calculateReliableAvailability ──────────────────────────────────────
  test('calculateReliableAvailability: Monday rate ~0.17 → avoid', async () => {
    const db = makeHistoryDb(mockHistory)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.equal(result.dayReliability.Monday.status, 'avoid')
    assert.ok(result.dayReliability.Monday.rate < 0.5)
  }),

  test('calculateReliableAvailability: Friday rate 1.0 → reliable', async () => {
    const db = makeHistoryDb(mockHistory)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.equal(result.dayReliability.Friday.status, 'reliable')
    assert.equal(result.dayReliability.Friday.rate, 1.0)
  }),

  test('calculateReliableAvailability: day with 1 occurrence → unknown', async () => {
    const singleOccurrence = [
      { week_start: weeksAgo(2), day_of_week: 'Wednesday', stated_available: true, actual_outcome: 'worked' },
    ]
    const db = makeHistoryDb(singleOccurrence)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.equal(result.dayReliability.Wednesday.status, 'unknown')
  }),

  test('calculateReliableAvailability: mostUnreliableDay is Monday', async () => {
    const db = makeHistoryDb(mockHistory)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.equal(result.mostUnreliableDay, 'Monday')
  }),

  test('calculateReliableAvailability: recent weeks weighted 2x', async () => {
    // Recent = last 3 weeks. If the most recent Monday entry is 'worked',
    // the weighted rate should be higher than raw 1/6
    const recentHistory = [
      { week_start: weeksAgo(7), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
      { week_start: weeksAgo(6), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
      { week_start: weeksAgo(5), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
      // Recent 3 weeks — 2 worked, 1 callout
      { week_start: weeksAgo(3), day_of_week: 'Monday', stated_available: true, actual_outcome: 'worked' },
      { week_start: weeksAgo(2), day_of_week: 'Monday', stated_available: true, actual_outcome: 'worked' },
      { week_start: weeksAgo(1), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
    ]
    const db = makeHistoryDb(recentHistory)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    // Raw: 2/6 = 0.333
    // Weighted: recent worked=2, recent stated=3, older worked=0, older stated=3
    // weighted = (2*2 + 0) / (3*2 + 3) = 4/9 = 0.444
    // Weighted should be higher than raw 0.333
    assert.ok(result.dayReliability.Monday.rate > 0.333, `rate ${result.dayReliability.Monday.rate} should be > 0.333`)
  }),

  test('calculateReliableAvailability: weeksAnalyzed reflects data', async () => {
    const db = makeHistoryDb(mockHistory)
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.ok(result.weeksAnalyzed > 0)
  }),

  test('calculateReliableAvailability: empty history → no crash', async () => {
    const db = makeHistoryDb([])
    const result = await calculateReliableAvailability('marcus_1', 'g1', 8, db)
    assert.ok(result.dayReliability)
    assert.equal(result.mostUnreliableDay, null)
  }),

  // ── applyLearnedAvailability ───────────────────────────────────────────
  test('applyLearnedAvailability: avoid day + >=4 weeks → flagged', () => {
    const assignments = [
      { staffId: 's1', dayOfWeek: 'Monday', shiftId: 'shift1' },
    ]
    const reliabilityMap = new Map([
      ['s1', {
        staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 6,
        dayReliability: {
          Monday: { rate: 0.17, status: 'avoid', statedCount: 6, workedCount: 1 },
        },
      }],
    ])
    const result = applyLearnedAvailability(assignments, reliabilityMap, 4)
    assert.equal(result.risks.length, 1)
    assert.equal(result.risks[0].staffId, 's1')
    assert.equal(result.risks[0].dayOfWeek, 'Monday')
  }),

  test('applyLearnedAvailability: avoid day but <4 weeks → NOT flagged', () => {
    const assignments = [
      { staffId: 's1', dayOfWeek: 'Monday', shiftId: 'shift1' },
    ]
    const reliabilityMap = new Map([
      ['s1', {
        staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 2,
        dayReliability: {
          Monday: { rate: 0.17, status: 'avoid', statedCount: 2, workedCount: 0 },
        },
      }],
    ])
    const result = applyLearnedAvailability(assignments, reliabilityMap, 4)
    assert.equal(result.risks.length, 0)
  }),

  test('applyLearnedAvailability: unreliable day → not flagged', () => {
    const assignments = [
      { staffId: 's1', dayOfWeek: 'Monday', shiftId: 'shift1' },
    ]
    const reliabilityMap = new Map([
      ['s1', {
        staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 6,
        dayReliability: {
          Monday: { rate: 0.6, status: 'unreliable', statedCount: 6, workedCount: 4 },
        },
      }],
    ])
    const result = applyLearnedAvailability(assignments, reliabilityMap, 4)
    assert.equal(result.risks.length, 0)
  }),

  test('applyLearnedAvailability: reliable day → no flag', () => {
    const assignments = [
      { staffId: 's1', dayOfWeek: 'Friday', shiftId: 'shift1' },
    ]
    const reliabilityMap = new Map([
      ['s1', {
        staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 6,
        dayReliability: {
          Friday: { rate: 1.0, status: 'reliable', statedCount: 5, workedCount: 5 },
        },
      }],
    ])
    const result = applyLearnedAvailability(assignments, reliabilityMap, 4)
    assert.equal(result.risks.length, 0)
  }),

  // ── formatAvailabilityInsight ──────────────────────────────────────────
  test('formatAvailabilityInsight: contains staff name', () => {
    const reliability = {
      staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 8,
      dayReliability: {
        Monday: { rate: 0.17, status: 'avoid', statedCount: 6, workedCount: 1 },
        Friday: { rate: 1.0, status: 'reliable', statedCount: 5, workedCount: 5 },
      },
      mostUnreliableDay: 'Monday',
      patternNote: null,
    }
    const text = formatAvailabilityInsight('Marcus', reliability)
    assert.ok(text.includes('Marcus'))
  }),

  test('formatAvailabilityInsight: day-by-day with percentages', () => {
    const reliability = {
      staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 8,
      dayReliability: {
        Monday: { rate: 0.17, status: 'avoid', statedCount: 6, workedCount: 1 },
        Friday: { rate: 1.0, status: 'reliable', statedCount: 5, workedCount: 5 },
      },
      mostUnreliableDay: 'Monday',
      patternNote: null,
    }
    const text = formatAvailabilityInsight('Marcus', reliability)
    assert.ok(text.includes('17%') || text.includes('16%'), 'should show Monday percentage')
    assert.ok(text.includes('100%'), 'should show Friday percentage')
  }),

  test('formatAvailabilityInsight: shows warning and check icons', () => {
    const reliability = {
      staffId: 's1', staffName: 'Marcus', weeksAnalyzed: 8,
      dayReliability: {
        Monday: { rate: 0.17, status: 'avoid', statedCount: 6, workedCount: 1 },
        Friday: { rate: 1.0, status: 'reliable', statedCount: 5, workedCount: 5 },
      },
      mostUnreliableDay: 'Monday',
      patternNote: null,
    }
    const text = formatAvailabilityInsight('Marcus', reliability)
    assert.ok(text.includes('\u2705'), 'should have check mark for reliable')
    assert.ok(text.includes('\u26A0\uFE0F'), 'should have warning for avoid')
  }),

  // ── formatAvailabilityRiskSection ──────────────────────────────────────
  test('formatAvailabilityRiskSection: contains flagged staff and day', () => {
    const risks = [
      { staffId: 's1', staffName: 'Marcus', dayOfWeek: 'Monday', reliabilityRate: 0.17 },
    ]
    const text = formatAvailabilityRiskSection(risks)
    assert.ok(text)
    assert.ok(text.includes('Marcus'))
    assert.ok(text.includes('Monday'))
    assert.ok(text.includes('17%'))
  }),

  test('formatAvailabilityRiskSection: null when no risks', () => {
    const result = formatAvailabilityRiskSection([])
    assert.equal(result, null)
  }),

  // ── detectStatedVsActualGap ────────────────────────────────────────────
  test('detectStatedVsActualGap: returns staff with avoid day', async () => {
    const db = makeGapDb({
      marcus_1: {
        name: 'Marcus',
        records: mockHistory,
      },
    })
    const result = await detectStatedVsActualGap('g1', db)
    assert.ok(result.length > 0)
    assert.ok(result.some((r) => r.staffName === 'Marcus'))
  }),

  test('detectStatedVsActualGap: requires >=4 weeks data', async () => {
    const shortHistory = [
      { week_start: weeksAgo(3), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
      { week_start: weeksAgo(2), day_of_week: 'Monday', stated_available: true, actual_outcome: 'callout' },
    ]
    const db = makeGapDb({
      marcus_1: { name: 'Marcus', records: shortHistory },
    })
    const result = await detectStatedVsActualGap('g1', db)
    assert.equal(result.length, 0)
  }),

  test('detectStatedVsActualGap: empty data → empty array', async () => {
    const db = makeGapDb({})
    const result = await detectStatedVsActualGap('g1', db)
    assert.deepEqual(result, [])
  }),

  // ── saveAvailabilityOutcome / getAvailabilityHistory (MockDB) ─────────
  test('saveAvailabilityOutcome: inserts record', async () => {
    const db = makeInsertDb()
    await saveAvailabilityOutcome('g1', 's1', '2025-02-10', 'Monday', true, 'worked', db)
    assert.equal(db.inserted.length, 1)
    assert.equal(db.inserted[0].day_of_week, 'Monday')
    assert.equal(db.inserted[0].actual_outcome, 'worked')
  }),

  test('saveAvailabilityOutcome: multiple inserts accumulate (never upserts)', async () => {
    const db = makeInsertDb()
    await saveAvailabilityOutcome('g1', 's1', '2025-02-10', 'Monday', true, 'worked', db)
    await saveAvailabilityOutcome('g1', 's1', '2025-02-10', 'Monday', true, 'callout', db)
    assert.equal(db.inserted.length, 2, 'should have 2 records, not upserted')
  }),

  test('getAvailabilityHistory: returns records', async () => {
    const db = makeInsertDb()
    await saveAvailabilityOutcome('g1', 's1', '2025-02-10', 'Monday', true, 'worked', db)
    const history = await getAvailabilityHistory('g1', 's1', 8, db)
    assert.ok(Array.isArray(history))
    assert.ok(history.length > 0)
  }),
])
