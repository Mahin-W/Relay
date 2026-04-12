# Availability Learning — Wiring Instructions

## Database Table Required

```sql
CREATE TABLE availability_outcomes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id text NOT NULL,
  staff_id text NOT NULL,
  week_start date NOT NULL,
  day_of_week text NOT NULL,
  stated_available boolean NOT NULL,
  actual_outcome text NOT NULL CHECK (actual_outcome IN ('worked', 'callout', 'time_off', 'no_show')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_avail_outcomes_staff ON availability_outcomes(group_id, staff_id);
CREATE INDEX idx_avail_outcomes_week ON availability_outcomes(week_start);

ALTER TABLE availability_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON availability_outcomes FOR ALL USING (true);
```

## Integration Points

### 1. Record Outcomes (after each week completes)

In the weekly schedule finalization flow (or a cron/scheduled task), compare stated availability vs actual:

```javascript
import { saveAvailabilityOutcome } from './intelligence/availabilityLearningDb.js'

// For each staff member + day in the completed week:
await saveAvailabilityOutcome(groupId, staffId, weekStart, dayOfWeek, statedAvailable, actualOutcome, db)
```

**Where to get data:**
- `statedAvailable`: from `availability_responses` table (what staff said in /availability flow)
- `actualOutcome`: from `schedule_assignments` status + `coverage_requests` + `time_entries`
  - assigned + clocked in = 'worked'
  - assigned + coverage request filed = 'callout'
  - assigned + time_off request = 'time_off'
  - assigned + no clock-in + no coverage = 'no_show'

### 2. Flag Risky Assignments (during schedule generation)

In `generateSchedule.js`, after building draft assignments:

```javascript
import { calculateReliableAvailability, applyLearnedAvailability } from './intelligence/availabilityLearning.js'

// Build reliability map for all assigned staff
const reliabilityMap = new Map()
for (const staffId of uniqueStaffIds) {
  const reliability = await calculateReliableAvailability(staffId, groupId, 8, db)
  reliabilityMap.set(staffId, reliability)
}

// Apply learned availability to flag risky assignments
const { assignments, risks } = applyLearnedAvailability(draftAssignments, reliabilityMap)
```

### 3. Show Risk Section in Schedule Review (manager DM)

In `reviewSchedule.js`, when sending the draft to the manager:

```javascript
import { formatAvailabilityRiskSection } from './intelligence/availabilityLearning.js'

const riskText = formatAvailabilityRiskSection(risks)
if (riskText) {
  message += '\n\n' + riskText
}
```

### 4. Staff Insight Command (manager only)

Add a `/staffinsight <name>` command:

```javascript
import { calculateReliableAvailability, formatAvailabilityInsight } from './intelligence/availabilityLearning.js'

const reliability = await calculateReliableAvailability(staffId, groupId, 8, db)
const text = formatAvailabilityInsight(staffName, reliability)
bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
```

### 5. Weekly Summary Gap Detection

In the weekly briefing (e.g., Sunday briefing):

```javascript
import { detectStatedVsActualGap } from './intelligence/availabilityLearning.js'

const gaps = await detectStatedVsActualGap(groupId, db)
// gaps = array of reliability objects for staff with 'avoid' days
```

## Important Notes

- **INSERT only**: Never update/upsert records. Each outcome is a historical data point.
- **Manager only**: Never expose reliability data to staff members.
- **Minimum 4 weeks**: `applyLearnedAvailability` only flags when `weeksAnalyzed >= minimumWeeks` (default 4).
- **Recent weighting**: Last 3 weeks count 2x in reliability calculations.
- **Graceful degradation**: Empty data returns 'unknown' status, never crashes.
