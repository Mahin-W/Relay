# Callout Predictor Wiring Guide

## What it does
Predictive callout risk analysis that combines multiple signals (historical callout rates, morale, consecutive days, recent spikes) into a 0-1 probability per schedule assignment. This is different from patternAlerts.js which does binary flag detection.

## Integration point: reviewSchedule.js

In `reviewSchedule.js`, after generating the schedule and before presenting to the manager, call:

```javascript
import { predictCalloutRisks, formatCalloutRiskSection } from '../intelligence/calloutPredictor.js'

// After generating assignments, before sending review message:
const risks = await predictCalloutRisks(groupId, assignments, db)
const riskSection = formatCalloutRiskSection(risks, weeksOfData)
if (riskSection) {
  // Append to the review message sent to the manager
  reviewMessage += '\n\n' + riskSection
}
```

## Assignment shape expected

Each assignment object passed to `predictCalloutRisks` needs:
```javascript
{
  staffId: string,       // internal staff ID
  staffName: string,     // display name
  shiftName: string,     // e.g. "Dinner"
  dayOfWeek: string,     // e.g. "Friday"
  telegramId: number     // for matching coverage_requests.requester_telegram_id
}
```

## DB methods needed (for mock injection)

If using db injection for testing:
- `db.getCalloutHistory(groupId, staffId)` - returns `[{ day_of_week, shift_name, created_at }]`
- `db.getMoraleEvents(groupId, staffId)` - returns morale event rows
- `db.getConsecutiveDays(groupId, staffId, dayOfWeek)` - returns number

## Key behaviors
- **New staff protection:** If totalObservations < 3, riskLevel capped at 'medium'
- **Insufficient data:** formatCalloutRiskSection returns null if weeksOfData < 4
- **Manager-only:** Never expose risk data to staff members
- **Non-low only:** predictCalloutRisks filters out 'low' risk assignments
