# Manager Shift Log — Wiring Instructions

## dmRouter.js — insert handler before fallback

Add import at top of dmRouter.js:
```js
import { handleManagerLogEntry } from '../managerLog/shiftLog.js'
```

Find the fallback section near line 156. Insert BEFORE it:
```js
// Manager shift log — catch manager free-text DMs
const logHandled = await handleManagerLogEntry(bot, msg)
if (logHandled) return
```

That's it. The handler internally checks: is sender a manager? is text > 10 chars?

## New SQL — run in Supabase SQL editor:

```sql
CREATE TABLE IF NOT EXISTS manager_log_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  manager_id BIGINT NOT NULL,
  entry_text TEXT NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manager_log_entries_group_week
  ON manager_log_entries (group_id, week_start);
```
