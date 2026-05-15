# Future Work — Next Session Handoff + Phases B & C

> **If you are starting a new session: read this top section first. It tells you exactly what state the project is in, what to verify, and what to do next.**

---

## START HERE — Session Handoff (last update: 2026-05-15)

### 0. 2026-05-15 session delta

- ✅ 4 P1 audit bugs fixed, committed, and pushed:
  - `7383008` fix: LLM client timeout + route JSON-mode through Groq (P1-12, P1-28)
  - `7b3075e` fix: self-healing polling recovery (P1-3)
  - `35727d1` fix: sanitize 500 error responses on dashboard routes (P1-1, plus a sibling leak at line 1521)
- ✅ Render deploy back to green after a `JWT_SECRET must be ≥32 characters` boot failure. Operator rotated `JWT_SECRET` on Render to a fresh 64-char URL-safe value (the P0-1 fail-fast guard at `src/server/middleware.js:4-6` was doing its job — code did not change). Note: that rotation invalidated any existing dashboard JWTs — staff/managers logged in before the rotation will need to OTP-login again.
- **Next session, start here:** the next P1 batch (in priority order, ~3-4 hr): P1-2 (OTP brute-force + IP rate limit), P1-4 (deep `/health`), P1-15 (graceful HTTP shutdown), P1-16 (`"latest"` deps → pinned), P1-29 (in-memory reminder dedup). After that, Phase B1+B2 below.

### 1. Where things stand right now

**Deployed and live:**
- Render backend at `https://relay-v5ne.onrender.com` (verified `/health` returns 200 multiple times during the 2026-05-09 session)
- Netlify frontend at `https://getrelay-app.netlify.app/dashboard`
- Supabase project `khfyiapeoiatnxbhcbto`

**Code state:** working tree clean. Latest commits (`git log --oneline -8`):
1. `d226938` — 13 manager commands work in DMs; `/help`; full README rewrite
2. `cf22017` — data export, support contact, operator launch checklist
3. `1b4ad6b` — launch readiness report + audit bug list
4. `264afa2` — drop dead files (audit cleanup)
5. `a5c1177` — RLS lockdown + cascade-soften migrations (008/009)
6. `4cb69c9` — P0 launch-blocker fixes
7. `c62e882` — pre-session: BUILDNEXT split-brain doc (now deleted)
8. `8eab76f` — pre-session: bot+dashboard split-brain fix

**SQL migrations applied to prod Supabase:** 008 (RLS lockdown — anon now has zero DB access) and 009 (cascade-delete soften + unique constraint on `schedule_assignments`).

**Render env vars set by the operator on 2026-05-09:** `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY` (in addition to the originals: `TELEGRAM_BOT_TOKEN`, `CEREBRAS_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_ORIGINS`).

### 2. Smoke tests to run first (5 min)

Run these in order. If any fails, fix before adding more surface area.

```bash
# 1) Backend health
curl -sm 6 https://relay-v5ne.onrender.com/health

# 2) Local boot still works (Cerebras + Groq + JWT_SECRET should be in .env)
PORT=10099 node src/index.js > /tmp/relay-boot.log 2>&1 &
PID=$!
until curl -s -m 1 localhost:10099/health >/dev/null 2>&1; do sleep 0.5; done
curl -s localhost:10099/health
curl -s -o /dev/null -w "HTTP %{http_code}\n" -m 2 localhost:10099/api/export   # expect 401
kill $PID; wait $PID 2>/dev/null
```

Then in the operator's Telegram (manual — can't be done from a coding session):
- DM the bot `/help` → should reply with the full sectioned reference
- DM the bot `/pay` → should send the payroll summary directly in the DM (not "Sent to your DM")
- DM the bot `/morale`, `/reliability`, `/budget` — all should answer in DM
- In the test group, `/setup` on a populated group → should ask for "yes wipe" instead of nuking
- Log in to dashboard → Settings → Account → Download .xlsx → file should open in Excel

### 3. What is NOT verified end-to-end

The 13 DM-enabled commands compile and the server boots, but no Telegram interaction has actually been simulated. The operator should walk through the DM smoke tests above before trusting them.

LLM tests have been skipped because Groq's daily token quota was exhausted in the last test run (the operator now has CEREBRAS_API_KEY locally so re-running tests should hit Cerebras).

### 4. Order of operations for the next session

In priority order. Each item links to the doc that has the detail.

| Priority | Block | Doc | Effort |
|---|---|---|---|
| 1 | Operator items: pay for Render Starter, sign up UptimeRobot, decide billing, set up ToS, generate onboarding Loom, smoke test the live deploy | `LAUNCH_OPERATOR_TASKS.md` | 2 hr (mostly the operator's time, not code) |
| 2 | ~~Top P1s: Cerebras JSON-mode, polling auto-recovery, dashRoutes leaks, LLM timeout~~ ✅ **DONE 2026-05-15** (commits `7383008`, `7b3075e`, `35727d1`) | `LAUNCH_AUDIT_BUGS.md` | — |
| 2b | Next P1 batch: P1-2 (OTP IP rate limit), P1-4 (deep `/health`), P1-15 (graceful HTTP shutdown), P1-16 (pin `"latest"` deps), P1-29 (persist reminder dedup) | `LAUNCH_AUDIT_BUGS.md` | ~3-4 hr |
| 3 | Phase B1 + B2 below (more commands in DM, write commands in DM) | this file | ~3 hr (originally estimated 6-8 hr — the pattern is mechanical, see calibration note below) |
| 4 | Phase C1 + C5 below (read receipts panel, time-off approvals UI) | this file | ~2-3 hr |
| 5 | Phase B3, then C2/C4/C6, then C3 last | this file | spread across several sessions |

### 5. Estimate calibration (Phase A retrospective)

The Phase A work in this session (13 DM commands + `/help` + README rewrite) was estimated at 3-4 hr; actual was ~15 min. Reasons:
- Refactor pattern was mechanical once `resolveManagerContext` existed.
- README "rewrite" was mostly restructuring existing tables.
- I padded estimates because the prompt said "ultrathink scope" — overestimating felt safer.

**For future estimates:** the mechanical phases (B1, B2, C1, C5, C6) will probably be 30-50% of the bands listed below. The genuinely novel UX work (C3 insights panel, possibly C2 cross-training matrix) won't compress as much.

### 6. Known gotchas

- ~~**Cerebras silently strips `response_format: { type: "json_object" }`**~~ ✅ Fixed 2026-05-15 (commit `7383008`). `llmCreate` now routes JSON-mode requests directly to Groq when configured, bypassing Cerebras. When only Cerebras is available, the strip is logged via `logger.warn` instead of being silent.
- **Groq daily token quota** (~100k tokens/day on free tier) gets exhausted by `npm test` runs. Use `npm run test:fast` (skip-llm) or upgrade Groq if testing frequently.
- **Render free tier sleeps after 15 min idle.** Operator decision pending in `LAUNCH_OPERATOR_TASKS.md` item 4.
- **Cron jobs run in UTC, not restaurant local time.** Sunday rollups, no-show alerts, missed-clock-out alerts all fire at UTC offsets (`LAUNCH_AUDIT_BUGS.md` P1-8).
- **22 commands in `src/index.js` still have the `if (!['group','supergroup']...) return` guard** — Phase B1+B2 below covers them.
- **Support email everywhere is `mahinwaghray@gmail.com`** — hardcoded in `public/dashboard.html` footer, `src/setup/setupFlow.js` welcome footer, `src/server/exportRoutes.js` cover sheet. Search for it if you need to change it.

### 7. Key files to know

| File | What |
|---|---|
| `src/index.js` | All bot.onText handlers. The new `resolveManagerContext(msg)` helper at line ~94 is the single source of truth for group/DM auth. |
| `src/server/dashRoutes.js` | 55 dashboard API routes. All gated by `requireAuth`. Group scoping via `req.manager.groupId`. |
| `src/server/exportRoutes.js` | New `/api/export` endpoint — XLSX dump of tenant tables. |
| `src/server/marketingRoutes.js` | New `/api/waitlist` proxy — replaces the hardcoded GAS URL. |
| `src/coverage/confirmationHandler.js` | Coverage swap with compensation pattern (P0-5 fix). Reverts `markCovered` if schedule write fails. |
| `src/coverage/cancelHandler.js` | Cancel-after-fill: reverse-swaps the schedule and DMs the volunteer (P0-6 fix). |
| `src/coverage/tradeHandler.js` | Trade swap with undo-stack rollback (P0-7 fix). |
| `src/payroll/payCalculator.js` | Multi-role payroll (P0-9 fix): `rolesWorked`, `weightedRegularRate`, `roleNameDisplay`. |
| `src/db/client.js` | Prefers `SUPABASE_SERVICE_ROLE_KEY`; falls back to anon for dev. |
| `scripts/migrations/008_lock_down_rls.sql` | Already applied. RLS lockdown. |
| `scripts/migrations/009_soften_cascades.sql` | Already applied. Cascade soften + unique constraint. |
| `public/dashboard.html` | Single 6,250-line SPA. Settings → Account section has the export button + support email. Persistent footer on every page. |
| `public/index.html` | Marketing landing. Now POSTs to `/api/waitlist` instead of GAS direct. |

### 8. Sister docs to read

- `README.md` — user-facing. Brand intro, dashboard pages, command tables, deployment.
- `PRODUCTION_READINESS_REPORT.md` — narrative pre-launch audit. All 13 P0s marked FIXED.
- `LAUNCH_AUDIT_BUGS.md` — file:line bug list. 13 P0 (✅ all fixed), 32 P1 (open), ~25 P2.
- `LAUNCH_OPERATOR_TASKS.md` — non-code launch items only the operator can do.
- `CAPABILITIES.md` — per-feature wired/not-wired status.
- `CLAUDE.md` — coding rules + stack invariants for AI sessions.

---

## Phase A — Already shipped (commit `d226938`)

- `resolveManagerContext(msg)` helper in `src/index.js` for unified group/DM auth
- 13 commands DM-enabled: `/briefing /pay /staffpay /reliability /spreadsheet /labortrend /budget /morale /retention /patterns /staffinsight /rules /crosstraining`
- `/help` (and `/commands`) — full sectioned reference in DMs, short pointer in groups
- README rewrite per launch spec
- This doc

---

## Phase B — Dashboard parity + write commands in DM (~6-8 hr)

### B1. Read commands still group-only because the handler reads `msg.chat.id` (~2 hr)

These need an explicit `groupId` parameter added to their handler signatures so DM mode can pass the resolved group:

| Command | Handler | File:line |
|---|---|---|
| `/rotation` | `handleRotationCommand` | `src/fairness/rotationTracker.js:131` (also calls `bot.getChatMember` which fails in DM — needs to skip that check when groupId is passed explicitly) |
| `/clockstatus` | `handleClockStatus` | `src/timeclock/clockCommands.js:21` |
| `/timesheet` | `handleTimesheetCommand` | `src/timeclock/clockCommands.js:74` |
| `/quality` | `handleQualityCommand` | `src/intelligence/scheduleQuality.js:296` |
| `/shifts` (read) | `handleShiftsCommand` | `src/setup/shiftEditor.js:143` |
| `/staff` (read) | `handleViewStaff` | `src/setup/staffManager.js:103` |
| `/tipmode` (read) | `handleTipModeCommand` | `src/operations/tipPool.js:405` |
| `/tips` | `handleTipHistory` | `src/operations/tipPool.js:481` |
| `/kudos` | `handleRecognitionHistory` | `src/engagement/recognition.js:354` |

Pattern for each: add `groupId = String(msg.chat.id)` as a default param, then in `index.js` pass `ctx.groupId` from `resolveManagerContext(msg)`. ~10 min per command.

### B2. Write commands in DM (~1 hr)

These mutate state. DM-enabling them means a typo in DM can wreck a published schedule. Add a confirmation step where appropriate:

| Command | What it writes | DM treatment |
|---|---|---|
| `/setrate [role] [amount]` | role pay rate | Direct apply, echo "✅ Rate set" |
| `/setbudget [amount]` | weekly labor budget | Direct apply |
| `/setmaxshifts [n]` | scheduling constraint | Direct apply |
| `/setovertime` | OT settings (interactive) | Already DM-aware via `startOvertimeStep`, just remove group guard |
| `/log [text]` | manager shift log | Direct apply |
| `/revenue [amount]` | weekly revenue entry | Direct apply |
| `/delrule [n]` | deletes a business rule | Confirm: show rule text, require "yes delete" |
| `/removestaff [name]` | deactivates staff | Confirm before applying |
| `/addshift /editshift /removeshift` | shift configuration | Already interactive; remove group guard, route via session.dm_chat_id |
| `/copyschedule` | overwrites draft | Direct apply (idempotent against draft) |
| `/makeschedule` | overwrites draft | Direct apply |
| `/coverage` | creates coverage request | Need: where does it broadcast? Group only via session.group_id — should work, just remove the guard and route the broadcast via the resolved groupId |

### B3. NL DM intents the user listed (~2-3 hr)

Per the original prompt, these manager NL DM intents should work:

- `"approve"` / `"approve anyway"` / `"regenerate"` — schedule review (likely already works via `dmRouter.js` schedule-review path; verify)
- `"approve [name]"` / `"deny [name]"` — time-off approval; check current handler exists
- `"tips were $X tonight"` — tip split via `handleTipMessage`; verify routing
- `"split $X from [shift]"` — tied tip split
- `"[name] can also work [role]"` — cross-training detection
- `"who can work now"` / `"emergency coverage"` — query on_call + availability ranked by response speed
- `"who is working"` — current shift roster
- `"remove Sarah from Friday Dinner"` — schedule edit on draft
- `"add Mike to Saturday Lunch"` — schedule edit on draft

Audit `src/routing/dmRouter.js` first to find which already work; add only the missing ones. **Defense-in-depth**: schedule edits via DM must check `generated_schedules.status !== 'published'` and refuse without explicit "override" confirmation.

### B4. New `/admins` `/addadmin` `/removeadmin` in DMs (~30 min)

These exist in `src/routing/commandRouter.js` but only respond in groups. Mirror them as `bot.onText` handlers in `src/index.js` with the `resolveManagerContext` pattern. **Defense-in-depth**: only the original `manager_id` can grant/revoke admin (not self-granting bot admins).

---

## Phase C — Dashboard feature parity (~8-12 hr)

The user's prompt asked for 6 dashboard "agents" each adding multiple sections. Splitting into focused chunks with stop-at-quality cutoffs.

### C1. Schedule page (~1-2 hr)

| Item | Where | Notes |
|---|---|---|
| Read Receipts panel | `dashboard.html` schedule page | New `GET /api/schedule/receipts?week=` route + new `POST /api/schedule/remind` route. Per-staff ✅/⏳ list + "Remind unconfirmed" button. |
| Reset Availability button | next to Generate button | New `DELETE /api/availability?weekStart=` route. Confirm modal first. |
| Hours summary color-coding | existing Total column | Color: green <40h, orange 38-40h, red >40h. UI-only change. |
| Rotation fairness toggle | header button | Reuses existing rotation data; renders ↑/↓/= badges per staff row. Defer the underlying API change to B1. |

### C2. Staff page (~2 hr)

| Item | Where | Notes |
|---|---|---|
| Cross-training matrix | new section below table | Cross-training picker already exists per-staff in the modal (`dashboard.html:4003`). Promote it to a grid view: staff rows × role columns, click to cycle ✅/🔄/—. New `PATCH /api/staff/:id/crosstraining` route. |
| Reliability column | existing staff table | Pull from `/api/staff/:id/stats`. Color badge + click-to-expand row. |
| "Send registration link" per unregistered staff | existing ⏳ row | New `POST /api/staff/:id/remind-register`. **Defense-in-depth**: rate-limit max 1/day/staff. |
| Bot admins section | below staff table | New `GET/POST/DELETE /api/admins` routes. Only `manager_id` can grant. |

### C3. Insights / Intelligence panel (~2-3 hr)

This is the biggest UX item. Defer to a focused turn — needs design thinking, not just feature wiring.

- Morale signals card with sparkline
- Retention risk card with risk pills
- Quality trend card with letter grade
- Staffing patterns card with "Confirm as rule" buttons
- Per-staff insight slide-out modal (the most ambitious — pulls in reliability, availability learning, morale, recognition, cross-training, callout risk)
- New unified `GET /api/insights` route

### C4. Time clock + payroll polish (~1-2 hr)

| Item | Where | Notes |
|---|---|---|
| Live "Currently clocked in" banner | top of timeclock page | New `GET /api/timeclock/live` route. Auto-refresh every 60s. **Defense-in-depth**: only return entries where `clock_in > 8h ago AND clock_out IS NULL`. |
| Per-staff timesheet modal | click staff name in timeclock | Reuses existing `/api/timeclock/weekly` data. |
| Hours summary on payroll page | existing payroll table | Per-staff scheduled vs worked hours; late deductions column. |

### C5. Event log + budget (~2 hr)

| Item | Where | Notes |
|---|---|---|
| Event log tab filters | top of event log page | All / Coverage / Trades / Kudos / Time-off / No-shows / Schedule edits |
| Kudos feed | new tab | Pull from `recognition_events`. |
| Time-off approvals UI | new tab | New `GET /api/timeoff` + `POST /api/timeoff/:id/approve\|deny`. Bot DM staff on decision. |
| Schedule edit audit | new tab | Pull from `schedule_edit_events`. |
| No-show warnings | new tab | Pull from `noshow_warnings`. |
| Labor trend chart | income page | 8-week bar chart, color-coded by labor %. |
| Revenue sparkline per week | income page | Small bar chart of last 8 weeks. |

### C6. Settings additions (~1 hr)

| Item | Where | Notes |
|---|---|---|
| Max shifts per day | new settings row | Number input 1-5 or "no limit". `PATCH /api/settings`. |
| Bot admins management | new settings section | Mirrors C2 admin section. |
| Availability reminder toggle | new settings row | `PATCH /api/settings { availabilityReminders }`. |
| Help & Support link | new section | Link to README + support email. |

---

## Order I'd actually do these

If you ship to a friendly first customer first, you can defer most of this. They tolerate friction.

If you're selling to a stranger, do this order:

1. **Phase A operator items first** (`LAUNCH_OPERATOR_TASKS.md`): Render Starter, UptimeRobot, ToS, billing decision. ~2 hr.
2. **Top P1s from `LAUNCH_AUDIT_BUGS.md`**: Cerebras JSON-mode workaround, polling auto-recovery, dashRoutes error leaks. ~3 hr. These reduce real failure risk.
3. **Phase B1 + B2** (DM-enable remaining read commands, add safe write commands): ~3 hr. Removes daily friction for the customer's manager.
4. **Phase C1 + C5** (read receipts, time-off approvals): ~3 hr. Closes two visible gaps in the dashboard.
5. **Phase B3** (NL DM intents — schedule edits, tips split, emergency coverage): ~2-3 hr.
6. **Phase C2 + C4** (cross-training matrix, live clock-in): ~3-4 hr.
7. **Phase C3** (insights panel): defer until you have real customer feedback on what they actually look at. Don't build a feature no one uses.
8. **Phase C6 + B4**: ~1.5 hr.

Total post-launch: ~15-20 hr split into 4-5 short focused sessions.
