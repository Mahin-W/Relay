# /retention Command Wiring

Wire into `src/routing/commandRouter.js` (or `src/index.js` command handler).

**CRITICAL: /retention data MUST always DM the manager. Never post to group chat.**

## Import

```javascript
import { generateTurnoverRiskReport, formatTurnoverRiskCommand } from './intelligence/turnoverRisk.js'
```

## Command Handler

```javascript
// In command router or index.js command dispatch:
if (command === '/retention') {
  // Must be admin/manager
  const member = await bot.getChatMember(msg.chat.id, msg.from.id)
  if (!['administrator', 'creator'].includes(member.status)) return

  const report = await generateTurnoverRiskReport(String(msg.chat.id), db)
  const formatted = formatTurnoverRiskCommand(report)

  // ALWAYS DM the manager — never post to group
  const dmChatId = String(msg.from.id)
  await bot.sendMessage(dmChatId, formatted, { parse_mode: 'Markdown' })

  // Optional: confirm in group that DM was sent
  await bot.sendMessage(msg.chat.id, 'Retention report sent to your DMs.', { parse_mode: 'Markdown' })
}
```

## Notes

- The report contains sensitive staff risk assessments — group posting would be harmful
- `generateTurnoverRiskReport` accepts `db` as last param for testability
- If the manager hasn't started a DM with the bot, the sendMessage to DM will fail — wrap in try/catch and tell them to start the bot first
