# Time Clock, Doubles Support & Schema Update

**Date:** 2026-04-11
**Status:** Approved

## Overview

Three changes in one pass:
1. **Time clock** — staff clock in/out via DM, payroll uses actual hours when available
2. **Doubles support** — remove 1-shift-per-day limit, add configurable max
3. **Schema update** — bring `supabase-schema.sql` up to date with all tables

## 1. Time Clock

### DM Flow

Staff DMs the bot naturally. The DM router detects clock intent using keyword matching first (fast path), with LLM `isDmConfirmation`-style fallback for ambiguous phrasing.

**Fast-path patterns (no LLM):**
- Clock in: `clock in`, `clocking in`, `here`, `starting`, `on the clock`, `checked in`
- Clock out: `clock out`, `clocking out`, `done`, `leaving`, `off the clock`, `heading out`, `finished`

**Clock in:**
1. Look up today's scheduled shift(s) via `findPersonShiftForDay`
2. If one shift → auto-link, confirm: "Clocked in for Monday Lunch (11am-3pm) at 11:05 AM"
3. If multiple shifts (doubles) → ask: "You have two shifts today:\n1) Lunch (11am-3pm)\n2) Dinner (5pm-10pm)\nWhich one?"
4. If no shift found → still record with no shift link: "Clocked in at 2:15 PM (no shift scheduled today)"

**Clock out:**
1. Find open clock-in (null `clock_out`) for this user today
2. Close it: "Clocked out of Monday Lunch. Worked 3h 55m."
3. If actual weekly hours now exceed OT threshold → DM manager: "Heads up — Alex just hit 42.5 hours this week (threshold: 40). 2.5 hours OT so far."
4. If no open clock-in → "You haven't clocked in today. Send 'clock in' to start."

### Data Model

```sql
CREATE TABLE IF NOT EXISTS time_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  staff_id BIGINT,
  shift_id UUID,
  clock_in TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  clock_in_raw TEXT,
  clock_out_raw TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, group_id, clock_in)
);

CREATE INDEX IF NOT EXISTS idx_time_entries_user_open
  ON time_entries (user_id, group_id) WHERE clock_out IS NULL;
```

### Payroll Integration

`calculateWeeklyPayWithOT` receives an optional `timeEntries` array. Per assignment:
- If a matching time entry exists (same `staff_id` + `shift_id`) → use actual hours from `clock_in`/`clock_out`
- If no match → fall back to scheduled hours (current behavior, unchanged)

Pay report marks each shift `[actual]` or `[scheduled]` so the manager knows the source.

### Manager Notifications

**OT alert (real-time):** When a clock-out pushes weekly actual hours past the OT threshold, DM the manager immediately.

**Compliance nudge (daily briefing):** Add a section to the existing 8am daily briefing:
- "Yesterday, 3 staff didn't clock in: Alex, Sarah, Jordan"
- "Alex has missed clock-in 4 of the last 5 shifts" (rolling 5-shift window)

### Manager Commands

- `/clockstatus` — Who's currently clocked in, who's scheduled today but hasn't clocked in
- `/timesheet` or `/timesheet [name]` — Actual vs scheduled hours for the current/most recent published week

## 2. Doubles Support

### Scheduling Change

Remove the guard in `generateSchedule.js:152`:
```js
if (assignedOnDay[s.userId]?.has(shift.day_of_week)) return false
```

Replace with a configurable max check:
```js
const dayCount = assignmentsOnDay[s.userId]?.get(shift.day_of_week) ?? 0
if (maxShiftsPerDay > 0 && dayCount >= maxShiftsPerDay) return false
```

Track counts instead of a Set (increment per assignment, not just presence).

### Configuration

- Stored in `setup_sessions.setup_data.max_shifts_per_day` (integer, 0 = no limit)
- Default: 0 (no limit) — existing behavior after removing the guard
- Setup flow: asked after overtime settings — "Max shifts per person per day? (Reply a number, or 'no limit')"
- `/setmaxshifts [number]` command to change after setup (0 or "none" = no limit)

### Downstream Impact

- Clopening detection already handles multiple shifts per day (compares consecutive-day pairs)
- Hours tracker already sums all shifts per person
- Time clock handles multiple shifts (asks which one on clock-in)

## 3. Schema Update

Bring `supabase-schema.sql` up to date by adding every table referenced in the codebase. Tables to add (derived from reading all `src/**/db*.js` and `src/**/*Db.js` files):

- `setup_sessions`
- `shifts`
- `shift_requirements`
- `staff`
- `role_rates`
- `overtime_settings`
- `generated_schedules`
- `schedule_assignments`
- `availability_records`
- `availability_sessions`
- `schedule_receipts`
- `reliability_events`
- `oncall_records`
- `time_off_requests`
- `noshow_warnings`
- `onboarding_records`
- `passive_availability`
- `weekly_revenue`
- `labor_budgets`
- `manager_log_entries`
- `payroll_records`
- `time_entries` (new)

All tables get RLS enabled with anon access policies (matching existing pattern).

## Files to Create/Modify

**New files:**
- `src/timeclock/clockDetector.js` — fast-path keyword matching for clock in/out intent
- `src/timeclock/clockHandler.js` — handles clock-in, clock-out, shift disambiguation
- `src/timeclock/clockDb.js` — DB operations for time_entries
- `src/timeclock/clockAlerts.js` — OT alert on clock-out, compliance nudge for briefing
- `src/timeclock/clockCommands.js` — `/clockstatus` and `/timesheet` handlers

**Modified files:**
- `src/routing/dmRouter.js` — add clock detection before LLM fallback
- `src/index.js` — add `/clockstatus`, `/timesheet`, `/setmaxshifts` commands
- `src/payroll/payCalculator.js` — add timeEntries param to `calculateWeeklyPayWithOT`
- `src/payroll/payReport.js` — show `[actual]`/`[scheduled]` markers
- `src/schedule/reviewSchedule.js` — pass time entries to payroll on publish
- `src/schedule/generateSchedule.js` — replace 1-shift-per-day with max config
- `src/setup/setupFlow.js` — add max_shifts_per_day step
- `src/briefing/dailyBriefing.js` — add clock compliance section
- `supabase-schema.sql` — all missing tables + time_entries

## What's NOT Included

- GPS/location verification
- Break tracking
- Rounding rules (nearest 15 min)
- Timezone configuration
- Manager approval of time entries
- Editing clock-in/out times after the fact
