# Relay

Relay is a Telegram bot that handles shift scheduling, coverage, and team communication for restaurants. It manages the full weekly cycle: collect availability, generate the schedule, review it, publish it, and track everything after.

Staff only need Telegram. There is no extra app to install.

---

## Table of Contents

- [Getting Started](#getting-started)
- [The Weekly Cycle](#the-weekly-cycle)
- [Group Chat Commands](#group-chat-commands)
- [What Staff Can Do in DMs](#what-staff-can-do-in-dms)
- [Natural Language (Just Talk Normally)](#natural-language-just-talk-normally)
- [Automatic Features](#automatic-features)
- [Notifications Staff Receive](#notifications-staff-receive)
- [Pay and Overtime](#pay-and-overtime)
- [Tips](#tips)
- [Staff Engagement](#staff-engagement)
- [Intelligence Layer](#intelligence-layer)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### First-Time Setup

1. Create a Telegram group for your restaurant staff.
2. Add the Relay bot to the group.
3. Type `/setup` in the group. The bot will send you a private message to walk you through:
   - Your restaurant name
   - Shifts (for example, "Saturday Lunch, 11am-3pm")
   - How many of each role you need per shift (for example, "Saturday Lunch: 2 servers, 1 cook")
   - Hourly pay rates for each role
   - Staff names and roles
   - Tip settings (pooled, individual, or cash)
   - Overtime settings
4. Type `/register` in the group and have each staff member tap the link that appears. This lets the bot send them private messages.
5. You are ready to go.

### Getting Staff Registered

Type `/register` in the group. The bot posts a link. When a staff member taps that link, it opens a private chat with the bot and they are registered. That is all they need to do.

---

## The Weekly Cycle

Here is how a typical week works from start to finish:

1. **Collect availability** -- Type `/availability` in the group. The bot sends every registered staff member a private message with a numbered list of shifts and asks which ones they can work.
2. **Staff respond** -- Each person replies in their private chat with shift numbers (like "1 3 5"), "all", or "off".
3. **Generate the schedule** -- Type `/makeschedule` in the group. The bot builds a draft schedule using availability, role requirements, fairness rotation, cross-training data, and staff pairing optimization. It flags problems like clopenings (less than 10 hours of rest between shifts), overtime risks (40+ hours), callout risk predictions, and staffing pattern recommendations. If a role cannot be filled by the primary staff, cross-trained staff are considered automatically.
4. **Review the draft** -- The bot sends the draft to the manager in a private message with intelligence sections: staffing pattern insights, callout risk predictions, and pairing optimization notes. You can type "approve", "approve anyway" (to publish despite warnings), "regenerate" (for a different arrangement), or make edits in plain English like "remove Sarah from Friday Dinner" or "add Mike to Saturday Lunch".
5. **Publish** -- Once you approve, the schedule is posted to the group.
6. **Staff get their schedules** -- Each staff member receives a private message showing only their shifts for the week. They reply "got it" to confirm they have seen it.
7. **Track confirmations** -- Type `/receipts` to see who has not confirmed yet.
8. **Payroll** -- Payroll is calculated automatically when the schedule is published. You get a text summary and an Excel spreadsheet.
9. **Daily briefings** -- Every morning at 8am, the manager gets a private message with today's shifts and anything that needs attention.
10. **Sunday briefing** -- Every Sunday the manager gets an AI-written narrative summary of the week: coverage stats, late arrivals, no-shows, overtime, morale alerts, staff retention flags, and a schedule quality score tracking how Relay is improving over time.
11. **Shift reminders** -- Staff get a reminder the night before their shift and again two hours before. If someone has not confirmed 15 minutes before their shift, the manager gets a warning.

---

## Group Chat Commands

These are the commands you can type in your restaurant's Telegram group.

### Setup and Registration

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/setup` | Group admin | Starts the setup wizard. The bot sends you a private message to walk through everything. |
| `/register` | Anyone | Posts a registration link for staff to tap and connect with the bot. |
| `/welcome [name]` | Admin | Manually starts the new hire welcome flow for someone. |

### Scheduling

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/availability` | Admin | Sends a private message to every registered staff member asking which shifts they can work next week. |
| `/resetavailability` | Admin | Clears all availability responses so you can start fresh. |
| `/makeschedule` | Admin | Generates next week's schedule with cross-training, pairing optimization, callout risk prediction, and staffing pattern insights. |
| `/schedule` | Anyone | Shows the current published schedule in the group. |
| `/copyschedule` | Admin | Copies last week's schedule as a starting draft for next week (removes staff who are no longer active). |
| `/hours` | Admin | Shows total scheduled hours for each staff member this week. |
| `/receipts` | Admin | Shows which staff have not confirmed they have seen their schedule. |
| `/rotation` | Admin | Shows the rotation fairness report -- who has been getting the desirable shifts. |

### Pay and Reports

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/pay` | Manager | Sends you this week's payroll summary (hours, gross pay, deductions) in a private message. |
| `/staffpay [name]` | Manager | Shows a specific staff member's pay history. |
| `/setrate [role] [amount]` | Manager | Sets the hourly pay rate for a role. Example: `/setrate server 18` |
| `/setovertime` | Manager | Walks you through overtime settings (weekly and daily thresholds and multipliers). |
| `/spreadsheet` | Admin | Sends you an Excel file with the schedule, payroll, and late arrivals. |
| `/briefing` | Admin | Sends you a daily summary: today's shifts, open requests, pending approvals. |
| `/reliability` | Manager | Shows staff reliability scores (internal, last 90 days). |
| `/morale` | Manager | Shows team morale report based on engagement signals. |

### Tips

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/tipmode` | Admin | Shows current tip settings (pool mode, split method, BOH inclusion). |
| `/tipmode pool` | Admin | Switches to pooled tips (Relay calculates the split). |
| `/tipmode individual` | Admin | Switches to individual tips (staff keep their own). |
| `/tipmode cash` | Admin | Switches to cash tips (Relay logs only, no split). |
| `/tipmode hours` | Admin | Sets split method to hours worked. |
| `/tipmode equal` | Admin | Sets split method to equal split. |
| `/tipmode points` | Admin | Sets split method to role-weighted points. |
| `/tipmode boh on` | Admin | Includes back-of-house staff in tip pool. |
| `/tipmode boh off` | Admin | Excludes back-of-house staff from tip pool. |
| `/tips` | Admin | Shows recent tip records (last 4 weeks). |

### Staff and Intelligence

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/kudos` | Anyone | Shows the recognition leaderboard for the last 4 weeks. |
| `/kudos [name]` | Anyone | Shows a specific person's recognition history. |
| `/crosstraining` | Admin | Shows the cross-training roster (who can work which additional roles). |
| `/retention` | Admin | Sends a private retention risk report to your DMs. Never posted to the group. |
| `/quality` | Admin | Shows schedule quality score trend (last 12 weeks). Sent to your DMs. |
| `/patterns` | Admin | Shows staffing pattern insights and seasonal trends. Sent to your DMs. |

### Time Tracking

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/clockstatus` | Admin | Shows who is currently clocked in. |
| `/timesheet [name]` | Admin | Shows a staff member's time entries. |

### Financial

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/revenue [amount]` | Manager | Logs weekly revenue for labor cost percentage tracking. |
| `/labortrend` | Manager | Shows labor cost trend over recent weeks. |
| `/setbudget [amount]` | Admin | Sets your weekly labor budget. |
| `/budget` | Anyone | Shows the current weekly labor budget. |

### Rules and Settings

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/rules` | Admin | Lists active business rules (scheduling constraints). |
| `/delrule [number]` | Admin | Deletes a business rule by number. |
| `/setmaxshifts [1-5]` | Admin | Limits how many shifts one person can work per day. |
| `/log [text]` | Manager | Views or adds to the manager shift log. |

### Admin Management

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/addadmin` | Manager | Reply to someone's message to grant them admin access. |
| `/removeadmin` | Manager | Reply to someone's message to revoke admin access. |
| `/admins` | Anyone | Lists current bot admins. |

### Help

| Command | Who can use it | What it does |
|---------|---------------|--------------|
| `/help` or `/commands` | Anyone | Shows available commands. |

---

## What Staff Can Do in DMs

Staff can send private messages to the bot at any time. Here is what works:

| What to say | What happens |
|-------------|--------------|
| "my schedule" or "when do I work" | Shows your personal shifts for the week. |
| "my hours" or "how many hours" | Shows your total hours. |
| "my pay" or "my paycheck" | Shows this week's pay breakdown. |
| "pay history" | Shows your last 4 weeks of pay. |
| "how much have I made" or "my earnings" | Shows real-time earned wages: completed shifts, current mid-shift earnings, and projected week total. |
| "clock in" or "clock out" | Starts or stops your time entry. |
| "got it" | Confirms you have seen your schedule (read receipt). |

Managers also get extra options in their private chat:

| What to say | What happens |
|-------------|--------------|
| "approve" | Publishes the draft schedule to the group. |
| "approve anyway" | Publishes despite warnings about clopenings or overtime. |
| "regenerate" | Asks the bot to build a different schedule arrangement. |
| Natural language edits (like "remove Sarah from Friday Dinner" or "add Mike to Saturday Lunch") | The bot updates the draft accordingly. |
| "approve [name]" or "deny [name]" | Approves or denies a time-off request. |
| "tips were $840 tonight" | Calculates the tip split based on your tip settings and shows who gets what. |
| "split $1,200 from Friday dinner" | Same as above, tied to a specific shift. |
| "Marcus can also work prep" | Records cross-training (the bot detects this automatically). |
| "who can work now" or "emergency coverage" | Shows who is available right now, ranked by response speed. |
| "who is working" | Shows who is currently on shift. |

---

## Natural Language (Just Talk Normally)

You do not need to memorize commands for most things. Just type what you mean in the group chat and the bot will figure it out.

### Coverage and Callouts

When someone cannot make their shift:

| What to say | What happens |
|-------------|--------------|
| "I can't come in tonight" | The bot posts a coverage request to the group and sends private messages to all registered staff asking who can cover. On-call staff and top responders get notified first. |
| "need someone to cover my evening shift" | Same as above. |
| "can't work Friday" | Same as above. |

When someone wants to pick up the shift:

| What to say | What happens |
|-------------|--------------|
| "I can cover" | The bot marks the shift as covered, swaps the schedule, and notifies everyone. |
| "I can cover from 3pm to 5pm" | Partial coverage -- the bot tracks portions until the whole shift is filled. |
| "bet" / "say less" / "I got u" / "fasho" | All count as yes. The bot understands casual language and slang. |

Other responses:

| What to say | What happens |
|-------------|--------------|
| "Maybe" or "I think I can" | The bot asks for a firm yes or no. |
| "Cancel" or "nevermind" | Cancels an open coverage request. Managers can cancel anyone's. |

### Shift Trading

| What to say | What happens |
|-------------|--------------|
| "I want to trade my Friday dinner shift" | The bot posts a trade offer to the group and sends private messages to staff. |
| "trade my Saturday lunch" (in response to a trade or coverage request) | The bot executes a two-way shift swap and updates the schedule. |

### Recognition and Shoutouts

The bot listens for recognition language in the group and amplifies it:

| What to say | What happens |
|-------------|--------------|
| "shoutout Marcus for covering last minute" | The bot posts a formatted shoutout and logs it to Marcus's recognition history. |
| "great job everyone tonight" | The bot posts a team-wide shoutout. |
| "kudos to Sarah" | Individual recognition, logged and formatted. |
| "props to the kitchen crew" | Role-based recognition. |

Recognition is passive -- the bot watches for phrases like "shoutout", "great job", "well done", "kudos", "props to", "crushed it", "MVP", "stepped up", and similar. No special command needed.

### Other Things You Can Say

| What to say | What happens |
|-------------|--------------|
| "I need next Friday off" | The bot sends the manager a private message for approval. You get notified of the decision. |
| "Running late, about 15 minutes" | The bot quietly acknowledges it in the group and sends the manager a detailed private message with shift info and your ETA. |
| "I'm on call this week" or "I can pick up extra shifts" | The bot records you as on-call. You get first priority on coverage requests. |
| "Welcome John to the team" | The bot posts a welcome message with a registration link. |
| "Repeat last week's schedule" | Same as the `/copyschedule` command. |

### Slang and Casual Phrasing That Works

The bot understands all of these as a "yes" when confirming coverage:

bet, fasho, fa sho, say less, word, ight, aight, no cap, on god, fr, igu, i got u, i gotchu, locked in, facts, frl, pulling up, ima pull up, count me in, put me down, on it, done, i'll take it, fs, ofc

Emoji replies also work: thumbs up, check mark, 100, raised hands, OK hand.

---

## Automatic Features

These run on their own with no command needed.

| Feature | When it runs | Who gets notified |
|---------|-------------|-------------------|
| Shift reminders (night before) | 8pm daily | Staff who have shifts the next day |
| Shift reminders (2 hours before) | Checked every 30 minutes | Staff with upcoming shifts |
| No-show early warning | Checked every 15 minutes | Manager gets a private message if staff have not confirmed close to shift time |
| Daily manager briefing | 8am daily | Manager |
| Sunday weekly briefing | Sunday morning | Manager gets an AI narrative summary of the week |
| Reliability tracking | Automatically on every coverage, no-show, and trade event | Stored internally, visible with `/reliability` |
| Morale tracking | Tracks engagement signals (response times, coverage patterns, recognition received) | Manager, via `/morale` and Sunday briefing |
| Rotation fairness | During schedule generation | Automatically balances who gets the desirable shifts |
| Cross-training gap filling | During schedule generation | If a role is short-staffed, cross-trained staff fill the gap automatically |
| Payroll calculation | When the schedule is published | Manager gets a text summary and an Excel spreadsheet |
| Recognition detection | Every group message | The bot watches for shoutouts and praise and amplifies them |
| Cross-training detection | Every group message | The bot listens for phrases like "Marcus can also work prep" and records them |
| Demand signal detection | Every group message | The bot captures staffing demand signals ("we were slammed") for scheduling |
| Preference learning | Sunday midnight | Analyzes manager's schedule edits to learn patterns (auto-applies high-confidence ones) |
| Turnover risk assessment | Sunday briefing | Flags staff who may be disengaging, based on morale, reliability, hours, and recognition |
| Schedule quality scoring | Sunday briefing | Scores each week 0-100 based on draft edits, coverage requests, no-shows, fill time, and confirmations |
| Staffing pattern analysis | During schedule generation | Detects chronically understaffed or overstaffed shifts and recommends requirement changes |
| Availability learning | Continuously | Tracks stated vs actual availability per staff per day, flags unreliable patterns |
| Callout risk prediction | During schedule generation | Predicts per-assignment callout probability using historical, morale, and behavioral signals |
| Implicit constraint discovery | Every 4 weeks | Surfaces unwritten rules the manager follows (never-together pairs, always-on-shift staff) |
| Shift pairing optimization | During schedule generation | Identifies staff pairs that correlate with smooth or rough shifts, optimizes pairings |

---

## Notifications Staff Receive

Here is every private message staff might get from the bot and what to do about it.

| When | What the message says | How to reply |
|------|----------------------|--------------|
| Manager runs `/availability` | A numbered list of shifts asking which you can work | Reply with numbers ("1 3 5"), "all", or "off" |
| Schedule is published | Your personal shifts for the week | Reply "got it" to confirm |
| Someone needs coverage | "[Name] needs coverage for [shift]. Can you cover?" | Reply "yes" or "trade my [shift]" |
| Night before your shift | "Reminder -- you're on tomorrow for [shift]" | No reply needed |
| 2 hours before your shift | "Heads up -- your [shift] starts in about 2 hours" | No reply needed |
| Time off approved or denied | "Your time-off for [date] has been approved/denied" | No reply needed |
| New hire registration | Welcome message with setup instructions | Follow the link to register |
| Tip split (if enabled) | "Your tips for [shift]: $[amount]" | No reply needed |
| Recognition received | "You got a shoutout from [manager]" (via group post) | No reply needed |

---

## Pay and Overtime

- Payroll is calculated automatically when the schedule is published.
- The manager receives a text summary in a private message showing each staff member's hours and gross pay.
- The manager also receives an Excel spreadsheet with three tabs: Schedule, Payroll, and Late Arrivals.
- Staff can message the bot "my pay" to see this week's breakdown, or "pay history" for the last four weeks.
- Staff can message "how much have I made" to see real-time earnings including mid-shift progress.
- Overtime settings are configured during setup or with `/setovertime`. You can set weekly thresholds, daily thresholds, and multipliers.
- Late arrival deductions are factored into payroll automatically.
- Labor cost percentage tracking is available with `/revenue` and `/labortrend`.

---

## Tips

Relay handles tip distribution based on how your restaurant works. Tip settings are configured during setup and can be changed anytime with `/tipmode`.

### Three Modes

| Mode | How it works |
|------|-------------|
| **Pool** (default) | Manager says "tips were $840 tonight" and Relay splits them across eligible staff. |
| **Individual** | Staff keep their own tips. Relay logs the total for your records but does not split. |
| **Cash** | Tips are paid in cash manually. Relay logs the total only. |

### Split Methods (Pool Mode)

| Method | How it splits |
|--------|--------------|
| **Hours worked** (default) | Proportional to hours worked. Someone who worked 6 hours gets more than someone who worked 4. |
| **Equal** | Everyone gets the same amount regardless of hours. |
| **Role points** | Weighted by role. Servers and bartenders get 3 points per hour, cooks get 2, runners and bussers get 1.5, hosts get 1. |

### BOH Inclusion

By default, back-of-house staff (cooks, prep, dishwashers) are excluded from the tip pool. Use `/tipmode boh on` to include them.

### How It Works

1. Manager sends a DM like "tips were $840 tonight" or "split $1,200 from Friday dinner".
2. Relay identifies the shift, looks up who worked it, and calculates the split.
3. The manager sees a formatted breakdown with each person's name, role, hours, and tip amount.
4. Optionally, each staff member can be DMed their individual amount.

The split always adds up to the exact total -- rounding cents are given to the highest earner.

---

## Staff Engagement

### Recognition and Shoutouts

Relay listens for praise and recognition in the group chat. When a manager says something like "shoutout Marcus for covering last minute" or "great job everyone tonight", the bot:

1. Posts a formatted shoutout in the group.
2. Logs it to the person's recognition history.
3. Factors it into their morale score (recognition reduces turnover risk).

Use `/kudos` to see the recognition leaderboard, or `/kudos [name]` for someone's history.

### Earned Wage Visibility

Staff can DM the bot "how much have I made" at any time to see:

- What they have earned from completed shifts this week.
- What they are earning right now if they are mid-shift (updates in real time).
- Their projected total for the full week based on remaining scheduled shifts.

This builds trust and transparency. No manager involvement required.

### Cross-Training

When a manager says something like "Marcus can also work prep if needed" in the group or a DM, Relay records it with a proficiency level:

| Level | When it is used |
|-------|----------------|
| **Training** | "Marcus is learning prep" or "training on bar" |
| **Competent** (default) | "Marcus can also work prep" |
| **Proficient** | "Marcus is fully certified on prep" or "expert on all stations" |

Cross-trained staff are automatically considered when the schedule generator cannot fill a role with primary staff. Only competent and proficient staff are used (not those still in training).

Use `/crosstraining` to see the full roster.

---

## Intelligence Layer

These features run behind the scenes to help managers make better decisions. Every feature requires a minimum amount of history before it activates -- Relay gets smarter the longer your restaurant uses it.

### Schedule Quality Score

After each week, Relay scores the schedule quality 0-100 based on: how many draft edits the manager made, how many coverage requests were filed, no-shows, average fill time for coverage, and how many staff confirmed their schedules. The score appears in the Sunday briefing and trends over time so managers can see Relay improving.

Grades: A (90-100), B (80-89), C (70-79), D (60-69), F (below 60). Use `/quality` for the full trend over the last 12 weeks.

Trend detection requires at least 3 weeks of history.

### Staffing Pattern Memory

After 6 or more weeks, Relay detects shifts that are chronically understaffed or overstaffed compared to their requirements. For example: "Your Tuesday Lunch has been understaffed 6 of 8 weeks. Consider bumping the server requirement from 2 to 3."

These recommendations appear in the draft schedule when you run `/makeschedule`. Use `/patterns` for the full report including seasonal trends (requires 12+ weeks).

### Availability Learning

Relay tracks each staff member's stated availability versus what actually happens. If someone says they are available on Mondays but calls out or requests off 80% of the time, Relay flags this as an availability risk. The manager sees these flags in the draft schedule review.

Recent behavior is weighted more heavily than older data (last 3 weeks count double). Minimum 4 weeks of data required before any flags appear. This data is never shown to staff.

### Predictive Callout Risk

Before the manager approves a draft schedule, Relay predicts the callout probability for each assignment using multiple signals:

- Historical callout rate for that staff member on that specific day and shift (35% weight)
- Historical callout rate on that specific shift (25% weight)
- Recent callout spike (3+ in last 3 weeks)
- Current morale score and trend
- Consecutive days scheduled that week

Risk levels: low (under 20%), medium (20-40%), high (40-60%), critical (over 60%). New staff with fewer than 3 data points are capped at medium risk to avoid false flags.

These predictions appear in the draft schedule DM after at least 4 weeks of data.

### Implicit Constraint Discovery

Every 4 weeks, Relay analyzes schedule history to find unwritten rules the manager follows but never explicitly stated:

- **Never together**: Two staff members who are never scheduled on the same shift.
- **Always on shift**: A staff member who appears on a specific shift 80%+ of the time.
- **Never on day**: A staff member who is never scheduled on a certain day (and is not marked unavailable).
- **Always together**: Two staff members who are consistently paired together.

When Relay detects a pattern with high confidence (after 6-8 weeks of data), it asks the manager: "I've noticed you never schedule Maria and Carlos together -- should I make this a permanent rule?" The manager can confirm (converts to a business rule) or dismiss (Relay will not ask again).

Maximum 2 discovery questions per cycle to avoid overwhelming the manager.

### Shift Pairing Optimization

Relay tracks which staff combinations correlate with smooth operations (no coverage events, no late arrivals, positive recognition) versus rough shifts. After enough data (3+ shifts together), it identifies positive and negative pairs.

During schedule generation, Relay automatically:
- Separates negative pairs by swapping staff to different shifts on the same day (only if a same-role swap is available that does not create a new negative pair).
- Notes positive pairs that are kept together.

These optimizations appear as notes in the draft schedule DM. Pairing data is manager-only and invisible to staff.

### Morale Tracking

The bot tracks engagement signals for each staff member: how quickly they respond to availability and coverage requests, whether they accept or decline coverage, and whether they receive recognition. Use `/morale` to see the team report.

### Turnover Risk

Every Sunday, Relay calculates a retention risk score for each staff member based on:

- Morale score and trend
- Reliability score
- Hours volatility (sudden drops in scheduled hours)
- Coverage decline rate
- Consecutive days worked
- Late arrival frequency
- Recognition received (reduces risk)

Staff flagged as medium risk or higher appear in the Sunday briefing with a recommendation (check-in, 1:1 conversation, etc.). Use `/retention` for the full report -- it is always sent to your DMs, never posted to the group.

New staff (less than 2 weeks of data) are protected from false flags -- their risk score is capped until enough data accumulates.

### Pattern Detection

Relay analyzes coverage and scheduling patterns to surface insights:

- Which staff frequently call out on specific days or shifts.
- Which staff are the most reliable coverage responders.
- Suggested on-call candidates based on response speed and reliability.

These appear as alerts when you generate the schedule with `/makeschedule`.

### Preference Learning

Relay watches when managers edit draft schedules (removing someone from a shift, adding someone to another). After enough consistent edits, it learns the pattern and auto-applies it to future schedules. Medium-confidence patterns are surfaced as suggestions.

### Demand Signals

When staff mention things like "we were slammed Saturday" or "dead on Monday", Relay captures these demand signals and factors them into scheduling recommendations.

### Contextual Warnings

When generating the schedule, Relay checks the manager's shift log, recent coverage history, and other context to surface relevant warnings (for example, "last week's Friday dinner was short-staffed").

---

## Troubleshooting

| Problem | What to do |
|---------|-----------|
| Bot does not respond in the group | Make sure the bot is a member of the group and has permission to send messages. |
| Staff did not get a private message | They need to register first. Type `/register` in the group and have them tap the link. |
| `/makeschedule` says no availability | Run `/availability` first to collect staff responses. |
| Schedule has unfilled positions | Not enough available staff for those shifts. Cross-trained staff are used automatically. Check `/crosstraining` to see who can fill additional roles. |
| Staff says "I can cover" but nothing happens | They need to be registered. Use `/register` to get them connected. |
| Payroll numbers look wrong | Check `/setrate` to verify hourly rates and `/setovertime` for overtime settings. |
| Tip split does not add up | It always adds up exactly. Check `/tipmode` to verify your settings. |
| Bot sends too many reminders | Reminders are automatic -- one the night before and one two hours before each shift. |
| Need to redo part of setup | Type "reset" during any setup step to clear that section and start over. |
| `/retention` shows up in group | It never does -- retention data is always sent to DMs only. |

---

## Requirements for Staff

1. Have Telegram installed on any device.
2. Someone types `/register` in the group.
3. The staff member taps the link that appears, which opens a private chat with the bot.
4. They are now registered and will receive schedule messages, coverage requests, and reminders.

That is it.
