#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// RELAY — REALISTIC RESTAURANT SCENARIOS STRESS TEST
// 35 targeted edge cases that real restaurants encounter daily.
// Each scenario exposes a distinct failure mode. Run independently.
// node --env-file=.env src/tests/simulation/realisticScenarios.js
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict'
import { SimulationDb } from './simulationDb.js'
import { MockBot } from '../helpers/mocks.js'
import { seedMesaVerde, STAFF, SHIFTS, GROUP_ID, GROUP_CHAT_ID, MANAGER_ID, MANAGER_DM, WEEK_STARTS, OT_SETTINGS } from './mesaVerdeSeed.js'
import { signJWT, simulateDashboardRequest } from './dashboardHelper.js'

import { calculateLaborCostPercent, parseRevenueInput } from '../../analytics/laborCost.js'
import { parseTipMessage, calculateTipSplit } from '../../operations/tipPool.js'
import { parseAvailabilityResponse } from '../../availability/collectAvailability.js'
import { calculateWeeklyPayWithOT } from '../../payroll/payCalculator.js'
import { classifySentiment, calculateMoraleScore, detectDisengagement } from '../../intelligence/moraleTracker.js'
import { applyRulesToAssignments, detectRuleConflicts } from '../../rules/businessRules.js'
import { generateWeeklySchedule } from '../../schedule/generateSchedule.js'
import { detectRecognition } from '../../engagement/recognition.js'
import { handleCoverageConfirmation } from '../../coverage/confirmationHandler.js'

// ── Harness ────────────────────────────────────────────────────────────────
const passed = [], failed = [], bugs = []

async function step(name, feature, fn, opts = {}) {
  try {
    await fn()
    process.stdout.write(`  ✅ ${name}\n`)
    passed.push({ name, feature })
  } catch (err) {
    process.stdout.write(`  ❌ ${name}: ${err.message}\n`)
    failed.push({ name, feature, error: err.message })
    bugs.push({ name, severity: opts.severity || 'HIGH', error: err.message })
  }
}

function missing(what) { throw new Error(`MISSING FEATURE: ${what}`) }
function wrongOutput(what, got, expected) { throw new Error(`BUG: ${what} — got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`) }

// ── Shared fixtures ────────────────────────────────────────────────────────
let db, bot, JWT

async function setup() {
  db = new SimulationDb()
  bot = new MockBot()
  await seedMesaVerde(db)
  JWT = signJWT({ groupId: GROUP_ID })
}

function staffByName(n) { return db.staff.find(s => s.name === n) }

// ═══════════════════════════════════════════════════════════════════════════
// GROUP A — API VALIDATION GAPS (non-existent IDs, deactivated entities)
// ═══════════════════════════════════════════════════════════════════════════

async function groupA() {
  console.log('\n── GROUP A: API Validation Gaps ──')

  await step('A.01 POST /api/schedule/assign with non-existent staffId must reject', 'Validation', async () => {
    const res = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: 99999, shiftId: 2001, weekStart: WEEK_STARTS.week2 }, JWT)
    if (res.status === 201) missing('staffId existence check — accepted assignment for ghost staff 99999')
    if (res.status >= 500) wrongOutput('non-existent staffId status', res.status, '400 or 404')
  }, { severity: 'HIGH' })

  await step('A.02 POST /api/schedule/assign with non-existent shiftId must reject', 'Validation', async () => {
    const aaliyah = staffByName('Aaliyah')
    const res = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: aaliyah.id, shiftId: 99999, weekStart: WEEK_STARTS.week2 }, JWT)
    if (res.status === 201) missing('shiftId existence check — accepted assignment for ghost shift 99999')
    if (res.status >= 500) wrongOutput('non-existent shiftId status', res.status, '400 or 404')
  }, { severity: 'HIGH' })

  await step('A.03 POST /api/schedule/assign for deactivated staff must reject', 'Validation', async () => {
    const devon = staffByName('Devon')
    // Deactivate Devon
    const delRes = await simulateDashboardRequest(db, 'DELETE', `/api/staff/${devon.id}`, {}, JWT)
    assert.equal(delRes.status, 200, 'deactivation must succeed')
    assert.equal(devon.active, false, 'Devon must be inactive')
    // Now try to assign deactivated Devon to a shift
    const res = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: devon.id, shiftId: 2002, weekStart: WEEK_STARTS.week2 }, JWT)
    if (res.status === 201) missing('deactivated-staff schedule assignment must be rejected (409 or 400)')
    // Re-activate for subsequent tests
    devon.active = true
  }, { severity: 'HIGH' })

  await step('A.04 POST /api/rules with non-existent subjectStaffId must reject', 'Validation', async () => {
    const before = db.businessRules.length
    const res = await simulateDashboardRequest(db, 'POST', '/api/rules',
      { type: 'always-required', constraintText: 'Ghost must work Mondays', subjectStaffId: 99999 }, JWT)
    const after = db.businessRules.length
    if (res.status === 201 && after > before) {
      missing('subjectStaffId existence validation — orphan rule created for staff 99999 (does not exist)')
    }
  }, { severity: 'MEDIUM' })

  await step('A.05 POST /api/staff with rate > $150/hr should warn or reject', 'Validation', async () => {
    // $250/hr is unrealistic — a restaurant paying $250/hr to a server is a data-entry error
    const sam = staffByName('Sam')
    const res = await simulateDashboardRequest(db, 'PATCH', `/api/payroll/${sam.id}/rate`, { rate: 250 }, JWT)
    // Either reject (400) or accept but return a warning field
    if (res.status === 200 && !res.body.warning && !res.body.warningRate) {
      missing('suspiciously high rate warning ($250/hr accepted silently without any warning)')
    }
  }, { severity: 'LOW' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP B — OVERLAPPING SHIFT & SCHEDULE CONFLICTS
// ═══════════════════════════════════════════════════════════════════════════

async function groupB() {
  console.log('\n── GROUP B: Overlapping Shift & Schedule Conflicts ──')

  await step('B.01 Assigning staff to two overlapping shifts same day must be detected', 'Schedule', async () => {
    // Lunch: 11am-4pm, Dinner: 3pm-11pm on same day → 1hr overlap 3-4pm
    const aaliyah = staffByName('Aaliyah')
    const lunchShift = db.shifts.find(s => s.name === 'Mon-Fri Lunch')  // 11:00-16:00
    const dinnerShift = db.shifts.find(s => s.name === 'Mon-Fri Dinner') // 17:00-23:00

    // Assign to lunch
    const r1 = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: aaliyah.id, shiftId: lunchShift.id, weekStart: WEEK_STARTS.week2 }, JWT)

    // Create a custom overlap scenario: a "late lunch" shift that overlaps dinner
    // Since lunch ends 4pm and dinner starts 5pm — no overlap with real shifts.
    // Instead test: same staff, same day, same shift twice (BH.35 already covers this).
    // Real overlap: staff assigned to a 10am-3pm shift AND a 2pm-8pm shift.
    // We'll seed a synthetic overlapping shift directly.
    const overlapShift = {
      id: 8801, group_id: GROUP_ID, name: 'Late Lunch', day_of_week: 'Monday',
      start_time: '14:00', end_time: '18:00', active: true, recurringDays: ['Monday'],
      created_at: '2024-12-01T00:00:00Z',
    }
    db.shifts.push(overlapShift)
    db.shiftRequirements.push({ id: db._nextId(), shift_id: 8801, role: 'Server', count: 1 })

    // Aaliyah on Mon-Fri Dinner (17:00-23:00); Late Lunch (14:00-18:00) overlaps 17:00-18:00
    // Assign Aaliyah to Dinner first
    const dRes = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: aaliyah.id, shiftId: 2002, weekStart: WEEK_STARTS.week2 }, JWT)
    // Then try to assign to overlapping Late Lunch
    const olRes = await simulateDashboardRequest(db, 'POST', '/api/schedule/assign',
      { staffId: aaliyah.id, shiftId: 8801, weekStart: WEEK_STARTS.week2 }, JWT)
    if (olRes.status === 201) {
      missing('overlapping-shift detection — Aaliyah assigned to Mon-Fri Dinner (17-23) AND Late Lunch (14-18) same day: 1hr overlap not flagged')
    }
  }, { severity: 'HIGH' })

  await step('B.02 Deactivating staff should auto-cancel future scheduled assignments', 'Cascade', async () => {
    // Seed Devon with future assignments this week
    db.scheduleAssignments.push(
      { id: db._nextId(), group_id: GROUP_ID, staff_id: staffByName('Devon').id, shift_id: 2002,
        week_start: WEEK_STARTS.week3, day_of_week: 'Monday', status: 'scheduled' },
      { id: db._nextId(), group_id: GROUP_ID, staff_id: staffByName('Devon').id, shift_id: 2002,
        week_start: WEEK_STARTS.week3, day_of_week: 'Tuesday', status: 'scheduled' },
    )
    const futureCount = db.scheduleAssignments.filter(a =>
      a.staff_id === staffByName('Devon').id && a.week_start >= WEEK_STARTS.week2 && a.status === 'scheduled').length
    assert.ok(futureCount >= 2, `Devon has ${futureCount} future assignments`)

    // Fire Devon
    await simulateDashboardRequest(db, 'DELETE', `/api/staff/${staffByName('Devon').id}`, {}, JWT)
    assert.equal(staffByName('Devon').active, false)

    // After deactivation: future scheduled assignments should either be cancelled or coverage requests auto-created
    const openCoverage = db.coverageRequests.filter(r =>
      r.status === 'open' && /devon/i.test(r.notes ?? r.shift_description ?? ''))
    const stillScheduled = db.scheduleAssignments.filter(a =>
      a.staff_id === staffByName('Devon').id &&
      a.week_start >= WEEK_STARTS.week2 &&
      a.status === 'scheduled').length

    if (stillScheduled > 0 && openCoverage.length === 0) {
      missing(`deactivation cascade — Devon fired but ${stillScheduled} future shifts still 'scheduled' with no coverage requests created`)
    }
    // Re-activate for rest of tests
    staffByName('Devon').active = true
  }, { severity: 'HIGH' })

  await step('B.03 Re-generating schedule for already-published week must warn', 'Schedule', async () => {
    // Publish week2 schedule
    db.scheduleAssignments.push(
      { id: db._nextId(), group_id: GROUP_ID, staff_id: staffByName('Aaliyah').id, shift_id: 2004,
        week_start: WEEK_STARTS.week2, day_of_week: 'Saturday', status: 'scheduled' },
    )
    const published = await db.getPublishedSchedule(GROUP_ID, WEEK_STARTS.week2)
    assert.ok(published.length > 0, 'week2 is published')

    // Generate again — should include a warning or flag
    await db.saveAvailability(staffByName('Aaliyah').user_id, GROUP_ID, WEEK_STARTS.week2, { available_all: true })
    const mockData = {
      shifts: db.shifts.filter(s => s.group_id === GROUP_ID),
      staff: db.staff.filter(s => s.group_id === GROUP_ID && s.active !== false).map(s => ({
        id: s.id, name: s.name, role: s.role, userId: s.user_id, dmChatId: s.dm_chat_id,
      })),
      availability: await db.getAvailability(GROUP_ID, WEEK_STARTS.week2),
      requirements: db.shiftRequirements,
      rules: [],
      maxShiftsPerDay: 2,
      publishedCount: published.length,
    }
    const draft2 = await generateWeeklySchedule(GROUP_ID, WEEK_STARTS.week2, mockData)
    // Correct: either returns a warning flag OR the new draft includes alreadyPublished: true
    const hasWarning = draft2.alreadyPublished || draft2.warning || draft2.regenerated
    if (!hasWarning) {
      missing('re-generate published schedule — no warning/flag returned when overwriting an already-published week')
    }
  }, { severity: 'MEDIUM' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP C — PAYROLL EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

async function groupC() {
  console.log('\n── GROUP C: Payroll Edge Cases ──')

  await step('C.01 calculateWeeklyPayWithOT with null hourlyRate must not produce NaN', 'Payroll', async () => {
    // Jordan has null hourlyRate — simulate a new hire not yet assigned a rate
    const shifts = [{ id: 9201, name: 'Mon', dayOfWeek: 'Monday', startTime: '11:00', endTime: '16:00' }]
    const assigns = [{ staffId: 1013, staffName: 'Jordan', shiftId: 9201, role: 'Server', dayOfWeek: 'Monday' }]
    const roles = [{ roleName: 'Server', hourlyRate: null }]  // null rate — unset
    const ot = { overtime_enabled: false, weekly_threshold: 40, weekly_multiplier: 1.5 }
    let result
    try {
      result = calculateWeeklyPayWithOT(assigns, shifts, roles, ot, [], [], [])
    } catch (e) {
      wrongOutput('calculateWeeklyPayWithOT with null rate', 'threw: ' + e.message, 'returns 0-pay row')
    }
    const row = Array.isArray(result) ? result.find(r => String(r.staffId) === '1013') : null
    if (row && !Number.isFinite(row.totalGrossPay)) {
      wrongOutput('gross pay with null rate', row.totalGrossPay, '0 or finite number')
    }
  }, { severity: 'HIGH' })

  await step('C.02 calculateWeeklyPayWithOT with zero assignments must return empty array', 'Payroll', async () => {
    const shifts = [{ id: 9202, name: 'Shift', dayOfWeek: 'Monday', startTime: '11:00', endTime: '16:00' }]
    const roles = [{ roleName: 'Server', hourlyRate: 15 }]
    let result
    try {
      result = calculateWeeklyPayWithOT([], shifts, roles, OT_SETTINGS, [], [], [])
    } catch (e) {
      wrongOutput('calculateWeeklyPayWithOT empty assignments', 'threw: ' + e.message, '[]')
    }
    assert.ok(Array.isArray(result), `expected array, got ${typeof result}`)
    assert.equal(result.length, 0, `expected empty array, got ${result.length} rows`)
  }, { severity: 'MEDIUM' })

  await step('C.03 Labor cost % with $0 total labor must return 0%, not NaN', 'Payroll', async () => {
    const result = calculateLaborCostPercent(0, 35000)
    if (!Number.isFinite(result.percent) && result.percent !== null) {
      wrongOutput('labor% when labor=0', result.percent, '0 or null')
    }
    const pct = result.percent ?? 0
    if (pct !== 0) wrongOutput('labor% when labor=0', pct, 0)
  }, { severity: 'MEDIUM' })

  await step('C.04 savePeriodPayroll upsert — second save replaces first (no duplicate)', 'Payroll', async () => {
    const sam = staffByName('Sam')
    await db.savePeriodPayroll({
      group_id: GROUP_ID, staff_id: sam.id, week_start: WEEK_STARTS.week2,
      total_hours: 25, total_late_minutes: 0, total_late_deduction: 0,
      total_gross_pay: 525, shift_breakdown: [],
    })
    await db.savePeriodPayroll({
      group_id: GROUP_ID, staff_id: sam.id, week_start: WEEK_STARTS.week2,
      total_hours: 30, total_late_minutes: 0, total_late_deduction: 0,
      total_gross_pay: 630, shift_breakdown: [],
    })
    const rows = db.payrollRecords.filter(r => r.staff_id === sam.id && r.week_start === WEEK_STARTS.week2)
    if (rows.length > 1) wrongOutput('payroll upsert created duplicate', rows.length, 1)
    const total = await db.getPayrollTotal(GROUP_ID, WEEK_STARTS.week2)
    // Should include only Sam's $630 + other pre-seeded payroll (not doubled)
    const samTotal = rows[0]?.total_gross_pay
    if (Math.abs(samTotal - 630) > 0.01) wrongOutput('payroll after upsert', samTotal, 630)
  }, { severity: 'HIGH' })

  await step('C.05 OT calculation at exactly 40h must yield 0 OT hours', 'Payroll', async () => {
    const shifts = [
      { id: 9210, name: 'M', dayOfWeek: 'Monday',    startTime: '09:00', endTime: '17:00' },
      { id: 9211, name: 'T', dayOfWeek: 'Tuesday',   startTime: '09:00', endTime: '17:00' },
      { id: 9212, name: 'W', dayOfWeek: 'Wednesday', startTime: '09:00', endTime: '17:00' },
      { id: 9213, name: 'R', dayOfWeek: 'Thursday',  startTime: '09:00', endTime: '17:00' },
      { id: 9214, name: 'F', dayOfWeek: 'Friday',    startTime: '09:00', endTime: '17:00' },
    ]
    const assigns = shifts.map(s => ({ staffId: 9901, staffName: 'Test', shiftId: s.id, role: 'Server', dayOfWeek: s.dayOfWeek }))
    const roles = [{ roleName: 'Server', hourlyRate: 15 }]
    const pay = calculateWeeklyPayWithOT(assigns, shifts, roles, OT_SETTINGS, [], [], [])
    const row = pay.find(r => String(r.staffId) === '9901')
    assert.ok(row, 'expected pay row')
    if (Math.abs(row.totalHours - 40) > 0.01) wrongOutput('40h total', row.totalHours, 40)
    if (row.totalWeeklyOTHours > 0.001) wrongOutput('OT at exactly 40h', row.totalWeeklyOTHours, 0)
    if (Math.abs(row.totalGrossPay - 600) > 0.5) wrongOutput('gross at 40h × $15', row.totalGrossPay, 600)
  }, { severity: 'CRITICAL' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP D — CLOCK EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

async function groupD() {
  console.log('\n── GROUP D: Clock Edge Cases ──')

  await step('D.01 Clock-out before clock-in must produce non-negative hours in payroll', 'TimeClock', async () => {
    // Staff clocks in at 5pm, manager does a retroactive override setting clock-out to 3pm
    // Correct: system should reject or treat as 0 hours, not return negative pay
    const mike = staffByName('Mike')
    const clockInTime = '2025-02-10T17:00:00Z'
    const badClockOut = '2025-02-10T15:00:00Z'  // 2h BEFORE clock-in

    await db.clockIn({ staff_id: mike.id, user_id: mike.user_id, group_id: GROUP_ID,
      shift_id: 2002, clock_in: clockInTime })
    const entry = db.timeEntries.find(e => e.staff_id === mike.id && e.clock_in === clockInTime)
    assert.ok(entry, 'clock-in entry exists')

    // Force a bad clock-out (simulate manager data-entry error)
    entry.clock_out = badClockOut

    // Now calculate hours — should be 0, not -2
    const durationMs = new Date(entry.clock_out) - new Date(entry.clock_in)  // -7200000ms
    const hours = durationMs / 3600000  // -2

    // The issue: if calculateWeeklyPayWithOT uses clock entries directly,
    // negative hours produce negative pay. Check that the system guards against this.
    const shifts = [{ id: 2002, name: 'Mon-Fri Dinner', dayOfWeek: 'Monday', startTime: '17:00', endTime: '23:00' }]
    const assigns = [{ staffId: mike.id, staffName: 'Mike', shiftId: 2002, role: 'Prep Cook', dayOfWeek: 'Monday' }]
    const roles = [{ roleName: 'Prep Cook', hourlyRate: 13 }]
    const pay = calculateWeeklyPayWithOT(assigns, shifts, roles, OT_SETTINGS, [], [], [])
    const row = pay.find(r => String(r.staffId) === String(mike.id))

    if (row && row.totalHours < 0) {
      wrongOutput('payroll with reversed clock times', row.totalHours, '>= 0 (negative hours must not propagate to pay)')
    }
    if (row && row.totalGrossPay < 0) {
      wrongOutput('gross pay with bad clock data', row.totalGrossPay, '>= 0')
    }
    // Clean up
    db.timeEntries = db.timeEntries.filter(e => !(e.staff_id === mike.id && e.clock_in === clockInTime))
  }, { severity: 'HIGH' })

  await step('D.02 Double clock-out must not silently overwrite first clock-out', 'TimeClock', async () => {
    const rosa = staffByName('Rosa')
    await db.clockIn({ staff_id: rosa.id, user_id: rosa.user_id, group_id: GROUP_ID,
      shift_id: 2003, clock_in: '2025-02-08T10:00:00Z' })
    const entry = db.timeEntries.find(e => e.staff_id === rosa.id)
    assert.ok(entry, 'clock-in exists')

    // First clock-out at 3pm (correct)
    await db.clockOut(entry.id, '2025-02-08T15:00:00Z')
    assert.equal(entry.clock_out, '2025-02-08T15:00:00Z')

    // Manager accidentally calls clock-out again with a different time
    const secondOut = await db.clockOut(entry.id, '2025-02-08T17:00:00Z')

    // Correct: second clock-out should be rejected (return null or error), preserving the first
    if (entry.clock_out === '2025-02-08T17:00:00Z') {
      missing('clock-out idempotency — second clockOut call silently overwrote original 3pm with 5pm')
    }
  }, { severity: 'MEDIUM' })

  await step('D.03 getMissedClockOuts with all closed entries must return empty array', 'TimeClock', async () => {
    // Seed some closed entries and verify getMissedClockOuts doesn't return them
    const priya = staffByName('Priya')
    await db.clockIn({ staff_id: priya.id, user_id: priya.user_id, group_id: GROUP_ID,
      shift_id: 2001, clock_in: '2025-02-03T11:00:00Z' })
    const entry = db.timeEntries.find(e => e.staff_id === priya.id && !e.clock_out)
    if (entry) await db.clockOut(entry.id, '2025-02-03T16:00:00Z')

    const missed = await db.getMissedClockOuts(GROUP_ID, new Date('2025-02-03T23:00:00Z'))
    const priyaMissed = missed.filter(e => e.staff_id === priya.id)
    assert.equal(priyaMissed.length, 0, `Priya clocked out but still flagged as missed: ${priyaMissed.length}`)
  }, { severity: 'LOW' })

  await step('D.04 Overnight shift 10pm-2am must yield 4 hours, not negative', 'TimeClock', async () => {
    const shifts = [{ id: 9220, name: 'Close', dayOfWeek: 'Friday', startTime: '22:00', endTime: '02:00' }]
    const assigns = [{ staffId: 9902, staffName: 'Close', shiftId: 9220, role: 'Bartender', dayOfWeek: 'Friday' }]
    const roles = [{ roleName: 'Bartender', hourlyRate: 18 }]
    const pay = calculateWeeklyPayWithOT(assigns, shifts, roles, OT_SETTINGS, [], [], [])
    const row = pay.find(r => String(r.staffId) === '9902')
    assert.ok(row, 'expected row for overnight shift')
    if (row.totalHours < 0) wrongOutput('overnight shift hours', row.totalHours, 4)
    if (Math.abs(row.totalHours - 4) > 0.1) wrongOutput('overnight hours', row.totalHours, 4)
    if (Math.abs(row.totalGrossPay - 72) > 0.5) wrongOutput('overnight pay $18×4h', row.totalGrossPay, 72)
  }, { severity: 'HIGH' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP E — TIP EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

async function groupE() {
  console.log('\n── GROUP E: Tip Edge Cases ──')

  await step('E.01 calculateTipSplit with staff having negative hoursWorked must not produce negative splits', 'Tips', async () => {
    // Can happen when a manager enters wrong clock data and the tip splitter gets negative hours
    const staff = [
      { id: 1, name: 'A', role: 'Server', hoursWorked: 6 },
      { id: 2, name: 'B', role: 'Server', hoursWorked: -2 },  // bad data
      { id: 3, name: 'C', role: 'Bartender', hoursWorked: 5 },
    ]
    const splits = calculateTipSplit(900, staff, 'hours')
    for (const s of splits) {
      if (s.amount < 0) wrongOutput(`tip split amount for ${s.name}`, s.amount, '>= 0')
    }
    const sum = splits.reduce((a, b) => a + b.amount, 0)
    if (Math.abs(sum - 900) > 0.01) wrongOutput('tip split sum with negative hours', sum, 900)
  }, { severity: 'HIGH' })

  await step('E.02 parseTipMessage with $0 must return null', 'Tips', async () => {
    const result = parseTipMessage('tips tonight were $0')
    if (result && result.totalTips === 0) {
      missing('parseTipMessage zero-tip guard — $0 accepted as valid tip record')
    }
  }, { severity: 'MEDIUM' })

  await step('E.03 Duplicate tip submission same day must be detectable', 'Tips', async () => {
    // Manager enters tips twice for Wednesday — $1140 + $1140 = double-counted
    const date = '2025-02-05'
    await db.saveTipRecord({ group_id: GROUP_ID, shift_date: date, total_tips: 1140,
      splits: [], split_method: 'hours', mode: 'pool' })
    await db.saveTipRecord({ group_id: GROUP_ID, shift_date: date, total_tips: 1140,
      splits: [], split_method: 'hours', mode: 'pool' })
    const records = db.tipRecords.filter(r => r.group_id === GROUP_ID && r.shift_date === date)
    // Correct: either saveTipRecord upserts by date, OR there's a way to detect duplicates
    if (records.length > 1) {
      missing(`duplicate tip record detection — ${records.length} tip records for same date ${date} (manager entered twice, total doubled to $${records.reduce((s,r) => s+r.total_tips, 0)})`)
    }
  }, { severity: 'MEDIUM' })

  await step('E.04 Large tip amount $45,000 (private event) parses and splits correctly', 'Tips', async () => {
    const parsed = parseTipMessage('tips tonight were $45,000 for the gala event')
    assert.ok(parsed && parsed.totalTips === 45000, `got ${JSON.stringify(parsed)}`)
    const foh = [
      { id: 1, name: 'A', role: 'Server', hoursWorked: 8 },
      { id: 2, name: 'B', role: 'Server', hoursWorked: 8 },
      { id: 3, name: 'C', role: 'Server', hoursWorked: 8 },
      { id: 4, name: 'D', role: 'Bartender', hoursWorked: 8 },
    ]
    const splits = calculateTipSplit(45000, foh, 'hours')
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 45000, `sum ${sum} !== 45000`)
    for (const s of splits) {
      if (!Number.isFinite(s.amount) || s.amount < 0) wrongOutput(`split for ${s.name}`, s.amount, 'positive finite')
    }
  }, { severity: 'HIGH' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP F — PURE FUNCTION NULL SAFETY
// ═══════════════════════════════════════════════════════════════════════════

async function groupF() {
  console.log('\n── GROUP F: Pure Function Null Safety ──')

  await step('F.01 parseAvailabilityResponse(null) must not throw', 'Availability', async () => {
    let result
    try {
      result = parseAvailabilityResponse(null, { 1: 2001 })
    } catch (e) {
      wrongOutput('parseAvailabilityResponse(null)', 'threw: ' + e.message, "{ type: 'unclear' }")
    }
    assert.ok(result && result.type, `expected {type}, got ${JSON.stringify(result)}`)
  }, { severity: 'HIGH' })

  await step('F.02 parseAvailabilityResponse(undefined) must not throw', 'Availability', async () => {
    let result
    try {
      result = parseAvailabilityResponse(undefined, { 1: 2001 })
    } catch (e) {
      wrongOutput('parseAvailabilityResponse(undefined)', 'threw: ' + e.message, "{ type: 'unclear' }")
    }
    assert.ok(result && result.type, `expected {type}, got ${JSON.stringify(result)}`)
  }, { severity: 'HIGH' })

  await step('F.03 applyRulesToAssignments with null rules must not throw', 'BusinessRules', async () => {
    const assignments = [{ staffId: 1001, staffName: 'Marcus', shiftId: 2002, dayOfWeek: 'Monday' }]
    const shifts = db.shifts.filter(s => s.group_id === GROUP_ID)
    const staff = db.staff.filter(s => s.group_id === GROUP_ID)
    let result
    try {
      result = applyRulesToAssignments(assignments, shifts, staff, null)
    } catch (e) {
      wrongOutput('applyRulesToAssignments(null rules)', 'threw: ' + e.message, '{ assignments, conflicts: [] }')
    }
    assert.ok(result && Array.isArray(result.conflicts), 'expected {conflicts:[]}')
  }, { severity: 'HIGH' })

  await step('F.04 detectRuleConflicts with null/empty must not throw', 'BusinessRules', async () => {
    let r1, r2
    try { r1 = detectRuleConflicts(null) } catch (e) {
      wrongOutput('detectRuleConflicts(null)', 'threw: ' + e.message, '[]')
    }
    try { r2 = detectRuleConflicts([]) } catch (e) {
      wrongOutput('detectRuleConflicts([])', 'threw: ' + e.message, '[]')
    }
    assert.ok(Array.isArray(r1 ?? []), 'null → array or null')
    assert.ok(Array.isArray(r2), 'empty → array')
    assert.equal((r2 ?? []).length, 0, 'empty rules → no conflicts')
  }, { severity: 'MEDIUM' })

  await step('F.05 detectRecognition with empty staff list must not throw', 'Recognition', async () => {
    let result
    try {
      result = detectRecognition('great job to the whole crew!', [])
    } catch (e) {
      wrongOutput('detectRecognition(empty staff)', 'threw: ' + e.message, 'null or team recognition')
    }
    // null is acceptable; crash is not
  }, { severity: 'MEDIUM' })

  await step('F.06 classifySentiment with empty string must return neutral', 'Morale', async () => {
    const r = classifySentiment('')
    assert.equal(r, 'neutral', `got "${r}"`)
  }, { severity: 'LOW' })

  await step('F.07 calculateMoraleScore with empty events must return { score:50, trend:stable }', 'Morale', async () => {
    const r = calculateMoraleScore([])
    assert.equal(r.score, 50, `expected 50, got ${r.score}`)
    assert.equal(r.trend, 'stable', `expected stable, got ${r.trend}`)
  }, { severity: 'LOW' })
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP G — REAL RESTAURANT OPERATIONAL SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

async function groupG() {
  console.log('\n── GROUP G: Real Restaurant Operational Scenarios ──')

  await step('G.01 Revenue entered twice for same week must upsert not double-count', 'Revenue', async () => {
    await db.saveWeeklyRevenue(GROUP_ID, WEEK_STARTS.week1, 34500)
    await db.saveWeeklyRevenue(GROUP_ID, WEEK_STARTS.week1, 35000)  // correction
    const records = db.weeklyRevenue.filter(r => r.group_id === GROUP_ID && r.week_start === WEEK_STARTS.week1)
    if (records.length > 1) wrongOutput('revenue double-save created duplicate', records.length, 1)
    assert.equal(records[0].revenue, 35000, 'corrected revenue should be 35000')
  }, { severity: 'HIGH' })

  await step('G.02 "same as last week" availability must be handled (not crash)', 'Availability', async () => {
    // Seed last week's availability for Aaliyah
    await db.saveAvailability(staffByName('Aaliyah').user_id, GROUP_ID, WEEK_STARTS.week1, { available_all: true })
    // She replies "same as last week"
    const parsed = parseAvailabilityResponse('same as last week', { 1: { id: 2001, day_of_week: 'Monday' } })
    // This phrase is ambiguous — system should either copy last week OR return 'unclear' (not crash)
    assert.ok(parsed && parsed.type, 'should return a type, not crash')
    // If it returns unclear, that's acceptable but should be flagged for improvement
    if (parsed.type === 'unclear') {
      // This is the current behavior but note it as a limitation
      process.stdout.write(`    ℹ  "same as last week" returns 'unclear' — no auto-copy from previous week\n`)
    }
  }, { severity: 'LOW' })

  await step('G.03 Staff availability submitted after schedule already published must be flagged', 'Availability', async () => {
    // Publish week2 schedule first
    if (!db.scheduleAssignments.some(a => a.week_start === WEEK_STARTS.week2)) {
      db.scheduleAssignments.push({ id: db._nextId(), group_id: GROUP_ID,
        staff_id: staffByName('Marcus').id, shift_id: 2004, week_start: WEEK_STARTS.week2,
        day_of_week: 'Saturday', status: 'scheduled' })
    }
    // Emma submits availability for week2 AFTER it's been published
    await db.saveAvailability(staffByName('Emma').user_id, GROUP_ID, WEEK_STARTS.week2,
      { available_shift_ids: [2004], raw_response: 'only sat dinner' })
    // Correct: system should record availability but also note it's for an already-published week
    const avail = (await db.getAvailability(GROUP_ID, WEEK_STARTS.week2))
      .find(a => a.user_id === staffByName('Emma').user_id)
    assert.ok(avail, 'availability saved')
    // Check if there's a flag or the save returns a warning
    const published = await db.getPublishedSchedule(GROUP_ID, WEEK_STARTS.week2)
    assert.ok(published.length > 0, 'schedule is published')
    // The absence of a warning field is a minor bug
    if (!avail.late_submission && !avail.after_publish_warning) {
      missing('late availability flag — staff submitted for already-published week but no warning recorded')
    }
  }, { severity: 'LOW' })

  await step('G.04 Three concurrent coverage volunteers: exactly one wins, others get DM', 'Coverage', async () => {
    const req = await db.saveRequest(GROUP_ID, 'Mesa Verde', 'Thursday Dinner (Marcus)', 'Marcus', staffByName('Marcus').user_id)
    const volunteers = ['Aaliyah', 'Sarah', 'Priya'].map(n => staffByName(n))

    // All three mark covered concurrently
    const [r1, r2, r3] = await Promise.all([
      db.markCovered(req.id, volunteers[0].name),
      db.markCovered(req.id, volunteers[1].name),
      db.markCovered(req.id, volunteers[2].name),
    ])

    const results = [r1, r2, r3]
    const winners = results.filter(r => r !== null)
    const losers = results.filter(r => r === null)

    if (winners.length !== 1) {
      wrongOutput('concurrent coverage winners', winners.length, 1)
    }
    if (losers.length !== 2) {
      wrongOutput('concurrent coverage losers (should get "already covered" DM)', losers.length, 2)
    }

    const final = db.coverageRequests.find(r => r.id === req.id)
    assert.equal(final.status, 'covered', 'request should be covered')
    assert.ok(volunteers.some(v => v.name === final.covered_by), 'covered_by is one of the volunteers')
  }, { severity: 'HIGH' })

  await step('G.05 OT volunteer warning — covering a shift would push staff into OT', 'Coverage', async () => {
    // Sam already has 38h this week. A ~6h shift pushes him over 40h → OT.
    // handleCoverageConfirmation should warn the manager via DM before marking covered.
    const sam = staffByName('Sam')
    // Seed Sam's current week hours: 38h
    await db.savePeriodPayroll({ group_id: GROUP_ID, staff_id: sam.id, week_start: WEEK_STARTS.week2,
      total_hours: 38, total_late_minutes: 0, total_late_deduction: 0,
      total_gross_pay: Math.round(38 * 21 * 100) / 100, shift_breakdown: [] })

    // Create an open coverage request scoped to GROUP_ID with week_start for OT check
    const req = await db.saveRequest(GROUP_ID, 'Mesa Verde', 'Saturday Dinner (someone needed)', 'Tony')
    req.week_start = WEEK_STARTS.week2  // mutates in-place (same reference stored in coverageRequests)

    // Sam offers coverage via handleCoverageConfirmation (the real handler path)
    // chat.id must match the group_id used in saveRequest for getOpenRequest to find it
    const msgsBefore = bot.sentMessages.length
    const coverageMsg = {
      chat: { id: GROUP_ID },  // must match req.group_id ('stress-group-001')
      from: { id: sam.user_id, first_name: sam.name },
      text: 'I can cover',
    }
    await handleCoverageConfirmation(bot, coverageMsg, { person: sam.name }, db)

    // Coverage must still be accepted
    const samHours = db.payrollRecords.find(r => r.staff_id === sam.id && r.week_start === WEEK_STARTS.week2)?.total_hours
    assert.ok(samHours >= 38, `Sam has ${samHours}h`)

    // Manager must have received an OT warning DM
    const newMsgs = bot.sentMessages.slice(msgsBefore)
    const managerDmId = String(MANAGER_DM)
    const otWarning = newMsgs.find(m => m.chatId === managerDmId && /overtime|OT|over\s*40/i.test(m.text))
    if (!otWarning) {
      missing('OT warning when volunteer would exceed 40h — coverage accepted without alerting manager to OT cost')
    }
  }, { severity: 'MEDIUM' })

  await step('G.06 "I worked my shift but no one entered my hours" — hours dispute flow', 'Payroll', async () => {
    // Staff DMs: "I worked Tuesday but my hours aren't in the system"
    // This tests the intent pattern — the system should route to payroll dispute handler
    const intent = classifySentiment("I worked my shift Tuesday but no one entered my hours and I haven't been paid")
    // Should be recognized as a concern (negative or neutral with payroll context)
    // Not necessarily "negative" but at minimum not dismissed as positive
    assert.ok(intent !== 'positive', `payroll dispute classified as positive: "${intent}"`)
  }, { severity: 'LOW' })

  await step('G.07 Schedule gap: all Chefs unavailable for Saturday must surface CRITICAL gap', 'Schedule', async () => {
    // Remove all Chef availability for week
    const noChefMock = {
      shifts: db.shifts.filter(s => s.group_id === GROUP_ID),
      staff: db.staff.filter(s => s.group_id === GROUP_ID && s.role !== 'Chef' && s.active !== false).map(s => ({
        id: s.id, name: s.name, role: s.role, userId: s.user_id, dmChatId: s.dm_chat_id,
      })),
      availability: [
        // Everyone available except Chefs (excluded from staff above)
        ...db.staff.filter(s => s.group_id === GROUP_ID && s.role !== 'Chef').map(s => ({
          user_id: s.user_id, group_id: GROUP_ID, week_start: WEEK_STARTS.week3,
          available_all: true, available_shift_ids: [],
        })),
      ],
      requirements: db.shiftRequirements,
      rules: [],
      maxShiftsPerDay: 2,
    }
    const draft = await generateWeeklySchedule(GROUP_ID, WEEK_STARTS.week3, noChefMock)
    const gaps = draft.gaps ?? []
    const chefGap = gaps.find(g => /chef/i.test(g.roleName ?? g.role ?? ''))
    if (!chefGap) {
      missing(`no-Chef gap not surfaced — schedule generated without any Chef available but no critical gap reported. Gaps: ${JSON.stringify(gaps).slice(0,200)}`)
    }
  }, { severity: 'HIGH' })

  await step('G.08 Long staff name (100+ chars) round-trips through dashboard correctly', 'Dashboard', async () => {
    const longName = 'A'.repeat(80) + ' Smith-Johnson'  // 94 chars
    const res = await simulateDashboardRequest(db, 'POST', '/api/staff', { name: longName, role: 'Server' }, JWT)
    if (res.status !== 201) wrongOutput('long name create status', res.status, 201)
    const saved = db.staff.find(s => s.id === res.body.id)
    if (!saved) missing('long name — staff not found after creation')
    // Check it wasn't silently truncated
    if (saved.name !== longName) wrongOutput('long name storage', saved.name.length, longName.length)
  }, { severity: 'LOW' })

  await step('G.09 Staff with no role assigned multiple shifts — payroll uses correct fallback', 'Payroll', async () => {
    // Jordan (role: null) gets assigned to shifts — payroll should not crash
    const jordan = staffByName('Jordan')
    const shifts = [{ id: 9230, name: 'Mon', dayOfWeek: 'Monday', startTime: '11:00', endTime: '16:00' }]
    const assigns = [{ staffId: jordan.id, staffName: 'Jordan', shiftId: 9230, role: null, dayOfWeek: 'Monday' }]
    const roles = []  // No rate defined for null role
    let result
    try {
      result = calculateWeeklyPayWithOT(assigns, shifts, roles, OT_SETTINGS, [], [], [])
    } catch (e) {
      wrongOutput('calculateWeeklyPayWithOT null-role staff', 'threw: ' + e.message, 'empty array or 0-pay row')
    }
    // Should not crash; 0-pay is acceptable
    if (result) {
      const row = Array.isArray(result) ? result.find(r => String(r.staffId) === String(jordan.id)) : null
      if (row && !Number.isFinite(row.totalGrossPay)) {
        wrongOutput('Jordan null-role gross pay', row.totalGrossPay, '0 or undefined')
      }
    }
  }, { severity: 'HIGH' })

  await step('G.10 Concurrent rapid-fire schedule assigns for UNIQUE staff+shift pairs must all succeed', 'Concurrency', async () => {
    // This is the corrected version of BH.34: use unique combinations so all should succeed
    const staffPool = db.staff.filter(s => s.group_id === GROUP_ID && s.active !== false && s.role).slice(0, 10)
    const shiftPool = db.shifts.filter(s => s.group_id === GROUP_ID)
    const weekStart = '2027-03-08'  // Far-future week — past-week guard won't reject

    const requests = staffPool.slice(0, 10).map((s, i) => ({
      staffId: s.id, shiftId: shiftPool[i % shiftPool.length].id, weekStart,
    }))

    // These are all unique (staff+shift vary) → ALL should succeed
    const results = await Promise.all(
      requests.map(r => simulateDashboardRequest(db, 'POST', '/api/schedule/assign', r, JWT))
    )
    const successes = results.filter(r => r.status === 201).length
    if (successes < requests.length) {
      wrongOutput('unique-assignment flood success count', successes, requests.length)
    }

    // No duplicate rows created
    const rows = db.scheduleAssignments.filter(a => a.week_start === weekStart)
    if (rows.length !== successes) {
      wrongOutput('rows created vs successes', rows.length, successes)
    }
  }, { severity: 'MEDIUM' })
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('  RELAY — REALISTIC RESTAURANT SCENARIOS STRESS TEST')
  console.log('  35 targeted edge cases designed to expose real restaurant bugs')
  console.log('═══════════════════════════════════════════════════════════════════\n')

  await setup()

  await groupA()
  await groupB()
  await groupC()
  await groupD()
  await groupE()
  await groupF()
  await groupG()

  const total = passed.length + failed.length
  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log(`  RESULTS: ${passed.length}/${total} steps passing (${Math.round(passed.length / total * 100)}%)`)
  console.log('═══════════════════════════════════════════════════════════════════\n')

  const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] }
  for (const b of bugs) (bySev[b.severity] ??= []).push(b)

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    if (!bySev[sev]?.length) continue
    console.log(`  ${sev}:`)
    for (const b of bySev[sev]) {
      console.log(`    ❌ ${b.name}`)
      console.log(`       ${b.error}`)
    }
  }

  const verdict = bugs.filter(b => b.severity === 'CRITICAL').length > 0 ? '🔴 CRITICAL BUGS PRESENT' :
                  bugs.filter(b => b.severity === 'HIGH').length > 0 ? '🟡 HIGH-SEVERITY BUGS FOUND' :
                  bugs.length > 0 ? '🟡 MINOR BUGS FOUND' : '🟢 ALL SCENARIOS PASS'

  console.log(`\n  VERDICT: ${verdict}`)
  console.log(`  (CRITICAL: ${bySev.CRITICAL?.length ?? 0} | HIGH: ${bySev.HIGH?.length ?? 0} | MEDIUM: ${bySev.MEDIUM?.length ?? 0} | LOW: ${bySev.LOW?.length ?? 0})\n`)

  if (failed.length > 0) process.exit(1)
}

main().catch(err => {
  console.error('Simulation crashed:', err)
  process.exit(1)
})
