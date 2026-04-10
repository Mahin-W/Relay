# Four Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement rotation fairness tracking, copy-last-week schedule, new-hire onboarding detection, and partial shift coverage — four independent features built in sequence with TDD.

**Architecture:** Each feature follows the existing pattern: pure functions + DB layer + handler, wired into groupRouter.js switch and/or index.js bot.onText. Tests use MockBot/MockDB from helpers/mocks.js. Groq intent tests call real API with dotenv/config. No modifications to run-tests-parallel.js — run tests individually via `node --test`.

**Tech Stack:** Node.js 25, ES modules, Supabase (postgres), Groq (llama-3.1-8b-instant), node-telegram-bot-api, node:test + assert/strict

---

## Background: Existing Patterns to Follow

**db=null injection (exact pattern from requestHandler.js):**
```js
export async function handleFoo(bot, msg, intent, db = null) {
  const _saveThing = db?.saveThing ?? liveSaveThing
  const _getThing  = db?.getThing  ?? liveGetThing
  // use _saveThing, _getThing throughout
}
```

**Groq retry (from parsers/groq.js):**
```js
import { groq, groqWithRetry } from '../parsers/groq.js'
const completion = await groqWithRetry(() => groq.chat.completions.create({ ... }))
```

**Test message helpers (from tests/helpers/mocks.js):**
```js
import { MockBot, makeGroupMsg, makeDMMsg } from '../helpers/mocks.js'
const bot = new MockBot()
const msg = makeGroupMsg({ text: '...', from: { id: 101, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
```

**FAST_SUITES suite object format (for run-tests-parallel.js — add manually later):**
```js
{ id: 'unit_FEATURE', file: 'unit/FEATURE.test.js', label: 'Unit — FEATURE', timeout: 10_000 }
```

**All new test files run with:**
```bash
node --env-file=.env --test src/tests/unit/FEATURE.test.js
```

---

## Feature 1: Rotation Fairness Tracking

### Files
- **CREATE** `src/fairness/rotationDb.js` — raw Supabase queries (getRotationScores, getRecentShiftHistory, getGroupShiftHistory)
- **CREATE** `src/fairness/rotationTracker.js` — pure functions + orchestration (isDesirableShift, buildRotationPriorityMap, applyRotationToAssignments, getRotationReport)
- **CREATE** `src/tests/unit/rotationTracker.test.js` — all tests
- **MODIFY** `src/schedule/generateSchedule.js:194-207` — wire fairness after greedy loop (live-mode only)
- **MODIFY** `src/index.js:107` — add `/rotation` command before `process.on('SIGINT')`

---

### Task 1.1 — Write all rotationTracker tests (RED)

- [ ] Create `src/tests/unit/rotationTracker.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDesirableShift, applyRotationToAssignments, buildRotationPriorityMap, getRotationReport } from '../../fairness/rotationTracker.js'

// ── isDesirableShift ─────────────────────────────────────────────────────────

test('isDesirableShift: Friday → true', () => {
  assert.equal(isDesirableShift({ name: 'Lunch', day_of_week: 'Friday', end_time: '3pm' }), true)
})

test('isDesirableShift: Saturday → true', () => {
  assert.equal(isDesirableShift({ name: 'Brunch', day_of_week: 'Saturday', end_time: '2pm' }), true)
})

test('isDesirableShift: Tuesday Dinner → true (name contains dinner)', () => {
  assert.equal(isDesirableShift({ name: 'Dinner Service', day_of_week: 'Tuesday', end_time: '10pm' }), true)
})

test('isDesirableShift: Monday Evening → true (name contains evening)', () => {
  assert.equal(isDesirableShift({ name: 'Evening Shift', day_of_week: 'Monday', end_time: '11pm' }), true)
})

test('isDesirableShift: Tuesday Lunch 3pm → false', () => {
  assert.equal(isDesirableShift({ name: 'Lunch', day_of_week: 'Tuesday', end_time: '3pm' }), false)
})

test('isDesirableShift: Wednesday ends 21:00 → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Wednesday', end_time: '21:00' }), true)
})

test('isDesirableShift: Thursday ends 20:59 → false', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Thursday', end_time: '20:59' }), false)
})

test('isDesirableShift: endTime 9pm → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '9pm' }), true)
})

test('isDesirableShift: endTime 21:00 → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '21:00' }), true)
})

test('isDesirableShift: endTime 9:00pm → true', () => {
  assert.equal(isDesirableShift({ name: 'Shift', day_of_week: 'Monday', end_time: '9:00pm' }), true)
})

// ── applyRotationToAssignments ───────────────────────────────────────────────

const MOCK_SHIFTS = [
  { id: 1, name: 'Friday Dinner', day_of_week: 'Friday', end_time: '11pm' },
  { id: 2, name: 'Tuesday Lunch', day_of_week: 'Tuesday', end_time: '3pm' },
]

test('applyRotation: non-desirable shifts unchanged', () => {
  const assignments = [
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 10, staffName: 'Alice', roleName: 'server' },
  ]
  const priorityMap = new Map([[2, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  assert.equal(result[0].staffId, 10, 'non-desirable shift should not change')
})

test('applyRotation: staff with 0 recent desirable history gets priority over staff with 3', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  // priorityMap says Bob (20) should get shiftId 1 (Bob has 0 recent, Alice has 3)
  const priorityMap = new Map([
    [1, [20, 10]],
    [2, [10, 20]],
  ])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayA = result.find(a => a.shiftId === 1)
  assert.equal(fridayA.staffId, 20, 'Bob (0 recent) should be swapped onto Friday Dinner')
})

test('applyRotation: no double bookings introduced after rotation', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
    // Bob is also on Friday already — should NOT be swapped onto Friday Dinner (would be double-booking on Friday)
    { shiftId: 99, shiftName: 'Friday Lunch', dayOfWeek: 'Friday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  const priorityMap = new Map([[1, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayDinner = result.find(a => a.shiftId === 1)
  assert.equal(fridayDinner.staffId, 10, 'Alice should stay — Bob is already on Friday (double booking prevented)')
})

test('applyRotation: role constraints preserved (chef stays chef)', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'chef' },
    { shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', staffId: 20, staffName: 'Bob', roleName: 'server' },
  ]
  // Bob (server) has higher priority for shiftId 1 but is wrong role
  const priorityMap = new Map([[1, [20, 10]]])
  const result = applyRotationToAssignments(assignments, priorityMap, MOCK_SHIFTS)
  const fridayA = result.find(a => a.shiftId === 1)
  assert.equal(fridayA.staffId, 10, 'Alice should keep Friday Dinner — Bob is server not chef')
  assert.equal(fridayA.roleName, 'chef')
})

test('applyRotation: empty assignments → empty result', () => {
  const result = applyRotationToAssignments([], new Map(), MOCK_SHIFTS)
  assert.deepEqual(result, [])
})

test('applyRotation: no priorityMap entry for shift → unchanged', () => {
  const assignments = [
    { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 10, staffName: 'Alice', roleName: 'server' },
  ]
  const result = applyRotationToAssignments(assignments, new Map(), MOCK_SHIFTS)
  assert.equal(result[0].staffId, 10)
})

// ── buildRotationPriorityMap (mock DB) ───────────────────────────────────────

test('buildRotationPriorityMap returns a Map', async () => {
  const mockDb = { getRotationScores: async () => [] }
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, [], mockDb)
  assert.ok(result instanceof Map)
})

test('buildRotationPriorityMap: Map key is shiftId, value is array of staffIds', async () => {
  const mockDb = { getRotationScores: async () => [] }
  const staff = [{ staffId: 10, name: 'Alice', role: 'server' }]
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, staff, mockDb)
  assert.ok(result.has(1))
  assert.ok(Array.isArray(result.get(1)))
})

test('buildRotationPriorityMap: staff with fewer recent = earlier in priority array', async () => {
  const mockDb = {
    getRotationScores: async (groupId, shiftId) => {
      if (shiftId === 1) return [
        { staffId: 20, staffName: 'Bob', recentCount: 0 },
        { staffId: 10, staffName: 'Alice', recentCount: 3 },
      ]
      return []
    },
  }
  const staff = [{ staffId: 10, name: 'Alice', role: 'server' }, { staffId: 20, name: 'Bob', role: 'server' }]
  const result = await buildRotationPriorityMap('g1', MOCK_SHIFTS, staff, mockDb)
  const order = result.get(1)
  assert.equal(order[0], 20, 'Bob (0 recent) should be index 0')
  assert.equal(order[1], 10, 'Alice (3 recent) should be index 1')
})

// ── getRotationReport (mock DB) ──────────────────────────────────────────────

test('getRotationReport returns array sorted DESC by desirableShiftsWorked', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-13' },
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-20' },
      { staffId: 20, staffName: 'Bob', shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', endTime: '3pm', weekStart: '2025-01-06' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].staffId, 10, 'Alice first (3 desirable shifts)')
  assert.equal(result[0].desirableShiftsWorked, 3)
  assert.equal(result[1].staffId, 20, 'Bob second (0 desirable shifts)')
  assert.equal(result[1].desirableShiftsWorked, 0)
})

test('getRotationReport: correct totalShiftsWorked count', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
      { staffId: 10, staffName: 'Alice', shiftId: 2, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', endTime: '3pm', weekStart: '2025-01-06' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].totalShiftsWorked, 2)
})

test('getRotationReport: lastDesirableShiftName populated', async () => {
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-13' },
    ],
  }
  const result = await getRotationReport('g1', 4, mockDb)
  assert.equal(result[0].lastDesirableShiftName, 'Friday Dinner')
  assert.equal(result[0].lastDesirableShiftDate, '2025-01-13')
})

// ── /rotation command (MockBot) ───────────────────────────────────────────────

test('/rotation: sends report to group', async () => {
  const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
  const { handleRotationCommand } = await import('../../fairness/rotationTracker.js')
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 101, first_name: 'Alice' } })
  const mockDb = {
    getGroupShiftHistory: async () => [
      { staffId: 10, staffName: 'Alice', shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', endTime: '11pm', weekStart: '2025-01-06' },
    ],
  }
  await handleRotationCommand(bot, msg, mockDb)
  const sent = bot.lastMessage('-100')
  assert.ok(sent.text.includes('Alice'), 'report should include staff name')
  assert.ok(sent.text.includes('1'), 'should show desirable shift count')
})

test('/rotation: shows "No shift history" when empty', async () => {
  const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
  const { handleRotationCommand } = await import('../../fairness/rotationTracker.js')
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 101, first_name: 'Alice' } })
  const mockDb = { getGroupShiftHistory: async () => [] }
  await handleRotationCommand(bot, msg, mockDb)
  const sent = bot.lastMessage('-100')
  assert.ok(sent.text.includes('No shift history') || sent.text.includes('publish a schedule'), 'empty state message')
})

test('/rotation: blocked for non-admins', async () => {
  const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
  const { handleRotationCommand } = await import('../../fairness/rotationTracker.js')
  const bot = new MockBot()
  // do NOT setAdmin
  const msg = makeGroupMsg({ chat: { id: '-100', type: 'group', title: 'Test' }, from: { id: 999, first_name: 'Rando' } })
  const mockDb = { getGroupShiftHistory: async () => [] }
  await handleRotationCommand(bot, msg, mockDb)
  assert.ok(!bot.lastMessage('-100'), 'non-admin should get no reply')
})
```

- [ ] Run: `node --env-file=.env --test src/tests/unit/rotationTracker.test.js`
- [ ] Confirm: all tests FAIL with "Cannot find module" or similar (modules don't exist yet)

---

### Task 1.2 — Implement rotationDb.js

- [ ] Create `src/fairness/rotationDb.js`:

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function getRotationScores(groupId, shiftId, weeksBack = 4) {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - weeksBack * 7)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select('staff_id')
      .eq('group_id', groupId)
      .eq('shift_id', shiftId)
      .gte('week_start', cutoffStr)
    if (error) throw error

    const counts = {}
    for (const row of data ?? []) {
      counts[row.staff_id] = (counts[row.staff_id] ?? 0) + 1
    }

    const staffIds = Object.keys(counts).map(Number)
    if (!staffIds.length) return []

    const { data: staffRows, error: sErr } = await supabase
      .from('staff').select('id, name').in('id', staffIds)
    if (sErr) throw sErr

    const nameMap = Object.fromEntries((staffRows ?? []).map(s => [s.id, s.name]))
    return staffIds
      .map(id => ({ staffId: id, staffName: nameMap[id] ?? 'Unknown', recentCount: counts[id] }))
      .sort((a, b) => a.recentCount - b.recentCount)
  } catch (err) {
    logger.error(`getRotationScores failed: ${err.message}`)
    return []
  }
}

export async function getGroupShiftHistory(groupId, weeksBack = 4) {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - weeksBack * 7)
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const { data: assignments, error } = await supabase
      .from('schedule_assignments')
      .select('staff_id, shift_id, week_start')
      .eq('group_id', groupId)
      .gte('week_start', cutoffStr)
    if (error) throw error
    if (!assignments?.length) return []

    const shiftIds = [...new Set(assignments.map(a => a.shift_id))]
    const staffIds = [...new Set(assignments.map(a => a.staff_id))]

    const [{ data: shifts }, { data: staffRows }] = await Promise.all([
      supabase.from('shifts').select('id, name, day_of_week, end_time').in('id', shiftIds),
      supabase.from('staff').select('id, name').in('id', staffIds),
    ])

    const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
    const nameMap = Object.fromEntries((staffRows ?? []).map(s => [s.id, s.name]))

    return assignments.map(a => ({
      staffId: a.staff_id,
      staffName: nameMap[a.staff_id] ?? 'Unknown',
      shiftId: a.shift_id,
      shiftName: shiftMap[String(a.shift_id)]?.name ?? '',
      dayOfWeek: shiftMap[String(a.shift_id)]?.day_of_week ?? '',
      endTime: shiftMap[String(a.shift_id)]?.end_time ?? '',
      weekStart: a.week_start,
    }))
  } catch (err) {
    logger.error(`getGroupShiftHistory failed: ${err.message}`)
    return []
  }
}
```

- [ ] Run: `node --check src/fairness/rotationDb.js` — must exit 0

---

### Task 1.3 — Implement rotationTracker.js

- [ ] Create `src/fairness/rotationTracker.js`:

```js
import { getRotationScores as liveGetRotationScores, getGroupShiftHistory as liveGetGroupShiftHistory } from './rotationDb.js'

/**
 * Parse a time string to decimal hours (e.g. "9pm"→21, "21:00"→21, "9:00 PM"→21, "3pm"→15)
 */
function parseHour(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase()
  // HH:MM (24h)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return parseInt(h24[1], 10) + parseInt(h24[2], 10) / 60
  // H:MMam/pm or H:MM am/pm
  const h12full = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/)
  if (h12full) {
    let h = parseInt(h12full[1], 10)
    const min = parseInt(h12full[2], 10) / 60
    if (h12full[3] === 'pm' && h !== 12) h += 12
    if (h12full[3] === 'am' && h === 12) h = 0
    return h + min
  }
  // Hpm or H:MMpm (no space)
  const h12 = s.match(/^(\d{1,2})\s*(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1], 10)
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return h
  }
  return 0
}

/**
 * Pure function — no DB, no Groq.
 * Returns true if the shift is "desirable" (Fri/Sat, evening by name, or ends >= 21:00).
 */
export function isDesirableShift(shift) {
  const day = shift.day_of_week ?? shift.dayOfWeek ?? ''
  const name = (shift.name ?? '').toLowerCase()
  const endTime = shift.end_time ?? shift.endTime ?? ''

  if (day === 'Friday' || day === 'Saturday') return true
  if (name.includes('dinner') || name.includes('evening') || name.includes('night')) return true
  if (parseHour(endTime) >= 21) return true
  return false
}

/**
 * Builds Map<shiftId, staffId[]> — priority order ASC by recent count (fewest = index 0).
 */
export async function buildRotationPriorityMap(groupId, shifts, staff, db = null) {
  const _getRotationScores = db?.getRotationScores ?? liveGetRotationScores

  const map = new Map()
  await Promise.all(shifts.map(async (shift) => {
    const scores = await _getRotationScores(groupId, shift.id)
    // scores is sorted ASC by recentCount
    const scoreMap = new Map(scores.map(s => [s.staffId, s.recentCount]))
    const sorted = [...staff]
      .sort((a, b) => (scoreMap.get(a.staffId) ?? 0) - (scoreMap.get(b.staffId) ?? 0))
      .map(s => s.staffId)
    map.set(shift.id, sorted)
  }))
  return map
}

/**
 * Pure function — reorders assignments for desirable shifts based on priority.
 * Swaps current assignee with higher-priority person IF they have same role
 * and the swap won't cause a double-booking on the same day.
 */
export function applyRotationToAssignments(assignments, priorityMap, shifts) {
  if (!assignments.length) return []
  const shiftMap = new Map(shifts.map(s => [String(s.id), s]))
  const result = assignments.map(a => ({ ...a }))

  for (const [shiftId, priorityOrder] of priorityMap) {
    const shift = shiftMap.get(String(shiftId))
    if (!shift || !isDesirableShift(shift)) continue

    const desirableAssignments = result.filter(a => String(a.shiftId) === String(shiftId))

    for (const desA of desirableAssignments) {
      const currentIdx = priorityOrder.indexOf(desA.staffId)
      if (currentIdx <= 0) continue  // already highest priority or not in map

      // Look for a higher-priority candidate
      for (const candidateId of priorityOrder.slice(0, currentIdx)) {
        // Candidate must be in a different non-desirable assignment with same role
        const candidateA = result.find(a =>
          a.staffId === candidateId &&
          String(a.shiftId) !== String(shiftId) &&
          a.roleName === desA.roleName
        )
        if (!candidateA) continue

        // No double booking: candidate must not already be on the same day as desirable shift
        const candidateAlreadyOnDay = result.some(a =>
          a.staffId === candidateId &&
          a.dayOfWeek === desA.dayOfWeek &&
          String(a.shiftId) !== String(shiftId)
        )
        if (candidateAlreadyOnDay) continue

        // No double booking: current person must not already be on candidate's day
        const currentAlreadyOnCandidateDay = result.some(a =>
          a.staffId === desA.staffId &&
          a.dayOfWeek === candidateA.dayOfWeek &&
          a !== desA
        )
        if (currentAlreadyOnCandidateDay) continue

        // Do the swap
        const [tmpId, tmpName] = [desA.staffId, desA.staffName]
        desA.staffId = candidateA.staffId
        desA.staffName = candidateA.staffName
        candidateA.staffId = tmpId
        candidateA.staffName = tmpName
        break
      }
    }
  }

  return result
}

/**
 * Returns per-staff rotation summary sorted DESC by desirableShiftsWorked.
 */
export async function getRotationReport(groupId, weeksBack = 4, db = null) {
  const _getGroupShiftHistory = db?.getGroupShiftHistory ?? liveGetGroupShiftHistory

  const history = await _getGroupShiftHistory(groupId, weeksBack)
  if (!history.length) return []

  const statsMap = {}
  for (const row of history) {
    if (!statsMap[row.staffId]) {
      statsMap[row.staffId] = {
        staffId: row.staffId,
        staffName: row.staffName,
        desirableShiftsWorked: 0,
        totalShiftsWorked: 0,
        lastDesirableShiftDate: null,
        lastDesirableShiftName: null,
      }
    }
    const s = statsMap[row.staffId]
    s.totalShiftsWorked++
    if (isDesirableShift({ day_of_week: row.dayOfWeek, name: row.shiftName, end_time: row.endTime })) {
      s.desirableShiftsWorked++
      if (!s.lastDesirableShiftDate || row.weekStart > s.lastDesirableShiftDate) {
        s.lastDesirableShiftDate = row.weekStart
        s.lastDesirableShiftName = row.shiftName
      }
    }
  }

  return Object.values(statsMap).sort((a, b) => b.desirableShiftsWorked - a.desirableShiftsWorked)
}

/**
 * Called from index.js bot.onText(/\/rotation/).
 * Sends a rotation report to the group chat.
 */
export async function handleRotationCommand(bot, msg, db = null) {
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id

  // Admin check using bot.getChatMember
  try {
    const member = await bot.getChatMember(groupId, userId)
    const isAdmin = ['creator', 'administrator'].includes(member?.status)
    if (!isAdmin) return
  } catch {
    return
  }

  const report = await getRotationReport(groupId, 4, db)
  if (!report.length) {
    await bot.sendMessage(groupId,
      'No shift history yet — publish a schedule first.')
    return
  }

  const lines = report.map(r =>
    `• ${r.staffName}: ${r.desirableShiftsWorked} desirable / ${r.totalShiftsWorked} total` +
    (r.lastDesirableShiftName ? ` (last: ${r.lastDesirableShiftName})` : '')
  )
  await bot.sendMessage(groupId,
    `🔄 *Shift rotation — last 4 weeks*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' })
}
```

- [ ] Run: `node --check src/fairness/rotationTracker.js` — must exit 0
- [ ] Run: `node --env-file=.env --test src/tests/unit/rotationTracker.test.js`
- [ ] All tests must PASS (green)

---

### Task 1.4 — Wire fairness into generateSchedule.js

The insertion point is **after the greedy loop** (after line 193, before the clopening detection at line 198). Only apply in live mode (skip when `mockData` is present — keeps existing schedule tests unchanged).

- [ ] Edit `src/schedule/generateSchedule.js` — add import at top (after existing imports):

```js
import { buildRotationPriorityMap, applyRotationToAssignments } from '../fairness/rotationTracker.js'
```

- [ ] Edit `src/schedule/generateSchedule.js` — insert after line 193 (the closing `}` of the greedy for-loop), before `logger.bot(...)`:

```js
    // ── Apply rotation fairness (live mode only) ───────────────────────────────
    if (!mockData && assignments.length > 0) {
      try {
        const priorityMap = await buildRotationPriorityMap(groupId, shifts, resolvedStaff)
        const fairAssignments = applyRotationToAssignments(assignments, priorityMap, shifts)
        assignments.length = 0
        assignments.push(...fairAssignments)
      } catch (fairErr) {
        logger.error(`Rotation fairness failed (non-fatal): ${fairErr.message}`)
      }
    }
```

- [ ] Run: `node --check src/schedule/generateSchedule.js` — must exit 0
- [ ] Run: `node --env-file=.env --test src/tests/unit/scheduleGenerator.test.js` — all existing tests still pass

---

### Task 1.5 — Add /rotation command to index.js

- [ ] Edit `src/index.js` — add import at top (after existing imports):

```js
import { handleRotationCommand } from './fairness/rotationTracker.js'
```

- [ ] Edit `src/index.js` — insert before `process.on('SIGINT', ...)` (after the `/reliability` handler block):

```js
bot.onText(/^\/rotation/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  await handleRotationCommand(bot, msg)
})
```

- [ ] Run: `node --check src/index.js` — must exit 0

---

### Task 1.6 — Commit Feature 1

- [ ] `git add -A && git commit -m "feat: rotation fairness tracking"`

---

## Feature 2: Copy Last Week Schedule

### Files
- **CREATE** `src/schedule/copySchedule.js` — getNextWeekStart (re-exported from generateSchedule), getPreviousWeekSchedule, buildCopiedSchedule, detectStaleAssignments, handleCopySchedule
- **CREATE** `src/tests/unit/copySchedule.test.js` — all tests
- **MODIFY** `src/parsers/messageParsers.js:84-91` — add `COPY_SCHEDULE_REQUEST` to SYSTEM_PROMPT
- **MODIFY** `src/routing/groupRouter.js:47-96` — add `copy_schedule_request` case
- **MODIFY** `src/index.js` — add `/copyschedule` command

---

### Task 2.1 — Write all copySchedule tests (RED)

- [ ] Create `src/tests/unit/copySchedule.test.js`:

```js
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCopiedSchedule, detectStaleAssignments, getNextWeekStart } from '../../schedule/copySchedule.js'

// ── getNextWeekStart ─────────────────────────────────────────────────────────

test('getNextWeekStart returns a Monday (day index 1)', () => {
  const result = getNextWeekStart()
  const d = new Date(result + 'T12:00:00')
  assert.equal(d.getDay(), 1, 'should be Monday')
})

test('getNextWeekStart returns a future date', () => {
  const result = getNextWeekStart()
  const today = new Date().toISOString().split('T')[0]
  assert.ok(result > today, 'should be after today')
})

// ── buildCopiedSchedule ──────────────────────────────────────────────────────

const PREV_ASSIGNMENTS = [
  { shiftId: 'shift-1', shiftName: 'Monday Lunch', dayOfWeek: 'Monday', staffId: 10, staffName: 'Alice', roleName: 'server', userId: 101, dmChatId: 1001, startTime: '11am', endTime: '3pm' },
  { shiftId: 'shift-2', shiftName: 'Friday Dinner', dayOfWeek: 'Friday', staffId: 20, staffName: 'Bob', roleName: 'server', userId: 102, dmChatId: 1002, startTime: '6pm', endTime: '11pm' },
]
const NEW_WEEK = '2025-02-03'

test('buildCopiedSchedule: week_start updated to newWeekStart on all assignments', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  for (const a of result) assert.equal(a.weekStart, NEW_WEEK)
})

test('buildCopiedSchedule: same staffId/shiftId pairs preserved', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  assert.equal(result[0].staffId, 10)
  assert.equal(result[0].shiftId, 'shift-1')
  assert.equal(result[1].staffId, 20)
  assert.equal(result[1].shiftId, 'shift-2')
})

test('buildCopiedSchedule: status set to "scheduled" on all', () => {
  const result = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)
  for (const a of result) assert.equal(a.status, 'scheduled')
})

test('buildCopiedSchedule: empty array → empty result', () => {
  const result = buildCopiedSchedule([], NEW_WEEK)
  assert.deepEqual(result, [])
})

// ── detectStaleAssignments ────────────────────────────────────────────────────

const ACTIVE_STAFF = [{ id: 10, name: 'Alice' }, { id: 20, name: 'Bob' }]
const COPIED = buildCopiedSchedule(PREV_ASSIGNMENTS, NEW_WEEK)

test('detectStaleAssignments: active staff → goes to valid', () => {
  const { valid, stale } = detectStaleAssignments(COPIED, ACTIVE_STAFF)
  assert.equal(valid.length, 2)
  assert.equal(stale.length, 0)
})

test('detectStaleAssignments: removed staff → goes to stale', () => {
  const onlyAlice = [{ id: 10, name: 'Alice' }]  // Bob removed
  const { valid, stale } = detectStaleAssignments(COPIED, onlyAlice)
  assert.equal(valid.length, 1)
  assert.equal(stale.length, 1)
  assert.equal(stale[0].staffId, 20)
})

test('detectStaleAssignments: all active → stale is empty array', () => {
  const { stale } = detectStaleAssignments(COPIED, ACTIVE_STAFF)
  assert.deepEqual(stale, [])
})

test('detectStaleAssignments: all removed → valid is empty array', () => {
  const { valid } = detectStaleAssignments(COPIED, [])
  assert.deepEqual(valid, [])
})

// ── handleCopySchedule (MockBot + mock DB) ───────────────────────────────────

const { MockBot, makeGroupMsg } = await import('../helpers/mocks.js')
const { handleCopySchedule } = await import('../../schedule/copySchedule.js')

function makeMsg(text = '/copyschedule') {
  return makeGroupMsg({ text, from: { id: 101, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
}

function makeDb(overrides = {}) {
  return {
    getPreviousWeekSchedule: async () => ({
      assignments: PREV_ASSIGNMENTS,
      weekStart: '2025-01-27',
      id: 42,
    }),
    saveGeneratedSchedule: async () => ({ id: 99 }),
    getStaffForGroup: async () => ACTIVE_STAFF,
    getSetupSession: async () => ({ manager_id: 101, dm_chat_id: 9001 }),
    ...overrides,
  }
}

test('handleCopySchedule: sends draft to manager DM', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  const dmMessages = bot.messagesTo(9001)
  assert.ok(dmMessages.length > 0, 'should DM the manager')
})

test('handleCopySchedule: DM contains shift assignments', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  const dm = bot.messagesTo(9001)[0]
  assert.ok(dm.text.includes('Monday Lunch') || dm.text.includes('Alice'), 'should include schedule content')
})

test('handleCopySchedule: shows stale warning when inactive staff', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const db = makeDb({
    getStaffForGroup: async () => [{ id: 10, name: 'Alice' }],  // Bob removed
  })
  await handleCopySchedule(bot, makeMsg(), db)
  const dm = bot.messagesTo(9001)[0]
  assert.ok(dm.text.includes('Bob') || dm.text.includes('Removed') || dm.text.includes('no longer'), 'should warn about stale staff')
})

test('handleCopySchedule: no stale warning when all staff active', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  await handleCopySchedule(bot, makeMsg(), makeDb())
  const dm = bot.messagesTo(9001)[0]
  assert.ok(!dm.text.includes('Removed') && !dm.text.includes('no longer'), 'no stale warning needed')
})

test('handleCopySchedule: saves as draft not published', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  let savedStatus = null
  const db = makeDb({
    saveGeneratedSchedule: async (groupId, weekStart, assignments, gaps, status) => {
      savedStatus = status
      return { id: 99 }
    },
  })
  await handleCopySchedule(bot, makeMsg(), db)
  assert.equal(savedStatus, 'draft')
})

test('handleCopySchedule: "no schedule found" message when no previous schedule', async () => {
  const bot = new MockBot()
  bot.setAdmin('-100', 101)
  const db = makeDb({ getPreviousWeekSchedule: async () => null })
  await handleCopySchedule(bot, makeMsg(), db)
  const groupMsg = bot.messagesTo('-100')[0]
  assert.ok(groupMsg.text.includes('No published schedule') || groupMsg.text.includes('generate a new one'), 'should explain no schedule found')
})

test('handleCopySchedule: blocked for non-admins', async () => {
  const bot = new MockBot()
  // NOT setAdmin
  const msg = makeGroupMsg({ text: '/copyschedule', from: { id: 999, first_name: 'Rando' }, chat: { id: '-100', type: 'group' } })
  await handleCopySchedule(bot, msg, makeDb())
  const groupMsgs = bot.messagesTo('-100')
  const hasWarning = groupMsgs.some(m => m.text.includes('Only admins') || m.text.includes('admin'))
  assert.ok(hasWarning, 'non-admin should get blocked message')
})

test('handleCopySchedule: does not work in DMs (group only)', async () => {
  const bot = new MockBot()
  const dmMsg = makeMsg()
  dmMsg.chat.type = 'private'
  await handleCopySchedule(bot, dmMsg, makeDb())
  assert.ok(!bot.lastMessage(dmMsg.chat.id), 'should be silent in DMs')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "same as last week" → copy_schedule_request', async () => {
  const r = await parseMessage('same as last week', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "copy last week schedule" → copy_schedule_request', async () => {
  const r = await parseMessage("copy last week's schedule", 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "just repeat the schedule" → copy_schedule_request', async () => {
  const r = await parseMessage('just repeat the schedule from last week', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'copy_schedule_request')
})

test('[LLM] "can anyone cover my shift" → NOT copy_schedule_request', async () => {
  const r = await parseMessage('can anyone cover my shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'copy_schedule_request')
})

test('[LLM] "my schedule" → NOT copy_schedule_request', async () => {
  const r = await parseMessage('what is my schedule', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'copy_schedule_request')
})
```

- [ ] Run: `node --env-file=.env --test src/tests/unit/copySchedule.test.js`
- [ ] Confirm: tests FAIL (module not found)

---

### Task 2.2 — Implement copySchedule.js

`getNextWeekStart` already exists in `generateSchedule.js` — re-export from there.

- [ ] Create `src/schedule/copySchedule.js`:

```js
import { getNextWeekStart as liveGetNextWeekStart, formatScheduleMessage } from './generateSchedule.js'
import { getPublishedSchedule, saveGeneratedSchedule as liveSaveGeneratedSchedule } from '../availability/availabilityDb.js'
import { getStaffForGroup as liveGetStaffForGroup, getSetupSession as liveGetSetupSession } from '../setup/setupDb.js'
import { logger } from '../logger.js'

export { getNextWeekStart } from './generateSchedule.js'

export async function getPreviousWeekSchedule(groupId, db = null) {
  const _getPublishedSchedule = db?.getPreviousWeekSchedule ?? (() => getPublishedSchedule(groupId))
  const data = await _getPublishedSchedule()
  if (!data) return null
  return {
    assignments: data.assignments ?? [],
    weekStart: data.week_start,
    id: data.id,
  }
}

/**
 * Pure — clones assignments with new weekStart and status='scheduled'.
 */
export function buildCopiedSchedule(previousAssignments, newWeekStart) {
  return previousAssignments.map(a => ({
    ...a,
    weekStart: newWeekStart,
    status: 'scheduled',
  }))
}

/**
 * Pure — splits copied assignments into valid (staff still active) and stale (removed).
 */
export function detectStaleAssignments(copiedAssignments, activeStaff) {
  const activeIds = new Set(activeStaff.map(s => s.id))
  const valid = copiedAssignments.filter(a => activeIds.has(a.staffId))
  const stale = copiedAssignments.filter(a => !activeIds.has(a.staffId))
  return { valid, stale }
}

export async function handleCopySchedule(bot, msg, db = null) {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return

  const groupId = String(msg.chat.id)
  const userId = msg.from?.id

  // Admin check
  try {
    const member = await bot.getChatMember(groupId, userId)
    const isAdmin = ['creator', 'administrator'].includes(member?.status)
    if (!isAdmin) {
      await bot.sendMessage(groupId, '⚠️ Only admins can copy the schedule.')
      return
    }
  } catch {
    await bot.sendMessage(groupId, '⚠️ Only admins can copy the schedule.')
    return
  }

  const _getPreviousWeekSchedule = db?.getPreviousWeekSchedule ?? (() => getPublishedSchedule(groupId).then(d => d ? { assignments: d.assignments ?? [], weekStart: d.week_start, id: d.id } : null))
  const _saveGeneratedSchedule = db?.saveGeneratedSchedule ?? liveSaveGeneratedSchedule
  const _getStaffForGroup = db?.getStaffForGroup ?? (() => liveGetStaffForGroup(groupId))
  const _getSetupSession = db?.getSetupSession ?? (() => liveGetSetupSession(groupId))

  const prev = await _getPreviousWeekSchedule()
  if (!prev) {
    await bot.sendMessage(groupId,
      'No published schedule found to copy. Use /makeschedule to generate a new one.')
    return
  }

  const newWeekStart = liveGetNextWeekStart()
  const copied = buildCopiedSchedule(prev.assignments, newWeekStart)
  const activeStaff = await _getStaffForGroup()
  const { valid, stale } = detectStaleAssignments(copied, activeStaff)

  await _saveGeneratedSchedule(groupId, newWeekStart, valid, [], 'draft')

  const session = await _getSetupSession()
  if (!session?.dm_chat_id) {
    logger.error('handleCopySchedule: no dm_chat_id for group ' + groupId)
    return
  }

  const scheduleText = formatScheduleMessage(valid, [], newWeekStart)
  const staleText = stale.length > 0
    ? `\n⚠️ *Removed (no longer active):*\n${stale.map(s => `• ${s.staffName} — was on ${s.shiftName}`).join('\n')}`
    : ''

  await bot.sendMessage(session.dm_chat_id,
    `📋 *Draft — copied from last week*\n\n${scheduleText}${staleText}\n\nReply *approve* to publish, or *regenerate* to build from scratch.`,
    { parse_mode: 'Markdown' })
}
```

Note: `saveGeneratedSchedule` in `availabilityDb.js` takes `(groupId, weekStart, assignments, gaps)` — it doesn't accept a `status` parameter. The draft status is set automatically by that function. Pass `status` as 5th arg and ignore it, or use the existing function as-is (it always saves as 'draft'). The test checks `savedStatus === 'draft'`, so just always save as draft which the real function does.

- [ ] Run: `node --check src/schedule/copySchedule.js` — must exit 0

---

### Task 2.3 — Add intent to messageParsers.js SYSTEM_PROMPT

Add the new intent **before** the `SCHEDULE_UPDATE` line (around line 80). Edit `src/parsers/messageParsers.js`:

- [ ] In the SYSTEM_PROMPT string, find `SCHEDULE_UPDATE` section and insert before it:

```
COPY_SCHEDULE_REQUEST — manager wants to repeat last week's schedule as-is:
{"type":"copy_schedule_request","person":null}

Common copy_schedule_request phrases: 'same as last week', 'copy last week', 'repeat last week', 'just do the same schedule', 'same schedule as before', 'copy the schedule', 'use last week again'
MUST NOT trigger on: 'can anyone cover' (coverage_request), 'my schedule' (irrelevant), 'make a new schedule' (irrelevant)

```

- [ ] Run: `node --check src/parsers/messageParsers.js` — must exit 0

---

### Task 2.4 — Wire into groupRouter.js

- [ ] Edit `src/routing/groupRouter.js` — add import at top:

```js
import { handleCopySchedule } from '../schedule/copySchedule.js'
```

- [ ] In the `switch (intent.type)` block, add case before `default:`:

```js
      case 'copy_schedule_request':
        await handleCopySchedule(bot, msg)
        break
```

- [ ] Run: `node --check src/routing/groupRouter.js` — must exit 0

---

### Task 2.5 — Add /copyschedule to index.js

- [ ] Edit `src/index.js` — add import at top:

```js
import { handleCopySchedule } from './schedule/copySchedule.js'
```

- [ ] Add before `process.on('SIGINT', ...)`:

```js
bot.onText(/^\/copyschedule/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  await handleCopySchedule(bot, msg)
})
```

- [ ] Run: `node --check src/index.js` — must exit 0
- [ ] Run: `node --env-file=.env --test src/tests/unit/copySchedule.test.js`
- [ ] All non-LLM tests must PASS. LLM tests require `.env` with valid GROQ_API_KEY.

---

### Task 2.6 — Commit Feature 2

- [ ] `git add -A && git commit -m "feat: copy last week schedule"`

---

## Feature 3: New Hire Onboarding Detection

### Files
- **CREATE** `src/onboarding/onboardingDb.js` — saveOnboardingRecord, completeOnboarding, getPendingOnboarding
- **CREATE** `src/onboarding/handleNewHire.js` — handleNewHireAnnouncement, handleNewHireRegistration
- **CREATE** `src/tests/unit/newHire.test.js` — all tests
- **MODIFY** `src/parsers/messageParsers.js` — add new_hire_announcement intent
- **MODIFY** `src/routing/groupRouter.js` — add case
- **MODIFY** `src/routing/dmRouter.js:38-53` — enhance register_ handler
- **MODIFY** `src/index.js` — add /welcome command

---

### Task 3.1 — Write all newHire tests (RED)

- [ ] Create `src/tests/unit/newHire.test.js`:

```js
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeGroupMsg, makeDMMsg } from '../helpers/mocks.js'
import { handleNewHireAnnouncement, handleNewHireRegistration } from '../../onboarding/handleNewHire.js'

const GROUP_ID = '-100'
const MANAGER_DM = 9001
const BOT_USERNAME = 'RelayTestBot'

function makeDb(overrides = {}) {
  const records = []
  return {
    getSetupSession: async () => ({ manager_id: 101, dm_chat_id: MANAGER_DM, group_id: GROUP_ID }),
    saveOnboardingRecord: async (groupId, name, role, startDate) => {
      const r = { id: records.length + 1, groupId, name, role, startDate, status: 'pending' }
      records.push(r)
      return r
    },
    getPendingOnboarding: async (groupId) => records.filter(r => r.groupId === groupId && r.status === 'pending'),
    completeOnboarding: async (id) => {
      const r = records.find(r => r.id === id)
      if (r) r.status = 'completed'
      return r
    },
    upsertStaffDm: async () => {},
    upsertGroupMember: async () => {},
    _records: records,
    ...overrides,
  }
}

// ── handleNewHireAnnouncement ─────────────────────────────────────────────────

test('handleNewHireAnnouncement: posts group message', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsgs = bot.messagesTo(GROUP_ID)
  assert.ok(groupMsgs.length > 0, 'should post in group')
})

test('handleNewHireAnnouncement: group message contains person name', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes('Jake'), 'should include person name')
})

test('handleNewHireAnnouncement: group message contains registration link', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes('t.me/') || groupMsg.text.includes('register'), 'should include registration link')
})

test('handleNewHireAnnouncement: registration link contains groupId', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes(GROUP_ID.replace('-', '')), 'link should contain group ID')
})

test('handleNewHireAnnouncement: DM sent to manager', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const dmMsgs = bot.messagesTo(MANAGER_DM)
  assert.ok(dmMsgs.length > 0, 'should DM manager')
})

test('handleNewHireAnnouncement: onboarding record saved with status pending', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: 'chef', startDate: null }
  const db = makeDb()
  await handleNewHireAnnouncement(bot, msg, intent, db)
  assert.equal(db._records.length, 1)
  assert.equal(db._records[0].status, 'pending')
  assert.equal(db._records[0].name, 'Jake')
})

// ── handleNewHireRegistration ─────────────────────────────────────────────────

test('handleNewHireRegistration: sends welcome DM', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  await handleNewHireRegistration(bot, msg, GROUP_ID, makeDb())
  const dms = bot.messagesTo(3030)
  assert.ok(dms.length > 0, 'Jake should get a welcome DM')
})

test('handleNewHireRegistration: welcome DM mentions Relay', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  await handleNewHireRegistration(bot, msg, GROUP_ID, makeDb())
  const dm = bot.messagesTo(3030)[0]
  assert.ok(dm.text.includes('Relay') || dm.text.includes('schedule'), 'welcome DM should mention Relay')
})

test('handleNewHireRegistration: notifies manager with staff name', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  const db = makeDb()
  // Pre-seed a pending record so it completes
  db._records.push({ id: 1, groupId: GROUP_ID, name: 'Jake', status: 'pending' })
  await handleNewHireRegistration(bot, msg, GROUP_ID, db)
  const managerDms = bot.messagesTo(MANAGER_DM)
  assert.ok(managerDms.length > 0, 'should notify manager')
  assert.ok(managerDms[0].text.includes('Jake'), 'notification should include staff name')
})

test('handleNewHireRegistration: onboarding record marked completed', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  const db = makeDb()
  db._records.push({ id: 1, groupId: GROUP_ID, name: 'Jake', status: 'pending' })
  await handleNewHireRegistration(bot, msg, GROUP_ID, db)
  const record = db._records.find(r => r.id === 1)
  assert.equal(record.status, 'completed')
})

// ── /welcome command ──────────────────────────────────────────────────────────

test('/welcome: posts group registration message', async () => {
  const { handleWelcomeCommand } = await import('../../onboarding/handleNewHire.js')
  const bot = new MockBot()
  bot.setAdmin(GROUP_ID, 101)
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ text: '/welcome Jake', chat: { id: GROUP_ID, type: 'group' }, from: { id: 101, first_name: 'Manager' } })
  await handleWelcomeCommand(bot, msg, 'Jake')
  const groupMsgs = bot.messagesTo(GROUP_ID)
  assert.ok(groupMsgs.length > 0)
  assert.ok(groupMsgs[0].text.includes('Jake'))
})

test('/welcome: blocked for non-admins', async () => {
  const { handleWelcomeCommand } = await import('../../onboarding/handleNewHire.js')
  const bot = new MockBot()
  // NOT setAdmin
  const msg = makeGroupMsg({ text: '/welcome Jake', chat: { id: GROUP_ID, type: 'group' }, from: { id: 999, first_name: 'Rando' } })
  await handleWelcomeCommand(bot, msg, 'Jake')
  assert.ok(!bot.lastMessage(GROUP_ID), 'non-admin should get no reply')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "everyone welcome Jake!" → new_hire_announcement, person Jake', async () => {
  const r = await parseMessage('everyone welcome Jake!', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
  assert.ok(r.person?.toLowerCase().includes('jake'), `expected person=Jake, got ${r.person}`)
})

test('[LLM] "please welcome Sarah to the team" → new_hire_announcement', async () => {
  const r = await parseMessage('please welcome Sarah to the team', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
})

test('[LLM] "introducing our new chef Marcus" → new_hire_announcement, role chef', async () => {
  const r = await parseMessage('introducing our new chef Marcus', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
})

test('[LLM] "welcome back Emma" → NOT new_hire_announcement (returning staff)', async () => {
  const r = await parseMessage('welcome back Emma', 'Manager', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})

test('[LLM] "welcome everyone" → NOT new_hire_announcement (no specific person)', async () => {
  const r = await parseMessage('welcome everyone', 'Manager', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})

test('[LLM] "can anyone cover my shift" → NOT new_hire_announcement', async () => {
  const r = await parseMessage('can anyone cover my shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})
```

- [ ] Run: `node --env-file=.env --test src/tests/unit/newHire.test.js`
- [ ] Confirm: FAIL (module not found)

---

### Task 3.2 — Implement onboardingDb.js

- [ ] Create `src/onboarding/onboardingDb.js`:

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveOnboardingRecord(groupId, name, role, startDate) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .insert({ group_id: groupId, name, role: role ?? null, start_date: startDate ?? null, status: 'pending' })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveOnboardingRecord failed: ${err.message}`)
    return null
  }
}

export async function getPendingOnboarding(groupId) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .order('announced_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPendingOnboarding failed: ${err.message}`)
    return []
  }
}

export async function completeOnboarding(id) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`completeOnboarding failed: ${err.message}`)
    return null
  }
}
```

- [ ] Run: `node --check src/onboarding/onboardingDb.js` — must exit 0

---

### Task 3.3 — Implement handleNewHire.js

- [ ] Create `src/onboarding/handleNewHire.js`:

```js
import { saveOnboardingRecord as liveSaveOnboardingRecord, getPendingOnboarding as liveGetPendingOnboarding, completeOnboarding as liveCompleteOnboarding } from './onboardingDb.js'
import { getSetupSession as liveGetSetupSession } from '../setup/setupDb.js'
import { upsertStaffDm as liveUpsertStaffDm, upsertGroupMember as liveUpsertGroupMember } from '../db.js'
import { logger } from '../logger.js'

let _cachedBotUsername = null
async function getBotUsername(bot) {
  if (!_cachedBotUsername) {
    const me = await bot.getMe()
    _cachedBotUsername = me.username
  }
  return _cachedBotUsername
}

export async function handleNewHireAnnouncement(bot, msg, intent, db = null) {
  const _saveOnboardingRecord  = db?.saveOnboardingRecord  ?? liveSaveOnboardingRecord
  const _getSetupSession       = db?.getSetupSession       ?? (() => liveGetSetupSession(String(msg.chat.id)))

  const groupId   = String(msg.chat.id)
  const personName = intent.person || 'new team member'
  const botUsername = await getBotUsername(bot)

  const registrationLink = `t.me/${botUsername}?start=register_${groupId}`

  await bot.sendMessage(groupId,
    `👋 Welcome to the team, ${personName}!\n\n` +
    `${personName} — send me a DM to get set up with scheduling: ${registrationLink}`,
    { parse_mode: 'Markdown' })

  const session = await _getSetupSession()
  if (session?.dm_chat_id) {
    await bot.sendMessage(session.dm_chat_id,
      `✅ New hire announcement detected.\n\nI've posted a registration link for *${personName}* in the group. I'll notify you when they register.`,
      { parse_mode: 'Markdown' })
  }

  await _saveOnboardingRecord(groupId, personName, intent.role ?? null, intent.startDate ?? null)
  logger.bot(`New hire onboarding started: ${personName} in group ${groupId}`)
}

export async function handleNewHireRegistration(bot, msg, groupId, db = null) {
  const _getPendingOnboarding = db?.getPendingOnboarding ?? (() => liveGetPendingOnboarding(groupId))
  const _completeOnboarding   = db?.completeOnboarding   ?? liveCompleteOnboarding
  const _getSetupSession      = db?.getSetupSession      ?? (() => liveGetSetupSession(groupId))

  const staffName  = msg.from?.first_name || 'New team member'
  const dmChatId   = msg.chat.id

  // Send welcome DM
  await bot.sendMessage(dmChatId,
    `👋 Welcome to the team!\n\n` +
    `I'm *Relay* — I handle shift scheduling.\n` +
    `Here's what I do:\n` +
    `• Send you your weekly schedule\n` +
    `• Alert you when someone needs coverage\n` +
    `• Let you check your shifts anytime\n\n` +
    `Your manager will add you to the schedule soon.\n` +
    `If you ever need anything, just DM me 👍`,
    { parse_mode: 'Markdown' })

  // Check for pending onboarding records and notify manager
  const pending = await _getPendingOnboarding()
  if (pending.length > 0) {
    const record = pending[0]  // use most recent
    await _completeOnboarding(record.id)

    const session = await _getSetupSession()
    if (session?.dm_chat_id) {
      await bot.sendMessage(session.dm_chat_id,
        `✅ *${staffName}* has registered with Relay and is ready to be added to the schedule.`,
        { parse_mode: 'Markdown' })
    }
    logger.bot(`New hire ${staffName} completed onboarding for group ${groupId}`)
  }
}

export async function handleWelcomeCommand(bot, msg, name) {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return

  const groupId = String(msg.chat.id)
  const userId  = msg.from?.id

  try {
    const member = await bot.getChatMember(groupId, userId)
    if (!['creator', 'administrator'].includes(member?.status)) return
  } catch {
    return
  }

  const displayName = name || 'new team member'
  const botUsername = await getBotUsername(bot)

  await bot.sendMessage(groupId,
    `👋 Welcome to the team, ${displayName}!\n\n` +
    `Send me a DM to get set up: t.me/${botUsername}?start=register_${groupId}`)
}
```

- [ ] Run: `node --check src/onboarding/handleNewHire.js` — must exit 0

---

### Task 3.4 — Add intent to messageParsers.js

- [ ] In `src/parsers/messageParsers.js` SYSTEM_PROMPT, add before `COPY_SCHEDULE_REQUEST` (or before `SCHEDULE_UPDATE` if copy hasn't been added yet):

```
NEW_HIRE_ANNOUNCEMENT — manager announces a new staff member joining the team:
{"type":"new_hire_announcement","person":"name of new hire extracted from message","startDate":null,"role":null}

Common new_hire_announcement phrases: 'everyone welcome [name]', 'please welcome [name]', 'welcome [name] to the team', '[name] is joining us', '[name] starts [day]', 'new team member [name]', 'introducing [name]', '[name] is our new [role]'
Extract: person = the new hire's name. role = their job role if mentioned. startDate = when they start if mentioned.
MUST NOT trigger on: 'welcome back [name]' (returning staff), 'welcome everyone' (no specific person), general greetings without a new hire context.

```

- [ ] Run: `node --check src/parsers/messageParsers.js` — must exit 0

---

### Task 3.5 — Wire into groupRouter.js

- [ ] Edit `src/routing/groupRouter.js` — add import:

```js
import { handleNewHireAnnouncement } from '../onboarding/handleNewHire.js'
```

- [ ] Add case in switch:

```js
      case 'new_hire_announcement':
        await handleNewHireAnnouncement(bot, msg, intent)
        break
```

- [ ] Run: `node --check src/routing/groupRouter.js` — must exit 0

---

### Task 3.6 — Enhance register_ handler in dmRouter.js

The existing `register_` block (lines 38-53) already does basic upsert + generic welcome. Enhance it to also call `handleNewHireRegistration`.

- [ ] Edit `src/routing/dmRouter.js` — add import at top:

```js
import { handleNewHireRegistration } from '../onboarding/handleNewHire.js'
```

- [ ] Replace the existing `register_` block (lines 38-53) with:

```js
    if (param.startsWith('register_')) {
      const groupId = param.replace('register_', '')
      await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
      await upsertGroupMember(userId, groupId, senderName, msg.from?.username)
      await handleNewHireRegistration(bot, msg, groupId)
      logger.bot(`${senderName} registered via group invite link (group ${groupId})`)
      return
    }
```

Note: `handleNewHireRegistration` now sends the welcome DM. Remove the old generic welcome message from this block.

- [ ] Run: `node --check src/routing/dmRouter.js` — must exit 0

---

### Task 3.7 — Add /welcome to index.js

- [ ] Edit `src/index.js` — add import:

```js
import { handleWelcomeCommand } from './onboarding/handleNewHire.js'
```

- [ ] Add before `process.on('SIGINT', ...)`:

```js
bot.onText(/^\/welcome(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const name = (match[1] || '').trim().replace(/^@/, '')
  await handleWelcomeCommand(bot, msg, name)
})
```

- [ ] Run: `node --check src/index.js` — must exit 0
- [ ] Run: `node --env-file=.env --test src/tests/unit/newHire.test.js`
- [ ] All non-LLM tests must PASS

---

### Task 3.8 — Commit Feature 3

- [ ] `git add -A && git commit -m "feat: new hire onboarding detection"`

---

## Feature 4: Partial Shift Coverage

### Files
- **CREATE** `src/coverage/partialCoverage.js` — parseTimeReference, getMidpoint, formatPartialCoverageMessage, calculateRemainingCoverage, isFullyCovered, handlePartialCoverageOffer
- **CREATE** `src/tests/unit/partialCoverage.test.js` — all tests
- **MODIFY** `src/parsers/messageParsers.js` — add partial_coverage_offer intent
- **MODIFY** `src/routing/groupRouter.js` — add case BEFORE coverage_confirmation

---

### Task 4.1 — Write all partialCoverage tests (RED)

- [ ] Create `src/tests/unit/partialCoverage.test.js`:

```js
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTimeReference,
  calculateRemainingCoverage,
  isFullyCovered,
  formatPartialCoverageMessage,
} from '../../coverage/partialCoverage.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'

// ── parseTimeReference ────────────────────────────────────────────────────────

const SHIFT = { startTime: '11am', endTime: '5pm' }  // 11:00 – 17:00, midpoint = 14:00 = 2pm

test('parseTimeReference: first_half → 11:00am to 2:00pm', () => {
  const result = parseTimeReference({ portion: 'first_half' }, SHIFT)
  assert.equal(result.coverFrom, '11:00am')
  assert.equal(result.coverUntil, '2:00pm')
})

test('parseTimeReference: second_half → 2:00pm to 5:00pm', () => {
  const result = parseTimeReference({ portion: 'second_half' }, SHIFT)
  assert.equal(result.coverFrom, '2:00pm')
  assert.equal(result.coverUntil, '5:00pm')
})

test('parseTimeReference: until 2pm → 11:00am to 2:00pm', () => {
  const result = parseTimeReference({ portion: 'until', timeReference: '2pm' }, SHIFT)
  assert.equal(result.coverFrom, '11:00am')
  assert.equal(result.coverUntil, '2:00pm')
})

test('parseTimeReference: from 2pm → 2:00pm to 5:00pm', () => {
  const result = parseTimeReference({ portion: 'from', timeReference: '2pm' }, SHIFT)
  assert.equal(result.coverFrom, '2:00pm')
  assert.equal(result.coverUntil, '5:00pm')
})

test('parseTimeReference: midnight-crossing shift midpoint handled', () => {
  const nightShift = { startTime: '10pm', endTime: '2am' }
  const result = parseTimeReference({ portion: 'first_half' }, nightShift)
  // 10pm = 22:00, 2am = 2:00 (next day = 26 in decimal), midpoint = 24 = 12am midnight
  assert.ok(result.coverFrom, 'should return a coverFrom')
  assert.ok(result.coverUntil, 'should return a coverUntil')
})

// ── calculateRemainingCoverage ────────────────────────────────────────────────

const SHIFT_FULL = { startTime: '11am', endTime: '5pm' }  // 11:00 – 17:00 decimal

test('calculateRemainingCoverage: no partials → one gap spanning full shift', () => {
  const gaps = calculateRemainingCoverage(SHIFT_FULL, [])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '11:00am')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: first half covered → one gap from 2pm to 5pm', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '2:00pm' }]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '2:00pm')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: both halves covered → empty array', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '2:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 0)
})

test('calculateRemainingCoverage: overlapping partials → correct remaining', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '3:00pm' },
    { coverFrom: '2:00pm', coverUntil: '4:00pm' },  // overlaps with first
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '4:00pm')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: non-contiguous partials → two gaps', () => {
  // Covered: 11am-12pm and 2pm-5pm, gap: 12pm-2pm
  const partials = [
    { coverFrom: '11:00am', coverUntil: '12:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)  // gap from 12pm to 2pm
  assert.equal(gaps[0].from, '12:00pm')
  assert.equal(gaps[0].until, '2:00pm')
})

// ── isFullyCovered ────────────────────────────────────────────────────────────

test('isFullyCovered: single partial covers whole shift → true', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '5:00pm' }]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), true)
})

test('isFullyCovered: two partials cover whole shift → true', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '2:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), true)
})

test('isFullyCovered: one partial, gap remains → false', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '2:00pm' }]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), false)
})

test('isFullyCovered: empty partials → false', () => {
  assert.equal(isFullyCovered(SHIFT_FULL, []), false)
})

// ── formatPartialCoverageMessage ──────────────────────────────────────────────

test('formatPartialCoverageMessage: contains volunteer name', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('Alice'))
})

test('formatPartialCoverageMessage: contains shift name', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('Monday Lunch'))
})

test('formatPartialCoverageMessage: contains covered time range', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('11:00am') && result.includes('2:00pm'))
})

test('formatPartialCoverageMessage: contains "Still need coverage" text', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.toLowerCase().includes('still need') || result.includes('Still need'))
})

// ── handlePartialCoverageOffer (MockBot + mock DB) ───────────────────────────

const { handlePartialCoverageOffer } = await import('../../coverage/partialCoverage.js')

const OPEN_REQUEST = {
  id: 55,
  group_id: '-100',
  shift_description: 'Monday Lunch',
  matched_shift_id: 'shift-1',
  week_start: '2025-01-06',
  status: 'open',
}
const SHIFT_ROW = { id: 'shift-1', name: 'Monday Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '5pm' }

function makeCoverageDb(partials = [], overrides = {}) {
  let requestStatus = 'open'
  return {
    getOpenRequest: async () => ({ ...OPEN_REQUEST }),
    getShiftById: async () => SHIFT_ROW,
    getPartialCoverages: async () => [...partials],
    savePartialCoverage: async (data) => ({ id: Math.random(), ...data }),
    markCovered: async () => { requestStatus = 'covered' },
    _getStatus: () => requestStatus,
    ...overrides,
  }
}

test('handlePartialCoverageOffer: saves partial_coverage record', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: 'I can cover the first half', from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  let saved = null
  const db = makeCoverageDb([], { savePartialCoverage: async (data) => { saved = data; return { id: 1, ...data } } })
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.ok(saved, 'should save a partial coverage record')
})

test('handlePartialCoverageOffer: posts partial coverage message to group', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: 'I can cover the first half', from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  await handlePartialCoverageOffer(bot, msg, intent, makeCoverageDb())
  const groupMsgs = bot.messagesTo('-100')
  assert.ok(groupMsgs.length > 0)
})

test('handlePartialCoverageOffer: keeps coverage_request open when partially covered', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  const db = makeCoverageDb()
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.equal(db._getStatus(), 'open', 'request should remain open when partially covered')
})

test('handlePartialCoverageOffer: closes coverage_request when fully covered by two volunteers', async () => {
  const bot = new MockBot()
  const existingPartials = [{ coverFrom: '11:00am', coverUntil: '2:00pm', staffName: 'Alice' }]
  const msg = makeGroupMsg({ from: { id: 202, first_name: 'Bob' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Bob', portion: 'second_half', timeReference: null }
  const db = makeCoverageDb(existingPartials)
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.equal(db._getStatus(), 'covered', 'request should be closed when fully covered')
})

test('handlePartialCoverageOffer: "No open requests" when none exists', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  const db = makeCoverageDb([], { getOpenRequest: async () => null })
  await handlePartialCoverageOffer(bot, msg, intent, db)
  const groupMsgs = bot.messagesTo('-100')
  assert.ok(groupMsgs[0].text.includes('No open') || groupMsgs[0].text.includes('no open'), 'should explain no open requests')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "I can cover the first half" → partial_coverage_offer, portion first_half', async () => {
  const r = await parseMessage('I can cover the first half', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'first_half')
})

test('[LLM] "I can cover until 3pm" → partial_coverage_offer, portion until', async () => {
  const r = await parseMessage('I can cover until 3pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'until')
  assert.ok(r.timeReference?.includes('3'), `expected timeReference with 3pm, got ${r.timeReference}`)
})

test('[LLM] "I can come in from 2pm" → partial_coverage_offer, portion from', async () => {
  const r = await parseMessage('I can come in from 2pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'from')
})

test('[LLM] "I can do 11am to 2pm" → partial_coverage_offer, portion range', async () => {
  const r = await parseMessage('I can do 11am to 2pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
})

test('[LLM] "I can cover" alone → coverage_confirmation NOT partial', async () => {
  const r = await parseMessage('I can cover', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'partial_coverage_offer')
  assert.equal(r.type, 'coverage_confirmation')
})

test('[LLM] "I can cover the whole shift" → coverage_confirmation NOT partial', async () => {
  const r = await parseMessage('I can cover the whole shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'partial_coverage_offer')
  assert.equal(r.type, 'coverage_confirmation')
})
```

- [ ] Run: `node --env-file=.env --test src/tests/unit/partialCoverage.test.js`
- [ ] Confirm: FAIL (module not found)

---

### Task 4.2 — Implement partialCoverage.js

- [ ] Create `src/coverage/partialCoverage.js`:

```js
import { getOpenRequest as liveGetOpenRequest, markCovered as liveMarkCovered } from '../db.js'
import { logger } from '../logger.js'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Parse any time string to decimal hours.
 * Handles: "9pm", "21:00", "9:00pm", "9:00 AM", "11am"
 */
function parseHour(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, '')
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return parseInt(h24[1], 10) + parseInt(h24[2], 10) / 60
  const h12full = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/)
  if (h12full) {
    let h = parseInt(h12full[1], 10)
    const min = parseInt(h12full[2], 10) / 60
    if (h12full[3] === 'pm' && h !== 12) h += 12
    if (h12full[3] === 'am' && h === 12) h = 0
    return h + min
  }
  const h12 = s.match(/^(\d{1,2})(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1], 10)
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return h
  }
  return 0
}

function decimalToTimeStr(decimal) {
  // Handle 24+ for midnight crossing
  const normalized = decimal >= 24 ? decimal - 24 : decimal
  const h = Math.floor(normalized)
  const min = Math.round((normalized - h) * 60)
  const minStr = min === 0 ? '00' : String(min).padStart(2, '0')
  const period = h >= 12 && h < 24 ? 'pm' : 'am'
  const displayH = h === 0 || h === 24 ? 12 : h > 12 ? h - 12 : h
  return `${displayH}:${minStr}${period}`
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Calculates the midpoint time string between two time strings.
 * Handles midnight crossing (e.g. 10pm to 2am).
 */
function getMidpoint(startTime, endTime) {
  let startH = parseHour(startTime)
  let endH = parseHour(endTime)
  // Handle midnight crossing: if end < start, add 24 to end
  if (endH < startH) endH += 24
  const mid = (startH + endH) / 2
  return decimalToTimeStr(mid)
}

/**
 * Returns { coverFrom, coverUntil } strings based on portion type and shift times.
 */
export function parseTimeReference(intent, shift) {
  const { portion, timeReference } = intent
  const { startTime, endTime } = shift
  const midpoint = getMidpoint(startTime, endTime)

  const fmt = (t) => decimalToTimeStr(parseHour(t))

  switch (portion) {
    case 'first_half':
      return { coverFrom: fmt(startTime), coverUntil: midpoint }
    case 'second_half':
      return { coverFrom: midpoint, coverUntil: fmt(endTime) }
    case 'until':
      return { coverFrom: fmt(startTime), coverUntil: fmt(timeReference) }
    case 'from':
      return { coverFrom: fmt(timeReference), coverUntil: fmt(endTime) }
    case 'range': {
      // timeReference like "11am to 2pm" or "11am-2pm"
      const parts = (timeReference || '').split(/\s*(?:to|-)\s*/i)
      if (parts.length === 2) {
        return { coverFrom: fmt(parts[0].trim()), coverUntil: fmt(parts[1].trim()) }
      }
      return { coverFrom: fmt(startTime), coverUntil: fmt(endTime) }
    }
    default:
      return { coverFrom: fmt(startTime), coverUntil: fmt(endTime) }
  }
}

/**
 * Returns uncovered time ranges for a shift given existing partial coverages.
 */
export function calculateRemainingCoverage(shift, partialCoverages) {
  const shiftStart = parseHour(shift.startTime)
  const rawEnd = parseHour(shift.endTime)
  const shiftEnd = rawEnd < shiftStart ? rawEnd + 24 : rawEnd

  if (!partialCoverages.length) {
    return [{ from: decimalToTimeStr(shiftStart), until: decimalToTimeStr(shiftEnd) }]
  }

  // Convert all partials to decimal ranges
  const covered = partialCoverages.map(p => {
    const s = parseHour(p.coverFrom)
    const e = parseHour(p.coverUntil)
    return [Math.max(s, shiftStart), Math.min(e < s ? e + 24 : e, shiftEnd)]
  }).filter(([s, e]) => s < e)

  // Sort and merge overlapping intervals
  covered.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of covered) {
    if (!merged.length || merged[merged.length - 1][1] < s) {
      merged.push([s, e])
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e)
    }
  }

  // Find gaps
  const gaps = []
  let cursor = shiftStart
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push({ from: decimalToTimeStr(cursor), until: decimalToTimeStr(s) })
    cursor = e
  }
  if (cursor < shiftEnd) gaps.push({ from: decimalToTimeStr(cursor), until: decimalToTimeStr(shiftEnd) })

  return gaps
}

export function isFullyCovered(shift, partialCoverages) {
  return calculateRemainingCoverage(shift, partialCoverages).length === 0
}

export function formatPartialCoverageMessage(shiftName, volunteer, coverFrom, coverUntil, remaining) {
  let msg = `✅ *${volunteer}* will cover *${shiftName}* from ${coverFrom} to ${coverUntil}.\n`

  if (remaining.length > 0) {
    const gapList = remaining.map(g => `${g.from}–${g.until}`).join(', ')
    msg += `\n📋 Still need coverage from ${gapList}.\nAnyone available for this portion?`
  }

  return msg
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function liveGetShiftById(shiftId) {
  try {
    const { data, error } = await supabase
      .from('shifts').select('*').eq('id', shiftId).maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getShiftById failed: ${err.message}`)
    return null
  }
}

async function liveGetPartialCoverages(requestId) {
  try {
    const { data, error } = await supabase
      .from('partial_coverage').select('*').eq('coverage_request_id', requestId)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPartialCoverages failed: ${err.message}`)
    return []
  }
}

async function liveSavePartialCoverage(data) {
  try {
    const { data: row, error } = await supabase
      .from('partial_coverage').insert(data).select().single()
    if (error) throw error
    return row
  } catch (err) {
    logger.error(`savePartialCoverage failed: ${err.message}`)
    return null
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handlePartialCoverageOffer(bot, msg, intent, db = null) {
  const _getOpenRequest     = db?.getOpenRequest     ?? (() => liveGetOpenRequest(String(msg.chat.id)))
  const _getShiftById       = db?.getShiftById       ?? liveGetShiftById
  const _getPartialCoverages = db?.getPartialCoverages ?? liveGetPartialCoverages
  const _savePartialCoverage = db?.savePartialCoverage ?? liveSavePartialCoverage
  const _markCovered         = db?.markCovered         ?? liveMarkCovered

  const groupId    = String(msg.chat.id)
  const volunteer  = intent.person || msg.from?.first_name || 'Someone'

  const openRequest = await _getOpenRequest()
  if (!openRequest) {
    await bot.sendMessage(msg.chat.id, 'No open coverage requests right now 👍')
    return
  }

  const shift = await _getShiftById(openRequest.matched_shift_id)
  if (!shift) {
    await bot.sendMessage(msg.chat.id, 'Could not find shift details. Try again shortly.')
    return
  }

  const shiftForCalc = { startTime: shift.start_time, endTime: shift.end_time }
  const { coverFrom, coverUntil } = parseTimeReference(intent, shiftForCalc)

  await _savePartialCoverage({
    coverage_request_id: openRequest.id,
    staff_name: volunteer,
    staff_id: null,
    cover_from: coverFrom,
    cover_until: coverUntil,
    group_id: groupId,
  })

  const allPartials = await _getPartialCoverages(openRequest.id)
  // Normalize partial records to { coverFrom, coverUntil }
  const normalizedPartials = allPartials.map(p => ({
    coverFrom: p.cover_from ?? p.coverFrom,
    coverUntil: p.cover_until ?? p.coverUntil,
  }))

  if (isFullyCovered(shiftForCalc, normalizedPartials)) {
    // Build the full coverage confirmation
    const coverageList = allPartials.map(p =>
      `• ${p.staff_name ?? p.staffName}: ${p.cover_from ?? p.coverFrom}–${p.cover_until ?? p.coverUntil}`
    ).join('\n')

    await bot.sendMessage(msg.chat.id,
      `✅ *${shift.name}* is fully covered!\n\n${coverageList}`,
      { parse_mode: 'Markdown' })

    await _markCovered(openRequest.id, volunteer)
  } else {
    const remaining = calculateRemainingCoverage(shiftForCalc, normalizedPartials)
    const text = formatPartialCoverageMessage(shift.name, volunteer, coverFrom, coverUntil, remaining)
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  }
}
```

- [ ] Run: `node --check src/coverage/partialCoverage.js` — must exit 0

---

### Task 4.3 — Add intent to messageParsers.js

- [ ] In `src/parsers/messageParsers.js` SYSTEM_PROMPT, add AFTER `COVERAGE_CONFIRMATION` and BEFORE `COVERAGE_MAYBE`:

```
PARTIAL_COVERAGE_OFFER — someone volunteers to cover only PART of a shift (first half, second half, until a time, from a time, or a specific time range). ONLY use this when they explicitly state a partial time:
{"type":"partial_coverage_offer","person":"name of volunteer, use sender name","portion":"first_half|second_half|until|from|range","timeReference":"the time mentioned if applicable, null otherwise"}

Common partial_coverage_offer phrases: 'I can cover the first half', 'I can do the first part', 'I can cover until [time]', 'I can come in from [time]', 'I can do [time] to [time]', 'I can cover the morning part', 'available for the second half'
portion values: 'first_half' (first part/first half), 'second_half' (second part/second half), 'until' (I can cover until X), 'from' (I can come from X), 'range' (I can do X to Y)
MUST NOT trigger on: 'I can cover' alone → coverage_confirmation, 'I can cover that' → coverage_confirmation, 'I can cover the whole shift' → coverage_confirmation
KEY DISTINCTION: partial_coverage_offer requires explicit partial time language. Full coverage without time restrictions = coverage_confirmation.

```

- [ ] Run: `node --check src/parsers/messageParsers.js` — must exit 0

---

### Task 4.4 — Wire into groupRouter.js

- [ ] Edit `src/routing/groupRouter.js` — add import:

```js
import { handlePartialCoverageOffer } from '../coverage/partialCoverage.js'
```

- [ ] Add case BEFORE the `coverage_confirmation` case in the switch:

```js
      case 'partial_coverage_offer':
        await handlePartialCoverageOffer(bot, msg, intent)
        break
```

- [ ] Run: `node --check src/routing/groupRouter.js` — must exit 0
- [ ] Run: `node --env-file=.env --test src/tests/unit/partialCoverage.test.js`
- [ ] All non-LLM tests must PASS

---

### Task 4.5 — Commit Feature 4

- [ ] `git add -A && git commit -m "feat: partial shift coverage"`

---

## Final Verification

### Run all 4 test suites individually

- [ ] `node --env-file=.env --test src/tests/unit/rotationTracker.test.js`
- [ ] `node --env-file=.env --test src/tests/unit/copySchedule.test.js`
- [ ] `node --env-file=.env --test src/tests/unit/newHire.test.js`
- [ ] `node --env-file=.env --test src/tests/unit/partialCoverage.test.js`

All must show `# pass N` with no failures.

### Run existing fast suites to verify no regressions

- [ ] `node --env-file=.env --test src/tests/unit/scheduleGenerator.test.js`
- [ ] `node --env-file=.env --test src/tests/integration/coverageFlow.test.js`
- [ ] `node --env-file=.env --test src/tests/integration/scheduleFlow.test.js`

---

## ADD TO run-tests-parallel.js (add manually after parallel payroll session finishes)

Add to `FAST_SUITES` array:

```js
  { id: 'unit_rotation', file: 'unit/rotationTracker.test.js', label: 'Unit — Rotation Fairness', timeout: 10_000 },
  { id: 'unit_copy_schedule', file: 'unit/copySchedule.test.js', label: 'Unit — Copy Schedule', timeout: 10_000 },
  { id: 'unit_new_hire', file: 'unit/newHire.test.js', label: 'Unit — New Hire Onboarding', timeout: 10_000 },
  { id: 'unit_partial_coverage', file: 'unit/partialCoverage.test.js', label: 'Unit — Partial Coverage', timeout: 10_000 },
```

Add LLM tests to `LLM_SUITES` array (copy_schedule, new_hire, and partial_coverage have Groq intent tests):

```js
  { id: 'unit_copy_schedule_llm', file: 'unit/copySchedule.test.js', label: 'Unit — Copy Schedule (LLM)', timeout: 180_000 },
  { id: 'unit_new_hire_llm', file: 'unit/newHire.test.js', label: 'Unit — New Hire (LLM)', timeout: 180_000 },
  { id: 'unit_partial_coverage_llm', file: 'unit/partialCoverage.test.js', label: 'Unit — Partial Coverage (LLM)', timeout: 180_000 },
```

Note: These suites mix pure + LLM tests. When running in LLM_SUITES, the pure tests will run again — that's fine. Alternatively, split them into separate files (e.g. `copySchedule.llm.test.js`) — your call.

---

## RUN IN SUPABASE SQL EDITOR (in order)

```sql
-- Feature 1: Rotation Fairness (index only, no new tables)
CREATE INDEX IF NOT EXISTS idx_assignments_staff_week
  ON schedule_assignments(staff_id, week_start);

-- Feature 3: New Hire Onboarding
CREATE TABLE IF NOT EXISTS onboarding_pending (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT,
  role TEXT,
  telegram_id BIGINT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired')),
  announced_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_onboarding_group_status
  ON onboarding_pending(group_id, status);
ALTER TABLE onboarding_pending ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon on onboarding_pending"
  ON onboarding_pending FOR ALL TO anon USING (true) WITH CHECK (true);

-- Feature 4: Partial Coverage
CREATE TABLE IF NOT EXISTS partial_coverage (
  id BIGSERIAL PRIMARY KEY,
  coverage_request_id BIGINT REFERENCES coverage_requests(id) ON DELETE CASCADE,
  staff_id BIGINT,
  staff_name TEXT NOT NULL,
  cover_from TEXT NOT NULL,
  cover_until TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_partial_coverage_request
  ON partial_coverage(coverage_request_id);
ALTER TABLE partial_coverage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon on partial_coverage"
  ON partial_coverage FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE coverage_requests
  ADD COLUMN IF NOT EXISTS partial_coverage_needed BOOLEAN DEFAULT FALSE;
```
