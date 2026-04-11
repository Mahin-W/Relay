import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeCoveragePatterns,
  analyzeOnCallCandidates,
  generatePrePublishAlerts,
  formatPrePublishAlerts
} from '../../intelligence/patternAlerts.js'

// --- helpers ---

function makeDb(overrides = {}) {
  return {
    getCoverageHistory: async () => overrides.coverageHistory || [],
    getOnCallHistory: async () => overrides.onCallHistory || [],
    analyzeCoveragePatterns: overrides.analyzeCoveragePatterns || undefined,
    analyzeOnCallCandidates: overrides.analyzeOnCallCandidates || undefined,
    ...overrides
  }
}

// Raw coverage history rows (mimic DB shape)
function coverageRow(requested_by, requester_telegram_id, day_of_week, shift_name, created_at, status = 'open') {
  return { requested_by, requester_telegram_id, day_of_week, shift_name, created_at, status }
}

// Raw on-call (coverage confirmation) rows
function onCallRow(covered_by, staff_id, response_minutes, created_at) {
  return { covered_by, staff_id, response_minutes, created_at }
}

// Schedule data rows (how many times a person was scheduled for a day/shift)
function scheduleRow(staff_id, staff_name, day_of_week, shift_name, count) {
  return { staff_id, staff_name, day_of_week, shift_name, count }
}

await Promise.all([

  // ===== analyzeCoveragePatterns =====

  test('analyzeCoveragePatterns: 4 callouts in 6 Friday shifts → frequent_callout', async () => {
    const db = makeDb({
      getCoverageHistory: async () => [
        coverageRow('Marcus', 101, 'Friday', 'Fri Dinner', '2025-01-03'),
        coverageRow('Marcus', 101, 'Friday', 'Fri Dinner', '2025-01-10'),
        coverageRow('Marcus', 101, 'Friday', 'Fri Dinner', '2025-01-17'),
        coverageRow('Marcus', 101, 'Friday', 'Fri Dinner', '2025-01-24'),
      ],
      getScheduleHistory: async () => [
        scheduleRow(101, 'Marcus', 'Friday', 'Fri Dinner', 6),
      ]
    })
    const result = await analyzeCoveragePatterns('group1', 6, db)
    const marcus = result.find(r => r.staffId === 101 && r.pattern === 'frequent_callout')
    assert.ok(marcus, 'Marcus should be flagged as frequent_callout')
    assert.ok(Math.abs(marcus.calloutRate - 4/6) < 0.01, 'calloutRate should be ~0.67')
    assert.equal(marcus.calloutCount, 4)
    assert.equal(marcus.totalScheduled, 6)
    assert.equal(marcus.dayOfWeek, 'Friday')
    assert.equal(marcus.shiftName, 'Fri Dinner')
  }),

  test('analyzeCoveragePatterns: 0 callouts → not flagged', async () => {
    const db = makeDb({
      getCoverageHistory: async () => [],
      getScheduleHistory: async () => [
        scheduleRow(102, 'Anna', 'Monday', 'Mon Lunch', 5),
      ]
    })
    const result = await analyzeCoveragePatterns('group1', 6, db)
    const flagged = result.filter(r => r.pattern === 'frequent_callout')
    assert.equal(flagged.length, 0)
  }),

  test('analyzeCoveragePatterns: staff who covered 5 requests → reliable_coverage', async () => {
    const db = makeDb({
      getCoverageHistory: async () => [],
      getScheduleHistory: async () => [],
      getReliableCoverers: async () => [
        { staff_id: 103, staff_name: 'Sarah', coverage_count: 5 }
      ]
    })
    const result = await analyzeCoveragePatterns('group1', 6, db)
    const sarah = result.find(r => r.staffId === 103 && r.pattern === 'reliable_coverage')
    assert.ok(sarah, 'Sarah should be flagged as reliable_coverage')
    assert.equal(sarah.staffName, 'Sarah')
  }),

  test('analyzeCoveragePatterns: less than 2 callouts → not flagged as frequent', async () => {
    const db = makeDb({
      getCoverageHistory: async () => [
        coverageRow('Jake', 104, 'Tuesday', 'Tue Open', '2025-01-07'),
      ],
      getScheduleHistory: async () => [
        scheduleRow(104, 'Jake', 'Tuesday', 'Tue Open', 4),
      ]
    })
    const result = await analyzeCoveragePatterns('group1', 6, db)
    const flagged = result.filter(r => r.pattern === 'frequent_callout')
    assert.equal(flagged.length, 0)
  }),

  test('analyzeCoveragePatterns: empty history → empty array, no crash', async () => {
    const db = makeDb({
      getCoverageHistory: async () => [],
      getScheduleHistory: async () => [],
      getReliableCoverers: async () => []
    })
    const result = await analyzeCoveragePatterns('group1', 6, db)
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 0)
  }),

  // ===== analyzeOnCallCandidates =====

  test('analyzeOnCallCandidates: fastest avg response ranked first', async () => {
    const db = makeDb({
      getOnCallHistory: async () => [
        onCallRow('Sarah', 4, 10, '2025-01-03'),
        onCallRow('Sarah', 4, 20, '2025-01-10'),
        onCallRow('Mike', 5, 30, '2025-01-05'),
        onCallRow('Mike', 5, 40, '2025-01-12'),
        onCallRow('Zara', 6, 50, '2025-01-06'),
        onCallRow('Zara', 6, 60, '2025-01-13'),
      ]
    })
    const result = await analyzeOnCallCandidates('group1', db)
    assert.equal(result[0].staffName, 'Sarah')
    assert.equal(result[0].avgResponseMinutes, 15)
    assert.equal(result[0].coverageCount, 2)
    assert.ok(result[0].reliabilityScore > result[1].reliabilityScore)
  }),

  test('analyzeOnCallCandidates: returns max 3', async () => {
    const db = makeDb({
      getOnCallHistory: async () => [
        onCallRow('A', 1, 10, '2025-01-01'),
        onCallRow('B', 2, 20, '2025-01-01'),
        onCallRow('C', 3, 30, '2025-01-01'),
        onCallRow('D', 4, 40, '2025-01-01'),
      ]
    })
    const result = await analyzeOnCallCandidates('group1', db)
    assert.ok(result.length <= 3)
  }),

  test('analyzeOnCallCandidates: empty → empty array', async () => {
    const db = makeDb({ getOnCallHistory: async () => [] })
    const result = await analyzeOnCallCandidates('group1', db)
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 0)
  }),

  // ===== generatePrePublishAlerts =====

  test('generatePrePublishAlerts: Marcus on Friday with callout pattern → warning', async () => {
    const db = makeDb({
      analyzeCoveragePatterns: async () => [
        {
          staffId: 101, staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Fri Dinner',
          calloutCount: 4, totalScheduled: 6, calloutRate: 4/6,
          lastCalloutDate: '2025-01-24', pattern: 'frequent_callout'
        }
      ],
      analyzeOnCallCandidates: async () => []
    })
    const assignments = [
      { staffId: 101, staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Fri Dinner' }
    ]
    const result = await generatePrePublishAlerts('group1', assignments, [], db)
    const warning = result.find(a => a.severity === 'warning' && a.type === 'callout_risk')
    assert.ok(warning, 'Should produce a callout_risk warning')
    assert.equal(warning.staffName, 'Marcus')
    assert.equal(warning.shiftName, 'Fri Dinner')
    assert.equal(warning.dayOfWeek, 'Friday')
    assert.ok(warning.message.length > 0)
  }),

  test('generatePrePublishAlerts: Sarah with high coverage → info on_call_suggestion', async () => {
    const db = makeDb({
      analyzeCoveragePatterns: async () => [],
      analyzeOnCallCandidates: async () => [
        { staffId: 4, staffName: 'Sarah', avgResponseMinutes: 12, coverageCount: 5, reliabilityScore: 0.9 }
      ]
    })
    const result = await generatePrePublishAlerts('group1', [], [], db)
    const info = result.find(a => a.severity === 'info' && a.type === 'on_call_suggestion')
    assert.ok(info, 'Should produce an on_call_suggestion info alert')
    assert.equal(info.staffName, 'Sarah')
    assert.ok(info.message.length > 0)
  }),

  test('generatePrePublishAlerts: no patterns → empty alerts', async () => {
    const db = makeDb({
      analyzeCoveragePatterns: async () => [],
      analyzeOnCallCandidates: async () => []
    })
    const result = await generatePrePublishAlerts('group1', [], [], db)
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 0)
  }),

  test('generatePrePublishAlerts: warnings sorted before info', async () => {
    const db = makeDb({
      analyzeCoveragePatterns: async () => [
        {
          staffId: 101, staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Fri Dinner',
          calloutCount: 3, totalScheduled: 5, calloutRate: 0.6,
          lastCalloutDate: '2025-01-24', pattern: 'frequent_callout'
        }
      ],
      analyzeOnCallCandidates: async () => [
        { staffId: 4, staffName: 'Sarah', avgResponseMinutes: 12, coverageCount: 5, reliabilityScore: 0.9 }
      ]
    })
    const assignments = [
      { staffId: 101, staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Fri Dinner' }
    ]
    const result = await generatePrePublishAlerts('group1', assignments, [], db)
    assert.ok(result.length >= 2)
    const firstWarningIdx = result.findIndex(a => a.severity === 'warning')
    const firstInfoIdx = result.findIndex(a => a.severity === 'info')
    if (firstWarningIdx !== -1 && firstInfoIdx !== -1) {
      assert.ok(firstWarningIdx < firstInfoIdx, 'Warnings should come before info')
    }
  }),

  // ===== formatPrePublishAlerts =====

  test('formatPrePublishAlerts: returns null when empty', () => {
    assert.equal(formatPrePublishAlerts([]), null)
  }),

  test('formatPrePublishAlerts: non-empty returns string with header', () => {
    const alerts = [
      {
        severity: 'warning', type: 'callout_risk',
        staffName: 'Marcus', shiftName: 'Fri Dinner', dayOfWeek: 'Friday',
        message: 'Marcus has called out 4 of the last 6 Friday shifts. You\'ve scheduled them this Friday.',
        calloutCount: 4, totalScheduled: 6
      }
    ]
    const result = formatPrePublishAlerts(alerts, 6)
    assert.ok(typeof result === 'string')
    assert.ok(result.includes('🔍'))
  }),

  test('formatPrePublishAlerts: warnings before info in output', () => {
    const alerts = [
      {
        severity: 'info', type: 'on_call_suggestion',
        staffName: 'Sarah', shiftName: null, dayOfWeek: null,
        message: 'Sarah picks up coverage fast — good on-call candidate if needed.'
      },
      {
        severity: 'warning', type: 'callout_risk',
        staffName: 'Marcus', shiftName: 'Fri Dinner', dayOfWeek: 'Friday',
        message: 'Marcus has called out 4 of the last 6 Friday shifts. You\'ve scheduled them this Friday.',
        calloutCount: 4, totalScheduled: 6
      }
    ]
    const result = formatPrePublishAlerts(alerts, 6)
    const warningPos = result.indexOf('⚠️')
    const infoPos = result.indexOf('💡')
    assert.ok(warningPos < infoPos, 'Warning emoji should appear before info emoji')
  }),

  test('formatPrePublishAlerts: contains counts', () => {
    const alerts = [
      {
        severity: 'warning', type: 'callout_risk',
        staffName: 'Marcus', shiftName: 'Fri Dinner', dayOfWeek: 'Friday',
        message: 'Marcus has called out 4 of the last 6 Friday shifts. You\'ve scheduled them this Friday.',
        calloutCount: 4, totalScheduled: 6
      }
    ]
    const result = formatPrePublishAlerts(alerts, 6)
    assert.ok(result.includes('4'), 'Should contain callout count')
    assert.ok(result.includes('6'), 'Should contain total count')
  }),
])
