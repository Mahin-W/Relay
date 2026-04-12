# Staffing Pattern Memory — Wiring Instructions

## Overview
`staffingPatterns.js` analyzes historical schedule data to detect chronic understaffing/overstaffing patterns and seasonal trends. All functions use DB injection (`db = null` last param).

## Exported Functions

| Function | Type | DB? | Purpose |
|---|---|---|---|
| `analyzeShiftStaffingHistory(groupId, shiftId, weeksBack, db)` | async | yes | Single shift analysis |
| `analyzeAllShifts(groupId, weeksBack, db)` | async | yes | All shifts, filtered+sorted |
| `generateStaffingRecommendations(patterns)` | pure | no | Patterns → recommendations |
| `formatStaffingPatternAlert(recommendations)` | pure | no | Recommendations → Telegram text |
| `detectSeasonalPatterns(groupId, db)` | async | yes | 12+ week seasonal analysis |
| `formatSeasonalInsight(patterns, currentMonth)` | pure | no | Seasonal → Telegram text |

## Required DB Interface

The `db` object must provide:

```javascript
{
  getShiftById: async (shiftId) => { id, name, day_of_week, group_id },
  getShiftsByGroup: async (groupId) => [{ id, name, day_of_week }],
  getShiftRequirements: async (shiftId) => [{ role, count }],
  getAssignmentCountsByWeek: async (groupId, shiftId, weekStarts) => Map<weekStart, count>,
}
```

## Wiring into Sunday Briefing

```javascript
import {
  analyzeAllShifts,
  generateStaffingRecommendations,
  formatStaffingPatternAlert,
  detectSeasonalPatterns,
  formatSeasonalInsight,
} from '../intelligence/staffingPatterns.js'

// In briefing generation:
const patterns = await analyzeAllShifts(groupId, 8, db)
const { recommendations } = generateStaffingRecommendations(patterns)
const alert = formatStaffingPatternAlert({ recommendations })
if (alert) briefingSections.push(alert)

const seasonal = await detectSeasonalPatterns(groupId, db)
const seasonalText = formatSeasonalInsight(seasonal, new Date().getMonth())
if (seasonalText) briefingSections.push(seasonalText)
```

## Wiring into Schedule Review

After `generateSchedule()` completes, before sending to manager:

```javascript
const patterns = await analyzeAllShifts(groupId, 8, db)
const recs = generateStaffingRecommendations(patterns)
const alert = formatStaffingPatternAlert(recs)
// Append alert to schedule review message if non-null
```

## Pattern Thresholds

- Chronic pattern: >= 60% of weeks affected AND >= 6 weeks of data
- High severity: understaffed rate >= 75%
- Seasonal: requires 12+ weeks, heavy = 130%+ of average
