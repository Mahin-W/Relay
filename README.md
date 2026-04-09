# Relay

A Telegram bot that handles shift scheduling, coverage, and trades for restaurant teams. It lives in your existing staff group chat — no new apps, no training.

## What Relay Does

**Scheduling** — Collects availability from every staff member via DM, generates a weekly schedule, and lets the manager review, edit, and publish it. Staff get their personal schedule as a DM and confirm they've seen it.

**Coverage** — When someone can't make their shift, they just say so in the group chat. Relay detects it, posts a structured request, and DMs available staff. The first person to volunteer gets confirmed.

**Shift Trades** — Staff can propose swapping their shift with someone else. Relay brokers the trade and updates both assignments.

**Time Off** — Staff request days off in natural language. Relay logs it and notifies the manager.

**Late Arrivals** — "Running 20 min late" gets relayed to the group with the details extracted.

**On-Call** — Staff can volunteer to be on call for extra shifts throughout the week.

## Getting Started

### 1. Create a Telegram Bot

Open [@BotFather](https://t.me/BotFather) on Telegram and run:

- `/newbot` — create the bot and copy the token
- `/setprivacy` — select your bot, then choose **Disable** (required so the bot can read group messages)
- `/setjoingroups` — select your bot, then choose **Enable**

### 2. Get a Groq API Key

Sign up free at [console.groq.com](https://console.groq.com) and create an API key. No credit card required.

### 3. Set Up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor**, paste the contents of `supabase-schema.sql`, and run it
3. Copy your **Project URL** and **anon key** from **Settings > API**

### 4. Configure and Run

```bash
git clone <repo-url>
cd relay-bot
cp .env.example .env
```

Fill in the four values in `.env`:

```
TELEGRAM_BOT_TOKEN=your-token-from-botfather
GROQ_API_KEY=your-groq-key
SUPABASE_URL=your-supabase-project-url
SUPABASE_ANON_KEY=your-supabase-anon-key
```

Then:

```bash
npm install
node src/index.js
```

### 5. Add the Bot to Your Group

1. Add the bot as a member of your Telegram staff group
2. Promote it to admin: **Group Settings > Administrators > Add Admin**
3. Grant permissions: Read Messages, Send Messages
4. Type `/setup` in the group — the bot will DM you to walk through configuration

## Setup Wizard

When you run `/setup`, Relay walks you through in a private DM:

1. **Restaurant name** — what to call your team
2. **Shifts** — define your shift schedule (e.g., Morning Prep 7am-11am, Lunch 11am-3pm)
3. **Roles** — how many people you need per shift
4. **Staff** — add your team members by name

You can type `reset` at any step to redo it.

## Commands

Run these in your staff group chat.

### Everyone

| Command | What it does |
|---|---|
| `/schedule` | View the current published schedule |
| `/register` | Get a link for new staff to register with the bot |
| `/commands` | Show all available commands |

### Admins Only

| Command | What it does |
|---|---|
| `/setup` | Configure Relay for this group |
| `/availability` | DM all staff to collect next week's availability |
| `/resetavailability` | Clear collected availability and start fresh |
| `/makeschedule` | Generate a draft schedule and send it to the manager for review |
| `/receipts` | See which staff haven't confirmed their schedule yet |
| `/hours` | View total scheduled hours per staff member |

### Manager Only

| Command | What it does |
|---|---|
| `/addadmin` | Reply to someone's message to grant them admin access |
| `/removeadmin` | Reply to someone's message to revoke admin access |
| `/admins` | List current Relay admins |

## Natural Language

Relay understands natural language in the group chat. Staff don't need to learn commands — they just talk normally.

### Coverage Requests

> "Can anyone cover my Saturday lunch?"
> "Calling in sick, need someone for Friday morning"
> "Can't make it tomorrow"

Relay detects the request, posts it to the group, and DMs available staff.

### Volunteering

> "I can cover" / "I'll take it" / "bet" / "igu" / "say less"

Relay understands casual slang and emoji reactions (👍 ✅ 💯). The first volunteer gets confirmed.

### Cancelling

> "Never mind, I found someone" / "Cancel my request"

Cancels your open coverage request. Managers can cancel anyone's.

### Shift Trades

> "Trade my Monday morning for anyone's Tuesday"

Relay posts the trade offer. Someone replies with their own shift to complete the swap.

### Time Off

> "Can I have Saturday off?" / "I can't work Sunday"

Logged and sent to the manager.

### Running Late

> "Running 20 minutes late" / "Stuck in traffic, be there by 6:30"

Relay extracts the details and relays it to the group.

### On-Call

> "I can pick up extra shifts this week" / "Put me on call"

Relay notes the availability for the week.

## Schedule Workflow

1. **Collect** — Run `/availability`. Relay DMs each registered staff member to ask what days they can work.
2. **Generate** — Run `/makeschedule`. Relay builds a schedule from availability, shift requirements, and staff roles.
3. **Review** — The manager gets a draft in DM with warnings for clopenings (close then open) and overtime. They can:
   - Reply **approve** to publish
   - Reply **approve anyway** to publish despite warnings
   - Reply **regenerate** for a different arrangement
   - Describe an edit: *"remove Mahin from Monday Morning Prep"* or *"add Sapna to Tuesday Lunch"*
4. **Publish** — Approved schedules are posted to the group. Each staff member gets a personal DM with their shifts.
5. **Confirm** — Staff reply to confirm they've seen their schedule. Run `/receipts` to see who hasn't confirmed yet.

## Deploying

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Add the four environment variables under **Variables** in the Railway dashboard.

## Support

Type `/commands` in any group with Relay to see the full command list.
