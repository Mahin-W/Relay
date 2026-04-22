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

    // B3: reject past weekStart (>= 7 days before today)
    const weekStartDate = new Date(body.weekStart)
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

  return { status: 404, body: { error: `No handler for ${M} ${path}` } }
}
