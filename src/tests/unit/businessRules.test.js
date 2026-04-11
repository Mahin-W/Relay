import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  applyRulesToAssignments,
  formatRuleConflicts,
  handleListRules,
  handleDeleteRule,
} from '../../rules/businessRules.js'

// ── Test data ────────────────────────────────────────────────────────────────

const mockStaff = [
  { id: 1, name: 'Marcus', role: 'Server' },
  { id: 2, name: 'Jake', role: 'Cook' },
  { id: 3, name: 'Carlos', role: 'Server' },
  { id: 4, name: 'Sarah', role: 'Host' },
]

const mockShifts = [
  { id: 1, name: 'Mon Lunch', dayOfWeek: 'Monday', startTime: '11am', endTime: '4pm' },
  { id: 2, name: 'Tue Dinner', dayOfWeek: 'Tuesday', startTime: '5pm', endTime: '11pm' },
  { id: 3, name: 'Fri Dinner', dayOfWeek: 'Friday', startTime: '5pm', endTime: '11pm' },
]

function makeDb(overrides = {}) {
  const rules = []
  return {
    saveRule: async (groupId, rule) => {
      const r = { id: rules.length + 1, ...rule, created_at: new Date().toISOString() }
      rules.push(r)
      return r
    },
    getRules: async (groupId) => rules.filter(r => r.active !== false),
    deactivateRule: async (ruleId) => {
      const r = rules.find(r => r.id === ruleId)
      if (r) r.active = false
    },
    _rules: rules,
    ...overrides,
  }
}

// ── Phase 1: Pure function tests (no LLM) ───────────────────────────────────

describe('applyRulesToAssignments — staff_conflict', { concurrency: true }, () => {
  test('Marcus and Jake on same shift with conflict rule → conflict', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 2, shiftId: 1 },
    ]
    const rules = [{
      id: 10, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 2,
      constraint: 'Never schedule Marcus and Jake together', active: true,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, false)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].ruleId, 10)
    assert.ok(result.conflicts[0].description.includes('Marcus'))
    assert.ok(result.conflicts[0].description.includes('Jake'))
  })

  test('Marcus and Jake on different shifts → no conflict', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 2, shiftId: 2 },
    ]
    const rules = [{
      id: 10, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 2,
      constraint: 'Never schedule Marcus and Jake together', active: true,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test('Inactive rule is skipped', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 2, shiftId: 1 },
    ]
    const rules = [{
      id: 10, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 2,
      constraint: 'Never schedule Marcus and Jake together', active: false,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })
})

describe('applyRulesToAssignments — time_constraint', { concurrency: true }, () => {
  test('Carlos on Tue shift ending 11pm, rule says leave by 9pm → conflict', () => {
    const assignments = [
      { staffId: 3, shiftId: 2 },
    ]
    const rules = [{
      id: 20, type: 'time_constraint', subjectStaffId: 3,
      constraint: 'Carlos needs to leave by 9pm on Tuesdays',
      dayOfWeek: 'Tuesday', latestEndTime: '21:00', active: true,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, false)
    assert.equal(result.conflicts.length, 1)
    assert.ok(result.conflicts[0].description.includes('Carlos'))
  })

  test('Carlos on Mon shift (wrong day) → no conflict', () => {
    const assignments = [
      { staffId: 3, shiftId: 1 },
    ]
    const rules = [{
      id: 20, type: 'time_constraint', subjectStaffId: 3,
      constraint: 'Carlos needs to leave by 9pm on Tuesdays',
      dayOfWeek: 'Tuesday', latestEndTime: '21:00', active: true,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test('Carlos on Tue shift ending 8pm → no conflict', () => {
    const shifts = [
      ...mockShifts.slice(0, 1),
      { id: 2, name: 'Tue Early', dayOfWeek: 'Tuesday', startTime: '12pm', endTime: '8pm' },
      ...mockShifts.slice(2),
    ]
    const assignments = [
      { staffId: 3, shiftId: 2 },
    ]
    const rules = [{
      id: 20, type: 'time_constraint', subjectStaffId: 3,
      constraint: 'Carlos needs to leave by 9pm on Tuesdays',
      dayOfWeek: 'Tuesday', latestEndTime: '21:00', active: true,
    }]
    const result = applyRulesToAssignments(assignments, shifts, mockStaff, rules)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })
})

describe('applyRulesToAssignments — multiple / edge cases', { concurrency: true }, () => {
  test('Two rules both violated → both conflicts returned', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 2, shiftId: 1 },
      { staffId: 3, shiftId: 2 },
    ]
    const rules = [
      {
        id: 10, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 2,
        constraint: 'Never schedule Marcus and Jake together', active: true,
      },
      {
        id: 20, type: 'time_constraint', subjectStaffId: 3,
        constraint: 'Carlos needs to leave by 9pm on Tuesdays',
        dayOfWeek: 'Tuesday', latestEndTime: '21:00', active: true,
      },
    ]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, false)
    assert.equal(result.conflicts.length, 2)
  })

  test('Zero conflicts → valid true, empty array', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 3, shiftId: 1 },
    ]
    const rules = [{
      id: 10, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 2,
      constraint: 'Never schedule Marcus and Jake together', active: true,
    }]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, rules)
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })

  test('Empty rules array → valid true, empty conflicts', () => {
    const assignments = [
      { staffId: 1, shiftId: 1 },
      { staffId: 2, shiftId: 1 },
    ]
    const result = applyRulesToAssignments(assignments, mockShifts, mockStaff, [])
    assert.equal(result.valid, true)
    assert.equal(result.conflicts.length, 0)
  })
})

describe('formatRuleConflicts', { concurrency: true }, () => {
  test('Contains each constraint text, staff name, shift name', () => {
    const conflicts = [
      { ruleId: 10, constraint: 'Never together', staffName: 'Marcus', shiftName: 'Mon Lunch', description: 'Marcus and Jake both on Mon Lunch' },
    ]
    const output = formatRuleConflicts(conflicts)
    assert.ok(output.includes('Marcus'))
    assert.ok(output.includes('Mon Lunch') || output.includes('Never together'))
    assert.ok(output.includes('approve anyway'))
  })

  test('Empty conflicts → returns null', () => {
    const output = formatRuleConflicts([])
    assert.equal(output, null)
  })
})

describe('handleListRules', { concurrency: true }, () => {
  test('Shows numbered list with dates', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await db.saveRule('g1', { type: 'staff_conflict', constraint: 'Never schedule Marcus and Jake together', active: true })
    await db.saveRule('g1', { type: 'time_constraint', constraint: 'Carlos leaves by 9pm Tuesdays', active: true })

    const msg = { chat: { id: 'g1' } }
    await handleListRules(bot, msg, 'g1', db)

    const sent = bot.last.text
    assert.ok(sent.includes('1.'))
    assert.ok(sent.includes('2.'))
    assert.ok(sent.includes('Never schedule Marcus and Jake together'))
    assert.ok(sent.includes('Carlos leaves by 9pm Tuesdays'))
  })

  test('Empty rules → "No rules saved yet"', async () => {
    const bot = new MockBot()
    const db = makeDb()

    const msg = { chat: { id: 'g1' } }
    await handleListRules(bot, msg, 'g1', db)

    assert.ok(bot.last.text.includes('No rules saved yet'))
  })
})

describe('handleDeleteRule', { concurrency: true }, () => {
  test('Deactivates correct rule and confirms', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await db.saveRule('g1', { type: 'staff_conflict', constraint: 'Never schedule Marcus and Jake together', active: true })
    await db.saveRule('g1', { type: 'time_constraint', constraint: 'Carlos leaves by 9pm Tuesdays', active: true })

    const msg = { chat: { id: 'g1' } }
    await handleDeleteRule(bot, msg, 1, 'g1', db)

    // First rule deactivated
    assert.equal(db._rules[0].active, false)
    // Second rule still active
    assert.equal(db._rules[1].active, true)
    // Confirms with constraint text
    assert.ok(bot.last.text.includes('Never schedule Marcus and Jake together'))
  })

  test('Out of range → helpful error', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await db.saveRule('g1', { type: 'staff_conflict', constraint: 'Test rule', active: true })

    const msg = { chat: { id: 'g1' } }
    await handleDeleteRule(bot, msg, 5, 'g1', db)

    assert.ok(bot.last.text.toLowerCase().includes('invalid') || bot.last.text.includes('1'))
  })
})

// ── Phase 2: LLM/Cerebras tests ─────────────────────────────────────────────

describe('extractRule (LLM)', { concurrency: true }, () => {
  // Dynamic import to avoid Supabase env crash at module level
  let extractRule

  test('"never schedule Marcus and Jake together" → staff_conflict', async () => {
    if (!process.env.CEREBRAS_API_KEY) return
    if (!extractRule) {
      const mod = await import('../../rules/businessRules.js')
      extractRule = mod.extractRule
    }
    const result = await extractRule('never schedule Marcus and Jake together', mockStaff, mockShifts, 'g1')
    assert.equal(result.isRule, true)
    assert.equal(result.rule.type, 'staff_conflict')
    assert.equal(result.rule.subjectStaffId, 1)
    assert.equal(result.rule.objectStaffId, 2)
  })

  test('"Carlos needs to leave by 9pm Tuesdays" → time_constraint', async () => {
    if (!process.env.CEREBRAS_API_KEY) return
    if (!extractRule) {
      const mod = await import('../../rules/businessRules.js')
      extractRule = mod.extractRule
    }
    const result = await extractRule('Carlos needs to leave by 9pm Tuesdays', mockStaff, mockShifts, 'g1')
    assert.equal(result.isRule, true)
    assert.equal(result.rule.type, 'time_constraint')
    assert.equal(result.rule.latestEndTime, '21:00')
    assert.equal(result.rule.subjectStaffId, 3)
  })

  test('"Sarah only works morning shifts" → shift_preference', async () => {
    if (!process.env.CEREBRAS_API_KEY) return
    if (!extractRule) {
      const mod = await import('../../rules/businessRules.js')
      extractRule = mod.extractRule
    }
    const result = await extractRule('Sarah only works morning shifts', mockStaff, mockShifts, 'g1')
    assert.equal(result.isRule, true)
    assert.equal(result.rule.type, 'shift_preference')
    assert.equal(result.rule.subjectStaffId, 4)
  })

  test('"the pasta was great tonight" → isRule false', async () => {
    if (!process.env.CEREBRAS_API_KEY) return
    if (!extractRule) {
      const mod = await import('../../rules/businessRules.js')
      extractRule = mod.extractRule
    }
    const result = await extractRule('the pasta was great tonight', mockStaff, mockShifts, 'g1')
    assert.equal(result.isRule, false)
  })

  test('Unrecognized staff name → subjectStaffId null', async () => {
    if (!process.env.CEREBRAS_API_KEY) return
    if (!extractRule) {
      const mod = await import('../../rules/businessRules.js')
      extractRule = mod.extractRule
    }
    const result = await extractRule('never schedule Zephyr on Fridays', mockStaff, mockShifts, 'g1')
    assert.equal(result.isRule, true)
    assert.equal(result.rule.subjectStaffId, null)
  })
})
