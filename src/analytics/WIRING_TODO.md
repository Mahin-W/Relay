# Labor Cost — Wiring Instructions

## commandRouter.js

Add import at top:
```js
import { handleLaborCostCommand } from '../analytics/laborCost.js'
```

Add command handler inside handleGroupCommands, before `return false`:
```js
if (cmd('laborcost')) {
  const admin = await isAuthorizedAdmin(groupId, userId)
  if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can view labor costs.`); return true }
  const weekStart = getNextWeekStart()
  await handleLaborCostCommand(bot, msg.chat.id, groupId, weekStart)
  return true
}
```

## New SQL tables — run in Supabase SQL editor:

```sql
-- weekly_revenue
CREATE TABLE IF NOT EXISTS weekly_revenue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  revenue NUMERIC(10,2),
  total_labor_cost NUMERIC(10,2),
  labor_percent NUMERIC(5,2),
  UNIQUE(group_id, week_start)
);

-- labor_budgets
CREATE TABLE IF NOT EXISTS labor_budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  weekly_budget NUMERIC(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD'
);
```
