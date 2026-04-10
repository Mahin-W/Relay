# Payroll Wiring TODO

Snippets ready to paste into src/index.js when the parallel session is done.

## /setovertime command

```js
// Add import at top of src/index.js:
import { startOvertimeStep } from './setup/overtimeSteps.js'
import { getManagerGroup } from './setup/setupDb.js'

// Add bot.onText block:
bot.onText(/^\/setovertime/, async (msg) => {
  if (msg.chat.type === 'private') return
  const session = await getManagerGroup(msg.from.id)
  if (!session) return
  await startOvertimeStep(bot, session.dm_chat_id, String(msg.chat.id), session.setup_data ?? {})
})
```

## /spreadsheet command

```js
// Add import at top of src/index.js:
import { sendPayrollSpreadsheet } from './payroll/spreadsheetGenerator.js'

// Add bot.onText block:
bot.onText(/^\/spreadsheet(.*)/, async (msg, match) => {
  if (msg.chat.type === 'private') return
  if (!(await isBotAdmin(String(msg.chat.id), msg.from.id))) return
  const weekStart = match[1].trim() || null
  await bot.sendMessage(msg.chat.id, '📊 Generating payroll spreadsheet...')
  await sendPayrollSpreadsheet(bot, String(msg.chat.id), weekStart, null)
})
```

## DM router — pay query triggers (add BEFORE LLM call in src/routing/dmRouter.js)

```js
import { isPayQuery, isHistoryQuery, handleStaffPayQuery, handleStaffHistoryQuery } from '../payroll/staffPayService.js'

// Before LLM fallback:
if (isHistoryQuery(text)) return handleStaffHistoryQuery(bot, msg, db)
if (isPayQuery(text))     return handleStaffPayQuery(bot, msg, db)
```

## publishSchedule — spreadsheet send (add after sendPayReport in src/schedule/reviewSchedule.js)

```js
import { sendPayrollSpreadsheet } from '../payroll/spreadsheetGenerator.js'

// Inside publishSchedule try/catch after sendPayReport call:
try { await sendPayrollSpreadsheet(bot, groupId, weekStart, db) }
catch(e) { logger.error('Spreadsheet failed:', e.message) }
```
