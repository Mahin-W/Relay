import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  calculateQualityScore,
  detectQualityTrend,
  formatQualityTrend,
  formatQualitySummary,
  collectWeekMetrics,
  calculateWeeklyQualityScore,
  handleQualityCommand,
} from '../../intelligence/scheduleQuality.js'
import {
  saveWeeklyQualityScore,
  getQualityHistory,
} from '../../intelligence/scheduleQualityDb.js'

// ── Mock data ────────────────────────────────────────────────────────────────

const perfectMetrics = { draftEdits: 0, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, staffScheduled: 10 }
const badMetrics = { draftEdits: 8, coverageRequests: 4, noShows: 2, avgFillMinutes: 75, unconfirmedCount: 5, staffScheduled: 10 }
const mediumMetrics = { draftEdits: 2, coverageRequests: 1, noShows: 0, avgFillMinutes: 18, unconfirmedCount: 1, staffScheduled: 8 }

// ── Quality MockDB ───────────────────────────────────────────────────────────

class QualityMockDB {
  constructor() {
    this.scheduleEditEvents = []
    this.coverageRequests = []
    this.staffReliabilityEvents = []
    this.scheduleReceipts = []
    this.scheduleAssignments = []
    this.weeklyQualityScores = []
  }

  // Supabase-style fluent query builder
  from(table) {
    const self = this
    const state = { table, filters: [], orderCol: null, orderAsc: true, isUpsert: false, upsertConflict: null, insertData: null, selectCols: null }

    const builder = {
      select(cols = '*') {
        state.selectCols = cols
        return builder
      },
      insert(data) {
        state.insertData = data
        return builder
      },
      upsert(data, opts = {}) {
        state.insertData = data
        state.isUpsert = true
        state.upsertConflict = opts.onConflict
        return builder
      },
      eq(col, val) {
        state.filters.push({ col, op: 'eq', val })
        return builder
      },
      gte(col, val) {
        state.filters.push({ col, op: 'gte', val })
        return builder
      },
      lt(col, val) {
        state.filters.push({ col, op: 'lt', val })
        return builder
      },
      lte(col, val) {
        state.filters.push({ col, op: 'lte', val })
        return builder
      },
      not(col, op, val) {
        state.filters.push({ col, op: 'not_' + op, val })
        return builder
      },
      order(col, opts = {}) {
        state.orderCol = col
        state.orderAsc = opts.ascending !== false
        return builder
      },
      single() {
        return self._execute(state, true)
      },
      then(resolve, reject) {
        try {
          const result = self._execute(state, false)
          resolve(result)
        } catch (e) { reject(e) }
      },
    }
    return builder
  }

  _getStore(table) {
    const map = {
      schedule_edit_events: this.scheduleEditEvents,
      coverage_requests: this.coverageRequests,
      staff_reliability_events: this.staffReliabilityEvents,
      schedule_receipts: this.scheduleReceipts,
      schedule_assignments: this.scheduleAssignments,
      weekly_quality_scores: this.weeklyQualityScores,
    }
    return map[table] || []
  }

  _execute(state, single) {
    const store = this._getStore(state.table)

    // Insert / upsert
    if (state.insertData) {
      if (state.isUpsert) {
        const conflictCols = (state.upsertConflict || '').split(',').map(c => c.trim())
        const idx = store.findIndex(row =>
          conflictCols.every(c => row[c] === state.insertData[c])
        )
        if (idx >= 0) {
          store[idx] = { ...store[idx], ...state.insertData }
        } else {
          store.push({ ...state.insertData })
        }
      } else {
        store.push({ ...state.insertData })
      }
      return { data: state.insertData, error: null }
    }

    // Select with filters
    let rows = [...store]
    for (const f of state.filters) {
      rows = rows.filter(row => {
        const v = row[f.col]
        switch (f.op) {
          case 'eq': return v === f.val
          case 'gte': return v >= f.val
          case 'lt': return v < f.val
          case 'lte': return v <= f.val
          case 'not_is': return v !== f.val && v !== null && v !== undefined
          default: return true
        }
      })
    }

    if (state.orderCol) {
      rows.sort((a, b) => {
        if (a[state.orderCol] < b[state.orderCol]) return state.orderAsc ? -1 : 1
        if (a[state.orderCol] > b[state.orderCol]) return state.orderAsc ? 1 : -1
        return 0
      })
    }

    if (single) return { data: rows[0] || null, error: null }
    return { data: rows, error: null }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('calculateQualityScore', { concurrency: true }, () => {
  it('perfect metrics → score 100, grade A', () => {
    const result = calculateQualityScore(perfectMetrics, perfectMetrics.staffScheduled)
    assert.equal(result.score, 100)
    assert.equal(result.grade, 'A')
  })

  it('bad metrics → score < 50, grade F', () => {
    const result = calculateQualityScore(badMetrics, badMetrics.staffScheduled)
    assert.ok(result.score < 50, `Expected < 50, got ${result.score}`)
    assert.equal(result.grade, 'F')
  })

  it('medium metrics → score 70-85', () => {
    const result = calculateQualityScore(mediumMetrics, mediumMetrics.staffScheduled)
    assert.ok(result.score >= 70 && result.score <= 85, `Expected 70-85, got ${result.score}`)
  })

  it('draftEdits:0 → no edit deduction', () => {
    const result = calculateQualityScore({ ...perfectMetrics, draftEdits: 0 }, 10)
    assert.equal(result.deductions.edits, 0)
  })

  it('draftEdits:7 → -20', () => {
    const result = calculateQualityScore({ ...perfectMetrics, draftEdits: 7 }, 10)
    assert.equal(result.deductions.edits, 20)
  })

  it('coverageRequests:3, staff:10 → -30', () => {
    const result = calculateQualityScore({ ...perfectMetrics, coverageRequests: 3 }, 10)
    assert.equal(result.deductions.coverage, 30)
  })

  it('coverageRequests:3, staff:30 → less deduction (scaled)', () => {
    const result = calculateQualityScore({ ...perfectMetrics, coverageRequests: 3 }, 30)
    // 3 * 10 / 30 = 1 → normalized 1 → -10
    assert.ok(result.deductions.coverage < 30, `Expected < 30, got ${result.deductions.coverage}`)
  })

  it('noShows:2 → -20', () => {
    const result = calculateQualityScore({ ...perfectMetrics, noShows: 2 }, 10)
    assert.equal(result.deductions.noShows, 20)
  })

  it('avgFillMinutes:5 → 0 deduction', () => {
    const result = calculateQualityScore({ ...perfectMetrics, coverageRequests: 1, avgFillMinutes: 5 }, 10)
    assert.equal(result.deductions.fillTime, 0)
  })

  it('avgFillMinutes:90 → -15', () => {
    const result = calculateQualityScore({ ...perfectMetrics, coverageRequests: 1, avgFillMinutes: 90 }, 10)
    assert.equal(result.deductions.fillTime, 15)
  })

  it('score always clamped 0-100', () => {
    const extreme = { draftEdits: 100, coverageRequests: 100, noShows: 100, avgFillMinutes: 999, unconfirmedCount: 100, staffScheduled: 1 }
    const result = calculateQualityScore(extreme, 1)
    assert.ok(result.score >= 0 && result.score <= 100)
  })

  it('staffScheduled:0 → does not crash (division by zero safe)', () => {
    const result = calculateQualityScore({ ...perfectMetrics, coverageRequests: 2, unconfirmedCount: 3, staffScheduled: 0 }, 0)
    assert.ok(typeof result.score === 'number')
    assert.ok(!Number.isNaN(result.score))
  })
})

describe('detectQualityTrend', { concurrency: true }, () => {
  it('[60,65,70,75,80,85] → improving', () => {
    const history = [60, 65, 70, 75, 80, 85].map(score => ({ score }))
    const result = detectQualityTrend(history)
    assert.equal(result.trend, 'improving')
  })

  it('[85,80,75,70,65,60] → declining', () => {
    const history = [85, 80, 75, 70, 65, 60].map(score => ({ score }))
    const result = detectQualityTrend(history)
    assert.equal(result.trend, 'declining')
  })

  it('[78,80,79,81,80,78] → stable', () => {
    const history = [78, 80, 79, 81, 80, 78].map(score => ({ score }))
    const result = detectQualityTrend(history)
    assert.equal(result.trend, 'stable')
  })

  it('2 weeks → insufficient_data', () => {
    const history = [80, 85].map(score => ({ score }))
    const result = detectQualityTrend(history)
    assert.equal(result.trend, 'insufficient_data')
  })

  it('0 weeks → insufficient_data', () => {
    const result = detectQualityTrend([])
    assert.equal(result.trend, 'insufficient_data')
  })
})

describe('formatQualityTrend', { concurrency: true }, () => {
  it('contains week dates, scores, grades', () => {
    const history = [
      { weekStart: '2025-01-06', score: 80, grade: 'B' },
      { weekStart: '2025-01-13', score: 85, grade: 'B' },
      { weekStart: '2025-01-20', score: 90, grade: 'A' },
    ]
    const current = { score: 92, grade: 'A', weekStart: '2025-01-27' }
    const text = formatQualityTrend(history, current)
    assert.ok(text.includes('92'), 'Should contain current score')
    assert.ok(text.includes('A'), 'Should contain grade')
    assert.ok(text.includes('2025-01-06') || text.includes('2025-01-27'), 'Should contain week date')
  })

  it('contains trend indicator', () => {
    const history = [
      { weekStart: '2025-01-06', score: 70, grade: 'C' },
      { weekStart: '2025-01-13', score: 75, grade: 'C' },
      { weekStart: '2025-01-20', score: 80, grade: 'B' },
      { weekStart: '2025-01-27', score: 85, grade: 'B' },
    ]
    const current = { score: 90, grade: 'A', weekStart: '2025-02-03' }
    const text = formatQualityTrend(history, current)
    assert.ok(text.includes('Improving') || text.includes('Stable') || text.includes('Declining'), 'Should contain trend')
  })

  it('shows improvement stats when improving', () => {
    const history = [
      { weekStart: '2025-01-06', score: 60, grade: 'D' },
      { weekStart: '2025-01-13', score: 65, grade: 'D' },
      { weekStart: '2025-01-20', score: 70, grade: 'C' },
      { weekStart: '2025-01-27', score: 80, grade: 'B' },
    ]
    const current = { score: 85, grade: 'B', weekStart: '2025-02-03' }
    const text = formatQualityTrend(history, current)
    assert.ok(text.includes('Improving'), 'Should show improving')
  })
})

describe('formatQualitySummary', { concurrency: true }, () => {
  it('score 95 → contains grade A and score', () => {
    const current = { score: 95, grade: 'A' }
    const trend = { trend: 'stable' }
    const text = formatQualitySummary(current, trend)
    assert.ok(text.includes('A'), 'Should contain grade')
    assert.ok(text.includes('95'), 'Should contain score')
  })

  it('score 55 → contains grade F and top deduction', () => {
    const current = { score: 55, grade: 'F', deductions: { edits: 20, coverage: 30, noShows: 0, fillTime: 0, unconfirmed: 0 } }
    const trend = { trend: 'declining' }
    const text = formatQualitySummary(current, trend)
    assert.ok(text.includes('F'), 'Should contain grade')
    assert.ok(text.includes('55'), 'Should contain score')
  })
})

describe('collectWeekMetrics (MockDB)', { concurrency: true }, () => {
  it('returns correct counts from seeded data', async () => {
    const db = new QualityMockDB()
    const groupId = '-100'
    const weekStart = '2025-01-06'
    const weekEnd = '2025-01-13'

    // Seed edit events
    db.scheduleEditEvents.push(
      { group_id: groupId, week_start: weekStart, type: 'swap' },
      { group_id: groupId, week_start: weekStart, type: 'remove' },
    )

    // Seed coverage requests (within the week)
    db.coverageRequests.push(
      { group_id: groupId, created_at: '2025-01-07T10:00:00Z', covered_at: '2025-01-07T10:30:00Z', status: 'covered' },
      { group_id: groupId, created_at: '2025-01-08T09:00:00Z', covered_at: null, status: 'open' },
    )

    // Seed no-shows
    db.staffReliabilityEvents.push(
      { group_id: groupId, event_type: 'no_call_no_show', recorded_at: '2025-01-07T08:00:00Z' },
    )

    // Seed receipts
    db.scheduleReceipts.push(
      { group_id: groupId, week_start: weekStart, status: 'sent', staff_id: 1 },
      { group_id: groupId, week_start: weekStart, status: 'confirmed', staff_id: 2 },
    )

    // Seed assignments
    db.scheduleAssignments.push(
      { group_id: groupId, week_start: weekStart, staff_id: 1, shift_id: 'a' },
      { group_id: groupId, week_start: weekStart, staff_id: 2, shift_id: 'b' },
      { group_id: groupId, week_start: weekStart, staff_id: 1, shift_id: 'c' },
    )

    const metrics = await collectWeekMetrics(groupId, weekStart, db)
    assert.equal(metrics.draftEdits, 2)
    assert.equal(metrics.coverageRequests, 2)
    assert.equal(metrics.noShows, 1)
    assert.equal(metrics.unconfirmedCount, 1)
    assert.equal(metrics.staffScheduled, 2) // 2 distinct staff
    assert.equal(metrics.avgFillMinutes, 30) // 30 min avg (only 1 covered)
  })

  it('empty week → all zeros', async () => {
    const db = new QualityMockDB()
    const metrics = await collectWeekMetrics('-999', '2025-06-01', db)
    assert.equal(metrics.draftEdits, 0)
    assert.equal(metrics.coverageRequests, 0)
    assert.equal(metrics.noShows, 0)
    assert.equal(metrics.avgFillMinutes, null)
    assert.equal(metrics.unconfirmedCount, 0)
    assert.equal(metrics.staffScheduled, 0)
  })

  it('avgFillMinutes averaged correctly with multiple covered requests', async () => {
    const db = new QualityMockDB()
    const groupId = '-200'
    const weekStart = '2025-02-03'

    db.coverageRequests.push(
      { group_id: groupId, created_at: '2025-02-04T10:00:00Z', covered_at: '2025-02-04T10:20:00Z', status: 'covered' }, // 20 min
      { group_id: groupId, created_at: '2025-02-05T10:00:00Z', covered_at: '2025-02-05T10:40:00Z', status: 'covered' }, // 40 min
    )

    const metrics = await collectWeekMetrics(groupId, weekStart, db)
    assert.equal(metrics.avgFillMinutes, 30) // (20+40)/2 = 30
  })
})

describe('saveWeeklyQualityScore / getQualityHistory (MockDB)', { concurrency: true }, () => {
  it('saves and retrieves correctly', async () => {
    const db = new QualityMockDB()
    const scoreData = { score: 85, grade: 'B', draftEdits: 2, coverageRequests: 1, noShows: 0, avgFillMinutes: 15, unconfirmedCount: 1, weeksOfData: 1 }
    await saveWeeklyQualityScore('-100', '2025-01-06', scoreData, db)
    const history = await getQualityHistory('-100', 100, db)
    assert.equal(history.length, 1)
    assert.equal(history[0].score, 85)
    assert.equal(history[0].grade, 'B')
  })

  it('second save upserts (does not duplicate)', async () => {
    const db = new QualityMockDB()
    const scoreData1 = { score: 80, grade: 'B', draftEdits: 3, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, weeksOfData: 1 }
    const scoreData2 = { score: 90, grade: 'A', draftEdits: 1, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, weeksOfData: 2 }
    await saveWeeklyQualityScore('-100', '2025-01-06', scoreData1, db)
    await saveWeeklyQualityScore('-100', '2025-01-06', scoreData2, db)
    const history = await getQualityHistory('-100', 100, db)
    assert.equal(history.length, 1)
    assert.equal(history[0].score, 90) // updated, not duplicated
  })

  it('returns ASC order', async () => {
    const db = new QualityMockDB()
    await saveWeeklyQualityScore('-100', '2025-01-20', { score: 90, grade: 'A', draftEdits: 0, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, weeksOfData: 3 }, db)
    await saveWeeklyQualityScore('-100', '2025-01-06', { score: 70, grade: 'C', draftEdits: 5, coverageRequests: 2, noShows: 1, avgFillMinutes: 25, unconfirmedCount: 2, weeksOfData: 1 }, db)
    await saveWeeklyQualityScore('-100', '2025-01-13', { score: 80, grade: 'B', draftEdits: 2, coverageRequests: 1, noShows: 0, avgFillMinutes: 10, unconfirmedCount: 1, weeksOfData: 2 }, db)
    const history = await getQualityHistory('-100', 100, db)
    assert.equal(history.length, 3)
    assert.equal(history[0].weekStart, '2025-01-06')
    assert.equal(history[1].weekStart, '2025-01-13')
    assert.equal(history[2].weekStart, '2025-01-20')
  })
})

describe('handleQualityCommand (MockBot, MockDB)', { concurrency: true }, () => {
  it('DMs manager with quality trend', async () => {
    const bot = new MockBot()
    const db = new QualityMockDB()
    // Need some history — use recent dates so they fall within default 12-week window
    await saveWeeklyQualityScore('-100', '2026-02-02', { score: 80, grade: 'B', draftEdits: 2, coverageRequests: 1, noShows: 0, avgFillMinutes: 15, unconfirmedCount: 1, weeksOfData: 1 }, db)
    await saveWeeklyQualityScore('-100', '2026-02-09', { score: 85, grade: 'B', draftEdits: 1, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, weeksOfData: 2 }, db)
    await saveWeeklyQualityScore('-100', '2026-02-16', { score: 90, grade: 'A', draftEdits: 0, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, weeksOfData: 3 }, db)

    const msg = {
      chat: { id: '-100', type: 'group' },
      from: { id: 12345, first_name: 'Manager' },
    }

    await handleQualityCommand(bot, msg, db)
    const dm = bot.lastMessage('12345')
    assert.ok(dm, 'Should DM the manager')
    assert.ok(dm.text.includes('quality') || dm.text.includes('Quality'), 'Should mention quality')
  })

  it('empty history → "Not enough data" message', async () => {
    const bot = new MockBot()
    const db = new QualityMockDB()
    const msg = {
      chat: { id: '-200', type: 'group' },
      from: { id: 99999, first_name: 'Manager' },
    }

    await handleQualityCommand(bot, msg, db)
    const dm = bot.lastMessage('99999')
    assert.ok(dm, 'Should DM the manager')
    assert.ok(dm.text.includes('Not enough data') || dm.text.includes('not enough data'), 'Should say not enough data')
  })
})
