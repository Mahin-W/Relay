# Relay Bot

## Stack
- Node.js 20+ ES modules
- node-telegram-bot-api (polling)
- Cerebras `llama-3.3-70b` (primary) + Groq `llama-3.3-70b-versatile` (fallback) via `openai` SDK
- @supabase/supabase-js (server uses `SUPABASE_SERVICE_ROLE_KEY`; per-tenant RLS denies anon)
- Render (backend) + Netlify (static frontend at getrelay-app.netlify.app) + Supabase (DB)

## Rules
- Always use ES module syntax (import/export)
- Every async function needs try/catch
- Bot must never crash — `process.on('unhandledRejection' | 'uncaughtException')` exit so Render restarts
- No hardcoded values — everything from .env
- Use `response_format: { type: "json_object" }` on Groq calls. Cerebras strips it; if a call requires strict JSON, route through Groq explicitly or guard the parse.
- `JWT_SECRET` must be set (≥32 chars) — server refuses to start without it
- Coverage / trade swaps must be atomic with `markCovered`. On schedule-write failure, revert with `revertCovered` (compensation pattern in `src/coverage/confirmationHandler.js` and undo-stack in `src/coverage/tradeHandler.js`)
