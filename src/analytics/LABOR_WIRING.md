# Labor Cost Wiring

## Imports for src/index.js
```js
import { handleRevenueInput, parseRevenueInput, getRevenueHistory, formatRevenueHistory } from './analytics/laborCost.js'
```

## /revenue command (group or DM)
```js
bot.onText(/^\/revenue(.*)/, async (msg, match) => {
  const raw = match[1].trim()
  if (!raw) return bot.sendMessage(msg.chat.id, "Usage: /revenue [amount]\nExample: /revenue 14500")
  const revenue = parseRevenueInput(raw)
  if (!revenue && revenue !== 0) return bot.sendMessage(msg.chat.id, "Couldn't parse that amount. Try: /revenue 14500")
  await handleRevenueInput(bot, msg, revenue)
})
```

## /labortrend command
```js
bot.onText(/^\/labortrend/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(msg.from?.id)) return
  const history = await getRevenueHistory(groupId)
  const formatted = formatRevenueHistory(history)
  if (session.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, '📨 Labor trend sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, formatted, { parse_mode: 'Markdown' })
  }
})
```
