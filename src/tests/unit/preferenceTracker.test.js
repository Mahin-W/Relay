import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEditFromMessage,
  analyzePatterns,
  applyPreferencesToDraft,
  formatPreferenceSummary,
  formatNewPatternAlert
} from '../../intelligence/preferenceTracker.js'
import {
  saveEditEvent,
  getEditHistory,
  savePreference,
  getPreferences
} from '../../intelligence/preferenceDb.js'

const mockStaff = [
  { id: 1, name: 'Sarah', role: 'Server' },
  { id: 2, name: 'Jake', role: 'Cook' },
  { id: 3, name: 'Marcus', role: 'Server' }
]
const mockShifts = [
  { id: 1, name: 'Monday Lunch', dayOfWeek: 'Monday', startTime: '11am', endTime: '4pm' },
  { id: 2, name: 'Friday Dinner', dayOfWeek: 'Friday', startTime: '5pm', endTime: '11pm' }
]

function makeDb() {
  const edits = []
  const prefs = []
  return {
    saveEditEvent: async (groupId, edit) => {
      const e = { id: edits.length + 1, ...edit, created_at: new Date().toISOString() }
      edits.push(e)
      return e
    },
    getEditHistory: async (groupId, weeksBack) => edits,
    savePreference: async (groupId, pref) => {
      prefs.push(pref)
      return pref
    },
    getPreferences: async (groupId) => prefs.filter(p => p.confidence >= 0.6),
    _edits: edits,
    _prefs: prefs
  }
}

// --- parseEditFromMessage tests ---

describe('parseEditFromMessage', () => {
  test('remove Sarah from Monday', () => {
    const result = parseEditFromMessage('remove Sarah from Monday', {}, mockStaff, mockShifts)
    assert.equal(result.type, 'remove')
    assert.equal(result.staffName, 'Sarah')
    assert.equal(result.staffId, 1)
    assert.equal(result.dayOfWeek, 'Monday')
  })

  test('swap Jake to Friday dinner', () => {
    const result = parseEditFromMessage('swap Jake to Friday dinner', {}, mockStaff, mockShifts)
    assert.equal(result.type, 'swap')
    assert.equal(result.staffName, 'Jake')
    assert.equal(result.staffId, 2)
  })

  test('add Marcus to Saturday', () => {
    const result = parseEditFromMessage('add Marcus to Saturday', {}, mockStaff, mockShifts)
    assert.equal(result.type, 'add')
    assert.equal(result.staffName, 'Marcus')
    assert.equal(result.staffId, 3)
  })

  test('looks good returns null', () => {
    const result = parseEditFromMessage('looks good', {}, mockStaff, mockShifts)
    assert.equal(result, null)
  })

  test('approve returns null', () => {
    const result = parseEditFromMessage('approve', {}, mockStaff, mockShifts)
    assert.equal(result, null)
  })

  test('case insensitive: REMOVE sarah FROM monday', () => {
    const result = parseEditFromMessage('REMOVE sarah FROM monday', {}, mockStaff, mockShifts)
    assert.equal(result.type, 'remove')
    assert.equal(result.staffName, 'Sarah')
    assert.equal(result.staffId, 1)
    assert.equal(result.dayOfWeek, 'Monday')
  })

  test('partial name "Sar" matches Sarah', () => {
    const result = parseEditFromMessage('remove Sar from Monday', {}, mockStaff, mockShifts)
    assert.equal(result.staffId, 1)
    assert.equal(result.staffName, 'Sarah')
  })

  test('move Sarah off Mondays -> remove', () => {
    const result = parseEditFromMessage('move Sarah off Mondays', {}, mockStaff, mockShifts)
    assert.equal(result.type, 'remove')
    assert.equal(result.staffName, 'Sarah')
    assert.equal(result.staffId, 1)
    assert.equal(result.dayOfWeek, 'Monday')
  })
})

// --- analyzePatterns tests ---

describe('analyzePatterns', () => {
  test('5 remove Sarah Monday edits over 8 weeks -> confidence 0.625', () => {
    const history = Array.from({ length: 5 }, () => ({
      type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null
    }))
    const patterns = analyzePatterns(history, 8)
    assert.equal(patterns.length, 1)
    assert.equal(patterns[0].count, 5)
    assert.equal(patterns[0].confidence, 0.625)
    assert.equal(patterns[0].staffName, 'Sarah')
    assert.equal(patterns[0].dayOfWeek, 'Monday')
    assert.ok(patterns[0].description.includes('Sarah'))
  })

  test('2 edits -> count 2, above minimum', () => {
    const history = [
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null },
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null }
    ]
    const patterns = analyzePatterns(history, 8)
    assert.equal(patterns.length, 1)
    assert.equal(patterns[0].count, 2)
  })

  test('1 edit -> below minimum, not returned', () => {
    const history = [
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null }
    ]
    const patterns = analyzePatterns(history, 8)
    assert.equal(patterns.length, 0)
  })

  test('mixed edits -> only consistent ones returned', () => {
    const history = [
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null },
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null },
      { type: 'remove', staff_id: 1, staff_name: 'Sarah', day_of_week: 'Monday', from_shift_id: null, to_shift_id: null },
      { type: 'swap', staff_id: 2, staff_name: 'Jake', day_of_week: null, from_shift_id: null, to_shift_id: 2 },
      // only 1 swap, not returned
    ]
    const patterns = analyzePatterns(history, 8)
    assert.equal(patterns.length, 1)
    assert.equal(patterns[0].staffName, 'Sarah')
  })

  test('empty history -> empty array', () => {
    const patterns = analyzePatterns([], 8)
    assert.deepEqual(patterns, [])
  })
})

// --- applyPreferencesToDraft tests ---

describe('applyPreferencesToDraft', () => {
  test('Sarah avoid_day Monday, autoApply true -> removed from Monday', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 2, staffName: 'Jake', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 1, staffName: 'Sarah', shiftId: 2, dayOfWeek: 'Friday' }
    ]
    const preferences = [
      { type: 'avoid_day', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday', shiftId: null, confidence: 0.8, autoApply: true }
    ]
    const { newAssignments, applied } = applyPreferencesToDraft(assignments, preferences, mockShifts, mockStaff)
    assert.equal(newAssignments.length, 2)
    assert.ok(!newAssignments.some(a => a.staffId === 1 && a.dayOfWeek === 'Monday'))
    assert.equal(applied.length, 1)
  })

  test('autoApply false -> assignments unchanged', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 2, staffName: 'Jake', shiftId: 1, dayOfWeek: 'Monday' }
    ]
    const preferences = [
      { type: 'avoid_day', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday', shiftId: null, confidence: 0.8, autoApply: false }
    ]
    const { newAssignments, applied } = applyPreferencesToDraft(assignments, preferences, mockShifts, mockStaff)
    assert.equal(newAssignments.length, 2)
    assert.equal(applied.length, 0)
  })

  test('gap protection: removing Sarah would leave Monday empty -> SKIP', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 2, staffName: 'Jake', shiftId: 2, dayOfWeek: 'Friday' }
    ]
    const preferences = [
      { type: 'avoid_day', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday', shiftId: null, confidence: 0.8, autoApply: true }
    ]
    const { newAssignments, applied } = applyPreferencesToDraft(assignments, preferences, mockShifts, mockStaff)
    // Sarah should still be there — removing her would leave Monday empty
    assert.equal(newAssignments.length, 2)
    assert.equal(applied.length, 0)
  })

  test('returns applied array describing changes', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 2, staffName: 'Jake', shiftId: 1, dayOfWeek: 'Monday' },
    ]
    const preferences = [
      { type: 'avoid_day', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday', shiftId: null, confidence: 0.8, autoApply: true }
    ]
    const { applied } = applyPreferencesToDraft(assignments, preferences, mockShifts, mockStaff)
    assert.equal(applied.length, 1)
    assert.ok(applied[0].description)
    assert.ok(applied[0].preference)
  })

  test('no preferences -> identical assignments', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' }
    ]
    const { newAssignments, applied } = applyPreferencesToDraft(assignments, [], mockShifts, mockStaff)
    assert.deepEqual(newAssignments, assignments)
    assert.equal(applied.length, 0)
  })

  test('avoid_shift removes staff from specific shift', () => {
    const assignments = [
      { staffId: 1, staffName: 'Sarah', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 2, staffName: 'Jake', shiftId: 1, dayOfWeek: 'Monday' },
      { staffId: 1, staffName: 'Sarah', shiftId: 2, dayOfWeek: 'Friday' }
    ]
    const preferences = [
      { type: 'avoid_shift', staffId: 1, staffName: 'Sarah', dayOfWeek: null, shiftId: 1, confidence: 0.8, autoApply: true }
    ]
    const { newAssignments, applied } = applyPreferencesToDraft(assignments, preferences, mockShifts, mockStaff)
    assert.equal(newAssignments.length, 2)
    assert.ok(!newAssignments.some(a => a.staffId === 1 && a.shiftId === 1))
    assert.equal(applied.length, 1)
  })
})

// --- formatPreferenceSummary tests ---

describe('formatPreferenceSummary', () => {
  test('lists each applied preference', () => {
    const applied = [
      { preference: { staffName: 'Sarah', dayOfWeek: 'Monday' }, description: 'Sarah: off Mondays (consistent last 6 weeks)' },
      { preference: { staffName: 'Jake', shiftId: 2 }, description: 'Jake: Friday dinner (your usual choice)' }
    ]
    const result = formatPreferenceSummary(applied)
    assert.ok(result.includes('Sarah'))
    assert.ok(result.includes('Jake'))
    assert.ok(result.includes('preferences'))
  })

  test('empty -> returns null', () => {
    assert.equal(formatPreferenceSummary([]), null)
  })
})

// --- formatNewPatternAlert tests ---

describe('formatNewPatternAlert', () => {
  test('contains staff name and day', () => {
    const pattern = { staffName: 'Sarah', dayOfWeek: 'Monday', type: 'remove' }
    const result = formatNewPatternAlert(pattern)
    assert.ok(result.includes('Sarah'))
    assert.ok(result.includes('Monday'))
  })

  test('contains staff name and shift', () => {
    const pattern = { staffName: 'Jake', shiftName: 'Friday Dinner', type: 'swap' }
    const result = formatNewPatternAlert(pattern)
    assert.ok(result.includes('Jake'))
    assert.ok(result.includes('Friday Dinner'))
  })
})

// --- DB mock tests ---

describe('preferenceDb with mock', () => {
  test('saveEditEvent stores and returns edit', async () => {
    const db = makeDb()
    const edit = { type: 'remove', staffId: 1, staffName: 'Sarah', fromShiftId: null, toShiftId: null, dayOfWeek: 'Monday', reason: null, weekStart: '2026-04-06' }
    const result = await saveEditEvent(123, edit, db)
    assert.equal(result.type, 'remove')
    assert.equal(result.staffName, 'Sarah')
    assert.ok(result.id)
    assert.ok(result.created_at)
  })

  test('getEditHistory returns stored edits', async () => {
    const db = makeDb()
    await saveEditEvent(123, { type: 'remove', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday' }, db)
    await saveEditEvent(123, { type: 'swap', staffId: 2, staffName: 'Jake', dayOfWeek: 'Friday' }, db)
    const history = await getEditHistory(123, 8, db)
    assert.equal(history.length, 2)
  })

  test('savePreference stores preference', async () => {
    const db = makeDb()
    const pref = { type: 'avoid_day', staffId: 1, staffName: 'Sarah', dayOfWeek: 'Monday', shiftId: null, confidence: 0.75, sampleSize: 6, autoApply: true }
    const result = await savePreference(123, pref, db)
    assert.equal(result.type, 'avoid_day')
  })

  test('getPreferences filters by confidence >= 0.6', async () => {
    const db = makeDb()
    await savePreference(123, { type: 'avoid_day', staffId: 1, confidence: 0.75, autoApply: true }, db)
    await savePreference(123, { type: 'avoid_day', staffId: 2, confidence: 0.3, autoApply: false }, db)
    const prefs = await getPreferences(123, db)
    assert.equal(prefs.length, 1)
    assert.equal(prefs[0].staffId, 1)
  })
})
