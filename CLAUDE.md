# CLAUDE.md

## Commands
```bash
node src/index.js          # run bot
npm test                   # full suite (parallel)
npm run test:unit          # 23 pure tests
npm run test:unit:groq     # 15 LLM API tests (Cerebras)
npm run test:integration   # 13 tests
npm run test:e2e           # 3 tests
```

## Tech stack
Node.js 25, ES modules, Supabase (postgres), Cerebras (llama3.1-8b), node-telegram-bot-api

## File map
```
src/index.js              — bot init + message dispatcher (~60 lines)
src/routing/dmRouter.js   — DM message handling
src/routing/groupRouter.js — group message dispatch
src/routing/commandRouter.js — /command handlers
src/handleCoverage.js     — barrel → src/coverage/*
src/coverage/pendingState.js — in-memory clarification TTL state
src/coverage/shiftResolver.js — resolveShift (LLM + day matching)
src/coverage/requestHandler.js — handleCoverageRequest
src/coverage/confirmationHandler.js — handleCoverageConfirmation, handleDmConfirmation
src/coverage/cancelHandler.js — handleCoverageCancel
src/coverage/tradeHandler.js — handleTradeRequest, handleTradeOffer
src/parseMessage.js       — barrel → src/parsers/*
src/parsers/messageParsers.js — parseMessage, isDmConfirmation + SYSTEM_PROMPT
src/parsers/setupParsers.js — parseShift, parseStaff, parseShiftRequirements
src/parsers/groq.js       — shared Cerebras client (OpenAI SDK) + groqWithRetry + extractJSON
src/shiftMatcher.js       — fuzzy shift matching (score-based)
src/db.js                 — barrel → src/db/{coverage,members,trades}.js
src/setup/setupDb.js      — barrel → src/setup/db/{sessions,admins,shifts,staff,assignments}.js
src/setup/setupFlow.js    — setup state machine
src/setup/shiftSteps.js   — add_shifts + shift_roles step handlers
src/setup/staffSteps.js   — welcome + add_staff step handlers
src/availability/availabilityDb.js — barrel → src/availability/db/*
src/availability/collectAvailability.js — /availability flow + reply handler
src/schedule/generateSchedule.js — weekly schedule algorithm (returns clopenings + hoursIssues)
src/schedule/reviewSchedule.js   — manager approve/edit/publish flow (handles "approve anyway")
src/schedule/readReceipts.js     — sendPersonalSchedule, handleReceiptConfirmation, getUnconfirmedStaff, sendReceiptReminders
src/schedule/clopen.js           — detectClopenings, formatClopeningWarning (pure, no DB/Groq)
src/schedule/hoursTracker.js     — calculateWeeklyHours, detectHoursIssues, formatHoursWarning (pure)
src/timeclock/clockDetector.js   — fast-path keyword matching for clock in/out (no LLM)
src/timeclock/clockDb.js         — time_entries DB operations
src/timeclock/clockHandler.js    — handleClockIn, handleClockOut + shift auto-matching
src/timeclock/clockAlerts.js     — OT alerts on clock-out, compliance report for briefing
src/timeclock/clockCommands.js   — /clockstatus, /timesheet commands
src/logger.js             — logger utility
```

## Key design rules
- DB injection via 4th param `db = null` on handleCoverageRequest/Confirmation
- Pre-resolved shifts via `intent._preResolvedShift` / `intent._preResolvedWeekStart`
- `--env-file=.env` required on node (Supabase throws at module level without env)
- TAP output: look for `ℹ pass` and `ℹ fail` in stdout (Node.js 25 format)
- `bot.deleteWebHook({ drop_pending_updates: true })` (capital H) before polling

## DB schema
See `supabase-schema.sql`

## Environment
See `.env` — requires: TELEGRAM_BOT_TOKEN, CEREBRAS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
