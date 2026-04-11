# Manager Shift Log Wiring

## Imports for src/index.js
```js
import { handleLogCommand } from './managerLog/shiftLog.js'
```

## /log command
```js
bot.onText(/^\/log(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return
  const args = (match[1] || '').trim()
  await handleLogCommand(bot, msg, args)
})
```

## DM Router addition (src/routing/dmRouter.js)
Add BEFORE the final fallback message (line 156), AFTER the trade offer check (line 154):
```js
// Manager shift log — catch-all for manager free-text
import { handleLogEntry } from '../managerLog/shiftLog.js'

// Add after line 154, before the fallback:
const managerGroupForLog = managerGroup || await getManagerGroup(userId)
if (managerGroupForLog && text.length > 10 && !text.startsWith('/')) {
  try {
    await handleLogEntry(bot, msg)
    return
  } catch (err) {
    logger.error(`Log entry failed: ${err.message}`)
  }
}
```
