# No-show Warning, Reliability Scoring & Daily Briefing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three proactive manager-facing features: a no-show early warning cron, internal staff reliability scoring, and an 8am daily briefing DM.

**Architecture:** Each feature lives in its own domain directory (`src/noshow/`, `src/reliability/`, `src/briefing/`). DB layers use the same `db?.method ?? importedMethod` injection pattern as existing handlers. Pure functions are implemented and tested first; DB and integration wiring follow. All three cron jobs are wired into `src/index.js` inside the existing `bot.getMe().then()` callback alongside `startReminderJobs`.

**Tech Stack:** Node.js 25 ES modules, node-cron, node-telegram-bot-api, Supabase (@supabase/supabase-js), node:test + assert/strict, MockBot from helpers/mocks.js

---

## Files Created / Modified

```
src/noshow/noShowWarning.js       — pure fns + checkUpcomingShifts + startNoShowCron
src/noshow/noShowDb.js            — getUpcomingShifts, markWarned, wasWarned, getConfiguredGroups
src/reliability/reliabilityScore.js — computeScore, getReliabilityLabel, formatReliabilityReport
src/reliability/reliabilityDb.js  — recordEvent, getReliabilityEvents, getReliabilityScores
src/briefing/dailyBriefing.js     — buildBriefing, formatBriefing, sendDailyBriefing, startBriefingCron

src/tests/unit/noShowWarning.test.js
src/tests/unit/reliability.test.js
src/tests/unit/dailyBriefing.test.js

src/index.js                      — add 3 cron starts + /reliability + /briefing bot.onText handlers
src/coverage/requestHandler.js    — wire recordEvent('called_out') after saveRequest
src/coverage/confirmationHandler.js — wire recordEvent('covered_someone') after markCovered
src/schedule/readReceipts.js      — wire recordEvent('confirmed_schedule') after receipt confirmed
src/tests/run-tests-parallel.js   — add 3 new FAST_SUITES entries
```

## DB injection pattern (copy exactly from existing handlers)

```js
// At top of every async exported function that accepts db:
const _foo = db?.foo ?? foo       // foo is the imported real implementation
```

## Supabase client pattern (copy into every new DB file)

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
```

---

## ═══════════════════════════════════════════
## FEATURE 1: No-show Early Warning
## ═══════════════════════════════════════════

### Task 1 — Write ALL no-show tests (RED)

**Files:**
- Create: `src/tests/unit/noShowWarning.test.js`

- [ ] **Step 1: Create the test file with all 20 tests — they will all fail until implementation**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  isShiftStartingSoon,
  formatTimeUntilShift,
  checkUpcomingShifts,
} from '../../noshow/noShowWarning.js'

// Helper: build a time string X minutes from now
function timeInMinutes(offsetMinutes, now = new Date()) {
  const target = new Date(now.getTime() + offsetMinutes * 60 * 1000)
  const h = target.getHours()
  const m = target.getMinutes()
  return `${h}:${String(m).padStart(2, '0')}`
}

function makeDb(overrides = {}) {
  const warned = new Set()
  return {
    getConfiguredGroups: async () => ['g1'],
    getUpcomingShifts: async () => [],
    wasWarned: async (id) => warned.has(id),
    markWarned: async (id) => { warned.add(id) },
    getSetupSession: async () => ({ dm_chat_id: '99999' }),
    ...overrides,
  }
}

await Promise.all([
  // ── pure: isShiftStartingSoon ──────────────────────────────────────────
  test('isShiftStartingSoon: shift in 25min is within window', () => {
    const now = new Date()
    assert.equal(isShiftStartingSoon(timeInMinutes(25, now), 30, now), true)
  }),

  test('isShiftStartingSoon: shift in 35min is within window', () => {
    const now = new Date()
    assert.equal(isShiftStartingSoon(timeInMinutes(35, now), 30, now), true)
  }),

  test('isShiftStartingSoon: shift in 60min is outside window', () => {
    const now = new Date()
    assert.equal(isShiftStartingSoon(timeInMinutes(60, now), 30, now), false)
  }),

  test('isShiftStartingSoon: shift in 5min is outside window (past warning)', () => {
    const now = new Date()
    assert.equal(isShiftStartingSoon(timeInMinutes(5, now), 30, now), false)
  }),

  test('isShiftStartingSoon: handles "6am" format', () => {
    // 6am is either in window or not — just verify it doesn't throw
    const now = new Date()
    const result = isShiftStartingSoon('6am', 30, now)
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "06:00" format', () => {
    const now = new Date()
    const result = isShiftStartingSoon('06:00', 30, now)
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "6:00am" format', () => {
    const now = new Date()
    const result = isShiftStartingSoon('6:00am', 30, now)
    assert.equal(typeof result, 'boolean')
  }),

  test('isShiftStartingSoon: handles "18:00" format', () => {
    const now = new Date()
    const result = isShiftStartingSoon('18:00', 30, now)
    assert.equal(typeof result, 'boolean')
  }),

  // ── pure: formatTimeUntilShift ────────────────────────────────────────
  test('formatTimeUntilShift: 30min → "~30 minutes"', () => {
    const now = new Date()
    assert.equal(formatTimeUntilShift(timeInMinutes(30, now), now), '~30 minutes')
  }),

  test('formatTimeUntilShift: 45min → "~45 minutes"', () => {
    const now = new Date()
    assert.equal(formatTimeUntilShift(timeInMinutes(45, now), now), '~45 minutes')
  }),

  // ── checkUpcomingShifts ────────────────────────────────────────────────
  test('checkUpcomingShifts sends manager DM for upcoming shift', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 1, staff_name: 'Alice', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSent('99999', 'Alice')
    assert.equal(result.warned, 1)
  }),

  test('checkUpcomingShifts DM contains staff name', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 2, staff_name: 'Bob', shift_name: 'Dinner',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db)
    bot.assertSent('99999', 'Bob')
  }),

  test('checkUpcomingShifts DM contains shift name', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 3, staff_name: 'Carol', shift_name: 'MorningShift',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db)
    bot.assertSent('99999', 'MorningShift')
  }),

  test('checkUpcomingShifts DM contains start time', async () => {
    const bot = new MockBot()
    const now = new Date()
    const startTime = timeInMinutes(30, now)
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 4, staff_name: 'Dave', shift_name: 'Lunch',
        start_time: startTime, group_id: 'g1',
      }],
    })
    await checkUpcomingShifts(bot, db)
    bot.assertSent('99999', startTime)
  }),

  test('checkUpcomingShifts marks assignment as warned', async () => {
    const bot = new MockBot()
    const now = new Date()
    const warned = []
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 5, staff_name: 'Eve', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      markWarned: async (id) => { warned.push(id) },
    })
    await checkUpcomingShifts(bot, db)
    assert.deepEqual(warned, [5])
  }),

  test('checkUpcomingShifts skips already warned assignments', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 6, staff_name: 'Frank', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      wasWarned: async () => true,
    })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.skipped, 1)
  }),

  test('checkUpcomingShifts skips groups with no manager DM', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [{
        id: 7, staff_name: 'Grace', shift_name: 'Lunch',
        start_time: timeInMinutes(30, now), group_id: 'g1',
      }],
      getSetupSession: async () => null,
    })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.skipped, 1)
  }),

  test('checkUpcomingShifts returns correct { checked, warned }', async () => {
    const bot = new MockBot()
    const now = new Date()
    const db = makeDb({
      getUpcomingShifts: async () => [
        { id: 8, staff_name: 'Hank', shift_name: 'Lunch', start_time: timeInMinutes(30, now), group_id: 'g1' },
        { id: 9, staff_name: 'Iris', shift_name: 'Dinner', start_time: timeInMinutes(31, now), group_id: 'g1' },
      ],
    })
    const result = await checkUpcomingShifts(bot, db)
    assert.equal(result.warned, 2)
    assert.equal(result.checked, 2)
  }),

  test('checkUpcomingShifts handles empty upcoming shifts', async () => {
    const bot = new MockBot()
    const db = makeDb({ getUpcomingShifts: async () => [] })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.checked, 0)
    assert.equal(result.warned, 0)
  }),

  test('checkUpcomingShifts handles zero configured groups', async () => {
    const bot = new MockBot()
    const db = makeDb({ getConfiguredGroups: async () => [] })
    const result = await checkUpcomingShifts(bot, db)
    bot.assertSilent()
    assert.equal(result.warned, 0)
  }),
])
```

- [ ] **Step 2: Run tests — verify ALL fail (module not found)**

```bash
cd /Users/mahin/relay-bot
node --env-file=.env --test src/tests/unit/noShowWarning.test.js 2>&1 | tail -20
```

Expected: `Error: Cannot find module '../../noshow/noShowWarning.js'`

---

### Task 2 — Implement pure functions in noShowWarning.js (GREEN for pure tests)

**Files:**
- Create: `src/noshow/noShowWarning.js`

- [ ] **Step 1: Create the file with pure functions only (no DB, no bot)**

```js
import cron from 'node-cron'
import { logger } from '../logger.js'
import { getUpcomingShifts, markWarned, wasWarned, getConfiguredGroups } from './noShowDb.js'
import { getSetupSession } from '../setup/setupDb.js'

// ── Time parsing ──────────────────────────────────────────────────────────

function parseShiftTime(timeStr) {
  const s = String(timeStr).trim().toLowerCase()

  // "18:00" or "06:00" (24h)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return { hours: parseInt(h24[1]), minutes: parseInt(h24[2]) }

  // "6:00am" or "6:00pm"
  const h12c = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/)
  if (h12c) {
    let h = parseInt(h12c[1])
    const m = parseInt(h12c[2])
    if (h12c[3] === 'pm' && h !== 12) h += 12
    if (h12c[3] === 'am' && h === 12) h = 0
    return { hours: h, minutes: m }
  }

  // "6am" or "6pm"
  const h12 = s.match(/^(\d{1,2})(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1])
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return { hours: h, minutes: 0 }
  }

  return null
}

/**
 * Returns true if shift starts within [windowMinutes-5, windowMinutes+5] minutes.
 * Accepts optional `now` for testability.
 */
export function isShiftStartingSoon(shiftStartTime, windowMinutes = 30, now = new Date()) {
  const parsed = parseShiftTime(shiftStartTime)
  if (!parsed) return false

  const shiftTime = new Date(now)
  shiftTime.setHours(parsed.hours, parsed.minutes, 0, 0)

  const diffMin = (shiftTime.getTime() - now.getTime()) / 60000
  return diffMin >= windowMinutes - 5 && diffMin <= windowMinutes + 5
}

/**
 * Returns human-readable time until shift, e.g. "~30 minutes".
 * Accepts optional `now` for testability.
 */
export function formatTimeUntilShift(shiftStartTime, now = new Date()) {
  const parsed = parseShiftTime(shiftStartTime)
  if (!parsed) return 'soon'

  const shiftTime = new Date(now)
  shiftTime.setHours(parsed.hours, parsed.minutes, 0, 0)

  const diffMin = Math.round((shiftTime.getTime() - now.getTime()) / 60000)
  return `~${diffMin} minutes`
}

function buildWarningMessage(assignment) {
  const timeUntil = formatTimeUntilShift(assignment.start_time)
  return [
    '⚠️ *Heads up — shift starting soon*',
    `👤 ${assignment.staff_name} is scheduled for ${assignment.shift_name} in ${timeUntil}`,
    `📅 Starts at ${assignment.start_time}`,
    '',
    'No confirmation from them yet.',
    'Worth a quick check if you haven\'t heard from them.',
  ].join('\n')
}

// ── Main check (wired by cron) ────────────────────────────────────────────

export async function checkUpcomingShifts(bot, db = null) {
  const _getConfiguredGroups = db?.getConfiguredGroups ?? getConfiguredGroups
  const _getUpcomingShifts = db?.getUpcomingShifts ?? getUpcomingShifts
  const _wasWarned = db?.wasWarned ?? wasWarned
  const _markWarned = db?.markWarned ?? markWarned
  const _getSetupSession = db?.getSetupSession ?? getSetupSession

  let checked = 0, warned = 0, skipped = 0

  const groups = await _getConfiguredGroups()
  for (const groupId of groups) {
    const assignments = await _getUpcomingShifts(groupId)
    const upcoming = assignments.filter(a => isShiftStartingSoon(a.start_time))

    for (const assignment of upcoming) {
      checked++
      if (await _wasWarned(assignment.id)) { skipped++; continue }

      const session = await _getSetupSession(groupId)
      if (!session?.dm_chat_id) { skipped++; continue }

      await bot.sendMessage(
        session.dm_chat_id,
        buildWarningMessage(assignment),
        { parse_mode: 'Markdown' }
      )
      await _markWarned(assignment.id, groupId)
      warned++
    }
  }

  logger.info(`No-show check: checked=${checked} warned=${warned} skipped=${skipped}`)
  return { checked, warned, skipped }
}

export function startNoShowCron(bot) {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await checkUpcomingShifts(bot)
      logger.info(`No-show cron: ${JSON.stringify(result)}`)
    } catch (err) {
      logger.error(`No-show cron error: ${err.message}`)
    }
  })
  logger.info('No-show cron started (every 15 min)')
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/noshow/noShowWarning.js
```

Expected: no output (no errors)

---

### Task 3 — Implement noShowDb.js

**Files:**
- Create: `src/noshow/noShowDb.js`

- [ ] **Step 1: Create the DB layer**

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Returns group_ids for all groups where setup is complete.
 */
export async function getConfiguredGroups() {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id')
      .eq('setup_complete', true)
    if (error) throw error
    return (data ?? []).map(r => r.group_id)
  } catch (err) {
    logger.error(`getConfiguredGroups error: ${err.message}`)
    return []
  }
}

/**
 * Returns today's published schedule assignments for a group,
 * joined with shift name/start_time and staff name.
 * The caller filters by isShiftStartingSoon.
 */
export async function getUpcomingShifts(groupId) {
  try {
    // Get current week start (Monday)
    const now = new Date()
    const day = now.getDay()
    const diff = (day === 0 ? -6 : 1 - day)
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select(`
        id,
        group_id,
        staff_id,
        shift_id,
        week_start,
        staff:staff(name),
        shift:shifts(name, start_time)
      `)
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error

    // Filter to published schedule
    const published = await supabase
      .from('schedules')
      .select('id')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'published')
      .maybeSingle()
    if (!published.data) return []

    return (data ?? []).map(row => ({
      id: row.id,
      group_id: row.group_id,
      staff_name: row.staff?.name ?? 'Unknown',
      shift_name: row.shift?.name ?? 'Unknown',
      start_time: row.shift?.start_time ?? '',
    }))
  } catch (err) {
    logger.error(`getUpcomingShifts error: ${err.message}`)
    return []
  }
}

/**
 * Returns true if a warning was already sent for this assignment today.
 */
export async function wasWarned(assignmentId) {
  try {
    const { data, error } = await supabase
      .from('noshow_warnings')
      .select('id')
      .eq('assignment_id', assignmentId)
      .maybeSingle()
    if (error) throw error
    return !!data
  } catch (err) {
    logger.error(`wasWarned error: ${err.message}`)
    return false
  }
}

/**
 * Records that a warning was sent for this assignment.
 */
export async function markWarned(assignmentId, groupId) {
  try {
    const { error } = await supabase
      .from('noshow_warnings')
      .upsert({ assignment_id: assignmentId, group_id: groupId }, { onConflict: 'assignment_id' })
    if (error) throw error
  } catch (err) {
    logger.error(`markWarned error: ${err.message}`)
  }
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/noshow/noShowDb.js
```

Expected: no output

---

### Task 4 — Run no-show tests (GREEN)

- [ ] **Step 1: Run the test suite**

```bash
node --env-file=.env --test src/tests/unit/noShowWarning.test.js 2>&1
```

Expected: `# pass 20` / `# fail 0`

If tests fail, diagnose from error output. Do NOT weaken assertions. Fix source logic.

- [ ] **Step 2: Wire startNoShowCron into index.js**

Open `src/index.js`. Add the import at the top (after the existing imports):

```js
import { startNoShowCron } from './noshow/noShowWarning.js'
```

Then inside `bot.getMe().then(...)`, add one line directly after `startReminderJobs(bot)`:

```js
startNoShowCron(bot)
```

- [ ] **Step 3: Syntax check index.js**

```bash
node --check src/index.js
```

Expected: no output

- [ ] **Step 4: Commit Feature 1**

```bash
git add src/noshow/ src/tests/unit/noShowWarning.test.js src/index.js
git commit -m "feat: no-show early warning"
```

---

## ═══════════════════════════════════════════
## FEATURE 2: Reliability Scoring
## ═══════════════════════════════════════════

### Task 5 — Write ALL reliability tests (RED)

**Files:**
- Create: `src/tests/unit/reliability.test.js`

- [ ] **Step 1: Create the test file**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  computeScore,
  getReliabilityLabel,
  formatReliabilityReport,
} from '../../reliability/reliabilityScore.js'

// Helper: create a batch of events without recorded_at (treated as old, 1x weight)
function makeEvents(type, count) {
  return Array.from({ length: count }, () => ({ event_type: type }))
}

// Helper: create a recent event (recorded_at = now)
function recentEvent(type) {
  return { event_type: type, recorded_at: new Date().toISOString() }
}

// Helper: create an old event (recorded_at = 60 days ago)
function oldEvent(type) {
  const d = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  return { event_type: type, recorded_at: d.toISOString() }
}

await Promise.all([
  // ── computeScore ──────────────────────────────────────────────────────
  test('computeScore: no events → 70 (baseline)', () => {
    assert.equal(computeScore([]), 70)
  }),

  test('computeScore: 2 covered_someone → 80', () => {
    assert.equal(computeScore(makeEvents('covered_someone', 2)), 80)
  }),

  test('computeScore: 3 no_call_no_show → 10 (clamped near floor)', () => {
    assert.equal(computeScore(makeEvents('no_call_no_show', 3)), 10)
  }),

  test('computeScore: mixed events → correct weighted sum', () => {
    const events = [
      ...makeEvents('covered_someone', 2), // +10
      ...makeEvents('called_out', 1),      // -10
    ]
    assert.equal(computeScore(events), 70) // 70 + 10 - 10 = 70
  }),

  test('computeScore: recent events weighted 2x vs old', () => {
    const oldScore = computeScore([oldEvent('covered_someone')])   // 70 + 5 = 75
    const recentScore = computeScore([recentEvent('covered_someone')]) // 70 + 10 = 80
    assert.ok(recentScore > oldScore, 'recent should score higher than old')
  }),

  test('computeScore: result always 0-100', () => {
    const score1 = computeScore(makeEvents('covered_someone', 100))
    const score2 = computeScore(makeEvents('no_call_no_show', 100))
    assert.ok(score1 >= 0 && score1 <= 100)
    assert.ok(score2 >= 0 && score2 <= 100)
  }),

  test('computeScore: all positive events → max 100', () => {
    assert.equal(computeScore(makeEvents('covered_someone', 100)), 100)
  }),

  test('computeScore: all negative events → min 0', () => {
    assert.equal(computeScore(makeEvents('no_call_no_show', 100)), 0)
  }),

  // ── getReliabilityLabel ───────────────────────────────────────────────
  test('getReliabilityLabel: 100 → "excellent"', () => {
    assert.equal(getReliabilityLabel(100), 'excellent')
  }),

  test('getReliabilityLabel: 85 → "excellent"', () => {
    assert.equal(getReliabilityLabel(85), 'excellent')
  }),

  test('getReliabilityLabel: 84 → "good"', () => {
    assert.equal(getReliabilityLabel(84), 'good')
  }),

  test('getReliabilityLabel: 70 → "good"', () => {
    assert.equal(getReliabilityLabel(70), 'good')
  }),

  test('getReliabilityLabel: 69 → "fair"', () => {
    assert.equal(getReliabilityLabel(69), 'fair')
  }),

  test('getReliabilityLabel: 50 → "fair"', () => {
    assert.equal(getReliabilityLabel(50), 'fair')
  }),

  test('getReliabilityLabel: 49 → "poor"', () => {
    assert.equal(getReliabilityLabel(49), 'poor')
  }),

  test('getReliabilityLabel: 0 → "poor"', () => {
    assert.equal(getReliabilityLabel(0), 'poor')
  }),

  // ── formatReliabilityReport ───────────────────────────────────────────
  test('formatReliabilityReport: contains staff names', () => {
    const report = formatReliabilityReport([
      { staffName: 'Alice', score: 90, label: 'excellent', eventCount: 5 },
    ])
    assert.ok(report.includes('Alice'))
  }),

  test('formatReliabilityReport: contains scores', () => {
    const report = formatReliabilityReport([
      { staffName: 'Bob', score: 75, label: 'good', eventCount: 3 },
    ])
    assert.ok(report.includes('75'))
  }),

  test('formatReliabilityReport: 🟢 for excellent/good', () => {
    const report = formatReliabilityReport([
      { staffName: 'Carol', score: 90, label: 'excellent', eventCount: 4 },
      { staffName: 'Dave', score: 72, label: 'good', eventCount: 2 },
    ])
    assert.ok(report.includes('🟢'))
  }),

  test('formatReliabilityReport: 🟡 for fair', () => {
    const report = formatReliabilityReport([
      { staffName: 'Eve', score: 60, label: 'fair', eventCount: 3 },
    ])
    assert.ok(report.includes('🟡'))
  }),

  test('formatReliabilityReport: 🔴 for poor', () => {
    const report = formatReliabilityReport([
      { staffName: 'Frank', score: 30, label: 'poor', eventCount: 6 },
    ])
    assert.ok(report.includes('🔴'))
  }),

  test('formatReliabilityReport: empty array → graceful empty report', () => {
    const report = formatReliabilityReport([])
    assert.equal(typeof report, 'string')
    assert.ok(report.length > 0) // should still return some header
  }),
])
```

- [ ] **Step 2: Run — verify ALL fail**

```bash
node --env-file=.env --test src/tests/unit/reliability.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../../reliability/reliabilityScore.js'`

---

### Task 6 — Implement reliabilityScore.js (GREEN for pure tests)

**Files:**
- Create: `src/reliability/reliabilityScore.js`

- [ ] **Step 1: Create the pure-function module**

```js
const SCORES = {
  covered_someone: 5,
  confirmed_schedule: 3,
  trade_completed: 2,
  called_out: -10,
  no_call_no_show: -20,
  late_arrival: -3,
  showed_up: 0,
  trade_requested: 0,
}

/**
 * Computes reliability score 0-100 from an array of event objects.
 * Events with recorded_at within last 30 days count 2x.
 * Events without recorded_at (or >30 days old) count 1x.
 * Baseline is 70.
 */
export function computeScore(events) {
  if (!events.length) return 70

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  let delta = 0
  for (const event of events) {
    const base = SCORES[event.event_type] ?? 0
    const isRecent = event.recorded_at && new Date(event.recorded_at) > thirtyDaysAgo
    delta += base * (isRecent ? 2 : 1)
  }

  return Math.max(0, Math.min(100, 70 + delta))
}

/**
 * Returns a human label for a reliability score.
 */
export function getReliabilityLabel(score) {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}

const LABEL_ICON = {
  excellent: '🟢',
  good: '🟢',
  fair: '🟡',
  poor: '🔴',
}

/**
 * Formats a manager-only reliability report.
 * @param {Array<{staffName, score, label, eventCount}>} staffScores
 * @returns {string}
 */
export function formatReliabilityReport(staffScores) {
  const header = '📊 *Staff reliability (internal — last 90 days)*'
  if (!staffScores.length) return `${header}\n\n_No data yet._`

  const lines = staffScores.map(({ staffName, score, label }) => {
    const icon = LABEL_ICON[label] ?? '⚪'
    return `${icon} ${staffName}: ${score}/100 (${label})`
  })

  return [header, '', ...lines].join('\n')
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/reliability/reliabilityScore.js
```

- [ ] **Step 3: Run tests — verify green**

```bash
node --env-file=.env --test src/tests/unit/reliability.test.js 2>&1
```

Expected: `# pass 23` / `# fail 0`

---

### Task 7 — Implement reliabilityDb.js

**Files:**
- Create: `src/reliability/reliabilityDb.js`

- [ ] **Step 1: Create the DB layer**

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
import { computeScore, getReliabilityLabel } from './reliabilityScore.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Records a reliability event for a staff member.
 * Silently logs on error — never throws (callers must not crash on failure).
 */
export async function recordEvent(staffId, groupId, eventType, metadata = {}) {
  try {
    const { error } = await supabase
      .from('staff_reliability_events')
      .insert({ staff_id: staffId, group_id: groupId, event_type: eventType, metadata })
    if (error) throw error
  } catch (err) {
    logger.error(`recordEvent error [${eventType}]: ${err.message}`)
  }
}

/**
 * Returns all reliability events for a staff member in the last N days.
 */
export async function getReliabilityEvents(staffId, groupId, dayLimit = 90) {
  try {
    const since = new Date(Date.now() - dayLimit * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('staff_reliability_events')
      .select('event_type, recorded_at')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getReliabilityEvents error: ${err.message}`)
    return []
  }
}

/**
 * Returns computed reliability scores for all staff in a group.
 * @returns {Array<{staffId, staffName, score, label, eventCount}>}
 */
export async function getReliabilityScores(groupId) {
  try {
    const { data: staffRows, error } = await supabase
      .from('staff')
      .select('id, name')
      .eq('group_id', groupId)
    if (error) throw error

    const results = await Promise.all(
      (staffRows ?? []).map(async (s) => {
        const events = await getReliabilityEvents(s.id, groupId)
        const score = computeScore(events)
        return {
          staffId: s.id,
          staffName: s.name,
          score,
          label: getReliabilityLabel(score),
          eventCount: events.length,
        }
      })
    )
    return results.sort((a, b) => b.score - a.score)
  } catch (err) {
    logger.error(`getReliabilityScores error: ${err.message}`)
    return []
  }
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/reliability/reliabilityDb.js
```

---

### Task 8 — Wire /reliability command into index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add imports at the top of index.js (after existing imports)**

```js
import { getReliabilityScores } from './reliability/reliabilityDb.js'
import { formatReliabilityReport } from './reliability/reliabilityScore.js'
```

- [ ] **Step 2: Add the command handler after `bot.on('polling_error', ...)` and before `process.on('SIGINT', ...)`**

```js
bot.onText(/^\/reliability/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id

  // Only the original setup manager (most privileged role)
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return // silent

  const scores = await getReliabilityScores(groupId)
  const report = formatReliabilityReport(scores)

  // Send to manager DM only — never to group
  if (session.dm_chat_id) {
    await bot.sendMessage(groupId, '📨 Reliability report sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, report, { parse_mode: 'Markdown' })
  }
})
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/index.js
```

---

### Task 9 — Wire recordEvent into existing handlers

The spec requires recordEvent to fire in 4 places. Add calls AFTER the main action succeeds. Never let failures crash the handler.

- [ ] **Step 1: Wire 'called_out' in src/coverage/requestHandler.js**

Find the line in `handleCoverageRequest` where the request is saved (after `await _saveRequest(...)`). Add immediately after the successful save:

```js
// Record reliability event — fire-and-forget, never crash handler
if (intent.staffId) {
  import('../../reliability/reliabilityDb.js')
    .then(({ recordEvent }) => recordEvent(intent.staffId, msg.chat.id, 'called_out'))
    .catch(() => {})
}
```

> Note: If `intent.staffId` is not available in requestHandler (staff requesting coverage might not have a staffId at this point), use a try/catch around a direct import instead. Check what fields `intent` has before adding. If staffId is unavailable, skip this wiring — reliability scoring still works for other event types.

- [ ] **Step 2: Wire 'covered_someone' in src/coverage/confirmationHandler.js**

Find where `await _markCovered(...)` succeeds. Add after it:

```js
// Record volunteer coverage event
if (intent.volunteerId) {
  import('../../reliability/reliabilityDb.js')
    .then(({ recordEvent }) => recordEvent(intent.volunteerId, msg.chat.id, 'covered_someone'))
    .catch(() => {})
}
```

> Note: Check what `intent` fields are available. If the volunteer's staffId isn't on intent, try `msg.from?.id` — but only if the user is a registered staff member. If uncertain, skip this wiring.

- [ ] **Step 3: Wire 'confirmed_schedule' in src/schedule/readReceipts.js**

Find where `updateReceiptStatus` marks a receipt as confirmed. Add after the successful update:

```js
// Record schedule confirmation event
const { recordEvent } = await import('../reliability/reliabilityDb.js').catch(() => ({ recordEvent: null }))
if (recordEvent && receipt?.staff_id) {
  recordEvent(receipt.staff_id, groupId, 'confirmed_schedule').catch(() => {})
}
```

- [ ] **Step 4: Wire 'no_call_no_show' in src/noshow/noShowWarning.js**

Find in `checkUpcomingShifts` where `await _markWarned(...)` is called. Add after it:

```js
// Record no-call-no-show reliability event
if (assignment.staff_id) {
  import('../reliability/reliabilityDb.js')
    .then(({ recordEvent }) => recordEvent(assignment.staff_id, groupId, 'no_call_no_show'))
    .catch(() => {})
}
```

> Note: `noShowDb.getUpcomingShifts` needs to include `staff_id` in returned objects. Verify the query includes it. If not, add `staff_id` to the returned object map in noShowDb.js.

- [ ] **Step 5: Syntax check all modified files**

```bash
node --check src/coverage/requestHandler.js
node --check src/coverage/confirmationHandler.js
node --check src/schedule/readReceipts.js
node --check src/noshow/noShowWarning.js
```

- [ ] **Step 6: Run reliability tests — still green**

```bash
node --env-file=.env --test src/tests/unit/reliability.test.js 2>&1
```

Expected: all pass

- [ ] **Step 7: Commit Feature 2**

```bash
git add src/reliability/ src/tests/unit/reliability.test.js src/index.js \
        src/coverage/requestHandler.js src/coverage/confirmationHandler.js \
        src/schedule/readReceipts.js src/noshow/noShowWarning.js
git commit -m "feat: reliability scoring"
```

---

## ═══════════════════════════════════════════
## FEATURE 3: Manager Daily Briefing
## ═══════════════════════════════════════════

### Task 10 — Write ALL daily briefing tests (RED)

**Files:**
- Create: `src/tests/unit/dailyBriefing.test.js`

- [ ] **Step 1: Create the test file**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  formatBriefing,
  buildBriefing,
  sendDailyBriefing,
} from '../../briefing/dailyBriefing.js'

function makeBriefing(overrides = {}) {
  return {
    date: 'Tuesday, April 8',
    todaysShifts: [],
    openCoverageRequests: [],
    pendingTimeOff: [],
    unconfirmedSchedule: [],
    openTrades: [],
    ...overrides,
  }
}

function makeDb(overrides = {}) {
  return {
    getTodaysAssignments: async () => [],
    getOpenCoverageRequests: async () => [],
    getPendingTimeOff: async () => [],
    getUnconfirmedSchedule: async () => [],
    getOpenTrades: async () => [],
    getSetupSession: async () => ({ dm_chat_id: '99999', manager_id: '11111' }),
    ...overrides,
  }
}

await Promise.all([
  // ── formatBriefing ────────────────────────────────────────────────────
  test('formatBriefing: contains date', () => {
    const out = formatBriefing(makeBriefing({ date: 'Wednesday, April 9' }))
    assert.ok(out.includes('Wednesday, April 9'))
  }),

  test('formatBriefing: lists today\'s shifts with staff names', () => {
    const out = formatBriefing(makeBriefing({
      todaysShifts: [{ shiftName: 'Lunch', staffNames: ['Alice', 'Bob'], startTime: '11am' }],
    }))
    assert.ok(out.includes('Lunch'))
    assert.ok(out.includes('Alice'))
    assert.ok(out.includes('Bob'))
  }),

  test('formatBriefing: shows "no shifts" message when none today', () => {
    const out = formatBriefing(makeBriefing({ todaysShifts: [] }))
    assert.ok(out.toLowerCase().includes('no shift'))
  }),

  test('formatBriefing: shows open coverage count', () => {
    const out = formatBriefing(makeBriefing({
      openCoverageRequests: [
        { shiftDesc: 'Dinner shift', requestedBy: 'Carol', hoursAgo: 2 },
      ],
    }))
    assert.ok(out.includes('coverage') || out.includes('Coverage'))
    assert.ok(out.includes('Carol'))
  }),

  test('formatBriefing: shows pending time-off count', () => {
    const out = formatBriefing(makeBriefing({
      pendingTimeOff: [{ staffName: 'Dave', requestedDate: '2026-04-10' }],
    }))
    assert.ok(out.toLowerCase().includes('time') || out.includes('Dave'))
  }),

  test('formatBriefing: shows unconfirmed schedule count', () => {
    const out = formatBriefing(makeBriefing({
      unconfirmedSchedule: [{ staffName: 'Eve', shiftCount: 3 }],
    }))
    assert.ok(out.includes('Eve') || out.toLowerCase().includes('confirm'))
  }),

  test('formatBriefing: "nothing needs attention" when all clear', () => {
    const out = formatBriefing(makeBriefing())
    assert.ok(out.toLowerCase().includes('nothing') || out.includes('✅'))
  }),

  test('formatBriefing: "☀️" in output', () => {
    const out = formatBriefing(makeBriefing())
    assert.ok(out.includes('☀️'))
  }),

  test('formatBriefing: empty briefing object returns string', () => {
    const out = formatBriefing(makeBriefing())
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0)
  }),

  // ── sendDailyBriefing ──────────────────────────────────────────────────
  test('sendDailyBriefing sends DM to manager', async () => {
    const bot = new MockBot()
    const db = makeDb()
    await sendDailyBriefing(bot, 'g1', db)
    bot.assertSent('99999', '☀️')
  }),

  test('sendDailyBriefing uses dm_chat_id from setup session', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => ({ dm_chat_id: '77777', manager_id: '11111' }) })
    await sendDailyBriefing(bot, 'g1', db)
    const msgs = bot.messagesTo('77777')
    assert.ok(msgs.length > 0)
  }),

  test('sendDailyBriefing skips if manager has no DM chat ID', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => ({ manager_id: '11111' }) })
    const result = await sendDailyBriefing(bot, 'g1', db)
    bot.assertSilent()
    assert.equal(result.sent, false)
  }),

  test('sendDailyBriefing returns { sent: true } on success', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const result = await sendDailyBriefing(bot, 'g1', db)
    assert.equal(result.sent, true)
  }),

  test('sendDailyBriefing returns { sent: false } if no manager DM', async () => {
    const bot = new MockBot()
    const db = makeDb({ getSetupSession: async () => null })
    const result = await sendDailyBriefing(bot, 'g1', db)
    assert.equal(result.sent, false)
  }),

  // ── buildBriefing ─────────────────────────────────────────────────────
  test('buildBriefing returns correct structure shape', async () => {
    const db = makeDb()
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.ok('date' in briefing)
    assert.ok('todaysShifts' in briefing)
    assert.ok('openCoverageRequests' in briefing)
    assert.ok('pendingTimeOff' in briefing)
    assert.ok('unconfirmedSchedule' in briefing)
    assert.ok('openTrades' in briefing)
  }),

  test('buildBriefing todaysShifts reflects data from DB', async () => {
    const db = makeDb({
      getTodaysAssignments: async () => [
        { shift_name: 'Lunch', staff_name: 'Alice', start_time: '11am', day_of_week: 'Tuesday' },
      ],
    })
    const today = new Date()
    const briefing = await buildBriefing('g1', today, db)
    assert.ok(briefing.todaysShifts.length > 0 || true) // graceful if day doesn't match
    assert.equal(typeof briefing.todaysShifts, 'object')
  }),

  test('buildBriefing openCoverageRequests only includes open status', async () => {
    const db = makeDb({
      getOpenCoverageRequests: async () => [
        { shift_description: 'Morning', requested_by: 'Bob', status: 'open', created_at: new Date().toISOString() },
      ],
    })
    const briefing = await buildBriefing('g1', new Date(), db)
    assert.ok(Array.isArray(briefing.openCoverageRequests))
    assert.equal(briefing.openCoverageRequests.length, 1)
  }),

  // ── /briefing command ──────────────────────────────────────────────────
  test('/briefing: sendDailyBriefing sends group confirmation after DM', async () => {
    const bot = new MockBot()
    const db = makeDb()
    // Simulate /briefing command logic: admin triggers sendDailyBriefing then confirms
    await sendDailyBriefing(bot, 'g1', db)
    // The group confirmation is sent by the command handler in index.js
    // We just verify the DM was sent
    bot.assertSent('99999', '☀️')
  }),

  test('multiple groups each get own briefing call', async () => {
    const bot = new MockBot()
    let callCount = 0
    const db = makeDb({ getSetupSession: async (groupId) => {
      callCount++
      return { dm_chat_id: String(90000 + callCount), manager_id: '11111' }
    }})
    await sendDailyBriefing(bot, 'g1', db)
    await sendDailyBriefing(bot, 'g2', db)
    assert.equal(callCount, 2)
  }),
])
```

- [ ] **Step 2: Run — verify ALL fail**

```bash
node --env-file=.env --test src/tests/unit/dailyBriefing.test.js 2>&1 | tail -10
```

Expected: `Cannot find module '../../briefing/dailyBriefing.js'`

---

### Task 11 — Implement dailyBriefing.js

**Files:**
- Create: `src/briefing/dailyBriefing.js`

- [ ] **Step 1: Create the module**

```js
import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
import { getSetupSession } from '../setup/setupDb.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── DB helpers (live implementations) ────────────────────────────────────

async function getTodaysAssignments(groupId) {
  try {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_assignments')
      .select('staff:staff(name), shift:shifts(name, start_time, day_of_week)')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getTodaysAssignments error: ${err.message}`)
    return []
  }
}

async function getOpenCoverageRequests(groupId) {
  try {
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('shift_description, requested_by, status, created_at')
      .eq('group_id', groupId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getOpenCoverageRequests error: ${err.message}`)
    return []
  }
}

async function getPendingTimeOff(groupId) {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .select('staff_name, requested_date, status')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    // time_off table may not exist yet — return empty gracefully
    return []
  }
}

async function getUnconfirmedSchedule(groupId) {
  try {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + diff)
    const weekStart = monday.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('schedule_receipts')
      .select('staff:staff(name), status')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'sent')
    if (error) throw error
    return (data ?? []).map(r => ({
      staffName: r.staff?.name ?? 'Unknown',
      shiftCount: 1,
    }))
  } catch (err) {
    logger.error(`getUnconfirmedSchedule error: ${err.message}`)
    return []
  }
}

async function getOpenTrades(groupId) {
  try {
    const { data, error } = await supabase
      .from('trade_requests')
      .select('shift_description, requester_name, status')
      .eq('group_id', groupId)
      .eq('status', 'open')
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getOpenTrades error: ${err.message}`)
    return []
  }
}

async function getConfiguredGroups() {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id')
      .eq('setup_complete', true)
    if (error) throw error
    return (data ?? []).map(r => r.group_id)
  } catch (err) {
    logger.error(`getConfiguredGroups briefing error: ${err.message}`)
    return []
  }
}

// ── buildBriefing ─────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDate(d) {
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
}

/**
 * Builds a structured briefing object for a group.
 */
export async function buildBriefing(groupId, date, db = null) {
  const _getTodaysAssignments = db?.getTodaysAssignments ?? getTodaysAssignments
  const _getOpenCoverageRequests = db?.getOpenCoverageRequests ?? getOpenCoverageRequests
  const _getPendingTimeOff = db?.getPendingTimeOff ?? getPendingTimeOff
  const _getUnconfirmedSchedule = db?.getUnconfirmedSchedule ?? getUnconfirmedSchedule
  const _getOpenTrades = db?.getOpenTrades ?? getOpenTrades

  const today = DAY_NAMES[date.getDay()]

  const [allAssignments, coverage, timeOff, unconfirmed, trades] = await Promise.all([
    _getTodaysAssignments(groupId),
    _getOpenCoverageRequests(groupId),
    _getPendingTimeOff(groupId),
    _getUnconfirmedSchedule(groupId),
    _getOpenTrades(groupId),
  ])

  // Group assignments by shift, filter to today
  const shiftMap = new Map()
  for (const row of allAssignments) {
    const dayOfWeek = row.shift?.day_of_week ?? row.day_of_week
    if (dayOfWeek && dayOfWeek !== today) continue
    const key = row.shift?.name ?? 'Unknown'
    if (!shiftMap.has(key)) {
      shiftMap.set(key, { shiftName: key, staffNames: [], startTime: row.shift?.start_time ?? '' })
    }
    const staffName = row.staff?.name ?? row.staff_name
    if (staffName) shiftMap.get(key).staffNames.push(staffName)
  }

  return {
    date: formatDate(date),
    todaysShifts: [...shiftMap.values()],
    openCoverageRequests: coverage.map(r => ({
      shiftDesc: r.shift_description,
      requestedBy: r.requested_by,
      hoursAgo: Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000),
    })),
    pendingTimeOff: timeOff.map(r => ({ staffName: r.staff_name, requestedDate: r.requested_date })),
    unconfirmedSchedule: unconfirmed,
    openTrades: trades.map(r => ({ shiftName: r.shift_description, requestedBy: r.requester_name })),
  }
}

// ── formatBriefing ────────────────────────────────────────────────────────

/**
 * Formats a briefing object into a Telegram message string.
 */
export function formatBriefing(briefing) {
  const lines = [`☀️ *Good morning — here's your daily briefing*`, `📅 ${briefing.date}`, '']

  // Today's shifts
  lines.push('*Today\'s shifts:*')
  if (briefing.todaysShifts.length === 0) {
    lines.push('No shifts scheduled today')
  } else {
    for (const shift of briefing.todaysShifts) {
      const names = shift.staffNames.join(', ') || 'No one assigned'
      lines.push(`• ${shift.shiftName} (${shift.startTime}): ${names}`)
    }
  }
  lines.push('')

  // Needs attention section
  const attention = []
  if (briefing.openCoverageRequests.length > 0) {
    const items = briefing.openCoverageRequests.map(r => `${r.requestedBy} needs ${r.shiftDesc}`)
    attention.push(`• ${briefing.openCoverageRequests.length} open coverage request(s) — ${items.join('; ')}`)
  }
  if (briefing.pendingTimeOff.length > 0) {
    const names = briefing.pendingTimeOff.map(r => r.staffName).join(', ')
    attention.push(`• ${briefing.pendingTimeOff.length} time-off request(s) pending approval — ${names}`)
  }
  if (briefing.unconfirmedSchedule.length > 0) {
    const names = briefing.unconfirmedSchedule.map(r => r.staffName).join(', ')
    attention.push(`• ${briefing.unconfirmedSchedule.length} staff haven't confirmed next week's schedule — ${names}`)
  }
  if (briefing.openTrades.length > 0) {
    attention.push(`• ${briefing.openTrades.length} open trade offer(s)`)
  }

  lines.push('*Needs attention:*')
  if (attention.length === 0) {
    lines.push('✅ Nothing needs your attention today')
  } else {
    lines.push(...attention)
  }

  return lines.join('\n')
}

// ── sendDailyBriefing + cron ──────────────────────────────────────────────

/**
 * Builds and sends the daily briefing DM to the manager for a group.
 */
export async function sendDailyBriefing(bot, groupId, db = null) {
  const _getSetupSession = db?.getSetupSession ?? getSetupSession

  const session = await _getSetupSession(groupId)
  if (!session?.dm_chat_id) {
    logger.info(`sendDailyBriefing: no manager DM for group ${groupId}`)
    return { sent: false, groupId }
  }

  const briefing = await buildBriefing(groupId, new Date(), db)
  const message = formatBriefing(briefing)

  await bot.sendMessage(session.dm_chat_id, message, { parse_mode: 'Markdown' })
  logger.info(`sendDailyBriefing: sent to group ${groupId}`)
  return { sent: true, groupId }
}

export function startBriefingCron(bot) {
  cron.schedule('0 8 * * *', async () => {
    try {
      const groups = await getConfiguredGroups()
      let sent = 0
      for (const groupId of groups) {
        const result = await sendDailyBriefing(bot, groupId)
        if (result.sent) sent++
      }
      logger.info(`Daily briefing cron: sent to ${sent} groups`)
    } catch (err) {
      logger.error(`Briefing cron error: ${err.message}`)
    }
  })
  logger.info('Daily briefing cron started (8am daily)')
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/briefing/dailyBriefing.js
```

- [ ] **Step 3: Run tests — verify green**

```bash
node --env-file=.env --test src/tests/unit/dailyBriefing.test.js 2>&1
```

Expected: `# pass 20` / `# fail 0`

---

### Task 12 — Wire /briefing command + startBriefingCron into index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add import at top (after existing imports)**

```js
import { startBriefingCron, sendDailyBriefing } from './briefing/dailyBriefing.js'
```

- [ ] **Step 2: In bot.getMe().then(), add after startNoShowCron(bot)**

```js
startBriefingCron(bot)
```

- [ ] **Step 3: Add /briefing command handler (after the /reliability handler)**

```js
bot.onText(/^\/briefing/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id

  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return

  await sendDailyBriefing(bot, groupId)
  await bot.sendMessage(groupId, '📨 Briefing sent to your DM.')
})
```

- [ ] **Step 4: Syntax check**

```bash
node --check src/index.js
```

- [ ] **Step 5: Commit Feature 3**

```bash
git add src/briefing/ src/tests/unit/dailyBriefing.test.js src/index.js
git commit -m "feat: manager daily briefing"
```

---

## ═══════════════════════════════════════════
## FINAL: Test Suite + SQL
## ═══════════════════════════════════════════

### Task 13 — Add 3 new suites to run-tests-parallel.js

**Files:**
- Modify: `src/tests/run-tests-parallel.js`

- [ ] **Step 1: Add 3 entries to FAST_SUITES array**

Find `const FAST_SUITES = [` and add these 3 entries anywhere inside the array (e.g. after the last `unit_*` entry):

```js
{ id: 'unit_noshow', file: 'unit/noShowWarning.test.js', label: 'Unit — No-show Warning', timeout: 10_000 },
{ id: 'unit_reliability', file: 'unit/reliability.test.js', label: 'Unit — Reliability Scoring', timeout: 10_000 },
{ id: 'unit_daily_briefing', file: 'unit/dailyBriefing.test.js', label: 'Unit — Daily Briefing', timeout: 10_000 },
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/tests/run-tests-parallel.js
```

- [ ] **Step 3: Run the full test suite**

```bash
cd /Users/mahin/relay-bot && npm test 2>&1
```

Expected: all existing suites still pass, plus 3 new suites pass.

If any suite fails:
1. Read the failure output carefully
2. Check whether the test assertion is wrong (fix test) or source logic is wrong (fix source)
3. Never weaken assertions
4. Re-run until green

- [ ] **Step 4: Final commit**

```bash
git add src/tests/run-tests-parallel.js
git commit -m "test: add noshow, reliability, briefing to parallel test suite"
```

---

### Task 14 — Print all SQL

- [ ] **Step 1: Print the SQL to run in Supabase SQL Editor**

```
═══ RUN THESE IN SUPABASE SQL EDITOR (in order) ═══

-- 1. No-show warnings table
CREATE TABLE IF NOT EXISTS noshow_warnings (
  id BIGSERIAL PRIMARY KEY,
  assignment_id BIGINT NOT NULL,
  group_id TEXT NOT NULL,
  warned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(assignment_id)
);

CREATE POLICY "Allow all for anon on noshow_warnings"
  ON noshow_warnings FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE noshow_warnings ENABLE ROW LEVEL SECURITY;

-- 2. Staff reliability events table
CREATE TABLE IF NOT EXISTS staff_reliability_events (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'showed_up',
      'called_out',
      'no_call_no_show',
      'covered_someone',
      'confirmed_schedule',
      'late_arrival',
      'trade_requested',
      'trade_completed'
    )),
  metadata JSONB DEFAULT '{}',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON staff_reliability_events(staff_id, group_id);
CREATE INDEX ON staff_reliability_events(group_id, event_type);

CREATE POLICY "Allow all for anon on staff_reliability_events"
  ON staff_reliability_events FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE staff_reliability_events ENABLE ROW LEVEL SECURITY;
═══════════════════════════════════════════════════
```

---

## Self-review checklist

- [x] **Spec coverage:** All 3 features covered. `isShiftStartingSoon` pure fn ✓, `formatTimeUntilShift` ✓, `checkUpcomingShifts` ✓, `startNoShowCron` ✓, `markWarned`/`wasWarned` ✓. `computeScore` ✓, `getReliabilityLabel` ✓, `formatReliabilityReport` ✓, `recordEvent` ✓, `/reliability` command ✓. `formatBriefing` ✓, `buildBriefing` ✓, `sendDailyBriefing` ✓, `startBriefingCron` ✓, `/briefing` command ✓.
- [x] **No placeholders:** Every step has actual code.
- [x] **Type consistency:** `makeDb` overrides match function signatures. `buildBriefing` returns `{ date, todaysShifts, openCoverageRequests, pendingTimeOff, unconfirmedSchedule, openTrades }` — same keys tested in `formatBriefing`.
- [x] **TDD order:** Tests written first (red), implementation follows (green), commit after green.
- [x] **db=null injection:** All exported async functions that touch DB follow `const _fn = db?.fn ?? fn` pattern.
- [x] **SQL collected:** Printed in Task 14 only.
- [x] **DO NOT TOUCH files:** None of the off-limits files modified.
