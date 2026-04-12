# Earned Wage Visibility — Wiring Instructions

## What this module provides

- `isEarnedWageQuery(text)` — keyword detector for wage/earnings queries
- `calculateEarnedWages(staffId, groupId, weekStart, now, db)` — core calculation
- `formatEarnedWageResponse(earned, showRate)` — Telegram-formatted response
- `handleEarnedWageQuery(bot, msg, db)` — full DM handler (lookup + calculate + respond)

## How to wire into the bot

### In `src/routing/dmRouter.js`

Add import:
```js
import { isEarnedWageQuery, handleEarnedWageQuery } from '../engagement/earnedWage.js'
```

Add detection before other DM handlers (after clock detection, before coverage):
```js
if (isEarnedWageQuery(msg.text)) {
  return handleEarnedWageQuery(bot, msg)
}
```

### DB dependencies

The module queries these tables via Supabase (or injected db):
- `schedule_assignments` — staff's weekly shift assignments
- `shifts` — shift times and days
- `staff` — staff name and role
- `role_rates` — hourly rate per role per group
- `staff_dms` — DM chat ID to staff lookup

### Mock DB interface (for tests)

```js
db.getAssignmentsForStaffWeek(staffId, weekStart) // → [{shift_id, day_of_week, start_time, end_time, shift_name}]
db.getStaffWithRole(staffId)                       // → {id, name, role, group_id}
db.getRoleRate(groupId, roleName)                   // → number (hourly rate)
db.getStaffByDmChatId(dmChatId)                     // → {staff_id, group_id, name, role}
```
