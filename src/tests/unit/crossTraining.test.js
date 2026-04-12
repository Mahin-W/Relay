import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'

// ── Phase 1: DB + pure logic tests (no LLM, run in parallel) ──────────────

const mockStaff = [
  { id: 1, name: 'Marcus', roleId: 1 },
  { id: 2, name: 'Sarah', roleId: 2 },
]

const mockRoles = [
  { id: 1, name: 'Server' },
  { id: 2, name: 'Chef' },
  { id: 3, name: 'Bartender' },
]

// MockDB adapter for cross-training tables
function makeCTDb() {
  const records = []
  let _id = 1
  return {
    _records: records,
    saveCrossTraining: async (groupId, staffId, roleId, proficiency) => {
      const existing = records.find(
        r => r.group_id === String(groupId) && r.staff_id === staffId && r.role_id === roleId && r.active
      )
      if (existing) {
        existing.proficiency = proficiency
        existing.updated_at = new Date().toISOString()
        return existing
      }
      const inactive = records.find(
        r => r.group_id === String(groupId) && r.staff_id === staffId && r.role_id === roleId && !r.active
      )
      if (inactive) {
        inactive.active = true
        inactive.proficiency = proficiency
        inactive.updated_at = new Date().toISOString()
        return inactive
      }
      const row = {
        id: _id++,
        group_id: String(groupId),
        staff_id: staffId,
        role_id: roleId,
        proficiency,
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      records.push(row)
      return row
    },
    removeCrossTraining: async (groupId, staffId, roleId) => {
      const rec = records.find(
        r => r.group_id === String(groupId) && r.staff_id === staffId && r.role_id === roleId && r.active
      )
      if (rec) { rec.active = false; return true }
      return false
    },
    getCrossTrainingForStaff: async (staffId, groupId, includeTraining) => {
      return records
        .filter(r =>
          r.staff_id === staffId &&
          r.group_id === String(groupId) &&
          r.active &&
          (includeTraining || r.proficiency !== 'training')
        )
        .map(r => ({ roleId: r.role_id, roleName: mockRoles.find(rl => rl.id === r.role_id)?.name ?? 'Unknown', proficiency: r.proficiency }))
    },
    getCrossTrainedForRole: async (groupId, roleId) => {
      return records
        .filter(r =>
          r.group_id === String(groupId) &&
          r.role_id === roleId &&
          r.active &&
          r.proficiency !== 'training'
        )
        .sort((a, b) => {
          const order = { proficient: 0, competent: 1 }
          return (order[a.proficiency] ?? 2) - (order[b.proficiency] ?? 2)
        })
        .map(r => ({
          staffId: r.staff_id,
          staffName: mockStaff.find(s => s.id === r.staff_id)?.name ?? 'Unknown',
          proficiency: r.proficiency,
        }))
    },
    getAllCrossTraining: async (groupId) => {
      const active = records.filter(r => r.group_id === String(groupId) && r.active)
      const grouped = {}
      for (const r of active) {
        if (!grouped[r.staff_id]) grouped[r.staff_id] = []
        grouped[r.staff_id].push({
          roleId: r.role_id,
          roleName: mockRoles.find(rl => rl.id === r.role_id)?.name ?? 'Unknown',
          proficiency: r.proficiency,
        })
      }
      return grouped
    },
    getStaffForGroup: async (groupId) => mockStaff.map(s => ({ id: s.id, name: s.name, role: mockRoles.find(r => r.id === s.roleId)?.name })),
    getRolesForGroup: async (groupId) => mockRoles,
  }
}

// ── saveCrossTraining ──

await Promise.all([
  test('saveCrossTraining: saves with correct proficiency', async () => {
    const { saveCrossTraining } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    const result = await saveCrossTraining('g1', 1, 3, 'competent', db)
    assert.equal(result.staff_id, 1)
    assert.equal(result.role_id, 3)
    assert.equal(result.proficiency, 'competent')
    assert.equal(result.active, true)
  }),

  test('saveCrossTraining: second save upserts, not duplicates', async () => {
    const { saveCrossTraining } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 3, 'competent', db)
    const result = await saveCrossTraining('g1', 1, 3, 'proficient', db)
    assert.equal(result.proficiency, 'proficient')
    assert.equal(db._records.filter(r => r.active).length, 1)
  }),

  test('saveCrossTraining: returns saved record', async () => {
    const { saveCrossTraining } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    const result = await saveCrossTraining('g1', 2, 1, 'training', db)
    assert.ok(result.id)
    assert.equal(result.group_id, 'g1')
    assert.equal(result.staff_id, 2)
  }),

  // ── getCrossTrainedForRole ──

  test('getCrossTrainedForRole: proficient returned before competent', async () => {
    const { saveCrossTraining, getCrossTrainedForRole } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 2, 3, 'competent', db)
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    const result = await getCrossTrainedForRole('g1', 3, db)
    assert.equal(result.length, 2)
    assert.equal(result[0].proficiency, 'proficient')
    assert.equal(result[1].proficiency, 'competent')
  }),

  test('getCrossTrainedForRole: training level excluded', async () => {
    const { saveCrossTraining, getCrossTrainedForRole } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 3, 'training', db)
    await saveCrossTraining('g1', 2, 3, 'competent', db)
    const result = await getCrossTrainedForRole('g1', 3, db)
    assert.equal(result.length, 1)
    assert.equal(result[0].staffId, 2)
  }),

  test('getCrossTrainedForRole: empty when no cross-trained staff', async () => {
    const { getCrossTrainedForRole } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    const result = await getCrossTrainedForRole('g1', 3, db)
    assert.deepEqual(result, [])
  }),

  // ── getCrossTrainingForStaff ──

  test('getCrossTrainingForStaff: returns all roles for staff', async () => {
    const { saveCrossTraining, getCrossTrainingForStaff } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 2, 'competent', db)
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    const result = await getCrossTrainingForStaff(1, 'g1', false, db)
    assert.equal(result.length, 2)
  }),

  test('getCrossTrainingForStaff: includeTraining false excludes training', async () => {
    const { saveCrossTraining, getCrossTrainingForStaff } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 2, 'training', db)
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    const result = await getCrossTrainingForStaff(1, 'g1', false, db)
    assert.equal(result.length, 1)
    assert.equal(result[0].proficiency, 'proficient')
  }),

  test('getCrossTrainingForStaff: includeTraining true includes all', async () => {
    const { saveCrossTraining, getCrossTrainingForStaff } = await import('../../intelligence/crossTrainingDb.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 2, 'training', db)
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    const result = await getCrossTrainingForStaff(1, 'g1', true, db)
    assert.equal(result.length, 2)
  }),

  // ── formatCrossTrainingRoster ──

  test('formatCrossTrainingRoster: groups by staff name', async () => {
    const { saveCrossTraining } = await import('../../intelligence/crossTrainingDb.js')
    const { formatCrossTrainingRoster } = await import('../../intelligence/crossTraining.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 2, 'competent', db)
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    await saveCrossTraining('g1', 2, 1, 'competent', db)
    const result = await formatCrossTrainingRoster('g1', db)
    assert.ok(result.includes('Marcus'))
    assert.ok(result.includes('Sarah'))
  }),

  test('formatCrossTrainingRoster: shows proficiency per role', async () => {
    const { saveCrossTraining } = await import('../../intelligence/crossTrainingDb.js')
    const { formatCrossTrainingRoster } = await import('../../intelligence/crossTraining.js')
    const db = makeCTDb()
    await saveCrossTraining('g1', 1, 3, 'proficient', db)
    const result = await formatCrossTrainingRoster('g1', db)
    assert.ok(result.includes('proficient'))
    assert.ok(result.includes('Bartender'))
  }),

  test('formatCrossTrainingRoster: empty returns helpful message', async () => {
    const { formatCrossTrainingRoster } = await import('../../intelligence/crossTraining.js')
    const db = makeCTDb()
    const result = await formatCrossTrainingRoster('g1', db)
    assert.ok(result.length > 10)
    assert.ok(result.toLowerCase().includes('no cross-train'))
  }),

  // ── generateSchedule cross-training integration ──

  test('generateSchedule: cross-trained staff fills gap', async () => {
    const { generateWeeklySchedule } = await import('../../schedule/generateSchedule.js')
    const db = makeCTDb()
    // Sarah is cross-trained as Bartender (proficient). Marcus fills Server, Sarah fills Bartender via CT.
    await db.saveCrossTraining('g1', 2, 3, 'proficient')
    const mockData = {
      shifts: [{ id: 10, name: 'AM', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '3:00 PM' }],
      staff: [
        { id: 1, name: 'Marcus', role: 'Server', userId: 100, dmChatId: '100' },
        { id: 2, name: 'Sarah', role: 'Chef', userId: 200, dmChatId: '200' },
      ],
      availability: [
        { user_id: 100, available_all: true },
        { user_id: 200, available_all: true },
      ],
      requirements: [
        { shift_id: 10, role: 'Server', count: 1, roleId: 1 },
        { shift_id: 10, role: 'Bartender', count: 1, roleId: 3 },
      ],
      crossTrainingDb: db,
    }
    const result = await generateWeeklySchedule('g1', '2026-04-06', mockData)
    const bartenderAssignment = result.assignments.find(a => a.roleName === 'Bartender')
    assert.ok(bartenderAssignment, `Bartender role should be filled via cross-training. Assignments: ${JSON.stringify(result.assignments)}`)
    assert.ok(result.crossTrainingUsed?.length > 0, 'crossTrainingUsed should be populated')
  }),

  test('generateSchedule: only competent/proficient used, not training', async () => {
    const { generateWeeklySchedule } = await import('../../schedule/generateSchedule.js')
    const db = makeCTDb()
    await db.saveCrossTraining('g1', 2, 3, 'training')
    const mockData = {
      shifts: [{ id: 10, name: 'AM', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '3:00 PM' }],
      staff: [
        { id: 1, name: 'Marcus', role: 'Server', userId: 100, dmChatId: '100' },
        { id: 2, name: 'Sarah', role: 'Chef', userId: 200, dmChatId: '200' },
      ],
      availability: [
        { user_id: 100, available_all: true },
        { user_id: 200, available_all: true },
      ],
      requirements: [
        { shift_id: 10, role: 'Server', count: 1 },
        { shift_id: 10, role: 'Bartender', count: 1, roleId: 3 },
      ],
      crossTrainingDb: db,
    }
    const result = await generateWeeklySchedule('g1', '2026-04-06', mockData)
    const bartenderAssignment = result.assignments.find(a => a.roleName === 'Bartender')
    assert.equal(bartenderAssignment, undefined, 'Training-level staff should not fill gaps')
  }),

  test('generateSchedule: cross-trained note added to result', async () => {
    const { generateWeeklySchedule } = await import('../../schedule/generateSchedule.js')
    const db = makeCTDb()
    await db.saveCrossTraining('g1', 2, 3, 'competent')
    const mockData = {
      shifts: [{ id: 10, name: 'AM', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '3:00 PM' }],
      staff: [
        { id: 1, name: 'Marcus', role: 'Server', userId: 100, dmChatId: '100' },
        { id: 2, name: 'Sarah', role: 'Chef', userId: 200, dmChatId: '200' },
      ],
      availability: [
        { user_id: 100, available_all: true },
        { user_id: 200, available_all: true },
      ],
      requirements: [
        { shift_id: 10, role: 'Chef', count: 1 },
        { shift_id: 10, role: 'Bartender', count: 1, roleId: 3 },
      ],
      crossTrainingDb: db,
    }
    const result = await generateWeeklySchedule('g1', '2026-04-06', mockData)
    assert.ok(Array.isArray(result.crossTrainingUsed))
    if (result.crossTrainingUsed.length > 0) {
      assert.ok(result.crossTrainingUsed[0].includes('cross-training'))
    }
  }),

  test('generateSchedule: already-assigned staff not double-assigned on same shift+day', async () => {
    const { generateWeeklySchedule } = await import('../../schedule/generateSchedule.js')
    const db = makeCTDb()
    await db.saveCrossTraining('g1', 1, 2, 'proficient')
    await db.saveCrossTraining('g1', 1, 3, 'proficient')
    const mockData = {
      shifts: [{ id: 10, name: 'AM', day_of_week: 'Monday', start_time: '9:00 AM', end_time: '3:00 PM' }],
      staff: [
        { id: 1, name: 'Marcus', role: 'Server', userId: 100, dmChatId: '100' },
      ],
      availability: [
        { user_id: 100, available_all: true },
      ],
      requirements: [
        { shift_id: 10, role: 'Server', count: 1 },
        { shift_id: 10, role: 'Chef', count: 1, roleId: 2 },
        { shift_id: 10, role: 'Bartender', count: 1, roleId: 3 },
      ],
      crossTrainingDb: db,
    }
    const result = await generateWeeklySchedule('g1', '2026-04-06', mockData)
    const marcusAssignments = result.assignments.filter(a => a.staffId === 1 && a.shiftId === 10 && a.dayOfWeek === 'Monday')
    assert.equal(marcusAssignments.length, 1, `Marcus should only be assigned once per shift+day, got ${marcusAssignments.length}`)
  }),
])

// ── Phase 2: LLM tests (Cerebras, sequential) ──────────────────────────────

describe('extractCrossTrainingMention (LLM)', () => {
  it('"Marcus can also work prep if needed" -> isCrossTraining:true, competent', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'Marcus can also work prep if needed', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, true)
    assert.ok(result.staffName?.toLowerCase().includes('marcus'))
    assert.equal(result.proficiency, 'competent')
    assert.equal(result.direction, 'add')
  })

  it('"Sarah is training on bar" -> isCrossTraining:true, training', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'Sarah is training on bar', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, true)
    assert.equal(result.proficiency, 'training')
  })

  it('"Marcus is fully certified on bartending" -> isCrossTraining:true, proficient', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'Marcus is fully certified on bartending', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, true)
    assert.equal(result.proficiency, 'proficient')
  })

  it('"Marcus no longer does prep" -> direction:remove', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'Marcus no longer does prep', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, true)
    assert.equal(result.direction, 'remove')
  })

  it('"the kitchen was slammed tonight" -> isCrossTraining:false', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'the kitchen was slammed tonight', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, false)
  })

  it('"everyone can work host" -> isCrossTraining:false (no specific staff)', async () => {
    const { extractCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const result = await extractCrossTrainingMention(
      'everyone can work host', mockStaff, mockRoles
    )
    assert.equal(result.isCrossTraining, false)
  })
})

describe('handleCrossTrainingMention', () => {
  it('saves and confirms for add', async () => {
    const { handleCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const bot = new MockBot()
    const db = makeCTDb()
    const msg = {
      text: 'Marcus can also tend bar',
      chat: { id: '-100', type: 'group' },
      from: { id: 1001 },
    }
    const result = await handleCrossTrainingMention(bot, msg, '-100', db)
    assert.equal(result, true)
    const sent = bot.lastMessage('-100')
    assert.ok(sent, 'Bot should send confirmation')
    assert.ok(sent.text.toLowerCase().includes('cross-train') || sent.text.toLowerCase().includes('marcus'))
  })

  it('removes and confirms for remove', async () => {
    const { handleCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const bot = new MockBot()
    const db = makeCTDb()
    await db.saveCrossTraining('-100', 1, 3, 'competent')
    const msg = {
      text: 'Marcus no longer does bartender',
      chat: { id: '-100', type: 'group' },
      from: { id: 1001 },
    }
    const result = await handleCrossTrainingMention(bot, msg, '-100', db)
    assert.equal(result, true)
    const sent = bot.lastMessage('-100')
    assert.ok(sent)
  })

  it('returns false for non-CT message', async () => {
    const { handleCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const bot = new MockBot()
    const db = makeCTDb()
    const msg = {
      text: 'the kitchen was slammed tonight',
      chat: { id: '-100', type: 'group' },
      from: { id: 1001 },
    }
    const result = await handleCrossTrainingMention(bot, msg, '-100', db)
    assert.equal(result, false)
  })

  it('returns false when no staff name resolved', async () => {
    const { handleCrossTrainingMention } = await import('../../intelligence/crossTraining.js')
    const bot = new MockBot()
    const db = makeCTDb()
    const msg = {
      text: 'everyone can work host',
      chat: { id: '-100', type: 'group' },
      from: { id: 1001 },
    }
    const result = await handleCrossTrainingMention(bot, msg, '-100', db)
    assert.equal(result, false)
  })
})
