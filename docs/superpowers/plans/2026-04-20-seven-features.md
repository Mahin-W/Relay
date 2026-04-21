# Seven Features Implementation Plan — 2026-04-20

## Critical Schema Corrections vs. Spec

The spec assumes columns/tables that don't exist in supabase-schema.sql:

| Assumed | Reality |
|---------|---------|
| `shifts.active` | MISSING — ALTER TABLE needed |
| `staff.active` | MISSING — ALTER TABLE needed |
| `schedule_assignments.active` | MISSING — use `status='cancelled'` instead |
| `time_clock_entries` | MISSING — actual table is `time_entries` |
| `time_entries.alerted_at` | MISSING — ALTER TABLE needed |
| `time_entries.is_manual` | MISSING — ALTER TABLE needed |
| `coverage_requests.initiated_by` | MISSING — ALTER TABLE needed |
| `recurring_constraints` | MISSING — CREATE TABLE needed |
| `staff_availability_windows` | MISSING — CREATE TABLE needed |

## Exact Schema Column Names

### shifts
`id, group_id, name, day_of_week, start_time, end_time, created_at`
*add: active BOOLEAN DEFAULT true*

### staff
`id, group_id, name, role, created_at`
*add: active BOOLEAN DEFAULT true*

### schedule_assignments
`id, group_id, shift_id, staff_id, week_start, status, created_at`
*no active column — use status='cancelled' to cancel*

### coverage_requests
`id, group_id, group_name, shift_description, requested_by, requester_telegram_id, matched_shift_id, week_start, status, covered_by, created_at, covered_at`
*add: initiated_by TEXT DEFAULT 'staff'*

### time_entries (NOT time_clock_entries)
`id, group_id, user_id, staff_id, shift_id, clock_in, clock_out, clock_in_raw, clock_out_raw, created_at`
*add: alerted_at TIMESTAMPTZ, is_manual BOOLEAN DEFAULT false*

### setup_sessions
`group_id, group_name, manager_id, dm_chat_id, phone, step, setup_data, setup_complete, created_at, updated_at`

### manager_log_entries
`id, group_id, manager_id, entry_text, shift_name, day_of_week, week_start, created_at`

## groqWithRetry Call Pattern

```js
import { groq, groqWithRetry } from '../../parsers/groq.js'

const completion = await groqWithRetry(() => groq.chat.completions.create({
  model: 'llama-3.3-70b',
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text }
  ]
}))
const result = JSON.parse(completion.choices[0].message.content)
```

## db=null Injection Pattern

```js
export async function handleFoo(bot, msg, db = null) {
  const _getShifts = db?.getShiftsForGroup ?? getShiftsForGroup
  const _saveShift = db?.saveShift ?? saveShift
  // use _getShifts, _saveShift throughout
}
```

## Run Tests

```bash
node --env-file=.env --test src/tests/unit/FEATURE.test.js
```

## MockBot API

```js
import { MockBot, makeGroupMsg, makeDMMsg } from '../helpers/mocks.js'
const bot = new MockBot()
bot.sentMessages        // array of all sent messages
bot.last                // last sent message
bot.messagesTo(chatId)  // messages to a specific chat
bot.lastMessage(chatId) // last message to chatId
bot.assertSent(chatId, text)
bot.assertSilent()
bot.setAdmin(chatId, userId)  // make user admin
bot.getChatMember(chatId, userId)  // check status
```

## File Ownership (zero overlaps)

| Agent | New Files | Do NOT Touch |
|-------|-----------|--------------|
| 1 | src/setup/shiftEditor.js, src/tests/unit/shiftEditor.test.js | all others |
| 2 | src/setup/staffManager.js, src/tests/unit/staffManager.test.js | all others |
| 3 | src/coverage/managerCoverage.js, src/tests/unit/managerCoverage.test.js | all others |
| 4 | src/timeOff/recurringTimeOff.js, src/timeOff/recurringTimeOffDb.js, src/tests/unit/recurringTimeOff.test.js | all others |
| 5 | src/availability/availabilityWindow.js, src/tests/unit/availabilityWindow.test.js | all others |
| 6 | src/timeclock/missedClockOut.js, src/tests/unit/missedClockOut.test.js | all others |
| 7 | src/timeclock/clockOverride.js, src/tests/unit/clockOverride.test.js | all others |

## Wiring Insertion Points (done AFTER all 7 green)

### index.js — add bot.onText commands
```js
// After existing commands, before process.on('SIGINT')
import { handleShiftsCommand, handleEditShift, handleAddShift, handleRemoveShift } from './setup/shiftEditor.js'
import { handleViewStaff, handleRemoveStaff } from './setup/staffManager.js'
import { handleCoverageCommand } from './coverage/managerCoverage.js'
import { handleMissedClockOutCheck } from './timeclock/missedClockOut.js'

bot.onText(/\/shifts/, (msg) => handleShiftsCommand(bot, msg))
bot.onText(/\/editshift(.*)/, (msg, match) => handleEditShift(bot, msg, match[1].trim()))
bot.onText(/\/addshift/, (msg) => handleAddShift(bot, msg))
bot.onText(/\/removeshift(.*)/, (msg, match) => handleRemoveShift(bot, msg, match[1].trim()))
bot.onText(/\/staff/, (msg) => handleViewStaff(bot, msg))
bot.onText(/\/removestaff(.*)/, (msg, match) => handleRemoveStaff(bot, msg, match[1].trim()))
bot.onText(/\/coverage(.*)/, (msg, match) => handleCoverageCommand(bot, msg, match))
```

### 15-min cron in index.js (new)
```js
cron.schedule('*/15 * * * *', async () => {
  const { data: groups } = await supabase
    .from('setup_sessions').select('group_id').eq('setup_complete', true)
  for (const g of groups || []) {
    await handleMissedClockOutCheck(bot, g.group_id)
  }
})
```

### dmRouter.js — early in handleDmMessage, before existing handlers
```js
// 1. Clock override (admin only) — import at top
// if (isGroupAdmin) { detectClockOverride check }

// 2. Availability window update
// await handleAvailabilityWindowUpdate(bot, msg)

// 3. Recurring constraint
// const wasConstraint = await handleRecurringConstraint(bot, msg)
// if (wasConstraint) return
```

### groupRouter.js — passive block (lines 122-150)
```js
// detectManagerCoverageRequest → handleManagerCoveragePost (admin only)
// detectStaffRemoval (admin only) → handleRemoveStaff
```

### generateSchedule.js — inside filter at line 160
```js
// After loading shifts/staff/availability, load recurring constraints
// Apply in candidate filter: if recurring constraint blocks staff from shift → skip
```

## All New SQL (run in Supabase SQL Editor)

```sql
-- Activate soft-delete on shifts
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- Activate soft-delete on staff
ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- Track who initiated coverage requests
ALTER TABLE coverage_requests ADD COLUMN IF NOT EXISTS initiated_by TEXT DEFAULT 'staff';

-- Missed clock-out alerts
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

-- Manual clock adjustments
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;

-- Recurring time-off constraints
CREATE TABLE IF NOT EXISTS recurring_constraints (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('day_off','time_constraint')),
  day_of_week TEXT,
  before_time TEXT,
  after_time TEXT,
  note TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_id, group_id, day_of_week, type)
);
CREATE INDEX IF NOT EXISTS idx_recurring_constraints_group
  ON recurring_constraints(group_id, active);
ALTER TABLE recurring_constraints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon on recurring_constraints"
  ON recurring_constraints FOR ALL TO anon USING (true) WITH CHECK (true);

-- Staff availability windows
CREATE TABLE IF NOT EXISTS staff_availability_windows (
  id BIGSERIAL PRIMARY KEY,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE UNIQUE,
  group_id TEXT NOT NULL,
  days_available TEXT[],
  before_time TEXT,
  after_time TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE staff_availability_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for anon on staff_availability_windows"
  ON staff_availability_windows FOR ALL TO anon USING (true) WITH CHECK (true);
```
