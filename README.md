# Relay

## What is Relay

Restaurant shift coverage is chaos. Someone calls in sick, a manager
scrambles through DMs, half the group chat doesn't see it, and the
shift goes uncovered. Relay fixes this by sitting inside your existing
staff group chat and handling the whole thing automatically.

When someone says "can anyone cover my Saturday lunch?", Relay detects
it, posts a structured request, and confirms coverage the moment a
coworker volunteers — no new app, no training, no behavior change for
your staff.

## Architecture

```
Telegram Group Chat
      ↓ message
node-telegram-bot-api (polling)
      ↓ text + sender
parseMessage.js → Groq API / llama-3.1-8b-instant
      ↓ intent JSON
handleCoverage.js
      ↓ save / read
Supabase (Postgres)
      ↓ reply
Telegram Group Chat
```

The bot polls Telegram for new messages, runs each group message
through Groq to classify intent (coverage request, confirmation, or
irrelevant), then acts accordingly. All state lives in Supabase so
coverage requests persist across restarts.

## Setup

### 1. Create a Telegram bot via @BotFather

```
/newbot          — create the bot, copy the token
/setprivacy      — select your bot → Disable  ← REQUIRED to read all messages
/setjoingroups   — select your bot → Enable
```

### 2. Get a Groq API key

Sign up free (no credit card) at [console.groq.com](https://console.groq.com),
then create an API key.

### 3. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New Query**, paste the contents of
   `supabase-schema.sql`, and click **Run**
3. Copy your **Project URL** and **anon key** from
   **Settings → API**

### 4. Run locally

```bash
git clone <repo>
cd relay-bot
cp .env.example .env
# Fill in all 4 values in .env
npm install
npm run test-parse   # verify Groq is working before touching Telegram
npm run dev
```

### 5. Add the bot to your Telegram group

1. Add the bot as a member of the group
2. Make it an admin: **Group Settings → Administrators → Add Admin**
3. Grant: Read Messages, Send Messages
4. Send this in the group:

   > anyone free to cover Saturday lunch?

   The bot should respond within 3 seconds.

## Deploying to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then go to your Railway project dashboard and add the 4 environment
variables from your `.env` under **Variables**.

Railway will auto-restart on failure (configured in `railway.json`).

## Test phrases

| What to say | Expected response |
|---|---|
| `can anyone cover my Saturday lunch shift` | Posts coverage request card |
| `I need someone for Friday 6pm to close` | Posts coverage request card |
| `calling in sick tomorrow morning` | Posts coverage request card |
| `I can cover that` | Confirms coverage, closes request |
| `I'll take it` | Confirms coverage, closes request |
| `what time does service start?` | No response (irrelevant) |

## What's next

- `/status` command to list open requests
- DM the volunteer with shift details after confirmation
- Manager notifications via a separate channel
- Multi-shift tracking (queue of open requests per group)
- Weekly coverage analytics
