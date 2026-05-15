# Relay — Production Readiness Report

**Date:** 2026-05-08 (P0 status updated 2026-05-09; first P1 batch shipped 2026-05-15)
**Auditor:** Claude Opus 4.7 (12-agent parallel codebase audit)
**Verdict:** ✅ **All 13 P0 blockers fixed and deployed. SQL migrations 008/009 applied to Supabase. Render boot is green as of 2026-05-15 (`JWT_SECRET` env set). 4 P1s fixed (P1-1, P1-3, P1-12, P1-28); 28 P1s still open — see `LAUNCH_AUDIT_BUGS.md`.**

## P0 status (2026-05-09)

| # | Status | Fix |
|---|--------|-----|
| P0-1 JWT_SECRET fallback | ✅ FIXED | `src/server/middleware.js` fail-fast on missing/<32-char secret |
| P0-2 No global error handlers | ✅ FIXED | `src/index.js` adds `unhandledRejection` + `uncaughtException` |
| P0-3 Message handler unwrapped | ✅ FIXED | `src/index.js:bot.on('message')` try/catch with chat/user context |
| P0-4 `/setup` silent wipe | ✅ FIXED | `src/setup/setupFlow.js` requires "yes wipe" confirmation |
| P0-5 Coverage swap not atomic | ✅ FIXED | `revertCovered` compensation in `src/coverage/confirmationHandler.js` + `src/db/coverage.js` |
| P0-6 Cancel-after-fill | ✅ FIXED | `src/coverage/cancelHandler.js` reverse-swaps + DMs volunteer |
| P0-7 Trade swap not transactional | ✅ FIXED | Undo-stack rollback in `src/coverage/tradeHandler.js` |
| P0-8 RLS wide open | ✅ FIXED | Migration 008 dropped anon `USING (true)`; `src/db/client.js` prefers service-role key |
| P0-9 Multi-role payroll wrong | ✅ FIXED | `rolesWorked` + `weightedRegularRate` + per-shift literal pay in `src/payroll/payCalculator.js` and `spreadsheetGenerator.js` |
| P0-10 Coverage dual-write | ✅ FIXED | `swapIfPossible` rolls back inner write on failure (bundled with P0-5) |
| P0-11 Cascade deletes wipe history | ✅ FIXED | Migration 009 converts critical FKs to `ON DELETE SET NULL`; adds unique constraint on `schedule_assignments` |
| P0-12 Hardcoded GAS URL | ✅ FIXED | `src/server/marketingRoutes.js` `/api/waitlist` proxy; `public/index.html` updated |
| P0-13 `bot.getMe()` no `.catch` | ✅ FIXED | `src/index.js` exits on rejection so Render restarts |

---

---

## One-Line Verdict

The core flows work in the happy path, but six classes of failure — silent bot death, auth-token forgeability, accidental setup data wipe, non-atomic coverage/trade swaps, **a Supabase RLS policy that grants `anon` full read+write on every table**, and **multi-role staff being paid the wrong rate** — will hit a real customer within their first two weeks and cause immediate churn, wage disputes, or a public security incident.

---

## Launch Blockers (P0 — fix before first customer)

### P0-1: `JWT_SECRET` falls back to a hardcoded dev secret

**File:** `src/server/middleware.js:3-4`
```javascript
const JWT_SECRET = process.env.JWT_SECRET
  || 'relay-dev-secret-change-in-production'
```
- **What breaks:** If `JWT_SECRET` is not set in Render env vars (or accidentally cleared), tokens sign with a string that lives in the public source tree. Anyone with the repo can forge a JWT for any manager at any restaurant. 7-day token lifetime amplifies the blast radius.
- **How likely:** Certain on misconfigured deploys; latent on every deploy where the env var is forgotten or rotated incorrectly.
- **Fix time:** 5 min.
- **Fix:** Throw at module load if `process.env.JWT_SECRET` is missing or shorter than 32 chars.

### P0-2: No global `uncaughtException` / `unhandledRejection` handler

**File:** `src/index.js` (only `SIGINT` handler at line 684)
- **What breaks:** Any throw that escapes a message handler kills the Node process. Bot disappears mid-Friday-rush; manager doesn't know it's dead because there's no health alert.
- **How likely:** Likely. Every external-input handler is a candidate (Telegram payload, LLM response, Supabase row).
- **Fix time:** 10 min.
- **Fix:** `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)`, log + `process.exit(1)` so Render restarts.

### P0-3: Telegram message handler is not wrapped in try/catch

**File:** `src/index.js:102-116`
```javascript
bot.on('message', async (msg) => {
  ...
  await handleDmMessage(...)   // can throw
  await handleGroupMessage(...) // can throw
})
```
- **What breaks:** A single malformed payload or a transient Supabase error throws → unhandled rejection → process dies (per P0-2).
- **How likely:** Certain — these handlers do dozens of awaits each.
- **Fix:** Wrap both calls in try/catch; log with msg context; never re-throw.

### P0-4: `/setup` silently wipes existing staff/shifts/availability

**File:** `src/setup/setupFlow.js:27-31`
```javascript
const existing = await getSetupSession(groupId)
const hadData = !!existing
if (hadData) {
  await clearGroupSetupData(groupId)   // <-- destructive, no confirmation
}
```
- **What breaks:** Manager runs `/setup` again — by accident, while showing a coworker, or because they forgot they already did it — and all staff/shifts/assignments are deleted before they see any prompt.
- **How likely:** Will happen within month 1. Restaurant managers are not careful CLI users.
- **Fix:** Detect existing setup with non-zero staff or shifts; require an explicit "yes, wipe and start over" reply in DM before destructive call.

### P0-5: Coverage claim → schedule swap is not atomic

**File:** `src/coverage/confirmationHandler.js:217-230`
```javascript
const marked = await _markCovered(openRequest.id, volunteer)  // CAS — atomic ✓
if (!marked) { ...return }
...
await swapIfPossible(openRequest, volunteer, groupId)  // separate call, errors swallowed
```
- **What breaks:** `markCovered` succeeds; `swapIfPossible` (which updates `schedule_assignments` + `published_schedule`) throws or partially fails. `swapIfPossible` catches and only logs (line 24 of same file). Result: `coverage_requests.status='covered'` but `schedule_assignments` still points at original requester. Both staff have conflicting versions; manager has no signal anything went wrong.
- **How likely:** Likely under any DB blip during peak.
- **Fix:** Compensation pattern — on swap failure, revert `coverage_requests.status` to `'open'` and surface the error.

### P0-6: Coverage cancel does not work after the request is filled

**File:** `src/db/coverage.js:92-107`
```javascript
.update({ status: 'cancelled' })
.eq('group_id', groupId)
.eq('status', 'open')   // <-- never matches a 'covered' request
```
- **What breaks:** Alice posts coverage. Bob accepts → status becomes `'covered'`, schedule swapped. Alice messages "actually I'm coming in" → cancel finds zero open rows, returns false. Bob is still on the schedule. Alice shows up. Bob doesn't. **Or** Bob shows up and Alice does, and one of them gets sent home.
- **How likely:** Will happen monthly per active customer.
- **Fix:** Allow cancellation of `'covered'` rows; on cancel, revert `schedule_assignments` to original requester and DM the volunteer that they're off the hook.

### P0-7: Trade swap is four sequential writes with no transaction

**File:** `src/coverage/tradeHandler.js:233-242`
```javascript
await swapScheduleAssignment(... shift_A ... requester→offerer)
await swapPublishedScheduleAssignment(... shift_A ...)
await swapScheduleAssignment(... shift_B ... offerer→requester)   // if this fails, A is half-done
await swapPublishedScheduleAssignment(... shift_B ...)
```
- **What breaks:** Step 3 fails. Steps 1–2 already committed. Half a swap is now persisted. Both sides of the trade have wrong assignments; no rollback path.
- **How likely:** Rare per attempt, certain over time.
- **Fix:** Wrap all four updates in a Postgres function (Supabase RPC) so the swap is all-or-nothing.

### P0-8: Supabase RLS grants `anon` full read+write on every table

**File:** `supabase-schema.sql:616-644`
```sql
EXECUTE format(
  'CREATE POLICY IF NOT EXISTS "Allow all for anon on %I" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)',
  tbl, tbl
);
```
- **What breaks:** Anyone with the Supabase URL + anon key can read **and modify** every row across every restaurant — phones, payroll, schedules, tips, time clock — bypassing the dashboard entirely. The `SUPABASE_ANON_KEY` is shipped in production (`render.yaml:envVars`) and embedded in any client that uses Supabase JS. App-layer JWT auth is the only thing protecting the database; if anyone discovers the URL, the database is open.
- **How likely:** Certain. Anon keys are not secret by design; they're meant to work with RLS. Without per-tenant RLS, this is wide open.
- **Fix time:** ~half a day to write per-table policies and verify.
- **Fix:** Replace `USING (true)` with `USING (group_id = (auth.jwt() ->> 'groupId'))` on every tenant-scoped table; require service-role key only for trusted server paths.

### P0-9: Multi-role staff are paid at the wrong rate

**File:** `src/payroll/payCalculator.js:304-306`
```js
staffMap[staffId] = {
  staffId, staffName, roleName,
  hourlyRate: roleObj.hourlyRate,   // <-- single rate per staff
  rawAssignments: []
}
```
- **What breaks:** A staff member who works two roles in one week (e.g. server $15/hr + bartender $20/hr) has their `roleName`/`hourlyRate` overwritten by the *last* assignment processed. All hours then price at that single rate — over- or under-paying every cross-trained employee, every week.
- **How likely:** Certain for any restaurant with cross-trained staff (most of them).
- **Fix time:** 1 day (track hours-by-role per staff; weighted-average OT premium per FLSA).

### P0-10: Schedule swap on coverage uses two separate writes

**File:** `src/coverage/confirmationHandler.js:17-23` (inside `swapIfPossible`)
- **What breaks:** `swapScheduleAssignment` (writes `schedule_assignments`) and `swapPublishedScheduleAssignment` (writes the published-schedule JSONB) are sequential. If the second fails, the live table and the manager-facing JSON are out of sync. This compounds with P0-5 — even when both writes succeed, there's no rollback if `markCovered` already committed.
- **Fix:** Move both updates into a single Postgres function (Supabase RPC) so the swap is atomic; combine with the P0-5 compensation pattern.

### P0-11: Cascading deletes destroy historical payroll

**File:** `supabase-schema.sql:35,211,366,385,402…`
- **What breaks:** Deleting a single `staff` or `shift` row cascades through `payroll_records`, `schedule_assignments`, `time_entries`, `coverage_requests`, etc. A manager who clicks "remove staff" or "delete shift" loses every historical pay record tied to that row — and there is no undo. Wage-claim defense becomes "we have no records."
- **Fix:** `ON DELETE SET NULL` (preserving historical FKs) or soft-delete with `deleted_at`; require a confirmation modal that shows the affected row count.

### P0-12: Public landing page leaks Google Apps Script URL

**File:** `public/index.html:1049`
```js
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz…/exec'
```
- **What breaks:** The waitlist signup posts to a hardcoded Google Apps Script endpoint visible in `view-source`. There's no origin check. Anyone can POST garbage to this URL and pollute the waitlist sheet, exhaust the GAS quota, or DoS the form. Rotating the URL requires a redeploy.
- **Fix:** Proxy waitlist submissions through `/api/waitlist`; rotate the Apps Script ID immediately.

### P0-13: `bot.getMe()` has no `.catch` — crons never start on transient Telegram failure

**File:** `src/index.js:71-82`
```javascript
bot.getMe().then((me) => {
  ...
  startReminderJobs(bot)
  startNoShowCron(bot)
  startBriefingCron(bot)
  startSundayBriefingCron(bot)
  startPreferenceCron(bot)
})
```
- **What breaks:** Telegram has a 502 at startup → promise rejects unhandled → no cron jobs ever start → no shift reminders, no missed-clock-out checks, no briefing, no escalation. Web server stays up so `/health` lies green. Manager has no idea features are dead.
- **How likely:** Likely on Render free-tier cold starts.
- **Fix:** `.catch()` that logs, exits, and lets Render restart; or retry `getMe()` until success before starting crons.

---

## Serious Issues (P1 — fix in first week)

### P1-1: Stack traces and raw DB errors leak through `res.status(500).json({ error: err.message })`
**File:** `src/server/dashRoutes.js` — at least 9 endpoints (lines 837, 1100, 1149, 1201, 1304, 1362, 1536, 1588, 1615, 1634). Line 1535 also logs `err.stack`. An attacker probing the dashboard learns table names, column names, RLS rule fragments. **Fix:** generic message to client, full error logged server-side only.

### P1-2: OTP brute-force protection is in-memory + per-phone only
**File:** `src/server/authRoutes.js`
- `otpStore` is an in-memory `Map` (line 7) — every Render restart wipes it, so an attacker can request a fresh code without waiting through the 60s cooldown.
- 5 attempts per code is fine; **but no IP rate limit** means a botnet can multiply attempts.
- 6-digit code + 10-min expiry + restart wipe = enumerable. **Fix:** persist OTP store in Supabase with TTL, add IP-based rate limit (e.g., 10 attempts/hour/IP).

### P1-3: Polling errors are logged but never recovered
**File:** `src/index.js:118-120`
```javascript
bot.on('polling_error', (err) => { logger.error(...) })
```
If polling stops, web server stays up, `/health` returns 200, but Telegram messages go unanswered. **Fix:** on polling_error, exponential-backoff `bot.startPolling()` retry; if N retries fail, exit so Render restarts.

### P1-4: `/health` only confirms the web server is alive
**File:** `src/server/webServer.js:38-39`
- Doesn't check polling status, doesn't ping Supabase, doesn't check LLM availability. Render's healthcheck passes while half the product is dead. **Fix:** structured health that fails the route on critical-dependency outage.

### P1-5: Greedy schedule generator can double-assign within a single shift
**File:** `src/schedule/generateSchedule.js` greedy loop (~line 268-337). The `alreadyAssigned` check is by shift+staff+day, but candidates are not deduplicated across requirement iterations — a single staff member who matches multiple roles for the same shift can be picked twice. **Fix:** maintain an `assignedThisShift` set and exclude before each requirement iteration.

### P1-6: `max_shifts_per_day` defaults to 0 = "no limit"
**File:** `src/schedule/generateSchedule.js:147`. Restaurants who never set this value silently get unbounded scheduling. **Fix:** default to 1, or surface the unset state in the dashboard.

### P1-7: Republish is `clear` + sequential `insert` with no transaction
**File:** `src/schedule/reviewSchedule.js:112-115`. A concurrent dashboard edit between clear and insert loses data. **Fix:** Postgres RPC or atomic upsert.

### P1-8: Cron timezone is server-time (UTC), not restaurant local time
**Files:** `src/index.js` cron schedules + `src/timeclock/missedClockOut.js`. Sunday-night preference cron, no-show alerts, missed clock-out alerts all fire at UTC offsets — wrong by hours for any non-UTC restaurant. **Fix:** read group timezone from `setup_sessions.setup_data` and pass it into cron schedules / time math.

### P1-9: No-show / missed-clock-out windows are hardcoded
**Files:** `src/noshow/noShowWarning.js:41` (30-min window), `src/timeclock/missedClockOut.js:106` (30-min grace). Should be per-group config. Some restaurants run loose; others run strict. **Fix:** read from `setup_sessions.setup_data`.

### P1-10: Clock-in is allowed without an assigned shift, hours before shift, and for shifts not assigned to user
**File:** `src/timeclock/clockHandler.js:84-109`. Staff member can clock in 5 hours early, or for a day they aren't on the schedule (`shiftId = null` is permitted). This is a wage-claim risk. **Fix:** require an assigned shift, cap clock-in to scheduled-start − N min.

### P1-11: Missed clock-out is alerted but never auto-closed
**File:** `src/timeclock/missedClockOut.js:106-125`. Staff who forgets to clock out leaves an open punch indefinitely. If manager misses the alert, payroll is wrong. **Fix:** auto-close at scheduled end + grace, with an audit-log row and DM to manager.

### P1-12: LLM has no client-level timeout
**File:** `src/parsers/llm.js:28, 38`. Cerebras/Groq client constructed without a request timeout. A hung response blocks the message handler. **Fix:** AbortSignal.timeout(8000) on each call, plus 429 retry already present.

### P1-13: Coverage broadcast does not respect Telegram's 30 msg/sec limit
**File:** `src/coverage/managerCoverage.js:253-267`, also `src/coverage/escalationCron.js:122-131`. A 50-staff broadcast fires DMs as fast as possible. After ~30 the rest get 429s; current code logs and continues — those staff never get the DM. **Fix:** simple in-process queue with 100ms spacing, or a `p-queue` with concurrency 5.

### P1-14: Phone numbers are not unique across `setup_sessions`
**File:** `src/setup/phoneSteps.js`. Same number can be registered to two groups → OTP login lookup is `.maybeSingle()` which returns ambiguous. **Fix:** unique constraint on `setup_sessions.phone` where `setup_complete = true`; reject duplicates in the wizard.

### P1-15: No graceful HTTP server shutdown
**File:** `src/server/webServer.js:44`. `app.listen()` return value is discarded; `SIGINT` handler stops polling but never closes Express. In-flight `/schedule/generate` (which can take 10–30s with LLM calls) is killed mid-request, potentially mid-Supabase-write.

### P1-16: All major deps are pinned to `"latest"`
**File:** `package.json:25,28,31,34`. Supabase, dotenv, groq-sdk, node-telegram-bot-api all float. A breaking change in any of them on the next `npm install` (Render runs this on every deploy) silently bricks production. **Fix:** pin to specific versions or `^x.y` ranges.

---

## Important Issues (P2 — fix in first month)

- **No request validation library on dashboard routes.** Hand-rolled checks per endpoint; many fields go through unchecked. (`src/server/dashRoutes.js` throughout.)
- **No CSRF token.** Cookies are `SameSite=Lax`, which mitigates the common cases, but state-changing routes (POST/PATCH/DELETE) accept any cross-origin POST that has the cookie. (`src/server/middleware.js`.)
- **`dashboard.html` uses `innerHTML` extensively** (~10 sites). Some interpolate `escapeHtml(...)`, some don't. Audit needed for XSS via staff name / shift name / revenue note.
- **No rate limit on dashboard write endpoints.** A logged-in attacker can hammer `/payroll/override`.
- **Schedule generation has no timeout.** LLM call inside a long greedy loop — UI hangs if the model is slow.
- **Render hardcoded URL in keep-alive ping** (`webServer.js:48`: `https://relay-v5ne.onrender.com/health`). Locks deploy to one Render instance; PR previews hit prod.
- **`.env.example` missing `JWT_SECRET` and `GROQ_API_KEY`**. Self-hosted users will set up without an LLM fallback or with the dev JWT secret.
- **`render.yaml` does not declare `GROQ_API_KEY`**, so the Groq fallback path is dead in production unless an operator knows to add it manually.
- **Tip pool, OT for multi-rate staff, daily-OT (CA), and tipped-minimum-wage** were not fully verified — `payCalculator` audit still in flight at write-time. Recommend a manual numeric test before first payroll cycle: 45h week, two rates, $200 cash tips, 7 splits, compare against hand calc.
- **Cron jobs are not idempotent at sub-second granularity.** Restart during a cron tick can re-fire (`noShowWarning.js:92` upsert-after-send).
- **No CSV/JSON data export for managers.** GDPR-style "give me my data" is not satisfiable.
- **Hours rounding rules are not documented or configurable.** Different states have different requirements — California, for example, prohibits time-clock rounding entirely as of 2022 case law.
- **Recognition / cross-training fire-and-forget handlers swallow all errors** — easy to silently regress without a test failing.
- **Unique constraint on `staff(group_id, name)` is not enforced.** Two "Mark"s create ambiguous coverage routing.
- **Clock-in for unassigned shifts** logs an entry with `shift_id = null` — payroll misses these or double-counts depending on join.

---

## Known Limitations to Communicate to the First Customer

1. **Free-tier Render means 30–90s cold-start** after 15 min idle. First message of the day will feel slow. Bot becomes responsive after first inbound.
2. **No SMS/WhatsApp.** Telegram-only. Staff who don't use Telegram won't get coverage DMs.
3. **No data export UI.** If they want to leave Relay, you'll have to dump it for them.
4. **No multi-location support.** One Telegram group = one restaurant.
5. **One manager per group on the dashboard.** OTP login resolves a phone → a group. Two managers sharing duties means sharing a phone (or being added to each other's groups via the bot).
6. **No support / status page yet.** Failures are silent unless the manager messages you directly.
7. **Cron jobs run in UTC.** Until P1-8 is fixed, "Sunday end-of-week" rollup happens at UTC midnight, not local.
8. **Schedule generation is best-effort.** It will sometimes leave gaps or assign suboptimally; manager review is mandatory before publish.

---

## What's Actually Good

- **Multi-tenancy isolation is solid.** Every dashboard query funnels `req.manager.groupId` from the verified JWT into a `.eq('group_id', ...)` filter (`router.use(requireAuth)` on line 9 of `dashRoutes.js`). If the JWT secret is protected (P0-1), tenants cannot cross-read.
- **Coverage double-claim race is correctly handled** with a Supabase compare-and-swap (`src/db/coverage.js:46-68`). Tests in `coverageAtomic.test.js` confirm 1 winner, N–1 losers.
- **Escalation cron uses CAS on tier advance** — idempotent under double-fire.
- **Manager admin authority is re-checked at action time** via `bot.getChatMember`, not cached.
- **Fan-out broadcasts have per-recipient try/catch** — one blocked user doesn't kill the loop.
- **Cookies are `HttpOnly; Secure; SameSite=Lax`.** Token isn't readable from JS. localStorage is only used for onboarding-dismiss state.
- **Per-handler try/catch coverage is genuinely high** in the routing layer (~30+ blocks across `dmRouter.js`, `groupRouter.js`).
- **LLM has Cerebras → Groq fallback** with 429 retry/backoff.
- **Setup wizard has a `reset|restart|clear|start over|redo` keyword** that branches to a reset flow (this part is good — the bug is that `/setup` itself does the wipe without confirmation; `reset` is fine).
- **Phone normalization** is defensive and rejects too-short numbers.
- **`env` validation at startup** for the truly required vars (Telegram, Supabase) — failure is loud.

---

## Confidence Assessment

**Overall confidence in audit: 80%.**

I read 25+ source files in full across 7 parallel audit agents (server/auth, routing/parsing, schedule, coverage, timeclock/no-show, setup, plus discovery greps and existing reports). I did not audit deeply: payroll arithmetic correctness (one agent in flight didn't finish before this report), the intelligence/insights subsystem, dashboard XSS surface, or the actual `supabase-schema.sql` for missing RLS / cascade-delete risk.

What would push confidence higher:
1. A 50-message live restaurant transcript run through the parser to validate intent classification beyond the 12 phrases mentally tested.
2. A numeric payroll test: 45h week with two rates, tip pool, late deduction — compare to hand-calculated truth.
3. RLS audit of `supabase-schema.sql` confirming every tenant-scoped table has a row-level policy, not just app-layer filters.
4. A real network-fault test: kill Supabase mid-coverage-claim, verify state is recoverable.
5. A real Telegram outage test: kill polling, verify bot recovers without manual restart.

---

## Recommended Pre-Launch Checklist

- [ ] **P0-1** Make `JWT_SECRET` mandatory at startup (`middleware.js`)
- [ ] **P0-2** Add `uncaughtException` + `unhandledRejection` process handlers (`index.js`)
- [ ] **P0-3** Wrap `handleDmMessage` / `handleGroupMessage` in try/catch (`index.js:102-116`)
- [ ] **P0-4** Add confirmation prompt before `/setup` wipes existing data (`setupFlow.js:27-31`)
- [ ] **P0-5** Compensate failed schedule swap by reverting `markCovered` (`confirmationHandler.js`)
- [ ] **P0-6** Allow cancel-after-fill; revert assignment + notify volunteer (`db/coverage.js`)
- [ ] **P0-7** Wrap trade swap in a Supabase RPC for atomicity (`tradeHandler.js`)
- [ ] **P0-8** Replace `USING (true)` RLS with per-tenant policies (`supabase-schema.sql`)
- [ ] **P0-9** Track per-role hours per staff in payroll; weighted-avg OT (`payCalculator.js`)
- [ ] **P0-10** Atomic coverage swap via Supabase RPC (`confirmationHandler.js`)
- [ ] **P0-11** `ON DELETE SET NULL` or soft-delete on `staff` / `shifts` references
- [ ] **P0-12** Move waitlist GAS call server-side; rotate the script ID (`public/index.html`)
- [ ] **P0-13** Add `.catch` to `bot.getMe()`; restart on failure so crons can start (`index.js:71-82`)
- [ ] **P1** Replace `err.message` leaks with generic messages in `dashRoutes.js`
- [ ] **P1** Persist OTP store in Supabase; add IP rate limit
- [ ] **P1** Add polling auto-recovery
- [ ] **P1** Pin `package.json` deps off `"latest"`
- [ ] **P1** Cron timezone awareness
- [ ] **P1** Telegram broadcast throttling
- [ ] **P1** Phone-number unique constraint
- [ ] **P2** RLS audit of `supabase-schema.sql`
- [ ] **P2** Replace dashboard `innerHTML` interpolations with `textContent` or escape-by-default
- [ ] **P2** Add `/cancel` keyword in setup wizard
- [ ] **P2** Add CSRF token on state-changing dashboard routes
- [ ] **Pre-launch ops:** status page, support email in dashboard footer, "data export" button
