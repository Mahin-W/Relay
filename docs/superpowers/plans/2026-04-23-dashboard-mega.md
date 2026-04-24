# Dashboard Mega-Update Implementation Plan

> **For agentic workers:** Each task is self-contained — read its "Files" list, do the work shown in "Steps", commit.

**Goal:** Backend fixes (re-setup clearing, schedule fallback for no availability, daily revenue table, weekly timeclock/events/full-settings routes) + dashboard rebuild of Payroll/TimeClock/Settings + new Event Log page + dark mode.

**Architecture:**
- Backend: add pure helpers; extend existing `src/server/dashRoutes.js`; add one new `src/setup/db/*.js` helper and one schema table.
- Frontend: edit `public/dashboard.html` in place, replace three `renderXxxPage()` function bodies, add new `renderEventLogPage()`, add sidebar nav item, add dark-mode CSS + localStorage toggle.
- Pattern: reuse existing `api()`, `showToast()`, `showModal()`, `escapeHtml()`, `escapeJs()`, skeleton CSS. Routes use `/api/*` paths (both `/api` and `/api/dashboard` are mounted — pick `/api` for new routes).

**Tech Stack:** Node 20+ ESM, Express 5, Supabase (Postgres), node-telegram-bot-api, vanilla JS dashboard (no framework), plain CSS with CSS variables + dark-mode class variant, ExcelJS (existing), jsonwebtoken (existing).

---

## Ground-truth facts discovered during research

- **Dashboard helpers** (`public/dashboard.html`):
  - `api(path, method='GET', body=null)` — throws on non-ok; uses `credentials: 'include'`; 401 redirects to `/login`. Full paths (no prefix).
  - `showToast(msg, type='success')` — types `success` / `error` / `warning`.
  - `showModal(title, bodyHTML, onConfirm, confirmLabel='Confirm')` — `onConfirm` is `async () => {}`, called after close.
  - `navigateTo(page)` → sets hash, updates active nav, calls `loadPage(page)`.
  - `setContent(html)` replaces `#page-content` innerHTML.
  - `escapeHtml()`, `escapeJs()`, `formatWeekRange()`, `formatDate()`, `parseDate()` exist.
  - Separate week state per page: `currentScheduleWeek`, `currentPayrollWeek` (both `YYYY-MM-DD` Monday).
  - `PAGE_TITLES` map drives nav + header.
  - Skeleton classes: `.skeleton`, `.skeleton-stat`, `.skeleton-row`, `.skeleton-line`.

- **Route mounting** (`webServer.js:30-31`): `/api` and `/api/dashboard` both point to `dashRoutes.js`. New routes use bare `/api/*`.

- **Auth** (`middleware.js`): `requireAuth` populates `req.manager = { groupId, restaurantName, ... }` from JWT. Globally applied.

- **Schema** (`supabase-schema.sql`):
  - `shift_requirements.shift_id` → `shifts(id) ON DELETE CASCADE` — deleting shifts auto-clears requirements.
  - `business_rules`, `schedule_edit_events`, `learned_preferences`, `morale_events`, `platform_contacts`, `business_rules.object_staff_id` → `staff(id) ON DELETE CASCADE`.
  - `business_rules.shift_id` → `shifts(id) ON DELETE SET NULL`.
  - `schedule_assignments` has NO FK — manual delete required.
  - `availability` has `group_id TEXT` column (keyed by `user_id`, `week_start`, `group_id`).
  - `weekly_revenue` has `UNIQUE (group_id, week_start)`.
  - `staff.active BOOLEAN DEFAULT true` (current CRUD soft-deletes; clearGroupSetupData hard-deletes — different semantics, fine for re-setup).

- **generateWeeklySchedule** existing return shape (don't break):
  ```js
  { assignments, gaps, weekStart, scheduleId, clopenings, hoursIssues, ruleConflicts, crossTrainingUsed, alreadyPublished }
  ```
  Accepts optional `mockData` 3rd arg for tests. Loads availability via `getAvailabilityForGroup(groupId, weekStart)` from `src/availability/availabilityDb.js`.

- **Availability record shape:** `{ user_id, group_id, week_start, available_shift_ids: BIGINT[], available_all: boolean, unavailable: boolean }`. Keyed by `user_id`. **Problem:** many `staff` rows have no `userId` (they're not yet on Telegram). The fallback must bypass `isAvailable()` entirely when `useFallback=true`, not just synthesize records — since records are keyed by user_id which may be null.

- **Setup wizard re-entry**: `startSetupDM()` calls `createSetupSession()` which upserts, resetting `step='welcome'` and `setup_complete=false`. But staff/shifts are NOT cleared. Insert `clearGroupSetupData()` call inside `startSetupDM` just BEFORE `createSetupSession`, gated on `existing?.setup_complete === true`.

- **`saveShift`/`saveStaff` always INSERT** — no dedupe. Re-run without clearing → duplicate rows (which the user already experienced).

---

## File Ownership Map

| # | Task | Owns (creates or modifies) |
|---|------|---------------------------|
| 1 | logger (already done) | `src/logger.js` — already committed in 06b0353 |
| 2 | clearGroupSetupData | `src/setup/db/cleanup.js` (create), `src/setup/setupDb.js` (add re-export), `src/setup/setupFlow.js` (wire the call) |
| 3 | schedule fallback | `src/schedule/generateSchedule.js` (extend) |
| 4 | daily_revenue + routes | `supabase-schema.sql` (append), `src/server/dashRoutes.js` (add 3 routes) |
| 5 | timeclock/weekly + events + settings/full | `src/server/dashRoutes.js` (add 4 routes: GET/weekly, GET/events, GET/settings/full, PATCH/settings/full) |
| 6 | dashboard frontend | `public/dashboard.html` (all edits) |
| 7 | verify + commit | all |

No overlaps — each backend task touches a distinct code region; all frontend work is one file.

---

## Task 1: Logger.warn fix (DONE — commit `06b0353`)

Added `warn:` method to `src/logger.js`. Fixes silent breakage at 6 call sites. This was done earlier in the session; no action here.

---

## Task 2: clearGroupSetupData on re-setup

**Files:**
- Create: `src/setup/db/cleanup.js`
- Modify: `src/setup/setupDb.js` — add re-export line
- Modify: `src/setup/setupFlow.js` — call at start of `startSetupDM` when existing session's `setup_complete === true`

**Why only when `setup_complete=true`**: if someone runs `/setup` mid-wizard (incomplete), they're likely resuming — don't nuke their partial data. Only a fresh run should clear.

### Step 1 — Create the cleanup helper

Write `src/setup/db/cleanup.js`:

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

/**
 * Clear configuration data for a group before a fresh /setup run.
 * Deletes: schedule_assignments → availability → staff → shifts.
 * shift_requirements cascade-deletes with shifts (FK).
 * PRESERVES historical data: payroll_records, time_entries, coverage_requests,
 * trade_requests, manager_log_entries, staff_reliability_events, tip_records,
 * and the setup_sessions row itself.
 *
 * Accepts a test-time db shim: db.runCleanup(groupId) — if provided, delegates
 * so unit tests don't need live Supabase.
 */
export async function clearGroupSetupData(groupId, db = null) {
  if (db?.runCleanup) return db.runCleanup(groupId)
  try {
    // Order matters: children first, parents last.
    // schedule_assignments has no FK cascade — manual delete required.
    await supabase.from('schedule_assignments').delete().eq('group_id', groupId)
    // availability is keyed by (user_id, week_start, group_id)
    await supabase.from('availability').delete().eq('group_id', groupId)
    // staff delete cascades to: business_rules, schedule_edit_events,
    // learned_preferences, morale_events, platform_contacts — desired for re-setup.
    await supabase.from('staff').delete().eq('group_id', groupId)
    // shifts delete cascades to shift_requirements.
    await supabase.from('shifts').delete().eq('group_id', groupId)
    logger.db(`Cleared setup data for group ${groupId} (assignments, availability, staff, shifts)`)
    return true
  } catch (err) {
    logger.error(`clearGroupSetupData failed: ${err.message}`)
    return false
  }
}
```

### Step 2 — Re-export from setupDb.js

Edit `src/setup/setupDb.js` — append:

```js
export * from './db/cleanup.js'
```

### Step 3 — Wire into startSetupDM

Edit `src/setup/setupFlow.js` — imports at top:

```js
import { createSetupSession, getSetupSession, clearGroupSetupData } from './setupDb.js'
```

Then replace the body of `startSetupDM` (currently lines 10–32):

```js
export async function startSetupDM(bot, msg, groupId) {
  const managerId = msg.from.id
  const dmChatId = msg.chat.id
  const managerName = msg.from.first_name || 'there'

  let groupName = `Group ${groupId}`
  try {
    const chat = await bot.getChat(groupId)
    groupName = chat.title || groupName
  } catch (err) {
    logger.error(`Could not fetch group info for ${groupId}: ${err.message}`)
  }

  // If a previous setup was COMPLETED, wipe its data so re-setup starts clean.
  // Mid-wizard sessions (setup_complete=false) are preserved for resumption.
  const existing = await getSetupSession(groupId)
  const wasCompleted = existing?.setup_complete === true
  if (wasCompleted) {
    await clearGroupSetupData(groupId)
  }

  await createSetupSession(groupId, groupName, managerId, dmChatId)

  const resetNote = wasCompleted
    ? `\n_(Previous setup cleared — historical payroll and time clock data preserved.)_\n`
    : ''

  await bot.sendMessage(dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n${resetNote}\n` +
    `First — what's your restaurant called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' })

  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName}${wasCompleted ? ' — data cleared' : ''}`)
}
```

### Step 4 — Verify

```bash
node --check src/setup/db/cleanup.js
node --check src/setup/setupDb.js
node --check src/setup/setupFlow.js
```

All three must print nothing (success).

### Step 5 — Commit

```bash
git add src/setup/db/cleanup.js src/setup/setupDb.js src/setup/setupFlow.js
git commit -m "fix(setup): clear stale data on re-setup for completed groups"
```

---

## Task 3: Schedule generation fallback for no availability

**Files:**
- Modify: `src/schedule/generateSchedule.js` — add helper function, add fallback branch, extend return shape with `warnings`

### Step 1 — Add buildFallbackAvailability helper

In `src/schedule/generateSchedule.js`, add this helper just after `formatWeekLabel()` (around line 47), before `generateWeeklySchedule`:

```js
/**
 * Build synthetic availability when no real availability was submitted.
 * Used only when availabilityRecords is empty — emits a warning in the return.
 *
 * Returns a shape-compatible array but the isAvailable() function below
 * should short-circuit to `true` when useFallback is set — this helper's
 * records act as a fallback for the availMap key lookup.
 */
function buildFallbackAvailability(resolvedStaff, weekStart, groupId) {
  const records = []
  for (const s of resolvedStaff) {
    if (!s.userId) continue  // staff without a Telegram userId — handled via useFallback flag
    records.push({
      user_id: s.userId,
      group_id: groupId,
      week_start: weekStart,
      available_shift_ids: [],
      available_all: true,
      unavailable: false,
      raw_response: null,
      collected_at: null,
    })
  }
  return records
}
```

### Step 2 — Apply fallback in the live path

In `generateWeeklySchedule`, after `availabilityRecords = liveAvail` (line 88), insert:

```js
      // Fallback: no availability submitted → assign by role-match using staff table.
      // In this mode, isAvailable() returns true for every staff, letting the
      // existing greedy loop pick candidates purely by role + rules.
      var useFallback = false
      if (availabilityRecords.length === 0) {
        availabilityRecords = buildFallbackAvailability(resolvedStaff, weekStart, groupId)
        useFallback = true
      }
```

Also apply the same fallback inside the mockData branch, right after `availabilityRecords = mockData.availability ?? []`:

```js
      var useFallback = false
      if (availabilityRecords.length === 0 && resolvedStaff.length > 0) {
        availabilityRecords = buildFallbackAvailability(resolvedStaff, weekStart, groupId)
        useFallback = true
      }
```

**Note:** `useFallback` is declared with `var` to hoist into the outer try scope. (The existing code already has the try opening at line 60, so placing `var useFallback = false` inside the if/else branches works because `var` is function-scoped. Alternatively, declare `let useFallback = false` once at line 61 before the branches.)

**Cleaner refactor — declare once:** at line 61 (just after the try opens), add `let useFallback = false`. Then inside both paths, only set `useFallback = true` when synthesizing. This avoids `var` hoisting subtlety:

```js
  const _promise = (async () => {
  try {
    let shifts, resolvedStaff, availabilityRecords, requirements, maxShiftsPerDay = 0, mockRules = null
    let useFallback = false
    // ... existing mockData / live branching ...
    // After availabilityRecords is assigned in each branch, add:
    //   if (availabilityRecords.length === 0 && resolvedStaff.length > 0) {
    //     availabilityRecords = buildFallbackAvailability(resolvedStaff, weekStart, groupId)
    //     useFallback = true
    //   }
```

### Step 3 — Update `isAvailable` to respect fallback

Replace the existing `isAvailable` function (lines 131–140):

```js
    function isAvailable(userId, shiftId) {
      if (useFallback) return true  // fallback path: role-match only, ignore availability
      if (!userId) return false
      const av = availMap[userId]
      if (!av) return false // no response = not available
      if (av.unavailable) return false
      if (av.available_all) return true
      const ids = (av.available_shift_ids ?? []).map(Number)
      return ids.includes(Number(shiftId))
    }
```

### Step 4 — Add warnings to return value

At line 421 (the return statement), change to:

```js
    const warnings = []
    if (useFallback) {
      warnings.push({
        type: 'no_availability',
        message: 'No availability was submitted for this week. Schedule generated from role matching only — please verify before publishing.',
      })
    }

    return { assignments, gaps, weekStart, scheduleId: saved?.id ?? null, clopenings, hoursIssues, ruleConflicts, crossTrainingUsed, alreadyPublished, warnings }
```

Also in the catch-block return at line 424:

```js
    return { assignments: [], gaps: [], weekStart, scheduleId: null, warnings: [] }
```

### Step 5 — Staff-without-userId handling

**Problem**: `resolvedStaff` entries whose `userId` is null still need to be candidates in fallback mode. The greedy loop filter at line 202 calls `isAvailable(s.userId, shift.id)` — when `useFallback`, this now returns true always (including for null userId). Good. But the day-count tracking at lines 206–209 skips staff with null userId, so they won't be subject to maxShiftsPerDay. That matches existing behavior. No change needed.

### Step 6 — Verify

```bash
node --check src/schedule/generateSchedule.js
```

Also run existing schedule generator tests:

```bash
node --env-file=.env --test src/tests/unit/scheduleGenerator.test.js
```

Expected: all existing tests still pass (we only added a branch when availability is empty — every existing test provides non-empty availability or explicitly tests the empty case).

### Step 7 — Commit

```bash
git add src/schedule/generateSchedule.js
git commit -m "feat(schedule): role-based fallback when no availability submitted"
```

---

## Task 4: daily_revenue table + 3 routes

**Files:**
- Modify: `supabase-schema.sql` — append table definition (for documentation; real migration is the SQL block printed at end)
- Modify: `src/server/dashRoutes.js` — add three routes

### Step 1 — Append schema definition

Append to `supabase-schema.sql` (just before the closing anon comment):

```sql
-- ═══════════════════════════════════════════════════════════════
-- DAILY REVENUE (granular entries; weekly_revenue is maintained as a cache)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_revenue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  entry_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_revenue_group_date
  ON daily_revenue(group_id, entry_date);
```

### Step 2 — Add routes

In `src/server/dashRoutes.js`, add AFTER the existing `POST /payroll/revenue` route (around line 923):

```js
// ─── DAILY REVENUE ────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().split('T')[0]
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

async function recalcWeeklyRevenue(db, groupId, weekStart) {
  const weekEnd = addDays(weekStart, 6)
  const { data: rows } = await db
    .from('daily_revenue')
    .select('amount')
    .eq('group_id', groupId)
    .gte('entry_date', weekStart)
    .lte('entry_date', weekEnd)
  const total = (rows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0)

  // Preserve labor metrics if they already exist — only overwrite `revenue`.
  const { data: existing } = await db
    .from('weekly_revenue')
    .select('total_labor_cost')
    .eq('group_id', groupId)
    .eq('week_start', weekStart)
    .maybeSingle()

  const laborCost = existing?.total_labor_cost ?? null
  const laborPct  = (laborCost != null && total > 0) ? Number(((laborCost / total) * 100).toFixed(2)) : null

  await db
    .from('weekly_revenue')
    .upsert(
      { group_id: groupId, week_start: weekStart, revenue: total, total_labor_cost: laborCost, labor_percent: laborPct },
      { onConflict: 'group_id,week_start' }
    )

  return { total, laborPercent: laborPct }
}

// GET /api/revenue/daily?weekStart=YYYY-MM-DD
router.get('/revenue/daily', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEnd = addDays(weekStart, 6)
    const db = supabase()

    const { data, error } = await db
      .from('daily_revenue')
      .select('id, entry_date, amount, note, created_at')
      .eq('group_id', groupId)
      .gte('entry_date', weekStart)
      .lte('entry_date', weekEnd)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) throw error

    // Build day buckets for all 7 days (even if empty)
    const days = {}
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i)
      days[d] = { total: 0, entries: [] }
    }
    for (const r of data ?? []) {
      const key = String(r.entry_date).slice(0, 10)
      if (!days[key]) days[key] = { total: 0, entries: [] }
      days[key].total = Number((Number(days[key].total) + Number(r.amount)).toFixed(2))
      days[key].entries.push({
        id: r.id,
        amount: Number(r.amount),
        note: r.note,
        created_at: r.created_at,
      })
    }
    const weekTotal = Object.values(days).reduce((s, d) => s + Number(d.total), 0)

    res.json({ weekStart, weekEnd, days, weekTotal: Number(weekTotal.toFixed(2)) })
  } catch (err) {
    console.error('GET /revenue/daily error:', err.message)
    res.status(500).json({ error: 'Failed to load daily revenue' })
  }
})

// POST /api/revenue/daily  body: { date, amount, note? }
router.post('/revenue/daily', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { date, amount, note } = req.body ?? {}
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' })
    }
    const db = supabase()

    const { data: inserted, error } = await db
      .from('daily_revenue')
      .insert({ group_id: groupId, entry_date: date, amount: amt, note: note || null })
      .select()
      .single()
    if (error) throw error

    const weekStart = mondayOf(date)
    const { total } = await recalcWeeklyRevenue(db, groupId, weekStart)

    res.status(201).json({ entry: inserted, dayTotal: total })
  } catch (err) {
    console.error('POST /revenue/daily error:', err.message)
    res.status(500).json({ error: 'Failed to save revenue entry' })
  }
})

// DELETE /api/revenue/daily/:id
router.delete('/revenue/daily/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const db = supabase()

    // Scope the delete to this group — prevents cross-tenant deletion
    const { data: found, error: fErr } = await db
      .from('daily_revenue')
      .select('id, entry_date')
      .eq('id', id)
      .eq('group_id', groupId)
      .maybeSingle()
    if (fErr) throw fErr
    if (!found) return res.status(404).json({ error: 'Entry not found' })

    const { error } = await db.from('daily_revenue').delete().eq('id', id).eq('group_id', groupId)
    if (error) throw error

    const weekStart = mondayOf(found.entry_date)
    await recalcWeeklyRevenue(db, groupId, weekStart)

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /revenue/daily/:id error:', err.message)
    res.status(500).json({ error: 'Failed to delete revenue entry' })
  }
})
```

### Step 3 — Verify

```bash
node --check src/server/dashRoutes.js
```

### Step 4 — Commit

```bash
git add src/server/dashRoutes.js supabase-schema.sql
git commit -m "feat(revenue): per-day revenue entries with weekly aggregation"
```

---

## Task 5: timeclock/weekly + events + settings/full routes

**Files:**
- Modify: `src/server/dashRoutes.js` — add four routes

### Step 1 — Add the weekly timeclock route

After the existing `POST /timeclock/override` (around line 1400), add:

```js
// GET /api/timeclock/weekly?weekStart=YYYY-MM-DD
// Per-staff scheduled hours vs clocked hours + missed clock-outs + entry list.
router.get('/timeclock/weekly', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEnd = addDays(weekStart, 6)
    const weekEndExclusive = addDays(weekStart, 7)
    const db = supabase()

    const [staffRes, shiftsRes, assignRes, entriesRes] = await Promise.all([
      db.from('staff').select('id, name, role').eq('group_id', groupId).eq('active', true),
      db.from('shifts').select('id, name, start_time, end_time, day_of_week').eq('group_id', groupId),
      db.from('schedule_assignments').select('staff_id, shift_id').eq('group_id', groupId).eq('week_start', weekStart),
      db.from('time_entries').select('id, staff_id, shift_id, clock_in, clock_out')
        .eq('group_id', groupId)
        .gte('clock_in', `${weekStart}T00:00:00Z`)
        .lt('clock_in', `${weekEndExclusive}T00:00:00Z`),
    ])

    const shifts = shiftsRes.data ?? []
    const shiftMap = Object.fromEntries(shifts.map(s => [String(s.id), s]))
    const assignments = assignRes.data ?? []
    const entries = entriesRes.data ?? []

    const scheduledHoursByStaff = {}
    const shiftsByStaff = {}
    for (const a of assignments) {
      const sh = shiftMap[String(a.shift_id)]
      if (!sh) continue
      const hours = parseShiftHours(sh.start_time, sh.end_time)
      scheduledHoursByStaff[a.staff_id] = (scheduledHoursByStaff[a.staff_id] ?? 0) + hours
      shiftsByStaff[a.staff_id] = (shiftsByStaff[a.staff_id] ?? 0) + 1
    }

    const now = Date.now()
    const MISSED_THRESHOLD_MS = 12 * 60 * 60 * 1000 // 12h old and still open = missed

    const entriesByStaff = {}
    for (const e of entries) {
      const sid = e.staff_id
      if (!sid) continue
      if (!entriesByStaff[sid]) entriesByStaff[sid] = []
      const clockInMs = new Date(e.clock_in).getTime()
      const clockOutMs = e.clock_out ? new Date(e.clock_out).getTime() : null
      const hours = clockOutMs
        ? (clockOutMs - clockInMs) / 3600000
        : Math.min((now - clockInMs) / 3600000, 24)
      const missedClockOut = !e.clock_out && (now - clockInMs) > MISSED_THRESHOLD_MS
      entriesByStaff[sid].push({
        id: e.id,
        shiftId: e.shift_id,
        shiftName: shiftMap[String(e.shift_id)]?.name ?? null,
        clockIn: e.clock_in,
        clockOut: e.clock_out,
        hours: Number(hours.toFixed(2)),
        missedClockOut,
      })
    }

    const rows = (staffRes.data ?? []).map(s => {
      const hoursScheduled = Number((scheduledHoursByStaff[s.id] ?? 0).toFixed(2))
      const staffEntries = entriesByStaff[s.id] ?? []
      const hoursClocked = Number(staffEntries.reduce((sum, e) => sum + e.hours, 0).toFixed(2))
      const missedCount = staffEntries.filter(e => e.missedClockOut).length
      return {
        staffId: s.id,
        staffName: s.name,
        role: s.role,
        shiftsScheduled: shiftsByStaff[s.id] ?? 0,
        hoursScheduled,
        hoursClocked,
        variance: Number((hoursClocked - hoursScheduled).toFixed(2)),
        entries: staffEntries,
        missedClockOuts: missedCount,
      }
    }).sort((a, b) => a.staffName.localeCompare(b.staffName))

    res.json({ weekStart, weekEnd, rows })
  } catch (err) {
    console.error('GET /timeclock/weekly error:', err.message)
    res.status(500).json({ error: 'Failed to load weekly timeclock' })
  }
})
```

### Step 2 — Add the events route

Right after the weekly timeclock route, add:

```js
// GET /api/events?weekStart=YYYY-MM-DD&limit=50
// Unified event log — coverage + trade + overtime events for a week.
router.get('/events', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEndExclusive = addDays(weekStart, 7)
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const db = supabase()

    const [coverageRes, tradeRes, payrollRes, staffRes, shiftsRes] = await Promise.all([
      db.from('coverage_requests')
        .select('id, shift_description, requested_by, covered_by, status, created_at, covered_at, matched_shift_id')
        .eq('group_id', groupId)
        .gte('created_at', `${weekStart}T00:00:00Z`)
        .lt('created_at', `${weekEndExclusive}T00:00:00Z`)
        .order('created_at', { ascending: false }),
      db.from('trade_requests')
        .select('id, requester_name, accepted_by_name, shift_description, accepted_shift_description, status, created_at')
        .eq('group_id', groupId)
        .gte('created_at', `${weekStart}T00:00:00Z`)
        .lt('created_at', `${weekEndExclusive}T00:00:00Z`)
        .order('created_at', { ascending: false }),
      db.from('payroll_records')
        .select('staff_id, total_hours, total_gross_pay, week_start')
        .eq('group_id', groupId)
        .eq('week_start', weekStart),
      db.from('staff').select('id, name').eq('group_id', groupId),
      db.from('shifts').select('id, name').eq('group_id', groupId),
    ])

    const staffMap = Object.fromEntries((staffRes.data ?? []).map(s => [String(s.id), s.name]))
    const shiftMap = Object.fromEntries((shiftsRes.data ?? []).map(s => [String(s.id), s.name]))

    const events = []

    for (const c of coverageRes.data ?? []) {
      const fillMinutes = c.covered_at && c.created_at
        ? Math.round((new Date(c.covered_at) - new Date(c.created_at)) / 60000)
        : null
      events.push({
        eventType: 'coverage',
        timestamp: c.created_at,
        title: `${c.requested_by || 'Someone'} called out — ${c.shift_description}`,
        meta: c.status === 'covered'
          ? { status: 'covered', coveredBy: c.covered_by, fillMinutes }
          : { status: c.status },
      })
    }

    for (const t of tradeRes.data ?? []) {
      events.push({
        eventType: 'trade',
        timestamp: t.created_at,
        title: `Shift trade: ${t.requester_name}${t.accepted_by_name ? ` ↔ ${t.accepted_by_name}` : ' (open)'}`,
        meta: {
          status: t.status,
          from: t.shift_description,
          to: t.accepted_shift_description,
        },
      })
    }

    for (const p of payrollRes.data ?? []) {
      if (Number(p.total_hours) > 40) {
        events.push({
          eventType: 'overtime',
          timestamp: `${p.week_start}T00:00:00Z`,
          title: `${staffMap[String(p.staff_id)] || 'Unknown'} — overtime week`,
          meta: {
            totalHours: Number(p.total_hours),
            overtimeHours: Number((Number(p.total_hours) - 40).toFixed(2)),
            grossPay: Number(p.total_gross_pay),
          },
        })
      }
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

    res.json({ weekStart, events: events.slice(0, limit) })
  } catch (err) {
    console.error('GET /events error:', err.message)
    res.status(500).json({ error: 'Failed to load events' })
  }
})
```

### Step 3 — Add settings/full routes

Right after the events route, add:

```js
// GET /api/settings/full — everything configurable, in one call
router.get('/settings/full', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()

    const [sessionRes, staffRes, shiftsRes, reqsShiftsRes, ratesRes, overtimeRes, budgetRes, rulesRes] = await Promise.all([
      db.from('setup_sessions').select('group_id, group_name, setup_data').eq('group_id', groupId).single(),
      db.from('staff').select('id, name, role, active').eq('group_id', groupId).eq('active', true),
      db.from('shifts').select('*').eq('group_id', groupId),
      db.from('shifts').select('id').eq('group_id', groupId),
      db.from('role_rates').select('role_name, hourly_rate').eq('group_id', groupId),
      db.from('overtime_settings').select('*').eq('group_id', groupId).maybeSingle(),
      db.from('labor_budgets').select('weekly_budget, currency').eq('group_id', groupId).maybeSingle(),
      db.from('business_rules').select('*').eq('group_id', groupId).or('active.is.null,active.eq.true'),
    ])

    // Shift requirements (joined by shift_id)
    const shiftIds = (reqsShiftsRes.data ?? []).map(s => s.id)
    let requirements = []
    if (shiftIds.length > 0) {
      const { data } = await db.from('shift_requirements').select('*').in('shift_id', shiftIds)
      requirements = data ?? []
    }

    const session = sessionRes.data || {}
    const setupData = session.setup_data || {}

    res.json({
      restaurant: {
        groupId: session.group_id,
        name: session.group_name,
      },
      staff: (staffRes.data ?? []).map(s => ({ id: s.id, name: s.name, role: s.role })),
      shifts: (shiftsRes.data ?? []).map(s => ({
        id: s.id,
        name: s.name,
        dayOfWeek: s.day_of_week,
        startTime: s.start_time,
        endTime: s.end_time,
        requirements: requirements.filter(r => String(r.shift_id) === String(s.id))
          .map(r => ({ id: r.id, role: r.role, count: r.count })),
      })),
      rates: (ratesRes.data ?? []).map(r => ({ roleName: r.role_name, hourlyRate: Number(r.hourly_rate) })),
      overtime: overtimeRes.data || {
        overtime_enabled: false,
        weekly_threshold: 40,
        weekly_multiplier: 1.5,
        daily_overtime_enabled: false,
        daily_threshold: 8,
        daily_multiplier: 1.5,
      },
      tips: {
        mode: setupData.tipMode || 'pool',
        splitMethod: setupData.tipSplitMethod || 'hours',
        bohIncluded: setupData.tipBohIncluded ?? false,
      },
      budget: {
        weeklyBudget: budgetRes.data?.weekly_budget ?? null,
        currency: budgetRes.data?.currency || 'USD',
      },
      rules: rulesRes.data ?? [],
    })
  } catch (err) {
    console.error('GET /settings/full error:', err.message)
    res.status(500).json({ error: 'Failed to load full settings' })
  }
})

// PATCH /api/settings/full — update subsections independently
// Body: any subset of { restaurant: {name}, overtime: {...}, tips: {mode, splitMethod, bohIncluded}, budget: {weeklyBudget} }
router.patch('/settings/full', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const body = req.body ?? {}
    const db = supabase()
    const errors = {}
    const updated = {}

    if (body.restaurant?.name !== undefined) {
      try {
        const { error } = await db.from('setup_sessions').update({ group_name: body.restaurant.name }).eq('group_id', groupId)
        if (error) throw error
        updated.restaurant = true
      } catch (e) { errors.restaurant = e.message }
    }

    if (body.overtime) {
      try {
        const ot = body.overtime
        const { error } = await db.from('overtime_settings').upsert({
          group_id: groupId,
          overtime_enabled: ot.overtime_enabled,
          weekly_threshold: ot.weekly_threshold,
          weekly_multiplier: ot.weekly_multiplier,
          daily_overtime_enabled: ot.daily_overtime_enabled,
          daily_threshold: ot.daily_threshold,
          daily_multiplier: ot.daily_multiplier,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id' })
        if (error) throw error
        updated.overtime = true
      } catch (e) { errors.overtime = e.message }
    }

    if (body.tips) {
      try {
        const { data: sess } = await db.from('setup_sessions').select('setup_data').eq('group_id', groupId).single()
        const merged = {
          ...(sess?.setup_data || {}),
          tipMode: body.tips.mode,
          tipSplitMethod: body.tips.splitMethod,
          tipBohIncluded: body.tips.bohIncluded,
        }
        const { error } = await db.from('setup_sessions').update({ setup_data: merged }).eq('group_id', groupId)
        if (error) throw error
        updated.tips = true
      } catch (e) { errors.tips = e.message }
    }

    if (body.budget?.weeklyBudget !== undefined) {
      try {
        const { error } = await db.from('labor_budgets').upsert({
          group_id: groupId,
          weekly_budget: Number(body.budget.weeklyBudget),
          currency: body.budget.currency || 'USD',
        }, { onConflict: 'group_id' })
        if (error) throw error
        updated.budget = true
      } catch (e) { errors.budget = e.message }
    }

    if (Object.keys(updated).length === 0 && Object.keys(errors).length === 0) {
      return res.status(400).json({ error: 'No updatable fields in body' })
    }
    res.json({ updated, errors: Object.keys(errors).length ? errors : undefined })
  } catch (err) {
    console.error('PATCH /settings/full error:', err.message)
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

// POST /api/rates — add/update a role rate (used by Settings pay-rates section)
router.post('/rates', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { roleName, hourlyRate } = req.body ?? {}
    if (!roleName || typeof roleName !== 'string') return res.status(400).json({ error: 'roleName required' })
    const rate = Number(hourlyRate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 500) return res.status(400).json({ error: 'hourlyRate must be 0–500' })

    const db = supabase()
    const { data, error } = await db
      .from('role_rates')
      .upsert({ group_id: groupId, role_name: roleName, hourly_rate: rate, updated_at: new Date().toISOString() }, { onConflict: 'group_id,role_name' })
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('POST /rates error:', err.message)
    res.status(500).json({ error: 'Failed to save rate' })
  }
})
```

**Reminder:** `addDays` and `mondayOf` helpers were defined in Task 4. If Task 5 is implemented before Task 4, move those helpers here instead.

### Step 4 — Verify

```bash
node --check src/server/dashRoutes.js
```

### Step 5 — Commit

```bash
git add src/server/dashRoutes.js
git commit -m "feat(api): weekly timeclock, events feed, full settings routes"
```

---

## Task 6: Dashboard frontend — rebuilds + new page + dark mode

**Files:**
- Modify: `public/dashboard.html` — all edits

This is the biggest task. It touches: CSS additions, sidebar nav, `PAGE_TITLES`, `loadPage()` switch, `renderPayrollPage` + `loadPayrollPage`, `renderTimeClockPage` + `loadTimeClockPage`, `renderSettingsPage` + `loadSettingsPage`, new `renderEventLogPage` + `loadEventLogPage`, dark-mode toggle + localStorage.

### Step 1 — Add dark-mode CSS to `:root`

In the `<style>` block, add after the existing `:root { ... }` rule:

```css
:root.dark {
  --bg: #141218;
  --surface: #1E1B22;
  --surface-alt: #2A242F;
  --surface-border: #3A3240;
  --text: #EDE7E0;
  --text-secondary: #BFB5AA;
  --text-muted: #7A6F68;
  --accent: #F07A3F;
  --accent-hover: #FF9258;
  --accent-light: #3A2820;
  --success: #4FB386;
  --success-light: #1C3028;
  --sidebar-bg: #0E0C10;
}
```

### Step 2 — Add shared CSS for new components

In the `<style>` block, add at the end (before `</style>`):

```css
/* Warning banner (schedule-generate no-availability) */
.warning-banner {
  display: flex; align-items: center; gap: 10px;
  background: #FEF3C7; border: 1px solid #F59E0B;
  border-radius: 8px; padding: 12px 16px;
  margin-bottom: 16px; font-size: 14px; color: #92400E;
}
:root.dark .warning-banner { background: #3A2A10; color: #FCD34D; border-color: #92400E; }
.warning-banner button {
  margin-left: auto; background: none; border: none;
  cursor: pointer; color: inherit; font-size: 16px;
}

/* Daily revenue grid */
.revenue-section { margin-top: 24px; }
.revenue-header {
  display: flex; justify-content: space-between;
  align-items: center; margin-bottom: 16px;
}
.week-total { font-weight: 700; font-size: 18px; }
.revenue-grid {
  display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px;
}
.revenue-day {
  background: var(--surface); border: 1px solid var(--surface-border);
  border-radius: 8px; padding: 12px; min-height: 160px;
  display: flex; flex-direction: column;
}
.day-label {
  font-size: 11px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.day-date { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.day-total { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
.day-entries { flex: 1; overflow-y: auto; max-height: 120px; }
.revenue-entry {
  display: flex; align-items: center; gap: 4px;
  font-size: 12px; padding: 2px 0; border-bottom: 1px solid var(--surface-alt);
}
.entry-amount { font-weight: 600; }
.entry-note {
  color: var(--text-muted); flex: 1; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.entry-delete {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; padding: 0 2px; font-size: 11px;
}
.entry-delete:hover { color: #C0392B; }
.add-entry { margin-top: 8px; }
.revenue-input, .note-input {
  width: 100%; padding: 4px 6px;
  border: 1px solid var(--surface-border); border-radius: 4px;
  font-size: 12px; margin-bottom: 4px; background: var(--bg); color: var(--text);
}
.note-input { font-size: 11px; color: var(--text-muted); }
.add-btn {
  width: 100%; padding: 4px;
  background: var(--accent-light); border: 1px solid var(--accent);
  border-radius: 4px; color: var(--accent);
  font-size: 11px; font-weight: 600; cursor: pointer;
}
.add-btn:hover { background: var(--accent); color: white; }

/* Revenue chart */
.revenue-chart { margin-top: 24px; }
.chart-bars {
  display: flex; gap: 8px; align-items: flex-end;
  height: 140px; padding-bottom: 4px;
  border-bottom: 1px solid var(--surface-border);
}
.chart-col {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; height: 100%;
}
.bar-container { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.bar-fill {
  width: 100%; border-radius: 4px 4px 0 0;
  min-height: 2px; transition: height 0.3s ease;
  background: var(--accent);
}
.bar-label { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
.bar-amount { font-size: 10px; color: var(--text-secondary); font-weight: 600; }

/* Time clock table */
.timeclock-table { width: 100%; border-collapse: collapse; }
.timeclock-table th {
  font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted);
  padding: 8px 12px; text-align: left;
  border-bottom: 2px solid var(--surface-border); background: var(--surface-alt);
}
.timeclock-table td {
  padding: 12px; border-bottom: 1px solid var(--surface-border);
  font-size: 14px; vertical-align: middle;
}
.timeclock-table tr.expandable { cursor: pointer; }
.timeclock-table tr.expandable:hover td { background: var(--surface); }
.row-warning td { border-left: 3px solid #F59E0B; }
.clock-entries-row td { background: var(--surface-alt); padding: 12px 24px; }
.clock-entries-row.hidden { display: none; }
.clock-entry {
  display: flex; gap: 16px; align-items: center;
  padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--surface-border);
}
.text-warning { color: #D95F2B; font-weight: 600; }
.text-success { color: var(--success); font-weight: 600; }

/* Alert banner */
.alert-banner {
  border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
  display: flex; flex-direction: column; gap: 8px;
}
.alert-banner.orange { background: #FEF3C7; border: 1px solid #F59E0B; color: #92400E; }
:root.dark .alert-banner.orange { background: #3A2A10; color: #FCD34D; }
.alert-row { display: flex; align-items: center; gap: 8px; }
.alert-action {
  margin-left: auto; padding: 4px 12px;
  background: white; color: #92400E;
  border: 1px solid #F59E0B; border-radius: 6px;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.alert-action:hover { background: #FBF1B9; }

/* Event log */
.filter-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.filter-tab {
  padding: 6px 16px; border-radius: 20px;
  border: 1px solid var(--surface-border);
  background: var(--surface); font-size: 13px;
  cursor: pointer; color: var(--text-secondary);
}
.filter-tab.active { background: var(--accent); border-color: var(--accent); color: white; }
.event-card {
  display: flex; gap: 16px; align-items: flex-start;
  background: var(--surface); border: 1px solid var(--surface-border);
  border-radius: 10px; padding: 16px; margin-bottom: 12px;
}
.event-card.coverage  { border-left: 3px solid #D95F2B; }
.event-card.trade     { border-left: 3px solid #2D7D5A; }
.event-card.overtime  { border-left: 3px solid #F59E0B; }
.event-icon { font-size: 20px; flex-shrink: 0; }
.event-body { flex: 1; }
.event-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.event-meta { font-size: 13px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.event-time { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.badge.green  { background: var(--success-light); color: var(--success); }
.badge.red    { background: #FEE2E2; color: #991B1B; }
.badge.orange { background: #FEF3C7; color: #92400E; }
.badge.grey   { background: var(--surface-alt); color: var(--text-muted); }

/* Empty state */
.empty-state {
  text-align: center; padding: 48px 24px;
  background: var(--surface); border: 1px solid var(--surface-border);
  border-radius: 12px; color: var(--text-secondary);
}
.empty-state .empty-icon { font-size: 40px; margin-bottom: 8px; }
.empty-state h3 { margin-bottom: 4px; color: var(--text); }

/* Settings */
.settings-section {
  background: var(--surface); border: 1px solid var(--surface-border);
  border-radius: 10px; padding: 20px; margin-bottom: 16px;
}
.settings-section-title {
  font-size: 13px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--text-muted); margin-bottom: 16px;
  padding-bottom: 12px; border-bottom: 1px solid var(--surface-border);
}
.setting-row {
  display: flex; justify-content: space-between;
  align-items: center; padding: 12px 0;
  border-bottom: 1px solid var(--surface-alt); gap: 16px;
}
.setting-row:last-child { border-bottom: none; }
.setting-label { font-size: 14px; font-weight: 500; color: var(--text); }
.setting-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.setting-input {
  padding: 6px 10px; border: 1px solid var(--surface-border);
  border-radius: 6px; font-size: 14px; width: 180px;
  background: var(--bg); color: var(--text);
}
.setting-save-btn {
  margin-top: 12px; padding: 8px 20px;
  background: var(--accent); color: white;
  border: none; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.setting-save-btn:hover { background: var(--accent-hover); }
.toggle {
  width: 44px; height: 24px;
  background: var(--surface-border); border-radius: 12px;
  position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0;
}
.toggle.on { background: var(--success); }
.toggle::after {
  content: ''; width: 18px; height: 18px;
  background: white; border-radius: 9px;
  position: absolute; top: 3px; left: 3px; transition: left 0.2s;
}
.toggle.on::after { left: 23px; }

/* Responsive revenue grid */
@media (max-width: 900px) {
  .revenue-grid { grid-template-columns: repeat(4, 1fr); }
  .revenue-day:nth-child(5) { grid-column: 1 / 3; }
  .revenue-day:nth-child(6) { grid-column: 3 / 5; }
  .revenue-day:nth-child(7) { grid-column: 1 / 5; }
}
@media (max-width: 600px) {
  .revenue-grid { grid-template-columns: 1fr 1fr; }
  .revenue-day:nth-child(7) { grid-column: 1 / -1; }
}
```

### Step 3 — Add Event Log sidebar nav item

Find the sidebar nav block and add a new `<a class="nav-item" ...>` for Event Log between Time Clock and Settings (approximately between the timeclock and settings nav entries):

```html
<a class="nav-item" data-page="eventlog" onclick="navigateTo('eventlog')">
  <svg class="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="16" y1="2" x2="16" y2="6"></line>
    <line x1="8" y1="2" x2="8" y2="6"></line>
    <line x1="3" y1="10" x2="21" y2="10"></line>
  </svg>
  <span class="nav-item-label">Event Log</span>
</a>
```

### Step 4 — Add `eventlog: 'Event Log'` to `PAGE_TITLES`

In the JS block, find `const PAGE_TITLES = { ... }` and add the entry.

### Step 5 — Add `case 'eventlog'` to `loadPage(page)`

Find `loadPage(page)` switch; add:

```js
case 'eventlog': return loadEventLogPage()
```

### Step 6 — Wire generate button with warning banner

Find the existing `generateSchedule()` (or `window.generateSchedule`) handler in the schedule page. Replace it with:

```js
async function generateSchedule() {
  const btn = document.getElementById('generate-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…' }
  try {
    const result = await api('/api/schedule/generate', 'POST', { weekStart: currentScheduleWeek })

    const noAvail = (result.warnings || []).find(w => w.type === 'no_availability')
    if (noAvail) {
      // Prepend warning banner (dedupe: remove any existing banner first)
      const container = document.querySelector('#page-content .card, #page-content')
      const existing = container?.querySelector('.warning-banner')
      if (existing) existing.remove()
      const banner = document.createElement('div')
      banner.className = 'warning-banner'
      banner.innerHTML = `<span>⚠️</span><span>${escapeHtml(noAvail.message)}</span><button onclick="this.parentElement.remove()" aria-label="Dismiss">✕</button>`
      container?.prepend(banner)
    }

    await loadScheduleData(currentScheduleWeek)
    showToast(noAvail ? 'Schedule generated (role-based fallback)' : 'Schedule generated', noAvail ? 'warning' : 'success')
  } catch (err) {
    showToast(err.message || 'Failed to generate schedule', 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate Schedule' }
  }
}
```

### Step 7 — Replace `loadPayrollPage` and `renderPayrollPage`

Keep the existing payroll table (staff × hours × pay). REPLACE the revenue section with the daily grid + chart.

New `loadPayrollPage()`:

```js
async function loadPayrollPage() {
  setContent(renderPayrollSkeleton())
  try {
    // currentPayrollWeek already tracks which week is viewed
    const [payroll, settings, tips, revenue] = await Promise.all([
      api(`/api/payroll?weekStart=${currentPayrollWeek}`),
      api('/api/settings'),
      api(`/api/tips?weeks=4`),
      api(`/api/revenue/daily?weekStart=${currentPayrollWeek}`),
    ])
    setContent(renderPayrollPage(payroll, settings, tips, revenue))
  } catch (err) {
    setContent(renderError("loadPage('payroll')"))
    showToast(err.message || 'Failed to load payroll', 'error')
  }
}
```

New `renderPayrollPage(payroll, settings, tips, revenue)` — preserve the existing payroll table, week nav, tips section. Replace the revenue input section with:

```js
function renderRevenueSection(revenue) {
  const days = revenue.days || {}
  const dayOrder = Object.keys(days).sort()
  const maxAmount = Math.max(...dayOrder.map(d => Number(days[d].total)), 1)

  const dayLabel = dateStr => {
    const d = new Date(`${dateStr}T12:00:00`)
    return d.toLocaleDateString('en-US', { weekday: 'short' })
  }
  const dayDate = dateStr => {
    const d = new Date(`${dateStr}T12:00:00`)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const grid = dayOrder.map(date => {
    const day = days[date]
    const entries = (day.entries || []).map(e => `
      <div class="revenue-entry">
        <span class="entry-amount">$${Number(e.amount).toFixed(2)}</span>
        <span class="entry-note">${escapeHtml(e.note || '')}</span>
        <button class="entry-delete" onclick="deleteDailyRevenue(${e.id})" aria-label="Delete">✕</button>
      </div>
    `).join('')
    return `
      <div class="revenue-day">
        <div class="day-label">${dayLabel(date)}</div>
        <div class="day-date">${dayDate(date)}</div>
        <div class="day-total">$${Number(day.total).toFixed(2)}</div>
        <div class="day-entries">${entries || '<div style="font-size:11px;color:var(--text-muted)">No entries yet</div>'}</div>
        <div class="add-entry">
          <input type="number" class="revenue-input" placeholder="0.00" min="0" step="0.01" id="rev-${date}">
          <input type="text" class="note-input" placeholder="note (optional)" id="note-${date}" maxlength="80">
          <button class="add-btn" onclick="addDailyRevenue('${date}')">+ Add</button>
        </div>
      </div>
    `
  }).join('')

  const bars = dayOrder.map(date => {
    const amount = Number(days[date].total)
    const pct = (amount / maxAmount) * 100
    return `
      <div class="chart-col">
        <div class="bar-container">
          <div class="bar-fill" style="height:${pct}%" title="$${amount.toFixed(2)}"></div>
        </div>
        <div class="bar-label">${dayLabel(date)}</div>
        <div class="bar-amount">$${amount.toFixed(0)}</div>
      </div>
    `
  }).join('')

  return `
    <div class="revenue-section">
      <div class="revenue-header">
        <h3>Daily Revenue</h3>
        <div class="week-total">Week Total: <strong>$${Number(revenue.weekTotal || 0).toFixed(2)}</strong></div>
      </div>
      <div class="revenue-grid">${grid}</div>
      <div class="revenue-chart"><div class="chart-bars">${bars}</div></div>
    </div>
  `
}

async function addDailyRevenue(date) {
  const amtEl = document.getElementById(`rev-${date}`)
  const noteEl = document.getElementById(`note-${date}`)
  const amount = parseFloat(amtEl.value)
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('Enter an amount greater than zero', 'warning')
    return
  }
  try {
    await api('/api/revenue/daily', 'POST', { date, amount, note: noteEl.value || undefined })
    await loadPayrollPage()
    showToast('Revenue added')
  } catch (err) {
    showToast(err.message || 'Failed to save', 'error')
  }
}

async function deleteDailyRevenue(id) {
  showModal('Delete revenue entry?', `<p>This can't be undone.</p>`, async () => {
    try {
      await api(`/api/revenue/daily/${id}`, 'DELETE')
      await loadPayrollPage()
      showToast('Entry removed')
    } catch (err) {
      showToast(err.message || 'Failed to delete', 'error')
    }
  }, 'Delete')
}
```

Also enforce the "can't go past current week on payroll" constraint. In the next-button handler for payroll:

```js
function changePayrollWeek(deltaDays) {
  const newWeek = shiftDate(currentPayrollWeek, deltaDays)
  const thisWeek = mondayOfToday()  // "YYYY-MM-DD" of this week's Monday
  if (deltaDays > 0 && newWeek > thisWeek) return  // no navigating past current week
  currentPayrollWeek = newWeek
  loadPayrollPage()
}
```

Where `mondayOfToday()` computes current week's Monday (reuse existing helpers if present).

### Step 8 — Replace `loadTimeClockPage` and `renderTimeClockPage`

```js
async function loadTimeClockPage() {
  setContent(renderTimeClockSkeleton())
  try {
    const data = await api(`/api/timeclock/weekly?weekStart=${currentScheduleWeek}`)
    setContent(renderTimeClockPage(data))
  } catch (err) {
    setContent(renderError("loadPage('timeclock')"))
    showToast(err.message || 'Failed to load time clock', 'error')
  }
}

function renderTimeClockPage(data) {
  const rows = data.rows || []
  const missedRows = rows.filter(r => r.missedClockOuts > 0)

  const alert = missedRows.length > 0 ? `
    <div class="alert-banner orange">
      <div class="alert-row"><strong>⚠️ ${missedRows.length} possible missed clock-out${missedRows.length === 1 ? '' : 's'}</strong></div>
      ${missedRows.map(r => `
        <div class="alert-row">
          <span>${escapeHtml(r.staffName)} — ${r.missedClockOuts} open entr${r.missedClockOuts === 1 ? 'y' : 'ies'}</span>
          <button class="alert-action" onclick="clockOutNow(${r.staffId})">Clock out now</button>
        </div>
      `).join('')}
    </div>
  ` : ''

  const statusBadge = r => {
    if (r.missedClockOuts > 0) return '<span class="badge red">Missing clock-out</span>'
    if (r.variance > 4) return '<span class="badge orange">Possible overtime</span>'
    if (r.variance < -4) return '<span class="badge grey">Under scheduled</span>'
    return '<span class="badge green">Normal</span>'
  }

  const rowClass = r => r.missedClockOuts > 0 ? 'row-warning' : ''
  const varianceClass = r => r.variance > 0 ? 'text-success' : (r.variance < -2 ? 'text-warning' : '')

  const rowsHtml = rows.map(r => `
    <tr class="expandable ${rowClass(r)}" onclick="document.getElementById('entries-${r.staffId}').classList.toggle('hidden')">
      <td>${escapeHtml(r.staffName)}</td>
      <td>${escapeHtml(r.role || '')}</td>
      <td>${r.shiftsScheduled}</td>
      <td>${r.hoursScheduled.toFixed(1)}h</td>
      <td>${r.hoursClocked.toFixed(1)}h</td>
      <td class="${varianceClass(r)}">${r.variance >= 0 ? '+' : ''}${r.variance.toFixed(1)}h</td>
      <td>${statusBadge(r)}</td>
    </tr>
    <tr class="clock-entries-row hidden" id="entries-${r.staffId}">
      <td colspan="7">
        ${(r.entries || []).map(e => `
          <div class="clock-entry">
            <span>${new Date(e.clockIn).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span>In: ${new Date(e.clockIn).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
            <span>Out: ${e.clockOut ? new Date(e.clockOut).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '⚠️ Missing'}</span>
            <span>${e.hours.toFixed(1)}h</span>
            ${!e.clockOut ? `<button class="alert-action" onclick="event.stopPropagation(); clockOutEntry(${r.staffId})">Clock Out</button>` : ''}
          </div>
        `).join('') || '<div style="color:var(--text-muted);font-size:12px">No clock entries this week</div>'}
        <button class="alert-action" style="margin-top:8px" onclick="event.stopPropagation(); addManualEntry(${r.staffId}, '${escapeJs(r.staffName)}')">+ Add Manual Entry</button>
      </td>
    </tr>
  `).join('')

  return `
    <div class="card">
      <div class="card-header">
        <h2>Time Clock — Week of ${formatWeekRange(data.weekStart)}</h2>
        <div>
          <button class="btn-ghost" onclick="changeScheduleWeek(-7)">‹ Prev</button>
          <button class="btn-ghost" onclick="changeScheduleWeek(7)">Next ›</button>
        </div>
      </div>
      ${alert}
      <table class="timeclock-table">
        <thead>
          <tr>
            <th>Staff</th><th>Role</th><th>Shifts</th>
            <th>Scheduled</th><th>Clocked</th><th>Variance</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">No staff this week</td></tr>'}</tbody>
      </table>
    </div>
  `
}

async function clockOutNow(staffId) {
  try {
    await api('/api/timeclock/override', 'POST', { staffId, action: 'clock_out' })
    await loadTimeClockPage()
    showToast('Clocked out')
  } catch (err) {
    showToast(err.message || 'Failed', 'error')
  }
}

async function clockOutEntry(staffId) {
  // Same call — server closes the latest open entry for this staff
  return clockOutNow(staffId)
}

function addManualEntry(staffId, staffName) {
  const todayStr = new Date().toISOString().split('T')[0]
  showModal(`Add clock entry — ${escapeHtml(staffName)}`, `
    <div class="form-group">
      <label>Date</label>
      <input type="date" id="manual-date" value="${todayStr}">
    </div>
    <div class="form-group">
      <label>Clock In</label>
      <input type="time" id="manual-in">
    </div>
    <div class="form-group">
      <label>Clock Out (optional)</label>
      <input type="time" id="manual-out">
    </div>
  `, async () => {
    const date = document.getElementById('manual-date').value
    const clockIn = document.getElementById('manual-in').value
    const clockOut = document.getElementById('manual-out').value
    if (!date || !clockIn) { showToast('Date and Clock In are required', 'warning'); return }
    try {
      await api('/api/timeclock/override', 'POST', {
        staffId, action: 'clock_in', date, time: clockIn, clockOut: clockOut || undefined,
      })
      await loadTimeClockPage()
      showToast('Entry added')
    } catch (err) {
      showToast(err.message || 'Failed', 'error')
    }
  }, 'Add')
}
```

### Step 9 — Add new `loadEventLogPage` and `renderEventLogPage`

```js
let currentEventFilter = 'all'  // 'all' | 'coverage' | 'trade' | 'overtime'
let cachedEvents = []

async function loadEventLogPage() {
  setContent(renderEventLogSkeleton())
  try {
    const data = await api(`/api/events?weekStart=${currentScheduleWeek}`)
    cachedEvents = data.events || []
    setContent(renderEventLogPage(data))
  } catch (err) {
    setContent(renderError("loadPage('eventlog')"))
    showToast(err.message || 'Failed to load events', 'error')
  }
}

function renderEventLogPage(data) {
  const events = cachedEvents
  const filtered = currentEventFilter === 'all' ? events : events.filter(e => e.eventType === currentEventFilter)

  const tabs = ['all', 'coverage', 'trade', 'overtime']
    .map(t => `<button class="filter-tab ${t === currentEventFilter ? 'active' : ''}" onclick="filterEvents('${t}')">${t[0].toUpperCase()}${t.slice(1)}</button>`)
    .join('')

  const cards = filtered.length === 0 ? `
    <div class="empty-state">
      <div class="empty-icon">📋</div>
      <h3>No events this week</h3>
      <p>Coverage requests, trades, and overtime events will appear here.</p>
    </div>
  ` : filtered.map(renderEventCard).join('')

  return `
    <div class="card">
      <div class="card-header">
        <h2>Event Log — Week of ${formatWeekRange(data.weekStart)}</h2>
        <div>
          <button class="btn-ghost" onclick="changeScheduleWeek(-7)">‹ Prev</button>
          <button class="btn-ghost" onclick="changeScheduleWeek(7)">Next ›</button>
        </div>
      </div>
      <div class="filter-tabs">${tabs}</div>
      ${cards}
    </div>
  `
}

function renderEventCard(e) {
  const when = new Date(e.timestamp).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
  if (e.eventType === 'coverage') {
    const badge = e.meta.status === 'covered'
      ? `<span class="badge green">Filled${e.meta.fillMinutes != null ? ` in ${e.meta.fillMinutes} min` : ''}</span>`
      : e.meta.status === 'cancelled' ? '<span class="badge grey">Cancelled</span>' : '<span class="badge red">Unfilled</span>'
    const meta = e.meta.status === 'covered' ? `Covered by ${escapeHtml(e.meta.coveredBy || 'someone')}` : ''
    return `
      <div class="event-card coverage">
        <div class="event-icon">📢</div>
        <div class="event-body">
          <div class="event-title">${escapeHtml(e.title)}</div>
          <div class="event-meta">${meta} ${badge}</div>
          <div class="event-time">${when}</div>
        </div>
      </div>`
  }
  if (e.eventType === 'trade') {
    const badge = e.meta.status === 'completed' ? '<span class="badge green">Completed</span>'
               : e.meta.status === 'cancelled' ? '<span class="badge grey">Cancelled</span>'
               : '<span class="badge orange">Open</span>'
    const arrow = e.meta.to ? ` → ${escapeHtml(e.meta.to)}` : ''
    return `
      <div class="event-card trade">
        <div class="event-icon">🔄</div>
        <div class="event-body">
          <div class="event-title">${escapeHtml(e.title)}</div>
          <div class="event-meta">${escapeHtml(e.meta.from || '')}${arrow} ${badge}</div>
          <div class="event-time">${when}</div>
        </div>
      </div>`
  }
  // overtime
  return `
    <div class="event-card overtime">
      <div class="event-icon">⚡</div>
      <div class="event-body">
        <div class="event-title">${escapeHtml(e.title)}</div>
        <div class="event-meta">${e.meta.totalHours.toFixed(1)}hrs total — ${e.meta.overtimeHours.toFixed(1)}hrs overtime ($${e.meta.grossPay.toFixed(2)})</div>
        <div class="event-time">Week of ${e.timestamp.slice(0,10)}</div>
      </div>
    </div>`
}

function filterEvents(type) {
  currentEventFilter = type
  setContent(renderEventLogPage({ weekStart: currentScheduleWeek }))
}

function renderEventLogSkeleton() {
  return `
    <div class="card">
      <div class="card-header"><div class="skeleton skeleton-line" style="width:200px"></div></div>
      <div class="filter-tabs">
        <div class="skeleton" style="width:60px;height:28px;border-radius:20px"></div>
        <div class="skeleton" style="width:80px;height:28px;border-radius:20px"></div>
        <div class="skeleton" style="width:70px;height:28px;border-radius:20px"></div>
        <div class="skeleton" style="width:90px;height:28px;border-radius:20px"></div>
      </div>
      ${[1,2,3].map(() => `<div class="skeleton" style="height:70px;border-radius:10px;margin-bottom:12px"></div>`).join('')}
    </div>
  `
}
```

### Step 10 — Rebuild Settings page (8 sections + dark mode toggle)

```js
async function loadSettingsPage() {
  setContent(renderSettingsSkeleton())
  try {
    const config = await api('/api/settings/full')
    setContent(renderSettingsPage(config))
    // Restore dark-mode toggle state
    const darkOn = document.documentElement.classList.contains('dark')
    document.getElementById('dark-toggle')?.classList.toggle('on', darkOn)
  } catch (err) {
    setContent(renderError("loadPage('settings')"))
    showToast(err.message || 'Failed to load settings', 'error')
  }
}

function renderSettingsPage(c) {
  return `
    ${renderAppearanceSection()}
    ${renderRestaurantSection(c.restaurant)}
    ${renderRatesSection(c.rates)}
    ${renderOvertimeSection(c.overtime)}
    ${renderTipsSection(c.tips)}
    ${renderBudgetSection(c.budget)}
    ${renderShiftsSection(c.shifts)}
    ${renderRulesSection(c.rules, c.staff)}
  `
}

function renderAppearanceSection() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Appearance</div>
      <div class="setting-row">
        <div>
          <div class="setting-label">Dark Mode</div>
          <div class="setting-desc">Switch to dark theme</div>
        </div>
        <div class="toggle" id="dark-toggle" onclick="toggleDarkMode()"></div>
      </div>
    </div>
  `
}

function renderRestaurantSection(r) {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Restaurant</div>
      <div class="setting-row">
        <div class="setting-label">Name</div>
        <input class="setting-input" id="rest-name" value="${escapeHtml(r?.name || '')}">
      </div>
      <button class="setting-save-btn" onclick="saveRestaurant()">Save</button>
    </div>
  `
}

async function saveRestaurant() {
  const name = document.getElementById('rest-name').value.trim()
  if (!name) { showToast('Name cannot be empty', 'warning'); return }
  try {
    await api('/api/settings/full', 'PATCH', { restaurant: { name } })
    showToast('Restaurant saved')
  } catch (err) { showToast(err.message || 'Failed', 'error') }
}

function renderRatesSection(rates) {
  const rows = (rates || []).map(r => `
    <div class="setting-row">
      <div class="setting-label">${escapeHtml(r.roleName)}</div>
      <div>
        <input class="setting-input" type="number" step="0.01" min="0" max="500"
          value="${r.hourlyRate}" id="rate-${escapeJs(r.roleName)}" style="width:100px">
        <button class="setting-save-btn" onclick="saveRate('${escapeJs(r.roleName)}')" style="margin-top:0;padding:6px 14px">Save</button>
      </div>
    </div>
  `).join('')
  return `
    <div class="settings-section">
      <div class="settings-section-title">Pay Rates</div>
      ${rows || '<div class="setting-desc">No rates configured yet.</div>'}
      <button class="setting-save-btn" onclick="addRate()" style="margin-top:12px;background:var(--accent-light);color:var(--accent);border:1px solid var(--accent)">+ Add Rate</button>
    </div>
  `
}

async function saveRate(roleName) {
  const rate = parseFloat(document.getElementById(`rate-${roleName}`).value)
  if (!Number.isFinite(rate) || rate < 0) { showToast('Invalid rate', 'warning'); return }
  try {
    await api('/api/rates', 'POST', { roleName, hourlyRate: rate })
    showToast(`${roleName} saved`)
  } catch (err) { showToast(err.message || 'Failed', 'error') }
}

function addRate() {
  showModal('Add a role rate', `
    <div class="form-group"><label>Role name</label><input id="new-role" placeholder="Server" maxlength="40"></div>
    <div class="form-group"><label>Hourly rate</label><input id="new-rate" type="number" min="0" max="500" step="0.01" placeholder="15.50"></div>
  `, async () => {
    const roleName = document.getElementById('new-role').value.trim()
    const rate = parseFloat(document.getElementById('new-rate').value)
    if (!roleName || !Number.isFinite(rate) || rate < 0) { showToast('Invalid input', 'warning'); return }
    await api('/api/rates', 'POST', { roleName, hourlyRate: rate })
    await loadSettingsPage()
    showToast('Rate added')
  }, 'Add')
}

function renderOvertimeSection(o) {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Overtime</div>
      <div class="setting-row">
        <div class="setting-label">Weekly overtime enabled</div>
        <div class="toggle ${o.overtime_enabled ? 'on' : ''}" id="ot-weekly-toggle" onclick="this.classList.toggle('on')"></div>
      </div>
      <div class="setting-row">
        <div class="setting-label">Weekly threshold (hours)</div>
        <input class="setting-input" type="number" min="1" max="80" step="0.5" id="ot-weekly-threshold" value="${o.weekly_threshold}">
      </div>
      <div class="setting-row">
        <div class="setting-label">Weekly multiplier</div>
        <input class="setting-input" type="number" min="1" max="3" step="0.05" id="ot-weekly-mult" value="${o.weekly_multiplier}">
      </div>
      <div class="setting-row">
        <div class="setting-label">Daily overtime enabled</div>
        <div class="toggle ${o.daily_overtime_enabled ? 'on' : ''}" id="ot-daily-toggle" onclick="this.classList.toggle('on')"></div>
      </div>
      <div class="setting-row">
        <div class="setting-label">Daily threshold (hours)</div>
        <input class="setting-input" type="number" min="1" max="24" step="0.5" id="ot-daily-threshold" value="${o.daily_threshold}">
      </div>
      <div class="setting-row">
        <div class="setting-label">Daily multiplier</div>
        <input class="setting-input" type="number" min="1" max="3" step="0.05" id="ot-daily-mult" value="${o.daily_multiplier}">
      </div>
      <button class="setting-save-btn" onclick="saveOvertime()">Save Overtime</button>
    </div>
  `
}

async function saveOvertime() {
  const body = { overtime: {
    overtime_enabled: document.getElementById('ot-weekly-toggle').classList.contains('on'),
    weekly_threshold: Number(document.getElementById('ot-weekly-threshold').value),
    weekly_multiplier: Number(document.getElementById('ot-weekly-mult').value),
    daily_overtime_enabled: document.getElementById('ot-daily-toggle').classList.contains('on'),
    daily_threshold: Number(document.getElementById('ot-daily-threshold').value),
    daily_multiplier: Number(document.getElementById('ot-daily-mult').value),
  } }
  try { await api('/api/settings/full', 'PATCH', body); showToast('Overtime saved') }
  catch (err) { showToast(err.message || 'Failed', 'error') }
}

function renderTipsSection(t) {
  const radio = (name, value, label, current) => `
    <label style="display:flex;align-items:center;gap:6px;margin-right:12px;cursor:pointer">
      <input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}> ${label}
    </label>`
  return `
    <div class="settings-section">
      <div class="settings-section-title">Tips</div>
      <div class="setting-row">
        <div class="setting-label">Mode</div>
        <div style="display:flex;flex-wrap:wrap">
          ${radio('tip-mode', 'pool', 'Pool', t.mode)}
          ${radio('tip-mode', 'individual', 'Individual', t.mode)}
          ${radio('tip-mode', 'cash', 'Cash', t.mode)}
        </div>
      </div>
      <div class="setting-row" id="tip-split-row" style="${t.mode === 'pool' ? '' : 'display:none'}">
        <div class="setting-label">Split method</div>
        <div style="display:flex;flex-wrap:wrap">
          ${radio('tip-split', 'hours', 'Hours worked', t.splitMethod)}
          ${radio('tip-split', 'equal', 'Equal split', t.splitMethod)}
          ${radio('tip-split', 'points', 'Role points', t.splitMethod)}
        </div>
      </div>
      <div class="setting-row">
        <div>
          <div class="setting-label">Include BOH in tip pool</div>
          <div class="setting-desc">Off = back-of-house excluded from distribution</div>
        </div>
        <div class="toggle ${t.bohIncluded ? 'on' : ''}" id="tip-boh-toggle" onclick="this.classList.toggle('on')"></div>
      </div>
      <button class="setting-save-btn" onclick="saveTips()">Save Tips</button>
    </div>
  `
}

async function saveTips() {
  const mode = document.querySelector('input[name="tip-mode"]:checked')?.value || 'pool'
  const splitMethod = document.querySelector('input[name="tip-split"]:checked')?.value || 'hours'
  const bohIncluded = document.getElementById('tip-boh-toggle').classList.contains('on')
  try {
    await api('/api/settings/full', 'PATCH', { tips: { mode, splitMethod, bohIncluded } })
    showToast('Tips saved')
  } catch (err) { showToast(err.message || 'Failed', 'error') }
}

function renderBudgetSection(b) {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Weekly Budget</div>
      <div class="setting-row">
        <div class="setting-label">Target labor budget ($/week)</div>
        <input class="setting-input" type="number" min="0" step="10" id="budget-amount" value="${b.weeklyBudget ?? ''}">
      </div>
      <button class="setting-save-btn" onclick="saveBudget()">Save Budget</button>
    </div>
  `
}

async function saveBudget() {
  const v = parseFloat(document.getElementById('budget-amount').value)
  if (!Number.isFinite(v) || v < 0) { showToast('Enter a valid amount', 'warning'); return }
  try {
    await api('/api/settings/full', 'PATCH', { budget: { weeklyBudget: v } })
    showToast('Budget saved')
  } catch (err) { showToast(err.message || 'Failed', 'error') }
}

function renderShiftsSection(shifts) {
  const rows = (shifts || []).map(s => `
    <div class="setting-row">
      <div>
        <div class="setting-label">${escapeHtml(s.name)}</div>
        <div class="setting-desc">${escapeHtml(s.dayOfWeek)} · ${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</div>
      </div>
      <div>
        <button class="setting-save-btn" onclick="editShift(${s.id})" style="margin-top:0;padding:6px 14px">Edit</button>
        <button class="setting-save-btn" onclick="deleteShift(${s.id})" style="margin-top:0;padding:6px 14px;background:#C0392B">Delete</button>
      </div>
    </div>
  `).join('')
  return `
    <div class="settings-section">
      <div class="settings-section-title">Shifts</div>
      ${rows || '<div class="setting-desc">No shifts configured.</div>'}
      <button class="setting-save-btn" onclick="addShift()" style="margin-top:12px">+ Add Shift</button>
    </div>
  `
}

// editShift / deleteShift / addShift — reuse existing helpers from the current
// Settings page (they already call /api/shifts). Just keep them intact or inline them.

function renderRulesSection(rules, staff) {
  const items = (rules || []).map(r => `
    <div class="setting-row">
      <div>
        <div class="setting-label">${escapeHtml(r.constraint_text || '')}</div>
        <div class="setting-desc">${escapeHtml(r.type || '')}</div>
      </div>
      <button class="setting-save-btn" onclick="deleteRule(${r.id})" style="margin-top:0;padding:6px 14px;background:#C0392B">Delete</button>
    </div>
  `).join('')
  return `
    <div class="settings-section">
      <div class="settings-section-title">Business Rules</div>
      ${items || '<div class="setting-desc">No rules configured.</div>'}
      <button class="setting-save-btn" onclick="addRule()" style="margin-top:12px">+ Add Rule</button>
    </div>
  `
}
// addRule / deleteRule — reuse existing.

function toggleDarkMode() {
  const on = !document.documentElement.classList.contains('dark')
  document.documentElement.classList.toggle('dark', on)
  localStorage.setItem('darkMode', on ? 'true' : 'false')
  document.getElementById('dark-toggle')?.classList.toggle('on', on)
}

function renderSettingsSkeleton() {
  return [1,2,3,4,5,6,7,8].map(() => `
    <div class="skeleton" style="height:100px;border-radius:10px;margin-bottom:16px"></div>
  `).join('')
}
```

### Step 11 — Initialize dark mode on page load

At the end of the existing `<script>` block, inside the init function (or DOMContentLoaded handler), add:

```js
if (localStorage.getItem('darkMode') === 'true') {
  document.documentElement.classList.add('dark')
}
```

### Step 12 — Verify

```bash
python3 -c "
from html.parser import HTMLParser
class Check(HTMLParser):
  def __init__(self):
    super().__init__()
    self.errors = []
  def error(self, msg): self.errors.append(msg)
p = Check()
p.feed(open('public/dashboard.html').read())
print('HTML parsed OK' if not p.errors else p.errors)
"
```

Start server and smoke-test:

```bash
pkill -f "src/index.js" 2>/dev/null; sleep 2
node src/index.js > /tmp/relay-smoke.log 2>&1 &
sleep 4
curl -s -o /dev/null -w '%{http_code}\n' localhost:10000/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:10000/api/revenue/daily  # 401
curl -s -o /dev/null -w '%{http_code}\n' localhost:10000/api/events          # 401
curl -s -o /dev/null -w '%{http_code}\n' localhost:10000/api/settings/full   # 401
curl -s -o /dev/null -w '%{http_code}\n' localhost:10000/api/timeclock/weekly  # 401
pkill -f "src/index.js"
```

All should be 401 (auth required), proving the routes exist and middleware gates them.

### Step 13 — Commit

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): daily revenue grid, weekly timeclock, event log, settings rebuild, dark mode"
```

---

## Task 7: defense-in-depth review + final commit + SQL print

### Step 1 — defense-in-depth checklist

Before marking done, verify:

- [ ] Every new route begins with `const groupId = req.manager.groupId` (never trusts body-provided groupId).
- [ ] `DELETE /api/revenue/daily/:id` double-checks `group_id = req.manager.groupId` before deleting — PREVENTS cross-tenant access.
- [ ] `POST /api/revenue/daily` validates `amount > 0` and `date` format.
- [ ] `POST /api/rates` bounds rate `0 ≤ x ≤ 500`.
- [ ] `clearGroupSetupData` has NO code path that touches `payroll_records`, `time_entries`, `coverage_requests`, `manager_log_entries`, `tip_records`, `staff_reliability_events`, `weekly_revenue`, `daily_revenue`.
- [ ] `clearGroupSetupData` is only called when `existing?.setup_complete === true`.
- [ ] Schedule generate with no availability returns a populated `warnings` array, does not crash.
- [ ] Frontend: `addDailyRevenue` enforces `amount > 0`; `deleteDailyRevenue` uses showModal confirm.
- [ ] Dark mode: localStorage only; no server state.
- [ ] Settings PATCH: each subsection independently try/catch — one failure doesn't block others (verified in the code).
- [ ] Payroll week nav cannot go past current week (client-side guard in `changePayrollWeek`).

### Step 2 — Simplify pass

Run `node --check` on all touched files one more time. Look for dead code or duplicated helpers. Specifically:
- If `addDays` or `mondayOf` are defined twice in dashRoutes.js (Tasks 4 and 5), keep only one.
- Confirm no `var` is left from the schedule fallback (use `let`).

### Step 3 — Print SQL to run in Supabase

```
═════════════ RUN IN SUPABASE SQL EDITOR ═════════════
CREATE TABLE IF NOT EXISTS daily_revenue (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  entry_date DATE NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_revenue_group_date
  ON daily_revenue(group_id, entry_date);
═════════════════════════════════════════════════════
```

---

## Known gotchas for the implementer

1. **Double-mounted routes**: `webServer.js` mounts `dashRoutes` at both `/api` and `/api/dashboard`. Adding a route in `dashRoutes.js` exposes it on both paths — choose the bare `/api/*` for new routes in dashboard calls.
2. **`api()` throws** on non-ok — every dashboard caller must try/catch. All render functions above do.
3. **`escapeJs`** is needed inside `onclick="…"` attributes that embed dynamic strings; `escapeHtml` for body text.
4. **Sidebar nav styles use `.nav-item-label`** (verified from the existing markup). Use the exact class names.
5. **Schedule generate warning banner**: the selector `#page-content .card` may not exist if the schedule page uses different markup — fall back to `#page-content` itself.
6. **Availability fallback for null-userId staff**: the fallback flag short-circuits `isAvailable()` to `true` for all, so null-userId staff also become candidates. This is intentional.
7. **Re-setup** clears staff and cascading rows. If the user re-runs `/setup` after data is already populated, business rules, morale events, etc. tied to old staff IDs WILL be lost. This matches the semantic of "clean re-setup". Preserve historical financial tables explicitly.
