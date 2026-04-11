# Budget Alert — Wiring Instructions

## commandRouter.js — /makeschedule handler

Add import at top of commandRouter.js:
```js
import { getBudgetAlertForSchedule } from '../analytics/budgetAlert.js'
```

In the /makeschedule handler, after `const schedule = await generateWeeklySchedule(groupId, weekStart)`:
```js
const budgetAlert = await getBudgetAlertForSchedule(groupId, schedule.assignments, schedule.shifts ?? [])
```

Then in the DM message sent to manager, append budgetAlert if present:
```js
const budgetSection = budgetAlert ? `\n\n${budgetAlert}` : ''
await bot.sendMessage(managerGroup.dm_chat_id,
  `📋 *Draft Schedule Ready*\n\n${formatted}${clopeningWarn}${hoursWarn}${budgetSection}\n${reviewPrompt}`,
  { parse_mode: 'Markdown' })
```

## New SQL — run in Supabase SQL editor:

```sql
-- labor_budgets
CREATE TABLE IF NOT EXISTS labor_budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  weekly_budget NUMERIC(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD'
);
```
