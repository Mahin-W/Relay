#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// RELAY — Full Restaurant Week Simulation
// Restaurant: Mahin's Kitchen | Week Jan 6-12 2025
// Exercises every feature with realistic inputs + verifies outputs
// ═══════════════════════════════════════════════════════════════

import assert from 'node:assert/strict'

// ── Pure function imports (no DB/LLM needed) ─────────────────
import { parseTipMessage, calculateTipSplit, formatTipSplit } from '../../operations/tipPool.js'
import { detectRecognition, formatGroupShoutout } from '../../engagement/recognition.js'
import { isEarnedWageQuery, formatEarnedWageResponse } from '../../engagement/earnedWage.js'
import { calculateQualityScore, detectQualityTrend, formatQualitySummary } from '../../intelligence/scheduleQuality.js'
import { generateStaffingRecommendations, formatStaffingPatternAlert } from '../../intelligence/staffingPatterns.js'
import { calculateCalloutProbability, formatCalloutRiskSection } from '../../intelligence/calloutPredictor.js'
import { calculateRiskScore, formatTurnoverRiskAlert, formatTurnoverRiskCommand } from '../../intelligence/turnoverRisk.js'
import { calculateMoraleScore, classifySentiment, detectDisengagement } from '../../intelligence/moraleTracker.js'
import { computeScore, getReliabilityLabel } from '../../reliability/reliabilityScore.js'
import { extractDemandSignal } from '../../intelligence/demandSignals.js'
import { applyRulesToAssignments } from '../../rules/businessRules.js'
import { formatClopeningWarning } from '../../schedule/clopen.js'
import { calculateWeeklyHours, detectHoursIssues } from '../../schedule/hoursTracker.js'
import { parseAvailabilityResponse } from '../../availability/collectAvailability.js'
import { isReceiptConfirmation } from '../../schedule/readReceipts.js'
import { detectClockIntent } from '../../timeclock/clockDetector.js'
import { shouldSkip } from '../../preFilter.js'
import { isPayQuery, isHistoryQuery } from '../../payroll/staffPayService.js'
import { isScheduleQuery, isHoursQuery } from '../../schedule/selfService.js'
import { parseTimeReference, calculateRemainingCoverage, isFullyCovered } from '../../coverage/partialCoverage.js'
import { calculateShiftPay, calculateWeeklyPay } from '../../payroll/payCalculator.js'
import { parseRevenueInput, calculateLaborCostPercent } from '../../analytics/laborCost.js'
import { calculateProjectedLaborCost } from '../../analytics/budgetAlert.js'
import { analyzePatterns } from '../../intelligence/preferenceTracker.js'
import { analyzePairOutcomes, applyPairingOptimization } from '../../intelligence/pairingOptimizer.js'
import { filterAlreadyKnownConstraints, generateDiscoveryPrompts, getWeekNumber } from '../../intelligence/implicitConstraints.js'
import { getConsecutiveDayStreak } from '../../intelligence/contextualWarnings.js'
import { isShiftActive, getMinutesIntoShift, parseShiftTime } from '../../schedule/currentShift.js'
import { buildShiftNarrative } from '../../managerLog/shiftLog.js'
import { formatReliabilityReport } from '../../reliability/reliabilityScore.js'

// ── Simulation state ─────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []
const featuresTested = []
const intelligenceFired = []

async function step(name, feature, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
    passed++
    if (!featuresTested.includes(feature)) featuresTested.push(feature)
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`)
    failed++
    failures.push({ name, error: err.message })
  }
}

// ═══════════════════════════════════════════════════════════════
// RESTAURANT DATA
// ═══════════════════════════════════════════════════════════════

const GROUP_ID = 'sim-group-001'
const WEEK_START = '2025-01-06'

const staff = [
  { id: 1, name: 'Marcus', role: 'Chef', hourlyRate: 16 },
  { id: 2, name: 'Sarah', role: 'Server', hourlyRate: 14 },
  { id: 3, name: 'Jake', role: 'Server', hourlyRate: 14 },
  { id: 4, name: 'Amy', role: 'Bartender', hourlyRate: 15 },
  { id: 5, name: 'Carlos', role: 'Prep Cook', hourlyRate: 13 },
  { id: 6, name: 'Emma', role: 'Server', hourlyRate: 14 },
  { id: 7, name: 'Dani', role: 'Busser', hourlyRate: 12 },
  { id: 8, name: 'Mike', role: 'Cook', hourlyRate: 14 },
  { id: 9, name: 'Rosa', role: 'Host', hourlyRate: 13 },
  { id: 10, name: 'Jake L', role: 'Dishwasher', hourlyRate: 12 },
]

const shifts = [
  { id: 1, name: 'Monday Lunch', day_of_week: 'Monday', start_time: '11:00 AM', end_time: '4:00 PM' },
  { id: 2, name: 'Monday Dinner', day_of_week: 'Monday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 3, name: 'Tuesday Lunch', day_of_week: 'Tuesday', start_time: '11:00 AM', end_time: '4:00 PM' },
  { id: 4, name: 'Tuesday Dinner', day_of_week: 'Tuesday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 5, name: 'Wednesday Lunch', day_of_week: 'Wednesday', start_time: '11:00 AM', end_time: '4:00 PM' },
  { id: 6, name: 'Wednesday Dinner', day_of_week: 'Wednesday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 7, name: 'Thursday Lunch', day_of_week: 'Thursday', start_time: '11:00 AM', end_time: '4:00 PM' },
  { id: 8, name: 'Thursday Dinner', day_of_week: 'Thursday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 9, name: 'Friday Lunch', day_of_week: 'Friday', start_time: '11:00 AM', end_time: '4:00 PM' },
  { id: 10, name: 'Friday Dinner', day_of_week: 'Friday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 11, name: 'Saturday Brunch', day_of_week: 'Saturday', start_time: '10:00 AM', end_time: '3:00 PM' },
  { id: 12, name: 'Saturday Dinner', day_of_week: 'Saturday', start_time: '5:00 PM', end_time: '11:00 PM' },
  { id: 13, name: 'Sunday Brunch', day_of_week: 'Sunday', start_time: '10:00 AM', end_time: '3:00 PM' },
  { id: 14, name: 'Sunday Dinner', day_of_week: 'Sunday', start_time: '5:00 PM', end_time: '11:00 PM' },
]

// Business rules
const businessRules = [
  { id: 1, type: 'staff_conflict', subject_staff_id: 1, object_staff_id: 5, constraint_text: 'Marcus and Carlos never on same shift', active: true },
  { id: 2, type: 'time_constraint', subject_staff_id: 6, constraint_text: 'Emma leaves by 9pm on Wednesdays', day_of_week: 'Wednesday', latest_end_time: '21:00', active: true },
]

// Sample assignments for Wednesday dinner
const wednesdayDinnerAssignments = [
  { staffId: 2, staffName: 'Sarah', roleName: 'Server', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 3, staffName: 'Jake', roleName: 'Server', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 6, staffName: 'Emma', roleName: 'Server', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 1, staffName: 'Marcus', roleName: 'Chef', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 8, staffName: 'Mike', roleName: 'Cook', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 4, staffName: 'Amy', roleName: 'Bartender', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
  { staffId: 7, staffName: 'Dani', roleName: 'Busser', shiftId: 6, shiftName: 'Wednesday Dinner', dayOfWeek: 'Wednesday', startTime: '5:00 PM', endTime: '11:00 PM' },
]

// ═══════════════════════════════════════════════════════════════
// MONDAY — SETUP & SCHEDULE GENERATION
// ═══════════════════════════════════════════════════════════════

async function monday() {
  console.log('\nMONDAY (Setup & Schedule):')

  // Step 1: Availability parsing
  await step('Step 1: Staff availability responses parsed', 'Availability', () => {
    assert.deepStrictEqual(parseAvailabilityResponse('1 2 3 4 5 6 7', { '1': {}, '2': {}, '3': {}, '4': {}, '5': {}, '6': {}, '7': {} }),
      { type: 'specific_shifts', numbers: ['1', '2', '3', '4', '5', '6', '7'] })
    assert.deepStrictEqual(parseAvailabilityResponse('all', {}), { type: 'all_week' })
    assert.deepStrictEqual(parseAvailabilityResponse('off', {}), { type: 'unavailable' })
    assert.equal(parseAvailabilityResponse('4 5 6 7', { '1': {}, '2': {}, '3': {}, '4': {}, '5': {}, '6': {}, '7': {} }).type, 'specific_shifts')
    assert.deepStrictEqual(parseAvailabilityResponse('4 5 6 7', { '1': {}, '2': {}, '3': {}, '4': {}, '5': {}, '6': {}, '7': {} }).numbers, ['4', '5', '6', '7'])
  })

  // Step 2: Business rules enforce Marcus/Carlos separation
  await step('Step 2: Business rules — Marcus and Carlos never together', 'Business Rules', () => {
    const conflictAssignments = [
      { staffId: 1, staffName: 'Marcus', roleName: 'Chef', shiftId: 1, shiftName: 'Monday Lunch', dayOfWeek: 'Monday' },
      { staffId: 5, staffName: 'Carlos', roleName: 'Prep Cook', shiftId: 1, shiftName: 'Monday Lunch', dayOfWeek: 'Monday' },
    ]
    const mappedShifts = shifts.map(s => ({ id: s.id, name: s.name, dayOfWeek: s.day_of_week }))
    const mappedStaff = staff.map(s => ({ id: s.id, name: s.name }))
    // Rules use camelCase internally
    const camelRules = [
      { id: 1, type: 'staff_conflict', subjectStaffId: 1, objectStaffId: 5, constraint: 'Marcus and Carlos never on same shift', active: true },
    ]
    const result = applyRulesToAssignments(conflictAssignments, mappedShifts, mappedStaff, camelRules)
    assert.equal(result.valid, false, 'Should flag Marcus+Carlos on same shift')
    assert.ok(result.conflicts.length > 0, 'Should have at least one conflict')
    intelligenceFired.push('Business rules enforced (Marcus/Carlos)')
  })

  // Step 3: Hours calculation
  await step('Step 3: Weekly hours calculation', 'Payroll', () => {
    const weekAssignments = [
      { staffId: 2, staffName: 'Sarah', shiftId: 1 },
      { staffId: 2, staffName: 'Sarah', shiftId: 2 },
      { staffId: 2, staffName: 'Sarah', shiftId: 3 },
      { staffId: 2, staffName: 'Sarah', shiftId: 4 },
      { staffId: 2, staffName: 'Sarah', shiftId: 10 },
    ]
    const hours = calculateWeeklyHours(weekAssignments, shifts)
    assert.ok(hours[2], 'Sarah should have hours calculated')
    assert.ok(hours[2].totalHours > 0, 'Hours should be positive')
    // Mon lunch(5h) + Mon dinner(6h) + Tue lunch(5h) + Tue dinner(6h) + Fri dinner(6h) = 28h
    assert.equal(hours[2].totalHours, 28)
    assert.equal(hours[2].shiftCount, 5)
  })

  // Step 4: Receipt confirmation detection
  await step('Step 4: Schedule confirmations detected', 'Read Receipts', () => {
    assert.ok(isReceiptConfirmation('got it'))
    assert.ok(isReceiptConfirmation('Got it!'))
    assert.ok(isReceiptConfirmation('confirmed'))
    assert.ok(isReceiptConfirmation('👍'))
    assert.ok(!isReceiptConfirmation('maybe later'))
    assert.ok(!isReceiptConfirmation('I guess'))
  })

  // Step 5: Sentiment classification for confirmations
  await step('Step 5: Sentiment classification', 'Morale Tracking', () => {
    assert.equal(classifySentiment('got it'), 'neutral')
    assert.equal(classifySentiment('I guess'), 'negative')
    assert.equal(classifySentiment('yes definitely!'), 'positive')
    assert.equal(classifySentiment('thanks so much'), 'neutral') // only strong positive words trigger
    assert.equal(classifySentiment('whatever'), 'negative')
  })

  // Step 6: Preference learning patterns
  await step('Step 6: Preference learning — detect Amy/Friday pattern', 'Preference Learning', () => {
    const editHistory = [
      { staff_id: 4, staff_name: 'Amy', type: 'add', day_of_week: 'Friday', from_shift_id: null, to_shift_id: 10 },
      { staff_id: 4, staff_name: 'Amy', type: 'add', day_of_week: 'Friday', from_shift_id: null, to_shift_id: 10 },
      { staff_id: 4, staff_name: 'Amy', type: 'add', day_of_week: 'Friday', from_shift_id: null, to_shift_id: 10 },
      { staff_id: 6, staff_name: 'Emma', type: 'remove', day_of_week: 'Monday', from_shift_id: 1, to_shift_id: null },
      { staff_id: 6, staff_name: 'Emma', type: 'remove', day_of_week: 'Monday', from_shift_id: 1, to_shift_id: null },
      { staff_id: 6, staff_name: 'Emma', type: 'remove', day_of_week: 'Monday', from_shift_id: 1, to_shift_id: null },
    ]
    const patterns = analyzePatterns(editHistory, 6)
    assert.ok(patterns.length >= 2, `Expected at least 2 patterns, got ${patterns.length}`)
    const amyPattern = patterns.find(p => p.staffName === 'Amy')
    assert.ok(amyPattern, 'Should detect Amy pattern')
    assert.ok(amyPattern.confidence >= 0.5, 'Amy confidence should be >= 0.5')
    const emmaPattern = patterns.find(p => p.staffName === 'Emma')
    assert.ok(emmaPattern, 'Should detect Emma pattern')
    intelligenceFired.push('Preference learning applied to schedule')
  })
}

// ═══════════════════════════════════════════════════════════════
// TUESDAY — DEMAND SIGNALS & RECOGNITION
// ═══════════════════════════════════════════════════════════════

async function tuesday() {
  console.log('\nTUESDAY (Demand & Recognition):')

  // Step 7: Demand signal detection
  await step('Step 7: Demand signal — big reservation Saturday', 'Demand Signals', () => {
    const signal = extractDemandSignal('heads up everyone, big reservation Saturday, expecting a packed house')
    assert.ok(signal, 'Should detect demand signal')
    assert.equal(signal.type, 'high')
    assert.equal(signal.dayOfWeek, 'Saturday')
    intelligenceFired.push('Demand signal triggered recommendation')
  })

  // Step 8: Recognition detection
  await step('Step 8: Shoutout — great job Marcus', 'Recognition', () => {
    const result = detectRecognition('great job Marcus on Monday dinner, service was on point', staff)
    assert.ok(result, 'Should detect recognition')
    assert.equal(result.recipientType, 'individual')
    assert.equal(result.recipientName, 'Marcus')
    const formatted = formatGroupShoutout(result, 'Tony')
    assert.ok(formatted.includes('Tony'), 'Shoutout should mention manager')
    assert.ok(formatted.includes('Marcus'), 'Shoutout should mention Marcus')
  })

  // Step 9: Recognition edge cases — no false triggers
  await step('Step 9: Recognition — no false triggers', 'Recognition', () => {
    assert.equal(detectRecognition('the schedule looks good', staff), null)
    assert.equal(detectRecognition('great pasta tonight', staff), null)
    assert.equal(detectRecognition('great, got it', staff), null)
    assert.equal(detectRecognition('can anyone cover my shift', staff), null)
    // But team recognition works
    const team = detectRecognition('great job everyone tonight', staff)
    assert.ok(team, 'Team recognition should fire')
    assert.equal(team.recipientType, 'team')
  })

  // Step 10: Pre-filter — what gets through
  await step('Step 10: Pre-filter — slang detection', 'Pre-filter', () => {
    assert.ok(!shouldSkip('bet'))       // passes through (trigger)
    assert.ok(!shouldSkip('igu'))       // passes through
    assert.ok(shouldSkip('lmao'))       // filtered
    assert.ok(shouldSkip('haha'))       // filtered
    assert.ok(!shouldSkip("can't make my shift"))  // passes through
    assert.ok(shouldSkip('yo'))         // filtered (filler)
    assert.ok(!shouldSkip('I can cover'))  // passes through
  })
}

// ═══════════════════════════════════════════════════════════════
// WEDNESDAY — COVERAGE REQUEST & TIPS
// ═══════════════════════════════════════════════════════════════

async function wednesday() {
  console.log('\nWEDNESDAY (Coverage & Tips):')

  // Step 11: Clock intent detection
  await step('Step 11: Clock intent — fast path detection', 'Time Clock', () => {
    assert.equal(detectClockIntent('clock in'), 'clock_in')
    assert.equal(detectClockIntent('clocking out'), 'clock_out')
    assert.equal(detectClockIntent('I need to clock in'), 'clock_in')
    assert.equal(detectClockIntent('can anyone cover'), null)
  })

  // Step 12: Tip parsing — $940 tonight
  await step('Step 12: Tip parsing — $940 tonight', 'Tip Pool', () => {
    const result = parseTipMessage('tips were $940 tonight')
    assert.ok(result, 'Should parse tip message')
    assert.equal(result.totalTips, 940)

    // Edge cases
    const k = parseTipMessage('$1.2k tips')
    assert.ok(k)
    assert.equal(k.totalTips, 1200)

    const comma = parseTipMessage('split $1,200 from Friday dinner')
    assert.ok(comma)
    assert.equal(comma.totalTips, 1200)

    assert.equal(parseTipMessage('tips were great tonight'), null)
    assert.equal(parseTipMessage('can anyone cover'), null)
  })

  // Step 13: Tip split calculation — pool by hours, BOH excluded
  await step('Step 13: Tip split — $940, hours-based, BOH excluded', 'Tip Pool', () => {
    // FOH staff only (exclude Carlos=Cook, Mike=Cook)
    const eligibleStaff = [
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursWorked: 6 },
      { staffId: 3, staffName: 'Jake', roleName: 'Server', hoursWorked: 6 },
      { staffId: 6, staffName: 'Emma', roleName: 'Server', hoursWorked: 4 },  // left early (callout replacement)
      { staffId: 4, staffName: 'Amy', roleName: 'Bartender', hoursWorked: 6 },
      { staffId: 7, staffName: 'Dani', roleName: 'Busser', hoursWorked: 6 },
    ]
    const splits = calculateTipSplit(940, eligibleStaff, 'hours')
    assert.ok(splits.length === 5, 'Should have 5 splits')

    // Verify sum equals exactly $940
    const sum = splits.reduce((acc, s) => acc + s.amount, 0)
    assert.equal(sum, 940, `Tip sum must be exactly $940, got $${sum}`)

    // Verify proportionality (Sarah 6h should get more than Emma 4h)
    const sarahTip = splits.find(s => s.staffName === 'Sarah').amount
    const emmaTip = splits.find(s => s.staffName === 'Emma').amount
    assert.ok(sarahTip > emmaTip, 'Sarah (6h) should get more than Emma (4h)')

    // Format output
    const formatted = formatTipSplit(940, splits, { mode: 'pool', splitMethod: 'hours', bohIncluded: false })
    assert.ok(formatted.includes('940'), 'Should show total')
    assert.ok(formatted.includes('Sarah'), 'Should list Sarah')
  })

  // Step 14: Tip rounding edge case
  await step('Step 14: Tip rounding — $100 / 3 people', 'Tip Pool', () => {
    const threeWay = [
      { staffId: 1, staffName: 'A', roleName: 'Server', hoursWorked: 5 },
      { staffId: 2, staffName: 'B', roleName: 'Server', hoursWorked: 5 },
      { staffId: 3, staffName: 'C', roleName: 'Server', hoursWorked: 5 },
    ]
    const splits = calculateTipSplit(100, threeWay, 'hours')
    const sum = splits.reduce((acc, s) => acc + s.amount, 0)
    assert.equal(sum, 100, `$100/3 rounding: sum must be exactly $100, got $${sum}`)
  })

  // Step 15: Shift time parsing
  await step('Step 15: Shift time parsing — parseShiftTime', 'Current Shift', () => {
    const wed = new Date('2025-01-08T12:00:00Z')
    const start = parseShiftTime('5:00 PM', wed)
    assert.ok(start, 'Should parse 5:00 PM')
    assert.equal(start.getHours(), 17, '5 PM = 17:00')

    const end = parseShiftTime('11:00 PM', wed)
    assert.ok(end, 'Should parse 11:00 PM')
    assert.equal(end.getHours(), 23, '11 PM = 23:00')

    const noon = parseShiftTime('12:00 PM', wed)
    assert.ok(noon, 'Should parse 12:00 PM')
    assert.equal(noon.getHours(), 12, '12 PM = noon')

    const midnight = parseShiftTime('12:00 AM', wed)
    assert.ok(midnight, 'Should parse 12:00 AM')
    assert.equal(midnight.getHours(), 0, '12 AM = midnight')

    assert.equal(parseShiftTime('invalid', wed), null, 'Invalid time should return null')
  })
}

// ═══════════════════════════════════════════════════════════════
// THURSDAY — QUERIES & PARTIAL COVERAGE
// ═══════════════════════════════════════════════════════════════

async function thursday() {
  console.log('\nTHURSDAY (Queries & Coverage):')

  // Step 16: DM query detection
  await step('Step 16: DM query detection — pay, schedule, hours', 'Self-Service', () => {
    assert.ok(isPayQuery('how much do I get paid'))
    assert.ok(isPayQuery('my pay this week'))
    assert.ok(isHistoryQuery('pay history'))
    assert.ok(isScheduleQuery('when do I work'))
    assert.ok(isScheduleQuery('my schedule'))
    assert.ok(isHoursQuery('how many hours'))
    assert.ok(isEarnedWageQuery('how much have I made'))
    assert.ok(isEarnedWageQuery('my earnings this week'))
    assert.ok(!isEarnedWageQuery('can I swap shifts'))
  })

  // Step 17: Partial coverage parsing
  await step('Step 17: Partial coverage — "from 8pm to close"', 'Partial Coverage', () => {
    const shift = { startTime: '5:00 PM', endTime: '11:00 PM' }
    const result = parseTimeReference({ portion: 'from', timeReference: '8pm' }, shift)
    assert.ok(result, 'Should parse partial time reference')
    assert.ok(result.coverFrom.includes('8'), 'Should have 8pm start')
    assert.ok(result.coverUntil.includes('11'), 'Should have 11pm end')

    // Test first_half and second_half portions
    const firstHalf = parseTimeReference({ portion: 'first_half' }, shift)
    assert.ok(firstHalf, 'Should parse first_half')
    assert.ok(firstHalf.coverFrom.includes('5'), 'First half starts at 5')

    const secondHalf = parseTimeReference({ portion: 'second_half' }, shift)
    assert.ok(secondHalf, 'Should parse second_half')
    assert.ok(secondHalf.coverUntil.includes('11'), 'Second half ends at 11')

    // calculateRemainingCoverage works with consistent formats
    const partials = [{ cover_from: result.coverFrom, cover_until: result.coverUntil }]
    const remaining = calculateRemainingCoverage(shift, partials)
    assert.ok(Array.isArray(remaining), 'Should return array')
  })

  // Step 18: Earned wage formatting
  await step('Step 18: Earned wage response formatting', 'Earned Wage', () => {
    const earned = {
      staffName: 'Sarah', weekStart: '2025-01-06', hourlyRate: 14,
      shiftsCompleted: 3, shiftsInProgress: 1, shiftsUpcoming: 2,
      hoursWorked: 17, hoursScheduledTotal: 34,
      earnedSoFar: 238, currentShiftEarnings: 28,
      projectedWeekTotal: 476, noShiftsThisWeek: false
    }
    const formatted = formatEarnedWageResponse(earned, true)
    assert.ok(formatted.includes('238'), 'Should show earned so far')
    assert.ok(formatted.includes('14'), 'Should show rate')
    assert.ok(formatted.includes('476') || formatted.includes('projected'), 'Should show projected')
    assert.ok(formatted.toLowerCase().includes('right now') || formatted.includes('28'), 'Should show current earnings')
  })

  // Step 19: Earned wage — no shifts
  await step('Step 19: Earned wage — no shifts this week', 'Earned Wage', () => {
    const noShifts = {
      staffName: 'Rosa', weekStart: '2025-01-06', hourlyRate: 13,
      shiftsCompleted: 0, shiftsInProgress: 0, shiftsUpcoming: 0,
      hoursWorked: 0, hoursScheduledTotal: 0,
      earnedSoFar: 0, currentShiftEarnings: null,
      projectedWeekTotal: 0, noShiftsThisWeek: true
    }
    const formatted = formatEarnedWageResponse(noShifts)
    assert.ok(formatted.toLowerCase().includes('no shifts'), 'Should say no shifts')
  })
}

// ═══════════════════════════════════════════════════════════════
// FRIDAY — PAYROLL & MANAGER LOG
// ═══════════════════════════════════════════════════════════════

async function friday() {
  console.log('\nFRIDAY (Payroll & Intelligence):')

  // Step 20: Pay calculation
  await step('Step 20: Payroll — weekly pay calculation', 'Payroll', () => {
    const weekAssignments = [
      { staffId: 2, staffName: 'Sarah', shiftId: 1, roleName: 'Server' },
      { staffId: 2, staffName: 'Sarah', shiftId: 2, roleName: 'Server' },
      { staffId: 2, staffName: 'Sarah', shiftId: 3, roleName: 'Server' },
    ]
    const roles = [{ roleName: 'Server', hourlyRate: 14 }]
    const pay = calculateWeeklyPay(weekAssignments, shifts, roles)
    assert.ok(pay.length === 1, 'Should have 1 staff summary')
    assert.equal(pay[0].staffName, 'Sarah')
    // Mon lunch(5h) + Mon dinner(6h) + Tue lunch(5h) = 16h * $14 = $224
    assert.equal(pay[0].totalGrossPay, 224)
    assert.equal(pay[0].totalHours, 16)
  })

  // Step 21: Revenue and labor cost
  await step('Step 21: Revenue parsing + labor cost %', 'Labor Cost', () => {
    assert.equal(parseRevenueInput('14500'), 14500)
    assert.equal(parseRevenueInput('$14,500'), 14500)
    assert.equal(parseRevenueInput('14.5k'), 14500)

    const result = calculateLaborCostPercent(4350, 14500)
    assert.equal(result.percent, 30, 'Labor cost should be 30%')
    assert.ok(result.status, 'Should have status')
  })

  // Step 22: Auto shift log — narrative building
  await step('Step 22: Auto shift log — narrative building', 'Auto Shift Log', () => {
    const shiftData = {
      shiftName: 'Wednesday Dinner',
      dayOfWeek: 'Wednesday',
      date: 'Jan 8',
      callouts: [{ staffName: 'Emma', minutesBefore: 75, reportedAt: '2025-01-08T15:45:00Z' }],
      coverageEvents: [{ coveredBy: 'Marcus', fillMinutes: 7, confirmedAt: '2025-01-08T15:52:00Z' }],
      lateArrivals: [{ staffName: 'Sarah', minutesLate: 18 }],
      noShows: [],
      fullyCovered: true,
    }
    const narrative = buildShiftNarrative(shiftData)
    assert.ok(narrative.includes('Emma'), 'Should mention Emma callout')
    assert.ok(narrative.includes('Marcus'), 'Should mention Marcus covering')
    assert.ok(narrative.includes('Sarah'), 'Should mention Sarah late')
    assert.ok(narrative.includes('7'), 'Should mention 7min fill time')
  })

  // Step 23: Consecutive day streak detection
  await step('Step 23: Consecutive day streak — contextual warning', 'Contextual Warnings', () => {
    const streak7 = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
    assert.equal(streak7.streak, 7)
    assert.ok(streak7.warning, '7 days should be a warning')

    const streak4 = getConsecutiveDayStreak(['Monday', 'Tuesday', 'Wednesday', 'Thursday'])
    assert.equal(streak4.streak, 4)
    assert.ok(!streak4.warning, '4 days should not be a warning')
  })
}

// ═══════════════════════════════════════════════════════════════
// SATURDAY — INTELLIGENCE LAYER
// ═══════════════════════════════════════════════════════════════

async function saturday() {
  console.log('\nSATURDAY (Intelligence):')

  // Step 24: Callout probability prediction
  await step('Step 24: Callout predictor — Emma high risk', 'Callout Predictor', () => {
    const emmaSignals = {
      historicalCalloutRateThisDay: 0.4,
      historicalCalloutRateThisShift: 0.3,
      recentCalloutSpike: true,
      moraleScore: 38,
      moraleTrend: 'declining',
      consecutiveDaysThisWeek: 5,
      totalObservations: 8,
    }
    const result = calculateCalloutProbability(emmaSignals)
    assert.ok(result.probability > 0.4, `Emma probability should be high, got ${result.probability}`)
    assert.ok(['high', 'critical'].includes(result.riskLevel), `Expected high/critical, got ${result.riskLevel}`)
    assert.ok(result.keyFactors.length > 0, 'Should have key factors')
    intelligenceFired.push('Callout risk detected for Emma')
  })

  // Step 25: Callout predictor — new staff protection
  await step('Step 25: Callout predictor — new staff capped at medium', 'Callout Predictor', () => {
    const newStaffSignals = {
      historicalCalloutRateThisDay: 1.0,
      historicalCalloutRateThisShift: 1.0,
      recentCalloutSpike: true,
      moraleScore: 30,
      moraleTrend: 'declining',
      consecutiveDaysThisWeek: 6,
      totalObservations: 2,  // only 2 data points
    }
    const result = calculateCalloutProbability(newStaffSignals)
    assert.ok(result.riskLevel !== 'critical' && result.riskLevel !== 'high',
      `New staff should be capped at medium, got ${result.riskLevel}`)
  })

  // Step 26: Callout risk formatting
  await step('Step 26: Callout risk section formatting', 'Callout Predictor', () => {
    const risks = [
      { staffName: 'Emma', shiftName: 'Friday Dinner', dayOfWeek: 'Friday', probability: 0.62, riskLevel: 'critical', keyFactors: ['4 callouts on Fridays', 'morale declining'] },
    ]
    const section = formatCalloutRiskSection(risks, 8)
    assert.ok(section, 'Should produce section with 8 weeks data')
    assert.ok(section.includes('Emma'), 'Should mention Emma')
    assert.ok(section.includes('62%') || section.includes('0.62'), 'Should show probability')

    // With insufficient data
    const noSection = formatCalloutRiskSection(risks, 3)
    assert.equal(noSection, null, 'Should return null with < 4 weeks data')
  })

  // Step 27: Pairing analysis
  await step('Step 27: Pairing optimizer — pair outcomes', 'Pairing Optimizer', () => {
    const shiftHistory = [
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-01-03', staffIds: [1, 2], shiftScore: 92 },
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2024-12-27', staffIds: [1, 2], shiftScore: 88 },
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2024-12-20', staffIds: [1, 2], shiftScore: 95 },
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2024-12-13', staffIds: [1], shiftScore: 72 },
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2024-12-06', staffIds: [1], shiftScore: 68 },
      { shiftId: 10, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2024-11-29', staffIds: [1], shiftScore: 74 },
    ]
    const staffNames = { 1: 'Marcus', 2: 'Sarah' }
    const pairs = analyzePairOutcomes(shiftHistory, staffNames)
    const marcusSarah = pairs.find(p =>
      (p.staffIdA === 1 && p.staffIdB === 2) || (p.staffIdA === 2 && p.staffIdB === 1))
    assert.ok(marcusSarah, 'Should find Marcus+Sarah pair')
    assert.equal(marcusSarah.pairingValue, 'positive', 'Marcus+Sarah should be positive pair')
    assert.ok(marcusSarah.pairingBenefit > 10, 'Benefit should be significant')
    intelligenceFired.push('Pairing optimization (Marcus+Sarah)')
  })

  // Step 28: Implicit constraint — discovery prompts
  await step('Step 28: Implicit constraint — discovery prompt generation', 'Implicit Constraints', () => {
    const patterns = [
      { type: 'never_together', staffIdA: 6, staffNameA: 'Emma', staffIdB: 3, staffNameB: 'Jake', confidence: 1.0, weeksAnalyzed: 10 },
      { type: 'always_on_shift', staffIdA: 4, staffNameA: 'Amy', shiftName: 'Friday Dinner', confidence: 0.9, weeksAnalyzed: 8 },
    ]
    const rules = [] // no existing rules match
    const filtered = filterAlreadyKnownConstraints(patterns, rules, [])
    assert.equal(filtered.length, 2, 'Both patterns should pass filter')

    const prompts = generateDiscoveryPrompts(filtered)
    assert.ok(prompts.length <= 2, 'Max 2 prompts per cycle')
    assert.ok(prompts[0].question.includes('Emma') || prompts[0].question.includes('Amy'))
    intelligenceFired.push('Implicit constraint discovered')
  })

  // Step 29: Staffing pattern recommendations
  await step('Step 29: Staffing pattern — recommendations', 'Staffing Patterns', () => {
    const patterns = [
      { shiftId: 3, shiftName: 'Tuesday Lunch', dayOfWeek: 'Tuesday', weeksAnalyzed: 8,
        avgRequired: 4, avgAssigned: 2.5, understaffedWeeks: 6, overstaffedWeeks: 0,
        understaffedRate: 0.75, overstaffedRate: 0, pattern: 'chronic_understaffing' },
    ]
    const { recommendations } = generateStaffingRecommendations(patterns)
    assert.ok(recommendations.length === 1)
    assert.equal(recommendations[0].type, 'increase_requirement')
    assert.equal(recommendations[0].severity, 'high') // rate >= 0.75
    const alert = formatStaffingPatternAlert({ recommendations })
    assert.ok(alert, 'Should format alert')
    assert.ok(alert.includes('Tuesday Lunch'), 'Should mention shift')
  })
}

// ═══════════════════════════════════════════════════════════════
// SUNDAY — WEEKLY INTELLIGENCE & BRIEFING
// ═══════════════════════════════════════════════════════════════

async function sunday() {
  console.log('\nSUNDAY (Intelligence & Briefing):')

  // Step 30: Quality score calculation
  await step('Step 30: Quality score — week metrics', 'Schedule Quality', () => {
    const metrics = {
      draftEdits: 2, coverageRequests: 1, noShows: 0,
      avgFillMinutes: 7, unconfirmedCount: 1, staffScheduled: 10
    }
    const result = calculateQualityScore(metrics, 10)
    assert.ok(result.score >= 60, `Score should be decent, got ${result.score}`)
    assert.ok(result.score <= 95, `Score should reflect deductions, got ${result.score}`)
    assert.ok(['A', 'B', 'C'].includes(result.grade), `Grade should be A-C, got ${result.grade}`)
    intelligenceFired.push('Quality score calculated')
  })

  // Step 31: Quality score — perfect week
  await step('Step 31: Quality score — perfect week = 100', 'Schedule Quality', () => {
    const perfect = { draftEdits: 0, coverageRequests: 0, noShows: 0, avgFillMinutes: null, unconfirmedCount: 0, staffScheduled: 10 }
    const result = calculateQualityScore(perfect, 10)
    assert.equal(result.score, 100, 'Perfect week should score 100')
    assert.equal(result.grade, 'A')
  })

  // Step 32: Quality trend detection
  await step('Step 32: Quality trend — improving over time', 'Schedule Quality', () => {
    const history = [
      { score: 60 }, { score: 65 }, { score: 70 }, { score: 75 }, { score: 80 }, { score: 85 }
    ]
    const trend = detectQualityTrend(history)
    assert.equal(trend.trend, 'improving')
    assert.ok(trend.recentAvg > trend.priorAvg)

    // Insufficient data
    const short = [{ score: 80 }, { score: 85 }]
    assert.equal(detectQualityTrend(short).trend, 'insufficient_data')
  })

  // Step 33: Turnover risk scoring
  await step('Step 33: Turnover risk — Emma flagged', 'Turnover Risk', () => {
    const emmaSignals = {
      moraleScore: 38, moraleTrend: 'declining',
      reliabilityScore: 54,
      recentHoursDrop: false, hoursTrend: 'stable',
      coverageDeclineRate: 0.4,
      consecutiveDaysMax: 5,
      lateArrivalCount: 1,
      recognitionCount: 0,
      weeksOfData: 8,
    }
    const result = calculateRiskScore(emmaSignals)
    assert.ok(result.score > 30, `Emma should be at least medium risk, got ${result.score}`)
    assert.ok(result.factors.length > 0, 'Should have risk factors')
    intelligenceFired.push('Turnover risk flagged Emma')
  })

  // Step 34: Turnover risk — new staff protection
  await step('Step 34: Turnover risk — new staff capped at 30', 'Turnover Risk', () => {
    const newStaff = {
      moraleScore: 30, moraleTrend: 'declining', reliabilityScore: 40,
      recentHoursDrop: true, hoursTrend: 'dropping',
      coverageDeclineRate: 1.0, consecutiveDaysMax: 7,
      lateArrivalCount: 5, recognitionCount: 0, weeksOfData: 1,
    }
    const result = calculateRiskScore(newStaff)
    assert.ok(result.score <= 30, `New staff should be capped at 30, got ${result.score}`)
  })

  // Step 35: Turnover risk report formatting
  await step('Step 35: Turnover risk report — alert format', 'Turnover Risk', () => {
    const report = {
      critical: [{ staffName: 'Emma', score: 72, factors: ['Low morale (38)', 'Reliability issues'], recommendation: 'Urgent check-in recommended' }],
      high: [], medium: [], low: [],
      teamRiskAverage: 35, staffCount: 10,
    }
    const alert = formatTurnoverRiskAlert(report)
    assert.ok(alert, 'Should produce alert for critical staff')
    assert.ok(alert.includes('Emma'), 'Should mention Emma')
    assert.ok(alert.includes('private') || alert.includes('not visible'), 'Should have privacy note')

    const cmd = formatTurnoverRiskCommand(report)
    assert.ok(cmd.includes('Emma'), 'Command output should include Emma')
  })

  // Step 36: Morale score calculation
  await step('Step 36: Morale score — Marcus high, Emma low', 'Morale Tracking', () => {
    const marcusEvents = [
      { type: 'coverage_accept', sentiment: 'positive', created_at: new Date().toISOString() },
      { type: 'coverage_accept', sentiment: 'positive', created_at: new Date().toISOString() },
      { type: 'schedule_confirm', sentiment: 'positive', response_minutes: 30, created_at: new Date().toISOString() },
    ]
    const marcusMorale = calculateMoraleScore(marcusEvents)
    assert.ok(marcusMorale.score > 60, `Marcus morale should be high, got ${marcusMorale.score}`)

    const emmaEvents = [
      { type: 'coverage_decline', sentiment: 'negative', created_at: new Date().toISOString() },
      { type: 'coverage_decline', sentiment: 'negative', created_at: new Date().toISOString() },
      { type: 'no_response', sentiment: 'negative', created_at: new Date().toISOString() },
    ]
    const emmaMorale = calculateMoraleScore(emmaEvents)
    assert.ok(emmaMorale.score < 50, `Emma morale should be low, got ${emmaMorale.score}`)
  })

  // Step 37: Reliability scoring
  await step('Step 37: Reliability scoring — Marcus vs Emma', 'Reliability', () => {
    const marcusEvents = [
      { event_type: 'covered_someone', recorded_at: new Date().toISOString() },
      { event_type: 'covered_someone', recorded_at: new Date().toISOString() },
      { event_type: 'confirmed_schedule', recorded_at: new Date().toISOString() },
      { event_type: 'confirmed_schedule', recorded_at: new Date().toISOString() },
      { event_type: 'showed_up', recorded_at: new Date().toISOString() },
    ]
    const marcusScore = computeScore(marcusEvents)
    assert.ok(marcusScore > 80, `Marcus reliability should be excellent, got ${marcusScore}`)
    assert.equal(getReliabilityLabel(marcusScore), 'excellent')

    const emmaEvents = [
      { event_type: 'called_out', recorded_at: new Date().toISOString() },
      { event_type: 'called_out', recorded_at: new Date().toISOString() },
      { event_type: 'late_arrival', recorded_at: new Date().toISOString() },
    ]
    const emmaScore = computeScore(emmaEvents)
    assert.ok(emmaScore < 60, `Emma reliability should be low, got ${emmaScore}`)
    assert.ok(['fair', 'poor'].includes(getReliabilityLabel(emmaScore)))
  })
}

// ═══════════════════════════════════════════════════════════════
// RUN SIMULATION
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log(' RELAY SIMULATION — Full Restaurant Week')
  console.log(' Restaurant: Mahin\'s Kitchen | Week Jan 6-12 2025')
  console.log('═══════════════════════════════════════════════════════════')

  await monday()
  await tuesday()
  await wednesday()
  await thursday()
  await friday()
  await saturday()
  await sunday()

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════')
  console.log(` RESULTS: ${passed}/${passed + failed} steps passing`)
  console.log('═══════════════════════════════════════════════════════════')

  if (failures.length > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) {
      console.log(`  ❌ ${f.name}`)
      console.log(`     ${f.error}`)
    }
  }

  console.log('\nFEATURES TESTED:')
  for (const f of featuresTested) console.log(`  ✅ ${f}`)

  console.log('\nINTELLIGENCE FEATURES THAT FIRED:')
  for (const f of intelligenceFired) console.log(`  ✅ ${f}`)

  const notTested = [
    'Setup Wizard (requires LLM)',
    'Coverage DM flow (requires full handler chain)',
    'Trade execution (requires full handler chain)',
    'Availability Learning DB (requires Supabase)',
    'Emergency Availability ranking (requires DB)',
    'Cross-training LLM detection (requires Cerebras)',
    'Sunday narrative generation (requires Cerebras)',
    'Shift reminders cron',
    'No-show warning cron',
  ]
  console.log('\nFEATURES NOT TESTED (require DB/LLM):')
  for (const f of notTested) console.log(`  ⚠️  ${f}`)

  console.log('\n═══════════════════════════════════════════════════════════')
  if (failed === 0) {
    console.log('✅ ALL SIMULATION STEPS PASSING')
  } else {
    console.log(`❌ ${failed} STEP(S) FAILED`)
  }
  console.log('═══════════════════════════════════════════════════════════')

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Simulation crashed:', err)
  process.exit(1)
})
