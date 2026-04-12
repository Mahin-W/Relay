# Recognition Wiring Instructions

Wire staff recognition into the bot's message pipeline. Do NOT modify recognition.js — only touch the files below.

## 1. groupRouter.js — Passive listener (runs AFTER intent handlers)

At the end of the group message handler, after all intent checks (coverage, trades, etc.), add:

```javascript
import { handleRecognition } from '../engagement/recognition.js'

// ... at the end of the handler, after all other intent checks:
// Passive recognition listener — non-blocking, runs last
handleRecognition(bot, msg, groupId).catch(err => {
  logger.error('Recognition handler error:', err)
})
```

Key: use `.catch()` so recognition errors never block the main message flow.

## 2. commandRouter.js — /kudos command

Add a `/kudos` command handler:

```javascript
import { handleRecognitionHistory } from '../engagement/recognition.js'

// In the command switch/if block:
case '/kudos':
  const kudosName = args.join(' ') // everything after /kudos
  await handleRecognitionHistory(bot, msg, kudosName)
  return
```

## 3. Database — recognition_events table

Run this SQL in Supabase:

```sql
CREATE TABLE IF NOT EXISTS recognition_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  manager_id BIGINT,
  recipient_type TEXT NOT NULL DEFAULT 'team',
  recipient_name TEXT,
  recipient_staff_id BIGINT REFERENCES staff(id),
  role TEXT,
  reason TEXT,
  original_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recognition_group_created ON recognition_events(group_id, created_at DESC);
CREATE INDEX idx_recognition_staff ON recognition_events(recipient_staff_id) WHERE recipient_staff_id IS NOT NULL;

ALTER TABLE recognition_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON recognition_events FOR ALL USING (true);
```
