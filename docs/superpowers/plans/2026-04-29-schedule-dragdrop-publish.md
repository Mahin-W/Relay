# Schedule drag/drop + publish-state + planned-labor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTML5 drag-and-drop schedule editing with undo, persist publish state in `generated_schedules` (the always-missing write), surface planned labor cost on Payroll, lock destructive actions to current week, swap the duplicate Payroll icon, and add Copy-Last-Week + Regenerate guard + OT badges + status banner.

**Architecture:** All backend changes go in `src/server/dashRoutes.js` using existing `supabase()` accessor (NOT `req.app.locals.db` — user spec wrong). All frontend changes go in `public/dashboard.html`. The frontend resolves `shift_id` for pills via a separate `/api/shifts` lookup keyed by `(day_of_week, shiftName)`, so we don't need to modify the existing schedule data shape. Drag/drop supports SWAP only (same day, different staff); the `/schedule/move` route ships per spec but is unused by the v1 frontend (avoids ambiguous "which shift on the target day" problem). Publish-state write uses select-then-update-or-insert (no upsert) because `generated_schedules` has no unique constraint on `(group_id, week_start)` — SQL migration printed at end.

**Tech Stack:** Native HTML5 drag/drop (no libraries), Express + Supabase JS, vanilla JS in dashboard.html.

---

## Critical findings the engineer needs to know

1. `generated_schedules.published_at` and `.approved_at` columns ALREADY EXIST. We just need to write them.
2. There is NO unique constraint on `generated_schedules(group_id, week_start)`. `.upsert({...}, { onConflict: 'group_id,week_start' })` will throw. Use select→update-or-insert.
3. All routes use `const db = supabase()`. NEVER use `req.app.locals.db` (only `req.app.locals.bot` is real).
4. `role_rates` columns are `role_name` and `hourly_rate` (NOT `role` and `rate`). `staff.role` joins to `role_rates.role_name`.
5. `getCurrentWeekStart()`, `safeWeekParam()`, `parseShiftHours()`, `mondayOf()`, `addDays()` already defined in dashRoutes.js. Don't redefine.
6. `--danger`, `--warning`, `--danger-dim`, `--warning-dim` legacy aliases DO NOT EXIST. Use `--color-danger`, `--color-warning`, etc.
7. `.btn-danger` is a color-only modifier; pair with `.btn-small` for sizing. `.btn` (bare) doesn't exist.
8. `.modal-backdrop` is an ID, not a class. The existing showModal uses `id="modal-backdrop"`. New showConfirmModal must use the same id (single-instance) or add a `.modal-backdrop` class rule.
9. `renderScheduleTable(schedule, compact)` is shared between Overview (`compact=true`) and Schedule (`compact=false`). Drag/drop attributes ONLY when `!compact && isCurrentWeek`.
10. The frontend `loadSchedulePage` doesn't exist; the schedule loads inline at lines 1962-1970 (`case 'schedule'`). We'll create one.
11. The current schedule data shape (`{shiftName, startTime, endTime}` per shift entry) lacks `shift_id`. We resolve it client-side via `/api/shifts` + `(day_of_week, shiftName) → shift_id` map.

## Anchor reference (post-prior-edits, file lengths and key line numbers)

`public/dashboard.html` = **3512 lines**.

- `.shift-pill` CSS: **435–448**
- `.schedule-table` CSS: **389–422**
- `:root` color tokens: **30–91**
- `#modal-backdrop`/`.modal-card`/etc CSS: **793–882**
- `.toast` CSS: **771–790**
- `.role-badge` CSS: **924–931**
- `.data-table` CSS: **900–921**
- Nav HTML for Payroll/Income (identical SVGs): **1365–1372**
- `currentScheduleWeek` declaration: **1414**
- `getCurrentWeekStart` (frontend): **1430**
- `showModal` (existing, different signature): **1551**
- `loadScheduleData(week)`: **1638-1642**
- `renderScheduleTable(schedule, compact)`: **1741–1796**
- `renderSchedulePage(schedule)`: **1853–1863**
- `generateSchedule(btn, weekStart)`: **1865–1893**
- `approveSchedule(weekStart)`: **1895–1909**
- `case 'schedule'` in loadPage: **1962–1970**
- `changeScheduleWeek(delta)`: **2004–2017**
- `loadPayrollPage`: **2162–2173**
- `renderPayrollPage`: **2175–2237**
- Init IIFE: **3475–...**

`src/server/dashRoutes.js`:

- Helpers (`getCurrentWeekStart`, `safeWeekParam`, `addDays`, `mondayOf`, `parseShiftHours`): **17, 28, 954, 960, ~elsewhere**
- `GET /schedule-list`: **625–681**
- `POST /schedule/assign`: **683–754**
- `DELETE /schedule/assign`: **756–791**
- `POST /schedule/generate`: **793–824**
- `POST /schedule/approve`: **826–876**
- `GET /payroll`: **881–912**
- `POST /payroll/revenue`: **914–950**

---

## Task 1: Backend — Modify POST /schedule/approve to write publish state

**File:** `src/server/dashRoutes.js:826-876`

The existing route just sends Telegram and never writes `published_at`/`approved_at`. Add the write AFTER the safeSend, using select→update-or-insert (no upsert because no unique constraint).

- [ ] **Step 1:** Read the existing approve route. Right BEFORE `res.json({ success: true, staffNotified: ... })` at the end of the try block, insert:

```js
    // Persist publish state (always-missing write)
    try {
      const nowIso = new Date().toISOString()
      const { data: existingGs } = await db
        .from('generated_schedules')
        .select('id')
        .eq('group_id', groupId)
        .eq('week_start', weekStart)
        .maybeSingle()
      const publishUpdates = {
        status: 'published',
        published_at: nowIso,
        approved_at: nowIso,
      }
      if (existingGs) {
        await db.from('generated_schedules')
          .update(publishUpdates)
          .eq('id', existingGs.id)
      } else {
        await db.from('generated_schedules')
          .insert({
            group_id: groupId,
            week_start: weekStart,
            assignments: [],
            gaps: [],
            ...publishUpdates,
          })
      }
    } catch (pubErr) {
      console.error('[/schedule/approve publish-state]', pubErr.message)
      // non-fatal: schedule was sent, status write best-effort
    }
```

- [ ] **Step 2:** `node --check src/server/dashRoutes.js` — expect silent OK.

---

## Task 2: Backend — Add GET /schedule/status

**File:** `src/server/dashRoutes.js` — insert immediately AFTER the approve route (around line 876).

- [ ] **Step 1:** Insert this new route:

```js
// GET /api/schedule/status?week=YYYY-MM-DD
router.get('/schedule/status', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const week = safeWeekParam(req.query.week) || getCurrentWeekStart()
    const db = supabase()

    const [gsResult, countResult] = await Promise.all([
      db.from('generated_schedules')
        .select('status, published_at, approved_at')
        .eq('group_id', groupId)
        .eq('week_start', week)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from('schedule_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .eq('week_start', week),
    ])

    const gs = gsResult.data
    const count = countResult.count || 0

    return res.json({
      weekStart: week,
      isPublished: gs?.status === 'published',
      publishedAt: gs?.published_at || null,
      assignmentCount: count,
      hasAssignments: count > 0,
      status: gs?.status || (count > 0 ? 'draft' : 'empty'),
    })
  } catch (err) {
    console.error('[GET /schedule/status]', err.message)
    return res.status(500).json({ error: err.message || 'Failed to load schedule status' })
  }
})
```

Note we use `.order('id', desc).limit(1).maybeSingle()` instead of plain `.maybeSingle()` because there's no unique constraint — multiple historical rows could exist. We want the latest.

- [ ] **Step 2:** `node --check`.

---

## Task 3: Backend — Add POST /schedule/move and POST /schedule/swap

**File:** `src/server/dashRoutes.js` — insert AFTER the new `/schedule/status` route.

- [ ] **Step 1:** Insert /schedule/move:

```js
// POST /api/schedule/move
// Body: { staffId, fromShiftId, toShiftId, weekStart }
router.post('/schedule/move', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { staffId, fromShiftId, toShiftId, weekStart } = req.body || {}
    if (!staffId || !fromShiftId || !toShiftId || !weekStart) {
      return res.status(400).json({ error: 'staffId, fromShiftId, toShiftId, and weekStart are required' })
    }
    if (weekStart !== getCurrentWeekStart()) {
      return res.status(400).json({ error: 'Can only edit the current week' })
    }
    const db = supabase()

    // Conflict: target slot already filled?
    const { data: conflict } = await db
      .from('schedule_assignments')
      .select('id')
      .eq('group_id', groupId)
      .eq('staff_id', staffId)
      .eq('shift_id', toShiftId)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (conflict) {
      return res.status(409).json({ error: 'Staff already assigned to that shift' })
    }

    // Delete source
    const { error: delErr } = await db
      .from('schedule_assignments')
      .delete()
      .eq('group_id', groupId)
      .eq('staff_id', staffId)
      .eq('shift_id', fromShiftId)
      .eq('week_start', weekStart)
    if (delErr) throw delErr

    // Insert target
    const { data: newAssignment, error: insErr } = await db
      .from('schedule_assignments')
      .insert({ group_id: groupId, staff_id: staffId, shift_id: toShiftId, week_start: weekStart, status: 'assigned' })
      .select()
      .single()
    if (insErr) throw insErr

    return res.json({ success: true, removed: { staffId, shiftId: fromShiftId }, added: newAssignment })
  } catch (err) {
    console.error('[POST /schedule/move]', err.message)
    return res.status(500).json({ error: err.message || 'Failed to move shift' })
  }
})
```

- [ ] **Step 2:** Insert /schedule/swap immediately after:

```js
// POST /api/schedule/swap
// Body: { fromStaffId, toStaffId, shiftId, weekStart }
router.post('/schedule/swap', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { fromStaffId, toStaffId, shiftId, weekStart } = req.body || {}
    if (!fromStaffId || !toStaffId || !shiftId || !weekStart) {
      return res.status(400).json({ error: 'fromStaffId, toStaffId, shiftId, and weekStart are required' })
    }
    if (weekStart !== getCurrentWeekStart()) {
      return res.status(400).json({ error: 'Can only edit the current week' })
    }
    if (fromStaffId === toStaffId) {
      return res.status(400).json({ error: 'Same staff — nothing to swap' })
    }
    const db = supabase()

    // Conflict: toStaff already assigned to this shift?
    const { data: conflict } = await db
      .from('schedule_assignments')
      .select('id')
      .eq('group_id', groupId)
      .eq('staff_id', toStaffId)
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (conflict) {
      return res.status(409).json({ error: 'That employee is already on this shift' })
    }

    // Delete from source staff
    const { error: delErr } = await db
      .from('schedule_assignments')
      .delete()
      .eq('group_id', groupId)
      .eq('staff_id', fromStaffId)
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
    if (delErr) throw delErr

    // Insert for target staff
    const { data: newAssignment, error: insErr } = await db
      .from('schedule_assignments')
      .insert({ group_id: groupId, staff_id: toStaffId, shift_id: shiftId, week_start: weekStart, status: 'assigned' })
      .select()
      .single()
    if (insErr) throw insErr

    return res.json({ success: true, removed: { staffId: fromStaffId, shiftId }, added: newAssignment })
  } catch (err) {
    console.error('[POST /schedule/swap]', err.message)
    return res.status(500).json({ error: err.message || 'Failed to swap assignments' })
  }
})
```

- [ ] **Step 3:** `node --check`.

---

## Task 4: Backend — Add GET /payroll/planned

**File:** `src/server/dashRoutes.js` — insert after `GET /payroll` (line 912) but before `POST /payroll/revenue` (line 914).

- [ ] **Step 1:** Insert:

```js
// GET /api/payroll/planned?week=YYYY-MM-DD
// Returns planned hours+cost per staff based on schedule_assignments × role_rates.
router.get('/payroll/planned', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const week = safeWeekParam(req.query.week) || getCurrentWeekStart()
    const db = supabase()

    const [assignRes, ratesRes] = await Promise.all([
      db.from('schedule_assignments')
        .select('id, staff_id, shift_id, staff:staff_id(name, role), shift:shift_id(name, start_time, end_time, day_of_week)')
        .eq('group_id', groupId)
        .eq('week_start', week),
      db.from('role_rates')
        .select('role_name, hourly_rate')
        .eq('group_id', groupId),
    ])
    if (assignRes.error) throw assignRes.error

    const rateMap = {}
    for (const r of ratesRes.data || []) {
      rateMap[r.role_name] = parseFloat(r.hourly_rate) || 0
    }

    const byStaff = {}
    for (const a of assignRes.data || []) {
      const staffId = a.staff_id
      if (!byStaff[staffId]) {
        byStaff[staffId] = {
          staffId,
          staffName: a.staff?.name || 'Unknown',
          role: a.staff?.role || '',
          shifts: [],
          plannedHours: 0,
          plannedCost: 0,
        }
      }
      const start = a.shift?.start_time
      const end = a.shift?.end_time
      let hours = 0
      if (start && end) {
        const [sh, sm] = start.split(':').map(Number)
        const [eh, em] = end.split(':').map(Number)
        hours = (eh * 60 + em - sh * 60 - sm) / 60
        if (hours < 0) hours += 24
      }
      const rate = rateMap[a.staff?.role] || 0
      byStaff[staffId].plannedHours = Math.round((byStaff[staffId].plannedHours + hours) * 100) / 100
      byStaff[staffId].plannedCost = Math.round((byStaff[staffId].plannedCost + hours * rate) * 100) / 100
      byStaff[staffId].shifts.push({
        shiftName: a.shift?.name,
        day: a.shift?.day_of_week,
        hours,
      })
    }

    const rows = Object.values(byStaff)
    const totalPlannedHours = Math.round(rows.reduce((s, r) => s + r.plannedHours, 0) * 100) / 100
    const totalPlannedCost = Math.round(rows.reduce((s, r) => s + r.plannedCost, 0) * 100) / 100

    return res.json({ weekStart: week, rows, totalPlannedHours, totalPlannedCost })
  } catch (err) {
    console.error('[GET /payroll/planned]', err.message)
    return res.status(500).json({ error: err.message || 'Failed to load planned labor' })
  }
})
```

- [ ] **Step 2:** `node --check`.

---

## Task 5: Backend — Modify POST /schedule/generate (current-week guard + copyFromWeek branch)

**File:** `src/server/dashRoutes.js:793-824`

- [ ] **Step 1:** Replace the route body. Find:

```js
router.post('/schedule/generate', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { weekStart } = req.body
    if (!weekStart) return res.status(400).json({ error: 'weekStart is required' })
    const result = await generateWeeklySchedule(groupId, weekStart)
```

Replace with:

```js
router.post('/schedule/generate', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { weekStart, copyFromWeek } = req.body || {}
    if (!weekStart) return res.status(400).json({ error: 'weekStart is required' })

    // Guard: only the current week is generatable/copyable from the dashboard
    const currentWeek = getCurrentWeekStart()
    if (weekStart !== currentWeek) {
      return res.status(400).json({ error: 'Schedule generation is only available for the current week' })
    }

    const db = supabase()

    // Copy-last-week branch
    if (copyFromWeek) {
      if (!safeWeekParam(copyFromWeek)) {
        return res.status(400).json({ error: 'copyFromWeek must be YYYY-MM-DD' })
      }
      const { data: srcRows, error: srcErr } = await db
        .from('schedule_assignments')
        .select('staff_id, shift_id')
        .eq('group_id', groupId)
        .eq('week_start', copyFromWeek)
      if (srcErr) throw srcErr
      if (!srcRows || srcRows.length === 0) {
        return res.status(404).json({ error: 'No schedule found for the source week' })
      }
      // Wipe target then insert
      await db.from('schedule_assignments').delete()
        .eq('group_id', groupId).eq('week_start', weekStart)
      const inserts = srcRows.map(a => ({
        group_id: groupId,
        staff_id: a.staff_id,
        shift_id: a.shift_id,
        week_start: weekStart,
        status: 'scheduled',
      }))
      const { error: insErr } = await db.from('schedule_assignments').insert(inserts)
      if (insErr) throw insErr
      return res.json({
        success: true,
        copied: inserts.length,
        warnings: [{ type: 'copied_from_last_week', message: `Copied ${inserts.length} assignments from ${copyFromWeek}. Review before publishing.` }],
      })
    }

    const result = await generateWeeklySchedule(groupId, weekStart)
```

(The rest of the route continues unchanged: the existing sync of `result.assignments` into `schedule_assignments` and `res.json(result)`.)

- [ ] **Step 2:** `node --check`.

---

## Task 6: Frontend — CSS additions (drag/drop + status banner + modal-backdrop class)

**File:** `public/dashboard.html` — append a new `<style>`-block-safe region. Find the line with `.summary-bar-amount` block (added in prior commit) and append new rules right after it.

- [ ] **Step 1:** Locate the existing `.summary-bar-amount { … }` rule (added previously). Insert AFTER it:

```css
    /* Schedule status banner */
    .schedule-status {
      display: inline-flex; align-items: center;
      gap: 8px; padding: 6px 14px;
      border-radius: var(--radius-full);
      font-size: 13px; font-weight: 600;
      margin-bottom: 16px;
    }
    .schedule-status.published { background: var(--color-success-dim); color: var(--color-success-text); }
    .schedule-status.draft     { background: var(--color-warning-dim); color: var(--color-warning-text); }
    .schedule-status.empty     { background: var(--color-surface-alt); color: var(--color-text-muted); }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: currentColor; flex-shrink: 0;
    }
    .status-time { font-weight: 400; opacity: 0.75; font-size: 12px; }

    /* OT badge */
    .ot-badge {
      display: inline-block; padding: 1px 5px;
      background: var(--color-danger-dim); color: var(--color-danger);
      font-size: 10px; font-weight: 700;
      border-radius: 3px; margin-left: 4px;
      vertical-align: middle;
    }

    /* Drag/drop */
    .draggable-pill { cursor: grab; position: relative; }
    .draggable-pill:active { cursor: grabbing; }
    .draggable-pill.dragging { opacity: 0.4; cursor: grabbing; }
    .pill-remove {
      display: none; position: absolute;
      top: -6px; right: -6px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--color-danger); color: #fff;
      font-size: 11px; line-height: 16px;
      text-align: center; cursor: pointer;
      font-weight: 700; user-select: none;
    }
    .draggable-pill:hover .pill-remove { display: block; }
    .schedule-cell {
      transition: background var(--transition-fast);
    }
    .schedule-cell.droppable { cursor: copy; }
    .drop-target-valid {
      background: var(--color-success-dim) !important;
      outline: 2px dashed var(--color-success);
      outline-offset: -2px;
    }
    .drop-target-invalid {
      background: var(--color-danger-dim) !important;
      outline: 2px dashed var(--color-danger);
      outline-offset: -2px;
    }

    /* Undo toast */
    .undo-toast {
      position: fixed; bottom: 80px; left: 50%;
      transform: translateX(-50%);
      background: var(--color-text-primary); color: #fff;
      padding: 12px 20px; border-radius: 8px;
      display: flex; align-items: center;
      gap: 16px; font-size: 14px;
      z-index: 999; min-width: 260px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
      overflow: hidden;
    }
    .undo-toast button {
      background: none; border: 1px solid rgba(255,255,255,0.4);
      color: #fff; padding: 4px 12px; border-radius: 4px;
      cursor: pointer; font-size: 13px; font-weight: 600;
      white-space: nowrap;
    }
    .undo-toast button:hover { background: rgba(255,255,255,0.15); }
    .undo-timer {
      position: absolute; bottom: 0; left: 0;
      height: 3px; width: 100%;
      background: var(--color-accent);
      border-radius: 0 0 8px 8px;
    }

    /* Confirm-modal backdrop (class form so we can have multiple modals) */
    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(28,20,16,.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    }

    /* Warning button (used for Regenerate when published) */
    .btn-warning {
      background: var(--color-warning-dim);
      color: var(--color-warning-text);
      border: 1px solid var(--color-warning);
      padding: 10px 20px; border-radius: 8px;
      font-weight: 600; cursor: pointer; font-size: 14px;
      font-family: inherit;
      transition: background var(--transition-fast);
    }
    .btn-warning:hover { background: var(--color-warning); color: #fff; }
```

---

## Task 7: Frontend — Add formatRelativeTime + showConfirmModal helpers

**File:** `public/dashboard.html` — insert just BEFORE the existing `function showModal(...)` declaration at line 1551.

- [ ] **Step 1:** Insert:

```js
    function formatRelativeTime(isoStr) {
      if (!isoStr) return '';
      const then = new Date(isoStr).getTime();
      if (!Number.isFinite(then)) return '';
      const diffSec = Math.floor((Date.now() - then) / 1000);
      if (diffSec < 0) return 'just now';
      if (diffSec < 60) return 'just now';
      if (diffSec < 3600) {
        const m = Math.floor(diffSec / 60);
        return `${m} minute${m === 1 ? '' : 's'} ago`;
      }
      if (diffSec < 86400) {
        const h = Math.floor(diffSec / 3600);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
      }
      if (diffSec < 86400 * 7) {
        const d = Math.floor(diffSec / 86400);
        return `${d} day${d === 1 ? '' : 's'} ago`;
      }
      const dt = new Date(isoStr);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[dt.getMonth()]} ${dt.getDate()}`;
    }

    function showConfirmModal(title, message, confirmText = 'Confirm', cancelText = 'Cancel') {
      return new Promise(resolve => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
          <div class="modal-card">
            <div class="modal-title">${title}</div>
            <div class="modal-body"><p style="color:var(--color-text-secondary);font-size:14px;line-height:1.6;margin:0">${message}</p></div>
            <div class="modal-actions">
              <button class="btn-secondary" data-act="cancel">${cancelText}</button>
              <button class="btn-small btn-danger" data-act="confirm" style="padding:10px 20px;font-size:14px;border-radius:8px">${confirmText}</button>
            </div>
          </div>
        `;
        document.body.appendChild(backdrop);
        const cleanup = (val) => { backdrop.remove(); resolve(val); };
        backdrop.querySelector('[data-act="confirm"]').onclick = () => cleanup(true);
        backdrop.querySelector('[data-act="cancel"]').onclick  = () => cleanup(false);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
      });
    }
```

---

## Task 8: Frontend — Replace renderSchedulePage and renderScheduleTable

**File:** `public/dashboard.html:1741-1796` (renderScheduleTable) and `1853-1863` (renderSchedulePage).

- [ ] **Step 1:** Replace renderScheduleTable (1741-1796) with a version that accepts shifts/settings/isCurrentWeek and renders draggable pills + droppable cells when appropriate. Add `shiftMap` lookup for shift_id. The replacement function:

```js
    function buildShiftMap(shifts) {
      // (day_of_week + '|' + shiftName) → shift_id
      const map = {};
      (shifts || []).forEach(s => {
        if (s && s.day_of_week && s.name && s.id != null) {
          map[`${s.day_of_week}|${s.name}`] = s.id;
        }
      });
      return map;
    }

    function shiftHoursOf(s) {
      if (!s || !s.start_time || !s.end_time) return 0;
      const [sh, sm] = String(s.start_time).split(':').map(Number);
      const [eh, em] = String(s.end_time).split(':').map(Number);
      let h = (eh * 60 + em - sh * 60 - sm) / 60;
      if (h < 0) h += 24;
      return h;
    }

    function renderScheduleTable(schedule, compact, shifts = [], settings = {}, isCurrentWeek = false) {
      const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      const DAY_FULL = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' };
      const staff = schedule?.staff || [];
      const showHours = !compact;
      const editable = !compact && isCurrentWeek;

      const shiftMap = buildShiftMap(shifts);
      const shiftHoursById = {};
      (shifts || []).forEach(s => { shiftHoursById[s.id] = shiftHoursOf(s); });
      const otThreshold = Number(settings?.overtimeThreshold) || 40;

      let html = `<div class="card schedule-wrapper${compact ? ' compact' : ''}">`;
      if (!compact) {
        const atCurrent = currentScheduleWeek === getCurrentWeekStart();
        html += `
          <div class="schedule-nav">
            <button class="schedule-nav-btn" onclick="changeScheduleWeek(-7)">&larr; Prev</button>
            <span class="schedule-nav-label">Week of ${formatWeekRange(currentScheduleWeek)}</span>
            <button class="schedule-nav-btn" onclick="changeScheduleWeek(7)" ${atCurrent ? 'disabled style="opacity:.35;cursor:not-allowed"' : ''}>Next &rarr;</button>
          </div>`;
      } else {
        html += `<div class="card-header">This Week's Schedule</div>`;
      }

      html += `<div class="schedule-scroll"><table class="schedule-table"><thead><tr><th>Staff</th>`;
      days.forEach(d => { html += `<th>${d}</th>`; });
      if (showHours) html += `<th style="text-align:right">Total</th>`;
      html += `</tr></thead><tbody>`;

      if (staff.length === 0) {
        html += `<tr><td colspan="${showHours ? 9 : 8}" style="text-align:center;padding:24px;color:var(--text-muted)">No schedule data</td></tr>`;
      }

      staff.forEach(member => {
        const staffId = member.staffId ?? member.id ?? '';
        let totalHours = 0;
        let rowHtml = `<tr><td>
          <div class="staff-name">${escapeHtml(member.staffName || member.name || '')}</div>
          ${(member.roleName || member.role) ? `<div class="staff-role">${escapeHtml(member.roleName || member.role)}</div>` : ''}
        </td>`;

        days.forEach(day => {
          const dayKey = DAY_FULL[day];
          const shifts = member.shifts?.[dayKey] || member.shifts?.[day.toLowerCase()] || member.shifts?.[day] || [];
          let cellHtml = '';
          if (Array.isArray(shifts)) {
            shifts.forEach(s => {
              const label = typeof s === 'string' ? s : (s.shiftName || s.name || '');
              const sid = shiftMap[`${dayKey}|${label}`] ?? null;
              if (sid != null) totalHours += (shiftHoursById[sid] || 0);
              const dragAttrs = (editable && sid != null) ? `
                draggable="true"
                data-staff-id="${staffId}"
                data-shift-id="${sid}"
                data-day="${dayKey}"
                data-shift-name="${escapeHtml(label)}"
                data-week-start="${currentScheduleWeek}"
                ondragstart="onPillDragStart(event)"
                ondragend="onPillDragEnd(event)"
              ` : '';
              const removeBtn = (editable && sid != null) ? `<span class="pill-remove" onclick="removeAssignment(event, '${staffId}', '${sid}')">×</span>` : '';
              cellHtml += `<div class="shift-pill ${shiftPillClass(label)} ${editable && sid != null ? 'draggable-pill' : ''}" ${dragAttrs}>${escapeHtml(label)}${removeBtn}</div>`;
            });
          }
          const cellAttrs = editable ? `
            class="schedule-cell droppable"
            data-staff-id="${staffId}"
            data-day="${dayKey}"
            ondragover="onCellDragOver(event)"
            ondragleave="onCellDragLeave(event)"
            ondrop="onCellDrop(event)"
          ` : 'class="schedule-cell"';
          rowHtml += `<td ${cellAttrs}>${cellHtml}</td>`;
        });

        if (showHours) {
          const hoursColor = totalHours >= otThreshold
            ? 'var(--color-danger)'
            : totalHours >= otThreshold * 0.9
              ? 'var(--color-warning)' : 'var(--text-muted)';
          rowHtml += `<td style="text-align:right">
            <span style="font-weight:600;color:${hoursColor}">${totalHours.toFixed(1)}h</span>
            ${totalHours >= otThreshold ? '<span class="ot-badge">OT</span>' : ''}
          </td>`;
        }
        rowHtml += `</tr>`;
        html += rowHtml;
      });

      html += `</tbody></table></div></div>`;
      return html;
    }
```

- [ ] **Step 2:** Replace renderSchedulePage (1853-1863) with status-aware action bar version:

```js
    function renderSchedulePage(schedule, status, shifts, settings, isCurrentWeek) {
      const weekStart = (schedule && schedule.weekStart) || currentScheduleWeek;
      const s = status || { hasAssignments: false, isPublished: false, publishedAt: null };

      let banner = '';
      if (!s.hasAssignments && isCurrentWeek) {
        banner = `<div class="schedule-status empty"><span class="status-dot"></span>No schedule this week — generate one to start</div>`;
      } else if (s.isPublished) {
        banner = `<div class="schedule-status published"><span class="status-dot"></span>Published${s.publishedAt ? `<span class="status-time">${formatRelativeTime(s.publishedAt)}</span>` : ''}</div>`;
      } else if (s.hasAssignments) {
        banner = `<div class="schedule-status draft"><span class="status-dot"></span>Draft — not published yet</div>`;
      }

      const generateBtn = isCurrentWeek ? `
        <button class="${s.isPublished ? 'btn-warning' : 'btn-primary'}" style="display:inline-flex;align-items:center;gap:6px"
          onclick="generateSchedule(this,'${weekStart}')"
          ${s.isPublished ? 'title="Schedule is published. Regenerating will overwrite it."' : ''}>
          ${s.isPublished
            ? '⚠️ Regenerate'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate Schedule'}
        </button>` : '';

      const approveBtn = isCurrentWeek ? `
        <button id="approve-btn" class="btn-primary" style="background:var(--color-success);display:inline-flex;align-items:center;gap:6px"
          onclick="approveSchedule('${weekStart}')" ${!s.hasAssignments ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ${s.isPublished ? 'Republish' : 'Approve & Publish'}
        </button>` : '';

      const copyBtn = (isCurrentWeek && !s.hasAssignments) ? `
        <button class="btn-secondary" onclick="copyLastWeek()" title="Copy last week's schedule as a draft">↩ Copy Last Week</button>` : '';

      const actionBar = (isCurrentWeek)
        ? `<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">${generateBtn}${approveBtn}${copyBtn}</div>`
        : '';

      return banner + actionBar + renderScheduleTable(schedule, false, shifts || [], settings || {}, !!isCurrentWeek);
    }
```

---

## Task 9: Frontend — Add loadSchedulePage + drag/drop handlers + undo + copyLastWeek + remove

**File:** `public/dashboard.html` — insert AFTER the new `renderSchedulePage` function.

- [ ] **Step 1:** Add module-level state declarations at top of `<script>` block (next to `let currentScheduleWeek`):

Find:
```js
    let currentScheduleWeek = getCurrentWeekStart();
```

Add immediately below:
```js
    let scheduleStatus = null;
    let _dragState = null;
    let _lastAction = null;
```

- [ ] **Step 2:** Insert these new functions immediately after the new `renderSchedulePage`:

```js
    async function loadSchedulePage() {
      const content = document.getElementById('page-content');
      content.innerHTML = renderScheduleSkeleton();
      try {
        const [schedule, status, shifts, settings] = await Promise.all([
          apiFetch('/api/dashboard/schedule?week=' + currentScheduleWeek),
          api(`/api/schedule/status?week=${currentScheduleWeek}`),
          api('/api/shifts'),
          api('/api/settings'),
        ]);
        dashboardData.schedule = schedule;
        scheduleStatus = status;
        const isCurrentWeek = currentScheduleWeek === getCurrentWeekStart();
        content.innerHTML = renderSchedulePage(schedule, status, shifts || [], settings || {}, isCurrentWeek);
      } catch (e) {
        content.innerHTML = renderError("loadSchedulePage()");
      }
    }

    // ── Drag/drop handlers ──
    function onPillDragStart(e) {
      const pill = e.currentTarget;
      _dragState = {
        staffId: pill.dataset.staffId,
        shiftId: pill.dataset.shiftId,
        shiftName: pill.dataset.shiftName,
        day: pill.dataset.day,
        weekStart: pill.dataset.weekStart,
      };
      pill.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', pill.dataset.staffId);
    }
    function onPillDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      document.querySelectorAll('.drop-target-valid, .drop-target-invalid')
        .forEach(el => el.classList.remove('drop-target-valid', 'drop-target-invalid'));
    }
    function onCellDragOver(e) {
      e.preventDefault();
      if (!_dragState) return;
      const cell = e.currentTarget;
      const targetStaffId = cell.dataset.staffId;
      const targetDay     = cell.dataset.day;
      const sameStaff = String(targetStaffId) === String(_dragState.staffId);
      const sameDay   = targetDay === _dragState.day;
      const cellHasPills = !!cell.querySelector('.shift-pill');

      // v1 only supports SWAP: same day, different staff, target empty
      if (sameStaff || !sameDay || cellHasPills) {
        cell.classList.add('drop-target-invalid');
        cell.classList.remove('drop-target-valid');
        e.dataTransfer.dropEffect = 'none';
      } else {
        cell.classList.add('drop-target-valid');
        cell.classList.remove('drop-target-invalid');
        e.dataTransfer.dropEffect = 'move';
      }
    }
    function onCellDragLeave(e) {
      e.currentTarget.classList.remove('drop-target-valid', 'drop-target-invalid');
    }
    async function onCellDrop(e) {
      e.preventDefault();
      const cell = e.currentTarget;
      cell.classList.remove('drop-target-valid', 'drop-target-invalid');
      if (!_dragState) return;

      const targetStaffId = cell.dataset.staffId;
      const targetDay     = cell.dataset.day;
      const sameStaff = String(targetStaffId) === String(_dragState.staffId);
      const sameDay   = targetDay === _dragState.day;
      const cellHasPills = !!cell.querySelector('.shift-pill');

      if (sameStaff && sameDay) { _dragState = null; return; } // no-op
      if (!sameDay) { showToast('Drag within the same day to swap staff', 'error'); _dragState = null; return; }
      if (cellHasPills) { showToast('That cell is already filled', 'error'); _dragState = null; return; }

      const fromStaffId = _dragState.staffId;
      const shiftId     = _dragState.shiftId;
      const weekStart   = _dragState.weekStart;
      _dragState = null;

      try {
        await api('/api/schedule/swap', 'POST', {
          fromStaffId, toStaffId: targetStaffId, shiftId, weekStart,
        });
        _lastAction = { type: 'swap', fromStaffId, toStaffId: targetStaffId, shiftId, weekStart };
        await loadSchedulePage();
        showUndoToast('Shift swapped');
      } catch (err) {
        showToast(err.message || 'Failed to swap', 'error');
      }
    }

    async function removeAssignment(e, staffId, shiftId) {
      e.stopPropagation();
      const weekStart = currentScheduleWeek;
      if (weekStart !== getCurrentWeekStart()) return;
      _lastAction = { type: 'remove', staffId, shiftId, weekStart };
      try {
        await api('/api/schedule/assign', 'DELETE', { staffId, shiftId, weekStart });
        await loadSchedulePage();
        showUndoToast('Shift removed');
      } catch (err) {
        showToast('Failed to remove', 'error');
      }
    }

    function showUndoToast(message) {
      const existing = document.getElementById('undo-toast');
      if (existing) {
        if (existing._timeout) clearTimeout(existing._timeout);
        existing.remove();
      }
      const toast = document.createElement('div');
      toast.id = 'undo-toast';
      toast.className = 'undo-toast';
      toast.innerHTML = `<span>${message}</span><button onclick="undoLastAction()">Undo</button><div class="undo-timer"></div>`;
      document.body.appendChild(toast);
      const timerBar = toast.querySelector('.undo-timer');
      timerBar.style.transition = 'width 5s linear';
      requestAnimationFrame(() => { timerBar.style.width = '0%'; });
      toast._timeout = setTimeout(() => { toast.remove(); _lastAction = null; }, 5000);
    }

    async function undoLastAction() {
      if (!_lastAction) return;
      const action = _lastAction; _lastAction = null;
      const toast = document.getElementById('undo-toast');
      if (toast) { if (toast._timeout) clearTimeout(toast._timeout); toast.remove(); }
      try {
        if (action.type === 'swap') {
          await api('/api/schedule/swap', 'POST', {
            fromStaffId: action.toStaffId, toStaffId: action.fromStaffId,
            shiftId: action.shiftId, weekStart: action.weekStart,
          });
        } else if (action.type === 'remove') {
          await api('/api/schedule/assign', 'POST', {
            staffId: action.staffId, shiftId: action.shiftId, weekStart: action.weekStart,
          });
        }
        await loadSchedulePage();
        showToast('Undone');
      } catch (err) {
        showToast('Could not undo', 'error');
      }
    }

    async function copyLastWeek() {
      const d = parseDate(currentScheduleWeek);
      d.setDate(d.getDate() - 7);
      const lastWeekStr = formatDate(d);
      try {
        await api('/api/schedule/generate', 'POST', { weekStart: currentScheduleWeek, copyFromWeek: lastWeekStr });
        await loadSchedulePage();
        showToast("Last week's schedule copied as draft");
      } catch (err) {
        showToast(err.message || 'Failed to copy', 'error');
      }
    }
```

---

## Task 10: Frontend — Modify generateSchedule + approveSchedule + changeScheduleWeek + case 'schedule' to use loadSchedulePage

**File:** `public/dashboard.html`

- [ ] **Step 1:** Replace `generateSchedule` (lines 1865-1893) with a version that confirms before regenerating a published schedule and uses `loadSchedulePage`:

```js
    async function generateSchedule(btn, weekStart) {
      // Guard: confirm if schedule is already published
      if (scheduleStatus?.isPublished) {
        const ok = await showConfirmModal(
          '⚠️ Schedule is published',
          "This week's schedule has already been sent to your team. Regenerating will overwrite all current assignments. Are you sure?",
          'Yes, regenerate',
          'Cancel'
        );
        if (!ok) return;
      }
      const originalLabel = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Generating...';
      try {
        const result = await api('/api/schedule/generate', 'POST', { weekStart });
        const warnings = (result && result.warnings) || [];
        await loadSchedulePage();
        if (warnings.length > 0) {
          const container = document.getElementById('page-content');
          container.querySelectorAll('.warning-banner').forEach(b => b.remove());
          for (const w of warnings) {
            const banner = document.createElement('div');
            banner.className = 'warning-banner';
            banner.innerHTML = `<span>⚠️</span><span>${escapeHtml(w.message)}</span><button onclick="this.parentElement.remove()" aria-label="Dismiss">✕</button>`;
            container.prepend(banner);
          }
          showToast(`Schedule generated (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`, 'warning');
        } else {
          showToast('Schedule generated');
        }
      } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      }
    }
```

- [ ] **Step 2:** Replace `approveSchedule` (lines 1895-1909) so it reloads the page (so the banner flips to "Published") instead of mutating button state in place:

```js
    async function approveSchedule(weekStart) {
      const btn = document.getElementById('approve-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }
      try {
        const r = await api('/api/schedule/approve', 'POST', { weekStart });
        showToast(`Schedule published! ${r && r.staffNotified != null ? r.staffNotified : 0} staff notified.`);
        await loadSchedulePage();
      } catch (e) {
        showToast(e.message, 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Approve &amp; Publish';
        }
      }
    }
```

- [ ] **Step 3:** Replace `changeScheduleWeek` (lines 2004-2017) so it clamps to the current week and uses `loadSchedulePage`:

```js
    async function changeScheduleWeek(delta) {
      const d = parseDate(currentScheduleWeek);
      d.setDate(d.getDate() + delta);
      const next = formatDate(d);
      const currentWeek = getCurrentWeekStart();
      // Clamp: don't allow navigating into future weeks
      currentScheduleWeek = (delta > 0 && next > currentWeek) ? currentWeek : next;
      await loadSchedulePage();
    }
```

- [ ] **Step 4:** Replace the `case 'schedule'` branch in `loadPage` (lines 1962-1970) with:

```js
        case 'schedule':
          loadSchedulePage();
          break;
```

(loadSchedulePage handles its own skeleton + error rendering.)

- [ ] **Step 5:** Update the call sites of `renderScheduleTable` for the OVERVIEW page (line 1837 area). Find:

```js
      html += renderScheduleTable(schedule, true);
```

This still works because the new signature has all extra params optional with defaults (`shifts=[], settings={}, isCurrentWeek=false`). The compact overview will render exactly as before (no drag/drop, no OT badge — `shifts=[]` means `shiftHoursById` is empty so `totalHours` is 0; this matches the old `compact` behavior of NOT showing the Total column at all). NO change required.

---

## Task 11: Frontend — Payroll planned-labor card + table

**File:** `public/dashboard.html:2162-2237`

- [ ] **Step 1:** Replace `loadPayrollPage` (2162-2173) with a version that fetches planned labor:

```js
    async function loadPayrollPage() {
      try {
        const [payroll, settings, planned] = await Promise.all([
          api(`/api/payroll?week=${currentPayrollWeek}`),
          api('/api/settings'),
          api(`/api/payroll/planned?week=${currentPayrollWeek}`),
        ]);
        renderPayrollPage(payroll || [], settings || {}, planned || { rows: [], totalPlannedHours: 0, totalPlannedCost: 0 });
      } catch (e) {
        showToast(e.message, 'error');
        renderErrorInline("loadPage('payroll')");
      }
    }
```

- [ ] **Step 2:** Replace `renderPayrollPage` (2175-2237) with the planned-aware version:

```js
    function renderPayrollPage(payroll, settings, planned) {
      const totalPay = payroll.reduce((s, r) => s + (r.total_gross_pay || 0), 0);
      const totalHrs = payroll.reduce((s, r) => s + (r.total_hours || 0), 0);
      const avgRate  = totalHrs > 0 ? totalPay / totalHrs : 0;
      const staffPaid = payroll.filter(r => (r.total_hours || 0) > 0).length;
      const plannedRows = planned?.rows || [];
      const plannedCost = Number(planned?.totalPlannedCost || 0);
      const plannedHours = Number(planned?.totalPlannedHours || 0);

      const rateOf = r => (r.total_hours || 0) > 0 ? (r.total_gross_pay || 0) / (r.total_hours || 0) : 0;

      const rows = payroll.map(r => `
        <tr>
          <td>${escapeHtml(r.name || '')}</td>
          <td><span class="role-badge">${escapeHtml(r.role || '')}</span></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${(r.total_hours || 0).toFixed(1)}h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(rateOf(r))}/h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${formatCurrency(r.total_gross_pay || 0)}</td>
        </tr>`).join('');

      // Planned-vs-Actual rows (joined on staff_id)
      const pvaRows = plannedRows.map(p => {
        const actual = payroll.find(a => String(a.staff_id) === String(p.staffId)) || {};
        const actualHrs = actual.total_hours || 0;
        const actualPay = actual.total_gross_pay || 0;
        const variance = actualPay - p.plannedCost;
        const vColor = variance > 0 ? 'var(--color-danger)' : 'var(--color-success)';
        return `<tr>
          <td>${escapeHtml(p.staffName || '')}</td>
          <td><span class="role-badge">${escapeHtml(p.role || '')}</span></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${p.plannedHours.toFixed(1)}h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(p.plannedCost)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${actualHrs.toFixed(1)}h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(actualPay)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;color:${vColor}">${variance > 0 ? '+' : ''}${formatCurrency(variance)}</td>
        </tr>`;
      }).join('');

      const thisWeek = getCurrentWeekStart();
      const atCurrent = currentPayrollWeek >= thisWeek;
      const incomeHidden = (settings.hiddenPages || []).includes('income');

      setContent(`
        <div class="page-header">
          <h2 class="page-title">Payroll</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-small" onclick="changePayrollWeek(-7)">&larr; Prev</button>
            <span style="font-size:14px;font-weight:600;color:var(--text-secondary)">Week of ${formatWeekRange(currentPayrollWeek)}</span>
            <button class="btn-small" onclick="changePayrollWeek(7)" ${atCurrent ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>Next &rarr;</button>
            <a href="/api/payroll/spreadsheet?week=${currentPayrollWeek}" download class="btn-small">📥 Export CSV</a>
          </div>
        </div>

        <div class="stat-grid" style="margin-bottom:20px;grid-template-columns:repeat(4,1fr)">
          <div class="stat-card"><div class="stat-label">Labor Cost</div><div class="stat-value">${formatCurrency(totalPay)}</div></div>
          <div class="stat-card"><div class="stat-label">Total Hours</div><div class="stat-value">${totalHrs.toFixed(1)}h</div></div>
          <div class="stat-card">
            <div class="stat-label">Planned Labor</div>
            <div class="stat-value">${plannedRows.length ? formatCurrency(plannedCost) : '—'}</div>
            <div class="stat-sub">${plannedRows.length ? 'from published schedule' : 'No schedule this week'}</div>
          </div>
          <div class="stat-card"><div class="stat-label">Staff Paid</div><div class="stat-value">${staffPaid}</div></div>
        </div>

        <div class="card">
          <table class="data-table payroll-table">
            <thead><tr>
              <th>Name</th><th>Role</th>
              <th style="text-align:right">Hours</th>
              <th style="text-align:right">Rate</th>
              <th style="text-align:right">Gross Pay</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No payroll data for this week. Generate and approve a schedule to calculate payroll.</td></tr>'}</tbody>
            ${payroll.length ? `<tfoot><tr style="border-top:2px solid var(--surface-border);font-weight:700;color:var(--text)">
              <td>TOTAL</td><td>—</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${totalHrs.toFixed(1)}h</td>
              <td style="text-align:right">—</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(totalPay)}</td>
            </tr></tfoot>` : ''}
          </table>
        </div>

        ${plannedRows.length ? `
        <div class="card" style="margin-top:16px">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
            <span>Planned vs Actual Labor</span>
            <span style="font-size:12px;font-weight:400;color:var(--text-muted)">based on published schedule × hourly rates</span>
          </div>
          <table class="data-table">
            <thead><tr>
              <th>Staff</th><th>Role</th>
              <th style="text-align:right">Planned Hrs</th>
              <th style="text-align:right">Planned Cost</th>
              <th style="text-align:right">Actual Hrs</th>
              <th style="text-align:right">Actual Pay</th>
              <th style="text-align:right">Variance</th>
            </tr></thead>
            <tbody>${pvaRows}</tbody>
            <tfoot><tr style="border-top:2px solid var(--surface-border);font-weight:700;color:var(--text)">
              <td colspan="2">Total</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${plannedHours.toFixed(1)}h</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(plannedCost)}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${totalHrs.toFixed(1)}h</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(totalPay)}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${(totalPay - plannedCost) > 0 ? '+' : ''}${formatCurrency(totalPay - plannedCost)}</td>
            </tr></tfoot>
          </table>
        </div>` : ''}

        ${incomeHidden ? `<div style="margin-top:16px;text-align:center">
          <a onclick="navigateTo('income')" style="font-size:13px;color:var(--accent);cursor:pointer;text-decoration:none">Track revenue and tips →</a>
        </div>` : ''}
      `);
    }
```

---

## Task 12: Frontend — Swap Payroll nav icon to receipt

**File:** `public/dashboard.html:1366`

- [ ] **Step 1:** Replace the Payroll nav SVG (line 1366) with a receipt icon. Find:

```html
        <a class="nav-item" data-page="payroll" onclick="navigateTo('payroll')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span class="nav-item-label">Payroll</span>
        </a>
```

Replace with:

```html
        <a class="nav-item" data-page="payroll" onclick="navigateTo('payroll')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-2 4 2 4-2 4 2V4a2 2 0 0 0-2-2z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>
          <span class="nav-item-label">Payroll</span>
        </a>
```

(Income keeps the dollar sign; Payroll becomes a receipt/payslip.)

---

## Task 13: Verify

- [ ] **Step 1:** Backend syntax check.

```bash
node --check /Users/mahin/relay-bot/src/server/dashRoutes.js
```

- [ ] **Step 2:** HTML balance check.

```bash
python3 -c "
c = open('/Users/mahin/relay-bot/public/dashboard.html').read()
print('div open:', c.count('<div'))
print('div close:', c.count('</div>'))
print('match:', c.count('<div') == c.count('</div>'))
print('lines:', c.count(chr(10)))
"
```

- [ ] **Step 3:** Boot server, smoke-test new endpoints with bad cookie (expect 401, not 500):

```bash
cd /Users/mahin/relay-bot && node src/index.js > /tmp/relay-smoke.log 2>&1 &
SERVER_PID=$!
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:10000/api/auth/me 2>/dev/null | grep -qE "^(200|401|403)$"; then break; fi
done
echo "/api/schedule/status      => $(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: relay_session=bad' http://localhost:10000/api/schedule/status)"
echo "/api/payroll/planned      => $(curl -s -o /dev/null -w '%{http_code}' -H 'Cookie: relay_session=bad' http://localhost:10000/api/payroll/planned)"
echo "/api/schedule/swap (POST) => $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Cookie: relay_session=bad' -H 'Content-Type: application/json' -d '{}' http://localhost:10000/api/schedule/swap)"
echo "/api/schedule/move (POST) => $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Cookie: relay_session=bad' -H 'Content-Type: application/json' -d '{}' http://localhost:10000/api/schedule/move)"
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
echo "--- last 20 lines of server log ---"
tail -20 /tmp/relay-smoke.log
```

All four should return 401.

---

## Task 14: Print SQL migration + commit + push

- [ ] **Step 1:** Print this SQL block for the user to run in Supabase (NOT executed by the plan; it's an optional hardening — the publish state write works without it via select-then-update-or-insert):

```sql
-- Optional but recommended. The /schedule/approve write works without these,
-- but the unique constraint prevents duplicate (group_id, week_start) rows
-- accumulating in generated_schedules over time.

ALTER TABLE generated_schedules
  ADD CONSTRAINT IF NOT EXISTS generated_schedules_group_week_unique
  UNIQUE (group_id, week_start);

-- (status, published_at, approved_at columns already exist per supabase-schema.sql)
```

- [ ] **Step 2:** Commit + push.

```bash
git -C /Users/mahin/relay-bot add public/dashboard.html src/server/dashRoutes.js docs/superpowers/plans/2026-04-29-schedule-dragdrop-publish.md
git -C /Users/mahin/relay-bot commit -m "$(cat <<'EOF'
feat: schedule drag/drop + publish state + planned labor

Backend:
- POST /schedule/approve now writes generated_schedules.published_at
  and approved_at (the always-missing write). Uses
  select→update-or-insert because no unique constraint exists yet.
- New GET /schedule/status returning isPublished + publishedAt +
  hasAssignments for banner rendering.
- New POST /schedule/swap (drag-drop swap, current week only,
  conflict-checked) and POST /schedule/move (future-use).
- New GET /payroll/planned joining schedule_assignments × shifts ×
  role_rates to compute planned hours/cost per staff.
- POST /schedule/generate now (a) rejects non-current weeks and
  (b) accepts a copyFromWeek param to clone last week's assignments.

Frontend:
- Schedule page rebuilt: status banner (Published / Draft / Empty),
  smart action bar (Generate / Regenerate / Republish / Copy Last Week),
  HTML5 drag-drop swap with valid/invalid drop highlighting and
  hover × remove button. Past weeks are read-only.
- Undo toast (5s window) for every mutation.
- Real total-hours per staff column with OT badge using settings.overtimeThreshold.
- Confirm-modal guards regenerating a published schedule.
- Week nav clamps to current week; Next button disabled at current.
- Payroll: new "Planned Labor" stat card and "Planned vs Actual Labor"
  variance table (joined on staff_id, color-coded variance).
- Payroll nav icon swapped from dollar sign to receipt (no longer
  identical to Income).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /Users/mahin/relay-bot push origin main
```

---

## Self-Review

- **Spec coverage:** Routes 1-5 all addressed (Tasks 1-5). Drag/drop, undo, status banner, OT badge, copy-last-week, current-week lock, Payroll planned labor, icon swap — all addressed (Tasks 6-12).
- **Deviations from spec, with rationale:**
  - Used `supabase()` not `req.app.locals.db` (only `bot` is on `req.app.locals`).
  - Used select→update-or-insert for `/schedule/approve` publish write (no unique constraint exists; upsert with onConflict would throw).
  - Used `role_name`/`hourly_rate` columns (not `role`/`rate` per user spec — wrong column names).
  - Frontend supports SWAP only (not MOVE) — `move` route ships per spec but unused. Move requires unambiguous shift_id on cells; cells are per-day not per-shift, so a generic move target is undefined. SWAP covers the most common UX need.
  - showConfirmModal uses `class="modal-backdrop"` (added a class rule) instead of `id` so it can coexist with `showModal` (which uses the id).
  - Used `--color-*` tokens not legacy aliases for `--danger`, `--warning` (those don't exist as aliases).
- **Defense-in-depth checklist:**
  - ☑ Swap/move reject non-current week
  - ☑ Conflict check before delete
  - ☑ Undo cleared after use
  - ☑ Drag only attached when `isCurrentWeek && shiftId resolved`
  - ☑ Quick-remove only on current week (frontend guard + backend 7-day window already in place)
  - ☑ Generate guard: only current week (backend) + confirm modal if published (frontend)
  - ☑ Copy last week: backend 404s if no source rows
  - ☑ OT badge: respects `settings.overtimeThreshold`, defaults to 40
  - ☑ Planned labor: missing role_rates → $0 (rateMap fallback)
  - ☑ Hours: handles overnight (`if (h < 0) h += 24`)
  - ☑ Publish-write: works without unique constraint (no upsert dependency)
  - ☑ Next nav button disabled on current week + clamped if overshot
- **No placeholders.** All steps contain literal code.
