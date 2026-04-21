# Relay Bot

## Stack
- Node.js 20+ ES modules
- node-telegram-bot-api (polling)
- groq-sdk with llama-3.1-8b-instant
- @supabase/supabase-js
- Railway deployment

## Rules
- Always use ES module syntax (import/export)
- Every async function needs try/catch
- Bot must never crash — always recover
- No hardcoded values — everything from .env
- Use response_format: { type: "json_object" } on all Groq calls