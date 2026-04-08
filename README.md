# Relay

## What is Relay

Restaurant shift management is chaos. Someone calls in sick, a manager scrambles through DMs, half the group chat doesn't see it, and the shift goes uncovered. Relay fixes this by sitting inside your existing staff Telegram group and handling the whole thing automatically — coverage requests, shift trades, availability collection, weekly scheduling, time-off, and late arrivals.

No new app. No training. No behavior change for your staff.

## Features

| Feature | How it works |
|---|---|
| **Coverage requests** | Staff say "can anyone cover my Saturday lunch?" — Relay detects it and posts a structured request |
| **Confirmations** | First volunteer to say "I'll take it" gets confirmed and the request closes |
| **Shift trades** | "Anyone want to trade Friday dinner for Sunday brunch?" — Relay brokers the swap |
| **Availability** | `/availability` DMs every registered staff member to collect weekly availability |
| **Schedule generation** | `/makeschedule` builds a draft schedule from availability, sends it to the manager for review |
| **Time off** | "I need Saturday off" — logged and acknowledged |
| **Late arrivals** | "Running 20 minutes late" — Relay relays to the group |
| **Shift reminders** | Automated DM reminders before upcoming shifts |
| **Setup wizard** | Full onboarding flow for configuring shifts, roles, and staff |

## Architecture

```
Telegram Group Chat
      ↓ message
node-telegram-bot-api (polling)
      ↓ text + sender
src/routing/groupRouter.js
      ↓ commands → commandRouter.js
      ↓ natural language → parseMessage.js → Groq (llama-3.1-8b-instant)
      ↓ intent JSON
src/coverage/*  src/timeOff/*  src/lateArrival/*  src/schedule/*
      ↓ save / read
Supabase (Postgres)
      ↓ reply
Telegram Group Chat
```

## File map

```
src/index.js                        — bot init + message dispatcher
src/routing/
  dmRouter.js                       — DM message handling
  groupRouter.js                    — group message dispatch
  commandRouter.js                  — /command handlers
src/coverage/
  requestHandler.js                 — handleCoverageRequest
  confirmationHandler.js            — handleCoverageConfirmation, handleDmConfirmation
  cancelHandler.js                  — handleCoverageCancel
  tradeHandler.js                   — handleTradeRequest, handleTradeOffer
  shiftResolver.js                  — resolveShift (LLM + day matching)
  pendingState.js                   — in-memory clarification TTL state
src/parsers/
  messageParsers.js                 — parseMessage, isDmConfirmation + SYSTEM_PROMPT
  setupParsers.js                   — parseShift, parseStaff, parseShiftRequirements
  groq.js                           — shared Groq client + groqWithRetry
src/db/
  coverage.js                       — coverage request DB ops
  members.js                        — group member DB ops
  trades.js                         — trade request DB ops
src/availability/
  collectAvailability.js            — /availability flow + reply handler
  db/records.js                     — availability record ops
  db/schedules.js                   — published schedule ops
  db/sessions.js                    — availability session ops
src/schedule/
  generateSchedule.js               — weekly schedule algorithm
  reviewSchedule.js                 — manager approve/edit/publish flow
  scheduleEditor.js                 — inline schedule editing
src/setup/
  setupFlow.js                      — setup state machine
  shiftSteps.js                     — add_shifts + shift_roles step handlers
  staffSteps.js                     — welcome + add_staff step handlers
  db/sessions.js                    — setup session ops
  db/admins.js                      — bot admin ops
  db/shifts.js                      — shift config ops
  db/staff.js                       — staff roster ops
  db/assignments.js                 — shift assignment ops
src/timeOff/
  handleTimeOff.js                  — time off request handler
  timeOffDb.js                      — time off DB ops
src/lateArrival/
  handleLateArrival.js              — late arrival handler
src/reminders/
  shiftReminders.js                 — cron-based shift reminder jobs
src/shiftMatcher.js                 — fuzzy shift matching (score-based)
src/logger.js                       — logger utility
```

## Setup

### 1. Create a Telegram bot via @BotFather

```
/newbot          — create the bot, copy the token
/setprivacy      — select your bot → Disable  ← REQUIRED to read all messages
/setjoingroups   — select your bot → Enable
```

### 2. Get a Groq API key

Sign up free (no credit card) at [console.groq.com](https://console.groq.com), then create an API key.

### 3. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New Query**, paste the contents of `supabase-schema.sql`, and click **Run**
3. Copy your **Project URL** and **anon key** from **Settings → API**

### 4. Run locally

```bash
git clone <repo>
cd relay-bot
cp .env.example .env
# Fill in all 4 values in .env
npm install
npm run test-parse   # verify Groq is working
npm run dev
```

### 5. Add the bot to your Telegram group

1. Add the bot as a member of the group
2. Make it an admin: **Group Settings → Administrators → Add Admin**
3. Grant: Read Messages, Send Messages
4. DM the bot directly — it will walk you through the setup wizard to configure shifts and staff

## Commands

| Command | Who | What it does |
|---|---|---|
| `/register` | Admin | Generates a staff registration link |
| `/availability` | Admin | DMs all staff to collect availability for next week |
| `/resetavailability` | Admin | Clears collected availability to start fresh |
| `/makeschedule` | Admin | Generates a draft schedule and sends it to the manager for review |
| `/setup` | Admin (DM) | Starts the shift/staff setup wizard |

## Tests

```bash
npm test                   # full suite (parallel)
npm run test:unit          # pure unit tests (no API calls)
npm run test:unit:groq     # Groq API tests
npm run test:integration   # integration tests
npm run test:e2e           # end-to-end full-week flow
```

## Environment variables

```
TELEGRAM_BOT_TOKEN   — from @BotFather
GROQ_API_KEY         — from console.groq.com
SUPABASE_URL         — from Supabase project settings
SUPABASE_ANON_KEY    — from Supabase project settings
```

## Deploying to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Add the 4 environment variables from `.env` under **Variables** in the Railway dashboard. Railway auto-restarts on failure.

## Tech stack

- **Node.js 25** — ES modules
- **Groq** — llama-3.1-8b-instant for intent classification
- **Supabase** — Postgres for all persistent state
- **node-telegram-bot-api** — Telegram polling
- **node-cron** — shift reminders
