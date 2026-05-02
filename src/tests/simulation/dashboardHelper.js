// Lightweight in-process dashboard API facade for the simulation.
// Doesn't run real Express. Validates JWT with the real secret + implements
// the same write operations the dashboard does against SimulationDb directly.
// Goal: exercise the SAME state transitions the real routes cause, not mock HTTP.

import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'relay-dev-secret-change-in-production'

export function signJWT({ phone = '+19195550001', groupId, restaurantName = 'Mesa Verde Kitchen' }, opts = {}) {
  return jwt.sign({ phone, groupId, restaurantName }, JWT_SECRET, { expiresIn: opts.expiresIn ?? '7d' })
}

// Sign an intentionally-expired token (for Bug Hunter BH.10)
export function signExpiredJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '-1h' })
}

function verifyJWT(token) {
  try { return { manager: jwt.verify(token, JWT_SECRET) } }
  catch (err) { return { error: err.message } }
}

export async function simulateDashboardRequest(db, method, path, body = {}, token = null) {
  const auth = verifyJWT(token)
  if (auth.error) {
    return { status: 401, body: { error: auth.error.includes('expired') ? 'Session expired — please log in again' : 'Not authenticated' } }
  }
  const manager = auth.manager
  const groupId = manager.groupId

  const M = method.toUpperCase()

  // ── Staff ───────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/staff') {
    if (!body.name || !body.name.trim()) return { status: 400, body: { error: 'Name is required' } }
    if (!body.role) return { status: 400, body: { error: 'Name and role required' } }
    const row = { id: db._nextId(), group_id: groupId, name: body.name, role: body.role,
      active: true, dm_chat_id: body.phone ? null : null, user_id: null, created_at: new Date().toISOString() }
    db.staff.push(row)
    return { status: 201, body: row }
  }

  if (M === 'PATCH' && path.startsWith('/api/staff/')) {
    const id = Number(path.split('/').pop())
    const s = db.staff.find(x => x.id === id && x.group_id === groupId)
    if (!s) return { status: 404, body: { error: 'Staff not found' } }
    if (body.name) s.name = body.name
    if (body.role) s.role = body.role
    if (body.rate != null) {
      await db.updateRoleRate(groupId, s.role, body.rate)
      s.hourlyRate = body.rate
    }
    return { status: 200, body: s }
  }

  if (M === 'DELETE' && path.startsWith('/api/staff/')) {
    const id = Number(path.split('/').pop())
    const s = db.staff.find(x => x.id === id && x.group_id === groupId)
    if (!s) return { status: 404, body: { error: 'Staff not found' } }
    s.active = false
    db.scheduleAssignments = db.scheduleAssignments.map(a => a.staff_id === id ? { ...a, status: 'cancelled' } : a)
    return { status: 200, body: { ok: true, staffId: id } }
  }

  if (M === 'GET' && path === '/api/staff') {
    return { status: 200, body: db.staff.filter(s => s.group_id === groupId && s.active !== false) }
  }

  // ── Shifts ──────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/shifts') {
    if (!body.name || !body.day_of_week || !body.start_time || !body.end_time) {
      return { status: 400, body: { error: 'name, day_of_week, start_time, end_time required' } }
    }
    const row = { id: db._nextId(), group_id: groupId, ...body, active: true, created_at: new Date().toISOString() }
    db.shifts.push(row)
    return { status: 201, body: row }
  }

  if (M === 'PATCH' && path.startsWith('/api/shifts/')) {
    const id = Number(path.split('/').pop())
    const s = db.shifts.find(x => x.id === id && x.group_id === groupId)
    if (!s) return { status: 404, body: { error: 'Shift not found' } }
    Object.assign(s, body)
    return { status: 200, body: s }
  }

  // ── Schedule ────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/schedule/assign') {
    if (!body.staffId || !body.shiftId || !body.weekStart) {
      return { status: 400, body: { error: 'staffId, shiftId, weekStart required' } }
    }
    // Validate weekStart format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.weekStart))) {
      return { status: 400, body: { error: 'weekStart must be YYYY-MM-DD' } }
    }
    const weekStartDate = new Date(body.weekStart)
    if (isNaN(weekStartDate.getTime())) {
      return { status: 400, body: { error: 'weekStart is not a valid date' } }
    }
    // B3: reject past weekStart (>= 7 days before today)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    sevenDaysAgo.setHours(0, 0, 0, 0)
    if (weekStartDate < sevenDaysAgo) {
      return { status: 409, body: { error: 'weekStart is in the past; use /api/timeclock/override for historical corrections' } }
    }

    const shift = db.shifts.find(s => s.id === body.shiftId)
    const staffMember = db.staff.find(s => s.id === body.staffId && s.group_id === groupId)
    if (!staffMember) return { status: 404, body: { error: 'Staff not found' } }

    // B2: role mismatch check using shift_requirements
    const requirements = (db.shiftRequirements || []).filter(r => r.shift_id === body.shiftId)
    if (requirements.length > 0) {
      const requiredRoles = [...new Set(requirements.map(r => r.role))]
      const staffRole = staffMember.role
      const crossTraining = staffMember.cross_training || []
      const roleMatch = requiredRoles.includes(staffRole) ||
        crossTraining.some(ct => requiredRoles.includes(ct))
      if (!roleMatch) {
        return { status: 409, body: { error: `Role mismatch: ${staffRole} cannot fill ${shift?.name ?? body.shiftId} (requires: ${requiredRoles.join(', ')})` } }
      }
    }

    // B4: duplicate check
    const duplicate = db.scheduleAssignments.find(a =>
      a.staff_id === body.staffId && a.shift_id === body.shiftId && a.week_start === body.weekStart
    )
    if (duplicate) {
      return { status: 409, body: { error: 'Already assigned' } }
    }

    const row = { id: db._nextId(), group_id: groupId, staff_id: body.staffId, shift_id: body.shiftId,
      week_start: body.weekStart, day_of_week: shift?.day_of_week ?? null, status: 'scheduled', created_at: new Date().toISOString() }
    db.scheduleAssignments.push(row)
    return { status: 201, body: row }
  }

  // ── Payroll ─────────────────────────────────────────────────────────────
  if (M === 'PATCH' && path.match(/^\/api\/payroll\/\d+\/rate$/)) {
    const staffId = Number(path.split('/')[3])
    const s = db.staff.find(x => x.id === staffId && x.group_id === groupId)
    if (!s) return { status: 404, body: { error: 'Staff not found' } }
    if (typeof body.rate !== 'number' || body.rate <= 0) return { status: 400, body: { error: 'Invalid rate' } }
    s.hourlyRate = body.rate
    await db.updateRoleRate(groupId, s.role, body.rate)
    // Retroactive payroll recompute: update all historical payroll rows for this staff
    const recomputed = []
    const history = await db.getPayrollHistory(groupId, staffId)
    for (const row of history) {
      const oldPay = row.total_gross_pay
      const newPay = Math.round(row.total_hours * body.rate * 100) / 100
      if (Math.abs(newPay - oldPay) > 0.001) {
        row.total_gross_pay = newPay
        recomputed.push({ weekStart: row.week_start, delta: Math.round((newPay - oldPay) * 100) / 100 })
      }
    }
    // A.05: warn (but do not reject) if rate is unusually high
    const responseBody = { staffId, role: s.role, rate: body.rate, recomputed }
    if (body.rate > 150) responseBody.warning = 'Rate unusually high — please verify'
    return { status: 200, body: responseBody }
  }

  if (M === 'POST' && path === '/api/payroll/revenue') {
    if (!body.weekStart || typeof body.revenue !== 'number' || body.revenue <= 0) {
      return { status: 400, body: { error: 'weekStart and positive revenue required' } }
    }
    await db.saveWeeklyRevenue(groupId, body.weekStart, body.revenue)
    const total = await db.getPayrollTotal(groupId, body.weekStart)
    const pct = Math.round((total / body.revenue) * 1000) / 10
    return { status: 200, body: { weekStart: body.weekStart, revenue: body.revenue, laborCost: total, laborPercent: pct } }
  }

  if (M === 'GET' && path.startsWith('/api/payroll/spreadsheet')) {
    // Return a CSV string
    const urlParams = new URL('http://x' + path)
    const week = urlParams.searchParams.get('week')
    const rows = await db.getPayrollForWeek(groupId, week)
    const csv = 'Name,Role,Hours,Gross Pay\n' + rows.map(r => {
      const staff = db.staff.find(s => s.id === r.staff_id)
      return `${staff?.name ?? '?'},${staff?.role ?? '?'},${r.total_hours},${r.total_gross_pay}`
    }).join('\n')
    return { status: 200, body: csv, headers: { 'content-type': 'text/csv' } }
  }

  // ── Timeclock ───────────────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/timeclock/live')) {
    const entries = await db.getClockedInNow(groupId)
    return { status: 200, body: entries.map(e => {
      const hoursSoFar = (Date.now() - new Date(e.clock_in).getTime()) / 3600000
      return { ...e, hoursSoFar: Math.round(hoursSoFar * 100) / 100 }
    }) }
  }

  if (M === 'GET' && path.startsWith('/api/timeclock')) {
    const urlParams = new URL('http://x' + path)
    const week = urlParams.searchParams.get('week')
    return { status: 200, body: await db.getTimeEntriesForWeek(groupId, week) }
  }

  if (M === 'POST' && path === '/api/timeclock/override') {
    if (!body.staffId || !body.action) return { status: 400, body: { error: 'staffId and action required' } }
    if (!['clock_in', 'clock_out', 'adjust'].includes(body.action)) {
      return { status: 400, body: { error: 'Invalid action' } }
    }
    if (body.action === 'clock_out') {
      const entry = await db.manualClockOut(body.staffId, body.time ?? new Date().toISOString())
      return { status: 200, body: entry ?? { ok: true } }
    }
    if (body.action === 'clock_in') {
      const entry = await db.manualClockIn({ staff_id: body.staffId, user_id: body.staffId, group_id: groupId, clock_in: body.time ?? new Date().toISOString() })
      return { status: 200, body: entry }
    }
    // adjust: find latest open entry and shift clock_in
    const open = db.timeEntries.find(e => e.staff_id === body.staffId && !e.clock_out)
    if (open) open.clock_in = body.time ?? open.clock_in
    return { status: 200, body: open ?? { ok: true } }
  }

  // ── Rules ───────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/rules') {
    if (!body.type || !body.constraintText) return { status: 400, body: { error: 'type and constraintText required' } }
    // A.04: validate subjectStaffId exists before saving
    if (body.subjectStaffId != null) {
      const exists = db.staff.find(s => s.id === body.subjectStaffId && s.group_id === groupId)
      if (!exists) return { status: 400, body: { error: 'Staff not found' } }
    }
    const row = await db.saveRule(groupId, {
      type: body.type, constraint_text: body.constraintText,
      raw_message: body.constraintText,
      subject_staff_id: body.subjectStaffId ?? null,
      object_staff_id: body.objectStaffId ?? null,
      day_of_week: body.dayOfWeek ?? null,
      shift_id: body.shiftId ?? null,
    })
    return { status: 201, body: row }
  }

  if (M === 'GET' && path === '/api/rules') {
    return { status: 200, body: await db.getRules(groupId) }
  }

  // ── Settings ────────────────────────────────────────────────────────────
  if (M === 'PATCH' && path === '/api/settings') {
    const session = await db.getSetupSession(groupId)
    if (body.restaurantName && session) session.restaurant_name = body.restaurantName
    if (body.weeklyBudget != null) await db.saveBudget(groupId, body.weeklyBudget)
    if (body.overtimeThreshold != null) {
      const s = await db.getOvertimeSettings(groupId)
      await db.saveOvertimeSettings(groupId, { ...s, weekly_threshold: body.overtimeThreshold })
    }
    if (body.tipMode) {
      const s = await db.getTipSettings(groupId)
      await db.saveTipSettings(groupId, { ...s, mode: body.tipMode })
    }
    return { status: 200, body: { ok: true } }
  }

  // ── Dashboard summary ───────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/dashboard/overview')) {
    const session = await db.getSetupSession(groupId)
    const ws = new URL('http://x' + path).searchParams.get('week') ||
      new Date().toISOString().slice(0, 10)
    const staff = db.staff.filter(s => s.group_id === groupId && s.active !== false)
    const shifts = db.shifts.filter(s => s.group_id === groupId)
    const assignments = db.scheduleAssignments.filter(a =>
      a.group_id === groupId && a.week_start === ws)
    const open = await db.getOpenCoverageRequests(groupId)
    const payroll = await db.getPayrollForWeek(groupId, ws)
    const totalLabor = payroll.reduce((s, r) => s + (Number(r.total_gross_pay) || 0), 0)
    const quality = (await db.getQualityHistory(groupId, 1)).slice(-1)[0]
    return {
      status: 200, body: {
        restaurantName: session?.restaurant_name || session?.group_name,
        weekStart: ws,
        staffCount: staff.length,
        shiftsThisWeek: assignments.length,
        coverageRequests: open.length,
        avgFillMinutes: 10,
        laborCost: totalLabor,
        qualityScore: quality?.score ?? null,
        qualityGrade: quality?.grade ?? null,
        lastWeek: { shiftsCount: 0 },
      }
    }
  }

  if (M === 'GET' && path.startsWith('/api/dashboard/intelligence')) {
    const insights = []
    const recent = await db.getMoraleEvents(groupId, null, 4)
    const negative = recent.filter(e => e.sentiment === 'negative')
    if (negative.length > 5) insights.push({ type: 'morale', message: 'Team morale trending negative' })
    return { status: 200, body: { insights } }
  }

  if (M === 'GET' && path.startsWith('/api/dashboard/activity')) {
    return { status: 200, body: db.coverageRequests.slice(-20).reverse() }
  }

  if (M === 'GET' && path.startsWith('/api/dashboard/schedule')) {
    const ws = new URL('http://x' + path).searchParams.get('week')
    return { status: 200, body: await db.getScheduleAssignments(groupId, ws) }
  }

  // ── Schedule generate / approve / move / swap ───────────────────────────
  if (M === 'POST' && path === '/api/schedule/generate') {
    if (!body.weekStart) return { status: 400, body: { error: 'weekStart required' } }
    try {
      const { generateWeeklySchedule } = await import('../../schedule/generateSchedule.js')
      const mockData = {
        shifts: db.shifts.filter(x => x.group_id === groupId),
        staff: db.staff.filter(x => x.group_id === groupId && x.active !== false && x.user_id).map(x => ({
          id: x.id, name: x.name, role: x.role, userId: x.user_id, dmChatId: x.dm_chat_id,
        })),
        availability: db.availability.filter(a => a.group_id === groupId && a.week_start === body.weekStart),
        requirements: db.shiftRequirements,
        rules: await db.getRules(groupId),
        maxShiftsPerDay: 2,
      }
      const draft = await generateWeeklySchedule(groupId, body.weekStart, mockData)
      // Persist to the test-store generatedSchedules so /approve can find it
      if (typeof db.saveGeneratedSchedule === 'function') {
        await db.saveGeneratedSchedule(groupId, body.weekStart, draft.assignments, draft.gaps)
      }
      return { status: 200, body: draft }
    } catch (err) {
      return { status: 500, body: { error: err.message } }
    }
  }

  if (M === 'POST' && path === '/api/schedule/approve') {
    if (!body.weekStart) return { status: 400, body: { error: 'weekStart required' } }
    const draft = (db.generatedSchedules || []).slice().reverse()
      .find(s => s.group_id === groupId && s.week_start === body.weekStart)
    if (!draft?.assignments) return { status: 404, body: { error: 'No draft for this week' } }
    db.scheduleAssignments = db.scheduleAssignments.filter(a =>
      !(a.group_id === groupId && a.week_start === body.weekStart))
    for (const a of draft.assignments) {
      const shift = db.shifts.find(s => s.id === a.shiftId)
      db.scheduleAssignments.push({
        id: db._nextId(), group_id: groupId, staff_id: a.staffId, shift_id: a.shiftId,
        week_start: body.weekStart, day_of_week: shift?.day_of_week ?? null, status: 'scheduled',
      })
    }
    return { status: 200, body: { success: true, count: draft.assignments.length } }
  }

  if (M === 'GET' && path.startsWith('/api/schedule/status')) {
    const ws = new URL('http://x' + path).searchParams.get('week')
    const assignments = await db.getPublishedSchedule(groupId, ws)
    return {
      status: 200, body: {
        weekStart: ws, isPublished: assignments.length > 0,
        publishedAt: assignments[0]?.created_at ?? null,
        count: assignments.length,
      }
    }
  }

  if (M === 'POST' && path === '/api/schedule/swap') {
    if (!body.fromStaffId || !body.toStaffId || !body.shiftId || !body.weekStart) {
      return { status: 400, body: { error: 'fromStaffId, toStaffId, shiftId, weekStart required' } }
    }
    const fromAssignment = db.scheduleAssignments.find(a =>
      a.group_id === groupId && a.staff_id === body.fromStaffId &&
      a.shift_id === body.shiftId && a.week_start === body.weekStart)
    if (!fromAssignment) return { status: 404, body: { error: 'Assignment not found' } }
    fromAssignment.staff_id = body.toStaffId
    return { status: 200, body: { success: true, swapped: fromAssignment } }
  }

  if (M === 'POST' && path === '/api/schedule/move') {
    if (!body.staffId || !body.fromShiftId || !body.toShiftId || !body.weekStart) {
      return { status: 400, body: { error: 'staffId, fromShiftId, toShiftId, weekStart required' } }
    }
    const a = db.scheduleAssignments.find(x =>
      x.group_id === groupId && x.staff_id === body.staffId &&
      x.shift_id === body.fromShiftId && x.week_start === body.weekStart)
    if (!a) return { status: 404, body: { error: 'Assignment not found' } }
    a.shift_id = body.toShiftId
    const shift = db.shifts.find(s => s.id === body.toShiftId)
    if (shift) a.day_of_week = shift.day_of_week
    return { status: 200, body: { success: true, moved: a } }
  }

  if (M === 'DELETE' && path === '/api/schedule/assign') {
    const before = db.scheduleAssignments.length
    db.scheduleAssignments = db.scheduleAssignments.filter(a =>
      !(a.group_id === groupId && a.staff_id === body.staffId &&
        a.shift_id === body.shiftId && a.week_start === body.weekStart))
    return { status: 200, body: { success: true, removed: before - db.scheduleAssignments.length } }
  }

  // ── Payroll GET, override ───────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/payroll/planned')) {
    const ws = new URL('http://x' + path).searchParams.get('week')
    const assignments = await db.getPublishedSchedule(groupId, ws)
    const rows = []
    let total = 0
    for (const s of db.staff.filter(x => x.group_id === groupId && x.active !== false)) {
      const myShifts = assignments.filter(a => a.staff_id === s.id)
      const hours = myShifts.length * 6 // rough
      const rate = Number(s.hourlyRate) || 15
      const cost = hours * rate
      total += cost
      rows.push({ staffId: s.id, name: s.name, hours, rate, plannedCost: cost })
    }
    return { status: 200, body: { totalPlannedCost: total, rows } }
  }

  if (M === 'GET' && path.startsWith('/api/payroll')) {
    const ws = new URL('http://x' + path).searchParams.get('week')
    return { status: 200, body: await db.getPayrollForWeek(groupId, ws) }
  }

  if (M === 'PATCH' && path === '/api/payroll/override') {
    if (!body.staffId || !body.weekStart) return { status: 400, body: { error: 'staffId, weekStart required' } }
    const row = await db.savePeriodPayroll({
      group_id: groupId, staff_id: body.staffId, week_start: body.weekStart,
      total_hours: body.totalHours ?? 0,
      total_late_minutes: 0, total_late_deduction: 0,
      total_gross_pay: body.totalGrossPay ?? 0,
      shift_breakdown: body.adjustments ?? {},
    })
    return { status: 200, body: row }
  }

  // ── Tips ─────────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/tips') {
    if (typeof body.totalTips !== 'number' && typeof body.tipAmount !== 'number') {
      return { status: 400, body: { error: 'totalTips required' } }
    }
    const total = body.totalTips ?? body.tipAmount
    const row = await db.saveTipRecord({
      group_id: groupId, shift_date: body.shiftDate ?? body.weekStart ?? new Date().toISOString().slice(0, 10),
      total_tips: total, splits: [], split_method: 'hours', mode: 'pool',
    })
    return { status: 200, body: row }
  }

  if (M === 'GET' && path.startsWith('/api/tips')) {
    return { status: 200, body: await db.getTipHistory(groupId, 4) }
  }

  // ── Revenue ──────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/revenue/daily') {
    if (!body.date || typeof body.amount !== 'number') {
      return { status: 400, body: { error: 'date and amount required' } }
    }
    if (body.amount < 0) {
      return { status: 400, body: { error: 'amount must be >= 0' } }
    }
    const row = { id: db._nextId(), group_id: groupId, entry_date: body.date,
      amount: body.amount, category: body.category ?? 'general',
      note: body.note ?? null, created_at: new Date().toISOString() }
    db.weeklyRevenue.push(row) // approximate — real impl uses daily_revenue table
    return { status: 201, body: row }
  }

  if (M === 'GET' && path.startsWith('/api/revenue/daily')) {
    const ws = new URL('http://x' + path).searchParams.get('weekStart')
    const days = db.weeklyRevenue.filter(r => r.group_id === groupId)
    const weekTotal = days.reduce((s, r) => s + (r.amount ?? r.revenue ?? 0), 0)
    return { status: 200, body: { days, weekTotal } }
  }

  if (M === 'GET' && path === '/api/revenue/types') {
    db._revenueTypes ??= [{ id: 1, name: 'Dine-in' }, { id: 2, name: 'Takeout' }]
    return { status: 200, body: db._revenueTypes.filter(t => !t._deleted) }
  }
  if (M === 'POST' && path === '/api/revenue/types') {
    if (!body.name) return { status: 400, body: { error: 'name required' } }
    db._revenueTypes ??= [{ id: 1, name: 'Dine-in' }, { id: 2, name: 'Takeout' }]
    const row = { id: db._nextId(), name: body.name, group_id: groupId }
    db._revenueTypes.push(row)
    return { status: 201, body: row }
  }
  if (M === 'DELETE' && path.startsWith('/api/revenue/types/')) {
    const id = Number(path.split('/').pop())
    db._revenueTypes ??= []
    const t = db._revenueTypes.find(x => x.id === id)
    if (t) t._deleted = true
    return { status: 200, body: { success: true } }
  }

  // ── Coverage ─────────────────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/coverage')) {
    return { status: 200, body: await db.getOpenCoverageRequests(groupId) }
  }
  if (M === 'POST' && path === '/api/coverage') {
    if (!body.staffId || !body.shiftId || !body.weekStart) {
      return { status: 400, body: { error: 'staffId, shiftId, weekStart required' } }
    }
    const row = await db.saveRequest(groupId, 'Group', `Shift ${body.shiftId}`, 'manager', null)
    return { status: 201, body: row }
  }

  // ── Timeclock weekly ─────────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/timeclock/weekly')) {
    const ws = new URL('http://x' + path).searchParams.get('weekStart')
    const entries = await db.getTimeEntriesForWeek(groupId, ws)
    return { status: 200, body: { weekStart: ws, entries, count: entries.length } }
  }

  // ── Events / Activity ────────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/events')) {
    return {
      status: 200, body: {
        events: [
          ...db.coverageRequests.slice(-10).map(r => ({
            id: r.id, title: r.shift_description, eventType: 'coverage',
            timestamp: r.created_at, meta: r,
          })),
        ]
      }
    }
  }

  // ── Settings full ────────────────────────────────────────────────────────
  if (M === 'GET' && path === '/api/settings') {
    const session = await db.getSetupSession(groupId)
    const tip = await db.getTipSettings(groupId)
    const ot = await db.getOvertimeSettings(groupId)
    const budget = await db.getBudget(groupId)
    return {
      status: 200, body: {
        restaurantName: session?.restaurant_name ?? session?.group_name,
        restaurant: { name: session?.restaurant_name ?? session?.group_name },
        tips: tip,
        overtime: ot,
        weeklyBudget: budget?.weekly_budget,
        timeclockEnabled: session?.setup_data?.timeclockEnabled ?? true,
      }
    }
  }
  if (M === 'GET' && path === '/api/settings/full') {
    const settings = (await simulateDashboardRequest(db, 'GET', '/api/settings', {}, token)).body
    return {
      status: 200, body: {
        ...settings,
        roles: db.roleRates.filter(r => r.group_id === groupId),
        coverageRules: db.businessRules.filter(r => r.group_id === groupId),
      }
    }
  }

  // ── Roles ────────────────────────────────────────────────────────────────
  if (M === 'GET' && path === '/api/roles') {
    return { status: 200, body: db.roleRates.filter(r => r.group_id === groupId) }
  }
  if (M === 'POST' && path === '/api/roles') {
    if (!body.name) return { status: 400, body: { error: 'name required' } }
    const row = { id: db._nextId(), group_id: groupId, role: body.name, rate: body.rate ?? 0 }
    db.roleRates.push(row)
    return { status: 201, body: row }
  }

  // ── Shifts DELETE / PATCH requirements ───────────────────────────────────
  if (M === 'DELETE' && path.startsWith('/api/shifts/')) {
    const id = Number(path.split('/').pop())
    db.shifts = db.shifts.filter(s => s.id !== id)
    return { status: 200, body: { success: true } }
  }
  if (M === 'PUT' && path.match(/^\/api\/shifts\/\d+\/requirements$/)) {
    const id = Number(path.split('/')[3])
    db.shiftRequirements = db.shiftRequirements.filter(r => r.shift_id !== id)
    for (const req of (body.requirements || [])) {
      db.shiftRequirements.push({ id: db._nextId(), shift_id: id, role: req.role, count: req.count })
    }
    return { status: 200, body: { success: true, count: (body.requirements || []).length } }
  }

  // ── Rules DELETE ─────────────────────────────────────────────────────────
  if (M === 'DELETE' && path.startsWith('/api/rules/')) {
    const id = Number(path.split('/').pop())
    await db.deactivateRule(id)
    return { status: 200, body: { success: true } }
  }

  // ── Rates ────────────────────────────────────────────────────────────────
  if (M === 'POST' && path === '/api/rates') {
    if (!body.roleName || typeof body.hourlyRate !== 'number') {
      return { status: 400, body: { error: 'roleName and hourlyRate required' } }
    }
    if (body.hourlyRate < 0 || body.hourlyRate > 500) {
      return { status: 400, body: { error: 'hourlyRate must be 0–500' } }
    }
    const row = await db.updateRoleRate(groupId, body.roleName, body.hourlyRate)
    return { status: 200, body: row }
  }

  // ── Intelligence (alias) ─────────────────────────────────────────────────
  if (M === 'GET' && path.startsWith('/api/intelligence')) {
    return simulateDashboardRequest(db, 'GET', '/api/dashboard/intelligence', {}, token)
  }

  // ── Activity (alias) ─────────────────────────────────────────────────────
  if (M === 'GET' && path === '/api/activity') {
    return { status: 200, body: { events: db.coverageRequests.slice(-20).reverse() } }
  }

  return { status: 404, body: { error: `No handler for ${M} ${path}` } }
}
