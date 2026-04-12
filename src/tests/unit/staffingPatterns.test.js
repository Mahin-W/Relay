import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeShiftStaffingHistory,
  analyzeAllShifts,
  generateStaffingRecommendations,
  formatStaffingPatternAlert,
  detectSeasonalPatterns,
  formatSeasonalInsight,
} from '../../intelligence/staffingPatterns.js'

// ── Helper: generate week-start Mondays going back N weeks from a reference ──
function mondaysBack(count, refDate = new Date('2026-04-06')) {
  const mondays = []
  for (let i = 0; i < count; i++) {
    const d = new Date(refDate)
    d.setDate(d.getDate() - i * 7)
    mondays.push(d.toISOString().slice(0, 10))
  }
  return mondays
}

// ── MockDB factory ──────────────────────────────────────────────────────────
function makeMockDb({ shift, requirements, assignments }) {
  return {
    getShiftById: async (shiftId) => shift ?? null,
    getShiftRequirements: async (shiftId) => requirements ?? [],
    getAssignmentCountsByWeek: async (groupId, shiftId, weekStarts) => {
      // Returns Map<weekStart, count>
      return assignments ?? new Map()
    },
    getShiftsByGroup: async (groupId) => shift ? [shift] : [],
    getCoverageRequestsByGroup: async (groupId, since) => [],
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// analyzeShiftStaffingHistory
// ═══════════════════════════════════════════════════════════════════════════
describe('analyzeShiftStaffingHistory', { concurrency: true }, () => {
  it('detects chronic understaffing (6/8 weeks, rate 0.75)', async () => {
    const weeks = mondaysBack(8)
    const assignments = new Map()
    // 6 weeks understaffed (2 assigned vs 3 required), 2 weeks fully staffed
    weeks.forEach((w, i) => {
      assignments.set(w, i < 6 ? 2 : 3)
    })

    const db = makeMockDb({
      shift: { id: 1, name: 'Tuesday Lunch', day_of_week: 'Tuesday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments,
    })

    const result = await analyzeShiftStaffingHistory('100', 1, 8, db)
    assert.equal(result.pattern, 'chronic_understaffing')
    assert.equal(result.understaffedRate, 0.75)
    assert.equal(result.weeksAnalyzed, 8)
    assert.equal(result.understaffedWeeks, 6)
    assert.equal(result.shiftName, 'Tuesday Lunch')
    assert.equal(result.dayOfWeek, 'Tuesday')
    assert.equal(result.avgRequired, 3)
  })

  it('detects chronic overstaffing (5/8 weeks, rate 0.625)', async () => {
    const weeks = mondaysBack(8)
    const assignments = new Map()
    // 5 weeks overstaffed (4 assigned vs 3 required), 3 weeks normal
    weeks.forEach((w, i) => {
      assignments.set(w, i < 5 ? 4 : 3)
    })

    const db = makeMockDb({
      shift: { id: 2, name: 'Monday Dinner', day_of_week: 'Monday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments,
    })

    const result = await analyzeShiftStaffingHistory('100', 2, 8, db)
    assert.equal(result.pattern, 'chronic_overstaffing')
    assert.equal(result.overstaffedRate, 0.625)
    assert.equal(result.overstaffedWeeks, 5)
  })

  it('returns stable when understaffed rate below 0.6 (3/8)', async () => {
    const weeks = mondaysBack(8)
    const assignments = new Map()
    weeks.forEach((w, i) => {
      assignments.set(w, i < 3 ? 2 : 3)
    })

    const db = makeMockDb({
      shift: { id: 3, name: 'Wednesday AM', day_of_week: 'Wednesday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments,
    })

    const result = await analyzeShiftStaffingHistory('100', 3, 8, db)
    assert.equal(result.pattern, 'stable')
  })

  it('returns insufficient_data when weeksAnalyzed < 6', async () => {
    const weeks = mondaysBack(5)
    const assignments = new Map()
    weeks.forEach((w) => {
      assignments.set(w, 2) // all understaffed, but only 5 weeks
    })

    const db = makeMockDb({
      shift: { id: 4, name: 'Thursday PM', day_of_week: 'Thursday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments,
    })

    const result = await analyzeShiftStaffingHistory('100', 4, 5, db)
    assert.equal(result.pattern, 'insufficient_data')
    assert.equal(result.weeksAnalyzed, 5)
  })

  it('handles empty history without crashing', async () => {
    const db = makeMockDb({
      shift: { id: 5, name: 'Friday Night', day_of_week: 'Friday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments: new Map(),
    })

    const result = await analyzeShiftStaffingHistory('100', 5, 8, db)
    assert.equal(result.pattern, 'insufficient_data')
    assert.equal(result.weeksAnalyzed, 0)
  })

  it('weeksAnalyzed reflects actual data weeks found', async () => {
    // Ask for 8 weeks but only 6 have data
    const weeks = mondaysBack(6)
    const assignments = new Map()
    weeks.forEach((w) => {
      assignments.set(w, 2)
    })

    const db = makeMockDb({
      shift: { id: 6, name: 'Saturday Brunch', day_of_week: 'Saturday', group_id: '100' },
      requirements: [{ role: 'Server', count: 3 }],
      assignments,
    })

    const result = await analyzeShiftStaffingHistory('100', 6, 8, db)
    // The function generates 8 week-starts but only 6 have data in the map
    assert.equal(result.weeksAnalyzed, 6)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// generateStaffingRecommendations
// ═══════════════════════════════════════════════════════════════════════════
describe('generateStaffingRecommendations', { concurrency: true }, () => {
  it('generates increase_requirement for chronic understaffing', () => {
    const patterns = [{
      shiftId: 1, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 2.25,
      understaffedWeeks: 6, overstaffedWeeks: 0,
      understaffedRate: 0.75, overstaffedRate: 0,
      pattern: 'chronic_understaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.equal(recommendations.length, 1)
    assert.equal(recommendations[0].type, 'increase_requirement')
    assert.equal(recommendations[0].shiftName, 'Tuesday Lunch')
  })

  it('generates decrease_requirement for chronic overstaffing', () => {
    const patterns = [{
      shiftId: 2, shiftName: 'Monday Dinner', dayOfWeek: 'Monday',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 3.75,
      understaffedWeeks: 0, overstaffedWeeks: 5,
      understaffedRate: 0, overstaffedRate: 0.625,
      pattern: 'chronic_overstaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.equal(recommendations.length, 1)
    assert.equal(recommendations[0].type, 'decrease_requirement')
  })

  it('returns empty recommendations for no patterns', () => {
    const { recommendations } = generateStaffingRecommendations([])
    assert.equal(recommendations.length, 0)
  })

  it('suggestedRequirement for understaffing: ceil(avgAssigned + 0.5)', () => {
    const patterns = [{
      shiftId: 1, shiftName: 'Test', dayOfWeek: 'Mon',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 2.25,
      understaffedWeeks: 6, overstaffedWeeks: 0,
      understaffedRate: 0.75, overstaffedRate: 0,
      pattern: 'chronic_understaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    // ceil(2.25 + 0.5) = ceil(2.75) = 3
    assert.equal(recommendations[0].suggestedRequirement, Math.ceil(2.25 + 0.5))
  })

  it('suggestedRequirement for overstaffing: floor(avgAssigned)', () => {
    const patterns = [{
      shiftId: 2, shiftName: 'Test', dayOfWeek: 'Mon',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 3.75,
      understaffedWeeks: 0, overstaffedWeeks: 5,
      understaffedRate: 0, overstaffedRate: 0.625,
      pattern: 'chronic_overstaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.equal(recommendations[0].suggestedRequirement, Math.floor(3.75))
  })

  it('severity high when understaffedRate >= 0.75', () => {
    const patterns = [{
      shiftId: 1, shiftName: 'Test', dayOfWeek: 'Mon',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 2,
      understaffedWeeks: 6, overstaffedWeeks: 0,
      understaffedRate: 0.75, overstaffedRate: 0,
      pattern: 'chronic_understaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.equal(recommendations[0].severity, 'high')
  })

  it('severity medium when understaffedRate 0.6-0.74', () => {
    const patterns = [{
      shiftId: 1, shiftName: 'Test', dayOfWeek: 'Mon',
      weeksAnalyzed: 8, avgRequired: 3, avgAssigned: 2.5,
      understaffedWeeks: 5, overstaffedWeeks: 0,
      understaffedRate: 0.625, overstaffedRate: 0,
      pattern: 'chronic_understaffing',
    }]

    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.equal(recommendations[0].severity, 'medium')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// formatStaffingPatternAlert
// ═══════════════════════════════════════════════════════════════════════════
describe('formatStaffingPatternAlert', { concurrency: true }, () => {
  it('contains shift name and day', () => {
    const recs = {
      recommendations: [{
        shiftId: 1, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday',
        type: 'increase_requirement',
        currentRequirement: 3, suggestedRequirement: 4,
        reasoning: 'test', severity: 'high',
        understaffedWeeks: 6, weeksAnalyzed: 8,
      }],
      summary: 'test',
    }

    const alert = formatStaffingPatternAlert(recs)
    assert.ok(alert.includes('Tuesday Lunch'))
    assert.ok(alert.includes('Tuesday') || alert.includes('tuesday'))
  })

  it('contains current vs suggested requirement', () => {
    const recs = {
      recommendations: [{
        shiftId: 1, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday',
        type: 'increase_requirement',
        currentRequirement: 2, suggestedRequirement: 3,
        reasoning: 'test', severity: 'high',
        understaffedWeeks: 6, weeksAnalyzed: 8,
      }],
      summary: 'test',
    }

    const alert = formatStaffingPatternAlert(recs)
    assert.ok(alert.includes('2'))
    assert.ok(alert.includes('3'))
  })

  it('contains weeks count', () => {
    const recs = {
      recommendations: [{
        shiftId: 1, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday',
        type: 'increase_requirement',
        currentRequirement: 2, suggestedRequirement: 3,
        reasoning: 'test', severity: 'high',
        understaffedWeeks: 6, weeksAnalyzed: 8,
      }],
      summary: 'test',
    }

    const alert = formatStaffingPatternAlert(recs)
    assert.ok(alert.includes('6'))
    assert.ok(alert.includes('8'))
  })

  it('returns null when empty recommendations', () => {
    const result = formatStaffingPatternAlert({ recommendations: [], summary: '' })
    assert.equal(result, null)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// detectSeasonalPatterns
// ═══════════════════════════════════════════════════════════════════════════
describe('detectSeasonalPatterns', { concurrency: true }, () => {
  it('returns hasSeasonalData:false with < 12 weeks', async () => {
    const db = {
      getShiftsByGroup: async () => [{ id: 1, name: 'Lunch', day_of_week: 'Monday' }],
      getShiftRequirements: async () => [{ role: 'Server', count: 3 }],
      getAssignmentCountsByWeek: async () => new Map(),
      getCoverageRequestsByGroup: async () => [],
    }

    const result = await detectSeasonalPatterns('100', db)
    assert.equal(result.hasSeasonalData, false)
  })

  it('groups by month and calculates relativeLoad with 12+ weeks', async () => {
    // Simulate 16 weeks of data with varying understaffing
    const weeks = mondaysBack(16, new Date('2026-04-06'))
    const shifts = [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', group_id: '100' },
      { id: 2, name: 'Dinner', day_of_week: 'Tuesday', group_id: '100' },
    ]

    // Make January weeks heavily understaffed, others normal
    const assignmentsByShift = {}
    for (const s of shifts) {
      const map = new Map()
      weeks.forEach((w) => {
        const month = new Date(w).getMonth()
        // month 0 = January → understaffed (1 assigned); others → fully staffed (3)
        map.set(w, month === 0 ? 1 : 3)
      })
      assignmentsByShift[s.id] = map
    }

    const db = {
      getShiftsByGroup: async () => shifts,
      getShiftRequirements: async () => [{ role: 'Server', count: 3 }],
      getAssignmentCountsByWeek: async (groupId, shiftId, weekStarts) => {
        return assignmentsByShift[shiftId] ?? new Map()
      },
      getCoverageRequestsByGroup: async () => [],
    }

    const result = await detectSeasonalPatterns('100', db)
    assert.equal(result.hasSeasonalData, true)
    assert.ok(result.patterns.length > 0)

    // January should be heavy (lots of understaffing)
    const jan = result.patterns.find(p => p.month === 0)
    if (jan) {
      assert.equal(jan.relativeLoad, 'heavy')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// analyzeAllShifts
// ═══════════════════════════════════════════════════════════════════════════
describe('analyzeAllShifts', { concurrency: true }, () => {
  it('filters stable and insufficient, sorts by severity', async () => {
    const weeks = mondaysBack(8)

    const shift1Assignments = new Map()
    weeks.forEach((w, i) => shift1Assignments.set(w, i < 6 ? 2 : 3)) // understaffed 0.75

    const shift2Assignments = new Map()
    weeks.forEach((w) => shift2Assignments.set(w, 3)) // stable

    const shift3Assignments = new Map()
    weeks.forEach((w, i) => shift3Assignments.set(w, i < 5 ? 2 : 3)) // understaffed 0.625

    const shifts = [
      { id: 1, name: 'Tuesday Lunch', day_of_week: 'Tuesday', group_id: '100' },
      { id: 2, name: 'Monday AM', day_of_week: 'Monday', group_id: '100' },
      { id: 3, name: 'Wednesday PM', day_of_week: 'Wednesday', group_id: '100' },
    ]

    const assignmentsMap = { 1: shift1Assignments, 2: shift2Assignments, 3: shift3Assignments }

    const db = {
      getShiftById: async (id) => shifts.find(s => s.id === id),
      getShiftsByGroup: async () => shifts,
      getShiftRequirements: async () => [{ role: 'Server', count: 3 }],
      getAssignmentCountsByWeek: async (groupId, shiftId, weekStarts) => {
        return assignmentsMap[shiftId] ?? new Map()
      },
    }

    const results = await analyzeAllShifts('100', 8, db)
    // Should filter out stable (shift2)
    assert.equal(results.length, 2)
    // Should sort by severity (highest understaffedRate first)
    assert.equal(results[0].shiftName, 'Tuesday Lunch')
    assert.equal(results[1].shiftName, 'Wednesday PM')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// formatSeasonalInsight
// ═══════════════════════════════════════════════════════════════════════════
describe('formatSeasonalInsight', { concurrency: true }, () => {
  it('returns null when hasSeasonalData is false', () => {
    const result = formatSeasonalInsight({ hasSeasonalData: false, patterns: [] }, 3)
    assert.equal(result, null)
  })

  it('returns formatted string when hasSeasonalData is true', () => {
    const result = formatSeasonalInsight({
      hasSeasonalData: true,
      patterns: [
        { month: 0, avgUnderstaffedShifts: 3.5, relativeLoad: 'heavy' },
        { month: 5, avgUnderstaffedShifts: 0.5, relativeLoad: 'light' },
      ],
    }, 3) // current month March
    assert.ok(result !== null)
    assert.ok(typeof result === 'string')
    assert.ok(result.length > 0)
  })
})
