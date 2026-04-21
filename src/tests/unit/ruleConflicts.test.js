// G3 (3.11): detectRuleConflicts must flag contradictory business rules.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectRuleConflicts } from '../../rules/businessRules.js'

describe('detectRuleConflicts', { concurrency: false }, () => {
  test('day_off + always-required same staff same day → conflict', () => {
    const rules = [
      { id: 1, type: 'day_off', subjectStaffId: 10, subject_staff_id: 10,
        dayOfWeek: 'Wednesday', day_of_week: 'Wednesday', active: true,
        constraint_text: 'Devon off Wednesday', constraint: 'Devon off Wednesday' },
      { id: 2, type: 'always-required', subjectStaffId: 10, subject_staff_id: 10,
        dayOfWeek: 'Wednesday', day_of_week: 'Wednesday', active: true,
        constraint_text: 'Devon must work Thursday dinner', constraint: 'Devon must work Thursday dinner' },
    ]
    const conflicts = detectRuleConflicts(rules)
    assert.ok(Array.isArray(conflicts), 'returns array')
    assert.ok(conflicts.length >= 1, `Expected at least 1 conflict, got: ${JSON.stringify(conflicts)}`)
    assert.ok(conflicts[0].ruleIdA && conflicts[0].ruleIdB, 'conflict has ruleIdA and ruleIdB')
    assert.ok(typeof conflicts[0].description === 'string', 'conflict has description string')
  })

  test('duplicate rules (same type, same subject, same constraint_text) → conflict', () => {
    const rules = [
      { id: 10, type: 'day_off', subjectStaffId: 5, subject_staff_id: 5,
        dayOfWeek: 'Monday', day_of_week: 'Monday', active: true,
        constraint_text: 'Marcus off Mondays', constraint: 'Marcus off Mondays' },
      { id: 11, type: 'day_off', subjectStaffId: 5, subject_staff_id: 5,
        dayOfWeek: 'Monday', day_of_week: 'Monday', active: true,
        constraint_text: 'Marcus off Mondays', constraint: 'Marcus off Mondays' },
    ]
    const conflicts = detectRuleConflicts(rules)
    assert.ok(conflicts.length >= 1, `Expected duplicate conflict, got: ${JSON.stringify(conflicts)}`)
  })

  test('always-required + never-together for same subject → conflict', () => {
    const rules = [
      { id: 20, type: 'always-required', subjectStaffId: 7, subject_staff_id: 7,
        dayOfWeek: 'Thursday', day_of_week: 'Thursday', active: true,
        constraint_text: 'Devon must work Thursday dinner' },
      { id: 21, type: 'never-together', subjectStaffId: 7, subject_staff_id: 7,
        objectStaffId: 8, object_staff_id: 8, active: true,
        constraint_text: 'Devon and Sam never together' },
    ]
    const conflicts = detectRuleConflicts(rules)
    assert.ok(conflicts.length >= 1, `Expected never-together+always-required conflict: ${JSON.stringify(conflicts)}`)
  })

  test('no contradictions → empty array', () => {
    const rules = [
      { id: 30, type: 'day_off', subjectStaffId: 1, subject_staff_id: 1,
        dayOfWeek: 'Monday', day_of_week: 'Monday', active: true,
        constraint_text: 'Alice off Monday' },
      { id: 31, type: 'shift_preference', subjectStaffId: 2, subject_staff_id: 2,
        active: true, constraint_text: 'Bob prefers mornings' },
    ]
    const conflicts = detectRuleConflicts(rules)
    assert.equal(conflicts.length, 0, `Expected no conflicts, got: ${JSON.stringify(conflicts)}`)
  })

  test('inactive rules are skipped', () => {
    const rules = [
      { id: 40, type: 'day_off', subjectStaffId: 3, subject_staff_id: 3,
        dayOfWeek: 'Friday', day_of_week: 'Friday', active: false,
        constraint_text: 'Carol off Friday' },
      { id: 41, type: 'always-required', subjectStaffId: 3, subject_staff_id: 3,
        dayOfWeek: 'Friday', day_of_week: 'Friday', active: false,
        constraint_text: 'Carol always Friday' },
    ]
    const conflicts = detectRuleConflicts(rules)
    assert.equal(conflicts.length, 0, 'Inactive rules must not produce conflicts')
  })

  test('empty rules → empty array', () => {
    assert.deepEqual(detectRuleConflicts([]), [])
  })
})
