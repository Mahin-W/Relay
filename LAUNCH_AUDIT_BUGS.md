# Relay — Pre-Launch Audit Bug List

Generated: 2026-05-08 (P0 status updated 2026-05-09)
Source: 12-agent parallel codebase audit (see `PRODUCTION_READINESS_REPORT.md` for narrative)

## Status as of 2026-05-09

**All 13 P0 blockers fixed in code.** Migrations 008 (RLS lockdown) and 009 (cascade soften + unique constraint) applied to Supabase. Pending: operator deploy.

**P1 progress as of 2026-05-15:** 4 P1s fixed (P1-1, P1-3, P1-12, P1-28). 28 P1s still open.

P0 fixes summary (per item below):
- P0-1 → `src/server/middleware.js` fail-fast
- P0-2/P0-3/P0-13 → `src/index.js` process handlers + message-handler try/catch + getMe `.catch`
- P0-4 → `src/setup/setupFlow.js` "yes wipe" confirmation
- P0-5/P0-10 → `src/coverage/confirmationHandler.js` + `src/db/coverage.js` (`revertCovered`)
- P0-6 → `src/coverage/cancelHandler.js` (cancels covered, reverse-swaps, DMs volunteer)
- P0-7 → `src/coverage/tradeHandler.js` undo-stack rollback
- P0-8 → `scripts/migrations/008_lock_down_rls.sql` + `src/db/client.js` service-role preference
- P0-9 → `src/payroll/payCalculator.js` + `src/payroll/spreadsheetGenerator.js` multi-role correctness
- P0-11 → `scripts/migrations/009_soften_cascades.sql`
- P0-12 → `src/server/marketingRoutes.js` `/api/waitlist` proxy

Each row: severity / file / one-line summary / what breaks / fix sketch.

---

## P0 — Launch blockers

### P0-1 — JWT_SECRET falls back to a hardcoded dev secret
- **File:** `src/server/middleware.js:3-4`
- **Code:** `const JWT_SECRET = process.env.JWT_SECRET || 'relay-dev-secret-change-in-production'`
- **What breaks:** If `JWT_SECRET` env var is missing on Render, tokens sign with a string that lives in source control. Any reader of the repo can forge valid 7-day JWTs for any manager at any restaurant. Multi-tenancy collapses.
- **Likelihood:** Certain on misconfigured deploys; latent on every deploy.
- **Fix:** Throw at module load if `process.env.JWT_SECRET` is missing or shorter than 32 chars. No fallback string.
- **Effort:** 5 min.

### P0-2 — No global `uncaughtException` / `unhandledRejection` handlers
- **File:** `src/index.js` (only `SIGINT` handler at line 684)
- **What breaks:** Any throw that escapes a message handler kills the Node process. Bot disappears mid-service; the manager has no notification.
- **Likelihood:** Likely — every Telegram payload, LLM response, and Supabase row is a potential throw site.
- **Fix:** Add `process.on('unhandledRejection', …)` and `process.on('uncaughtException', …)` that log + `process.exit(1)` so Render restarts.
- **Effort:** 10 min.

### P0-3 — Telegram message handler is not wrapped in try/catch
- **File:** `src/index.js:102-116`
- **Code:**
  ```js
  bot.on('message', async (msg) => {
    ...
    await handleDmMessage(...)
    await handleGroupMessage(...)
  })
  ```
- **What breaks:** A single malformed message or transient Supabase error throws → unhandled rejection → process dies (per P0-2).
- **Likelihood:** Certain over time.
- **Fix:** Wrap both calls in try/catch with structured logging; never re-throw.
- **Effort:** 5 min.

### P0-4 — `/setup` silently wipes existing staff/shifts/availability
- **File:** `src/setup/setupFlow.js:27-31`
- **Code:**
  ```js
  const existing = await getSetupSession(groupId)
  const hadData = !!existing
  if (hadData) {
    await clearGroupSetupData(groupId)   // destructive, no confirmation
  }
  ```
- **What breaks:** Manager runs `/setup` again — by accident, while showing a coworker, or because they forgot — and all staff/shifts/assignments are deleted before any prompt is shown. The bot only shows a passive note *after*.
- **Likelihood:** Will happen within month 1.
- **Fix:** If existing setup has staff or shifts, require an explicit `"yes wipe"` reply in DM before destructive call.
- **Effort:** 30 min.

### P0-5 — Coverage claim → schedule swap is not atomic
- **File:** `src/coverage/confirmationHandler.js:217-230` (calls `swapIfPossible` at `lines 10-26`)
- **What breaks:** `markCovered` succeeds (CAS-protected, good); `swapIfPossible` then runs two separate writes (`schedule_assignments` + `published_schedule`) with errors swallowed. If either fails, the coverage row says "covered" but the schedule still points at the original requester. Both staff have conflicting versions.
- **Likelihood:** Likely under any DB blip during peak hours.
- **Fix:** Compensation pattern — on swap failure, revert `coverage_requests.status` to `'open'` and surface the error.
- **Effort:** 1 hr.

### P0-6 — Coverage cancel does not work after request is filled
- **File:** `src/db/coverage.js:92-107`
- **Code:** `update({ status: 'cancelled' }) … .eq('status', 'open')` — only matches open rows.
- **What breaks:** Alice posts coverage. Bob accepts → status = `covered`. Alice messages "actually I'm coming in" → cancel finds zero rows. Bob is still on the schedule. Alice arrives. Bob arrives. One gets sent home and is rightly upset, or both no-show because each thinks the other has it.
- **Likelihood:** Will happen monthly per active customer.
- **Fix:** Allow cancellation of `'covered'` rows; on cancel, revert `schedule_assignments` to original requester and DM the volunteer.
- **Effort:** 1 hr.

### P0-7 — Trade swap is four sequential writes with no rollback
- **File:** `src/coverage/tradeHandler.js:233-242`
- **What breaks:** Step 3 fails after steps 1–2 commit → half-completed swap → both staff have wrong assignments → no rollback path.
- **Likelihood:** Rare per attempt; certain over time.
- **Fix:** Move all four updates into a Postgres function (Supabase RPC) so the swap is all-or-nothing.
- **Effort:** 2 hr.

### P0-8 — Supabase RLS grants `anon` full read+write on every table
- **File:** `supabase-schema.sql:616-644`
- **Code:** `CREATE POLICY ... FOR ALL TO anon USING (true) WITH CHECK (true)` — applied to every table by `pg_tables` loop.
- **What breaks:** Anyone with the Supabase URL + the anon key (which is shipped in production env vars) can read AND write every row across every tenant: phones, payroll, schedules, tips, time clock. App-layer auth via JWT is the only protection. If the URL is leaked, exposed in client bundles, or guessed, the database is wide open.
- **Likelihood:** Certain — anon keys are not designed to be secret; RLS is supposed to enforce isolation.
- **Fix:** Replace `USING (true)` with per-tenant policies, e.g. `USING (group_id = (auth.jwt() ->> 'groupId'))`. Use service-role key only on trusted server paths.
- **Effort:** Half a day.

### P0-9 — Multi-role staff are paid at the wrong rate
- **File:** `src/payroll/payCalculator.js:304-306`
- **Code:**
  ```js
  staffMap[staffId] = { staffId, staffName, roleName, hourlyRate: roleObj.hourlyRate, rawAssignments: [] }
  ```
- **What breaks:** A staff member who works two roles in one week (server $15 + bartender $20) has `roleName`/`hourlyRate` overwritten by the *last* assignment processed. All hours price at that single rate. Cross-trained staff are paid 7%–25% wrong, every week. FLSA requires the weighted-average method for OT premium across mixed rates; this implementation can't do that because it has no per-role hours map.
- **Likelihood:** Certain wherever staff hold more than one role.
- **Fix:** Replace single-rate `staffMap` entry with `{ shifts: [{ role, hours, rate }] }`; compute regular pay per role, then OT premium on weighted average rate above 40h.
- **Effort:** 1 day.

### P0-10 — Coverage schedule swap is two separate writes
- **File:** `src/coverage/confirmationHandler.js:10-26` (`swapIfPossible`)
- **What breaks:** `swapScheduleAssignment` (mutates `schedule_assignments`) and `swapPublishedScheduleAssignment` (mutates the published JSONB) are sequential. If the second fails, dashboard view and authoritative table disagree. Compounds with P0-5: even when both succeed, the preceding `markCovered` is already committed.
- **Fix:** Wrap both writes in a single Postgres function (Supabase RPC). Use the P0-5 compensation pattern as a backstop.
- **Effort:** 2 hr.

### P0-11 — Cascading deletes destroy historical payroll
- **File:** `supabase-schema.sql:35, 211, 366, 385, 402, 416, 483 …`
- **What breaks:** Deleting one `staff` or `shift` row cascades to `payroll_records`, `schedule_assignments`, `time_entries`, `coverage_requests`, etc. A manager who clicks "remove staff" or "delete shift" wipes every historical pay record tied to that row. No undo. Wage-claim defence becomes "we have no records."
- **Fix:** `ON DELETE SET NULL` or soft-delete with `deleted_at`. Add a confirmation modal that shows affected row count.
- **Effort:** Half a day plus a migration.

### P0-12 — Landing page hardcodes a public Google Apps Script URL
- **File:** `public/index.html:1049`
- **What breaks:** Waitlist signup posts to a hardcoded GAS endpoint visible in `view-source`. No origin check; anyone can spam, exhaust GAS quota, DoS the form, or replay submissions.
- **Fix:** Proxy waitlist through `/api/waitlist`; rotate the Apps Script ID immediately after the source change is deployed.
- **Effort:** 30 min plus a redeploy.

### P0-13 — `bot.getMe()` has no `.catch` → crons never start on transient Telegram failure
- **File:** `src/index.js:71-82`
- **What breaks:** Telegram returns 502 at startup → unhandled rejection (no `.catch`) → no crons registered → no shift reminders, no missed-clock-out checks, no briefing, no escalation. Web server stays up so `/health` lies green. Manager has no idea features are dead.
- **Likelihood:** Likely on Render free-tier cold starts.
- **Fix:** `.catch()` that logs + exits so Render restarts; or retry `getMe()` until success before starting crons.
- **Effort:** 15 min.

---

## P1 — Fix in week 1

### P1-1 — Stack traces and raw DB errors leak through dashboard responses — ✅ FIXED 2026-05-15
- **File:** `src/server/dashRoutes.js` lines 837, 1100, 1149, 1201, 1304, 1362, 1521, 1536, 1588, 1615, 1634 (also `err.stack` logged at 1535)
- **Pattern:** `res.status(500).json({ error: err.message })` returns raw Supabase / SQL errors to the client.
- **What breaks:** Attacker probing the dashboard learns table names, column names, RLS rule fragments. Aids enumeration and crafted payload attacks.
- **Fix:** All 11 sites now return generic route-specific strings; full errors continue to be logged server-side. Sibling `insertErr.message` leak at line 1521 fixed in the same commit.

### P1-2 — OTP brute-force protection is in-memory + per-phone only
- **File:** `src/server/authRoutes.js:7,30-34,99-103`
- `otpStore` is an in-memory `Map` — every Render restart wipes it; an attacker can request a fresh code without waiting through the 60s cooldown.
- 5 attempts per code is fine, but **no IP rate limit** lets a botnet multiply attempts.
- **Fix:** Persist OTP store in Supabase with TTL; add IP-based rate limit (~10 attempts/hour/IP); consider a magic-link backup.

### P1-3 — Polling errors are logged but never recovered — ✅ FIXED 2026-05-15
- **File:** `src/index.js:176-246`
- **What breaks:** If polling stops, web server stays up, `/health` returns 200, but Telegram messages go unanswered.
- **Fix:** Self-healing handler — stopPolling/startPolling with exponential backoff (2/4/8/16/30s cap), tracks consecutive failures with a 60s settling-window reset, `process.exit(1)` after `POLLING_MAX_FAILURES` (default 5) so Render restarts.

### P1-4 — `/health` only confirms the web server is alive
- **File:** `src/server/webServer.js:38-39`
- **What breaks:** `/health` doesn't check polling status, doesn't ping Supabase, doesn't check LLM availability. Render's healthcheck passes while half the product is dead.
- **Fix:** Structured health that fails the route on critical-dependency outage.

### P1-5 — Greedy schedule generator can double-assign within a single shift
- **File:** `src/schedule/generateSchedule.js:268-337`
- **What breaks:** `alreadyAssigned` is keyed by shift+staff+day, but candidates are not deduped across requirement iterations — one staff member can be picked twice if they match multiple roles.
- **Fix:** `assignedThisShift` set; exclude before each requirement iteration.

### P1-6 — `max_shifts_per_day` defaults to 0 = "no limit"
- **File:** `src/schedule/generateSchedule.js:147`
- **What breaks:** Restaurants who never set this value get unbounded scheduling.
- **Fix:** Default to 1, or surface unset state in dashboard.

### P1-7 — Republish is `clear` + sequential `insert` with no transaction
- **File:** `src/schedule/reviewSchedule.js:112-115`
- **What breaks:** Concurrent dashboard edit between clear and insert loses data.
- **Fix:** Postgres RPC or atomic upsert with `on_conflict`.

### P1-8 — Cron timezone is UTC, not restaurant local time
- **Files:** `src/index.js` cron schedules, `src/timeclock/missedClockOut.js`, `src/noshow/noShowWarning.js`
- **What breaks:** Sunday-night preference cron, no-show alerts, missed-clock-out alerts fire at UTC offsets — wrong by hours for any non-UTC restaurant.
- **Fix:** Read group timezone from `setup_sessions.setup_data`; pass it into cron schedules and time math.

### P1-9 — No-show / missed-clock-out windows are hardcoded 30 minutes
- **Files:** `src/noshow/noShowWarning.js:41`, `src/timeclock/missedClockOut.js:106`
- **What breaks:** No per-group config; loose vs strict restaurants get the same alerting.
- **Fix:** Read window from `setup_sessions.setup_data`.

### P1-10 — Clock-in is allowed without an assigned shift, hours before shift, and for shifts not assigned to user
- **File:** `src/timeclock/clockHandler.js:84-109`
- **What breaks:** Staff can clock in 5 hours early or for a day they aren't on the schedule (`shift_id = null` is permitted). Wage-claim risk.
- **Fix:** Require an assigned shift; cap clock-in to scheduled-start − N min.

### P1-11 — Missed clock-out is alerted but never auto-closed
- **File:** `src/timeclock/missedClockOut.js:106-125`
- **What breaks:** Staff who forgets to clock out leaves an open punch indefinitely. If manager misses the alert, payroll is wrong.
- **Fix:** Auto-close at scheduled end + grace; audit-log row + DM to manager.

### P1-12 — LLM has no client-level timeout — ✅ FIXED 2026-05-15
- **File:** `src/parsers/llm.js` (`cerebrasCreate`, `groqCreate`)
- **What breaks:** Cerebras/Groq client constructed without request timeout. A hung response blocks the message handler.
- **Fix:** `AbortSignal.timeout(LLM_TIMEOUT_MS)` (default 8000ms) injected as the OpenAI SDK's `{ signal }` request option on every call. Callers can override via `params.signal`.

### P1-13 — Coverage broadcast does not respect Telegram's 30 msg/sec limit
- **Files:** `src/coverage/managerCoverage.js:253-267`, `src/coverage/escalationCron.js:122-131`
- **What breaks:** A 50-staff broadcast fires DMs as fast as possible. After ~30, the rest get 429s; current code logs and continues. Those staff never get the DM.
- **Fix:** In-process queue with 100ms spacing, or a `p-queue` with concurrency 5.

### P1-14 — Phone numbers are not unique across `setup_sessions`
- **File:** `src/setup/phoneSteps.js`
- **What breaks:** Same number can be registered to two groups → OTP login lookup is `.maybeSingle()` which returns ambiguous results.
- **Fix:** Unique constraint on `setup_sessions.phone where setup_complete = true`; reject duplicates in the wizard.

### P1-15 — No graceful HTTP server shutdown
- **File:** `src/server/webServer.js:44`
- **What breaks:** `app.listen()` return value is discarded. `SIGINT` stops polling but never closes Express. In-flight `/schedule/generate` (10–30s with LLM) gets killed mid-request, potentially mid-Supabase-write.
- **Fix:** Capture the server, `server.close(...)` in SIGINT handler with timeout, then `process.exit`.

### P1-16 — All major deps are pinned to `"latest"`
- **File:** `package.json:25,28,31,34`
- **What breaks:** Supabase, dotenv, groq-sdk, node-telegram-bot-api all float. A breaking change on the next `npm install` (Render runs this every deploy) silently bricks production.
- **Fix:** Pin to specific versions or `^x.y` ranges.

### P1-17 — Callout predictor flags new staff unfairly
- **File:** `src/intelligence/calloutPredictor.js:130-206`
- **What breaks:** Staff with <3 callout observations can still hit "medium" risk on neutral defaults — a new hire with one coincidental callout shows up flagged in pre-publish briefings.
- **Fix:** Cap risk to `'low'` while `totalObservations < 3`.

### P1-18 — Intelligence tables grow unbounded
- **Files:** `morale_events`, `weekly_quality_scores`, `schedule_edit_events`, `discovered_patterns`
- **What breaks:** No pruning policy. Reads window 8–12 weeks but tables grow forever. Performance degrades within the first year.
- **Fix:** Add a server-side cron to prune rows older than ~2 years; index `created_at` on each table.

### P1-19 — Setup wizard has no `/cancel` escape
- **File:** `src/setup/setupFlow.js`
- **What breaks:** Manager who closes Telegram or loses focus has no documented way to abort or restart.
- **Fix:** Recognize `cancel|abort|exit|nevermind`; reset session step.

### P1-20 — Spreadsheet `Gross` formula subtracts `lateDeduction` that was never added
- **File:** `src/payroll/spreadsheetGenerator.js:188`
- **Code:** `row.getCell(13).value = { formula: \`E${rowNum}+G${rowNum}+I${rowNum}-K${rowNum}\` }` — gross = reg + dailyOT + weeklyOT − lateDeduction.
- **Conflict:** `payCalculator.js:226` defines `grossPay = round2(regularPay + dailyOTPay + weeklyOTPay)` (late deduction is metadata only).
- **What breaks:** Excel export shows a smaller "gross" than the dashboard for any week with a late deduction. Manager / accountant reconciliation fails or, worse, payroll runs from the spreadsheet at the wrong number.
- **Fix:** Drop the `-K…` from the formula; render late deduction as a separate non-summed line.

### P1-21 — Mid-week rate change reprices the entire week (potential wage theft)
- **File:** `src/payroll/retroFix.js:111-118`
- **What breaks:** When a manager updates a role rate mid-week, the fallback path multiplies *all* recorded hours by the new rate — including hours already worked at the old rate. If the change is downward, the employee is retroactively underpaid for past hours; many states forbid this.
- **Fix:** Track `rate_effective_date` and split hours into pre-/post- segments; only apply the new rate prospectively.

### P1-22 — Tip-pool rounding picks the *post-rounding* max, not the actual top earner
- **File:** `src/operations/tipPool.js:119-134`
- **What breaks:** When sums are equal after rounding (common with even splits), the leftover penny is awarded to whichever index appears first, not to the genuine top earner. Cumulative drift over weeks; staff who care will notice.
- **Fix:** Track the largest pre-rounding amount as the recipient; or distribute leftover cents pro-rata across all recipients with banker's rounding.

### P1-23 — `concrete` minimum-wage validation is absent
- **File:** `src/payroll/payCalculator.js:43`
- **What breaks:** Manager can set a role rate to $5 (typo) or below state minimum and the system silently calculates pay against it. No warning to manager.
- **Fix:** Validate at rate save time against federal $7.25 floor; add a per-state minimum-wage table; warn loudly in dashboard + bot.

### P1-24 — Late deductions can pull gross below minimum wage
- **File:** `src/payroll/payCalculator.js:56-59`
- **What breaks:** `grossPay = max(0, hoursWorked - lateHours) * rate` — a 4-hour late penalty on an 8-hour shift drops gross to $7.50/hr. Below state minimum wage in most states; outright illegal in California where time-clock rounding against employees was banned in 2022.
- **Fix:** Cap late deduction so gross/hour ≥ state min wage; surface an "illegal-deduction risk" banner if state is unset or set to a high-min-wage state.

### P1-25 — Concurrent coverage confirmations both produce a public confirmation message
- **File:** `src/coverage/confirmationHandler.js:217-248`
- **What breaks:** `markCovered` is atomic, but multiple volunteers send a confirmation message into the group: the loser hits `markCovered` → `null` and then *also* falls through to a follow-up `sendMessage`. The group sees two "covered" notices for the same shift; staff are confused about who's working.
- **Fix:** Move all confirmation-side messaging behind the `if (!marked)` branch; on loss, only the volunteer's DM gets "already covered."

### P1-26 — Unguarded `bot.sendMessage` in DM router fallback
- **File:** `src/routing/dmRouter.js:477-479`
- **What breaks:** Final-fallback message is not wrapped in try/catch. If the user has blocked the bot, this rejects → unhandled rejection (per P0-2/P0-3).
- **Fix:** Wrap or `.catch(() => {})`.

### P1-27 — `preFilter` skip-set drops valid casual confirmations
- **File:** `src/preFilter.js:2-10`
- **What breaks:** Replies like "bet", "fasho", "no cap" — used as confirmations by many staff — never reach the parser. Coverage requests can expire uncovered because the confirmation was filtered out as filler.
- **Fix:** Either move slang confirmations to the parser path or invert the filter (skip only when no shift-signal token is present).

### P1-28 — Cerebras path silently strips `response_format: json_object` — ✅ FIXED 2026-05-15
- **File:** `src/parsers/llm.js` (`llmCreate`, `cerebrasCreate`)
- **Code:** `const { response_format, model, ...rest } = params` — `response_format` is destructured out before the call to Cerebras.
- **What breaks:** CLAUDE.md mandates `response_format: { type: "json_object" }` on every LLM call. Cerebras silently emits free-form text. `extractJSON()` falls back to a regex `{...}` grab, then `JSON.parse` either crashes or returns garbage. Setup parsers can return `[]` shifts and the wizard moves on as if everything saved.
- **Fix:** `llmCreate` now inspects `params.response_format?.type === 'json_object'` and routes directly to Groq when JSON mode is requested and Groq is configured, bypassing Cerebras entirely. When only Cerebras is available, the strip is now logged via `logger.warn` instead of being silent. `cerebrasCreate` retains its destructure (Cerebras would error on the field) but also logs a warn when it drops the directive.

### P1-29 — Schedule reminder dedup set is in-memory only
- **File:** `src/reminders/shiftReminders.js:5-11`
- **What breaks:** `sentToday` / `sentNightBefore` are JS `Set`s. A Render restart between cron tick and dedup-write resends every reminder. Free-tier sleep-wake cycles guarantee this happens daily.
- **Fix:** Persist sent IDs to a `reminder_sends` table keyed by `(assignment_id, kind, date)` with a unique constraint.

### P1-30 — Reliability score is opaque to the staff being scored
- **File:** `src/reliability/reliabilityScore.js`
- **What breaks:** Staff are scored with no visibility into the algorithm or their own number. Discovery via dashboard or rumor breeds distrust; legally questionable in some jurisdictions if used for discipline.
- **Fix:** Document the formula in onboarding; let staff query their own score (e.g., `/myscore`); add a "new hire grace period" so the first 14 days don't generate negative events.

### P1-31 — Recognition has no cooldown and broadcasts publicly
- **File:** `src/engagement/recognition.js:68, 313, 318`
- **What breaks:** Manager spam (50 "kudos" in 10 seconds) all save and broadcast. Sarcasm slips past the 25-char negation window. Public broadcast surfaces names and details that some staff would prefer kept private.
- **Fix:** Per-staff 60s cooldown; require an explicit "for X" clause; manager-configurable public vs. DM-only mode.

### P1-32 — Missed availability submitted after schedule generation does not trigger regeneration
- **File:** `src/availability/db/records.js`, `src/schedule/generateSchedule.js`
- **What breaks:** Late availability is stored but ignored; manager has to manually rerun `/makeschedule`. No warning is shown that fresh data exists.
- **Fix:** Surface a "stale schedule" banner in the dashboard when newer availability exists.

---

## P2 — Fix in month 1

- **No request validation library** on dashboard routes — hand-rolled checks per endpoint, many fields unchecked. (`src/server/dashRoutes.js`)
- **No CSRF token.** Cookies are `SameSite=Lax`, but state-changing routes accept any cross-origin POST that has the cookie.
- **`dashboard.html` uses `innerHTML`** in ~10 places. Some interpolate `escapeHtml(...)`, some don't. Need an XSS audit on staff names, shift names, revenue notes.
- **No rate limit on dashboard write endpoints.** A logged-in attacker can hammer `/payroll/override`.
- **Schedule generation has no end-to-end timeout.** Slow LLM means UI hangs.
- **Render keep-alive ping is hardcoded** to `https://relay-v5ne.onrender.com/health` (`src/server/webServer.js:48`). PR previews ping prod; deploys to a new host break the ping.
- **`.env.example` missing `JWT_SECRET` and `GROQ_API_KEY`.** Self-hosted users will set up without LLM fallback or with the dev JWT secret.
- **`render.yaml` does not declare `GROQ_API_KEY`** — the Groq fallback path is dead unless an operator knows to add it manually.
- **Tip pool, multi-rate OT, daily-OT (CA), tipped minimum wage** — payroll arithmetic was not deeply audited. Recommend a numeric test against hand-calculated truth before first payroll cycle.
- **Cron jobs are not idempotent at sub-second granularity.** Restart during a tick can re-fire (`noShowWarning.js:92` upsert-after-send).
- **No CSV/JSON data export for managers.** GDPR-style "give me my data" requests are unmet.
- **Hours rounding rules are not documented or configurable.** California outright prohibits time-clock rounding (2022 case law).
- **Recognition / cross-training fire-and-forget handlers swallow all errors** — silent regressions possible.
- **No unique constraint on `staff(group_id, name)`** — two "Mark"s create ambiguous coverage routing.
- **Clock-in for unassigned shifts** logs an entry with `shift_id = null` — payroll misses these or double-counts on join.
- **Missing or weak server timezone configuration.** Server is UTC; many time strings stored without TZ context.
- **Implicit-constraints discovery is O(staff² × assignments²)** (`src/intelligence/implicitConstraints.js:49-71`). Slow on 50+ staff teams; can block Sunday briefing cron.
- **Sunday-night briefing LLM call has no per-call timeout.** A degraded model means briefings never go out.
- **Morale cold-start defaults to 50/100** (`src/intelligence/moraleTracker.js:150`). Quality returns 100 on cold start. The two contradictory defaults will confuse new managers.
- **Setup wizard has no shift `start < end` validation.** "5pm–2pm" is silently accepted.
- **Setup wizard does not block duplicate staff names.**
- **Setup wizard does not validate phone uniqueness.** (See P1-14 for the auth-side bug.)
- **Setup session has 120s inactivity timeout but no warning and no cleanup.** Stale state lingers; a manager returning hours later resumes mid-flight.

---

## P3 — Nice to have

- **Bot blocked / kicked from group** — most fan-out paths handle per-recipient errors, but some single-message replies (e.g., `/briefing` reply at `index.js:129`) aren't wrapped.
- **Telegram update_id deduplication** — none. Telegram retransmissions are rare but possible.
- **Manager removes staff then re-adds** — historical rows remain; new staff row with same name creates ambiguity.
- **Bot is removed from a group** — no cleanup of `setup_sessions` row; stale cron runs continue indefinitely.
- **Manager admin re-validation on silent return** — non-admin who tries an admin command gets a silent return (`managerCoverage.js:198`). Better UX to reply with "admin only".
- **Recognition false positives** — sarcastic praise ("nice try") could surface as recognition.

---

## Verified-good areas

- **Multi-tenancy app-layer isolation:** every `dashRoutes` query funnels `req.manager.groupId` through `.eq('group_id', …)` after `router.use(requireAuth)` (`src/server/dashRoutes.js:9`). Solid if JWT is protected (P0-1).
- **Coverage double-claim race:** Supabase compare-and-swap in `markCovered` (`src/db/coverage.js:46-68`) — verified by `coverageAtomic.test.js`.
- **Escalation cron tier advance:** CAS-guarded; idempotent under double-fire.
- **Manager admin authority** is re-checked at the moment of action via `bot.getChatMember`, not cached.
- **Per-handler try/catch coverage** in routing layer is genuinely high (~30+ blocks across `dmRouter.js` / `groupRouter.js`).
- **LLM fallback chain:** Cerebras → Groq with 429 retry/backoff. Malformed JSON returns `irrelevant` rather than crashing.
- **Cookies:** `HttpOnly; Secure; SameSite=Lax`. Token isn't readable from JS. localStorage only used for onboarding-dismiss state.
- **Phone normalization** is defensive; rejects too-short numbers.
- **Startup env validation** — failure is loud for required vars (Telegram, Supabase, LLM key).

---

## Counts

- **P0:** 13 (all fixed)
- **P1:** 32 (4 fixed: P1-1, P1-3, P1-12, P1-28 — 28 open)
- **P2:** ~25
- **P3:** ~6

All 12 audit agents completed. Findings span server, routing/parsing, schedule, coverage, payroll, timeclock, setup wizard, intelligence, reliability/reminders/briefing/rules, dashboard HTML, schema/RLS, and discovery (greps + existing reports).

The single most important issue is **P0-8 (RLS)**: every other security control is downstream of database isolation. Fix it first.
