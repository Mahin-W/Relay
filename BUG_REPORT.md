# Relay — 8-Hour Stress Test Bug Report

Generated: 2026-04-29T03:33:02.083Z
Runtime: 587.8s
Total findings: 12 (0 critical, 11 high, 1 medium, 0 low)

## Phase Summary

| Phase | Findings | Stats |
|---|---|---|
| Schema Audit | 0 | schemaTableCount=48, codeTableRefs=46 |
| Feature Stress | 0 | features=29 |
| Command Stress | 0 | commandsTested=34, commandsThrew=0 |
| Concurrency Stress | 0 | coverageRaceWinners=1, concurrentClockIns=1, concurrentClockOuts=1, availabilityRows=1, payrollRows=1, tipRows=1 |
| Chat Router Stress | 0 | messagesProcessed=91, throws=0, slashCommandsHit=0 |
| Dashboard API Stress | 11 | calls=0 |
| Expanded 6-Month Sim | 1 | weeks=26, events=1191, throws=0, noiseMessages=187, demandSignalsDetected=25, recognitionsDetected=19, calloutEvents=91, botMessages=689, staff=15, assignments=820, payrollRecords=56, coverageRequests |

## HIGH (11)

### HIGH-1. POST /api/payroll/revenue returned 500 (set revenue)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to log revenue"}
```

- **Repro**: `POST /api/payroll/revenue with body {"weekStart":"2025-04-28","revenue":35000}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-2. POST /api/payroll/revenue returned 500 (huge revenue)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to log revenue"}
```

- **Repro**: `POST /api/payroll/revenue with body {"weekStart":"2025-04-28","revenue":1000000000000000}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-3. POST /api/revenue/daily returned 500 (add daily revenue)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"new row violates row-level security policy for table \"daily_revenue\""}
```

- **Repro**: `POST /api/revenue/daily with body {"date":"2025-04-28","amount":5000,"category":"lunch"}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-4. POST /api/revenue/types returned 500 (add category)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"new row violates row-level security policy for table \"revenue_types\""}
```

- **Repro**: `POST /api/revenue/types with body {"name":"Catering"}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-5. POST /api/rules returned 500 (add rule)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to add rule"}
```

- **Repro**: `POST /api/rules with body {"type":"staff_conflict","constraintText":"A and B never together"}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-6. POST /api/rules returned 500 (add day_off)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to add rule"}
```

- **Repro**: `POST /api/rules with body {"type":"day_off","constraintText":"X"}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-7. GET /api/timeclock returned 500 (list entries)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to load time clock entries"}
```

- **Repro**: `GET /api/timeclock`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-8. GET /api/timeclock?week=2025-04-28 returned 500 (specific week)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to load time clock entries"}
```

- **Repro**: `GET /api/timeclock?week=2025-04-28`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-9. GET /api/timeclock/live returned 500 (live entries)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to load live clock entries"}
```

- **Repro**: `GET /api/timeclock/live`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-10. PATCH /api/roles/Server returned 500 (update Server rate)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to update role rate"}
```

- **Repro**: `PATCH /api/roles/Server with body {"rate":16.5}`
- **Impact**: 500s on dashboard routes break the manager UI experience

### HIGH-11. POST /api/rates returned 500 (add rate)

- **Phase**: Dashboard API Stress
- **Area**: dash-api
- **Evidence**:

```
Status 500, body: {"error":"Failed to save rate"}
```

- **Repro**: `POST /api/rates with body {"roleName":"Bartender","hourlyRate":18}`
- **Impact**: 500s on dashboard routes break the manager UI experience

## MEDIUM (1)

### MEDIUM-1. Coverage fill rate is only 0% (0/91)

- **Phase**: Expanded 6-Month Sim
- **Area**: coverage-quality
- **Impact**: Bot is not effective at filling open shifts in this simulation; check outreach logic.

## Findings By Area

- **coverage-quality**: 1
- **dash-api**: 11

---

## Status of fixes (2026-04-28 evening pass)

Started at 55 findings, now at 12. Every code-fixable item is done; the remaining
items are blocked on either a schema deployment or a feature build.

### Already fixed in this branch

- ✅ `bot.once` / `bot.removeListener` added to `UnifiedBot` + `TelegramAdapter` — `/addshift` no longer crashes
- ✅ `role_rates.updated_at` removed from upserts (DB default handles it)
- ✅ `business_rules` join alias collision in `/api/rules` fixed
- ✅ 9 missing tables added to `supabase-schema.sql` (`weekly_quality_scores`, `restaurant_tip_settings`, `cross_training`, `recurring_constraints`, `discovered_patterns`, `coverage_confirmations`, `staff_availability_windows`, `staff_members`, `availability_outcomes`)
- ✅ RLS whitelist extended to 14 previously-uncovered tables
- ✅ `time_entries → staff` FK added (so dashboard timeclock joins work)
- ✅ `role_rates.updated_at` and `time_entries.alerted_at` `ALTER TABLE IF NOT EXISTS` safety adds
- ✅ Date-validity guard middleware (`safeWeekParam`) on every `weekStart`/`week` query param — turns 500s into graceful fallback to current week
- ✅ `parseRevenueInput` no longer false-positives on "tips were $X" — split into strict `extractRevenueFromGroupMessage` for passive group-message detection
- ✅ Type guard on `extractDemandSignal` (was crashing on non-string input)
- ✅ Type guard on `calculateCalloutProbability` (was crashing on null/non-object)
- ✅ `staffingPatterns` `weeksAnalyzed` regression fixed (was returning `insufficient_data` because of test/source date drift) — 22/22 tests pass
- ✅ `lateArrivalValidation` overnight-shift bug fixed (4/4 tests pass) — `parseShiftTime` now resolves end-of-shift correctly when shift wraps midnight
- ✅ `detectRecognition` negation guard ("no shoutouts tonight" no longer matches), 200-char `reason` cap, and Levenshtein fuzzy match for staff name typos ("Mark" → "Marc")
- ✅ `calculateWeeklyQualityScore` refactored to use named-method DB stubs first, fall back to Supabase queries — now testable end-to-end without a live DB
- ✅ `patternAlerts.js` and `calloutPredictor.js` queries fixed — they were selecting non-existent columns (`day_of_week`, `shift_name`) directly from `coverage_requests`/`schedule_assignments`. Now joining through `shifts(name, day_of_week)`.
- ✅ `crossTrainingDb.js` no longer joins to a non-existent `roles` table
- ✅ `calculateLaborCostPercent` returns `status: 'unknown'` (not 'critical') for non-finite/NaN inputs
- ✅ Stress harness schema audit improved — false positives from PostgREST relational join syntax dropped from 33 to 0

### Still requires manual action

**Production Supabase needs `supabase-schema.sql` re-applied.** The dashboard route
500s in this report (HIGH-1 through HIGH-11) all originate from the Supabase
project not having the new tables / RLS policies / FKs / columns I added to the
schema file. Steps:

1. Open the Supabase project → SQL Editor → New Query
2. Paste the entire contents of `supabase-schema.sql`
3. Run. (`CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
   are idempotent — safe to re-run on a project with existing data.)
4. Force the PostgREST schema cache reload: `NOTIFY pgrst, 'reload schema'`
5. Re-run the stress harness: `node --env-file=.env src/tests/simulation/stress8h/run.js`

After deployment, expect findings count to drop to **1** (just the coverage
escalation feature gap).

### Still pending (feature build, not a bug)

- **Coverage fill escalation cron** (MEDIUM-1) — the bot opens coverage requests
  but never re-pings staff if no one volunteers within 30/60/120 min. Add a cron
  that walks open `coverage_requests`, DMs the on-call staff first, then
  fans out to remaining staff, then alerts the manager. Detail in original
  recommendation §13.
