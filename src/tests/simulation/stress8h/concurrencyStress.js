// Concurrency stress — fires many simultaneous operations against
// SimulationDb to check atomicity, race conditions, idempotency.

import { SimulationDb } from '../simulationDb.js'
import { seedMesaVerde, GROUP_ID, STAFF } from '../mesaVerdeSeed.js'

export async function runConcurrencyStress() {
  const findings = []
  const stats = {}

  const db = new SimulationDb()
  await seedMesaVerde(db)

  // Test 1: 50 concurrent volunteers for the same coverage request — only one
  // should succeed (markCovered atomic).
  const req = await db.saveRequest(GROUP_ID, 'Mesa Verde', 'Saturday Dinner', 'Devon', 1002)
  const volunteers = STAFF.slice(0, 50)
  const winners = await Promise.all(volunteers.map(s => db.markCovered(req.id, s.name).catch(() => null)))
  const successCount = winners.filter(w => w && w.status === 'covered').length
  stats.coverageRaceWinners = successCount
  if (successCount !== 1) {
    findings.push({
      severity: 'HIGH',
      area: 'concurrency-coverage',
      title: `Coverage markCovered race produced ${successCount} winners (expected 1)`,
      evidence: `Each volunteer should see "you covered" but only one wins. Found ${successCount}.`,
      impact: 'Multiple staff get told they "covered" the same shift — schedule chaos.',
    })
  }

  // Test 2: 100 concurrent clock-ins for same staff — should be idempotent
  const clockIns = await Promise.all(Array.from({ length: 100 }, () =>
    db.clockIn({ staff_id: 1003, user_id: 1003, group_id: GROUP_ID, shift_id: 2003, clock_in: new Date().toISOString() }).catch(() => null)
  ))
  const successfulClocks = clockIns.filter(c => c != null).length
  stats.concurrentClockIns = successfulClocks
  if (successfulClocks > 1) {
    findings.push({
      severity: 'HIGH',
      area: 'concurrency-clock',
      title: `Concurrent clockIn produced ${successfulClocks} successful entries (expected 1)`,
      impact: 'Staff could end up with multiple open clock-ins — payroll double-counts.',
    })
  }

  // Test 3: 100 concurrent clockOut on the same entry — only one should win
  const open = db.timeEntries.find(e => !e.clock_out)
  if (open) {
    const outs = await Promise.all(Array.from({ length: 100 }, () =>
      db.clockOut(open.id).catch(() => null)
    ))
    const successOuts = outs.filter(o => o != null).length
    stats.concurrentClockOuts = successOuts
    if (successOuts > 1) {
      findings.push({
        severity: 'MEDIUM',
        area: 'concurrency-clock',
        title: `Concurrent clockOut produced ${successOuts} updates (expected 1)`,
        impact: 'clock_out timestamp race — could record wrong end time.',
      })
    }
  }

  // Test 4: 50 concurrent saveAvailability for same (user, week) — should upsert,
  // last write wins, no duplicates
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    db.saveAvailability(1003, GROUP_ID, '2025-04-28', { available_all: i % 2 === 0, raw_response: `attempt ${i}` })
  ))
  const avail = await db.getAvailability(GROUP_ID, '2025-04-28')
  const dupForAaliyah = avail.filter(a => a.user_id === 1003).length
  if (dupForAaliyah !== 1) {
    findings.push({
      severity: 'HIGH',
      area: 'concurrency-availability',
      title: `Concurrent saveAvailability created ${dupForAaliyah} rows for same user/week (expected 1)`,
      impact: 'Duplicate availability rows confuse schedule generator.',
    })
  }
  stats.availabilityRows = dupForAaliyah

  // Test 5: 50 concurrent payroll saves for same (staff, week) — should upsert
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    db.savePeriodPayroll({
      group_id: GROUP_ID, staff_id: 1003, week_start: '2025-04-28',
      total_hours: 30 + i, total_late_minutes: 0, total_late_deduction: 0,
      total_gross_pay: (30 + i) * 15, shift_breakdown: [],
    })
  ))
  const payRows = await db.getPayrollForWeek(GROUP_ID, '2025-04-28')
  const dupPay = payRows.filter(r => r.staff_id === 1003).length
  if (dupPay !== 1) {
    findings.push({
      severity: 'HIGH',
      area: 'concurrency-payroll',
      title: `Concurrent savePeriodPayroll created ${dupPay} rows for same staff/week (expected 1)`,
      impact: 'Payroll calculations inflate; duplicate rows in spreadsheet.',
    })
  }
  stats.payrollRows = dupPay

  // Test 6: race tip records for same date
  await Promise.all(Array.from({ length: 30 }, (_, i) =>
    db.saveTipRecord({ group_id: GROUP_ID, shift_date: '2025-04-28', total_tips: 1500 + i, splits: [], split_method: 'hours', mode: 'pool' })
  ))
  const tipRows = (await db.getTipHistory(GROUP_ID)).filter(t => t.shift_date === '2025-04-28').length
  if (tipRows !== 1) {
    findings.push({
      severity: 'MEDIUM',
      area: 'concurrency-tips',
      title: `Concurrent saveTipRecord created ${tipRows} rows for same date (expected 1 — upsert)`,
    })
  }
  stats.tipRows = tipRows

  return { findings, stats }
}
