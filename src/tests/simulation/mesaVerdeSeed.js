// Mesa Verde Kitchen seed — 15 staff, 6 shifts, 3 rules, recurring constraints,
// 4 weeks of pre-seeded history (payroll, quality scores, morale, callouts, cross-training).

export const GROUP_ID = 'stress-group-001'
export const GROUP_CHAT_ID = -100123456789
export const MANAGER_ID = 9001
export const MANAGER_DM = 9001
export const RESTAURANT_NAME = 'Mesa Verde Kitchen'

export const WEEK_STARTS = {
  preseed4: '2025-01-06',
  preseed3: '2025-01-13',
  preseed2: '2025-01-20',
  preseed1: '2025-01-27',
  week1: '2025-02-03',
  week2: '2025-02-10',
  week3: '2025-02-17',
  week4: '2025-02-24',
}

// 15 staff — ids match dm_chat_ids (for simplicity)
export const STAFF = [
  { id: 1001, name: 'Marcus',   role: 'Chef',       hourlyRate: 22, dm_chat_id: 1001, user_id: 1001, notes: 'Never Mondays (daughter school)' },
  { id: 1002, name: 'Devon',    role: 'Cook',       hourlyRate: 17, dm_chat_id: 1002, user_id: 1002, notes: '3 callouts in 90d, on thin ice' },
  { id: 1003, name: 'Aaliyah',  role: 'Server',     hourlyRate: 15, dm_chat_id: 1003, user_id: 1003, notes: 'Best. 3yr tenure.' },
  { id: 1004, name: 'Sarah',    role: 'Server',     hourlyRate: 14, dm_chat_id: 1004, user_id: 1004, notes: 'New, 6 weeks, occasionally late' },
  { id: 1005, name: 'Jake',     role: 'Bartender',  hourlyRate: 18, dm_chat_id: 1005, user_id: 1005, notes: 'Fri/Sat/Sun only' },
  { id: 1006, name: 'Carmen',   role: 'Server',     hourlyRate: 14, dm_chat_id: 1006, user_id: 1006, notes: 'Mon-Fri only, mother' },
  { id: 1007, name: 'Mike',     role: 'Prep Cook',  hourlyRate: 13, dm_chat_id: 1007, user_id: 1007, notes: 'Cross-trained Dishwasher' },
  { id: 1008, name: 'Rosa',     role: 'Host',       hourlyRate: 13, dm_chat_id: 1008, user_id: 1008, notes: 'Brunch only, must leave 4pm' },
  { id: 1009, name: 'Jaylen',   role: 'Busser',     hourlyRate: 12, dm_chat_id: 1009, user_id: 1009, notes: '17yo, no past 10pm Mon-Thu' },
  { id: 1010, name: 'Emma',     role: 'Server',     hourlyRate: 14, dm_chat_id: 1010, user_id: 1010, notes: 'Flight risk — declining morale' },
  { id: 1011, name: 'Carlos',   role: 'Dishwasher', hourlyRate: 12, dm_chat_id: null, user_id: null, notes: 'Sat only, no Telegram' },
  { id: 1012, name: 'Priya',    role: 'Server',     hourlyRate: 15, dm_chat_id: 1012, user_id: 1012, notes: 'Cross-trained Host, ambitious' },
  { id: 1013, name: 'Jordan',   role: null,         hourlyRate: 16, dm_chat_id: 1013, user_id: 1013, notes: 'Hired 2w ago, no role yet' },
  { id: 1014, name: 'Tiffany',  role: 'Server',     hourlyRate: 14, dm_chat_id: 1014, user_id: 1014, notes: 'Tue/Wed/Thu dinner only, not Mondays (religious)' },
  { id: 1015, name: 'Sam',      role: 'Chef',       hourlyRate: 21, dm_chat_id: 1015, user_id: 1015, notes: 'Marcus backup; DB has $19 (bug)' },
]

// 6 recurring shifts
export const SHIFTS = [
  { id: 2001, name: 'Mon-Fri Lunch',  day_of_week: 'Monday',   start_time: '11:00', end_time: '16:00', recurringDays: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
    requirements: [{ role: 'Server', count: 2 }, { role: 'Chef', count: 1 }, { role: 'Prep Cook', count: 1 }] },
  { id: 2002, name: 'Mon-Fri Dinner', day_of_week: 'Monday',   start_time: '17:00', end_time: '23:00', recurringDays: ['Monday','Tuesday','Wednesday','Thursday','Friday'],
    requirements: [{ role: 'Server', count: 3 }, { role: 'Chef', count: 1 }, { role: 'Cook', count: 1 }, { role: 'Bartender', count: 1 }, { role: 'Busser', count: 1 }] },
  { id: 2003, name: 'Sat Brunch',     day_of_week: 'Saturday', start_time: '10:00', end_time: '15:00', recurringDays: ['Saturday'],
    requirements: [{ role: 'Server', count: 3 }, { role: 'Chef', count: 1 }, { role: 'Host', count: 1 }] },
  { id: 2004, name: 'Sat Dinner',     day_of_week: 'Saturday', start_time: '17:00', end_time: '23:00', recurringDays: ['Saturday'],
    requirements: [{ role: 'Server', count: 4 }, { role: 'Chef', count: 1 }, { role: 'Cook', count: 1 }, { role: 'Bartender', count: 1 }, { role: 'Busser', count: 1 }, { role: 'Dishwasher', count: 1 }] },
  { id: 2005, name: 'Sun Brunch',     day_of_week: 'Sunday',   start_time: '10:00', end_time: '15:00', recurringDays: ['Sunday'],
    requirements: [{ role: 'Server', count: 2 }, { role: 'Chef', count: 1 }, { role: 'Host', count: 1 }] },
  { id: 2006, name: 'Sun Dinner',     day_of_week: 'Sunday',   start_time: '17:00', end_time: '22:00', recurringDays: ['Sunday'],
    requirements: [{ role: 'Server', count: 2 }, { role: 'Chef', count: 1 }, { role: 'Cook', count: 1 }, { role: 'Bartender', count: 1 }] },
]

// 3 business rules pre-configured
export const BUSINESS_RULES = [
  { type: 'staff_conflict',  subject: 'Marcus',  object: 'Devon',  constraint_text: 'Marcus and Devon never together' },
  { type: 'shift_preference', subject: 'Aaliyah', constraint_text: 'Aaliyah always Saturday dinner', day_of_week: 'Saturday', shift_id: 2004 },
  { type: 'shift_preference', subject: 'TEAM',    constraint_text: 'No one works more than 5 days/week' },
]

export const RECURRING_CONSTRAINTS = [
  { staff: 'Jake',    type: 'available_days', days: ['Friday', 'Saturday', 'Sunday'] },
  { staff: 'Carmen',  type: 'available_days', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
  { staff: 'Tiffany', type: 'day_off',        days: ['Monday'], reason: 'religious' },
  { staff: 'Rosa',    type: 'available_days', days: ['Saturday', 'Sunday'] },
  { staff: 'Rosa',    type: 'time_constraint', latest_end: '15:00' },
  { staff: 'Jaylen',  type: 'time_constraint', latest_end_mon_thu: '22:00' },
  { staff: 'Marcus',  type: 'day_off',        days: ['Monday'] },
]

export const OT_SETTINGS = {
  overtime_enabled: true,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_threshold: 0,
  daily_overtime_enabled: false,
  daily_multiplier: 1.5,
}

export const TIP_SETTINGS = { mode: 'pool', split_method: 'hours', boh_included: false }
export const WEEKLY_LABOR_BUDGET = 8500

export async function seedMesaVerde(db) {
  // staff
  for (const s of STAFF) {
    db.staff.push({ ...s, group_id: GROUP_ID, active: true, created_at: '2024-12-01T00:00:00Z' })
    if (s.role) {
      // role rate
      await db.updateRoleRate(GROUP_ID, s.role, s.hourlyRate)
    }
  }
  // Sam pre-existing bug: DB has $19, not $21
  await db.updateRoleRate(GROUP_ID, 'Chef', 21) // but we'll override sam_rate below
  db._samRateBug = { staffId: 1015, dbRate: 19, correctRate: 21 }

  // shifts + requirements
  for (const sh of SHIFTS) {
    db.shifts.push({ id: sh.id, group_id: GROUP_ID, name: sh.name, day_of_week: sh.day_of_week,
      start_time: sh.start_time, end_time: sh.end_time, active: true, created_at: '2024-12-01T00:00:00Z' })
    for (const req of sh.requirements) {
      db.shiftRequirements.push({ id: db._nextId(), shift_id: sh.id, role: req.role, count: req.count })
    }
  }

  // business rules — save with BOTH snake_case (DB) and camelCase (applyRulesToAssignments expects camelCase)
  for (const r of BUSINESS_RULES) {
    const sub = db.staff.find(s => s.name === r.subject)
    const obj = r.object ? db.staff.find(s => s.name === r.object) : null
    await db.saveRule(GROUP_ID, {
      type: r.type,
      subject_staff_id: sub?.id ?? null,
      object_staff_id: obj?.id ?? null,
      subjectStaffId: sub?.id ?? null,
      objectStaffId: obj?.id ?? null,
      constraint_text: r.constraint_text,
      constraint: r.constraint_text,
      raw_message: r.constraint_text,
      day_of_week: r.day_of_week ?? null,
      dayOfWeek: r.day_of_week ?? null,
      shift_id: r.shift_id ?? null,
    })
  }

  // recurring constraints
  for (const rc of RECURRING_CONSTRAINTS) {
    const s = db.staff.find(x => x.name === rc.staff)
    if (s) {
      await db.saveRecurringConstraint({ staff_id: s.id, group_id: GROUP_ID, ...rc, active: true })
    }
  }

  // OT, budget, tip settings, setup session
  await db.saveOvertimeSettings(GROUP_ID, OT_SETTINGS)
  await db.saveBudget(GROUP_ID, WEEKLY_LABOR_BUDGET)
  await db.saveTipSettings(GROUP_ID, TIP_SETTINGS)
  await db.updateSetupSession(GROUP_ID, {
    manager_id: MANAGER_ID,
    dm_chat_id: MANAGER_DM,
    group_name: RESTAURANT_NAME,
    restaurant_name: RESTAURANT_NAME,
    setup_complete: true,
    setup_data: { max_shifts_per_day: 2 },
  })

  // Cross-training
  const mike = db.staff.find(s => s.name === 'Mike')
  const priya = db.staff.find(s => s.name === 'Priya')
  await db.saveCrossTraining({ staff_id: mike.id, group_id: GROUP_ID, role: 'Dishwasher', proficiency: 'competent' })
  await db.saveCrossTraining({ staff_id: priya.id, group_id: GROUP_ID, role: 'Host', proficiency: 'competent' })
  await db.saveCrossTraining({ staff_id: priya.id, group_id: GROUP_ID, role: 'Bartender', proficiency: 'training' })

  // ── 4 weeks of pre-seeded history ─────────────────────────────────────────
  const preseedWeeks = [WEEK_STARTS.preseed4, WEEK_STARTS.preseed3, WEEK_STARTS.preseed2, WEEK_STARTS.preseed1]
  let idx = 0
  for (const weekStart of preseedWeeks) {
    idx++
    // quality score — avg 71 declining
    const score = 75 - idx * 1.5
    await db.saveQualityScore(GROUP_ID, weekStart, {
      score: Math.round(score), grade: score >= 80 ? 'B' : score >= 70 ? 'C' : 'D',
      draft_edits: 2, coverage_requests: 1, no_shows: 0, avg_fill_minutes: 15,
    })
    // payroll for each staff member — conservative fake
    for (const s of STAFF) {
      if (!s.role) continue
      const rate = s.name === 'Sam' ? 19 : s.hourlyRate // Sam's bug
      const hours = 20 + Math.random() * 10
      await db.savePeriodPayroll({
        group_id: GROUP_ID, staff_id: s.id, week_start: weekStart,
        total_hours: Math.round(hours * 100) / 100,
        total_late_minutes: 0, total_late_deduction: 0,
        total_gross_pay: Math.round(hours * rate * 100) / 100,
        shift_breakdown: [],
      })
    }
    // revenue
    await db.saveWeeklyRevenue(GROUP_ID, weekStart, 32000 + idx * 500)
  }

  // Emma declining morale (4 weeks)
  const emma = db.staff.find(s => s.name === 'Emma')
  for (let w = 0; w < 4; w++) {
    const ws = preseedWeeks[w]
    db.setNow(new Date(`${ws}T09:00:00Z`))
    await db.saveMoraleEvent(GROUP_ID, emma.id, { type: 'no_response', sentiment: 'negative', week_start: ws })
    if (w >= 1) await db.saveMoraleEvent(GROUP_ID, emma.id, { type: 'coverage_decline', sentiment: 'negative', week_start: ws })
    if (w >= 2) await db.saveMoraleEvent(GROUP_ID, emma.id, { type: 'late_confirm', response_minutes: 2000, week_start: ws })
  }

  // Devon 3 callouts in 90 days
  const devon = db.staff.find(s => s.name === 'Devon')
  const calloutDates = ['2024-12-11', '2025-01-08', '2025-01-22']
  for (const d of calloutDates) {
    db.setNow(new Date(`${d}T16:00:00Z`))
    await db.recordEvent(GROUP_ID, devon.id, { type: 'called_out', date: d, note: 'last-minute callout' })
    await db.saveMoraleEvent(GROUP_ID, devon.id, { type: 'coverage_decline', sentiment: 'negative', week_start: '2025-01-06' })
  }

  // Aaliyah reliable — 4 weeks of covered_someone events
  const aaliyah = db.staff.find(s => s.name === 'Aaliyah')
  for (const d of ['2025-01-11', '2025-01-18', '2025-01-25', '2025-02-01']) {
    db.setNow(new Date(`${d}T12:00:00Z`))
    await db.recordEvent(GROUP_ID, aaliyah.id, { type: 'confirmed_schedule', date: d })
    await db.saveMoraleEvent(GROUP_ID, aaliyah.id, { type: 'coverage_accept', sentiment: 'positive' })
  }

  // Some scheduled assignments from preseed1 so handlers have context
  const ws = WEEK_STARTS.preseed1
  for (const s of STAFF.filter(s => s.role && s.name !== 'Jordan')) {
    const shift = SHIFTS[Math.floor(Math.random() * SHIFTS.length)]
    db.scheduleAssignments.push({
      id: db._nextId(), group_id: GROUP_ID, shift_id: shift.id, staff_id: s.id,
      week_start: ws, day_of_week: shift.day_of_week, status: 'scheduled',
    })
  }

  db.setNow(null) // clear frozen clock

  // Availability seed for week1 — empty so availability collection is Step 1
  return { staffCount: db.staff.length, shiftCount: db.shifts.length }
}

export function dayOfWeek(d) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(d).getUTCDay()]
}
