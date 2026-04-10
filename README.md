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
3. **Generate the schedule** -- Type `/makeschedule` in the group. The bot builds a draft schedule using availability, role requirements, and fairness rotation. It flags problems like clopenings (less than 10 hours of rest between shifts) and overtime risks (40+ hours).
4. **Review the draft** -- The bot sends the draft to the manager in a private message. You can type "approve", "approve anyway" (to publish despite warnings), "regenerate" (for a different arrangement), or make edits in plain English like "remove Sarah from Friday Dinner" or "add Mike to Saturday Lunch".
5. **Publish** -- Once you approve, the schedule is posted to the group.
6. **Staff get their schedules** -- Each staff member receives a private message showing only their shifts for the week. They reply "got it" to confirm they have seen it.
7. **Track confirmations** -- Type `/receipts` to see who has not confirmed yet.
8. **Payroll** -- Payroll is calculated automatically when the schedule is published. You get a text summary and an Excel spreadsheet.
9. **Daily briefings** -- Every morning at 8am, the manager gets a private message with today's shifts and anything that needs attention.
10. **Shift reminders** -- Staff get a reminder the night before their shift and again two hours before. If someone has not confirmed 15 minutes before their shift, the manager gets a warning.

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
| `/makeschedule` | Admin | Generates next week's schedule based on availability, role requirements, and fairness rotation. |
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
| "got it" | Confirms you have seen your schedule (read receipt). |

Managers also get extra options in their private chat:

| What to say | What happens |
|-------------|--------------|
| "approve" | Publishes the draft schedule to the group. |
| "approve anyway" | Publishes despite warnings about clopenings or overtime. |
| "regenerate" | Asks the bot to build a different schedule arrangement. |
| Natural language edits (like "remove Sarah from Friday Dinner" or "add Mike to Saturday Lunch") | The bot updates the draft accordingly. |
| "approve [name]" or "deny [name]" | Approves or denies a time-off request. |

---

## Natural Language (Just Talk Normally)

You do not need to memorize commands for most things. Just type what you mean in the group chat and the bot will figure it out.

### Coverage and Callouts

When someone cannot make their shift:

| What to say | What happens |
|-------------|--------------|
| "I can't come in tonight" | The bot posts a coverage request to the group and sends private messages to all registered staff asking who can cover. On-call staff get notified first. |
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
| Reliability tracking | Automatically on every coverage, no-show, and trade event | Stored internally, visible with `/reliability` |
| Rotation fairness | During schedule generation | Automatically balances who gets the desirable shifts |
| Payroll calculation | When the schedule is published | Manager gets a text summary and an Excel spreadsheet |

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

---

## Pay and Overtime

- Payroll is calculated automatically when the schedule is published.
- The manager receives a text summary in a private message showing each staff member's hours and gross pay.
- The manager also receives an Excel spreadsheet with three tabs: Schedule, Payroll, and Late Arrivals.
- Staff can message the bot "my pay" to see this week's breakdown, or "pay history" for the last four weeks.
- Overtime settings are configured during setup or with `/setovertime`. You can set weekly thresholds, daily thresholds, and multipliers.
- Late arrival deductions are factored into payroll automatically.

---

## Troubleshooting

| Problem | What to do |
|---------|-----------|
| Bot does not respond in the group | Make sure the bot is a member of the group and has permission to send messages. |
| Staff did not get a private message | They need to register first. Type `/register` in the group and have them tap the link. |
| `/makeschedule` says no availability | Run `/availability` first to collect staff responses. |
| Schedule has unfilled positions | Not enough available staff for those shifts. Check `/hours` to see the gaps. |
| Staff says "I can cover" but nothing happens | They need to be registered. Use `/register` to get them connected. |
| Payroll numbers look wrong | Check `/setrate` to verify hourly rates and `/setovertime` for overtime settings. |
| Bot sends too many reminders | Reminders are automatic -- one the night before and one two hours before each shift. |
| Need to redo part of setup | Type "reset" during any setup step to clear that section and start over. |

---

## Requirements for Staff

1. Have Telegram installed on any device.
2. Someone types `/register` in the group.
3. The staff member taps the link that appears, which opens a private chat with the bot.
4. They are now registered and will receive schedule messages, coverage requests, and reminders.

That is it.
