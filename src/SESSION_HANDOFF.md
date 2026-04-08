# Relay — Session Handoff

## What's built and working
- /setup, /register, /availability, /resetavailability, /makeschedule, /schedule
- Coverage flow: NL request → staff DMs → group/DM confirmation → schedule swap
- Trade flow: "trade my X" → offer posted → "trade my Y" → both shifts swapped
- Pending clarification: 5-min in-memory TTL for ambiguous shift replies
- Bot admin system: /addadmin, /removeadmin, /admins

## Current task
Context reduction refactor — all large files (>150 lines) split into focused modules.

## Files most relevant to current task
- `src/routing/` — new routing layer (dmRouter, groupRouter, commandRouter)
- `src/coverage/` — coverage + trade handlers split into 5 files
- `src/parsers/` — LLM parsers split into groq client + messageParsers + setupParsers
- `src/db/`, `src/setup/db/`, `src/availability/db/` — DB functions split by domain

## Last known test status
42/42 passing across 10 suites (unit, integration, e2e)

## Decisions made
- Barrel re-exports at original paths (db.js, setupDb.js, etc.) so all imports unchanged
- `resolvePendingClarification` exported from `coverage/pendingState.js` via `handleCoverage.js` barrel
- `moveToStaffStepShared` exported from shiftSteps.js (needed by setupFlow reset handler)

## What to do next
Commit: `refactor: split large files to reduce per-session context consumption`
