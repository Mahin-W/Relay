# Future Work — Phases B & C

Phase A (this turn, commit `<TBD>`) shipped the highest-leverage items: `/help`, 13 read-only commands DM-enabled, full README rewrite. This doc tracks what's deferred and the order to do it in.

Sister docs:
- `PRODUCTION_READINESS_REPORT.md` — P0/P1 audit
- `LAUNCH_AUDIT_BUGS.md` — file:line bug list
- `LAUNCH_OPERATOR_TASKS.md` — non-code launch checklist

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
