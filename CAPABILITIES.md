# Relay — Capabilities & Status
Last updated: 2026-06-18

> **2026-06-18 state:** Live on Render (backend) + Netlify (frontend) + Supabase. RLS migrations 008/009 applied; migration 030 adds the `rekey_group()` function. The web setup wizard was rebuilt roles-first with AI shift parsing, and onboarding now runs on a **single source of truth**: every account is provisioned a `group_id` at signup, the wizard writes live operational rows via `/api/account/setup/*`, and connecting a Telegram group **rekeys** that data onto the real chat id (the old `setup_data`→tables staging/merge step is gone).

## Feature Status

| Feature | Status | File(s) | Notes |
|---------|--------|---------|-------|
| Setup wizard (Telegram) | ✅ WIRED | src/setup/setupFlow.js, src/setup/shiftSteps.js, src/setup/staffSteps.js | 6-step state machine: welcome → add_shifts → shift_roles → role_rates → add_staff → overtime_setup → complete. Re-running `/setup` on a populated group requires explicit "yes wipe" confirmation. |
| Setup wizard (web) | ✅ WIRED | public/onboarding.html, public/onboarding.js, public/onboardingHelpers.js, src/server/setupRoutes.js | Roles-first 6-step wizard: business → roles → employees → shifts → pay rates → review/connect. Writes live operational rows via `/api/account/setup/*`. AI "describe your shifts/team" via parse-shifts/parse-staff. Bulk multi-day shift tooling, business-type templates, instant resume. |
| Account auth (web) | ✅ WIRED | src/server/middleware.js, src/server/accountRoutes.js, public/login.html, public/relayAuth.js | Supabase Auth (Google / email+password) → Bearer token verified server-side. Optional login confirmation code (2FA) via Telegram DM or email. Legacy phone-OTP sessions still accepted. |
| Account→group provisioning + rekey | ✅ WIRED | src/server/db/accounts.js (ensureAccountGroup, isProvisionalGroup), src/setup/connectAccount.js, src/setup/db/rekey.js | Every account owns a `group_id` (`web:<uuid>`) from signup, so the dashboard/wizard write live data immediately. Connecting Telegram rekeys every `group_id` row onto the chat id via the `rekey_group()` Postgres fn — replaces the old `mergeFromAccount` staging translator. |
| Admin management | ✅ WIRED | src/setup/db/admins.js | /addadmin, /removeadmin, /admins. Manager-only grant/revoke. |
| Pre-filter | ✅ WIRED | src/preFilter.js | shouldSkip() — 4-layer noise filter: triggers whitelist, laugh regex, pure emoji regex, 42 known fillers. Saves ~40-50% LLM calls. |
| NLP intent parsing | ✅ WIRED | src/parsers/messageParsers.js | parseMessage() via Cerebras (llama-3.3-70b). 14 intent types. Slang/AAVE-aware. |
| Group message routing | ✅ WIRED | src/routing/groupRouter.js | Routes 12 intent types to handlers. Handles pending clarification resolution. |
| DM message routing | ✅ WIRED | src/routing/dmRouter.js | Pattern matching: setup sessions, availability replies, receipt confirmations, time-off approval, pay queries, schedule queries, coverage confirmations, trade offers |
| Command routing | ✅ WIRED | src/routing/commandRouter.js | 12 commands: /register, /availability, /resetavailability, /makeschedule, /schedule, /receipts, /hours, /addadmin, /removeadmin, /admins, /setup, /help |
| Coverage requests | ✅ WIRED | src/coverage/requestHandler.js | Group message → DB record → group post → DM outreach to all staff. On-call staff get priority. |
| Coverage confirmation | ✅ WIRED | src/coverage/confirmationHandler.js | Group or DM confirmation → marks covered → schedule swap → group notification |
| Coverage cancellation | ✅ WIRED | src/coverage/cancelHandler.js, src/db/coverage.js | Managers can cancel any; staff can cancel own. Cancels open OR covered: if covered, reverse-swaps schedule_assignments back to original requester and DMs the volunteer. |
| Coverage atomicity | ✅ WIRED | src/coverage/confirmationHandler.js, src/db/coverage.js (markCovered, revertCovered) | `markCovered` is CAS-atomic (`.eq('status','open')`). On schedule-write failure, `revertCovered` rolls the request back to 'open' so we never end up "covered" with the wrong staff still on the schedule. |
| Trade swap atomicity | ✅ WIRED | src/coverage/tradeHandler.js | Four-step trade swap records undo callbacks; on mid-flight failure runs them in reverse, then reports failure to the user. |
| Partial coverage | ✅ WIRED | src/coverage/partialCoverage.js | Partial time ranges, tracks portions until fully covered |
| Shift resolution | ✅ WIRED | src/coverage/shiftResolver.js | Day matching + fuzzy matching. 5-min TTL pending clarification in-memory. |
| Shift trading | ✅ WIRED | src/coverage/tradeHandler.js | Trade requests, trade offers, coverage-trade hybrid, DM trade offers |
| Availability collection | ✅ WIRED | src/availability/collectAvailability.js | /availability → DM each staff → parse response (numbers, "all", "off") → save to DB |
| Passive availability capture | ⚠️ NOT WIRED | src/availability/passiveAvailability.js | Captures group mentions ("I'm free Monday"), saves to passive_availability table, but NOT read by generateWeeklySchedule — data sits unused |
| Schedule generation | ✅ WIRED | src/schedule/generateSchedule.js | Greedy algorithm: load data → resolve staff → build availability map → sort by day → assign by role with fairness sort → apply rotation → detect clopenings/hours issues → save draft |
| Schedule review/edit | ✅ WIRED | src/schedule/reviewSchedule.js | Manager DM flow: approve, approve anyway, regenerate, or natural language edits parsed by LLM (add/remove person from shift) |
| Schedule publish | ✅ WIRED | src/schedule/reviewSchedule.js | Updates status → clears old assignments → saves new → posts to group → DMs each staff → calculates payroll → sends reports |
| Copy schedule | ✅ WIRED | src/schedule/copySchedule.js | Clones previous week's assignments, detects stale staff (no longer active), saves as draft |
| Clopening detection | ✅ WIRED | src/schedule/clopen.js | Pure function: flags <10hr rest between close→open shifts. Displayed in draft review. |
| Hours tracking | ✅ WIRED | src/schedule/hoursTracker.js | Pure function: calculates weekly hours, detects overtime (≥40hr) and under-scheduling (<8hr). Used in /makeschedule and /hours. |
| Rotation fairness | ✅ WIRED | src/fairness/rotationTracker.js | Tracks desirable shifts (Fri/Sat, evening/night, end ≥9pm). Swaps assignments to balance across staff. /rotation command shows report. |
| Read receipts | ✅ WIRED | src/schedule/readReceipts.js | Personal schedule DMs → staff reply "got it" → marked confirmed. /receipts shows unconfirmed. |
| Receipt reminders | ⚠️ NOT WIRED | src/schedule/readReceipts.js | sendReceiptReminders() exported but never called from any cron or command |
| Self-service schedule/hours | ✅ WIRED | src/schedule/selfService.js | Staff DM "my schedule"/"my hours" → personal lookup and response |
| Payroll calculation (basic) | ✅ WIRED | src/payroll/payCalculator.js | calculateWeeklyPay() — shift duration × role rate − late deductions. Legacy entry point. |
| Payroll with overtime | ✅ WIRED | src/payroll/payCalculator.js, src/schedule/reviewSchedule.js:151 | `calculateWeeklyPayWithOT()` is the production path on schedule publish. Daily + weekly OT thresholds, multi-rate aware (returns `rolesWorked` + `weightedRegularRate`). |
| Multi-role payroll | ✅ WIRED | src/payroll/payCalculator.js, src/payroll/spreadsheetGenerator.js | Cross-trained staff get correct totals: per-shift rate, per-role hours, weighted-average display rate. Spreadsheet writes literal computed values (no formula drift). |
| Payroll DB | ✅ WIRED | src/payroll/payDb.js | savePeriodPayroll, getPayrollForWeek, getPayrollHistory, getLateEventsForWeek — all called |
| Pay reports | ✅ WIRED | src/payroll/payReport.js | formatWeeklyPayReport, sendPayReport — called on publish. /pay command. |
| Payroll spreadsheet | ✅ WIRED | src/payroll/spreadsheetGenerator.js | 3-sheet Excel: Schedule, Payroll, Late Arrivals. ExcelJS. Sent on publish + /spreadsheet command. |
| Staff pay self-service | ✅ WIRED | src/payroll/staffPayService.js | DM "my pay" / "pay history" → personal breakdown. isPayQuery/isHistoryQuery pattern matching. |
| Time off requests | ✅ WIRED | src/timeOff/handleTimeOff.js | Group request → manager DM approval → staff notification. approve/deny via DM. |
| Late arrival | ✅ WIRED | src/lateArrival/handleLateArrival.js | "running late" intent → quiet group ack → detailed manager DM (shift info, ETA, original text) |
| No-show warning | ✅ WIRED | src/noshow/noShowWarning.js | Cron every 15min. Checks upcoming shifts, warns manager DM if no confirmation. Records reliability event. |
| Reliability scoring | ✅ WIRED | src/reliability/reliabilityScore.js, reliabilityDb.js | 0-100 score, baseline 70, recent events 2x weight. /reliability command (manager-only). |
| Daily briefing | ✅ WIRED | src/briefing/dailyBriefing.js | Cron at 8am. Today's shifts, open coverage, pending time-off, unconfirmed receipts, open trades. /briefing command. |
| New hire onboarding | ✅ WIRED | src/onboarding/handleNewHire.js | NLP detection + /welcome command + /start register_* DM registration. Tracks pending onboarding in DB. |
| On-call tracking | ✅ WIRED | src/oncall/handleOnCall.js | NLP "on_call_offer" intent → saves on-call record → prioritized in coverage outreach |
| Shift reminders | ✅ WIRED | src/reminders/shiftReminders.js | 3 crons: midnight dedup clear, 8pm night-before, every 30min 2-hour warning |
| Registration | ✅ WIRED | src/routing/commandRouter.js, dmRouter.js | /register generates link, /start register_* completes in DM |

## Command Reference (Technical)

### index.js commands
| Command | Handler function | File | Guard |
|---------|-----------------|------|-------|
| /briefing | sendDailyBriefing(bot, groupId) | src/briefing/dailyBriefing.js | Group only; isAuthorizedAdmin |
| /pay | sendPayReport(bot, groupId, weekArg) | src/payroll/payReport.js | Group only; manager_id === userId; requires dm_chat_id |
| /staffpay [name] | formatStaffPayHistory(name, history) | src/payroll/payReport.js | Group only; manager_id === userId; requires dm_chat_id |
| /setrate [role] [amount] | updateRoleRate(groupId, roleName, amount) | src/setup/db/roles.js | Group only; manager_id === userId |
| /reliability | formatReliabilityReport(scores) | src/reliability/reliabilityScore.js | Group only; manager_id === userId; requires dm_chat_id |
| /rotation | handleRotationCommand(bot, msg) | src/fairness/rotationTracker.js | Group only |
| /copyschedule | handleCopySchedule(bot, msg) | src/schedule/copySchedule.js | Group only |
| /welcome [name] | handleWelcomeCommand(bot, msg, name) | src/onboarding/handleNewHire.js | Group only |
| /setovertime | startOvertimeStep(bot, dm_chat_id, groupId, setup_data) | src/setup/setupFlow.js | Group only; requires manager session |
| /spreadsheet [weekStart] | sendPayrollSpreadsheet(bot, groupId, weekStart) | src/payroll/spreadsheetGenerator.js | Group only; isBotAdmin |

### commandRouter.js commands
| Command | Handler function | File | Guard |
|---------|-----------------|------|-------|
| /register | (generates deep link) | commandRouter.js | None |
| /availability | startAvailabilityCollection() | src/availability/collectAvailability.js | isAuthorizedAdmin |
| /resetavailability | resetAvailabilityForGroup() | src/availability/availabilityDb.js | isAuthorizedAdmin |
| /makeschedule | generateWeeklySchedule() + formatScheduleMessage() | src/schedule/generateSchedule.js | isAuthorizedAdmin |
| /schedule | getPublishedSchedule() + formatScheduleMessage() | src/schedule/generateSchedule.js | None |
| /receipts | getUnconfirmedStaff() | src/schedule/readReceipts.js | isAuthorizedAdmin |
| /hours | calculateWeeklyHours() + formatHoursWarning() | src/schedule/hoursTracker.js | isAuthorizedAdmin |
| /addadmin | addBotAdmin() | src/setup/db/admins.js | manager_id only |
| /removeadmin | removeBotAdmin() | src/setup/db/admins.js | manager_id only |
| /admins | getBotAdmins() | src/setup/db/admins.js | None |
| /setup | startSetupDM() | src/setup/setupFlow.js | isGroupAdmin |
| /help, /commands | (inline help text) | commandRouter.js | None |

## Intent Types

| Intent type | Parsed in | Handler | Router |
|-------------|-----------|---------|--------|
| coverage_request | messageParsers.js | handleCoverageRequest() | groupRouter.js |
| coverage_confirmation | messageParsers.js | handleCoverageConfirmation() | groupRouter.js |
| partial_coverage_offer | messageParsers.js | handlePartialCoverageOffer() | groupRouter.js |
| coverage_maybe | messageParsers.js | (inline prompt, no dedicated handler) | groupRouter.js |
| cancel_coverage | messageParsers.js | handleCoverageCancel() | groupRouter.js |
| trade_request | messageParsers.js | handleTradeRequest() | groupRouter.js |
| time_off_request | messageParsers.js | handleTimeOffRequest() | groupRouter.js |
| running_late | messageParsers.js | handleLateArrival() | groupRouter.js |
| availability_mention | messageParsers.js | handleAvailabilityMention() | groupRouter.js |
| on_call_offer | messageParsers.js | handleOnCallOffer() | groupRouter.js |
| new_hire_announcement | messageParsers.js | handleNewHireAnnouncement() | groupRouter.js |
| copy_schedule_request | messageParsers.js | handleCopySchedule() | groupRouter.js |
| schedule_update | messageParsers.js | (logged only, no handler) | groupRouter.js |
| irrelevant | messageParsers.js | (dropped silently) | groupRouter.js |

## Cron Jobs

| Job | Schedule | Function | File |
|-----|----------|----------|------|
| Dedup clear | 0 0 * * * (midnight) | clears sentNightBefore Set | src/reminders/shiftReminders.js |
| Night-before reminder | 0 20 * * * (8pm) | DMs staff with shifts tomorrow | src/reminders/shiftReminders.js |
| 2-hour shift warning | */30 * * * * (every 30min) | DMs staff with shifts starting in ~2hrs | src/reminders/shiftReminders.js |
| No-show check | */15 * * * * (every 15min) | Checks shifts starting soon, warns manager | src/noshow/noShowWarning.js |
| Daily briefing | 0 8 * * * (8am) | Sends manager summary DM | src/briefing/dailyBriefing.js |

## Database Tables

Key tables — a representative subset of the 47-table schema. Full, authoritative
definitions (kept in sync with the live database) live in `supabase-schema.sql`.

| Table | Purpose | Key columns |
|-------|---------|-------------|
| setup_sessions | Setup wizard state + the account↔group bridge | group_id (real Telegram chat id, or `web:<accountId>` before a group is connected), account_id, manager_id, dm_chat_id, step, setup_data (JSONB), setup_complete |
| shifts | Shift definitions | id, group_id, name, day_of_week, start_time, end_time |
| shift_requirements | Role requirements per shift | shift_id, role, count |
| staff | Staff roster | id, group_id, name, role |
| role_rates | Pay rates per role | group_id, role_name, hourly_rate |
| overtime_settings | OT configuration | group_id, overtime_enabled, weekly_threshold, weekly_multiplier, daily_overtime_enabled, daily_threshold |
| staff_dms | Staff DM registration | user_id (PK), first_name, username, dm_chat_id |
| group_members | Everyone seen in group | (user_id, group_id) composite PK, first_name, username, last_seen |
| coverage_requests | Coverage request tracking | id, group_id, requested_by, requester_telegram_id, shift_description, matched_shift_id, week_start, status (open/covered/cancelled), covered_by |
| coverage_outreach | DM outreach tracking | id, request_id (FK→coverage_requests), user_id, asked_at |
| trade_requests | Shift trade tracking | id, group_id, requester_id, requester_name, shift_id, shift_description, week_start, status (open/completed/cancelled), accepted_by_id/name |
| availability | Staff availability responses | user_id, group_id, week_start, available_shift_ids[], available_all, unavailable, raw_response |
| availability_sessions | Availability DM session state | user_id, group_id, dm_chat_id, week_start, shift_map (JSONB), status (pending/responded) |
| passive_availability | Passive availability mentions | user_id, group_id, week_start, day_of_week, status, raw_text |
| generated_schedules | Draft/published schedules | id, group_id, week_start, status (draft/approved/published/rejected), assignments (JSONB), gaps (JSONB) |
| schedule_assignments | Staff-to-shift assignments | group_id, shift_id, staff_id, week_start |
| schedule_receipts | Read receipt tracking | status (sent/confirmed) |
| time_off_requests | Time off request tracking | id, group_id, staff_telegram_id, staff_name, requested_date, week_start, status (pending/approved/denied) |
| noshow_warnings | No-show dedup | assignment_id, group_id |
| staff_reliability_events | Reliability event log | staff_id, group_id, event_type, recorded_at, metadata |
| on_call | On-call records | staff_id, group_id, week_start, days, all_week |
| onboarding_pending | New hire onboarding tracking | group_id, name, role, start_date, status, announced_at, completed_at |
| payroll_records | Payroll records | group_id, staff_id, week_start, total_hours, total_gross_pay, shift_breakdown (JSONB) |
| partial_coverage | Partial shift coverage | coverage_request_id, staff_id, staff_name, cover_from, cover_until |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| TELEGRAM_BOT_TOKEN | Yes | Telegram bot authentication |
| CEREBRAS_API_KEY | Yes | Cerebras AI API (LLM provider) |
| SUPABASE_URL | Yes | Supabase database URL |
| SUPABASE_ANON_KEY | Yes | Supabase anonymous key |
| NODE_ENV | No | Environment mode |
| ANTHROPIC_API_KEY | No | Anthropic Claude API (dev dependency) |

Note: LLM provider is Cerebras. Base URL: https://api.cerebras.ai/v1. Model: llama-3.3-70b.

## Test Suites

### Phase 1: Fast Suites (parallel, no LLM)
| Suite ID | File | Tests |
|----------|------|-------|
| unit_availability | src/tests/unit/availabilityParser.test.js | 11 |
| unit_shift | src/tests/unit/shiftMatcher.test.js | 7 |
| unit_schedule | src/tests/unit/scheduleGenerator.test.js | 5 |
| unit_botadmins | src/tests/unit/botAdmins.test.js | 15 |
| unit_reminders | src/tests/unit/shiftReminders.test.js | 8 |
| unit_read_receipts | src/tests/unit/readReceipts.test.js | 12 |
| unit_clopening | src/tests/unit/clopening.test.js | 10 |
| unit_hours | src/tests/unit/hoursTracker.test.js | 14 |
| unit_passive_avail | src/tests/unit/passiveAvailability.test.js | 10 |
| unit_self_service | src/tests/unit/selfService.test.js | 12 |
| unit_oncall | src/tests/unit/onCall.test.js | 13 |
| unit_noshow | src/tests/unit/noShowWarning.test.js | 20 |
| unit_reliability | src/tests/unit/reliability.test.js | 25 |
| unit_daily_briefing | src/tests/unit/dailyBriefing.test.js | 20 |
| unit_prefilter | src/tests/unit/preFilter.test.js | 1 |
| unit_prefilter_exhaustive | src/tests/unit/preFilter-exhaustive.test.js | 26 |
| unit_role_rates | src/tests/unit/roleRates.test.js | 19 |
| unit_pay_calculator | src/tests/unit/payCalculator.test.js | 21 |
| unit_pay_report | src/tests/unit/payReport.test.js | 15 |
| unit_staff_pay | src/tests/unit/staffPayService.test.js | 24 |
| unit_rotation | src/tests/unit/rotationTracker.test.js | 25 |
| unit_overtime_setup | src/tests/unit/overtimeSetup.test.js | 22 |
| unit_overtime_pay | src/tests/unit/overtimePay.test.js | 34 |
| unit_spreadsheet | src/tests/unit/spreadsheetGenerator.test.js | 28 |
| integration_coverage | src/tests/integration/coverageFlow.test.js | 11 |
| integration_botadmin | src/tests/integration/botAdminFlow.test.js | 4 |
| integration_schedule | src/tests/integration/scheduleFlow.test.js | 4 |
| e2e_week | src/tests/e2e/fullWeekFlow.test.js | 3 |

### Phase 2: LLM Suites (sequential, 62s delay between)
| Suite ID | File | Tests |
|----------|------|-------|
| unit_trade | src/tests/unit/tradeFlow.test.js | 8 |
| unit_parse | src/tests/unit/parseMessage.test.js | 15 |
| unit_timeoff | src/tests/unit/timeOff.test.js | 13 |
| unit_latearrival | src/tests/unit/lateArrival.test.js | 14 |
| integration_setup | src/tests/integration/setupFlow.test.js | 7 |
| unit_oncall_parse | src/tests/unit/onCallParse.test.js | 7 |
| unit_copy_schedule | src/tests/unit/copySchedule.test.js | 23 |
| unit_new_hire | src/tests/unit/newHire.test.js | 18 |
| unit_partial_coverage | src/tests/unit/partialCoverage.test.js | 29 |

Total: 37 suites, 553 tests

## Known Gaps

1. **Passive availability not integrated** — handleAvailabilityMention() saves to passive_availability table, but generateWeeklySchedule() only reads from active availability table. Passive data is write-only.

2. **Receipt reminders not wired** — sendReceiptReminders() is exported from readReceipts.js but never called from any cron or command. Needs a cron job or manual trigger.

3. **Unused format functions** — formatPayBreakdown(), formatPayBreakdownWithOT(), formatPersonalPayStub() are exported but called from nowhere.

4. **coverage_maybe has no dedicated handler** — Bot sends a generic confirmation prompt inline in groupRouter.js rather than routing to a handler function.

5. **schedule_update intent has no handler** — Parsed by messageParsers.js but only logged in groupRouter.js, never acted upon.
