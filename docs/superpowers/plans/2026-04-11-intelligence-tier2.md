# Intelligence Tier 2 — Six Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 intelligence features: auto-generated shift log, demand-aware scheduling, coverage speed optimization, contextual warnings during schedule review, weekly AI narrative briefing, and emergency availability query.

**Architecture:** Each feature is a standalone module in `src/intelligence/` or `src/managerLog/` with pure functions for logic, async functions for DB queries, and db=null injection for testability. Features integrate into existing flows via `commandRouter.js` (schedule draft), `dailyBriefing.js` (Sunday briefing), and `requestHandler.js` (coverage DMs). All Cerebras LLM calls use `groqWithRetry()`.

**Tech Stack:** Node.js 25, ES modules, node:test + assert/strict, Supabase (postgres), Cerebras llama-3.3-70b via OpenAI SDK, MockBot/MockDB from `src/tests/helpers/mocks.js`

---

## File Ownership Map

| Agent | Owns (create/extend) | Touches (insert hook only) |
|-------|----------------------|---------------------------|
| 1 | `src/managerLog/shiftLog.js` (extend), `src/tests/unit/autoShiftLog.test.js` | — |
| 2 | `src/intelligence/demandSignals.js`, `src/tests/unit/demandSignals.test.js` | — |
| 3 | `src/intelligence/coverageSpeed.js`, `src/tests/unit/coverageSpeed.test.js` | — |
| 4 | `src/intelligence/contextualWarnings.js`, `src/tests/unit/contextualWarnings.test.js` | — |
| 5 | `src/intelligence/narrativeBriefing.js`, `src/tests/unit/narrativeBriefing.test.js` | — |
| 6 | `src/intelligence/emergencyAvailability.js`, `src/tests/unit/emergencyAvailability.test.js` | — |
| Wire A | — | `src/routing/commandRouter.js` (demand + contextual warnings) |
| Wire B | — | `src/coverage/requestHandler.js` (coverage speed), `src/routing/dmRouter.js` (emergency) |
| Wire C | — | `src/briefing/dailyBriefing.js` (Sunday briefing), `src/routing/groupRouter.js` (demand listener) |

## Key Codebase Facts

- **DB injection pattern:** `const _fn = db?.fn ?? liveFn` (see `requestHandler.js:34-40`)
- **Import style:** ES modules, named exports, relative paths with `.js` extension
- **Test pattern:** `node:test` with `describe/test`, `assert` from `node:assert/strict`, `MockBot`/`MockDB` from `../helpers/mocks.js`
- **LLM calls:** `import { groq, groqWithRetry, extractJSON } from '../parsers/groq.js'` — model: `llama-3.3-70b`
- **coverage_requests columns:** id, group_id, group_name, shift_description, requested_by, requester_telegram_id, matched_shift_id, week_start, status, covered_by (TEXT), created_at, covered_at (TIMESTAMPTZ)
- **No `confirmed_at` or `covered_by_id`** on coverage_requests — use `covered_at` for timing, `covered_by` (TEXT name) for identity
- **manager_log_entries columns:** id, group_id, manager_id (BIGINT), entry_text, shift_name, day_of_week, week_start, created_at
- **generateWeeklySchedule returns:** `{ assignments, gaps, weekStart, scheduleId, clopenings, hoursIssues, ruleConflicts }`
- **Draft schedule sent to manager in:** `commandRouter.js:127-129` — message built from `formatted + clopeningWarn + hoursWarn + budgetSection + rulesSection + prefsSection + alertsSection + reviewPrompt`
- **Briefing cron:** `dailyBriefing.js:284-299` — `cron.schedule('0 8 * * *', ...)`, uses `getConfiguredGroups()` to iterate all groups
- **Coverage DM loop:** `requestHandler.js:95-114` — iterates `toNotify`, sends bot.sendMessage per member
- **saveLogEntry signature:** `saveLogEntry(groupId, managerId, text, shiftReference, db = null)` where shiftReference = `{ shiftName, dayOfWeek, weekStart }`
- **formatLogEntry:** formats single entry with day abbreviation, date, time, optional shift name with clipboard emoji
- **reliability events:** `recordEvent(staffId, groupId, eventType, metadata = {})` — types: covered_someone (+5), called_out (-10), no_call_no_show (-20), late_arrival (-3)
- **morale events:** `saveMoraleEvent(groupId, staffId, { type, responseMinutes, sentiment, weekStart })`
- **patternAlerts.js:** `analyzeCoveragePatterns(groupId, weeksBack, db)` returns `[{ staffId, staffName, dayOfWeek, shiftName, calloutCount, totalScheduled, calloutRate }]`

---

## SQL — New Table (Print at End)

```sql
CREATE TABLE IF NOT EXISTS demand_signals (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  day_of_week TEXT,
  is_week_level BOOLEAN DEFAULT FALSE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('high', 'low', 'normal')),
  raw_mention TEXT NOT NULL,
  source_user_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, week_start, day_of_week)
);
CREATE INDEX idx_demand_signals_group_week ON demand_signals(group_id, week_start);
```

---

### Task 1: Auto-Generated Shift Log

**Files:**
- Extend: `src/managerLog/shiftLog.js`
- Test: `src/tests/unit/autoShiftLog.test.js`

**Context:** The existing `shiftLog.js` has: `detectShiftReference`, `formatLogEntry`, `formatLogBook`, `handleLogEntry`, `handleLogCommand`. The existing `shiftLogDb.js` has: `saveLogEntry(groupId, managerId, text, shiftReference, db)`, `getLogEntries`, `searchLogEntries`. We add 3 new exported functions to `shiftLog.js` — pure `buildShiftNarrative`, async `compileShiftData`, and async `autoLogShift`. We also modify `formatLogEntry` to show "(auto)" when `manager_id` is null.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/autoShiftLog.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { buildShiftNarrative } from '../../managerLog/shiftLog.js'

const cleanShiftData = {
  shiftName: 'Tuesday Lunch',
  dayOfWeek: 'Tuesday',
  date: '2025-01-07',
  staffScheduled: [{ staffId: 1, staffName: 'Marcus' }],
  callouts: [],
  coverageEvents: [],
  lateArrivals: [],
  noShows: [],
  fullyCovered: true,
}

const chaosShiftData = {
  shiftName: 'Friday Dinner',
  dayOfWeek: 'Friday',
  date: '2025-01-10',
  staffScheduled: [
    { staffId: 1, staffName: 'Marcus' },
    { staffId: 2, staffName: 'Sarah' },
  ],
  callouts: [{ staffName: 'Marcus', reportedAt: '2025-01-10T16:02:00Z', minutesBefore: 58 }],
  coverageEvents: [{
    requestedBy: 'Marcus', coveredBy: 'Dani',
    requestedAt: '2025-01-10T16:05:00Z', confirmedAt: '2025-01-10T16:13:00Z',
    fillMinutes: 8, wasPartial: false,
  }],
  lateArrivals: [{ staffName: 'Sarah', minutesLate: 17 }],
  noShows: [],
  fullyCovered: true,
}

const noShowData = {
  shiftName: 'Saturday Brunch',
  dayOfWeek: 'Saturday',
  date: '2025-01-11',
  staffScheduled: [{ staffId: 3, staffName: 'Jake' }],
  callouts: [],
  coverageEvents: [],
  lateArrivals: [],
  noShows: [{ staffName: 'Jake' }],
  fullyCovered: false,
}

const partialData = {
  shiftName: 'Sunday Dinner',
  dayOfWeek: 'Sunday',
  date: '2025-01-12',
  staffScheduled: [{ staffId: 1, staffName: 'Marcus' }],
  callouts: [{ staffName: 'Marcus', reportedAt: '2025-01-12T15:00:00Z', minutesBefore: 120 }],
  coverageEvents: [{
    requestedBy: 'Marcus', coveredBy: 'Emma',
    requestedAt: '2025-01-12T15:05:00Z', confirmedAt: '2025-01-12T15:15:00Z',
    fillMinutes: 10, wasPartial: true, partialFrom: '5:00pm', partialTo: '8:00pm',
  }],
  lateArrivals: [],
  noShows: [],
  fullyCovered: true,
}

describe('buildShiftNarrative', () => {
  test('clean shift — no events', () => {
    const result = buildShiftNarrative(cleanShiftData)
    assert.ok(result.includes('Tuesday Lunch'), 'contains shift name')
    assert.ok(result.includes('2025-01-07'), 'contains date')
    assert.ok(result.includes('Clean shift'), 'contains clean shift indicator')
    assert.ok(!result.includes('called out'), 'no callout text')
    assert.ok(!result.includes('covered'), 'no coverage text')
    assert.ok(!result.includes('late'), 'no late text')
  })

  test('chaos shift — callout, coverage, late arrival', () => {
    const result = buildShiftNarrative(chaosShiftData)
    assert.ok(result.includes('Marcus called out'), 'contains callout')
    assert.ok(result.includes('58min before'), 'contains minutes before')
    assert.ok(result.includes('Dani covered'), 'contains coverage volunteer')
    assert.ok(result.includes('8min'), 'contains fill time')
    assert.ok(result.includes('Sarah'), 'contains late staff')
    assert.ok(result.includes('17min late'), 'contains late duration')
    assert.ok(result.includes('Full coverage achieved'), 'contains full coverage note')
    // Chronological: callout before coverage before late
    const calloutIdx = result.indexOf('Marcus called out')
    const coverageIdx = result.indexOf('Dani covered')
    const lateIdx = result.indexOf('Sarah')
    assert.ok(calloutIdx < coverageIdx, 'callout before coverage')
    assert.ok(coverageIdx < lateIdx, 'coverage before late arrival')
  })

  test('no show — understaffed warning', () => {
    const result = buildShiftNarrative(noShowData)
    assert.ok(result.includes('Jake'), 'contains no-show name')
    assert.ok(result.includes('no-show'), 'contains no-show text')
    assert.ok(result.includes('understaffed'), 'contains understaffed warning')
  })

  test('partial coverage', () => {
    const result = buildShiftNarrative(partialData)
    assert.ok(result.includes('Emma'), 'contains partial cover volunteer')
    assert.ok(result.includes('5:00pm'), 'contains partial from time')
    assert.ok(result.includes('8:00pm'), 'contains partial to time')
  })
})

describe('compileShiftData', () => {
  test('returns correct structure from mock DB', async () => {
    const { compileShiftData } = await import('../../managerLog/shiftLog.js')
    const db = {
      getScheduleAssignments: async () => [
        { staff_id: 1, staff_name: 'Marcus', shift_id: 10, day_of_week: 'Friday' },
      ],
      getCoverageRequestsForShift: async () => [{
        requested_by: 'Marcus', covered_by: 'Dani', status: 'covered',
        created_at: '2025-01-10T16:05:00Z', covered_at: '2025-01-10T16:13:00Z',
      }],
      getReliabilityEventsForDate: async () => [
        { staff_id: 1, event_type: 'late_arrival', metadata: { minutes_late: 17, staff_name: 'Marcus' } },
      ],
      getNoShowEventsForShift: async () => [],
    }
    const result = await compileShiftData('group1', 10, '2025-01-10', 'Friday Dinner', 'Friday', db)
    assert.ok(Array.isArray(result.staffScheduled), 'staffScheduled is array')
    assert.ok(Array.isArray(result.callouts), 'callouts is array')
    assert.ok(Array.isArray(result.coverageEvents), 'coverageEvents is array')
    assert.ok(Array.isArray(result.lateArrivals), 'lateArrivals is array')
    assert.ok(Array.isArray(result.noShows), 'noShows is array')
    assert.equal(result.staffScheduled.length, 1)
  })

  test('empty DB results return empty arrays', async () => {
    const { compileShiftData } = await import('../../managerLog/shiftLog.js')
    const db = {
      getScheduleAssignments: async () => [],
      getCoverageRequestsForShift: async () => [],
      getReliabilityEventsForDate: async () => [],
      getNoShowEventsForShift: async () => [],
    }
    const result = await compileShiftData('group1', 10, '2025-01-10', 'Friday Dinner', 'Friday', db)
    assert.equal(result.staffScheduled.length, 0)
    assert.equal(result.callouts.length, 0)
    assert.equal(result.coverageEvents.length, 0)
    assert.equal(result.lateArrivals.length, 0)
    assert.equal(result.noShows.length, 0)
  })
})

describe('autoLogShift', () => {
  test('calls saveLogEntry with narrative, managerId null', async () => {
    const { autoLogShift } = await import('../../managerLog/shiftLog.js')
    const bot = new MockBot()
    let savedEntry = null
    const db = {
      getScheduleAssignments: async () => [
        { staff_id: 1, staff_name: 'Marcus', shift_id: 10, day_of_week: 'Friday' },
      ],
      getCoverageRequestsForShift: async () => [],
      getReliabilityEventsForDate: async () => [],
      getNoShowEventsForShift: async () => [],
      getLogEntryForShiftDate: async () => null,
      saveLogEntry: async (groupId, managerId, text, shiftRef) => {
        savedEntry = { groupId, managerId, text, shiftRef }
        return { id: 1, entry_text: text }
      },
    }
    const result = await autoLogShift(bot, 'group1', 10, '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)
    assert.ok(savedEntry, 'saveLogEntry was called')
    assert.equal(savedEntry.managerId, null, 'managerId is null for auto entries')
    assert.ok(savedEntry.text.includes('Clean shift'), 'narrative contains clean shift')
    assert.equal(bot.sentMessages.length, 0, 'bot does NOT send message')
  })

  test('skips if log entry already exists for shift+date', async () => {
    const { autoLogShift } = await import('../../managerLog/shiftLog.js')
    const bot = new MockBot()
    let saveCalled = false
    const db = {
      getScheduleAssignments: async () => [],
      getCoverageRequestsForShift: async () => [],
      getReliabilityEventsForDate: async () => [],
      getNoShowEventsForShift: async () => [],
      getLogEntryForShiftDate: async () => ({ id: 99, entry_text: 'already logged' }),
      saveLogEntry: async () => { saveCalled = true },
    }
    await autoLogShift(bot, 'group1', 10, '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)
    assert.ok(!saveCalled, 'saveLogEntry NOT called when entry exists')
  })
})

describe('formatLogEntry — auto indicator', () => {
  test('shows (auto) when manager_id is null', () => {
    const { formatLogEntry } = await import('../../managerLog/shiftLog.js')
    const entry = {
      entry_text: 'Clean shift.',
      shift_name: 'Tuesday Lunch',
      day_of_week: 'Tuesday',
      created_at: '2025-01-07T14:30:00Z',
      manager_id: null,
    }
    const result = formatLogEntry(entry)
    assert.ok(result.includes('(auto)'), 'contains auto indicator')
  })

  test('no (auto) when manager_id is set', () => {
    const { formatLogEntry } = await import('../../managerLog/shiftLog.js')
    const entry = {
      entry_text: 'Good shift tonight.',
      shift_name: 'Friday Dinner',
      day_of_week: 'Friday',
      created_at: '2025-01-10T23:30:00Z',
      manager_id: 12345,
    }
    const result = formatLogEntry(entry)
    assert.ok(!result.includes('(auto)'), 'no auto indicator for manual entry')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
node --test src/tests/unit/autoShiftLog.test.js
```
Expected: FAIL — `buildShiftNarrative` not exported

- [ ] **Step 3: Implement buildShiftNarrative in shiftLog.js**

Add to `src/managerLog/shiftLog.js` (after existing exports):

```javascript
export function buildShiftNarrative(shiftData) {
  const { shiftName, dayOfWeek, date, callouts, coverageEvents, lateArrivals, noShows, fullyCovered } = shiftData
  const lines = [`*${shiftName}* — ${dayOfWeek} ${date}`]

  const hasEvents = callouts.length > 0 || coverageEvents.length > 0 || lateArrivals.length > 0 || noShows.length > 0
  if (!hasEvents) {
    lines.push('✅ Clean shift. No issues.')
    return lines.join('\n')
  }

  // Build events chronologically
  const events = []

  for (const c of callouts) {
    events.push({ time: c.reportedAt, text: `${c.staffName} called out ${c.minutesBefore}min before shift.` })
  }

  for (const cv of coverageEvents) {
    if (cv.wasPartial && cv.partialFrom && cv.partialTo) {
      events.push({ time: cv.confirmedAt, text: `${cv.coveredBy} covered ${cv.partialFrom}–${cv.partialTo} (${cv.fillMinutes}min to confirm).` })
    } else {
      events.push({ time: cv.confirmedAt, text: `${cv.coveredBy} covered (${cv.fillMinutes}min to confirm).` })
    }
  }

  for (const l of lateArrivals) {
    events.push({ time: null, text: `${l.staffName} arrived ${l.minutesLate}min late.` })
  }

  for (const n of noShows) {
    events.push({ time: null, text: `⚠️ ${n.staffName} no-showed.` })
  }

  // Sort by time if available (null-timed events go last)
  events.sort((a, b) => {
    if (!a.time && !b.time) return 0
    if (!a.time) return 1
    if (!b.time) return -1
    return new Date(a.time) - new Date(b.time)
  })

  for (const e of events) {
    lines.push(e.text)
  }

  if (fullyCovered && callouts.length > 0) {
    lines.push('Full coverage achieved.')
  } else if (!fullyCovered) {
    lines.push('⚠️ Shift ran understaffed.')
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Implement compileShiftData**

Add to `src/managerLog/shiftLog.js`:

```javascript
export async function compileShiftData(groupId, shiftId, shiftDate, shiftName, dayOfWeek, db = null) {
  const _getAssignments = db?.getScheduleAssignments ?? (async () => [])
  const _getCoverageRequests = db?.getCoverageRequestsForShift ?? (async () => [])
  const _getReliabilityEvents = db?.getReliabilityEventsForDate ?? (async () => [])
  const _getNoShows = db?.getNoShowEventsForShift ?? (async () => [])

  const [assignments, coverageReqs, reliabilityEvents, noShowEvents] = await Promise.all([
    _getAssignments(groupId, shiftId, shiftDate),
    _getCoverageRequests(groupId, shiftId, shiftDate),
    _getReliabilityEvents(groupId, shiftDate),
    _getNoShows(groupId, shiftId, shiftDate),
  ])

  const staffScheduled = assignments.map(a => ({ staffId: a.staff_id, staffName: a.staff_name }))

  const callouts = coverageReqs
    .filter(r => r.status === 'covered' || r.status === 'open')
    .map(r => ({
      staffName: r.requested_by,
      reportedAt: r.created_at,
      minutesBefore: r.covered_at
        ? Math.round((new Date(r.covered_at).getTime() - new Date(r.created_at).getTime()) / 60000)
        : 0,
    }))

  const coverageEvents = coverageReqs
    .filter(r => r.status === 'covered' && r.covered_by)
    .map(r => ({
      requestedBy: r.requested_by,
      coveredBy: r.covered_by,
      requestedAt: r.created_at,
      confirmedAt: r.covered_at,
      fillMinutes: r.covered_at
        ? Math.round((new Date(r.covered_at).getTime() - new Date(r.created_at).getTime()) / 60000)
        : 0,
      wasPartial: false,
    }))

  const lateArrivals = reliabilityEvents
    .filter(e => e.event_type === 'late_arrival' && e.metadata?.minutes_late)
    .map(e => ({
      staffName: e.metadata.staff_name || 'Unknown',
      minutesLate: e.metadata.minutes_late,
    }))

  const noShows = noShowEvents.map(e => ({ staffName: e.staff_name || e.metadata?.staff_name || 'Unknown' }))

  const hasCoverage = coverageReqs.some(r => r.status === 'covered')
  const hasOpenCoverage = coverageReqs.some(r => r.status === 'open')
  const fullyCovered = callouts.length === 0 || (hasCoverage && !hasOpenCoverage)

  return { shiftName, dayOfWeek, date: shiftDate, staffScheduled, callouts, coverageEvents, lateArrivals, noShows, fullyCovered }
}
```

- [ ] **Step 5: Implement autoLogShift**

Add to `src/managerLog/shiftLog.js`:

```javascript
export async function autoLogShift(bot, groupId, shiftId, shiftDate, shiftName, dayOfWeek, db = null) {
  const _getExisting = db?.getLogEntryForShiftDate ?? (async () => null)
  const _saveLog = db?.saveLogEntry ?? saveLogEntry

  // Prevent duplicate auto-logs
  const existing = await _getExisting(groupId, shiftName, shiftDate)
  if (existing) return existing

  const shiftData = await compileShiftData(groupId, shiftId, shiftDate, shiftName, dayOfWeek, db)
  const narrative = buildShiftNarrative(shiftData)

  const weekStart = getWeekStart(shiftDate)
  const saved = await _saveLog(groupId, null, narrative, { shiftName, dayOfWeek, weekStart })
  return saved
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr)
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}
```

- [ ] **Step 6: Modify formatLogEntry for auto indicator**

In `src/managerLog/shiftLog.js`, find the existing `formatLogEntry` function and modify it to append "(auto)" when `entry.manager_id` is null:

After the existing timestamp formatting line, add:
```javascript
// Inside formatLogEntry, after building the timestamp line:
const autoTag = entry.manager_id == null ? ' _(auto)_' : ''
// Append autoTag to the timestamp line
```

- [ ] **Step 7: Run tests — verify green**

```bash
node --check src/managerLog/shiftLog.js && node --test src/tests/unit/autoShiftLog.test.js
```
Expected: All tests PASS

- [ ] **Step 8: Verify existing shiftLog tests still pass**

```bash
node --test src/tests/unit/shiftLog.test.js
```
Expected: All PASS — no regressions

- [ ] **Step 9: Commit**

```bash
git add src/managerLog/shiftLog.js src/tests/unit/autoShiftLog.test.js
git commit -m "feat: auto-generated shift log from observed events

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Demand-Aware Scheduling

**Files:**
- Create: `src/intelligence/demandSignals.js`
- Test: `src/tests/unit/demandSignals.test.js`

**Context:** When a manager mentions "big event Saturday" or "slow week" in chat, we detect and store the signal. During schedule generation, we surface staffing recommendations based on historical averages.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/demandSignals.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

describe('extractDemandSignal', () => {
  let extractDemandSignal

  test('setup', async () => {
    const mod = await import('../../intelligence/demandSignals.js')
    extractDemandSignal = mod.extractDemandSignal
  })

  test('big event Saturday → high demand', () => {
    const result = extractDemandSignal('big event Saturday expect full house')
    assert.equal(result.type, 'high')
    assert.equal(result.dayOfWeek, 'Saturday')
    assert.equal(result.isWeekLevel, false)
  })

  test('slow Tuesday → low demand', () => {
    const result = extractDemandSignal("it's gonna be slow this Tuesday")
    assert.equal(result.type, 'low')
    assert.equal(result.dayOfWeek, 'Tuesday')
  })

  test('slow week → week-level low demand', () => {
    const result = extractDemandSignal('slow week probably')
    assert.equal(result.type, 'low')
    assert.equal(result.isWeekLevel, true)
    assert.equal(result.dayOfWeek, null)
  })

  test('game day Sunday → high demand', () => {
    const result = extractDemandSignal('game day Sunday')
    assert.equal(result.type, 'high')
    assert.equal(result.dayOfWeek, 'Sunday')
  })

  test('irrelevant message → null', () => {
    assert.equal(extractDemandSignal('can anyone cover my shift'), null)
  })

  test('pasta comment → null', () => {
    assert.equal(extractDemandSignal('the pasta was great'), null)
  })

  test('busy alone → week-level high', () => {
    const result = extractDemandSignal('busy')
    assert.equal(result.type, 'high')
    assert.equal(result.isWeekLevel, true)
  })

  test('case insensitive: SLOW WEEK', () => {
    const result = extractDemandSignal('SLOW WEEK')
    assert.equal(result.type, 'low')
  })

  test('false positive guard: busy work', () => {
    // "busy work" should NOT trigger — it's about personal tasks, not restaurant demand
    const result = extractDemandSignal("it's busy work I have to do tonight")
    assert.equal(result, null, 'busy work is not a demand signal')
  })

  test('false positive guard: dead tired', () => {
    assert.equal(extractDemandSignal("I'm dead tired"), null)
  })
})

describe('formatDemandRecommendations', () => {
  let formatDemandRecommendations

  test('setup', async () => {
    const mod = await import('../../intelligence/demandSignals.js')
    formatDemandRecommendations = mod.formatDemandRecommendations
  })

  test('high signal + understaffed → shows recommendation', () => {
    const recs = [{
      dayOfWeek: 'Saturday', signalType: 'high', currentStaffCount: 3,
      historicalAvg: 5, rawMention: 'big event Saturday',
      recommendation: 'Consider adding 2 more staff', severity: 'warning',
    }]
    const result = formatDemandRecommendations(recs)
    assert.ok(result, 'returns non-null')
    assert.ok(result.includes('big event'), 'contains raw mention')
    assert.ok(result.includes('3'), 'contains current count')
  })

  test('empty recommendations → null', () => {
    assert.equal(formatDemandRecommendations([]), null)
  })
})

describe('generateDemandRecommendations', () => {
  let generateDemandRecommendations

  test('setup', async () => {
    const mod = await import('../../intelligence/demandSignals.js')
    generateDemandRecommendations = mod.generateDemandRecommendations
  })

  test('high signal + understaffed → recommendation', async () => {
    const db = {
      getDemandSignals: async () => [{ day_of_week: 'Saturday', signal_type: 'high', raw_mention: 'big event Saturday' }],
      getHistoricalStaffCount: async () => ({ avgStaffCount: 5, weekCount: 4 }),
    }
    const assignments = [
      { dayOfWeek: 'Saturday', staffId: 1 },
      { dayOfWeek: 'Saturday', staffId: 2 },
      { dayOfWeek: 'Saturday', staffId: 3 },
    ]
    const result = await generateDemandRecommendations('g1', '2025-01-13', assignments, db)
    assert.ok(result.length > 0, 'returns recommendations')
    assert.equal(result[0].signalType, 'high')
    assert.equal(result[0].currentStaffCount, 3)
  })

  test('high signal + already well staffed → no recommendation', async () => {
    const db = {
      getDemandSignals: async () => [{ day_of_week: 'Saturday', signal_type: 'high', raw_mention: 'big event' }],
      getHistoricalStaffCount: async () => ({ avgStaffCount: 4, weekCount: 4 }),
    }
    const assignments = [
      { dayOfWeek: 'Saturday', staffId: 1 },
      { dayOfWeek: 'Saturday', staffId: 2 },
      { dayOfWeek: 'Saturday', staffId: 3 },
      { dayOfWeek: 'Saturday', staffId: 4 },
      { dayOfWeek: 'Saturday', staffId: 5 },
    ]
    const result = await generateDemandRecommendations('g1', '2025-01-13', assignments, db)
    assert.equal(result.length, 0)
  })

  test('no signals → empty array', async () => {
    const db = {
      getDemandSignals: async () => [],
      getHistoricalStaffCount: async () => ({ avgStaffCount: 3, weekCount: 4 }),
    }
    const result = await generateDemandRecommendations('g1', '2025-01-13', [], db)
    assert.equal(result.length, 0)
  })

  test('no historical data → still returns signal info', async () => {
    const db = {
      getDemandSignals: async () => [{ day_of_week: 'Friday', signal_type: 'high', raw_mention: 'packed Friday' }],
      getHistoricalStaffCount: async () => ({ avgStaffCount: 0, weekCount: 0 }),
    }
    const result = await generateDemandRecommendations('g1', '2025-01-13', [], db)
    assert.ok(result.length > 0, 'returns at least an FYI')
  })
})

describe('saveDemandSignal + getDemandSignals', () => {
  let saveDemandSignal, getDemandSignals

  test('setup', async () => {
    const mod = await import('../../intelligence/demandSignals.js')
    saveDemandSignal = mod.saveDemandSignal
    getDemandSignals = mod.getDemandSignals
  })

  test('saves and retrieves signal', async () => {
    const store = []
    const db = {
      upsertDemandSignal: async (signal) => { store.push(signal); return signal },
      getDemandSignals: async (groupId, weekStart) =>
        store.filter(s => s.group_id === groupId && s.week_start === weekStart),
    }
    await saveDemandSignal('g1', '2025-01-13', { type: 'high', dayOfWeek: 'Saturday', isWeekLevel: false, rawMention: 'big event' }, 'big event Saturday', 123, db)
    const signals = await getDemandSignals('g1', '2025-01-13', db)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].signal_type || signals[0].type, 'high')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
node --test src/tests/unit/demandSignals.test.js
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement demandSignals.js**

```javascript
// src/intelligence/demandSignals.js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

const HIGH_KEYWORDS = [
  'big event', 'full house', 'packed', 'large party', 'reservation',
  'expecting a crowd', 'game day', 'holiday', 'festival', 'graduation',
  'birthday party', 'special event', 'sold out', 'fully booked', 'rush',
]
const LOW_KEYWORDS = [
  'slow week', 'light week', 'probably slow', 'not much going on',
  'slow night', 'light covers', 'off season', 'quiet week',
]
// Single-word triggers need more careful handling
const HIGH_SINGLE = ['packed', 'rush']
const LOW_SINGLE = ['slow', 'quiet', 'dead']

const FALSE_POSITIVE_PATTERNS = [
  /busy\s*work/i, /dead\s*tired/i, /dead\s*serious/i, /dead\s*set/i,
  /dead\s*line/i, /deadline/i, /quiet\s*down/i, /rush\s*hour/i,
]

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export function extractDemandSignal(text) {
  if (!text || typeof text !== 'string') return null
  const lower = text.toLowerCase().trim()

  // Check false positives first
  for (const fp of FALSE_POSITIVE_PATTERNS) {
    if (fp.test(lower)) return null
  }

  let type = null
  let rawMention = null

  // Check multi-word keywords first (more specific)
  for (const kw of HIGH_KEYWORDS) {
    if (lower.includes(kw)) {
      type = 'high'
      rawMention = kw
      break
    }
  }
  if (!type) {
    for (const kw of LOW_KEYWORDS) {
      if (lower.includes(kw)) {
        type = 'low'
        rawMention = kw
        break
      }
    }
  }

  // Single word fallback — only if message is short or word appears with day context
  if (!type) {
    const words = lower.split(/\s+/)
    for (const sw of HIGH_SINGLE) {
      if (words.includes(sw)) { type = 'high'; rawMention = sw; break }
    }
  }
  if (!type) {
    for (const sw of LOW_SINGLE) {
      if (words_includes(lower, sw)) { type = 'low'; rawMention = sw; break }
    }
  }

  if (!type) return null

  // Extract day reference
  let dayOfWeek = null
  let isWeekLevel = false

  for (const day of DAYS) {
    if (lower.includes(day)) {
      dayOfWeek = day.charAt(0).toUpperCase() + day.slice(1)
      break
    }
  }

  if (!dayOfWeek && (lower.includes('week') || lower.includes('busy') && !DAYS.some(d => lower.includes(d)))) {
    isWeekLevel = true
  }

  if (!dayOfWeek && !isWeekLevel) {
    // No day mentioned, no "week" keyword — treat as week-level
    isWeekLevel = true
  }

  return { type, dayOfWeek, isWeekLevel, rawMention }
}

function words_includes(text, word) {
  return text.split(/\s+/).includes(word)
}

export async function saveDemandSignal(groupId, weekStart, signal, sourceMessage, sourceUserId, db = null) {
  const _upsert = db?.upsertDemandSignal
  if (_upsert) {
    return _upsert({
      group_id: groupId, week_start: weekStart, day_of_week: signal.dayOfWeek,
      is_week_level: signal.isWeekLevel, signal_type: signal.type,
      raw_mention: signal.rawMention, source_user_id: sourceUserId,
    })
  }
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('demand_signals')
      .upsert({
        group_id: groupId, week_start: weekStart, day_of_week: signal.dayOfWeek,
        is_week_level: signal.isWeekLevel, signal_type: signal.type,
        raw_mention: signal.rawMention, source_user_id: sourceUserId,
      }, { onConflict: 'group_id,week_start,day_of_week' })
      .select().single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveDemandSignal failed: ${err.message}`)
    return null
  }
}

export async function getDemandSignals(groupId, weekStart, db = null) {
  if (db?.getDemandSignals) return db.getDemandSignals(groupId, weekStart)
  if (!supabase) return []
  try {
    const { data, error } = await supabase
      .from('demand_signals')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getDemandSignals failed: ${err.message}`)
    return []
  }
}

export async function generateDemandRecommendations(groupId, weekStart, assignments, db = null) {
  const signals = await getDemandSignals(groupId, weekStart, db)
  if (signals.length === 0) return []

  const _getHistorical = db?.getHistoricalStaffCount ?? (async () => ({ avgStaffCount: 0, weekCount: 0 }))

  const recommendations = []

  for (const signal of signals) {
    const dayOfWeek = signal.day_of_week
    if (!dayOfWeek) continue // skip week-level for now (no specific day to compare)

    const currentCount = assignments.filter(a => a.dayOfWeek === dayOfWeek).length
    const historical = await _getHistorical(groupId, dayOfWeek)

    if (historical.weekCount === 0) {
      // No historical data — just surface the signal as FYI
      recommendations.push({
        dayOfWeek, signalType: signal.signal_type, currentStaffCount: currentCount,
        historicalAvg: 0, rawMention: signal.raw_mention,
        recommendation: `You mentioned "${signal.raw_mention}" — monitor staffing for ${dayOfWeek}.`,
        severity: 'suggestion',
      })
      continue
    }

    const avg = historical.avgStaffCount

    if (signal.signal_type === 'high' && currentCount < avg * 1.2) {
      const diff = Math.ceil(avg * 1.2) - currentCount
      recommendations.push({
        dayOfWeek, signalType: 'high', currentStaffCount: currentCount,
        historicalAvg: Math.round(avg * 10) / 10, rawMention: signal.raw_mention,
        recommendation: `You mentioned "${signal.raw_mention}" — you've scheduled ${currentCount} staff. Your typical ${dayOfWeek} has ${Math.round(avg)}. Consider adding ${diff} more.`,
        severity: 'warning',
      })
    } else if (signal.signal_type === 'low' && currentCount > avg * 0.8) {
      const diff = currentCount - Math.floor(avg * 0.8)
      recommendations.push({
        dayOfWeek, signalType: 'low', currentStaffCount: currentCount,
        historicalAvg: Math.round(avg * 10) / 10, rawMention: signal.raw_mention,
        recommendation: `You mentioned "${signal.raw_mention}" — you've scheduled ${currentCount} staff. Reducing by ${diff} would be within your normal range.`,
        severity: 'suggestion',
      })
    }
  }

  return recommendations
}

export function formatDemandRecommendations(recommendations) {
  if (!recommendations || recommendations.length === 0) return null

  const lines = ['📣 *Based on what you mentioned this week:*', '']
  for (const rec of recommendations) {
    const icon = rec.severity === 'warning' ? '⚠️' : '💡'
    lines.push(`${icon} ${rec.recommendation}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run test — verify green**

```bash
node --check src/intelligence/demandSignals.js && node --test src/tests/unit/demandSignals.test.js
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/demandSignals.js src/tests/unit/demandSignals.test.js
git commit -m "feat: demand-aware scheduling from conversation mentions

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Coverage Speed Optimization

**Files:**
- Create: `src/intelligence/coverageSpeed.js`
- Test: `src/tests/unit/coverageSpeed.test.js`

**Context:** Uses `coverage_requests` table (columns: `created_at`, `covered_at`, `covered_by` TEXT, `status`). No `confirmed_at` or `covered_by_id` columns exist — use `covered_at` for timing. The coverage DM loop is at `requestHandler.js:95-114`.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/coverageSpeed.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'

describe('calculateCoverageScore', () => {
  let calculateCoverageScore

  test('setup', async () => {
    const mod = await import('../../intelligence/coverageSpeed.js')
    calculateCoverageScore = mod.calculateCoverageScore
  })

  test('fast + reliable → high score', () => {
    const score = calculateCoverageScore(5, 1.0, 5)
    assert.ok(score > 0.8, `expected > 0.8, got ${score}`)
  })

  test('slow + reliable → lower score', () => {
    const score = calculateCoverageScore(45, 1.0, 5)
    assert.ok(score < 0.5, `expected < 0.5, got ${score}`)
  })

  test('fast + unreliable → medium score', () => {
    const score = calculateCoverageScore(5, 0.5, 5)
    assert.ok(score < 0.6, `expected < 0.6, got ${score}`)
  })

  test('returns 0-1 range', () => {
    const s1 = calculateCoverageScore(0, 1.0, 10)
    const s2 = calculateCoverageScore(120, 0.0, 1)
    assert.ok(s1 >= 0 && s1 <= 1, 'within range')
    assert.ok(s2 >= 0 && s2 <= 1, 'within range')
  })
})

describe('getCoverageResponseStats', () => {
  let getCoverageResponseStats

  test('setup', async () => {
    const mod = await import('../../intelligence/coverageSpeed.js')
    getCoverageResponseStats = mod.getCoverageResponseStats
  })

  test('returns sorted stats from coverage history', async () => {
    const db = {
      getCoveredRequests: async () => [
        // Marcus: 3 coverages, fast
        { covered_by: 'Marcus', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:07:00Z' },
        { covered_by: 'Marcus', created_at: '2025-01-08T16:00:00Z', covered_at: '2025-01-08T16:05:00Z' },
        { covered_by: 'Marcus', created_at: '2025-01-15T16:00:00Z', covered_at: '2025-01-15T16:08:00Z' },
        // Sarah: 2 coverages, slower
        { covered_by: 'Sarah', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:25:00Z' },
        { covered_by: 'Sarah', created_at: '2025-01-08T16:00:00Z', covered_at: '2025-01-08T16:20:00Z' },
        // Jake: 1 coverage only — excluded (min 2)
        { covered_by: 'Jake', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:30:00Z' },
      ],
      getNoShowAfterConfirm: async () => [],
    }
    const stats = await getCoverageResponseStats('g1', db)
    assert.ok(stats.length >= 2, 'at least Marcus and Sarah')
    assert.ok(!stats.find(s => s.staffName === 'Jake'), 'Jake excluded — only 1 confirmation')
    assert.equal(stats[0].staffName, 'Marcus', 'Marcus ranked first (faster)')
  })

  test('empty history → empty array', async () => {
    const db = {
      getCoveredRequests: async () => [],
      getNoShowAfterConfirm: async () => [],
    }
    const stats = await getCoverageResponseStats('g1', db)
    assert.equal(stats.length, 0)
  })
})

describe('getTopResponders', () => {
  let getTopResponders

  test('setup', async () => {
    const mod = await import('../../intelligence/coverageSpeed.js')
    getTopResponders = mod.getTopResponders
  })

  test('returns top N', async () => {
    const db = {
      getCoveredRequests: async () => [
        { covered_by: 'A', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:05:00Z' },
        { covered_by: 'A', created_at: '2025-01-02T16:00:00Z', covered_at: '2025-01-02T16:05:00Z' },
        { covered_by: 'B', created_at: '2025-01-01T16:00:00Z', covered_at: '2025-01-01T16:10:00Z' },
        { covered_by: 'B', created_at: '2025-01-02T16:00:00Z', covered_at: '2025-01-02T16:10:00Z' },
      ],
      getNoShowAfterConfirm: async () => [],
    }
    const top = await getTopResponders('g1', 3, db)
    assert.ok(top.length <= 3)
    assert.ok(top.length === 2, 'only 2 have data')
  })
})

describe('formatCoverageSpeedNotice', () => {
  let formatCoverageSpeedNotice

  test('setup', async () => {
    const mod = await import('../../intelligence/coverageSpeed.js')
    formatCoverageSpeedNotice = mod.formatCoverageSpeedNotice
  })

  test('formats notice with responder names', () => {
    const top = [
      { staffName: 'Marcus', avgResponseMinutes: 7 },
      { staffName: 'Sarah', avgResponseMinutes: 22 },
    ]
    const result = formatCoverageSpeedNotice(top, 14)
    assert.ok(result.includes('Marcus'), 'contains Marcus')
    assert.ok(result.includes('Sarah'), 'contains Sarah')
    assert.ok(result.includes('14'), 'contains avg fill time')
  })

  test('null when fewer than 2 responders', () => {
    assert.equal(formatCoverageSpeedNotice([{ staffName: 'A', avgResponseMinutes: 5 }], 5), null)
    assert.equal(formatCoverageSpeedNotice([], 0), null)
  })
})
```

- [ ] **Step 2: Run test — verify fails**

```bash
node --test src/tests/unit/coverageSpeed.test.js
```

- [ ] **Step 3: Implement coverageSpeed.js**

```javascript
// src/intelligence/coverageSpeed.js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

export function calculateCoverageScore(avgResponseMinutes, actualReliability, confirmationCount) {
  const speedScore = Math.max(0, 1 - (avgResponseMinutes / 60))
  let score = (actualReliability * 0.6) + (speedScore * 0.4)
  if (confirmationCount >= 5) score = Math.min(1, score + 0.05)
  return Math.max(0, Math.min(1, score))
}

export async function getCoverageResponseStats(groupId, db = null) {
  const _getCovered = db?.getCoveredRequests ?? (async () => {
    if (!supabase) return []
    const { data, error } = await supabase
      .from('coverage_requests')
      .select('covered_by, created_at, covered_at')
      .eq('group_id', groupId)
      .eq('status', 'covered')
      .not('covered_at', 'is', null)
    if (error) { logger.error(`getCoveredRequests: ${error.message}`); return [] }
    return data ?? []
  })

  const _getNoShows = db?.getNoShowAfterConfirm ?? (async () => [])

  const covered = await _getCovered(groupId)
  const noShows = await _getNoShows(groupId)

  // Group by covered_by name
  const byStaff = new Map()
  for (const req of covered) {
    if (!req.covered_by || !req.covered_at) continue
    const name = req.covered_by
    if (!byStaff.has(name)) byStaff.set(name, [])
    byStaff.get(name).push(req)
  }

  const stats = []
  for (const [staffName, requests] of byStaff) {
    if (requests.length < 2) continue // minimum 2 confirmations

    const responseTimes = requests.map(r => {
      return (new Date(r.covered_at).getTime() - new Date(r.created_at).getTime()) / 60000
    })

    const avgResponseMinutes = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    const noShowCount = noShows.filter(n => n.covered_by === staffName).length
    const actualReliability = (requests.length - noShowCount) / requests.length

    const score = calculateCoverageScore(avgResponseMinutes, actualReliability, requests.length)

    stats.push({
      staffName,
      avgResponseMinutes: Math.round(avgResponseMinutes * 10) / 10,
      confirmationCount: requests.length,
      noShowAfterConfirmCount: noShowCount,
      actualReliability,
      score,
    })
  }

  stats.sort((a, b) => b.score - a.score)
  return stats
}

export async function getTopResponders(groupId, count = 3, db = null) {
  const stats = await getCoverageResponseStats(groupId, db)
  return stats.slice(0, count)
}

export function formatCoverageSpeedNotice(topResponders, avgFillTime) {
  if (!topResponders || topResponders.length < 2) return null

  const names = topResponders.map(r => `${r.staffName} (avg ${Math.round(r.avgResponseMinutes)}min)`).join(', ')
  return (
    `📬 *Notified your ${topResponders.length} fastest responders first:*\n` +
    `${names}\n\n` +
    `Team avg fill time: ${Math.round(avgFillTime)}min`
  )
}
```

- [ ] **Step 4: Run test — verify green**

```bash
node --check src/intelligence/coverageSpeed.js && node --test src/tests/unit/coverageSpeed.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/coverageSpeed.js src/tests/unit/coverageSpeed.test.js
git commit -m "feat: coverage speed optimization with responder ranking

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Contextual Warnings During Review

**Files:**
- Create: `src/intelligence/contextualWarnings.js`
- Test: `src/tests/unit/contextualWarnings.test.js`

**Context:** When the draft schedule is sent to the manager, surface history: consecutive day streaks, callout patterns on specific days, and incident pairs. Uses `coverage_requests`, `manager_log_entries`, and `schedule_assignments` tables.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/contextualWarnings.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

describe('getConsecutiveDayStreak', () => {
  let getConsecutiveDayStreak

  test('setup', async () => {
    const mod = await import('../../intelligence/contextualWarnings.js')
    getConsecutiveDayStreak = mod.getConsecutiveDayStreak
  })

  test('6 consecutive days → streak:6, warning:false', () => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const result = getConsecutiveDayStreak(days)
    assert.equal(result.streak, 6)
    assert.equal(result.warning, false)
  })

  test('7 consecutive days → streak:7, warning:true', () => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const result = getConsecutiveDayStreak(days)
    assert.equal(result.streak, 7)
    assert.equal(result.warning, true)
  })

  test('1 day → streak:1, no flag', () => {
    const result = getConsecutiveDayStreak(['Wednesday'])
    assert.equal(result.streak, 1)
    assert.equal(result.warning, false)
  })

  test('non-consecutive → longest streak', () => {
    const result = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday'])
    assert.equal(result.streak, 3) // Thu-Fri-Sat
  })
})

describe('detectCalloutPatterns', () => {
  let detectCalloutPatterns

  test('setup', async () => {
    const mod = await import('../../intelligence/contextualWarnings.js')
    detectCalloutPatterns = mod.detectCalloutPatterns
  })

  test('3 callouts in 5 Fridays → flagged', async () => {
    const db = {
      getCalloutHistory: async (groupId, staffName) => [
        { day_of_week: 'Friday', shift_name: 'Dinner', count: 3, total_scheduled: 5 },
      ],
    }
    const assignments = [{ staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Dinner' }]
    const result = await detectCalloutPatterns('g1', assignments, db)
    assert.ok(result.length > 0)
    assert.equal(result[0].staffName, 'Marcus')
    assert.equal(result[0].calloutCount, 3)
  })

  test('1 callout in 5 days → not flagged', async () => {
    const db = {
      getCalloutHistory: async () => [
        { day_of_week: 'Monday', shift_name: 'Lunch', count: 1, total_scheduled: 5 },
      ],
    }
    const assignments = [{ staffName: 'Carlos', dayOfWeek: 'Monday', shiftName: 'Lunch' }]
    const result = await detectCalloutPatterns('g1', assignments, db)
    assert.equal(result.length, 0, '1 callout not flagged')
  })

  test('empty history → empty array', async () => {
    const db = { getCalloutHistory: async () => [] }
    const result = await detectCalloutPatterns('g1', [], db)
    assert.equal(result.length, 0)
  })
})

describe('generateContextualWarnings', () => {
  let generateContextualWarnings

  test('setup', async () => {
    const mod = await import('../../intelligence/contextualWarnings.js')
    generateContextualWarnings = mod.generateContextualWarnings
  })

  test('returns warnings and notes correctly', async () => {
    const db = {
      getCalloutHistory: async () => [
        { day_of_week: 'Friday', shift_name: 'Dinner', count: 3, total_scheduled: 5 },
      ],
      getLogIncidents: async () => [],
    }
    const assignments = [
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Monday' },
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Tuesday' },
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Wednesday' },
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Thursday' },
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Friday' },
      { staffId: 1, staffName: 'Carlos', dayOfWeek: 'Saturday' },
      { staffId: 2, staffName: 'Marcus', dayOfWeek: 'Friday', shiftName: 'Dinner' },
    ]
    const { warnings, notes } = await generateContextualWarnings('g1', assignments, db)
    // Carlos 6 consecutive → note (not warning, since < 7)
    const carlosNote = notes.find(n => n.staffName === 'Carlos')
    assert.ok(carlosNote, 'Carlos 6-day streak noted')
    // Marcus callout pattern → note
    const marcusNote = notes.find(n => n.staffName === 'Marcus')
    assert.ok(marcusNote, 'Marcus callout pattern noted')
  })

  test('empty assignments → no warnings', async () => {
    const db = { getCalloutHistory: async () => [], getLogIncidents: async () => [] }
    const { warnings, notes } = await generateContextualWarnings('g1', [], db)
    assert.equal(warnings.length, 0)
    assert.equal(notes.length, 0)
  })
})

describe('formatContextualWarnings', () => {
  let formatContextualWarnings

  test('setup', async () => {
    const mod = await import('../../intelligence/contextualWarnings.js')
    formatContextualWarnings = mod.formatContextualWarnings
  })

  test('contains staff names and counts', () => {
    const warnings = [{ staffName: 'Carlos', message: 'Carlos — 7 consecutive days scheduled.' }]
    const notes = [{ staffName: 'Marcus', message: 'Marcus has called out 3 of the last 5 Friday dinner shifts.' }]
    const result = formatContextualWarnings(warnings, notes)
    assert.ok(result, 'non-null')
    assert.ok(result.includes('Carlos'), 'contains warning name')
    assert.ok(result.includes('Marcus'), 'contains note name')
  })

  test('null when both empty', () => {
    assert.equal(formatContextualWarnings([], []), null)
  })
})
```

- [ ] **Step 2: Run test — verify fails**

```bash
node --test src/tests/unit/contextualWarnings.test.js
```

- [ ] **Step 3: Implement contextualWarnings.js**

```javascript
// src/intelligence/contextualWarnings.js
import { logger } from '../logger.js'

const DAYS_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function getConsecutiveDayStreak(scheduledDays) {
  if (!scheduledDays || scheduledDays.length === 0) return { streak: 0, days: [], warning: false }

  const indices = scheduledDays.map(d => DAYS_ORDER.indexOf(d)).filter(i => i >= 0).sort((a, b) => a - b)
  const unique = [...new Set(indices)]

  let maxStreak = 1
  let currentStreak = 1
  let bestStart = 0
  let currentStart = 0

  for (let i = 1; i < unique.length; i++) {
    if (unique[i] === unique[i - 1] + 1) {
      currentStreak++
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak
        bestStart = currentStart
      }
    } else {
      currentStreak = 1
      currentStart = i
    }
  }

  const streakDays = unique.slice(bestStart, bestStart + maxStreak).map(i => DAYS_ORDER[i])
  return { streak: maxStreak, days: streakDays, warning: maxStreak >= 7 }
}

export async function detectCalloutPatterns(groupId, assignments, db = null) {
  if (!assignments || assignments.length === 0) return []
  const _getHistory = db?.getCalloutHistory ?? (async () => [])

  const results = []
  const checked = new Set()

  for (const a of assignments) {
    const key = `${a.staffName}:${a.dayOfWeek}:${a.shiftName || ''}`
    if (checked.has(key)) continue
    checked.add(key)

    const history = await _getHistory(groupId, a.staffName)
    for (const h of history) {
      if (h.day_of_week === a.dayOfWeek && h.count >= 2) {
        results.push({
          staffName: a.staffName,
          shiftName: h.shift_name || a.shiftName,
          dayOfWeek: h.day_of_week,
          calloutCount: h.count,
          totalScheduled: h.total_scheduled,
          warning: h.count / (h.total_scheduled || 1) >= 0.5,
        })
      }
    }
  }

  return results
}

export async function generateContextualWarnings(groupId, assignments, db = null) {
  if (!assignments || assignments.length === 0) return { warnings: [], notes: [] }

  const warnings = []
  const notes = []

  // 1. Consecutive day streaks per staff
  const staffDays = new Map()
  for (const a of assignments) {
    if (!staffDays.has(a.staffName)) staffDays.set(a.staffName, [])
    staffDays.get(a.staffName).push(a.dayOfWeek)
  }

  for (const [staffName, days] of staffDays) {
    const uniqueDays = [...new Set(days)]
    const { streak, warning } = getConsecutiveDayStreak(uniqueDays)
    if (warning) {
      warnings.push({ staffName, message: `${staffName} — ${streak} consecutive days scheduled.` })
    } else if (streak >= 6) {
      notes.push({ staffName, message: `${staffName} — ${streak} consecutive days scheduled.` })
    }
  }

  // 2. Callout patterns
  const callouts = await detectCalloutPatterns(groupId, assignments, db)
  for (const c of callouts) {
    const msg = `${c.staffName} has called out ${c.calloutCount} of the last ${c.totalScheduled} ${c.dayOfWeek} ${c.shiftName || ''} shifts.`.trim()
    if (c.warning) {
      warnings.push({ staffName: c.staffName, message: msg })
    } else {
      notes.push({ staffName: c.staffName, message: msg })
    }
  }

  return { warnings, notes }
}

export function formatContextualWarnings(warnings, notes) {
  if ((!warnings || warnings.length === 0) && (!notes || notes.length === 0)) return null

  const lines = ['📋 *A few things from recent history:*', '']

  for (const w of warnings) {
    lines.push(`⚠️ ${w.message}`)
  }
  for (const n of notes) {
    lines.push(`💭 ${n.message}`)
  }

  if (warnings.length > 0) {
    lines.push('')
    lines.push('_Review before approving._')
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test — verify green**

```bash
node --check src/intelligence/contextualWarnings.js && node --test src/tests/unit/contextualWarnings.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/contextualWarnings.js src/tests/unit/contextualWarnings.test.js
git commit -m "feat: contextual warnings during schedule review

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Weekly AI Narrative Briefing

**Files:**
- Create: `src/intelligence/narrativeBriefing.js`
- Test: `src/tests/unit/narrativeBriefing.test.js`

**Context:** Every Sunday at 7pm, send the manager a paragraph written from structured data using Cerebras/groqWithRetry. Uses `groq` and `groqWithRetry` from `src/parsers/groq.js`. Model: `llama-3.3-70b`.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/narrativeBriefing.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const mockStats = {
  weekStart: '2025-01-06',
  totalShifts: 18,
  shiftsWithIssues: 3,
  coverageRequests: { total: 3, avgFillMinutes: 9, fastestFillMinutes: 4, fullyFilled: 3, partial: 0 },
  lateArrivals: { count: 2, totalMinutes: 29, worstOffender: 'Sarah' },
  noShows: { count: 0, names: [] },
  topReliableStaff: [{ name: 'Marcus', score: 92 }],
  unconfirmedSchedules: ['Jake', 'Amy'],
  understaffedShifts: [{ shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', scheduledCount: 2, requiredCount: 3 }],
  overtimeStaff: [],
  payrollTotal: 2840,
  laborPercent: null,
  moraleAlerts: [],
}

describe('compileWeeklyStats', () => {
  let compileWeeklyStats

  test('setup', async () => {
    const mod = await import('../../intelligence/narrativeBriefing.js')
    compileWeeklyStats = mod.compileWeeklyStats
  })

  test('returns correct coverage count', async () => {
    const db = {
      getCoverageStatsForWeek: async () => ({ total: 3, avgFillMinutes: 9, fastestFillMinutes: 4, fullyFilled: 3, partial: 0 }),
      getLateArrivalsForWeek: async () => ({ count: 2, totalMinutes: 29, worstOffender: 'Sarah' }),
      getNoShowsForWeek: async () => ({ count: 0, names: [] }),
      getTopReliableStaff: async () => [{ name: 'Marcus', score: 92 }],
      getUnconfirmedSchedules: async () => ['Jake', 'Amy'],
      getUnderstaffedShifts: async () => [{ shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', scheduledCount: 2, requiredCount: 3 }],
      getOvertimeStaff: async () => [],
      getPayrollTotal: async () => 2840,
      getLaborPercent: async () => null,
      getMoraleAlertsForWeek: async () => [],
      getTotalShifts: async () => ({ total: 18, withIssues: 3 }),
    }
    const stats = await compileWeeklyStats('g1', '2025-01-06', db)
    assert.equal(stats.coverageRequests.total, 3)
    assert.equal(stats.lateArrivals.count, 2)
    assert.deepEqual(stats.unconfirmedSchedules, ['Jake', 'Amy'])
    assert.equal(stats.totalShifts, 18)
  })

  test('empty week → zeroed stats', async () => {
    const db = {
      getCoverageStatsForWeek: async () => ({ total: 0, avgFillMinutes: 0, fastestFillMinutes: 0, fullyFilled: 0, partial: 0 }),
      getLateArrivalsForWeek: async () => ({ count: 0, totalMinutes: 0, worstOffender: null }),
      getNoShowsForWeek: async () => ({ count: 0, names: [] }),
      getTopReliableStaff: async () => [],
      getUnconfirmedSchedules: async () => [],
      getUnderstaffedShifts: async () => [],
      getOvertimeStaff: async () => [],
      getPayrollTotal: async () => 0,
      getLaborPercent: async () => null,
      getMoraleAlertsForWeek: async () => [],
      getTotalShifts: async () => ({ total: 0, withIssues: 0 }),
    }
    const stats = await compileWeeklyStats('g1', '2025-01-06', db)
    assert.equal(stats.coverageRequests.total, 0)
    assert.equal(stats.totalShifts, 0)
  })
})

describe('formatSundayBriefing', () => {
  let formatSundayBriefing

  test('setup', async () => {
    const mod = await import('../../intelligence/narrativeBriefing.js')
    formatSundayBriefing = mod.formatSundayBriefing
  })

  test('contains narrative and unconfirmed names', () => {
    const narrative = 'Solid week overall. Coverage filled quickly.'
    const result = formatSundayBriefing(narrative, mockStats)
    assert.ok(result.includes(narrative), 'contains narrative')
    assert.ok(result.includes('Jake'), 'contains unconfirmed name')
    assert.ok(result.includes('Amy'), 'contains unconfirmed name')
    assert.ok(result.includes('Have a good week'), 'contains sign-off')
  })

  test('no unconfirmed → no unconfirmed section', () => {
    const stats = { ...mockStats, unconfirmedSchedules: [] }
    const result = formatSundayBriefing('Good week.', stats)
    assert.ok(!result.includes('unconfirmed'), 'no unconfirmed section')
  })

  test('morale alerts shown', () => {
    const stats = { ...mockStats, moraleAlerts: [{ staffName: 'Jake', reasons: ['declining engagement'] }] }
    const result = formatSundayBriefing('Good week.', stats)
    assert.ok(result.includes('Jake'), 'morale alert shown')
    assert.ok(result.includes('check-in'), 'check-in suggestion')
  })
})

describe('generateNarrativeBriefing (LLM)', () => {
  let generateNarrativeBriefing

  test('setup', async () => {
    const mod = await import('../../intelligence/narrativeBriefing.js')
    generateNarrativeBriefing = mod.generateNarrativeBriefing
  })

  test('returns narrative string from stats', async () => {
    const db = {
      getCoverageStatsForWeek: async () => mockStats.coverageRequests,
      getLateArrivalsForWeek: async () => mockStats.lateArrivals,
      getNoShowsForWeek: async () => mockStats.noShows,
      getTopReliableStaff: async () => mockStats.topReliableStaff,
      getUnconfirmedSchedules: async () => mockStats.unconfirmedSchedules,
      getUnderstaffedShifts: async () => mockStats.understaffedShifts,
      getOvertimeStaff: async () => [],
      getPayrollTotal: async () => 2840,
      getLaborPercent: async () => null,
      getMoraleAlertsForWeek: async () => [],
      getTotalShifts: async () => ({ total: 18, withIssues: 3 }),
    }
    const result = await generateNarrativeBriefing('g1', '2025-01-06', db)
    assert.ok(result, 'returns non-null')
    assert.ok(result.narrative, 'has narrative field')
    assert.ok(typeof result.narrative === 'string', 'narrative is string')
    assert.ok(result.narrative.length > 20, 'narrative has content')
    assert.ok(result.narrative.length < 1000, 'narrative is concise')
  })
}, { timeout: 30000 })
```

- [ ] **Step 2: Run test — verify fails**

```bash
node --test src/tests/unit/narrativeBriefing.test.js
```

- [ ] **Step 3: Implement narrativeBriefing.js**

```javascript
// src/intelligence/narrativeBriefing.js
import { groq, groqWithRetry } from '../parsers/groq.js'
import { logger } from '../logger.js'

export async function compileWeeklyStats(groupId, weekStart, db = null) {
  const [coverage, lateArrivals, noShows, topStaff, unconfirmed, understaffed, overtime, payroll, laborPct, morale, shiftCounts] = await Promise.all([
    (db?.getCoverageStatsForWeek ?? (async () => ({ total: 0, avgFillMinutes: 0, fastestFillMinutes: 0, fullyFilled: 0, partial: 0 })))(groupId, weekStart),
    (db?.getLateArrivalsForWeek ?? (async () => ({ count: 0, totalMinutes: 0, worstOffender: null })))(groupId, weekStart),
    (db?.getNoShowsForWeek ?? (async () => ({ count: 0, names: [] })))(groupId, weekStart),
    (db?.getTopReliableStaff ?? (async () => []))(groupId),
    (db?.getUnconfirmedSchedules ?? (async () => []))(groupId),
    (db?.getUnderstaffedShifts ?? (async () => []))(groupId, weekStart),
    (db?.getOvertimeStaff ?? (async () => []))(groupId, weekStart),
    (db?.getPayrollTotal ?? (async () => 0))(groupId, weekStart),
    (db?.getLaborPercent ?? (async () => null))(groupId, weekStart),
    (db?.getMoraleAlertsForWeek ?? (async () => []))(groupId),
    (db?.getTotalShifts ?? (async () => ({ total: 0, withIssues: 0 })))(groupId, weekStart),
  ])

  return {
    weekStart,
    totalShifts: shiftCounts.total,
    shiftsWithIssues: shiftCounts.withIssues,
    coverageRequests: coverage,
    lateArrivals,
    noShows,
    topReliableStaff: topStaff,
    unconfirmedSchedules: unconfirmed,
    understaffedShifts: understaffed,
    overtimeStaff: overtime,
    payrollTotal: payroll,
    laborPercent: laborPct,
    moraleAlerts: morale,
  }
}

export async function generateNarrativeBriefing(groupId, weekStart, db = null) {
  const stats = await compileWeeklyStats(groupId, weekStart, db)

  if (stats.totalShifts === 0 && stats.coverageRequests.total === 0) {
    return null
  }

  try {
    const completion = await groqWithRetry(() => groq.chat.completions.create({
      model: 'llama-3.3-70b',
      temperature: 0.3,
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content: `You write weekly briefings for restaurant managers. Write 3-5 sentences, past tense, direct. Positive things first. Problems second. Forward-looking note at end if relevant. Never invent facts — only use provided data. No bullet points. No headers. Conversational. Under 150 words.`,
        },
        {
          role: 'user',
          content: `Write a weekly briefing for a restaurant manager. Data: ${JSON.stringify(stats)}`,
        },
      ],
    }))

    const narrative = completion.choices[0]?.message?.content?.trim() ?? ''
    return { narrative, stats }
  } catch (err) {
    logger.error(`generateNarrativeBriefing LLM failed: ${err.message}`)
    return { narrative: buildFallbackNarrative(stats), stats }
  }
}

function buildFallbackNarrative(stats) {
  const parts = []
  if (stats.coverageRequests.total > 0) {
    parts.push(`${stats.coverageRequests.total} coverage requests this week (avg ${stats.coverageRequests.avgFillMinutes}min to fill).`)
  }
  if (stats.lateArrivals.count > 0) {
    parts.push(`${stats.lateArrivals.count} late arrivals.`)
  }
  if (stats.noShows.count > 0) {
    parts.push(`${stats.noShows.count} no-shows.`)
  }
  if (parts.length === 0) parts.push('Quiet week — no major incidents.')
  return parts.join(' ')
}

export function formatSundayBriefing(narrative, stats) {
  const lines = [`📋 *Week of ${stats.weekStart} — Summary*`, '', narrative]

  if (stats.unconfirmedSchedules && stats.unconfirmedSchedules.length > 0) {
    lines.push('')
    lines.push(`⚠️ Still unconfirmed: ${stats.unconfirmedSchedules.join(', ')}`)
  }

  if (stats.moraleAlerts && stats.moraleAlerts.length > 0) {
    lines.push('')
    for (const alert of stats.moraleAlerts) {
      const reasons = alert.reasons?.join(', ') || 'declining engagement'
      lines.push(`👀 ${alert.staffName} may need a check-in — ${reasons}.`)
    }
  }

  lines.push('')
  lines.push('Have a good week.')

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test — verify green**

```bash
node --check src/intelligence/narrativeBriefing.js && node --test src/tests/unit/narrativeBriefing.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/narrativeBriefing.js src/tests/unit/narrativeBriefing.test.js
git commit -m "feat: weekly AI narrative Sunday briefing

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Emergency Availability Query

**Files:**
- Create: `src/intelligence/emergencyAvailability.js`
- Test: `src/tests/unit/emergencyAvailability.test.js`

**Context:** Manager DMs "who can work right now" — Relay checks who's off, ranks by speed/reliability/hours, and DMs top 3.

- [ ] **Step 1: Write the test file**

```javascript
// src/tests/unit/emergencyAvailability.test.js
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'

describe('rankAvailableStaff', () => {
  let rankAvailableStaff

  test('setup', async () => {
    const mod = await import('../../intelligence/emergencyAvailability.js')
    rankAvailableStaff = mod.rankAvailableStaff
  })

  test('Sarah ranked above Jake (faster, more reliable)', () => {
    const staff = [
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursThisWeek: 28 },
      { staffId: 3, staffName: 'Jake', roleName: 'Server', hoursThisWeek: 35 },
    ]
    const coverageStats = [
      { staffName: 'Sarah', avgResponseMinutes: 8, actualReliability: 0.95, confirmationCount: 10, score: 0.9 },
      { staffName: 'Jake', avgResponseMinutes: 25, actualReliability: 0.80, confirmationCount: 4, score: 0.5 },
    ]
    const ranked = rankAvailableStaff(staff, coverageStats)
    assert.equal(ranked[0].staffName, 'Sarah')
    assert.equal(ranked[1].staffName, 'Jake')
  })

  test('no coverage stats → ranked by hours available', () => {
    const staff = [
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursThisWeek: 38 },
      { staffId: 3, staffName: 'Jake', roleName: 'Server', hoursThisWeek: 20 },
    ]
    const ranked = rankAvailableStaff(staff, [])
    // Jake has more hours available
    assert.equal(ranked[0].staffName, 'Jake')
  })

  test('empty staff → empty array', () => {
    assert.deepEqual(rankAvailableStaff([], []), [])
  })
})

describe('getAvailableNow', () => {
  let getAvailableNow

  test('setup', async () => {
    const mod = await import('../../intelligence/emergencyAvailability.js')
    getAvailableNow = mod.getAvailableNow
  })

  test('excludes staff on shift and over hours', async () => {
    const db = {
      getAllStaffForGroup: async () => [
        { id: 1, name: 'Marcus', role_name: 'Chef' },
        { id: 2, name: 'Sarah', role_name: 'Server' },
        { id: 3, name: 'Jake', role_name: 'Server' },
        { id: 4, name: 'Amy', role_name: 'Server' },
      ],
      getActiveStaffIds: async () => [1],  // Marcus on shift
      getWeeklyHours: async () => ({ 1: 38, 2: 28, 3: 35, 4: 40 }),
      getCoveredRequests: async () => [],
      getNoShowAfterConfirm: async () => [],
    }
    const result = await getAvailableNow('g1', 10, new Date(), db)
    const names = result.map(r => r.staffName)
    assert.ok(!names.includes('Marcus'), 'Marcus excluded (on shift)')
    assert.ok(!names.includes('Amy'), 'Amy excluded (40hrs)')
    assert.ok(names.includes('Sarah'), 'Sarah available')
    assert.ok(names.includes('Jake'), 'Jake available')
  })

  test('empty staff → empty array', async () => {
    const db = {
      getAllStaffForGroup: async () => [],
      getActiveStaffIds: async () => [],
      getWeeklyHours: async () => ({}),
      getCoveredRequests: async () => [],
      getNoShowAfterConfirm: async () => [],
    }
    const result = await getAvailableNow('g1', 10, new Date(), db)
    assert.equal(result.length, 0)
  })
})

describe('formatEmergencyResponse', () => {
  let formatEmergencyResponse

  test('setup', async () => {
    const mod = await import('../../intelligence/emergencyAvailability.js')
    formatEmergencyResponse = mod.formatEmergencyResponse
  })

  test('lists ranked staff with reasons', () => {
    const ranked = [
      { staffName: 'Sarah', roleName: 'Server', avgResponseMinutes: 8, rank: 1, reason: 'fastest responder' },
      { staffName: 'Jake', roleName: 'Server', avgResponseMinutes: 25, rank: 2, reason: '35hrs this week' },
    ]
    const result = formatEmergencyResponse(ranked, 'Friday Dinner', 45)
    assert.ok(result.includes('Sarah'), 'contains Sarah')
    assert.ok(result.includes('Jake'), 'contains Jake')
    assert.ok(result.includes('Friday Dinner'), 'contains shift name')
    assert.ok(result.includes('45'), 'contains time until shift')
  })

  test('no available staff → warning message', () => {
    const result = formatEmergencyResponse([], 'Friday Dinner', 45)
    assert.ok(result.includes('No staff'), 'contains warning')
  })
})

describe('handleEmergencyQuery', () => {
  let handleEmergencyQuery

  test('setup', async () => {
    const mod = await import('../../intelligence/emergencyAvailability.js')
    handleEmergencyQuery = mod.handleEmergencyQuery
  })

  test('sends formatted response and DMs top 3', async () => {
    const bot = new MockBot()
    const db = {
      getManagerGroup: async () => ({ group_id: 'g1', dm_chat_id: '999' }),
      getAllStaffForGroup: async () => [
        { id: 2, name: 'Sarah', role_name: 'Server' },
        { id: 3, name: 'Jake', role_name: 'Server' },
      ],
      getActiveStaffIds: async () => [],
      getWeeklyHours: async () => ({ 2: 28, 3: 35 }),
      getCoveredRequests: async () => [],
      getNoShowAfterConfirm: async () => [],
      getGroupMembersWithDm: async () => [
        { userId: 2, firstName: 'Sarah', dmChatId: '200' },
        { userId: 3, firstName: 'Jake', dmChatId: '300' },
      ],
      getNextUpcomingShift: async () => ({ name: 'Friday Dinner', start_time: '5:00pm', day_of_week: 'Friday' }),
    }
    const msg = { chat: { id: '999', type: 'private' }, from: { id: 777, first_name: 'Manager' }, text: 'who can work tonight' }
    await handleEmergencyQuery(bot, msg, db)
    // Should have sent response to manager + DMs to available staff
    assert.ok(bot.sentMessages.length >= 2, 'sent messages to manager and staff')
    const managerMsgs = bot.messagesTo('999')
    assert.ok(managerMsgs.length >= 1, 'manager received response')
  })

  test('no upcoming shift → graceful message', async () => {
    const bot = new MockBot()
    const db = {
      getManagerGroup: async () => ({ group_id: 'g1', dm_chat_id: '999' }),
      getAllStaffForGroup: async () => [],
      getActiveStaffIds: async () => [],
      getWeeklyHours: async () => ({}),
      getCoveredRequests: async () => [],
      getNoShowAfterConfirm: async () => [],
      getGroupMembersWithDm: async () => [],
      getNextUpcomingShift: async () => null,
    }
    const msg = { chat: { id: '999', type: 'private' }, from: { id: 777 }, text: 'who can work now' }
    await handleEmergencyQuery(bot, msg, db)
    const managerMsgs = bot.messagesTo('999')
    assert.ok(managerMsgs.length >= 1, 'manager received response')
    assert.ok(managerMsgs[0].text.includes('No shifts') || managerMsgs[0].text.includes('No staff'), 'graceful message')
  })
})
```

- [ ] **Step 2: Run test — verify fails**

```bash
node --test src/tests/unit/emergencyAvailability.test.js
```

- [ ] **Step 3: Implement emergencyAvailability.js**

```javascript
// src/intelligence/emergencyAvailability.js
import { logger } from '../logger.js'
import { getCoverageResponseStats } from './coverageSpeed.js'

export function rankAvailableStaff(staff, coverageStats) {
  if (!staff || staff.length === 0) return []

  const statsMap = new Map()
  for (const s of coverageStats) {
    statsMap.set(s.staffName, s)
  }

  const ranked = staff.map(s => {
    const stats = statsMap.get(s.staffName)
    const hoursScore = Math.max(0, 1 - (s.hoursThisWeek / 40))
    let reliabilityScore = 0.5 // default for unknown
    let speedScore = 0.5
    let reason = `${s.hoursThisWeek}hrs this week`

    if (stats) {
      reliabilityScore = stats.actualReliability ?? 0.5
      speedScore = Math.max(0, 1 - (stats.avgResponseMinutes / 60))
      reason = `fastest responder avg ${Math.round(stats.avgResponseMinutes)}min`
    }

    const score = (reliabilityScore * 0.5) + (speedScore * 0.3) + (hoursScore * 0.2)
    const availabilityConfidence = stats ? 'high' : 'unknown'

    return {
      staffId: s.staffId, staffName: s.staffName, roleName: s.roleName,
      hoursThisWeek: s.hoursThisWeek,
      avgResponseMinutes: stats?.avgResponseMinutes ?? null,
      availabilityConfidence, score, reason,
    }
  })

  ranked.sort((a, b) => b.score - a.score)
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }))
}

export async function getAvailableNow(groupId, shiftId, now = new Date(), db = null) {
  const _getAllStaff = db?.getAllStaffForGroup ?? (async () => [])
  const _getActiveIds = db?.getActiveStaffIds ?? (async () => [])
  const _getHours = db?.getWeeklyHours ?? (async () => ({}))

  const [allStaff, activeIds, hours] = await Promise.all([
    _getAllStaff(groupId),
    _getActiveIds(groupId, now),
    _getHours(groupId),
  ])

  const activeSet = new Set(activeIds.map(String))

  const available = allStaff
    .filter(s => !activeSet.has(String(s.id)))
    .filter(s => (hours[s.id] ?? 0) < 40)
    .map(s => ({
      staffId: s.id,
      staffName: s.name,
      roleName: s.role_name || 'Staff',
      hoursThisWeek: hours[s.id] ?? 0,
    }))

  const coverageStats = await getCoverageResponseStats(groupId, db)
  return rankAvailableStaff(available, coverageStats)
}

export function formatEmergencyResponse(rankedStaff, shiftName, timeUntilShift) {
  if (!rankedStaff || rankedStaff.length === 0) {
    return (
      `⚠️ *No staff appear available.* Everyone is either on shift, over hours, or has no response history.\n\n` +
      `You may need to call individually.`
    )
  }

  const lines = [`🚨 *Available for ${shiftName} in ${timeUntilShift}min:*`, '']
  for (const s of rankedStaff.slice(0, 5)) {
    lines.push(`${s.rank}. ${s.staffName} (${s.roleName}) — ${s.reason}`)
  }
  lines.push('')
  lines.push(`Sending coverage request to top ${Math.min(3, rankedStaff.length)} now.`)
  return lines.join('\n')
}

export async function handleEmergencyQuery(bot, msg, db = null) {
  const _getManagerGroup = db?.getManagerGroup ?? (async () => null)
  const _getNextShift = db?.getNextUpcomingShift ?? (async () => null)
  const _getMembers = db?.getGroupMembersWithDm ?? (async () => [])

  const chatId = String(msg.chat.id)

  const managerGroup = await _getManagerGroup(msg.from?.id)
  const groupId = managerGroup?.group_id
  if (!groupId) {
    await bot.sendMessage(chatId, "I don't know which restaurant you manage. Run /start in your group first.")
    return
  }

  const nextShift = await _getNextShift(groupId)
  if (!nextShift) {
    await bot.sendMessage(chatId, 'No shifts left today — nothing to cover.')
    return
  }

  const timeUntilShift = 45 // placeholder — would compute from shift time
  const ranked = await getAvailableNow(groupId, nextShift.id ?? 0, new Date(), db)
  const response = formatEmergencyResponse(ranked, nextShift.name || 'upcoming shift', timeUntilShift)

  await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })

  // DM top 3 immediately
  const members = await _getMembers(groupId)
  const top3 = ranked.slice(0, 3)

  for (const staff of top3) {
    const member = members.find(m => String(m.userId) === String(staff.staffId) || m.firstName === staff.staffName)
    if (!member?.dmChatId) continue
    try {
      await bot.sendMessage(member.dmChatId,
        `🚨 *Emergency coverage needed* for *${nextShift.name || 'shift'}* — needed ASAP.\n\nCan you come in? Reply *yes* or *no*.`,
        { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`Emergency DM to ${staff.staffName} failed: ${err.message}`)
    }
  }

  if (top3.length > 0) {
    const names = top3.map(s => s.staffName).join(', ')
    await bot.sendMessage(chatId, `📬 Coverage request sent to: ${names}`)
  }
}
```

- [ ] **Step 4: Run test — verify green**

```bash
node --check src/intelligence/emergencyAvailability.js && node --test src/tests/unit/emergencyAvailability.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/emergencyAvailability.js src/tests/unit/emergencyAvailability.test.js
git commit -m "feat: emergency availability query with ranked responders

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Wire All Features

**Files:**
- Modify: `src/routing/commandRouter.js:111-128` (demand recs + contextual warnings in schedule draft)
- Modify: `src/briefing/dailyBriefing.js:284-299` (Sunday narrative cron)
- Modify: `src/routing/groupRouter.js` (passive demand signal listener)

**Context:** Each wiring insertion follows the existing pattern of try/catch non-fatal sections with dynamic imports. Insert demand recommendations and contextual warnings between `alertsSection` and `reviewPrompt` in commandRouter.js. Add Sunday cron alongside existing 8am daily cron in dailyBriefing.js.

- [ ] **Step 1: Wire demand + contextual warnings into commandRouter.js**

In `src/routing/commandRouter.js`, after the `alertsSection` block (line ~121) and before `const hasWarnings` (line 123), add:

```javascript
      // Demand-aware recommendations
      let demandSection = ''
      try {
        const { generateDemandRecommendations, formatDemandRecommendations } = await import('../intelligence/demandSignals.js')
        const demandRecs = await generateDemandRecommendations(groupId, weekStart, schedule.assignments)
        const demandStr = formatDemandRecommendations(demandRecs)
        if (demandStr) demandSection = '\n\n' + demandStr
      } catch (demandErr) {
        logger.error(`Demand recommendations failed (non-fatal): ${demandErr.message}`)
      }

      // Contextual warnings from history
      let contextSection = ''
      try {
        const { generateContextualWarnings, formatContextualWarnings } = await import('../intelligence/contextualWarnings.js')
        const { warnings, notes } = await generateContextualWarnings(groupId, schedule.assignments)
        const contextStr = formatContextualWarnings(warnings, notes)
        if (contextStr) contextSection = '\n\n' + contextStr
      } catch (contextErr) {
        logger.error(`Contextual warnings failed (non-fatal): ${contextErr.message}`)
      }
```

Then update the message template on line 128 to include the new sections:

```javascript
      await bot.sendMessage(managerGroup.dm_chat_id,
        `📋 *Draft Schedule Ready*\n\n${formatted}${clopeningWarn}${hoursWarn}${budgetSection}${rulesSection}${prefsSection}${alertsSection}${demandSection}${contextSection}\n${reviewPrompt}`,
        { parse_mode: 'Markdown' })
```

- [ ] **Step 2: Wire Sunday narrative cron into dailyBriefing.js**

At the bottom of `src/briefing/dailyBriefing.js`, after `startBriefingCron`, add:

```javascript
export function startSundayBriefingCron(bot) {
  cron.schedule('0 19 * * 0', async () => {
    try {
      const { generateNarrativeBriefing, formatSundayBriefing } = await import('../intelligence/narrativeBriefing.js')
      const { getSetupSession } = await import('../setup/setupDb.js')
      const groups = await getConfiguredGroups()

      for (const groupId of groups) {
        try {
          const session = await getSetupSession(groupId)
          if (!session?.dm_chat_id) continue

          const now = new Date()
          const day = now.getDay()
          const diff = day === 0 ? -6 : 1 - day
          const monday = new Date(now)
          monday.setDate(now.getDate() + diff)
          const weekStart = monday.toISOString().split('T')[0]

          const result = await generateNarrativeBriefing(groupId, weekStart)
          if (!result?.narrative) continue

          const message = formatSundayBriefing(result.narrative, result.stats)
          await bot.sendMessage(session.dm_chat_id, message, { parse_mode: 'Markdown' })
        } catch (err) {
          logger.error(`Sunday briefing for ${groupId} failed: ${err.message}`)
        }
      }
    } catch (err) {
      logger.error(`Sunday briefing cron error: ${err.message}`)
    }
  })
  logger.info('Sunday narrative briefing cron started (7pm Sundays)')
}
```

- [ ] **Step 3: Wire Sunday cron into index.js**

In `src/index.js`, add import and invocation alongside existing cron starts (around line 58):

```javascript
import { startSundayBriefingCron } from './briefing/dailyBriefing.js'
// In the bot.getMe() callback, after existing cron starts:
startSundayBriefingCron(bot)
```

- [ ] **Step 4: Wire passive demand signal listener into groupRouter.js**

At the end of `src/routing/groupRouter.js`, after the main switch statement processes the intent, add a passive fire-and-forget listener:

```javascript
    // Passive demand signal detection — fire and forget
    try {
      const { extractDemandSignal, saveDemandSignal } = await import('../intelligence/demandSignals.js')
      const signal = extractDemandSignal(msg.text)
      if (signal) {
        const now = new Date()
        const day = now.getDay()
        const diff = day === 0 ? -6 : 1 - day
        const monday = new Date(now)
        monday.setDate(now.getDate() + diff)
        const weekStart = monday.toISOString().split('T')[0]
        saveDemandSignal(groupId, weekStart, signal, msg.text, msg.from?.id).catch(() => {})
      }
    } catch (_) {}
```

- [ ] **Step 5: Verify syntax on all modified files**

```bash
node --check src/routing/commandRouter.js && \
node --check src/briefing/dailyBriefing.js && \
node --check src/index.js && \
node --check src/routing/groupRouter.js
```
Expected: No syntax errors

- [ ] **Step 6: Run full test suite**

```bash
npm test
```
Expected: All existing tests pass, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/routing/commandRouter.js src/briefing/dailyBriefing.js src/index.js src/routing/groupRouter.js
git commit -m "feat: wire demand signals, contextual warnings, Sunday briefing, emergency query

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Validation and Hardening

- [ ] **Step 1: Run all 6 new test suites**

```bash
node --test src/tests/unit/autoShiftLog.test.js && \
node --test src/tests/unit/demandSignals.test.js && \
node --test src/tests/unit/coverageSpeed.test.js && \
node --test src/tests/unit/contextualWarnings.test.js && \
node --test src/tests/unit/narrativeBriefing.test.js && \
node --test src/tests/unit/emergencyAvailability.test.js
```

- [ ] **Step 2: Run full npm test — everything must pass**

```bash
npm test
```

- [ ] **Step 3: Security review**

Verify:
- Demand signal data isolated per group_id (check saveDemandSignal uses groupId in upsert)
- Narrative briefing only DMs manager (check formatSundayBriefing sends to session.dm_chat_id only)
- Emergency DMs respect missing dmChatId (check handleEmergencyQuery skips when `!member?.dmChatId`)
- Coverage speed rankings are per-group (check getCoverageResponseStats filters by groupId)

- [ ] **Step 4: Print suite objects for run-tests-parallel.js**

Output at end of build:

```
═══ ADD TO run-tests-parallel.js Phase 1 ═══
{ id: 'unit_auto_shift_log', file: 'unit/autoShiftLog.test.js', timeout: 10000 },
{ id: 'unit_demand_signals', file: 'unit/demandSignals.test.js', timeout: 10000 },
{ id: 'unit_coverage_speed', file: 'unit/coverageSpeed.test.js', timeout: 10000 },
{ id: 'unit_contextual_warnings', file: 'unit/contextualWarnings.test.js', timeout: 10000 },
{ id: 'unit_emergency_availability', file: 'unit/emergencyAvailability.test.js', timeout: 10000 },

═══ ADD TO run-tests-parallel.js Phase 2 ═══
{ id: 'unit_narrative_briefing', file: 'unit/narrativeBriefing.test.js', timeout: 30000 },
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: validate and harden intelligence tier 2 features

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
