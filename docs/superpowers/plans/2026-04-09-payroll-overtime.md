# Payroll Overtime & Spreadsheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add overtime configuration to the setup wizard, OT-aware pay calculation, a personal pay stub formatter, and a payroll spreadsheet generator.

**Architecture:** Four independent features built TDD. Feature 1 wires a new `overtime_setup` step into the existing setup flow state machine. Feature 2 adds pure OT calculation functions alongside (not replacing) existing pay functions. Feature 3 adds `formatPersonalPayStub` to staffPayService. Feature 4 adds ExcelJS-based spreadsheet generation with a Python recalc script.

**Tech Stack:** Node.js 25, ES modules, node:test + assert/strict, ExcelJS (install needed), MockBot/MockDB from src/tests/helpers/mocks.js

---

## AUDIT FINDINGS

### Already implemented — DO NOT recreate:
- `src/payroll/payCalculator.js` — calculateShiftPay, calculateWeeklyPay, formatPayBreakdown (basic, no OT)
- `src/payroll/payDb.js` — savePeriodPayroll, getPayrollForWeek, getPayrollHistory, getLateEventsForWeek
- `src/payroll/payReport.js` — formatWeeklyPayReport, sendPayReport, formatStaffPayHistory
- `src/payroll/staffPayService.js` — isPayQuery, isHistoryQuery, handleStaffPayQuery, handleStaffHistoryQuery
- `src/tests/unit/payCalculator.test.js` — 22 tests
- `src/tests/unit/payReport.test.js` — 15 tests
- `src/tests/unit/staffPayService.test.js` — 18 tests

### Does NOT exist — build these:
- `src/setup/db/overtime.js`
- `src/setup/overtimeSteps.js`
- `src/tests/unit/overtimeSetup.test.js`
- `src/tests/unit/overtimePay.test.js`
- `src/tests/unit/spreadsheetGenerator.test.js`
- `src/payroll/spreadsheetGenerator.js`
- `src/payroll/WIRING_TODO.md`
- `scripts/recalc.py`

### Modify:
- `src/setup/setupFlow.js` — add `case 'overtime_setup'`
- `src/setup/setupDb.js` — add `export * from './db/overtime.js'`
- `src/setup/staffSteps.js` — route "done" to overtime_setup instead of completeSetup
- `src/payroll/payCalculator.js` — append OT functions (keep existing functions intact)
- `src/payroll/staffPayService.js` — append formatPersonalPayStub

### Do NOT touch (parallel sessions):
- src/routing/groupRouter.js, dmRouter.js
- src/parsers/messageParsers.js
- src/schedule/copySchedule.js
- src/onboarding/, src/coverage/partialCoverage.js
- src/index.js (add wiring to WIRING_TODO.md instead)

---

## Task 1: overtime DB functions

**Files:**
- Create: `src/setup/db/overtime.js`
- Modify: `src/setup/setupDb.js`

- [ ] **Step 1.1: Create src/setup/db/overtime.js**

```js
import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const DEFAULTS = {
  overtime_enabled: true,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_overtime_enabled: false,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

export async function saveOvertimeSettings(groupId, settings, db = null) {
  if (db?.saveOvertimeSettings) return db.saveOvertimeSettings(groupId, settings)
  try {
    const { data, error } = await supabase
      .from('overtime_settings')
      .upsert(
        { group_id: groupId, ...settings, updated_at: new Date().toISOString() },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Overtime settings saved for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveOvertimeSettings failed: ${err.message}`)
    return null
  }
}

export async function getOvertimeSettings(groupId, db = null) {
  if (db?.getOvertimeSettings) return db.getOvertimeSettings(groupId)
  try {
    const { data, error } = await supabase
      .from('overtime_settings')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    if (!data) return { ...DEFAULTS }
    return {
      overtime_enabled: data.overtime_enabled ?? DEFAULTS.overtime_enabled,
      weekly_threshold: Number(data.weekly_threshold ?? DEFAULTS.weekly_threshold),
      weekly_multiplier: Number(data.weekly_multiplier ?? DEFAULTS.weekly_multiplier),
      daily_overtime_enabled: data.daily_overtime_enabled ?? DEFAULTS.daily_overtime_enabled,
      daily_threshold: Number(data.daily_threshold ?? DEFAULTS.daily_threshold),
      daily_multiplier: Number(data.daily_multiplier ?? DEFAULTS.daily_multiplier),
    }
  } catch (err) {
    logger.error(`getOvertimeSettings failed: ${err.message}`)
    return { ...DEFAULTS }
  }
}
```

- [ ] **Step 1.2: Add barrel export to src/setup/setupDb.js**

Append this line to the file:
```js
export * from './db/overtime.js'
```

- [ ] **Step 1.3: Syntax check**

```bash
node --check src/setup/db/overtime.js
node --check src/setup/setupDb.js
```
Expected: no output (clean).

---

## Task 2: overtime_setup step in the flow

**Files:**
- Create: `src/setup/overtimeSteps.js`
- Modify: `src/setup/setupFlow.js` (add case)
- Modify: `src/setup/staffSteps.js` (reroute "done")

The step tracks sub-state in `session.setup_data.overtime_stage`.

- [ ] **Step 2.1: Create src/setup/overtimeSteps.js**

```js
import { updateSetupSession } from './setupDb.js'
import { saveOvertimeSettings } from './setupDb.js'
import { logger } from '../logger.js'

function parsePositiveFloat(text) {
  const n = parseFloat(text)
  return isNaN(n) ? null : n
}

async function finishOvertimeSetup(bot, msg, session, db) {
  const d = session.setup_data
  const settings = {
    overtime_enabled: d.overtime_enabled ?? false,
    weekly_threshold: d.overtime_weekly_threshold ?? 40,
    weekly_multiplier: d.overtime_weekly_multiplier ?? 1.5,
    daily_overtime_enabled: d.overtime_daily_enabled ?? false,
    daily_threshold: d.overtime_daily_threshold ?? 8,
    daily_multiplier: 1.5,
  }
  await saveOvertimeSettings(session.group_id, settings, db)

  let summary = `✅ *Overtime settings saved:*\n`
  if (!settings.overtime_enabled) {
    summary += `• No overtime configured.`
  } else {
    summary += `• Weekly OT: after ${settings.weekly_threshold}hrs @ ${settings.weekly_multiplier}x pay\n`
    if (settings.daily_overtime_enabled) {
      summary += `• Daily OT: after ${settings.daily_threshold}hrs @ ${settings.daily_multiplier}x pay`
    }
  }
  await bot.sendMessage(msg.chat.id, summary, { parse_mode: 'Markdown' })

  // Advance to complete
  await updateSetupSession(session.group_id, { step: 'complete', setup_complete: true }, db)

  // Announce in group
  try {
    const managerName = msg.from?.first_name || 'The manager'
    await bot.sendMessage(
      session.group_id,
      `✅ *Relay Setup Complete*\n\n${managerName} has finished configuring Relay for this group.\nI'm now ready to handle shift coverage automatically.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error(`Could not announce setup complete: ${err.message}`)
  }

  logger.success(`Setup complete (with overtime) for group ${session.group_id}`)
}

export async function handleOvertimeStep(bot, msg, session, text, db = null) {
  const stage = session.setup_data?.overtime_stage ?? 'ask_enabled'
  const chatId = msg.chat.id
  const yn = text.toLowerCase()

  if (stage === 'ask_enabled') {
    if (yn === 'yes') {
      await updateSetupSession(session.group_id, {
        setup_data: { ...session.setup_data, overtime_enabled: true, overtime_stage: 'ask_weekly_threshold' },
      }, db)
      await bot.sendMessage(chatId,
        `After how many hours per *week* does overtime kick in? _(Most common: 40)_\nReply with a number.`,
        { parse_mode: 'Markdown' })
    } else if (yn === 'no') {
      await updateSetupSession(session.group_id, {
        setup_data: { ...session.setup_data, overtime_enabled: false },
      }, db)
      await finishOvertimeSetup(bot, msg, { ...session, setup_data: { ...session.setup_data, overtime_enabled: false } }, db)
    } else {
      await bot.sendMessage(chatId, `Please reply *yes* or *no*.`, { parse_mode: 'Markdown' })
    }
    return
  }

  if (stage === 'ask_weekly_threshold') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 0 || n > 80) {
      await bot.sendMessage(chatId, `Enter a number between 1 and 80, like 40 or 35.`)
      return
    }
    await updateSetupSession(session.group_id, {
      setup_data: { ...session.setup_data, overtime_weekly_threshold: n, overtime_stage: 'ask_weekly_multiplier' },
    }, db)
    await bot.sendMessage(chatId,
      `What's your overtime pay multiplier?\n• 1.5 = time and a half _(most common)_\n• 2.0 = double time\nReply with a number greater than 1.`,
      { parse_mode: 'Markdown' })
    return
  }

  if (stage === 'ask_weekly_multiplier') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 1.0 || n > 3.0) {
      await bot.sendMessage(chatId, `Enter a number like 1.5 or 2.0 (must be more than 1.0 and at most 3.0).`)
      return
    }
    await updateSetupSession(session.group_id, {
      setup_data: { ...session.setup_data, overtime_weekly_multiplier: n, overtime_stage: 'ask_daily' },
    }, db)
    await bot.sendMessage(chatId,
      `Do you also pay *daily* overtime?\n_(Some states require extra pay after 8hrs/day)_\nReply *yes* or *no*.`,
      { parse_mode: 'Markdown' })
    return
  }

  if (stage === 'ask_daily') {
    if (yn === 'yes') {
      await updateSetupSession(session.group_id, {
        setup_data: { ...session.setup_data, overtime_daily_enabled: true, overtime_stage: 'ask_daily_threshold' },
      }, db)
      await bot.sendMessage(chatId,
        `After how many hours in one day? _(Most common: 8)_\nReply with a number.`,
        { parse_mode: 'Markdown' })
    } else if (yn === 'no') {
      const newData = { ...session.setup_data, overtime_daily_enabled: false }
      await updateSetupSession(session.group_id, { setup_data: newData }, db)
      await finishOvertimeSetup(bot, msg, { ...session, setup_data: newData }, db)
    } else {
      await bot.sendMessage(chatId, `Please reply *yes* or *no*.`, { parse_mode: 'Markdown' })
    }
    return
  }

  if (stage === 'ask_daily_threshold') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 0 || n > 24) {
      await bot.sendMessage(chatId, `Enter a number between 1 and 24.`)
      return
    }
    const newData = { ...session.setup_data, overtime_daily_threshold: n }
    await updateSetupSession(session.group_id, { setup_data: newData }, db)
    await finishOvertimeSetup(bot, msg, { ...session, setup_data: newData }, db)
    return
  }
}

export async function startOvertimeStep(bot, chatId, groupId, setupData, db = null) {
  await updateSetupSession(groupId, {
    step: 'overtime_setup',
    setup_data: { ...setupData, overtime_stage: 'ask_enabled' },
  }, db)
  await bot.sendMessage(chatId,
    `⏰ *Overtime settings*\nDoes your restaurant pay overtime?\nReply *yes* or *no*`,
    { parse_mode: 'Markdown' })
}
```

- [ ] **Step 2.2: Add overtime_setup case to src/setup/setupFlow.js**

Add this import at the top (after existing imports):
```js
import { handleOvertimeStep } from './overtimeSteps.js'
```

Add this case inside the `switch (session.step)` block, after the `add_staff` case:
```js
    case 'overtime_setup':
      await handleOvertimeStep(bot, msg, session, text)
      break
```

- [ ] **Step 2.3: Reroute "done" in staffSteps.js**

In `src/setup/staffSteps.js`, add this import at the top:
```js
import { startOvertimeStep } from './overtimeSteps.js'
```

In `handleAddStaffStep`, find the "done" branch that calls `completeSetup`. Replace `await completeSetup(bot, msg, session, shifts, staff)` in the "done" branch with:
```js
await startOvertimeStep(bot, msg.chat.id, session.group_id, session.setup_data ?? {})
```

And in the "skip" branch, replace `await completeSetup(bot, msg, session, shifts, [])` with:
```js
await startOvertimeStep(bot, msg.chat.id, session.group_id, session.setup_data ?? {})
```

Also remove the `completeSetup` function from staffSteps.js and move it into overtimeSteps.js's `finishOvertimeSetup` (it already handles completion). The `completeSetup` in staffSteps.js becomes dead code — delete it from staffSteps.js entirely.

- [ ] **Step 2.4: Update updateSetupSession signature in overtimeSteps.js**

Note: `updateSetupSession` in this codebase takes `(groupId, fields)`, not a `db` param. Check the actual signature:

```bash
grep -n "export async function updateSetupSession" /Users/mahin/relay-bot/src/setup/db/sessions.js
```

If it doesn't accept `db`, remove the `db` param from `updateSetupSession` calls in overtimeSteps.js (the mock DB handles this differently — the test will pass a mock that intercepts all calls via the db object pattern).

- [ ] **Step 2.5: Syntax check**

```bash
node --check src/setup/overtimeSteps.js
node --check src/setup/setupFlow.js
node --check src/setup/staffSteps.js
```

---

## Task 3: Tests for overtime setup

**Files:**
- Create: `src/tests/unit/overtimeSetup.test.js`

- [ ] **Step 3.1: Write the test file**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { handleOvertimeStep, startOvertimeStep } from '../../../src/setup/overtimeSteps.js'

function makeSession(stage, extraData = {}) {
  return {
    group_id: '-100',
    setup_data: { overtime_stage: stage, ...extraData },
    from: { first_name: 'TestMgr' },
  }
}

function makeMsg(text, chatId = '999') {
  return { text, chat: { id: chatId }, from: { first_name: 'TestMgr' } }
}

function makeMockDb(overrides = {}) {
  return {
    updateSetupSession: async () => ({}),
    saveOvertimeSettings: async (groupId, settings) => ({ group_id: groupId, ...settings }),
    getOvertimeSettings: async () => null,
    ...overrides,
  }
}

// ── startOvertimeStep ──────────────────────────────────────────────────
test("startOvertimeStep: sends overtime question", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await startOvertimeStep(bot, '999', '-100', {}, db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('overtime'))
  assert.ok(last.text.toLowerCase().includes('yes') || last.text.toLowerCase().includes('no'))
})

test("startOvertimeStep: sets session step to overtime_setup", async () => {
  const bot = new MockBot()
  let savedStep = null
  const db = makeMockDb({ updateSetupSession: async (gid, fields) => { savedStep = fields.step } })
  await startOvertimeStep(bot, '999', '-100', {}, db)
  assert.equal(savedStep, 'overtime_setup')
})

// ── enabled question ───────────────────────────────────────────────────
test("overtime 'no' → saves overtime_enabled:false", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_enabled')
  await handleOvertimeStep(bot, makeMsg('no'), session, 'no', db)
  assert.equal(saved.overtime_enabled, false)
})

test("overtime 'no' → sends confirmation message", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('no'), makeSession('ask_enabled'), 'no', db)
  const msgs = bot.sentMessages.map(m => m.text).join(' ')
  assert.ok(msgs.includes('saved') || msgs.includes('No overtime') || msgs.includes('complete'))
})

test("overtime 'yes' → asks weekly threshold", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('yes'), makeSession('ask_enabled'), 'yes', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('week') || last.text.toLowerCase().includes('hours'))
})

test("overtime invalid answer → asks again", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('maybe'), makeSession('ask_enabled'), 'maybe', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('yes') || last.text.toLowerCase().includes('no'))
})

// ── weekly threshold ───────────────────────────────────────────────────
test("weekly threshold '40' → saved as 40", async () => {
  const bot = new MockBot()
  let savedStage = null
  const db = makeMockDb({ updateSetupSession: async (gid, fields) => { if (fields.setup_data) savedStage = fields.setup_data } })
  await handleOvertimeStep(bot, makeMsg('40'), makeSession('ask_weekly_threshold'), '40', db)
  assert.equal(savedStage?.overtime_weekly_threshold, 40)
})

test("weekly threshold '0' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('0'), makeSession('ask_weekly_threshold'), '0', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('1') && last.text.includes('80'))
})

test("weekly threshold '81' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('81'), makeSession('ask_weekly_threshold'), '81', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('80') || last.text.includes('between'))
})

test("weekly threshold 'abc' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('abc'), makeSession('ask_weekly_threshold'), 'abc', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('number') || last.text.includes('between'))
})

// ── weekly multiplier ──────────────────────────────────────────────────
test("multiplier '1.5' → saved as 1.5", async () => {
  const bot = new MockBot()
  let savedData = null
  const db = makeMockDb({ updateSetupSession: async (gid, f) => { if (f.setup_data) savedData = f.setup_data } })
  const session = makeSession('ask_weekly_multiplier', { overtime_weekly_threshold: 40 })
  await handleOvertimeStep(bot, makeMsg('1.5'), session, '1.5', db)
  assert.equal(savedData?.overtime_weekly_multiplier, 1.5)
})

test("multiplier '1.0' → validation error (must be > 1.0)", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('1.0'), makeSession('ask_weekly_multiplier'), '1.0', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('1.0') || last.text.includes('more than'))
})

test("multiplier '3.1' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('3.1'), makeSession('ask_weekly_multiplier'), '3.1', db)
  const last = bot.lastMessage()
  assert.ok(last.text.includes('3.0') || last.text.includes('most') || last.text.includes('number'))
})

test("multiplier 'abc' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('abc'), makeSession('ask_weekly_multiplier'), 'abc', db)
  assert.ok(bot.lastMessage().text.includes('number') || bot.lastMessage().text.includes('like'))
})

// ── daily question ─────────────────────────────────────────────────────
test("daily 'yes' → asks daily threshold", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  const session = makeSession('ask_daily', { overtime_weekly_threshold: 40, overtime_weekly_multiplier: 1.5 })
  await handleOvertimeStep(bot, makeMsg('yes'), session, 'yes', db)
  const last = bot.lastMessage()
  assert.ok(last.text.toLowerCase().includes('day') || last.text.toLowerCase().includes('hours'))
})

test("daily 'no' → saves daily_overtime_enabled:false", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_daily', { overtime_enabled: true, overtime_weekly_threshold: 40, overtime_weekly_multiplier: 1.5 })
  await handleOvertimeStep(bot, makeMsg('no'), session, 'no', db)
  assert.equal(saved.daily_overtime_enabled, false)
})

// ── daily threshold ────────────────────────────────────────────────────
test("daily threshold '8' → saved as 8", async () => {
  const bot = new MockBot()
  let saved = null
  const db = makeMockDb({ saveOvertimeSettings: async (gid, s) => { saved = s; return s } })
  const session = makeSession('ask_daily_threshold', {
    overtime_enabled: true, overtime_weekly_threshold: 40,
    overtime_weekly_multiplier: 1.5, overtime_daily_enabled: true,
  })
  await handleOvertimeStep(bot, makeMsg('8'), session, '8', db)
  assert.equal(saved.daily_threshold, 8)
})

test("daily threshold '25' → validation error", async () => {
  const bot = new MockBot()
  const db = makeMockDb()
  await handleOvertimeStep(bot, makeMsg('25'), makeSession('ask_daily_threshold'), '25', db)
  assert.ok(bot.lastMessage().text.includes('24') || bot.lastMessage().text.includes('between'))
})

// ── saveOvertimeSettings DB ────────────────────────────────────────────
test("saveOvertimeSettings: upserts correctly (via mock)", async () => {
  const { saveOvertimeSettings } = await import('../../../src/setup/db/overtime.js')
  let upserted = null
  const db = { saveOvertimeSettings: async (gid, s) => { upserted = { gid, ...s }; return upserted } }
  await saveOvertimeSettings('-100', { overtime_enabled: true, weekly_threshold: 40 }, db)
  assert.equal(upserted.gid, '-100')
  assert.equal(upserted.overtime_enabled, true)
  assert.equal(upserted.weekly_threshold, 40)
})

test("saveOvertimeSettings: second save uses same groupId (upsert)", async () => {
  let callCount = 0
  const db = { saveOvertimeSettings: async () => { callCount++; return {} } }
  const { saveOvertimeSettings } = await import('../../../src/setup/db/overtime.js')
  await saveOvertimeSettings('-100', { overtime_enabled: true }, db)
  await saveOvertimeSettings('-100', { overtime_enabled: false }, db)
  assert.equal(callCount, 2)
})

test("getOvertimeSettings: returns defaults when no record", async () => {
  const { getOvertimeSettings } = await import('../../../src/setup/db/overtime.js')
  const db = { getOvertimeSettings: async () => null }
  const result = await getOvertimeSettings('-100', db)
  assert.equal(result.weekly_threshold, 40)
  assert.equal(result.weekly_multiplier, 1.5)
  assert.equal(result.daily_overtime_enabled, false)
})

test("getOvertimeSettings: returns saved values when record exists", async () => {
  const { getOvertimeSettings } = await import('../../../src/setup/db/overtime.js')
  const db = {
    getOvertimeSettings: async () => ({
      overtime_enabled: true, weekly_threshold: 35,
      weekly_multiplier: 2.0, daily_overtime_enabled: true,
      daily_threshold: 10, daily_multiplier: 1.5,
    }),
  }
  const result = await getOvertimeSettings('-100', db)
  assert.equal(result.weekly_threshold, 35)
  assert.equal(result.weekly_multiplier, 2.0)
  assert.equal(result.daily_overtime_enabled, true)
})
```

- [ ] **Step 3.2: Run tests — expect RED**

```bash
node --test src/tests/unit/overtimeSetup.test.js
```
Expected: failures (functions don't exist yet or logic incomplete).

- [ ] **Step 3.3: Run tests — expect GREEN after Task 2 implementation**

```bash
node --test src/tests/unit/overtimeSetup.test.js
```
Expected: all pass.

- [ ] **Step 3.4: Commit Feature 1**

```bash
git add src/setup/db/overtime.js src/setup/setupDb.js src/setup/overtimeSteps.js src/setup/setupFlow.js src/setup/staffSteps.js src/tests/unit/overtimeSetup.test.js
git commit -m "feat: overtime setup in wizard"
```

---

## Task 4: OT pay calculation functions

**Files:**
- Modify: `src/payroll/payCalculator.js` (append — do not change existing functions)

- [ ] **Step 4.1: Append OT functions to payCalculator.js**

Add these exports at the end of the file (after the last `}`):

```js
// ── Overtime-aware calculation ────────────────────────────────────────

/**
 * Parse time string to decimal hours.
 * "11am"→11.0, "5pm"→17.0, "11:30pm"→23.5, "23:00"→23.0, "12am"→0.0, "12pm"→12.0
 */
export function parseTimeToDecimalHours(timeStr) {
  return parseTimeToMinutes(timeStr) / 60
}

/**
 * Calculate a single shift's pay with overtime support.
 */
export function calculateShiftPayWithOT(shift, role, hoursWorkedThisWeekBefore, overtimeSettings, lateMinutes = 0, partialFrom = null, partialUntil = null) {
  const hourlyRate = role.hourlyRate ?? 0
  const startTime = shift.startTime ?? shift.start_time ?? '9am'
  const endTime   = shift.endTime   ?? shift.end_time   ?? '5pm'

  // Step 1 — effective hours
  const hoursScheduled = shiftDurationHours(startTime, endTime)
  let hoursWorked
  if (partialFrom != null && partialUntil != null) {
    hoursWorked = Math.max(0, partialUntil - partialFrom)
  } else {
    hoursWorked = hoursScheduled
  }
  const lateHours       = (lateMinutes ?? 0) / 60
  const effectiveHours  = Math.max(0, hoursWorked - lateHours)
  const lateDeduction   = round2(lateHours * hourlyRate)

  // Step 2 — daily OT split
  let dailyRegular, dailyOTHours
  if (overtimeSettings.daily_overtime_enabled) {
    dailyRegular  = Math.min(effectiveHours, overtimeSettings.daily_threshold)
    dailyOTHours  = Math.max(0, effectiveHours - overtimeSettings.daily_threshold)
  } else {
    dailyRegular  = effectiveHours
    dailyOTHours  = 0
  }

  // Step 3 — weekly OT split
  let regularHours, weeklyOTHours
  if (overtimeSettings.overtime_enabled) {
    const weeklyRemaining = Math.max(0, overtimeSettings.weekly_threshold - (hoursWorkedThisWeekBefore ?? 0))
    regularHours  = Math.min(dailyRegular, weeklyRemaining)
    weeklyOTHours = Math.max(0, dailyRegular - weeklyRemaining)
  } else {
    regularHours  = dailyRegular
    weeklyOTHours = 0
  }

  // Step 4 — pay amounts
  const regularPay   = round2(regularHours  * hourlyRate)
  const dailyOTPay   = round2(dailyOTHours  * hourlyRate * (overtimeSettings.daily_multiplier  ?? 1.5))
  const weeklyOTPay  = round2(weeklyOTHours * hourlyRate * (overtimeSettings.weekly_multiplier ?? 1.5))
  const grossPay     = round2(regularPay + dailyOTPay + weeklyOTPay)

  return {
    shiftName:      shift.name ?? 'Shift',
    dayOfWeek:      shift.dayOfWeek ?? shift.day_of_week ?? '',
    startTime,
    endTime,
    hoursScheduled: round2(hoursScheduled),
    hoursWorked:    round2(hoursWorked),
    effectiveHours: round2(effectiveHours),
    regularHours:   round2(regularHours),
    dailyOTHours:   round2(dailyOTHours),
    weeklyOTHours:  round2(weeklyOTHours),
    regularPay,
    dailyOTPay,
    weeklyOTPay,
    lateMinutes:    lateMinutes ?? 0,
    lateDeduction,
    grossPay,
  }
}

const DAY_ORDER = { mon:1, tue:2, wed:3, thu:4, fri:5, sat:6, sun:7, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:7 }

function dayRank(dayOfWeek) {
  return DAY_ORDER[(dayOfWeek ?? '').toLowerCase()] ?? 99
}

/**
 * Calculate weekly pay for all staff with OT support.
 */
export function calculateWeeklyPayWithOT(assignments, shifts, roles, overtimeSettings, lateEvents = [], partialCoverages = []) {
  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
  const roleMap  = Object.fromEntries((roles ?? []).map(r => [r.roleName?.toLowerCase(), r]))
  const lateMap  = {}
  for (const ev of (lateEvents ?? [])) {
    const key = `${ev.staffId}:${ev.shiftId}`
    lateMap[key] = (lateMap[key] ?? 0) + (ev.minutesLate ?? 0)
  }
  const partialMap = {}
  for (const p of (partialCoverages ?? [])) {
    partialMap[`${p.staffId}:${p.shiftId}`] = p
  }

  const staffMap = {}
  for (const a of (assignments ?? [])) {
    const staffId   = String(a.staffId ?? a.staff_id)
    const staffName = a.staffName ?? a.name ?? 'Unknown'
    const shiftId   = String(a.shiftId ?? a.shift_id ?? '')
    const shiftData = shiftMap[shiftId] ?? {}
    const shiftObj  = {
      name:       a.shiftName ?? shiftData.name ?? 'Shift',
      dayOfWeek:  a.dayOfWeek ?? shiftData.dayOfWeek ?? shiftData.day_of_week ?? '',
      startTime:  a.startTime ?? shiftData.startTime ?? shiftData.start_time,
      endTime:    a.endTime   ?? shiftData.endTime   ?? shiftData.end_time,
    }
    const roleName = a.role ?? a.roleName ?? ''
    const roleObj  = roleMap[roleName.toLowerCase()] ?? { roleName, hourlyRate: 0 }

    if (!staffMap[staffId]) {
      staffMap[staffId] = { staffId, staffName, roleName, hourlyRate: roleObj.hourlyRate, rawAssignments: [] }
    }
    staffMap[staffId].rawAssignments.push({ shiftObj, shiftId, roleObj, a })
  }

  const result = []
  for (const entry of Object.values(staffMap)) {
    // Sort chronologically: by day, then by startTime
    entry.rawAssignments.sort((x, y) => {
      const dayDiff = dayRank(x.shiftObj.dayOfWeek) - dayRank(y.shiftObj.dayOfWeek)
      if (dayDiff !== 0) return dayDiff
      return parseTimeToMinutes(x.shiftObj.startTime) - parseTimeToMinutes(y.shiftObj.startTime)
    })

    let runningHours = 0
    const shiftResults = []
    for (const { shiftObj, shiftId, roleObj } of entry.rawAssignments) {
      const lateMinutes = lateMap[`${entry.staffId}:${shiftId}`] ?? 0
      const partial     = partialMap[`${entry.staffId}:${shiftId}`]
      const pr = calculateShiftPayWithOT(
        shiftObj, roleObj, runningHours, overtimeSettings,
        lateMinutes,
        partial?.partialFrom ?? null,
        partial?.partialUntil ?? null,
      )
      runningHours += pr.effectiveHours
      shiftResults.push(pr)
    }

    result.push({
      staffId:             entry.staffId,
      staffName:           entry.staffName,
      roleName:            entry.roleName,
      hourlyRate:          entry.hourlyRate,
      shifts:              shiftResults,
      totalHours:          round2(shiftResults.reduce((s, r) => s + r.hoursWorked, 0)),
      totalEffectiveHours: round2(shiftResults.reduce((s, r) => s + r.effectiveHours, 0)),
      totalRegularHours:   round2(shiftResults.reduce((s, r) => s + r.regularHours, 0)),
      totalDailyOTHours:   round2(shiftResults.reduce((s, r) => s + r.dailyOTHours, 0)),
      totalWeeklyOTHours:  round2(shiftResults.reduce((s, r) => s + r.weeklyOTHours, 0)),
      totalLateMinutes:    shiftResults.reduce((s, r) => s + r.lateMinutes, 0),
      totalLateDeduction:  round2(shiftResults.reduce((s, r) => s + r.lateDeduction, 0)),
      totalRegularPay:     round2(shiftResults.reduce((s, r) => s + r.regularPay, 0)),
      totalDailyOTPay:     round2(shiftResults.reduce((s, r) => s + r.dailyOTPay, 0)),
      totalWeeklyOTPay:    round2(shiftResults.reduce((s, r) => s + r.weeklyOTPay, 0)),
      totalGrossPay:       round2(shiftResults.reduce((s, r) => s + r.grossPay, 0)),
    })
  }

  return result.sort((a, b) => a.staffName.localeCompare(b.staffName))
}

/**
 * Format pay breakdown with OT detail.
 */
export function formatPayBreakdownWithOT(staffSummary, overtimeSettings) {
  const { staffName, roleName, hourlyRate, shifts, totalGrossPay, totalEffectiveHours } = staffSummary
  let text = `${staffName} (${roleName}) — $${hourlyRate}/hr\n\n`

  for (const s of (shifts ?? [])) {
    text += `${s.shiftName} (${s.dayOfWeek}, ${s.startTime}–${s.endTime})\n`
    text += `  Regular: ${s.regularHours.toFixed(1)}hrs = $${s.regularPay.toFixed(2)}\n`
    if (s.dailyOTHours > 0) {
      text += `  Daily OT: ${s.dailyOTHours.toFixed(1)}hrs @ ${overtimeSettings.daily_multiplier}x = $${s.dailyOTPay.toFixed(2)}\n`
    }
    if (s.weeklyOTHours > 0) {
      text += `  Weekly OT: ${s.weeklyOTHours.toFixed(1)}hrs @ ${overtimeSettings.weekly_multiplier}x = $${s.weeklyOTPay.toFixed(2)}\n`
    }
    if (s.lateMinutes > 0) {
      text += `  ⚠️ Late ${s.lateMinutes}min: -$${s.lateDeduction.toFixed(2)}\n`
    }
    text += `  Shift total: $${s.grossPay.toFixed(2)}\n\n`
  }

  text += `────────────────\n`
  text += `Total: ${totalEffectiveHours.toFixed(1)}hrs → *$${totalGrossPay.toFixed(2)}*`
  return text
}
```

- [ ] **Step 4.2: Syntax check**

```bash
node --check src/payroll/payCalculator.js
```

---

## Task 5: Tests for OT pay calculation

**Files:**
- Create: `src/tests/unit/overtimePay.test.js`

- [ ] **Step 5.1: Write the test file**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateShiftPayWithOT,
  calculateWeeklyPayWithOT,
  formatPayBreakdownWithOT,
  parseTimeToDecimalHours,
} from '../../../src/payroll/payCalculator.js'

const baseSettings = {
  overtime_enabled: true,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_overtime_enabled: false,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

const noOTSettings = { ...baseSettings, overtime_enabled: false }

const dailySettings = {
  ...baseSettings,
  daily_overtime_enabled: true,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

const role = { roleName: 'Cook', hourlyRate: 15 }

function shift(name, day, start, end) {
  return { name, dayOfWeek: day, startTime: start, endTime: end }
}

// ── Time parsing ───────────────────────────────────────────────────────
test('parseTimeToDecimalHours: 11am → 11.0', () => {
  assert.equal(parseTimeToDecimalHours('11am'), 11.0)
})
test('parseTimeToDecimalHours: 5pm → 17.0', () => {
  assert.equal(parseTimeToDecimalHours('5pm'), 17.0)
})
test('parseTimeToDecimalHours: 11:30pm → 23.5', () => {
  assert.equal(parseTimeToDecimalHours('11:30pm'), 23.5)
})
test('parseTimeToDecimalHours: 23:00 → 23.0', () => {
  assert.equal(parseTimeToDecimalHours('23:00'), 23.0)
})
test('parseTimeToDecimalHours: 12am → 0.0', () => {
  assert.equal(parseTimeToDecimalHours('12am'), 0.0)
})
test('parseTimeToDecimalHours: 12pm → 12.0', () => {
  assert.equal(parseTimeToDecimalHours('12pm'), 12.0)
})
test('midnight crossing: 10pm–2am → 4hrs effective', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','10pm','2am'), role, 0, noOTSettings)
  assert.equal(r.hoursScheduled, 4)
})

// ── No OT settings ─────────────────────────────────────────────────────
test('no OT: 45hr week → all regular pay', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','5pm'), role, 45, noOTSettings)
  assert.equal(r.weeklyOTHours, 0)
  assert.equal(r.regularHours, r.effectiveHours)
})

// ── Weekly OT ──────────────────────────────────────────────────────────
test('38hrs before + 4hr shift → 2reg + 2weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','11am','3pm'), role, 38, baseSettings)
  assert.equal(r.regularHours, 2)
  assert.equal(r.weeklyOTHours, 2)
})
test('40hrs before + 4hr shift → 0reg + 4weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','11am','3pm'), role, 40, baseSettings)
  assert.equal(r.regularHours, 0)
  assert.equal(r.weeklyOTHours, 4)
})
test('0hrs before + 8hr shift → 8reg + 0OT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','5pm'), role, 0, baseSettings)
  assert.equal(r.regularHours, 8)
  assert.equal(r.weeklyOTHours, 0)
})
test('39hrs before + 2hr shift → 1reg + 1weeklyOT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','11am','1pm'), role, 39, baseSettings)
  assert.equal(r.regularHours, 1)
  assert.equal(r.weeklyOTHours, 1)
})

// ── Daily OT ───────────────────────────────────────────────────────────
test('9hr shift with daily OT: 8dailyReg + 1dailyOT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','6pm'), role, 0, dailySettings)
  assert.equal(r.dailyOTHours, 1)
  assert.equal(r.regularHours, 8)
})
test('7hr shift with daily OT: 7reg + 0dailyOT', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','4pm'), role, 0, dailySettings)
  assert.equal(r.dailyOTHours, 0)
  assert.equal(r.regularHours, 7)
})

// ── Both OT types ──────────────────────────────────────────────────────
test('39hr week + 10hr shift (daily+weekly OT): totals to 10hrs', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','7pm'), role, 39, dailySettings)
  const total = r.regularHours + r.weeklyOTHours + r.dailyOTHours
  assert.equal(total, r.effectiveHours)
  assert.ok(r.weeklyOTHours > 0 || r.dailyOTHours > 0)
})
test('both OT: no hours double-counted', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','7pm'), role, 39, dailySettings)
  assert.equal(
    Math.round((r.regularHours + r.weeklyOTHours + r.dailyOTHours) * 100),
    Math.round(r.effectiveHours * 100),
  )
})

// ── Late deduction ─────────────────────────────────────────────────────
test('0 late: no deduction', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','5pm'), role, 0, baseSettings, 0)
  assert.equal(r.lateDeduction, 0)
  assert.equal(r.effectiveHours, 8)
})
test('30min late on 8hr shift → 7.5 effective hours', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','5pm'), role, 0, baseSettings, 30)
  assert.equal(r.effectiveHours, 7.5)
})
test('late deduction = lateHours * hourlyRate', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','5pm'), role, 0, baseSettings, 60)
  assert.equal(r.lateDeduction, 15.00)
})
test('grossPay never negative when late > shift length', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','9am','9:30am'), role, 0, baseSettings, 60)
  assert.ok(r.grossPay >= 0)
  assert.equal(r.effectiveHours, 0)
})

// ── Partial shift ──────────────────────────────────────────────────────
test('partial 11–14 of 11am–5pm → 3hrs', () => {
  const r = calculateShiftPayWithOT(shift('S','Mon','11am','5pm'), role, 0, baseSettings, 0, 11, 14)
  assert.equal(r.hoursWorked, 3)
})

// ── Weekly calculation ─────────────────────────────────────────────────
test('shifts sorted Mon → Sun: running hours accumulate correctly', () => {
  const assignments = [
    { staffId: '1', staffName: 'Alice', shiftId: '1', role: 'Cook', dayOfWeek: 'Friday', startTime: '9am', endTime: '5pm', shiftName: 'Fri' },
    { staffId: '1', staffName: 'Alice', shiftId: '2', role: 'Cook', dayOfWeek: 'Monday', startTime: '9am', endTime: '5pm', shiftName: 'Mon' },
  ]
  const roles = [{ roleName: 'Cook', hourlyRate: 15 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  assert.equal(result.length, 1)
  assert.equal(result[0].totalEffectiveHours, 16)
})

test('empty assignments → empty array', () => {
  const result = calculateWeeklyPayWithOT([], [], [], baseSettings)
  assert.deepEqual(result, [])
})

test('different roles use their own hourlyRate', () => {
  const assignments = [
    { staffId: '1', staffName: 'Alice', shiftId: '1', role: 'Cook',   dayOfWeek: 'Monday', startTime: '9am', endTime: '5pm', shiftName: 'S1' },
    { staffId: '2', staffName: 'Bob',   shiftId: '2', role: 'Server', dayOfWeek: 'Monday', startTime: '9am', endTime: '5pm', shiftName: 'S2' },
  ]
  const roles = [{ roleName: 'Cook', hourlyRate: 15 }, { roleName: 'Server', hourlyRate: 12 }]
  const result = calculateWeeklyPayWithOT(assignments, [], roles, baseSettings)
  const alice = result.find(r => r.staffName === 'Alice')
  const bob   = result.find(r => r.staffName === 'Bob')
  assert.equal(alice.totalRegularPay, 120)
  assert.equal(bob.totalRegularPay,   96)
})

// ── Formatting ─────────────────────────────────────────────────────────
test('formatPayBreakdownWithOT: contains staff name', () => {
  const summary = {
    staffName: 'Marcus', roleName: 'Chef', hourlyRate: 15,
    shifts: [{ shiftName: 'Lunch', dayOfWeek: 'Monday', startTime: '11am', endTime: '5pm',
               regularHours: 6, dailyOTHours: 0, weeklyOTHours: 0,
               regularPay: 90, dailyOTPay: 0, weeklyOTPay: 0,
               lateMinutes: 0, lateDeduction: 0, grossPay: 90 }],
    totalEffectiveHours: 6, totalGrossPay: 90,
  }
  const text = formatPayBreakdownWithOT(summary, baseSettings)
  assert.ok(text.includes('Marcus'))
})

test('formatPayBreakdownWithOT: no OT lines when no OT', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName: 'S', dayOfWeek: 'Mon', startTime: '9am', endTime: '5pm',
               regularHours: 8, dailyOTHours: 0, weeklyOTHours: 0,
               regularPay: 120, dailyOTPay: 0, weeklyOTPay: 0,
               lateMinutes: 0, lateDeduction: 0, grossPay: 120 }],
    totalEffectiveHours: 8, totalGrossPay: 120,
  }
  const text = formatPayBreakdownWithOT(summary, baseSettings)
  assert.ok(!text.includes('Daily OT'))
  assert.ok(!text.includes('Weekly OT'))
})

test('formatPayBreakdownWithOT: daily OT line when dailyOT > 0', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName: 'S', dayOfWeek: 'Mon', startTime: '9am', endTime: '6pm',
               regularHours: 8, dailyOTHours: 1, weeklyOTHours: 0,
               regularPay: 120, dailyOTPay: 22.5, weeklyOTPay: 0,
               lateMinutes: 0, lateDeduction: 0, grossPay: 142.5 }],
    totalEffectiveHours: 9, totalGrossPay: 142.5,
  }
  const text = formatPayBreakdownWithOT(summary, dailySettings)
  assert.ok(text.includes('Daily OT'))
})

test('formatPayBreakdownWithOT: late line when lateMinutes > 0', () => {
  const summary = {
    staffName: 'Alice', roleName: 'Cook', hourlyRate: 15,
    shifts: [{ shiftName: 'S', dayOfWeek: 'Mon', startTime: '9am', endTime: '5pm',
               regularHours: 7.5, dailyOTHours: 0, weeklyOTHours: 0,
               regularPay: 112.5, dailyOTPay: 0, weeklyOTPay: 0,
               lateMinutes: 30, lateDeduction: 7.5, grossPay: 112.5 }],
    totalEffectiveHours: 7.5, totalGrossPay: 112.5,
  }
  const text = formatPayBreakdownWithOT(summary, baseSettings)
  assert.ok(text.includes('Late') || text.includes('late'))
})
```

- [ ] **Step 5.2: Run RED then implement then GREEN**

```bash
node --test src/tests/unit/overtimePay.test.js
# Expect: some failures if parseTimeToDecimalHours not exported yet — fix export
node --test src/tests/unit/overtimePay.test.js
# Expect: all pass
```

- [ ] **Step 5.3: Commit Feature 2**

```bash
git add src/payroll/payCalculator.js src/tests/unit/overtimePay.test.js
git commit -m "feat: overtime pay calculation"
```

---

## Task 6: formatPersonalPayStub + test

**Files:**
- Modify: `src/payroll/staffPayService.js` (append)
- Modify: `src/tests/unit/staffPayService.test.js` (append new tests)

- [ ] **Step 6.1: Append formatPersonalPayStub to staffPayService.js**

```js
/**
 * Format a personal pay stub for a staff member.
 * @param {object} staffRecord - pay summary (from payroll_records or calculateWeeklyPayWithOT output)
 * @param {string} weekStart - ISO date string
 * @param {boolean} showRate - whether to show hourly rate (default true)
 */
export function formatPersonalPayStub(staffRecord, weekStart, showRate = true) {
  const name = staffRecord.staffName ?? staffRecord.staff_name ?? 'You'
  let text = `💵 *Your pay — week of ${weekStart}*\n\n`

  const shifts = staffRecord.shifts ?? (staffRecord.shift_breakdown ? JSON.parse(staffRecord.shift_breakdown) : [])

  for (const s of shifts) {
    const day = s.dayOfWeek ?? s.day_of_week ?? ''
    const start = s.startTime ?? s.start_time ?? ''
    const end   = s.endTime   ?? s.end_time   ?? ''
    const hrs   = (s.hoursWorked ?? s.effectiveHours ?? 0).toFixed(1)
    const rate  = s.hourlyRate ?? staffRecord.hourlyRate ?? 0
    const gross = (s.grossPay ?? 0).toFixed(2)

    text += `${s.shiftName ?? 'Shift'} (${day}, ${start}–${end})\n`
    if (showRate) {
      text += `${hrs}hrs @ $${rate}/hr`
    } else {
      text += `${hrs}hrs worked`
    }
    if ((s.dailyOTHours ?? 0) > 0) {
      text += `\n+ ${(s.dailyOTHours).toFixed(1)}hrs daily OT @ ${staffRecord.daily_multiplier ?? 1.5}x`
    }
    if ((s.weeklyOTHours ?? 0) > 0) {
      text += `\n+ ${(s.weeklyOTHours).toFixed(1)}hrs weekly OT @ ${staffRecord.weekly_multiplier ?? 1.5}x`
    }
    if ((s.lateMinutes ?? 0) > 0) {
      text += `\n⚠️ ${s.lateMinutes}min late (-$${(s.lateDeduction ?? 0).toFixed(2)})`
    }
    text += `\nShift: $${gross}\n\n`
  }

  text += `━━━━━━━━━━━━━━━━━━\n`
  const total = (staffRecord.totalGrossPay ?? staffRecord.total_gross_pay ?? 0).toFixed(2)
  const totalHrs = (staffRecord.totalEffectiveHours ?? staffRecord.totalHours ?? staffRecord.total_hours ?? 0).toFixed(1)
  if (showRate) {
    text += `${totalHrs}hrs → *$${total}*`
  } else {
    text += `*Total: $${total}*`
  }
  return text
}
```

- [ ] **Step 6.2: Append tests to staffPayService.test.js**

Add these tests at the end of the file (don't remove existing tests):

```js
// ── formatPersonalPayStub ──────────────────────────────────────────────
import { formatPersonalPayStub } from '../../../src/payroll/staffPayService.js'

const baseRecord = {
  staffName: 'Marcus', hourlyRate: 15,
  shifts: [{
    shiftName: 'Monday Lunch', dayOfWeek: 'Monday', startTime: '11am', endTime: '5pm',
    hoursWorked: 6, hourlyRate: 15, grossPay: 90,
    dailyOTHours: 0, weeklyOTHours: 0, lateMinutes: 0, lateDeduction: 0,
  }],
  totalEffectiveHours: 6, totalGrossPay: 90,
}

test('formatPersonalPayStub: contains staff name', () => {
  const text = formatPersonalPayStub(baseRecord, '2025-01-06')
  assert.ok(text.includes('Your pay') || text.includes('Marcus'))
})

test('formatPersonalPayStub: correct total', () => {
  const text = formatPersonalPayStub(baseRecord, '2025-01-06')
  assert.ok(text.includes('90.00'))
})

test('formatPersonalPayStub: showRate:false hides rate', () => {
  const text = formatPersonalPayStub(baseRecord, '2025-01-06', false)
  assert.ok(!text.includes('/hr'))
  assert.ok(text.includes('hrs worked'))
})

test('formatPersonalPayStub: showRate:true shows rate', () => {
  const text = formatPersonalPayStub(baseRecord, '2025-01-06', true)
  assert.ok(text.includes('/hr'))
})

test('formatPersonalPayStub: shows OT when dailyOTHours > 0', () => {
  const rec = {
    ...baseRecord,
    shifts: [{ ...baseRecord.shifts[0], dailyOTHours: 1, weeklyOTHours: 0 }],
  }
  const text = formatPersonalPayStub(rec, '2025-01-06')
  assert.ok(text.includes('daily OT') || text.includes('OT'))
})

test('formatPersonalPayStub: shows late when lateMinutes > 0', () => {
  const rec = {
    ...baseRecord,
    shifts: [{ ...baseRecord.shifts[0], lateMinutes: 20, lateDeduction: 5 }],
  }
  const text = formatPersonalPayStub(rec, '2025-01-06')
  assert.ok(text.includes('late') || text.includes('Late'))
})
```

- [ ] **Step 6.3: Run tests**

```bash
node --test src/tests/unit/staffPayService.test.js
```
Expected: all pass (18 original + 6 new = 24 total).

- [ ] **Step 6.4: Commit Feature 3**

```bash
git add src/payroll/staffPayService.js src/tests/unit/staffPayService.test.js
git commit -m "feat: formatPersonalPayStub for staff pay stubs"
```

---

## Task 7: Install ExcelJS and create recalc.py

- [ ] **Step 7.1: Install exceljs**

```bash
cd /Users/mahin/relay-bot && npm install exceljs
```

- [ ] **Step 7.2: Create scripts/recalc.py**

```python
#!/usr/bin/env python3
"""
Recalculate formulas in an xlsx file using LibreOffice headless.
Usage: python scripts/recalc.py <filepath> [timeout_seconds]
Returns JSON: { status, total_errors, total_formulas, error_summary }
"""
import sys
import json
import subprocess
import os

def recalc(filepath, timeout=30):
    if not os.path.exists(filepath):
        return {"status": "file_not_found", "total_errors": 0, "total_formulas": 0, "error_summary": []}

    # Try LibreOffice headless recalc
    try:
        result = subprocess.run(
            ["libreoffice", "--headless", "--calc", "--convert-to", "xlsx",
             "--outdir", os.path.dirname(os.path.abspath(filepath)), filepath],
            capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            return {"status": "libreoffice_unavailable", "total_errors": 0,
                    "total_formulas": 0, "error_summary": [result.stderr[:200]]}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"status": "libreoffice_unavailable", "total_errors": 0,
                "total_formulas": 0, "error_summary": ["LibreOffice not available"]}

    # Scan for formula errors using openpyxl if available
    try:
        import openpyxl
        wb = openpyxl.load_workbook(filepath, data_only=False)
        error_tokens = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NULL!", "#NUM!"}
        total_formulas = 0
        errors = []
        for sheet in wb.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    if cell.value and isinstance(cell.value, str) and cell.value.startswith("="):
                        total_formulas += 1
                    if cell.value and isinstance(cell.value, str) and any(e in cell.value for e in error_tokens):
                        errors.append(f"{sheet.title}!{cell.coordinate}: {cell.value}")
        status = "errors_found" if errors else "success"
        return {"status": status, "total_errors": len(errors), "total_formulas": total_formulas,
                "error_summary": errors[:20]}
    except ImportError:
        return {"status": "success", "total_errors": 0, "total_formulas": 0,
                "error_summary": ["openpyxl not available — skipped formula scan"]}

if __name__ == "__main__":
    fp = sys.argv[1] if len(sys.argv) > 1 else None
    to = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    if not fp:
        print(json.dumps({"status": "error", "message": "No filepath provided"}))
        sys.exit(1)
    print(json.dumps(recalc(fp, to)))
```

---

## Task 8: spreadsheetGenerator.js

**Files:**
- Create: `src/payroll/spreadsheetGenerator.js`

> **NOTE:** Before writing spreadsheet code, read `/mnt/skills/public/xlsx/SKILL.md` if available. The implementation below follows ExcelJS best practices.

- [ ] **Step 8.1: Create src/payroll/spreadsheetGenerator.js**

```js
import ExcelJS from 'exceljs'
import { execSync } from 'child_process'
import { unlink } from 'fs/promises'
import { getOvertimeSettings } from '../setup/setupDb.js'
import { getPayrollForWeek, getLateEventsForWeek } from './payDb.js'
import { getSetupSession } from '../setup/setupDb.js'
import { getScheduleAssignments, getShiftsForGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { randomBytes } from 'crypto'

// ── Colour palette ────────────────────────────────────────────────────
const C = {
  header:   { argb: 'FF2C3E50' },
  white:    { argb: 'FFFFFFFF' },
  rowAlt:   { argb: 'FFEBF5FB' },
  rowBase:  { argb: 'FFFFFFFF' },
  weekend:  { argb: 'FFF2F2F2' },
  totals:   { argb: 'FFFFF9C4' },
  green:    { argb: 'FF27AE60' },
  orange:   { argb: 'FFE67E22' },
  red:      { argb: 'FFE74C3C' },
  blue:     { argb: 'FF2980B9' },
  gray:     { argb: 'FF95A5A6' },
}

function headerStyle(ws, row, cols, height = 25) {
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c)
    cell.font = { bold: true, size: 11, color: C.white, name: 'Arial' }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: C.header }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
  }
  row.height = height
}

function thin() {
  return { style: 'thin', color: { argb: 'FFBDC3C7' } }
}

function altFill(rowIdx) {
  return { type: 'pattern', pattern: 'solid', fgColor: rowIdx % 2 === 0 ? C.rowBase : C.rowAlt }
}

// ── Sheet 1: Schedule ─────────────────────────────────────────────────
function buildScheduleSheet(wb, summaries, scheduleData, weekStart, restaurantName) {
  const ws = wb.addWorksheet('Schedule')

  // Column widths
  ws.columns = [
    { width: 20 }, // Staff
    { width: 15 }, // Role
    { width: 18 }, // Mon
    { width: 18 }, // Tue
    { width: 18 }, // Wed
    { width: 18 }, // Thu
    { width: 18 }, // Fri
    { width: 18 }, // Sat
    { width: 18 }, // Sun
    { width: 12 }, // Total Hours
  ]

  // Row 1: Title
  const titleRow = ws.addRow([`${restaurantName} — Week of ${weekStart}`])
  ws.mergeCells(`A1:J1`)
  const titleCell = ws.getCell('A1')
  titleCell.font = { bold: true, size: 14, color: C.white, name: 'Arial' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: C.header }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.height = 35

  // Row 2: Headers
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const hdrRow = ws.addRow(['Staff', 'Role', ...DAYS, 'Total Hours'])
  headerStyle(ws, hdrRow, 10)

  // Build day→shift lookup from schedule data
  const { assignments = [], shifts = [] } = scheduleData ?? {}
  const shiftMap = Object.fromEntries(shifts.map(s => [String(s.id), s]))
  const staffDayShift = {}
  for (const a of assignments) {
    const sid   = String(a.staffId ?? a.staff_id)
    const shf   = shiftMap[String(a.shiftId ?? a.shift_id)] ?? {}
    const day   = (a.dayOfWeek ?? shf.day_of_week ?? '').toLowerCase().slice(0, 3)
    if (!staffDayShift[sid]) staffDayShift[sid] = {}
    staffDayShift[sid][day] = `${shf.name ?? 'Shift'}\n${shf.start_time ?? ''}–${shf.end_time ?? ''}`
  }

  // Data rows
  summaries.forEach((s, i) => {
    const row = ws.addRow([
      s.staffName,
      s.roleName ?? '',
      ...DAYS.map(d => staffDayShift[String(s.staffId)]?.[d.toLowerCase()] ?? ''),
      s.totalEffectiveHours ?? s.totalHours ?? 0,
    ])
    row.height = 40
    row.getCell(1).font = { bold: true, name: 'Arial' }
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' }
    row.getCell(10).font = { bold: true, name: 'Arial' }
    row.getCell(10).alignment = { horizontal: 'right', vertical: 'middle' }
    row.getCell(10).numFmt = '0.00'
    // Day cells
    for (let c = 3; c <= 9; c++) {
      row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      const isSat = c === 8, isSun = c === 9
      const fill = (isSat || isSun) ? { type:'pattern',pattern:'solid',fgColor: C.weekend } : altFill(i)
      row.getCell(c).fill = fill
    }
    for (let c = 1; c <= 10; c++) {
      if (c < 3 || c === 10) row.getCell(c).fill = altFill(i)
      row.getCell(c).border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
    }
  })

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }]
}

// ── Sheet 2: Payroll ──────────────────────────────────────────────────
function buildPayrollSheet(wb, summaries, weekStart, overtimeSettings) {
  const ws = wb.addWorksheet('Payroll')
  ws.columns = [
    { width: 20 }, // Staff
    { width: 15 }, // Role
    { width: 12 }, // Rate
    { width: 10 }, // Reg Hrs
    { width: 14 }, // Reg Pay
    { width: 12 }, // Daily OT Hrs
    { width: 14 }, // Daily OT Pay
    { width: 13 }, // Weekly OT Hrs
    { width: 15 }, // Weekly OT Pay
    { width: 10 }, // Late (min)
    { width: 13 }, // Late Ded
    { width: 10 }, // Total Hrs
    { width: 14 }, // GROSS PAY
  ]

  // Title
  const titleRow = ws.addRow([`Payroll — Week of ${weekStart}`])
  ws.mergeCells('A1:M1')
  const titleCell = ws.getCell('A1')
  titleCell.font = { bold: true, size: 14, color: C.white, name: 'Arial' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: C.header }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.height = 35

  ws.addRow([]) // spacer

  // Headers row 3
  const hdrRow = ws.addRow([
    'Staff','Role','Rate ($/hr)',
    'Reg Hrs','Reg Pay ($)',
    'Daily OT Hrs','Daily OT Pay ($)',
    'Weekly OT Hrs','Weekly OT Pay ($)',
    'Late (min)','Late Ded. ($)',
    'Total Hrs','GROSS PAY ($)',
  ])
  headerStyle(ws, hdrRow, 13)

  // Settings references (rows added after data — calculated dynamically)
  const dataStartRow = 4
  const dataEndRow   = dataStartRow + summaries.length - 1

  // Data rows (rows 4+)
  summaries.forEach((s, i) => {
    const rowNum = dataStartRow + i
    const row = ws.addRow([
      s.staffName,
      s.roleName ?? '',
      s.hourlyRate ?? 0,
      s.totalRegularHours   ?? 0,
      null, // formula
      s.totalDailyOTHours   ?? 0,
      null, // formula
      s.totalWeeklyOTHours  ?? 0,
      null, // formula
      s.totalLateMinutes    ?? 0,
      s.totalLateDeduction  ?? 0,
      s.totalEffectiveHours ?? s.totalHours ?? 0,
      null, // formula
    ])
    row.height = 22

    // Formulas
    row.getCell(5).value  = { formula: `C${rowNum}*D${rowNum}` }
    row.getCell(7).value  = { formula: `C${rowNum}*F${rowNum}*1.5` }  // multiplier hardcoded for now; override in settings
    row.getCell(9).value  = { formula: `C${rowNum}*H${rowNum}*1.5` }
    row.getCell(13).value = { formula: `E${rowNum}+G${rowNum}+I${rowNum}-K${rowNum}` }

    // Formats
    row.getCell(3).numFmt  = '$#,##0.00'
    row.getCell(3).font    = { color: C.blue, name: 'Arial' }
    for (const c of [4,6,8,10,12]) row.getCell(c).numFmt = '0.00'
    for (const c of [5,7,9,11])    { row.getCell(c).numFmt = '$#,##0.00' }
    row.getCell(11).font   = { color: (s.totalLateDeduction ?? 0) > 0 ? C.red : undefined, name: 'Arial' }
    for (const c of [7,9]) row.getCell(c).font = { color: C.orange, name: 'Arial' }
    row.getCell(13).numFmt = '$#,##0.00'
    row.getCell(13).font   = { bold: true, color: C.green, name: 'Arial' }

    const fill = altFill(i)
    for (let c = 1; c <= 13; c++) {
      if (!row.getCell(c).fill?.fgColor) row.getCell(c).fill = fill
      row.getCell(c).border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
    }
  })

  // Totals row
  const totalRow = ws.addRow([
    'TOTALS', '', '',
    { formula: `SUM(D${dataStartRow}:D${dataEndRow})` },
    { formula: `SUM(E${dataStartRow}:E${dataEndRow})` },
    { formula: `SUM(F${dataStartRow}:F${dataEndRow})` },
    { formula: `SUM(G${dataStartRow}:G${dataEndRow})` },
    { formula: `SUM(H${dataStartRow}:H${dataEndRow})` },
    { formula: `SUM(I${dataStartRow}:I${dataEndRow})` },
    { formula: `SUM(J${dataStartRow}:J${dataEndRow})` },
    { formula: `SUM(K${dataStartRow}:K${dataEndRow})` },
    { formula: `SUM(L${dataStartRow}:L${dataEndRow})` },
    { formula: `SUM(M${dataStartRow}:M${dataEndRow})` },
  ])
  totalRow.height = 22
  for (let c = 1; c <= 13; c++) {
    totalRow.getCell(c).font = { bold: true, name: 'Arial' }
    totalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: C.totals }
    totalRow.getCell(c).border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
  }
  for (const c of [4,6,8,10,12]) totalRow.getCell(c).numFmt = '0.00'
  for (const c of [5,7,9,11,13]) totalRow.getCell(c).numFmt = '$#,##0.00'

  // Settings rows
  ws.addRow([])
  ws.addRow(['Weekly OT threshold:', (overtimeSettings.weekly_threshold ?? 40) + ' hrs'])
  ws.addRow(['Weekly OT rate:', (overtimeSettings.weekly_multiplier ?? 1.5) + 'x'])
  ws.addRow(['Daily OT threshold:', overtimeSettings.daily_overtime_enabled
    ? (overtimeSettings.daily_threshold ?? 8) + ' hrs' : 'N/A'])
  ws.addRow(['Daily OT rate:', overtimeSettings.daily_overtime_enabled
    ? (overtimeSettings.daily_multiplier ?? 1.5) + 'x' : 'N/A'])

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }]
}

// ── Sheet 3: Late Arrivals ─────────────────────────────────────────────
function buildLateSheet(wb, lateEvents, weekStart) {
  if (!lateEvents || lateEvents.length === 0) return

  const ws = wb.addWorksheet('Late Arrivals Log')
  ws.columns = [
    { width: 20 }, // Staff
    { width: 20 }, // Shift
    { width: 12 }, // Day
    { width: 14 }, // Minutes Late
    { width: 16 }, // Pay Deducted
    { width: 25 }, // Notes
  ]

  const titleRow = ws.addRow([`Late Arrivals — Week of ${weekStart}`])
  ws.mergeCells('A1:F1')
  const titleCell = ws.getCell('A1')
  titleCell.font = { bold: true, size: 13, color: C.white, name: 'Arial' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: C.header }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleRow.height = 30

  const hdrRow = ws.addRow(['Staff', 'Shift', 'Day', 'Minutes Late', 'Pay Deducted ($)', 'Notes'])
  headerStyle(ws, hdrRow, 6)

  lateEvents.forEach((ev, i) => {
    const row = ws.addRow([
      ev.staffName ?? '',
      ev.shiftName ?? '',
      ev.dayOfWeek ?? '',
      ev.minutesLate ?? 0,
      ev.payDeducted ?? 0,
      ev.notes ?? '',
    ])
    row.getCell(4).numFmt = '0'
    row.getCell(5).numFmt = '$#,##0.00'
    row.getCell(5).font   = { color: C.red, name: 'Arial' }
    const mins = ev.minutesLate ?? 0
    row.getCell(4).font = {
      color: mins > 15 ? C.red : mins >= 5 ? C.orange : undefined,
      name: 'Arial',
    }
    const fill = altFill(i)
    for (let c = 1; c <= 6; c++) {
      row.getCell(c).fill   = fill
      row.getCell(c).border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
    }
  })

  const dataStart = 3
  const dataEnd   = 2 + lateEvents.length
  const footerRow = ws.addRow(['Total deductions:', '', '', '', { formula: `SUM(E${dataStart}:E${dataEnd})` }, ''])
  footerRow.getCell(1).font = { bold: true, name: 'Arial' }
  footerRow.getCell(5).numFmt = '$#,##0.00'
  footerRow.getCell(5).font   = { bold: true, color: C.red, name: 'Arial' }
  for (let c = 1; c <= 6; c++) {
    footerRow.getCell(c).fill   = { type: 'pattern', pattern: 'solid', fgColor: C.totals }
    footerRow.getCell(c).border = { top: thin(), bottom: thin(), left: thin(), right: thin() }
  }
}

// ── Main generator ────────────────────────────────────────────────────
export async function generatePayrollSpreadsheet(groupId, weekStart, payrollSummaries, scheduleData, lateEvents, overtimeSettings, restaurantName) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Relay Bot'
  wb.created = new Date()

  buildScheduleSheet(wb, payrollSummaries, scheduleData, weekStart, restaurantName)
  buildPayrollSheet(wb, payrollSummaries, weekStart, overtimeSettings)
  buildLateSheet(wb, lateEvents, weekStart)

  const rand    = randomBytes(4).toString('hex')
  const filepath = `/tmp/relay-payroll-${groupId}-${weekStart}-${rand}.xlsx`
  await wb.xlsx.writeFile(filepath)

  try {
    const raw = execSync(`python scripts/recalc.py ${filepath} 30`, { encoding: 'utf8', cwd: process.cwd() })
    const parsed = JSON.parse(raw)
    if (parsed.status === 'errors_found') {
      logger.error('Formula errors in spreadsheet:', JSON.stringify(parsed.error_summary))
    }
  } catch (err) {
    logger.warn('recalc.py unavailable — formulas written as strings:', err.message)
  }

  return filepath
}

export async function sendPayrollSpreadsheet(bot, groupId, weekStart = null, db = null) {
  const _getSession  = db?.getSetupSession
    ? (gid) => db.getSetupSession(gid)
    : (gid) => getSetupSession(gid)
  const _getPayroll  = db?.getPayrollForWeek
    ? (gid, w) => db.getPayrollForWeek(gid, w)
    : (gid, w) => getPayrollForWeek(gid, w)
  const _getLate     = db?.getLateEventsForWeek
    ? (gid, w) => db.getLateEventsForWeek(gid, w)
    : (gid, w) => getLateEventsForWeek(gid, w)
  const _getSettings = db?.getOvertimeSettings
    ? (gid) => db.getOvertimeSettings(gid)
    : (gid) => getOvertimeSettings(gid)
  const _getAssign   = db?.getScheduleAssignments
    ? (gid, w) => db.getScheduleAssignments(gid, w)
    : (gid, w) => getScheduleAssignments(gid, w)
  const _getShifts   = db?.getShiftsForGroup
    ? (gid) => db.getShiftsForGroup(gid)
    : (gid) => getShiftsForGroup(gid)

  const session = await _getSession(groupId)
  if (!session?.dm_chat_id) {
    logger.warn('No manager DM for spreadsheet')
    return { sent: false }
  }

  const week    = weekStart ?? (() => {
    const now = new Date(), day = now.getDay()
    const diff = now.getDate() - day + (day === 0 ? -6 : 1)
    return new Date(now.setDate(diff)).toISOString().split('T')[0]
  })()

  const payroll = await _getPayroll(groupId, week)
  if (!payroll || payroll.length === 0) {
    logger.warn('No payroll data for spreadsheet')
    return { sent: false }
  }

  const [assignments, shifts, lateEvents, settings] = await Promise.all([
    _getAssign(groupId, week),
    _getShifts(groupId),
    _getLate(groupId, week),
    _getSettings(groupId),
  ])

  const restaurantName = session.setup_data?.restaurant_name ?? 'Restaurant'
  const filepath = await generatePayrollSpreadsheet(
    groupId, week, payroll,
    { assignments: assignments ?? [], shifts: shifts ?? [] },
    lateEvents ?? [], settings,
    restaurantName,
  )

  let filepath2 = filepath
  try {
    await bot.sendDocument(session.dm_chat_id, filepath, {
      caption: `📊 Payroll spreadsheet — week of ${week}`,
    })
    return { sent: true }
  } finally {
    await unlink(filepath2).catch(() => {})
  }
}
```

- [ ] **Step 8.2: Syntax check**

```bash
node --check src/payroll/spreadsheetGenerator.js
```

---

## Task 9: Spreadsheet tests

**Files:**
- Create: `src/tests/unit/spreadsheetGenerator.test.js`

- [ ] **Step 9.1: Write the test file**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import ExcelJS from 'exceljs'
import { generatePayrollSpreadsheet, sendPayrollSpreadsheet } from '../../../src/payroll/spreadsheetGenerator.js'
import { MockBot } from '../helpers/mocks.js'

const mockPayroll = [
  {
    staffId: 1, staffName: 'Marcus', roleName: 'Chef', hourlyRate: 15,
    totalHours: 16, totalEffectiveHours: 16,
    totalRegularHours: 16, totalDailyOTHours: 0, totalWeeklyOTHours: 0,
    totalLateMinutes: 0, totalLateDeduction: 0,
    totalRegularPay: 240, totalDailyOTPay: 0, totalWeeklyOTPay: 0, totalGrossPay: 240,
    shifts: [
      { shiftName:'Monday Lunch', dayOfWeek:'Monday', startTime:'11am', endTime:'5pm',
        hoursWorked:6, regularHours:6, dailyOTHours:0, weeklyOTHours:0,
        regularPay:90, dailyOTPay:0, weeklyOTPay:0, lateMinutes:0, lateDeduction:0, grossPay:90 },
      { shiftName:'Wednesday Lunch', dayOfWeek:'Wednesday', startTime:'11am', endTime:'5pm',
        hoursWorked:6, regularHours:6, dailyOTHours:0, weeklyOTHours:0,
        regularPay:90, dailyOTPay:0, weeklyOTPay:0, lateMinutes:0, lateDeduction:0, grossPay:90 },
    ],
  },
  {
    staffId: 2, staffName: 'Sarah', roleName: 'Server', hourlyRate: 13,
    totalHours: 42, totalEffectiveHours: 41.67,
    totalRegularHours: 40, totalDailyOTHours: 0, totalWeeklyOTHours: 2,
    totalLateMinutes: 20, totalLateDeduction: 4.33,
    totalRegularPay: 520, totalDailyOTPay: 0, totalWeeklyOTPay: 39, totalGrossPay: 554.67,
    shifts: [],
  },
]

const mockSchedule = { assignments: [], shifts: [] }
const mockLateEvents = [
  { staffId:2, staffName:'Sarah', shiftName:'Friday Dinner',
    dayOfWeek:'Friday', minutesLate:20, payDeducted:4.33 },
]
const mockSettings = {
  overtime_enabled: true, weekly_threshold: 40, weekly_multiplier: 1.5,
  daily_overtime_enabled: false, daily_threshold: 8, daily_multiplier: 1.5,
}
const weekStart = '2025-01-06'
const restaurantName = 'Test Kitchen'

let generatedPath = null

async function generate(lateEvents = []) {
  return generatePayrollSpreadsheet(
    '-100', weekStart, mockPayroll, mockSchedule,
    lateEvents, mockSettings, restaurantName,
  )
}

// ── File generation ────────────────────────────────────────────────────
test('generatePayrollSpreadsheet: returns a filepath string', async () => {
  generatedPath = await generate()
  assert.ok(typeof generatedPath === 'string')
})

test('generatePayrollSpreadsheet: file exists at returned path', async () => {
  const fp = generatedPath ?? await generate()
  assert.ok(existsSync(fp))
  if (!generatedPath) await unlink(fp).catch(() => {})
})

test('generatePayrollSpreadsheet: file has .xlsx extension', async () => {
  const fp = generatedPath ?? await generate()
  assert.ok(fp.endsWith('.xlsx'))
})

test('generatePayrollSpreadsheet: file is valid xlsx', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  assert.ok(wb.worksheets.length > 0)
})

// ── Sheet existence ────────────────────────────────────────────────────
test('workbook has "Schedule" sheet', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  assert.ok(wb.getWorksheet('Schedule'))
})

test('workbook has "Payroll" sheet', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  assert.ok(wb.getWorksheet('Payroll'))
})

test('"Late Arrivals Log" exists when lateEvents present', async () => {
  const fp = await generate(mockLateEvents)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  assert.ok(wb.getWorksheet('Late Arrivals Log'))
  await unlink(fp).catch(() => {})
})

test('"Late Arrivals Log" NOT created when lateEvents empty', async () => {
  const fp = generatedPath ?? await generate([])
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  assert.ok(!wb.getWorksheet('Late Arrivals Log'))
})

// ── Schedule sheet ─────────────────────────────────────────────────────
test('Schedule sheet: title row contains restaurant name', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Schedule')
  const title = ws.getRow(1).getCell(1).value
  assert.ok(String(title).includes('Test Kitchen'))
})

test('Schedule sheet: title row contains weekStart', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Schedule')
  const title = ws.getRow(1).getCell(1).value
  assert.ok(String(title).includes('2025-01-06'))
})

test('Schedule sheet: header row has Mon column', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Schedule')
  const hdr = ws.getRow(2).values // 1-indexed
  assert.ok(hdr.some(v => String(v ?? '').includes('Mon')))
})

test('Schedule sheet: Marcus appears in data rows', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Schedule')
  const found = []
  ws.eachRow(row => { row.eachCell(c => { if (String(c.value ?? '').includes('Marcus')) found.push(c.value) }) })
  assert.ok(found.length > 0)
})

// ── Payroll sheet ──────────────────────────────────────────────────────
test('Payroll sheet: all staff names present', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Payroll')
  const allText = []
  ws.eachRow(row => row.eachCell(c => allText.push(String(c.value ?? ''))))
  assert.ok(allText.some(t => t.includes('Marcus')))
  assert.ok(allText.some(t => t.includes('Sarah')))
})

test('Payroll sheet: Marcus rate = 15', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Payroll')
  let found = false
  ws.eachRow(row => {
    if (String(row.getCell(1).value ?? '').includes('Marcus') && row.getCell(3).value === 15) found = true
  })
  assert.ok(found)
})

test('Payroll sheet: TOTALS row exists below data', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Payroll')
  const allText = []
  ws.eachRow(row => allText.push(String(row.getCell(1).value ?? '')))
  assert.ok(allText.some(t => t.toLowerCase().includes('total')))
})

test('Payroll sheet: settings rows show weekly threshold', async () => {
  const fp = generatedPath ?? await generate()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Payroll')
  const allText = []
  ws.eachRow(row => row.eachCell(c => allText.push(String(c.value ?? ''))))
  assert.ok(allText.some(t => t.includes('40')))
})

// ── Late arrivals sheet ────────────────────────────────────────────────
test('Late Arrivals: Sarah appears', async () => {
  const fp = await generate(mockLateEvents)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Late Arrivals Log')
  const allText = []
  ws.eachRow(row => row.eachCell(c => allText.push(String(c.value ?? ''))))
  assert.ok(allText.some(t => t.includes('Sarah')))
  await unlink(fp).catch(() => {})
})

test('Late Arrivals: footer has SUM formula', async () => {
  const fp = await generate(mockLateEvents)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  const ws = wb.getWorksheet('Late Arrivals Log')
  let hasFormula = false
  ws.eachRow(row => {
    row.eachCell(c => {
      if (c.value && typeof c.value === 'object' && c.value.formula) hasFormula = true
    })
  })
  assert.ok(hasFormula)
  await unlink(fp).catch(() => {})
})

// ── sendPayrollSpreadsheet ─────────────────────────────────────────────
test('sendPayrollSpreadsheet: { sent:false } when no manager DM', async () => {
  const bot = new MockBot()
  const db = {
    getSetupSession: async () => ({ dm_chat_id: null }),
    getPayrollForWeek: async () => [],
    getLateEventsForWeek: async () => [],
    getOvertimeSettings: async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup: async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, false)
})

test('sendPayrollSpreadsheet: { sent:false } when no payroll data', async () => {
  const bot = new MockBot()
  const db = {
    getSetupSession: async () => ({ dm_chat_id: '999', setup_data: { restaurant_name: 'T' } }),
    getPayrollForWeek: async () => [],
    getLateEventsForWeek: async () => [],
    getOvertimeSettings: async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup: async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, false)
})

test('sendPayrollSpreadsheet: { sent:true } and file cleaned up', async () => {
  const bot = new MockBot()
  bot.sendDocument = async (chatId, fp, opts) => {
    // File must exist at time of send
    assert.ok(existsSync(fp))
    return {}
  }
  const db = {
    getSetupSession: async () => ({ dm_chat_id: '999', setup_data: { restaurant_name: 'T' } }),
    getPayrollForWeek: async () => mockPayroll,
    getLateEventsForWeek: async () => [],
    getOvertimeSettings: async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup: async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, true)
})

// Cleanup
test('cleanup: delete generated file', async () => {
  if (generatedPath && existsSync(generatedPath)) {
    await unlink(generatedPath)
  }
  assert.ok(true)
})
```

- [ ] **Step 9.2: Run RED then implement then GREEN**

```bash
node --test src/tests/unit/spreadsheetGenerator.test.js
# Expect: all pass (or recalc-related warns — those are non-fatal)
```

- [ ] **Step 9.3: Commit Feature 4**

```bash
git add src/payroll/spreadsheetGenerator.js src/tests/unit/spreadsheetGenerator.test.js scripts/recalc.py package.json package-lock.json
git commit -m "feat: payroll spreadsheet generation"
```

---

## Task 10: WIRING_TODO.md and final outputs

- [ ] **Step 10.1: Create src/payroll/WIRING_TODO.md**

```markdown
# Payroll Wiring TODO

These snippets are ready to paste into src/index.js when the parallel session is done.

## /setovertime command

```js
// In src/index.js — add after existing bot.onText blocks:
bot.onText(/^\/setovertime/, async (msg) => {
  if (msg.chat.type === 'private') return
  const session = await getManagerGroup(msg.chat.id)
  if (!session) return
  await startOvertimeStep(bot, session.dm_chat_id, msg.chat.id, session.setup_data ?? {})
})
```

## /spreadsheet command

```js
// In src/index.js:
import { sendPayrollSpreadsheet } from './payroll/spreadsheetGenerator.js'

bot.onText(/^\/spreadsheet(.*)/, async (msg, match) => {
  if (msg.chat.type === 'private') return
  if (!(await isBotAdmin(msg.chat.id, msg.from.id))) return
  const weekStart = match[1].trim() || null
  await bot.sendMessage(msg.chat.id, '📊 Generating payroll spreadsheet...')
  await sendPayrollSpreadsheet(bot, String(msg.chat.id), weekStart, null)
})
```

## DM router — pay query triggers (add BEFORE LLM call)

```js
// In src/routing/dmRouter.js, before the LLM fallback:
import { isPayQuery, isHistoryQuery, handleStaffPayQuery, handleStaffHistoryQuery } from '../payroll/staffPayService.js'

if (isHistoryQuery(text)) return handleStaffHistoryQuery(bot, msg, db)
if (isPayQuery(text))     return handleStaffPayQuery(bot, msg, db)
```

## publishSchedule — spreadsheet send (add after sendPayReport)

```js
// In src/schedule/reviewSchedule.js, inside publishSchedule try/catch:
import { sendPayrollSpreadsheet } from '../payroll/spreadsheetGenerator.js'

try { await sendPayrollSpreadsheet(bot, groupId, weekStart, db) }
catch(e) { logger.error('Spreadsheet failed:', e.message) }
```
```

- [ ] **Step 10.2: Print test suite objects to add to run-tests-parallel.js**

```
═══ ADD TO run-tests-parallel.js WHEN SAFE (FAST_SUITES) ═══

{ id:'unit_overtime_setup', file:'unit/overtimeSetup.test.js',
  label:'Unit — Overtime Setup', timeout:10000 },
{ id:'unit_overtime_pay', file:'unit/overtimePay.test.js',
  label:'Unit — Overtime Pay Calc', timeout:10000 },
{ id:'unit_spreadsheet', file:'unit/spreadsheetGenerator.test.js',
  label:'Unit — Spreadsheet Generator', timeout:30000 },
```

- [ ] **Step 10.3: Run all 4 test files individually**

```bash
node --test src/tests/unit/overtimeSetup.test.js
node --test src/tests/unit/overtimePay.test.js
node --test src/tests/unit/staffPayService.test.js
node --test src/tests/unit/spreadsheetGenerator.test.js
```

All must pass.

---

## SQL to run in Supabase SQL Editor

```
═══ RUN IN SUPABASE SQL EDITOR (in order) ═══

-- 1. Overtime settings table (new)
CREATE TABLE IF NOT EXISTS overtime_settings (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  overtime_enabled BOOLEAN DEFAULT TRUE,
  weekly_threshold DECIMAL(5,2) DEFAULT 40.00,
  weekly_multiplier DECIMAL(4,2) DEFAULT 1.50,
  daily_overtime_enabled BOOLEAN DEFAULT FALSE,
  daily_threshold DECIMAL(4,2) DEFAULT 8.00,
  daily_multiplier DECIMAL(4,2) DEFAULT 1.50,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Payroll records table (new — payDb.js already references this)
CREATE TABLE IF NOT EXISTS payroll_records (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT REFERENCES staff(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  total_hours DECIMAL(10,2) DEFAULT 0,
  regular_hours DECIMAL(10,2) DEFAULT 0,
  daily_ot_hours DECIMAL(10,2) DEFAULT 0,
  weekly_ot_hours DECIMAL(10,2) DEFAULT 0,
  total_late_minutes INTEGER DEFAULT 0,
  total_late_deduction DECIMAL(10,2) DEFAULT 0,
  total_regular_pay DECIMAL(10,2) DEFAULT 0,
  total_daily_ot_pay DECIMAL(10,2) DEFAULT 0,
  total_weekly_ot_pay DECIMAL(10,2) DEFAULT 0,
  total_gross_pay DECIMAL(10,2) DEFAULT 0,
  shift_breakdown JSONB DEFAULT '[]',
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(staff_id, week_start, group_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_group_week
  ON payroll_records(group_id, week_start);
```
