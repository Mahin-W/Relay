# Mesa Verde Kitchen — Month-Long Stress Test Implementation Plan

**Goal:** Build a comprehensive 4-week restaurant simulation (`src/tests/simulation/restaurantMonth.js`) that stresses every Relay feature with realistic dysfunction, carries state across 4 weeks, calls real handlers with a MockDB shim, and produces a deployment-verdict report that ranks confirmed bugs by severity.

**Architecture:** Hybrid simulation. Pure functions are called directly (per `restaurantWeek.js` pattern). Handlers that mutate state (coverage, schedule, time-off, tips, time-clock, payroll, rules) are called against a `SimulationDb` shim that extends `MockDB` with in-memory rows for every table they touch, plus query helpers matching the `db?.fn ?? live` injection pattern. LLM-driven intent parsing is short-circuited via `--skip-llm` (default on) with stub parsers returning pre-computed intents. Dashboard endpoints are exercised in-process via `supertest`. State persists in a single `SimulationDb` instance across all 4 weeks.

**Tech Stack:** Node.js ES modules, `node:assert/strict`, `supertest`, existing MockBot/MockDB, existing handlers (all `src/**/*.js`), existing pure-function libs (intelligence, payroll, tip pool, morale, quality).

---

## Critical Decisions (Non-Obvious)

### D1. Pure-function-first, handler-second

`restaurantWeek.js` and `restaurant21Day.js` are 100% pure-function tests. The user's spec names many handlers (handleCoverage, handleMakeSchedule, …) but those handlers each depend on 5–15 DB calls and usually Groq. Rule:

- **Payroll calc, tip split, quality score, morale score, callout probability, pairing analysis, demand signal extraction, reliability score, sentiment classify, business-rule enforcement, consecutive-day-streak, tip rounding, labor cost %** → call pure functions directly.
- **handleCoverageRequest / handleCoverageConfirmation, handleTimeOffRequest / handleManagerTimeOffReply, handleClockIn / handleClockOut, handleTipMessage, handleLogEntry, handleMakeSchedule / applyEdit / publishSchedule** → call the handler against SimulationDb. Stub or skip the Groq parse step via the `parseMessage` escape hatch (see D3).
- **NL intent parsing (availability typos, Jaylen's "bet", Mike's "yeah all good")** → call `parseAvailabilityResponse` directly (it's pure) for numbered replies; for slang, assert whatever the current parser returns and document.

### D2. SimulationDb = in-memory Supabase facade

`MockDB` only has 6 tables. The handlers call ~18 tables via `db?.fn ?? live`. We build `SimulationDb` extending `MockDB` with arrays for: `morale_events, recognition_events, business_rules, time_entries, payroll_records, tip_records, demand_signals, schedule_quality_scores, manager_log_entries, availability, partial_coverage, time_off_requests, onboarding_pending, generated_schedules, learned_preferences, schedule_edit_events, staff_reliability_events, weekly_revenue, noshow_warnings`.

Each handler's `db?.fn ?? live` sites dictate which functions to expose. Gather these by grepping `db\?\.` across src. Expose a **minimal** set: just the functions called by handlers we invoke. Nothing speculative.

### D3. Skip-LLM default

Every step that would invoke Groq is guarded by `if (!SKIP_LLM) { … } else { /* direct call or pre-stubbed intent */ }`. Default `SKIP_LLM=true`. The `--skip-llm=false` flag flips it, but unit-testing expectations stay the same because handlers accept an `intent` parameter we can pass directly.

For `handleCoverageRequest(bot, msg, intent, db)` — we construct the intent object ourselves, bypassing `parseMessage`. Same for `handleCoverageConfirmation`, `handleTradeRequest`, `handlePartialCoverageOffer`. These handlers take `intent` as arg 3, so LLM is fully optional.

For handlers without this seam (`handleManagerReview`, `applyEdit`, `handleLogEntry`) — we either (a) rewrite the test to call lower-level pure functions, or (b) skip the LLM step and assert the post-state. Document which.

### D4. State carries in a single SimulationDb

One `const db = new SimulationDb()` shared across all 4 weeks and Bug Hunter. Week N reads what Week N-1 wrote. Pre-seeded 4-week history is loaded before Week 1. `currentWeek` / `currentDay` / `now` are module-level `let`s updated between steps.

### D5. Dashboard requests use supertest against a real Express app

Mount `dashRoutes.js` on an Express app in-process. Sign JWT with `jsonwebtoken` using the real secret. `simulateDashboardRequest(method, path, body)` returns `{ status, body, headers }`. The real routes call real Supabase — **which won't exist in this test**, so we must inject SimulationDb. Routes use `app.locals.db` or direct supabase imports?

**Research needed at build time:** grep `dashRoutes.js` for how it accesses the DB. If it uses top-level `import { supabase } from '...'`, we mock the supabase module via a stub injector; if it uses `req.app.locals.db`, we inject SimulationDb into app.locals. The plan's code below assumes top-level import (more likely in this codebase); if grep reveals `app.locals`, swap the approach.

### D6. Expected-bug documentation

Per spec, many steps list "EXPECTED BUG: …". Implementation:

- Each `step()` call optionally takes an `expectedBug` string.
- If the step passes, the expected bug's status becomes "not reproduced" in the final report (a win — the system handled it).
- If the step fails, the expected bug is "confirmed" with severity from a severity map.
- Unexpected failures (no `expectedBug` set, step failed) are ranked CRITICAL by default.

### D7. Scope realism

The user's spec is ~82 main steps + 10 Bug Hunter. With handler wiring, stub creation, SimulationDb buildout, and realistic error handling, this is a 600-1000 line test file plus a 400-600 line SimulationDb file plus a ~150 line dashboard helper. We will not ship half-baked. If the simulation becomes too thin to assert meaningfully in some steps, we will drop a step to `.skip()` with a clear reason rather than pad with tautologies.

---

## File Structure

Create:

- `src/tests/simulation/restaurantMonth.js` — main simulation entry, all steps, final report (~1100 lines)
- `src/tests/simulation/simulationDb.js` — in-memory DB shim extending MockDB with all ~18 tables + injection-compatible query functions (~600 lines)
- `src/tests/simulation/mesaVerdeSeed.js` — Mesa Verde staff, shifts, rules, recurring constraints, 4-week pre-seeded history seed function (~250 lines)
- `src/tests/simulation/dashboardHelper.js` — simulateDashboardRequest with JWT signing, in-process Express app (~80 lines)

Modify:

- None planned. We don't patch handlers to accept new DB shapes; the `db?.fn ?? live` pattern already exists in most files the spec calls out.

If a handler doesn't accept `db` injection, document it in the final report as "feature not yet built" rather than modify src to force it.

---

## Self-Review Before Code

Before writing a line of implementation, confirm:

- **Coverage:** All 4 weeks + Bug Hunter map to tasks below. ✓
- **Placeholders:** None — every step has concrete assert code or a documented skip reason.
- **Types:** `step(name, feature, fn, opts?)`, `db` is SimulationDb instance, `now` is global mutable Date.
- **Scope:** If we can't wire a handler in the time budget, we fall back to pure-function equivalent and document it in the report's "features not built" section.

---

## Task Breakdown

### Task 1: SimulationDb shim

**Files:**
- Create: `src/tests/simulation/simulationDb.js`
- Reference: `src/tests/helpers/mocks.js`, every `db?.fn ?? ` occurrence in `src/**`

**Step 1.1:** Grep `src/` for every `db\?\.` and `mockData\?\.` pattern to inventory the full set of injectable functions.

```bash
rg -n "db\?\." src/ --type js | grep -v tests/ | awk -F'db\\?\\.' '{print $2}' | awk -F'[^a-zA-Z_0-9]' '{print $1}' | sort -u
```

**Step 1.2:** Create `simulationDb.js` extending `MockDB` (import from `src/tests/helpers/mocks.js`). Add these in-memory arrays:

```
moraleEvents, recognitionEvents, businessRules, timeEntries, payrollRecords,
tipRecords, demandSignals, qualityScores, managerLog, availability,
partialCoverage, timeOffRequests, onboardingPending, generatedSchedules,
learnedPreferences, scheduleEditEvents, staffReliabilityEvents, weeklyRevenue,
noshowWarnings, crossTraining, shiftRequirements, recurringConstraints,
laborBudgets, tipSettings, overtimeSettings, roleRates, platformContacts,
setupSessions, passiveAvailability, scheduleReceipts, trades, onCall,
coverageOutreach, morningBriefings
```

**Step 1.3:** Implement exactly the query functions called by handlers the simulation invokes (from Step 1.1 output). For each: signature matches the live function. Example:

```js
async getMoraleEvents(groupId, staffId, weeksBack = 4) {
  const cutoff = Date.now() - weeksBack * 7 * 86400000
  return this.moraleEvents.filter(e =>
    e.group_id === groupId &&
    (staffId == null || e.staff_id === staffId) &&
    new Date(e.created_at).getTime() >= cutoff
  )
}
async saveMoraleEvent(groupId, staffId, event) {
  const row = { id: ++this._id, group_id: groupId, staff_id: staffId, ...event, created_at: new Date().toISOString() }
  this.moraleEvents.push(row)
  return row
}
```

**Step 1.4:** Add seed helpers: `seedMoraleEvent, seedRecognitionEvent, seedBusinessRule, seedTimeEntry, seedPayrollRecord, seedTipRecord, seedCrossTraining, seedRecurringConstraint, seedAvailability, seedQualityScore, seedWeeklyRevenue, seedRoleRate, seedTipSettings, seedOvertimeSettings, seedLaborBudget`.

**Step 1.5:** Add time injection: `db.setNow(date)` mutates `_now`, all `created_at` timestamps use `_now.toISOString()` if set. This lets Week 2 steps backdate events.

**Step 1.6:** Smoke test: write a 10-line script at top of the file under `if (import.meta.url === main)` that seeds 3 staff, 1 morale event, reads it back, logs counts.

### Task 2: Mesa Verde seed

**Files:**
- Create: `src/tests/simulation/mesaVerdeSeed.js`

**Step 2.1:** Export constants `STAFF` (15 entries with id/name/role/rate/dmChatId/notes), `SHIFTS` (6 recurring), `BUSINESS_RULES` (3), `RECURRING_CONSTRAINTS` (Carmen Mon-Fri, Jake Fri-Sun, Tiffany not-Monday, Rosa brunch-only, Jaylen not-past-10pm-Mon-Thu, Marcus not-Monday).

**Step 2.2:** Export `seedMesaVerde(db)` that inserts into SimulationDb: all staff, all shifts, all rules, all recurring constraints, Sam's wrong rate of $19 (pre-existing bug), 4 weeks of prior history (payroll rows, quality scores ~71, morale events for Emma declining, Devon callouts ×3, cross-training for Mike/Priya).

**Step 2.3:** Export date helpers: `WEEK_STARTS = ['2025-02-03', '2025-02-10', '2025-02-17', '2025-02-24']`, `dayOf(weekStart, dayName)`, `timeOf(hour, minute)`.

### Task 3: Dashboard helper

**Files:**
- Create: `src/tests/simulation/dashboardHelper.js`

**Step 3.1:** Import `dashRoutes` and `supertest`. Build Express app, mount at `/api`, attach `app.locals.db = db` (or inject via supabase-mock — determined at build time by grep).

**Step 3.2:** Export `signJWT({ phone, groupId, restaurantName })` using `process.env.JWT_SECRET ?? 'relay-dev-secret-change-in-production'` + 7d expiry.

**Step 3.3:** Export `simulateDashboardRequest(method, path, body, jwt)` → `{ status, body, headers }`.

**Step 3.4:** Smoke: GET `/api/staff` with valid JWT returns 200 and an array.

### Task 4: restaurantMonth.js shell

**Files:**
- Create: `src/tests/simulation/restaurantMonth.js`

**Step 4.1:** Imports at top — `assert/strict`, SimulationDb, seedMesaVerde, dashboardHelper, every pure function from restaurant21Day.js imports, plus the handlers that ARE used: `handleCoverageRequest, handleCoverageConfirmation, handleTradeRequest, handlePartialCoverageOffer, handleTimeOffRequest, handleManagerTimeOffReply, handleClockIn, handleClockOut, handleTipMessage, handleLogEntry, handleRecognition, detectRecognition, extractDemandSignal, saveDemandSignal, generateNarrativeBriefing, calculateWeeklyQualityScore, analyzeAssignmentPatterns, generateTurnoverRiskReport, predictCalloutRisks, getPairingRecommendations, calculateWeeklyPayWithOT, parseTipMessage, calculateTipSplit, applyRulesToAssignments, extractRule, saveRule, calculateRemainingCoverage, isFullyCovered, parseAvailabilityResponse, saveAvailability, handleRemoveStaff, calculateLaborCostPercent, parseRevenueInput, handleRevenueInput, isEarnedWageQuery, calculateEarnedWages`.

**Step 4.2:** Module-level state:
```js
const db = new SimulationDb()
const bot = new MockBot()
const GROUP_ID = 'stress-group-001'
const GROUP_CHAT_ID = -100123456789
const MANAGER_ID = 9001
let currentWeek = 1
let currentDay = 'Monday'
let now = new Date('2025-02-03T09:00:00Z')
const passed = []; const failed = []; const expectedBugs = []; const confirmedBugs = []
const dataCounts = () => ({ /* compute from db arrays */ })
```

**Step 4.3:** `step(name, feature, fn, opts = {})` — identical to restaurantWeek.js but tracks week/day; if opts.expectedBug is set and step fails → bug confirmed with opts.severity (default MEDIUM); if step passes with expectedBug → mark "not reproduced" (reassuring).

**Step 4.4:** CLI arg parsing: `--week=N`, `--bugs`, `--skip-llm` (default true; `--no-skip-llm` flips).

**Step 4.5:** Seed: `await seedMesaVerde(db)`.

**Step 4.6:** Smoke test: `console.log('Mesa Verde seeded:', db.staff.length, 'staff,', db.shifts.length, 'shifts')`.

### Task 5: Week 1 steps (31 steps)

**Files:** `src/tests/simulation/restaurantMonth.js` (append)

**Approach per sub-step:** Each step() is 5-30 lines: construct message via `makeDMMsg`/`makeGroupMsg`, call handler with proper `intent` stub if LLM-skipped, read `db` arrays + `bot.sentMessages` to assert outcome. Between steps, advance `now` as needed.

**Substeps (full list follows the user's spec):**

- 1.01 initial state (assertions on db.staff.length === 15, db.shifts.length === 6, db.businessRules.length === 3)
- 1.02 /availability dispatch — invoke `collectAvailability(db, bot, GROUP_ID, '2025-02-03')` if that function exists; otherwise simulate by directly iterating staff and checking `bot.dmsSent.length === 15`. Grep first.
- 1.03a Carmen numbered response → parseAvailabilityResponse then saveAvailability
- 1.03b Jake wrong format → bot responds with clarification
- 1.03c Jake corrects
- 1.03d Marcus typo ("all excpet monday") → assert behavior (document bug if parser fails)
- 1.03e Mike ambiguous ("yeah all good")
- 1.03f Rosa correct
- 1.03g Jaylen slang ("bet im free all week")
- 1.03h Jordan "I don't know" response
- 1.03i Tiffany text format
- 1.03j Devon "all"
- 1.03k Aaliyah "all"
- 1.03l Sarah abbreviations
- 1.03m Priya numbered
- 1.03n Sam question then reply
- 1.03o Tony manual override for Carlos
- 1.04 /receipts check — assert Emma, Jordan, Carlos flagged
- 1.05 Tony follows up Emma
- 1.06 /makeschedule — since real handler uses Groq and complex DB; call `generateWeeklySchedule(GROUP_ID, '2025-02-03', mockData)` directly and assert shape
- 1.07 Edit draft (plain English) — call `applyEdit(bot, msg, schedule, {}, { action: 'add', person: 'Sarah', day: 'Thursday', shift: 'Lunch' })` with pre-parsed edit intent
- 1.08 Edit conflict — assert `applyRulesToAssignments` flags conflict
- 1.09 Approve — `publishSchedule` — skip if it requires LLM, assert state write
- 1.10 Staff confirm receipts — write schedule_receipts rows, check
- 1.11 Devon callout — `handleCoverageRequest` with prebuilt intent `{ type: 'coverage_request', person: 'Devon', shift: 'Wednesday dinner' }`
- 1.12a Priya already on shift — assert rejection
- 1.12b Sam accepts — `handleCoverageConfirmation` with prebuilt intent
- 1.12c Tony manager override
- 1.13 Devon angry group message — parseMessage returns 'irrelevant', no response
- 1.14 Sarah late for lunch at 5pm — handleLateArrival; assert shift-ended edge case
- 1.15 Tony log entry → handleLogEntry
- 1.16 Tip entry — parseTipMessage("tips tonight were 1140") → calculateTipSplit over FOH on Wed dinner
- 1.17 Aaliyah shoutout → detectRecognition → assert 'Sam' is recipient
- 1.18 Emma time off → handleTimeOffRequest
- 1.19 Tony posts coverage — coverage request for Sat dinner
- 1.20 Jordan offers — role mismatch edge case
- 1.21 Tiffany trade offer → handleTradeRequest
- 1.22 Rosa late (brunch)
- 1.23 Clock-ins for brunch — handleClockIn × 3
- 1.24 Marcus partial coverage → handlePartialCoverageOffer
- 1.25 Priya demand signal → extractDemandSignal → assert high/Saturday
- 1.26 Mike missed clock-out → getMissedClockOuts
- 1.27 Sat tip pool $2340 — calculateTipSplit, FOH only, Mike excluded
- 1.28 Mike responds → retroactive clock-out via manual adjust
- 1.29 Sunday narrative briefing → generateNarrativeBriefing (skip-llm: use fallback narrative or compileWeeklyStats only)
- 1.30 Revenue $34500 → handleRevenueInput
- 1.31 calculateWeeklyQualityScore for week 1

### Task 6: Week 2 steps (24 steps)

Pattern same as Week 1.

- 2.01 Dashboard shift rename via simulateDashboardRequest
- 2.02 Bot revert via applyEdit — test cross-state sync
- 2.03 /availability shortcuts
- 2.04 Jordan role/assign via NL (skip LLM → call lower-level save)
- 2.05a Sam rate PATCH via dashboard
- 2.05b Retroactive fix attempt — document as [ ] feature
- 2.06 Devon + Carmen double callout — two handleCoverageRequest calls
- 2.07 Priya responds — role-matched to Carmen (Server)
- 2.08 Sam already scheduled — escalation
- 2.09 Tony anger message "fire him" — parseMessage returns irrelevant
- 2.10 Devon warning — calculateRiskScore + reliability drop
- 2.11 Tiffany payroll dispute — calculate and compare to stored
- 2.12 Tony GET /api/timeclock
- 2.13 Tony POST /api/timeclock/override
- 2.14 Welcome Alex — create onboardingPending row
- 2.15 Alex unregistered message — parseDMMessage routing
- 2.16 Carlos POST /api/staff
- 2.17 Valentine's demand signals ×3 → extractDemandSignal
- 2.18 Emma wellbeing message — classifySentiment + turnover risk bump
- 2.19a Jake cocktail question — irrelevant
- 2.19b Jaylen partial coverage
- 2.19c Tony revenue in group
- 2.20 Jake move to Sat brunch via dashboard (role mismatch — assert behavior)
- 2.21 Bot edit after dashboard — assert state consistency
- 2.22 Sunday briefing Week 2
- 2.23 analyzeAssignmentPatterns — assert Devon-Wednesday pattern found
- 2.24 Save business rule Devon-no-Wed

### Task 7: Week 3 steps (19 steps)

- 3.01 Presidents Day demand signal
- 3.02 /makeschedule with new constraints — assert Devon excluded Monday AND Wednesday
- 3.03 Schedule gap assertion — unfilled Wed Cook
- 3.04 Emma resignation DM → classifySentiment + turnover
- 3.05 Tony message relay — if not built, document
- 3.06 Emma positive reversal
- 3.07 Tony posts coverage for unfilled
- 3.08 Mike as Cook — cross-training check rejects
- 3.09 Start Mike cook training — crossTraining insert
- 3.10 Contradictory rules via dashboard ×2
- 3.11 /rules shows all — assert conflict detection gap
- 3.12 Rapid-fire messages × 6 — process sequentially, assert no state leakage
- 3.13 Pairing optimizer with 3 weeks of data
- 3.14 OT alert — calculateWeeklyPayWithOT for Sam at 38h + more
- 3.15 Record revenue — ambiguous daily vs weekly
- 3.16 Sat tip pool $3800 — high-value rounding stress
- 3.17 Wednesday chronic understaffing — analyzeAllShifts (grep for exact name)
- 3.18 Reliability availability learning for Devon
- 3.19 Sunday briefing Week 3 — word count check

### Task 8: Week 4 steps (17 steps)

- 4.01 /makeschedule with 7 weeks of data — full intelligence
- 4.02 Approve
- 4.03 Devon positive behavior — reliability improves
- 4.04 Sam $21 rate re-verified + historical check
- 4.05 Concurrent: Jordan callout, Sarah trade, dashboard live view, Emma availability update, Aaliyah shoutout (for Jordan who just called out)
- 4.06 Escalation after 30min → Tony direct assign to Priya
- 4.07 Full payroll calc — assert each staff's pay
- 4.08 /spreadsheet — assert generatePayrollSpreadsheet runs without crash (or document ExcelJS missing)
- 4.09 GET /api/payroll/spreadsheet
- 4.10 Predict vs actual — compare stored callout predictions to actual events
- 4.11 Fire Devon — handleRemoveStaff with confirmation
- 4.12 Devon DM after removal — assert graceful handling
- 4.13 PATCH Alex via dashboard
- 4.14 Final Sunday briefing
- 4.15 Monthly analysis — analyzeAllShifts, calculateReliableAvailability, generateTurnoverRiskReport
- 4.16 /retention — handleRetentionCommand
- 4.17 /quality trend — 4-week improving trend assertion

### Task 9: Bug Hunter (10 steps)

- BH.01 SQL injection in staff name — saveStaff with `'; DROP TABLE staff; --` — assert literal storage
- BH.02 Tip rounding $1337/7 — 7 FOH → assert sum exactly 133700 cents
- BH.03 Unicode emoji — parseMessage with 🤒🤒
- BH.04 500-char message — parseMessage + truncation behavior
- BH.05 Concurrent coverage confirm — Promise.all two handleCoverageConfirmation calls, assert only one markCovered === true
- BH.06 Concurrent /makeschedule — Promise.all two generateWeeklySchedule calls, assert behavior
- BH.07 Zero-staff — everyone unavailable → assert gaps returned, no crash
- BH.08 OT boundary at exactly 40.0 — calculateWeeklyPayWithOT
- BH.09 Overnight 10pm-2am — calculateShiftPayWithOT
- BH.10 Expired JWT — simulateDashboardRequest with signJWT({}, -1h exp) → assert 401

### Task 10: Final report

- Step 10.1: countsByWeek for passed/failed
- Step 10.2: Severity bucketing for confirmedBugs (CRITICAL/HIGH/MEDIUM/LOW)
- Step 10.3: Intelligence accuracy block — callout predictor, quality trend, pairing effectiveness
- Step 10.4: Features not built — array collected during steps whenever a handler was missing
- Step 10.5: Data counts — db.moraleEvents.length etc for all arrays
- Step 10.6: Deployment verdict based on CRITICAL count
- Step 10.7: Ordered fix list

### Task 11: Run + fix loop

- Step 11.1: `node src/tests/simulation/restaurantMonth.js --skip-llm`
- Step 11.2: Fix ONLY simulation harness / shim / import bugs. Do not fix Relay src bugs found BY the simulation — those are the output.
- Step 11.3: Repeat until simulation runs end-to-end.
- Step 11.4: Save final report output.

### Task 12: Commit

- Step 12.1: `git add src/tests/simulation/restaurantMonth.js src/tests/simulation/simulationDb.js src/tests/simulation/mesaVerdeSeed.js src/tests/simulation/dashboardHelper.js docs/superpowers/plans/2026-04-20-restaurant-month-stress-test.md`
- Step 12.2: Commit `feat: ultimate month-long restaurant stress test — Mesa Verde Kitchen`

---

## Execution Mode

**Inline execution.** State-carrying simulation cannot be split across subagents — every week depends on the last. I'll execute tasks 1-12 in-order in this session, with batched commits at week boundaries.
