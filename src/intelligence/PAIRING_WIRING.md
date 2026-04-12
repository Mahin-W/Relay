# Pairing Optimizer — Wiring Instructions

## Overview
Optimal shift pairing analyzes historical shift outcomes to identify staff pairs that work well (or poorly) together, then applies that insight during schedule generation.

## Files
- `src/intelligence/pairingOptimizer.js` — all pairing logic
- `src/tests/unit/pairingOptimizer.test.js` — 19 unit tests

## Exported Functions

| Function | Type | DB? | Purpose |
|----------|------|-----|---------|
| `getShiftOutcomeHistory(groupId, weeksBack, db)` | async | Yes | Score each shift instance 0-100 from events |
| `analyzePairOutcomes(shiftHistory, staffNames)` | pure | No | Find positive/negative staff pairs |
| `getPairingRecommendations(groupId, weeksBack, db)` | async | Yes | Full pipeline: history -> pair analysis |
| `applyPairingOptimization(assignments, pairingData)` | pure | No | Swap negative pairs if safe |
| `formatPairingInsight(applied)` | pure | No | Format message for manager |

## DB Adapter Shape

The `db` parameter must provide these async functions:

```javascript
{
  getPublishedAssignments(groupId, weeksBack) -> [{group_id, shift_id, staff_id, week_start, status}]
  getShiftsForGroup(groupId) -> [{id, group_id, name, day_of_week, start_time, end_time}]
  getCoverageRequestsForGroup(groupId, weeksBack) -> [{group_id, matched_shift_id, created_at, status}]
  getReliabilityEventsForGroup(groupId, weeksBack) -> [{staff_id, group_id, event_type, metadata, recorded_at}]
  getRecognitionEventsForGroup(groupId, weeksBack) -> [{group_id, recipient_staff_id, created_at}]
  getStaffForGroup(groupId) -> [{id, group_id, name}]
}
```

## Integration Point: generateSchedule.js

After schedule generation, before review:

```javascript
import { getPairingRecommendations, applyPairingOptimization, formatPairingInsight } from '../intelligence/pairingOptimizer.js'

// After generating assignments...
const pairingData = await getPairingRecommendations(groupId, 8, pairingDb)
const { newAssignments, applied } = applyPairingOptimization(assignments, pairingData)
const pairingNote = formatPairingInsight(applied)

// Use newAssignments instead of assignments
// Append pairingNote to manager review message if not null
```

## Integration Point: reviewSchedule.js

Show pairing insight in the manager review message:

```javascript
if (pairingNote) {
  reviewMessage += '\n\n' + pairingNote
}
```

## Scoring Model

Base score: 80 per shift instance
- -20 per coverage request on that shift/week
- -10 per late arrival by assigned staff
- -30 per no-call-no-show by assigned staff
- +10 per recognition event (capped at +20)
- Clamped 0-100

## Pair Classification

- **Positive**: pairingBenefit >= 10 (avg score together - avg score apart)
- **Negative**: pairingBenefit <= -10
- **Neutral**: between -10 and +10
- Minimum 3 shifts together required

## Safety Constraints

1. Never violate role requirements (swap must have same role)
2. Never force swaps (if no valid alternative, keep original)
3. Never create a new negative pair when resolving one
4. Graceful degradation: no history = no optimization, never crash
5. Pairing data is manager-only, invisible to staff
