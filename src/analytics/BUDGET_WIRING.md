# Budget Alert Wiring

## Imports for src/index.js
```js
import { saveBudget, getBudget } from './analytics/budgetAlert.js'
```

## /setbudget command
```js
bot.onText(/^\/setbudget(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return bot.sendMessage(msg.chat.id, "⚠️ Only admins can set the budget.")
  const raw = match[1].trim()
  const amount = parseFloat(raw.replace(/[$,]/g, ''))
  if (!amount || amount <= 0) {
    return bot.sendMessage(msg.chat.id, "Usage: /setbudget 3200\nSets your weekly labor budget to $3,200")
  }
  await saveBudget(groupId, amount)
  bot.sendMessage(msg.chat.id, `✅ Weekly labor budget set to $${amount.toFixed(2)}`)
})
```

## /budget command
```js
bot.onText(/^\/budget$/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const b = await getBudget(String(msg.chat.id))
  if (!b) return bot.sendMessage(msg.chat.id, "No budget set. Use /setbudget [amount]")
  bot.sendMessage(msg.chat.id, `💰 Weekly labor budget: $${b.weeklyBudget}`)
})
```

## Integration with /makeschedule in commandRouter.js
After line 61 where schedule is generated, before sending DM to manager:
```js
import { calculateProjectedLaborCost, formatBudgetAlert, getBudget } from '../analytics/budgetAlert.js'
import { getRatesForGroup } from '../setup/setupDb.js'  // already imported
import { getOvertimeSettings } from '../setup/setupDb.js'  // may need import

// After: const schedule = await generateWeeklySchedule(groupId, weekStart)
const shifts = await getShiftsForGroup(groupId)  // already available in scope
const rates = await getRatesForGroup(groupId)
const otSettings = await getOvertimeSettings(groupId)
const projected = calculateProjectedLaborCost(schedule.assignments, shifts, rates, otSettings ?? {})
const budget = await getBudget(groupId)
const budgetSection = formatBudgetAlert(projected, budget?.weeklyBudget ?? null, weekStart)
// Append budgetSection to the DM message before REVIEW_PROMPT
```
