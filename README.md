# Relay

> Shift scheduling that lives in your team's group chat — and in your browser dashboard.

---

## What is Relay?

Relay is a Telegram bot plus a web dashboard for managing shift-based teams. It handles the full weekly cycle — collecting availability, generating schedules, swapping coverage, paying your team, tracking time clock, and surfacing the patterns that affect retention. Works for restaurants, retail, salons, gyms, healthcare, anywhere with shifts and a team chat.

Staff only need Telegram. There's no extra app to install.

---

## How it works

1. Create your Relay account on the web and run the setup wizard — add your roles, your team, and your shifts (type them in, or describe them in plain English and Relay parses them with AI)
2. Connect your team's Telegram group from the last step of the wizard (add the bot as an admin) — your setup syncs into the chat automatically
3. Staff register with one tap from the link the bot posts
4. Generate schedules, handle coverage, log revenue, run payroll — all in the chat your team already uses
5. The web dashboard gives you a full management view at any time

Prefer to set up entirely in chat? You can still run `/setup` in the group instead — both paths write to the same place.

---

## Dashboard

Access Relay at `https://getrelay-app.netlify.app`.

Sign in with your Relay account — Google, or email + password. When login confirmation (2FA) is enabled, the bot DMs you a 6-digit code (or emails it if you haven't linked Telegram yet). New accounts land in the web setup wizard; returning owners go straight to the dashboard.

### Dashboard pages

**Overview**
- Staff count, planned hours, labor cost
- Schedule quality grade for the current week
- Open coverage requests
- Quick actions: view schedule, generate, log revenue
- Recent activity feed

**Schedule**
- Weekly grid; drag staff between shifts
- Generate schedule from collected availability (LLM-assisted)
- Approve and publish to the group
- Copy last week as a starting draft
- Read-receipt list — see who's confirmed
- Per-staff scheduled hours total

**Staff**
- Add, edit, deactivate staff
- Cross-training picker per role on each staff member
- Per-staff stats (callouts, late arrivals, no-shows, last 90 days)

**Payroll**
- Hours, gross pay, daily/weekly OT, late deductions
- Multi-role staff: per-shift rate, weighted regular rate, correct totals (FLSA-aware)
- Per-staff rate management (inline edit)
- Excel spreadsheet export — values are computed server-side, no formula drift

**Income**
- Daily revenue entries by category
- Tips logging and split calculation
- Weekly revenue rollup
- Labor % vs revenue

**Time Clock** (toggle in Settings)
- Live status of who's clocked in
- Manual clock-in / clock-out overrides for managers
- Missed clock-out alerts

**Event Log**
- Coverage requests and outcomes
- Trade requests
- Time-off requests
- Manager log entries

**Settings**
- Business name, manager phone
- Shifts: add, edit, remove with role requirements
- Pay rates by role
- Overtime thresholds and multipliers
- Tip mode and split method
- Weekly labor budget target
- Business rules (scheduling constraints)
- Revenue categories
- Time clock on/off
- Hidden nav items
- **Account**: download all your data as XLSX, support contact

A persistent footer on every page shows the support email.

---

## Group Chat Commands

These are commands you type in your team's Telegram group.

### Setup and Registration

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/setup` | Group admin | Starts the setup wizard. The bot DMs you to walk through everything. |
| `/register` | Anyone | Posts a registration link for staff to tap and connect with the bot. |
| `/welcome [name]` | Admin | Manually starts the new-hire welcome flow for someone. |
| `/setphone +15550001234` | Manager (DM only) | Links your phone to your Relay account for dashboard login. |

### Scheduling

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/availability` | Admin | DMs every registered staff member asking which shifts they can work next week. |
| `/resetavailability` | Admin | Clears all availability responses so you can start fresh. |
| `/makeschedule` | Admin | Generates next week's schedule with cross-training, pairing optimization, callout-risk prediction, and pattern insights. |
| `/schedule` | Anyone | Shows the current published schedule in the group. |
| `/copyschedule` | Admin | Copies last week's schedule as a starting draft (drops staff who are no longer active). |
| `/hours` | Admin | Shows total scheduled hours for each staff member this week. |
| `/receipts` | Admin | Shows which staff have not confirmed their schedule. |
| `/rotation` | Admin | Shows the rotation fairness report — who's getting the desirable shifts. |

### Pay and Reports

| Command | Who can use it | DM-enabled | What it does |
|---------|---------------|------------|--------------|
| `/pay [week?]` | Manager | ✅ | Payroll summary (hours, gross pay, deductions). |
| `/staffpay [name]` | Manager | ✅ | One staff member's pay history. |
| `/setrate [role] [amount]` | Manager | — | Sets the hourly pay rate for a role. |
| `/setovertime` | Manager | — | Walks through OT settings (weekly + daily thresholds, multipliers). |
| `/spreadsheet [week?]` | Manager | ✅ | Excel file with schedule, payroll, and late arrivals. |
| `/briefing` | Admin | ✅ | Daily summary: today's shifts, open requests, pending approvals. |
| `/reliability` | Manager | ✅ | Staff reliability scores (internal, last 90 days). |
| `/morale` | Manager | ✅ | Team morale report based on engagement signals. |

### Tips

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/tipmode` | Admin | Shows current tip settings (pool mode, split method, BOH inclusion). |
| `/tipmode pool` | Admin | Switches to pooled tips. |
| `/tipmode individual` | Admin | Switches to individual tips. |
| `/tipmode cash` | Admin | Switches to cash tips (logged only, no split). |
| `/tipmode hours\|equal\|points` | Admin | Sets split method. |
| `/tipmode boh on\|off` | Admin | Includes or excludes back-of-house in tip pool. |
| `/tips` | Admin | Recent tip records (last 4 weeks). |

### Staff and Intelligence

| Command | Who can use it | DM-enabled | What it does |
|---------|---------------|------------|--------------|
| `/kudos [name?]` | Anyone | — | Recognition leaderboard or one person's history. |
| `/crosstraining` | Admin | ✅ | Cross-training roster (who can work which extra roles). |
| `/retention` | Admin | ✅ | Turnover-risk report. Never posted to the group. |
| `/quality` | Admin | — | Schedule quality score trend (last 12 weeks). |
| `/patterns` | Admin | ✅ | Staffing pattern + seasonal trend insights. |
| `/staffinsight [name]` | Admin | ✅ | Per-staff deep-dive: availability learning + reliability. |

### Time Tracking

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/clockstatus` | Admin | Who is currently clocked in. |
| `/timesheet [name?]` | Admin | A staff member's time entries. |

### Financial

| Command | Who can use it | DM-enabled | What it does |
|---------|---------------|------------|--------------|
| `/revenue [amount]` | Manager | — | Logs weekly revenue for labor cost % tracking. |
| `/labortrend` | Manager | ✅ | Labor cost trend over recent weeks. |
| `/setbudget [amount]` | Admin | — | Sets your weekly labor budget. |
| `/budget` | Anyone | ✅ | Shows the current weekly labor budget. |

### Rules and Settings

| Command | Who can use it | DM-enabled | What it does |
|---------|---------------|------------|--------------|
| `/rules` | Admin | ✅ | Lists active business rules. |
| `/delrule [number]` | Admin | — | Deletes a business rule by number. |
| `/setmaxshifts [1-5\|none]` | Admin | — | Limits how many shifts one person can work per day. |
| `/log [text]` | Manager | — | Views or adds to the manager shift log. |
| `/shifts` `/addshift` `/editshift` `/removeshift` | Admin | — | Shift configuration. |
| `/staff` `/removestaff [name]` | Admin | — | Staff list / deactivate. |
| `/coverage [shift]` | Admin | — | Manually post a coverage request. |

### Admin Management

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/addadmin` | Manager | Reply to someone's message to grant them admin access. |
| `/removeadmin` | Manager | Reply to someone's message to revoke admin access. |
| `/admins` | Anyone | Lists current bot admins. |

### Help

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/help` or `/commands` | Anyone | In group: short pointer. In DM: full command reference. |

---

## Manager DM Commands

Most manager commands also work in your private chat with the bot — no need to use the group. Just send the same command directly.

When a command runs in DM, results are sent to you in the same chat instead of being forwarded to your DMs.

The "DM-enabled" column in the Group Chat tables above marks which commands currently work in DMs. Write commands (set-rate, set-budget, add-shift, etc.) and a few that depend on group context (rotation, tipmode, etc.) still need to be run in the group.

### Natural-language manager actions in DM

These work in your private chat with the bot:

| What to say | What happens |
|-------------|--------------|
| "approve" | Publishes the draft schedule to the group. |
| "approve anyway" | Publishes despite warnings (clopenings, OT). |
| "regenerate" | Asks the bot to build a different schedule. |
| "approve [name]" / "deny [name]" | Approves or denies a time-off request. |
| "tips were $840 tonight" | Calculates the tip split based on your tip settings. |
| "split $1,200 from Friday dinner" | Same, tied to a specific shift. |
| "Marcus can also work prep" | Records cross-training. |
| "who is working" | Current shift roster. |

Schedule edits via DM ("remove Sarah from Friday Dinner", "add Mike to Saturday Lunch", emergency-coverage queries) are planned for a future iteration.

---

## What Staff Can Do in DMs

Staff can DM the bot any time:

| What to say | What happens |
|-------------|--------------|
| "my schedule" / "when do I work" | Shows your shifts for the week. |
| "my hours" | Total hours scheduled. |
| "my pay" / "my paycheck" | This week's pay breakdown. |
| "pay history" | Last 4 weeks of pay. |
| "how much have I made" | Real-time earned wages: completed + mid-shift + projected. |
| "clock in" / "clock out" | Starts or stops a time entry. |
| "got it" | Confirms you've seen your schedule (read receipt). |

---

## Natural Language in the Group

You don't memorize commands for most things. Just type what you mean.

### Coverage and callouts

| What to say | What happens |
|-------------|--------------|
| "I can't come in tonight" | Posts a coverage request and DMs all eligible staff. On-call + top responders are prioritized. |
| "need someone to cover my evening shift" | Same. |
| "I can cover" / "bet" / "say less" / "fasho" | Marks the shift as covered, swaps the schedule, notifies everyone. |
| "I can cover from 3pm to 5pm" | Partial coverage — tracked until the whole window is filled. |
| "Cancel" / "nevermind" | Cancels an open coverage request. If the request was already covered, swaps the schedule back and DMs the volunteer. |

### Trades, recognition, time off, late, on-call

| What to say | What happens |
|-------------|--------------|
| "I want to trade my Friday dinner shift" | Posts a trade offer; eligible staff get DMs. |
| "trade my Saturday lunch" (in response) | Executes a two-way swap with rollback if any leg fails. |
| "shoutout Marcus for covering last minute" | Posts a formatted shoutout, logs to recognition history. |
| "I need next Friday off" | DMs the manager for approval; you're notified of the decision. |
| "Running late, about 15 minutes" | Quiet group ack + detailed manager DM (shift info, ETA). |
| "I'm on call this week" | Records you as on-call. You get first priority on coverage. |
| "Welcome John to the team" | Posts a welcome message with a registration link. |

Slang accepted as confirmation: bet, fasho, say less, word, no cap, fr, igu, i got u, locked in, count me in, on it, fs, ofc, plus 👍 ✅ 💯 🙌 👌.

---

## Automatic features

Run on their own — no command needed.

| Feature | When | Who's notified |
|---------|------|---------------|
| Shift reminders (night before) | 8pm daily | Staff with shifts tomorrow |
| Shift reminders (2hr before) | every 30 min | Staff with shifts in ~2hr |
| No-show early warning | every 15 min | Manager DM if staff hasn't confirmed |
| Daily manager briefing | 8am daily | Manager DM |
| Sunday weekly briefing | Sunday morning | Manager DM (LLM-narrated week summary) |
| Coverage outreach + escalation | when coverage is requested | Eligible staff first; escalates if no fill at 30 / 60 / 120 min |
| Reliability tracking | every coverage / no-show / trade event | Surfaced via `/reliability` |
| Morale tracking | continuously from engagement signals | Surfaced via `/morale` and Sunday briefing |
| Rotation fairness | during schedule generation | Auto-balanced |
| Cross-training gap-filling | during schedule generation | Auto-applied |
| Recognition detection | every group message | Bot amplifies shoutouts |
| Cross-training detection | every group message | Bot records "Marcus can also work prep" |

---

## Setup Guide

### 1. Create your account and run the web wizard
Go to `https://getrelay-app.netlify.app`, sign up, and walk the setup wizard — roles first, then your team (pick each person's role from your list), then shifts (type them or describe them in plain English and Relay parses them; bulk-apply a shift across the week), then pay rates per role.

### 2. Connect your Telegram group
The wizard's final step links your group — add the bot as an admin and your roles, staff, shifts, and rates sync into the chat automatically. Prefer chat-only setup? Run `/setup` in the group instead (tip and overtime settings are configured there).

### 3. Register your staff
Type `/register` in the group. Staff tap the link and connect to the bot in one step.

### 4. Collect availability
Run `/availability` each week. Staff reply via DM with the shifts they can work.

### 5. Generate and publish
Run `/makeschedule` (or use the dashboard). Review the draft and reply "approve" to publish to the group. Or edit it first via DM in natural language.

---

## Deployment

Production stack: Render (Node backend) + Netlify (static frontend) + Supabase (Postgres).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather |
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Supabase anon key (dev fallback) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ in prod | Required after migration 008 (RLS lockdown). Server uses this to bypass per-tenant policies and rely on app-layer auth. |
| `CEREBRAS_API_KEY` | ✅ (or Groq) | Primary LLM provider |
| `GROQ_API_KEY` | recommended | Fallback LLM (also used for any call needing strict JSON mode — Cerebras strips `response_format`) |
| `JWT_SECRET` | ✅ | ≥32 chars. Server refuses to start without it. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `ALLOWED_ORIGINS` | recommended | Comma-separated list of allowed dashboard origins for CORS |
| `WAITLIST_GAS_URL` | optional | Server-side proxy target for the landing-page waitlist form |
| `DASHBOARD_URL` | optional | Surfaced in `/help` reply |
| `NODE_ENV` | optional | `production` or `development` |
| `PORT` | optional | Server port (default 10000) |

### Run locally

```bash
npm install
cp .env.example .env
# Fill in .env with values from your Supabase + Telegram bot setup
node src/index.js
```

### Database migrations

```bash
node scripts/migrate.js         # apply pending migrations
node scripts/migrate.js --dry-run
```

Migrations live in `scripts/migrations/`. Migration 008 locks down RLS — make sure `SUPABASE_SERVICE_ROLE_KEY` is set on the server before applying it (the server uses it to bypass per-tenant policies and rely on app-layer auth).

---

## Tech stack

- **Bot**: Node.js 20+, ES modules, `node-telegram-bot-api`
- **Web server**: Express
- **Dashboard**: vanilla JS SPA, no framework, single HTML file
- **Database**: Supabase / Postgres with row-level security
- **LLM**: Cerebras `llama-3.3-70b` primary, Groq `llama-3.3-70b-versatile` fallback (via the `openai` SDK)
- **Auth**: Supabase Auth accounts (Google / email + password), Bearer access tokens verified server-side; optional login confirmation code (2FA) via Telegram DM or email. Legacy phone-OTP (JWT cookie) sessions still supported.
- **Hosting**: Render (backend) + Netlify (static frontend) + Supabase (DB)
- **Exports**: ExcelJS
- **Crons**: `node-cron`

---

## Support and reporting bugs

Email **mahinwaghray@gmail.com**. Usually replies within a day.

For the production-readiness audit (P0 blockers and how they were resolved), see [`PRODUCTION_READINESS_REPORT.md`](PRODUCTION_READINESS_REPORT.md).
