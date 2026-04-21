#!/usr/bin/env node
// Parallel test runner — runs ALL suites simultaneously via Promise.all.
// Reports a combined results table and exits 1 if anything fails.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '../..')

// Fast suites: no LLM calls — run in parallel
const FAST_SUITES = [
  { id: 'unit_availability', file: 'unit/availabilityParser.test.js', label: 'Unit — Availability Parser', timeout: 10_000 },
  { id: 'unit_shift', file: 'unit/shiftMatcher.test.js', label: 'Unit — Shift Matcher', timeout: 10_000 },
  { id: 'unit_schedule', file: 'unit/scheduleGenerator.test.js', label: 'Unit — Schedule Generator', timeout: 10_000 },
  { id: 'unit_botadmins', file: 'unit/botAdmins.test.js', label: 'Unit — Bot Admins', timeout: 10_000 },
  { id: 'unit_reminders', file: 'unit/shiftReminders.test.js', label: 'Unit — Shift Reminders', timeout: 15_000 },
  { id: 'unit_read_receipts', file: 'unit/readReceipts.test.js', label: 'Unit — Read Receipts', timeout: 10_000 },
  { id: 'unit_clopening', file: 'unit/clopening.test.js', label: 'Unit — Clopening Detection', timeout: 10_000 },
  { id: 'unit_hours', file: 'unit/hoursTracker.test.js', label: 'Unit — Hours Tracker', timeout: 10_000 },
  { id: 'unit_passive_avail', file: 'unit/passiveAvailability.test.js', label: 'Unit — Passive Availability', timeout: 10_000 },
  { id: 'unit_self_service', file: 'unit/selfService.test.js', label: 'Unit — Self-Service Schedule', timeout: 10_000 },
  { id: 'unit_oncall', file: 'unit/onCall.test.js', label: 'Unit — On-Call Bench System', timeout: 15_000 },
  { id: 'unit_noshow', file: 'unit/noShowWarning.test.js', label: 'Unit — No-show Warning', timeout: 10_000 },
  { id: 'unit_reliability', file: 'unit/reliability.test.js', label: 'Unit — Reliability Scoring', timeout: 10_000 },
  { id: 'unit_daily_briefing', file: 'unit/dailyBriefing.test.js', label: 'Unit — Daily Briefing', timeout: 10_000 },
  { id: 'unit_prefilter', file: 'unit/preFilter.test.js', label: 'Unit — Pre-filter', timeout: 10_000 },
  { id: 'unit_prefilter_exhaustive', file: 'unit/preFilter-exhaustive.test.js', label: 'Unit — Pre-filter Exhaustive', timeout: 15_000 },
  { id: 'unit_role_rates', file: 'unit/roleRates.test.js', label: 'Unit — Role Rates Setup', timeout: 10_000 },
  { id: 'unit_pay_calculator', file: 'unit/payCalculator.test.js', label: 'Unit — Pay Calculator', timeout: 10_000 },
  { id: 'unit_pay_report', file: 'unit/payReport.test.js', label: 'Unit — Pay Report', timeout: 10_000 },
  { id: 'unit_staff_pay', file: 'unit/staffPayService.test.js', label: 'Unit — Staff Pay Service', timeout: 10_000 },
  { id: 'unit_shift_editor', file: 'unit/shiftEditor.test.js', label: 'Unit — Shift Editor', timeout: 10_000 },
  { id: 'unit_staff_manager', file: 'unit/staffManager.test.js', label: 'Unit — Staff Manager', timeout: 10_000 },
  { id: 'unit_missed_clock_out', file: 'unit/missedClockOut.test.js', label: 'Unit — Missed Clock-Out', timeout: 10_000 },
  { id: 'unit_clock_override', file: 'unit/clockOverride.test.js', label: 'Unit — Clock Override', timeout: 10_000 },
  { id: 'unit_availability_window', file: 'unit/availabilityWindow.test.js', label: 'Unit — Availability Window', timeout: 10_000 },
  { id: 'unit_recurring_time_off', file: 'unit/recurringTimeOff.test.js', label: 'Unit — Recurring Time Off', timeout: 10_000 },
  { id: 'unit_rotation', file: 'unit/rotationTracker.test.js', label: 'Unit — Rotation Fairness', timeout: 10_000 },
  { id: 'unit_copy_schedule', file: 'unit/copySchedule.test.js', label: 'Unit — Copy Schedule', timeout: 10_000 },
  { id: 'unit_new_hire', file: 'unit/newHire.test.js', label: 'Unit — New Hire Onboarding', timeout: 10_000 },
  { id: 'unit_partial_coverage', file: 'unit/partialCoverage.test.js', label: 'Unit — Partial Coverage', timeout: 10_000 },
  { id: 'unit_overtime_setup', file: 'unit/overtimeSetup.test.js', label: 'Unit — Overtime Setup', timeout: 10_000 },
  { id: 'unit_overtime_pay', file: 'unit/overtimePay.test.js', label: 'Unit — Overtime Pay Calc', timeout: 10_000 },
  { id: 'unit_spreadsheet', file: 'unit/spreadsheetGenerator.test.js', label: 'Unit — Spreadsheet Generator', timeout: 30_000 },
  { id: 'unit_labor_cost', file: 'unit/laborCost.test.js', label: 'Unit — Labor Cost % Tracker', timeout: 15_000 },
  { id: 'unit_budget_alert', file: 'unit/budgetAlert.test.js', label: 'Unit — Budget Alert', timeout: 15_000 },
  { id: 'unit_shift_log', file: 'unit/shiftLog.test.js', label: 'Unit — Manager Shift Log', timeout: 15_000 },
  { id: 'unit_time_clock', file: 'unit/timeClock.test.js', label: 'Unit — Time Clock', timeout: 15_000 },
  { id: 'unit_clock_idempotency', file: 'unit/clockIdempotency.test.js', label: 'Unit — Clock Idempotency (BH.32)', timeout: 15_000 },
  { id: 'unit_late_arrival_validation', file: 'unit/lateArrivalValidation.test.js', label: 'Unit — Late Arrival Validation (1.14)', timeout: 15_000 },
  { id: 'unit_current_shift', file: 'unit/currentShift.test.js', label: 'Unit — Current Shift', timeout: 10_000 },
  { id: 'unit_business_rules', file: 'unit/businessRules.test.js', label: 'Unit — Business Rules', timeout: 60_000 },
  { id: 'unit_preference_tracker', file: 'unit/preferenceTracker.test.js', label: 'Unit — Preference Tracker', timeout: 10_000 },
  { id: 'unit_pattern_alerts', file: 'unit/patternAlerts.test.js', label: 'Unit — Pattern Alerts', timeout: 10_000 },
  { id: 'unit_morale_tracker', file: 'unit/moraleTracker.test.js', label: 'Unit — Morale Tracker', timeout: 10_000 },
  { id: 'unit_auto_shift_log', file: 'unit/autoShiftLog.test.js', label: 'Unit — Auto Shift Log', timeout: 10_000 },
  { id: 'unit_demand_signals', file: 'unit/demandSignals.test.js', label: 'Unit — Demand Signals', timeout: 10_000 },
  { id: 'unit_coverage_speed', file: 'unit/coverageSpeed.test.js', label: 'Unit — Coverage Speed', timeout: 10_000 },
  { id: 'unit_coverage_atomic', file: 'unit/coverageAtomic.test.js', label: 'Unit — Coverage Atomic + Role Validation', timeout: 15_000 },
  { id: 'unit_contextual_warnings', file: 'unit/contextualWarnings.test.js', label: 'Unit — Contextual Warnings', timeout: 10_000 },
  { id: 'unit_emergency_availability', file: 'unit/emergencyAvailability.test.js', label: 'Unit — Emergency Availability', timeout: 10_000 },
  { id: 'unit_tip_pool', file: 'unit/tipPool.test.js', label: 'Unit — Tip Pool Calculator', timeout: 10_000 },
  { id: 'unit_recognition', file: 'unit/recognition.test.js', label: 'Unit — Staff Recognition', timeout: 10_000 },
  { id: 'unit_earned_wage', file: 'unit/earnedWage.test.js', label: 'Unit — Earned Wage Visibility', timeout: 10_000 },
  { id: 'unit_turnover_risk', file: 'unit/turnoverRisk.test.js', label: 'Unit — Turnover Risk Score', timeout: 10_000 },
  { id: 'unit_schedule_quality', file: 'unit/scheduleQuality.test.js', label: 'Unit — Schedule Quality Score', timeout: 10_000 },
  { id: 'unit_staffing_patterns', file: 'unit/staffingPatterns.test.js', label: 'Unit — Staffing Pattern Memory', timeout: 10_000 },
  { id: 'unit_availability_learning', file: 'unit/availabilityLearning.test.js', label: 'Unit — Availability Learning', timeout: 10_000 },
  { id: 'unit_callout_predictor', file: 'unit/calloutPredictor.test.js', label: 'Unit — Callout Predictor', timeout: 10_000 },
  { id: 'unit_implicit_constraints', file: 'unit/implicitConstraints.test.js', label: 'Unit — Implicit Constraints', timeout: 10_000 },
  { id: 'unit_pairing_optimizer', file: 'unit/pairingOptimizer.test.js', label: 'Unit — Pairing Optimizer', timeout: 10_000 },
  { id: 'unit_platform', file: 'unit/platform.test.js', label: 'Unit — Platform Abstraction', timeout: 10_000 },
  { id: 'unit_dm_router_routing', file: 'unit/dmRouterRouting.test.js', label: 'Unit — DM Router Routing (F1/F2)', timeout: 10_000 },
  { id: 'unit_group_router_revenue', file: 'unit/groupRouterRevenue.test.js', label: 'Unit — Group Router Revenue Redirect (F3)', timeout: 10_000 },
  { id: 'integration_coverage', file: 'integration/coverageFlow.test.js', label: 'Integration — Coverage Flow', timeout: 30_000 },
  { id: 'integration_botadmin', file: 'integration/botAdminFlow.test.js', label: 'Integration — Bot Admin Flow', timeout: 10_000 },
  { id: 'integration_schedule', file: 'integration/scheduleFlow.test.js', label: 'Integration — Schedule Generation', timeout: 15_000 },
  { id: 'integration_dash_api', file: 'integration/dashApiRoutes.test.js', label: 'Integration — Dash API Routes', timeout: 30_000 },
  { id: 'e2e_week', file: 'e2e/fullWeekFlow.test.js', label: 'E2E — Full Week Cycle', timeout: 30_000 },
]

// LLM suites: share a Groq rate limit (6000 TPM on free tier) — run sequentially
const LLM_SUITES = [
  { id: 'unit_trade', file: 'unit/tradeFlow.test.js', label: 'Unit — Trade Flow (LLM)', timeout: 180_000 },
  { id: 'unit_parse', file: 'unit/parseMessage.test.js', label: 'Unit — LLM Message Parser', timeout: 360_000 },
  { id: 'unit_timeoff', file: 'unit/timeOff.test.js', label: 'Unit — Time-off Flow (LLM)', timeout: 300_000 },
  { id: 'unit_latearrival', file: 'unit/lateArrival.test.js', label: 'Unit — Late Arrival (LLM)', timeout: 300_000 },
  { id: 'integration_setup', file: 'integration/setupFlow.test.js', label: 'Integration — Setup Flow (LLM)', timeout: 180_000 },
  { id: 'unit_oncall_parse', file: 'unit/onCallParse.test.js', label: 'Unit — On-Call Parser (LLM)', timeout: 300_000 },
  { id: 'unit_manager_coverage', file: 'unit/managerCoverage.test.js', label: 'Unit — Manager Coverage (LLM)', timeout: 65_000 },
  { id: 'unit_copy_schedule', file: 'unit/copySchedule.test.js', label: 'Unit — Copy Schedule (LLM)', timeout: 300_000 },
  { id: 'unit_new_hire', file: 'unit/newHire.test.js', label: 'Unit — New Hire Onboarding (LLM)', timeout: 300_000 },
  { id: 'unit_partial_coverage', file: 'unit/partialCoverage.test.js', label: 'Unit — Partial Coverage (LLM)', timeout: 300_000 },
  { id: 'unit_narrative_briefing', file: 'unit/narrativeBriefing.test.js', label: 'Unit — Narrative Briefing (LLM)', timeout: 30_000 },
  { id: 'unit_cross_training', file: 'unit/crossTraining.test.js', label: 'Unit — Cross Training Tracker (LLM)', timeout: 65_000 },
]

const args = process.argv.slice(2)
const skipLlm = args.includes('--skip-llm')
const llmOnly = args.includes('--llm-only')

const fastToRun = llmOnly ? [] : FAST_SUITES
const llmToRun = skipLlm ? [] : LLM_SUITES

const TEST_SUITES = [...fastToRun, ...llmToRun]

// ── Suite runner ─────────────────────────────────────────────────────────────

function runSuite(suite) {
  return new Promise((resolve) => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''

    const fullPath = path.join(__dirname, suite.file)
    const proc = spawn(
      process.execPath,
      ['--env-file=.env', '--test', fullPath],
      { cwd: ROOT, env: process.env }
    )

    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })

    const timer = setTimeout(() => {
      proc.kill()
      resolve({
        ...suite,
        passed: false,
        timedOut: true,
        passCount: 0,
        failCount: 1,
        duration: Date.now() - start,
        output: stdout,
        error: `TIMED OUT after ${suite.timeout}ms`,
      })
    }, suite.timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)
      const passMatch = stdout.match(/^[#ℹ] pass\s+(\d+)/m)
      const failMatch = stdout.match(/^[#ℹ] fail\s+(\d+)/m)
      const passCount = passMatch ? parseInt(passMatch[1]) : 0
      const failCount = failMatch ? parseInt(failMatch[1]) : 0
      resolve({
        ...suite,
        passed: code === 0 && failCount === 0,
        exitCode: code,
        passCount,
        failCount,
        duration: Date.now() - start,
        output: stdout,
        error: stderr,
      })
    })
  })
}

// ── Results printer ───────────────────────────────────────────────────────────

function printResults(results, iteration) {
  const WIDTH = 64
  const LINE = '═'.repeat(WIDTH)

  console.log(`\n${LINE}`)
  console.log(`  RELAY TEST RESULTS — Iteration ${iteration}`)
  console.log(LINE)

  let totalPass = 0
  let totalFail = 0
  const failures = []

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌'
    const counts = r.timedOut ? 'TIMEOUT   ' : `${r.passCount}✓ ${r.failCount}✗`.padEnd(10)
    const time = `${(r.duration / 1000).toFixed(1)}s`
    console.log(`${icon} ${r.label.padEnd(38)} ${counts} ${time}`)
    totalPass += r.passCount || 0
    totalFail += r.failCount || 0
    if (!r.passed) failures.push(r)
  }

  console.log(LINE)
  console.log(`   TOTAL: ${totalPass} passed, ${totalFail} failed`)
  console.log(LINE)

  if (failures.length > 0) {
    console.log('\n❌ FAILURES:\n')
    for (const f of failures) {
      console.log(`── ${f.label} ──`)
      if (f.timedOut) {
        console.log('   TIMED OUT\n')
        continue
      }
      const failLines = f.output
        .split('\n')
        .filter(l =>
          l.includes('not ok') ||
          l.includes('Error:') ||
          l.includes('AssertionError') ||
          l.includes('expected') ||
          l.includes('actual') ||
          l.includes('at ')
        )
        .slice(0, 40)
        .join('\n')
      console.log(failLines || f.output.slice(-1000))
      if (f.error && f.error.trim()) {
        console.log('STDERR:', f.error.slice(-400))
      }
      console.log()
    }
  }

  return failures
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const totalStart = Date.now()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Relay Parallel Test Suite')
  console.log(`  ${TEST_SUITES.length} suites launching`)
  if (skipLlm) console.log('  Mode: --skip-llm (fast suites only)')
  if (llmOnly) console.log('  Mode: --llm-only (LLM suites only)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // Phase 1: fast suites run in parallel
  let fastResults = []
  if (fastToRun.length > 0) {
    console.log(`Phase 1: ${fastToRun.length} fast suites in parallel...`)
    fastResults = await Promise.all(fastToRun.map(suite => runSuite(suite)))
  }

  // Phase 2: LLM suites run sequentially to respect Groq TPM rate limits
  const llmResults = []
  if (llmToRun.length > 0) {
    console.log(`Phase 2: ${llmToRun.length} LLM suites sequentially...\n`)
    for (let i = 0; i < llmToRun.length; i++) {
      if (i > 0) {
        process.stdout.write('\n⏳ Waiting 62s before next LLM suite (Groq rate limit)...\n')
        await new Promise(r => setTimeout(r, 62_000))
      }
      llmResults.push(await runSuite(llmToRun[i]))
    }
  }
  const results = [...fastResults, ...llmResults]
  const failures = printResults(results, 1)

  const elapsed = ((Date.now() - totalStart) / 1000).toFixed(1)

  if (failures.length === 0) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ ALL TESTS PASSING — RELAY IS READY')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`Total test time: ${elapsed}s (all suites ran in parallel)`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    process.exit(0)
  } else {
    console.log(`\n❌ ${failures.length} suite(s) failing after ${elapsed}s\n`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
