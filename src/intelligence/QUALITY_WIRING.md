# Schedule Quality Score - Wiring Instructions

## 1. Sunday Cron Entry

In the Sunday briefing cron (or wherever `generateNarrativeBriefing` is called), add before the briefing generation:

```js
import { calculateWeeklyQualityScore } from './intelligence/scheduleQuality.js'

// Calculate and store quality score for the completed week
const weekStart = getLastMonday() // the Monday of the week that just ended
await calculateWeeklyQualityScore(groupId, weekStart)
```

## 2. Narrative Briefing Integration

In `narrativeBriefing.js`, add quality summary to the briefing output:

```js
import { formatQualitySummary, calculateWeeklyQualityScore } from './intelligence/scheduleQuality.js'
import { getQualityHistory } from './intelligence/scheduleQualityDb.js'
import { detectQualityTrend } from './intelligence/scheduleQuality.js'

// After computing the current week's score:
const result = await calculateWeeklyQualityScore(groupId, weekStart)
const history = await getQualityHistory(groupId, 12)
const trend = detectQualityTrend(history)
const qualityLine = formatQualitySummary(result, trend)

// Append qualityLine to the briefing sections
```

## 3. /quality Command in index.js

Register in `commandRouter.js` or `index.js`:

```js
import { handleQualityCommand } from './intelligence/scheduleQuality.js'

// In command handling:
case '/quality':
  await handleQualityCommand(bot, msg)
  break
```

The command DMs the manager with the full quality trend (never posts to group chat).

## 4. Database Table

Add to `supabase-schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS weekly_quality_scores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  week_start DATE NOT NULL,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  draft_edits INTEGER DEFAULT 0,
  coverage_requests INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  avg_fill_minutes INTEGER,
  unconfirmed_count INTEGER DEFAULT 0,
  weeks_of_data INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (group_id, week_start)
);

ALTER TABLE weekly_quality_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated" ON weekly_quality_scores
  FOR ALL USING (true) WITH CHECK (true);
```
