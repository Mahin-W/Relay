import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getConsecutiveDayStreak,
  detectCalloutPatterns,
  generateContextualWarnings,
  formatContextualWarnings,
} from '../../intelligence/contextualWarnings.js'

function makeDb(calloutHistory = {}) {
  return {
    getCalloutHistory: async (groupId, staffName) => calloutHistory[staffName] || [],
  }
}

await Promise.all([
  // ── getConsecutiveDayStreak ──

  test('getConsecutiveDayStreak: 6 consecutive Mon-Sat → streak:6, warning:false', () => {
    const result = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    assert.equal(result.streak, 6)
    assert.equal(result.warning, false)
    assert.deepEqual(result.days, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
  }),

  test('getConsecutiveDayStreak: 7 consecutive Mon-Sun → streak:7, warning:true', () => {
    const result = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    assert.equal(result.streak, 7)
    assert.equal(result.warning, true)
  }),

  test('getConsecutiveDayStreak: 1 day Wed → streak:1', () => {
    const result = getConsecutiveDayStreak(['Wednesday'])
    assert.equal(result.streak, 1)
  }),

  test('getConsecutiveDayStreak: non-consecutive Mon,Tue,Thu,Fri,Sat → streak:3 (Thu-Fri-Sat)', () => {
    const result = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday'])
    assert.equal(result.streak, 3)
    assert.deepEqual(result.days, ['Thursday', 'Friday', 'Saturday'])
  }),

  // ── detectCalloutPatterns ──

  test('detectCalloutPatterns: 3 callouts in 5 Fridays → flagged with calloutCount:3', async () => {
    const db = makeDb({
      Alice: [{ day_of_week: 'Friday', shift_name: 'Closing', count: 3, total_scheduled: 5 }],
    })
    const assignments = [{ staffName: 'Alice', dayOfWeek: 'Friday', shiftName: 'Closing' }]
    const result = await detectCalloutPatterns('g1', assignments, db)
    assert.equal(result.length, 1)
    assert.equal(result[0].staffName, 'Alice')
    assert.equal(result[0].calloutCount, 3)
    assert.equal(result[0].totalScheduled, 5)
    assert.equal(result[0].warning, true) // 3/5 = 60% >= 50%
  }),

  test('detectCalloutPatterns: 1 callout in 5 → not flagged (count < 2)', async () => {
    const db = makeDb({
      Bob: [{ day_of_week: 'Friday', shift_name: 'Closing', count: 1, total_scheduled: 5 }],
    })
    const assignments = [{ staffName: 'Bob', dayOfWeek: 'Friday', shiftName: 'Closing' }]
    const result = await detectCalloutPatterns('g1', assignments, db)
    assert.equal(result.length, 0)
  }),

  test('detectCalloutPatterns: empty history → empty array', async () => {
    const db = makeDb({})
    const assignments = [{ staffName: 'Charlie', dayOfWeek: 'Monday', shiftName: 'Opening' }]
    const result = await detectCalloutPatterns('g1', assignments, db)
    assert.equal(result.length, 0)
  }),

  // ── generateContextualWarnings ──

  test('generateContextualWarnings: Carlos 6 days + Marcus 3/5 Friday callouts', async () => {
    const db = makeDb({
      Marcus: [{ day_of_week: 'Friday', shift_name: 'Closing', count: 3, total_scheduled: 5 }],
    })
    const assignments = [
      { staffName: 'Carlos', dayOfWeek: 'Monday', shiftName: 'Opening' },
      { staffName: 'Carlos', dayOfWeek: 'Tuesday', shiftName: 'Opening' },
      { staffName: 'Carlos', dayOfWeek: 'Wednesday', shiftName: 'Opening' },
      { staffName: 'Carlos', dayOfWeek: 'Thursday', shiftName: 'Opening' },
      { staffName: 'Carlos', dayOfWeek: 'Friday', shiftName: 'Opening' },
      { staffName: 'Carlos', dayOfWeek: 'Saturday', shiftName: 'Opening' },
      { staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Closing' },
    ]
    const result = await generateContextualWarnings('g1', assignments, db)
    // Carlos has 6-day streak → note (not warning, since < 7)
    const carlosNote = result.notes.find(n => n.staffName === 'Carlos')
    assert.ok(carlosNote, 'Carlos should appear in notes')
    // Marcus has 3/5 callout rate (60%) → warning
    const marcusEntry = result.warnings.find(w => w.staffName === 'Marcus')
    assert.ok(marcusEntry, 'Marcus should appear in warnings')
  }),

  test('generateContextualWarnings: empty assignments → empty warnings and notes', async () => {
    const db = makeDb({})
    const result = await generateContextualWarnings('g1', [], db)
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.notes, [])
  }),

  // ── formatContextualWarnings ──

  test('formatContextualWarnings: contains staff names and messages', () => {
    const warnings = [{ staffName: 'Marcus', message: 'Marcus called out 3/5 Fridays (60%)' }]
    const notes = [{ staffName: 'Carlos', message: 'Carlos is scheduled 6 consecutive days' }]
    const result = formatContextualWarnings(warnings, notes)
    assert.ok(result.includes('Marcus'))
    assert.ok(result.includes('Carlos'))
    assert.ok(result.includes('A few things from recent history'))
  }),

  test('formatContextualWarnings: null when both empty', () => {
    const result = formatContextualWarnings([], [])
    assert.equal(result, null)
  }),

  test('formatContextualWarnings: warnings show ⚠️, notes show 💭', () => {
    const warnings = [{ staffName: 'A', message: 'warn msg' }]
    const notes = [{ staffName: 'B', message: 'note msg' }]
    const result = formatContextualWarnings(warnings, notes)
    assert.ok(result.includes('⚠️'))
    assert.ok(result.includes('💭'))
    assert.ok(result.includes('Review before approving'))
  }),
])
