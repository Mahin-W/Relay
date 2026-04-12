# Implicit Constraint Discovery - Wiring Instructions

## Overview

The implicit constraint discovery system analyzes schedule history to detect
unwritten scheduling rules (patterns the manager follows but never explicitly
stated). It runs every 4 weeks and surfaces max 2 questions to the manager.

## Database Setup

Run the following SQL to create the `discovered_patterns` table:

```sql
CREATE TABLE IF NOT EXISTS discovered_patterns (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL,
  staff_id_a BIGINT REFERENCES staff(id),
  staff_id_b BIGINT REFERENCES staff(id),
  shift_id BIGINT REFERENCES shifts(id),
  day_of_week TEXT,
  confidence DECIMAL(3,2),
  weeks_analyzed INTEGER,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','converted','dismissed')),
  asked_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, type, COALESCE(staff_id_a,0), COALESCE(staff_id_b,0), COALESCE(shift_id,0), COALESCE(day_of_week,''))
);
CREATE INDEX ON discovered_patterns(group_id, status);
```

## Integration Points

### 1. Schedule Publication (reviewSchedule.js)

After a schedule is published, check if discovery should run:

```javascript
import {
  shouldRunDiscovery,
  analyzeAssignmentPatterns,
  filterAlreadyKnownConstraints,
  generateDiscoveryPrompts,
  saveDiscoveredPattern,
  getDismissedPatterns,
} from '../intelligence/implicitConstraints.js'
import { getRules } from '../rules/rulesDb.js'

// After publishing schedule:
const weekStart = getCurrentWeekStart() // YYYY-MM-DD
if (await shouldRunDiscovery(groupId, weekStart)) {
  const patterns = await analyzeAssignmentPatterns(groupId, 10)
  const rules = await getRules(groupId)
  const dismissed = await getDismissedPatterns(groupId)
  const newPatterns = filterAlreadyKnownConstraints(patterns, rules, dismissed)

  if (newPatterns.length > 0) {
    const prompts = generateDiscoveryPrompts(newPatterns)
    for (const prompt of prompts) {
      await saveDiscoveredPattern(groupId, prompt.patternData)
      // Send question to manager via DM
      await bot.sendMessage(managerChatId, prompt.question, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Yes, add rule', callback_data: `disc_yes_${prompt.patternId}` },
            { text: 'No, skip', callback_data: `disc_no_${prompt.patternId}` },
          ]]
        }
      })
    }
  }
}
```

### 2. Manager Response Handler (commandRouter.js or dmRouter.js)

Handle callback queries for discovery prompts:

```javascript
// On 'Yes' → convert pattern to business rule via saveRule()
// On 'No'  → call dismissPattern(patternId)
```

### 3. Sunday Briefing (dailyBriefing.js)

Optionally include pending discovery questions in the weekly briefing
if the manager hasn't responded yet.

## Pattern Types

| Type | Min Weeks | Threshold | Converts To |
|------|-----------|-----------|-------------|
| never_together | 8 | Both staff active 4+ weeks, never on same shift+day | staff_conflict |
| always_on_shift | 6 | >= 80% weeks on shift | shift_preference |
| never_on_day | 6 | Never scheduled, not explicitly unavailable | day_off |
| always_together | 6 | >= 75% weeks together on shift | (new rule type or manual) |

## Manager-Only

All discovery data and prompts are manager-only. Staff should never see
discovery questions or know that their patterns are being analyzed.
