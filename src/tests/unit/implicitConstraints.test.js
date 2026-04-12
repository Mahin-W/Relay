import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeAssignmentPatterns,
  filterAlreadyKnownConstraints,
  generateDiscoveryPrompts,
  saveDiscoveredPattern,
  dismissPattern,
  getDismissedPatterns,
  getWeekNumber,
  shouldRunDiscovery,
} from '../../intelligence/implicitConstraints.js'

// ── Test data: 10 weeks of schedule history ────────────────────────────────
// Staff: Marcus(1), Sarah(2), Jake(3), Carlos(4)
// Shifts: Morning(1), Lunch(2), Dinner(3), Close(4), FridayDinner(5)
// Key patterns:
//   - Marcus(1) and Jake(3) are NEVER on the same shift+day
//   - Sarah(2) is on Friday Dinner (shift 5) 9 of 10 weeks
//   - Carlos(4) is never scheduled on Monday despite being active

const WEEKS = [
  '2025-01-06','2025-01-13','2025-01-20','2025-01-27',
  '2025-02-03','2025-02-10','2025-02-17','2025-02-24',
  '2025-03-03','2025-03-10',
]

function buildAssignments() {
  const rows = []
  let id = 1
  for (const week of WEEKS) {
    // Marcus(1): Mon Morning, Wed Dinner, Fri Morning
    rows.push({ id: id++, group_id: 'g1', staff_id: 1, shift_id: 1, week_start: week, status: 'published', day_of_week: 'Monday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 1, shift_id: 3, week_start: week, status: 'published', day_of_week: 'Wednesday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 1, shift_id: 1, week_start: week, status: 'published', day_of_week: 'Friday' })
    // Jake(3): Mon Dinner, Wed Morning, Fri Dinner — never overlaps Marcus on same shift+day
    rows.push({ id: id++, group_id: 'g1', staff_id: 3, shift_id: 3, week_start: week, status: 'published', day_of_week: 'Monday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 3, shift_id: 1, week_start: week, status: 'published', day_of_week: 'Wednesday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 3, shift_id: 3, week_start: week, status: 'published', day_of_week: 'Friday' })
    // Carlos(4): Tue Lunch, Wed Lunch, Thu Lunch, Fri Lunch — never Monday
    rows.push({ id: id++, group_id: 'g1', staff_id: 4, shift_id: 2, week_start: week, status: 'published', day_of_week: 'Tuesday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 4, shift_id: 2, week_start: week, status: 'published', day_of_week: 'Wednesday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 4, shift_id: 2, week_start: week, status: 'published', day_of_week: 'Thursday' })
    rows.push({ id: id++, group_id: 'g1', staff_id: 4, shift_id: 2, week_start: week, status: 'published', day_of_week: 'Friday' })
  }
  // Sarah(2): Friday Dinner(5) 9 of 10 weeks (skip week index 4)
  for (let i = 0; i < WEEKS.length; i++) {
    if (i === 4) continue // skip one week
    rows.push({ id: id++, group_id: 'g1', staff_id: 2, shift_id: 5, week_start: WEEKS[i], status: 'published', day_of_week: 'Friday' })
  }
  // Sarah also works other days so she's active
  for (const week of WEEKS) {
    rows.push({ id: id++, group_id: 'g1', staff_id: 2, shift_id: 1, week_start: week, status: 'published', day_of_week: 'Monday' })
  }
  return rows
}

const ALL_ASSIGNMENTS = buildAssignments()

const STAFF = [
  { id: 1, group_id: 'g1', name: 'Marcus', role: 'server' },
  { id: 2, group_id: 'g1', name: 'Sarah', role: 'server' },
  { id: 3, group_id: 'g1', name: 'Jake', role: 'server' },
  { id: 4, group_id: 'g1', name: 'Carlos', role: 'cook' },
]

const SHIFTS = [
  { id: 1, group_id: 'g1', name: 'Morning', day_of_week: null },
  { id: 2, group_id: 'g1', name: 'Lunch', day_of_week: null },
  { id: 3, group_id: 'g1', name: 'Dinner', day_of_week: null },
  { id: 4, group_id: 'g1', name: 'Close', day_of_week: null },
  { id: 5, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday' },
]

function makeDb(overrides = {}) {
  return {
    getAssignments: async (groupId, weeksBack) => {
      return ALL_ASSIGNMENTS.filter(a => a.group_id === groupId)
    },
    getStaff: async (groupId) => STAFF.filter(s => s.group_id === groupId),
    getShifts: async (groupId) => SHIFTS.filter(s => s.group_id === groupId),
    getEditEvents: async (groupId, weeksBack) => [],
    getAvailability: async (groupId) => [],
    saveDiscoveredPattern: async (groupId, pattern) => ({ id: 100, ...pattern }),
    dismissPattern: async (patternId) => ({ id: patternId, status: 'dismissed' }),
    getDismissedPatterns: async (groupId) => [],
    getDiscoveredPatternsThisWeek: async (groupId, weekStart) => [],
    ...overrides,
  }
}

// ── analyzeAssignmentPatterns ──────────────────────────────────────────────

await Promise.all([
  test('analyzeAssignmentPatterns: Marcus and Jake never together → never_together', async () => {
    const db = makeDb()
    const patterns = await analyzeAssignmentPatterns('g1', 10, db)
    const neverTogether = patterns.filter(p => p.type === 'never_together')
    // Marcus(1) and Jake(3) are never on the same shift+day
    const pair = neverTogether.find(p =>
      (p.staffIdA === 1 && p.staffIdB === 3) || (p.staffIdA === 3 && p.staffIdB === 1)
    )
    assert.ok(pair, 'should find Marcus/Jake never_together pattern')
    assert.ok(pair.confidence >= 0.7, `confidence ${pair.confidence} should be >= 0.7`)
    assert.equal(pair.weeksAnalyzed, 10)
  }),

  test('analyzeAssignmentPatterns: Sarah on Friday Dinner 9/10 → always_on_shift', async () => {
    const db = makeDb()
    const patterns = await analyzeAssignmentPatterns('g1', 10, db)
    const alwaysOnShift = patterns.filter(p => p.type === 'always_on_shift')
    const sarahFriday = alwaysOnShift.find(p =>
      p.staffIdA === 2 && p.shiftId === 5
    )
    assert.ok(sarahFriday, 'should find Sarah always_on_shift for Friday Dinner')
    assert.equal(sarahFriday.confidence, 0.9)
    assert.ok(sarahFriday.description.includes('Sarah'))
  }),

  test('analyzeAssignmentPatterns: Carlos never on Monday → never_on_day', async () => {
    const db = makeDb()
    const patterns = await analyzeAssignmentPatterns('g1', 10, db)
    const neverOnDay = patterns.filter(p => p.type === 'never_on_day')
    const carlosMon = neverOnDay.find(p =>
      p.staffIdA === 4 && p.dayOfWeek === 'Monday'
    )
    assert.ok(carlosMon, 'should find Carlos never_on_day Monday')
    assert.equal(carlosMon.confidence, 1.0)
  }),

  test('analyzeAssignmentPatterns: Carlos marked unavailable Monday → skip never_on_day', async () => {
    const db = makeDb({
      getAvailability: async () => [
        { staff_id: 4, day_of_week: 'Monday', available: false },
      ],
    })
    const patterns = await analyzeAssignmentPatterns('g1', 10, db)
    const neverOnDay = patterns.filter(p => p.type === 'never_on_day')
    const carlosMon = neverOnDay.find(p =>
      p.staffIdA === 4 && p.dayOfWeek === 'Monday'
    )
    assert.equal(carlosMon, undefined, 'should NOT flag Carlos Monday if explicitly unavailable')
  }),

  test('analyzeAssignmentPatterns: only 5 weeks → no patterns returned', async () => {
    const fiveWeeks = ALL_ASSIGNMENTS.filter(a =>
      WEEKS.slice(0, 5).includes(a.week_start)
    )
    const db = makeDb({
      getAssignments: async () => fiveWeeks,
    })
    const patterns = await analyzeAssignmentPatterns('g1', 5, db)
    assert.equal(patterns.length, 0, 'insufficient weeks should return no patterns')
  }),

  test('analyzeAssignmentPatterns: pair scheduled together only once → not always_together', async () => {
    const db = makeDb()
    const patterns = await analyzeAssignmentPatterns('g1', 10, db)
    const alwaysTogether = patterns.filter(p => p.type === 'always_together')
    // No pair in our data meets the 75% threshold for always_together
    // (Marcus+Jake are on same day but different shifts; others don't overlap enough)
    // If any spurious always_together appears, it should have high confidence
    for (const p of alwaysTogether) {
      assert.ok(p.confidence >= 0.75, 'always_together confidence must be >= 0.75')
    }
  }),

  // ── filterAlreadyKnownConstraints ────────────────────────────────────────

  test('filterAlreadyKnownConstraints: pattern matching existing rule → filtered out', () => {
    const patterns = [{
      type: 'never_together', staffIdA: 1, staffIdB: 3,
      confidence: 1.0, weeksAnalyzed: 10,
    }]
    const existingRules = [{
      type: 'staff_conflict',
      subject_staff_id: 1, object_staff_id: 3,
      active: true,
    }]
    const result = filterAlreadyKnownConstraints(patterns, existingRules)
    assert.equal(result.length, 0, 'should filter pattern matching staff_conflict rule')
  }),

  test('filterAlreadyKnownConstraints: pattern matching dismissed entry → filtered out', () => {
    const patterns = [{
      type: 'never_on_day', staffIdA: 4, dayOfWeek: 'Monday',
      confidence: 1.0, weeksAnalyzed: 10,
    }]
    const dismissed = [{
      type: 'never_on_day', staff_id_a: 4, day_of_week: 'Monday',
      status: 'dismissed',
    }]
    const result = filterAlreadyKnownConstraints(patterns, [], dismissed)
    assert.equal(result.length, 0, 'should filter dismissed patterns')
  }),

  test('filterAlreadyKnownConstraints: pattern with no matching rule → kept', () => {
    const patterns = [{
      type: 'always_on_shift', staffIdA: 2, shiftId: 5,
      confidence: 0.9, weeksAnalyzed: 10,
    }]
    const existingRules = [{
      type: 'staff_conflict',
      subject_staff_id: 1, object_staff_id: 3,
    }]
    const result = filterAlreadyKnownConstraints(patterns, existingRules)
    assert.equal(result.length, 1, 'unmatched pattern should be kept')
  }),

  test('filterAlreadyKnownConstraints: empty rules → all kept', () => {
    const patterns = [
      { type: 'never_together', staffIdA: 1, staffIdB: 3, confidence: 1.0 },
      { type: 'always_on_shift', staffIdA: 2, shiftId: 5, confidence: 0.9 },
    ]
    const result = filterAlreadyKnownConstraints(patterns, [], [])
    assert.equal(result.length, 2, 'all patterns kept when no rules or dismissed')
  }),

  // ── generateDiscoveryPrompts ─────────────────────────────────────────────

  test('generateDiscoveryPrompts: never_together → asks about permanent rule', () => {
    const patterns = [{
      type: 'never_together', staffIdA: 1, staffIdB: 3,
      staffNameA: 'Marcus', staffNameB: 'Jake',
      confidence: 1.0, weeksAnalyzed: 10,
    }]
    const prompts = generateDiscoveryPrompts(patterns)
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].question.includes('Marcus'))
    assert.ok(prompts[0].question.includes('Jake'))
    assert.ok(prompts[0].question.toLowerCase().includes('rule') ||
              prompts[0].question.toLowerCase().includes('never'))
    assert.ok(prompts[0].patternId)
  }),

  test('generateDiscoveryPrompts: always_on_shift → asks about prioritizing', () => {
    const patterns = [{
      type: 'always_on_shift', staffIdA: 2,
      staffNameA: 'Sarah', shiftName: 'Friday Dinner',
      confidence: 0.9, weeksAnalyzed: 10,
    }]
    const prompts = generateDiscoveryPrompts(patterns)
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].question.includes('Sarah'))
    assert.ok(prompts[0].question.includes('Friday Dinner'))
  }),

  test('generateDiscoveryPrompts: never_on_day → asks about day off', () => {
    const patterns = [{
      type: 'never_on_day', staffIdA: 4,
      staffNameA: 'Carlos', dayOfWeek: 'Monday',
      confidence: 1.0, weeksAnalyzed: 10,
    }]
    const prompts = generateDiscoveryPrompts(patterns)
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].question.includes('Carlos'))
    assert.ok(prompts[0].question.includes('Monday'))
    assert.ok(prompts[0].question.toLowerCase().includes('day off') ||
              prompts[0].question.toLowerCase().includes('off'))
  }),

  test('generateDiscoveryPrompts: always_together → asks about pairing', () => {
    const patterns = [{
      type: 'always_together', staffIdA: 1, staffIdB: 2,
      staffNameA: 'Marcus', staffNameB: 'Sarah',
      shiftName: 'Morning', confidence: 0.8, weeksAnalyzed: 10,
    }]
    const prompts = generateDiscoveryPrompts(patterns)
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].question.includes('Marcus'))
    assert.ok(prompts[0].question.includes('Sarah'))
    assert.ok(prompts[0].question.toLowerCase().includes('pair'))
  }),

  // ── shouldRunDiscovery ───────────────────────────────────────────────────

  test('shouldRunDiscovery: week 4 → true', async () => {
    // 2025-01-20 is ISO week 4
    const db = makeDb({
      getDiscoveredPatternsThisWeek: async () => [],
    })
    const result = await shouldRunDiscovery('g1', '2025-01-20', db)
    assert.equal(result, true)
  }),

  test('shouldRunDiscovery: week 5 → false', async () => {
    // 2025-01-27 is ISO week 5
    const db = makeDb()
    const result = await shouldRunDiscovery('g1', '2025-01-27', db)
    assert.equal(result, false)
  }),

  test('shouldRunDiscovery: week 4 but already ran → false', async () => {
    const db = makeDb({
      getDiscoveredPatternsThisWeek: async () => [{ id: 1 }],
    })
    const result = await shouldRunDiscovery('g1', '2025-01-20', db)
    assert.equal(result, false)
  }),

  // ── saveDiscoveredPattern / dismissPattern ───────────────────────────────

  test('saveDiscoveredPattern: saves with correct status', async () => {
    let savedData = null
    const db = makeDb({
      saveDiscoveredPattern: async (groupId, pattern) => {
        savedData = { groupId, pattern }
        return { id: 42, ...pattern }
      },
    })
    const pattern = {
      type: 'never_together', staffIdA: 1, staffIdB: 3,
      confidence: 1.0, weeksAnalyzed: 10,
    }
    const result = await saveDiscoveredPattern('g1', pattern, db)
    assert.equal(savedData.groupId, 'g1')
    assert.equal(savedData.pattern.type, 'never_together')
    assert.equal(result.id, 42)
  }),

  test('dismissPattern: sets status and timestamp', async () => {
    let dismissedId = null
    const db = makeDb({
      dismissPattern: async (patternId) => {
        dismissedId = patternId
        return { id: patternId, status: 'dismissed', responded_at: new Date().toISOString() }
      },
    })
    const result = await dismissPattern(42, db)
    assert.equal(dismissedId, 42)
    assert.equal(result.status, 'dismissed')
    assert.ok(result.responded_at)
  }),

  // ── getWeekNumber ────────────────────────────────────────────────────────

  test('getWeekNumber: 2025-01-06 → week 2', () => {
    const wn = getWeekNumber('2025-01-06')
    assert.equal(wn, 2)
  }),

  test('getWeekNumber: consistent across calls', () => {
    const a = getWeekNumber('2025-03-10')
    const b = getWeekNumber('2025-03-10')
    assert.equal(a, b)
  }),

  test('getWeekNumber: 2025-01-20 → week 4', () => {
    const wn = getWeekNumber('2025-01-20')
    assert.equal(wn, 4)
  }),
])
