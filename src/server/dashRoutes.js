import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from './middleware.js'
import { calculateTipSplit } from '../operations/tipPool.js'
import { generateWeeklySchedule } from '../schedule/generateSchedule.js'
import { manualClockOut, manualClockIn } from '../timeclock/clockOverride.js'

const router = express.Router()
router.use(requireAuth)

let _supabase
function supabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  return _supabase
}

function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  return monday.toISOString().split('T')[0]
}

function parseShiftHours(startTime, endTime) {
  if (!startTime || !endTime) return 0
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  let hours = (eh + em / 60) - (sh + sm / 60)
  if (hours <= 0) hours += 24
  return hours
}

// GET /api/dashboard/overview
router.get('/overview', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const [staffRes, assignRes, coverageRes, payrollRes, revenueRes, qualityRes, receiptsRes] = await Promise.all([
      // 1. Staff count
      db.from('staff').select('id', { count: 'exact', head: true }).eq('group_id', groupId),
      // 2. Shifts this week
      db.from('schedule_assignments').select('id', { count: 'exact', head: true }).eq('group_id', groupId).eq('week_start', weekStart),
      // 3. Coverage requests this week
      db.from('coverage_requests').select('id, created_at, covered_at, status').eq('group_id', groupId).gte('created_at', weekStart),
      // 4. Payroll total
      db.from('payroll_records').select('total_gross_pay').eq('group_id', groupId).eq('week_start', weekStart),
      // 5. Revenue
      db.from('weekly_revenue').select('revenue, labor_percent').eq('group_id', groupId).eq('week_start', weekStart).maybeSingle(),
      // 6. Quality score (latest)
      db.from('weekly_quality_scores').select('score, grade, week_start').eq('group_id', groupId).order('week_start', { ascending: false }).limit(1),
      // 7. Unconfirmed receipts
      db.from('schedule_receipts').select('id', { count: 'exact', head: true }).eq('group_id', groupId).eq('week_start', weekStart).is('confirmed_at', null),
    ])

    const staffCount = staffRes.count || 0
    const shiftsThisWeek = assignRes.count || 0

    const coverageList = coverageRes.data || []
    const coverageRequests = coverageList.length
    let avgFillMinutes = null
    const filled = coverageList.filter(c => c.covered_at && c.created_at)
    if (filled.length > 0) {
      const totalMin = filled.reduce((sum, c) => {
        return sum + (new Date(c.covered_at) - new Date(c.created_at)) / 60000
      }, 0)
      avgFillMinutes = Math.round(totalMin / filled.length)
    }

    const payrollRows = payrollRes.data || []
    const laborCost = payrollRows.reduce((sum, r) => sum + (parseFloat(r.total_gross_pay) || 0), 0)

    const revenue = revenueRes.data?.revenue ? parseFloat(revenueRes.data.revenue) : null
    const laborPercent = revenue ? Math.round((laborCost / revenue) * 100) : null

    const qualityRow = qualityRes.data?.[0] || null
    const unconfirmedCount = receiptsRes.count || 0

    res.json({
      restaurantName: req.manager.restaurantName,
      weekStart,
      staffCount,
      shiftsThisWeek,
      coverageRequests,
      avgFillMinutes,
      laborCost: Math.round(laborCost * 100) / 100,
      qualityScore: qualityRow?.score ?? null,
      qualityGrade: qualityRow?.grade ?? null,
    })
  } catch (err) {
    console.error('overview error:', err.message)
    res.status(500).json({ error: 'Failed to load overview' })
  }
})

// GET /api/dashboard/schedule
router.get('/schedule', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const [assignRes, staffRes, shiftRes] = await Promise.all([
      db.from('schedule_assignments').select('*').eq('group_id', groupId).eq('week_start', weekStart),
      db.from('staff').select('*').eq('group_id', groupId),
      db.from('shifts').select('*').eq('group_id', groupId),
    ])

    const assignments = assignRes.data || []
    const staffList = staffRes.data || []
    const shifts = shiftRes.data || []

    const staffMap = Object.fromEntries(staffList.map(s => [s.id, s]))
    const shiftMap = Object.fromEntries(shifts.map(s => [s.id, s]))

    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    // Group assignments by staff
    const byStaff = {}
    for (const a of assignments) {
      const staff = staffMap[a.staff_id]
      const shift = shiftMap[a.shift_id]
      if (!staff || !shift) continue

      if (!byStaff[a.staff_id]) {
        byStaff[a.staff_id] = {
          staffId: a.staff_id,
          staffName: staff.name,
          roleName: staff.role,
          shifts: {},
          totalHours: 0,
        }
      }

      const day = shift.day_of_week
      const hours = parseShiftHours(shift.start_time, shift.end_time)

      if (!byStaff[a.staff_id].shifts[day]) {
        byStaff[a.staff_id].shifts[day] = []
      }
      byStaff[a.staff_id].shifts[day].push({
        shiftName: shift.name,
        startTime: shift.start_time,
        endTime: shift.end_time,
      })
      byStaff[a.staff_id].totalHours += hours
    }

    // Round hours
    const staffResult = Object.values(byStaff).map(s => ({
      ...s,
      totalHours: Math.round(s.totalHours * 10) / 10,
    }))

    res.json({ weekStart, days: DAYS, staff: staffResult })
  } catch (err) {
    console.error('schedule error:', err.message)
    res.status(500).json({ error: 'Failed to load schedule' })
  }
})

// GET /api/dashboard/activity
router.get('/activity', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [coverageRes, logRes, reliabilityRes, tipRes, recognitionRes] = await Promise.all([
      db.from('coverage_requests').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(20),
      db.from('manager_log_entries').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(20),
      db.from('staff_reliability_events').select('*, staff!inner(name)').eq('group_id', groupId).gte('recorded_at', sevenDaysAgo).eq('event_type', 'late').order('recorded_at', { ascending: false }).limit(10),
      db.from('tip_records').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(10),
      db.from('recognition_events').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(10),
    ])

    const events = []

    for (const c of (coverageRes.data || [])) {
      if (c.status === 'covered') {
        const fillMin = c.covered_at && c.created_at ? Math.round((new Date(c.covered_at) - new Date(c.created_at)) / 60000) : null
        events.push({
          type: 'coverage_filled',
          text: `${c.covered_by} covered ${c.requested_by}'s ${c.shift_description}${fillMin ? ` (${fillMin}min)` : ''}`,
          timestamp: c.covered_at || c.created_at,
          severity: 'success',
        })
      } else if (c.status === 'open') {
        events.push({
          type: 'callout',
          text: `${c.requested_by} needs ${c.shift_description} covered`,
          timestamp: c.created_at,
          severity: 'warning',
        })
      }
    }

    for (const l of (logRes.data || [])) {
      events.push({
        type: 'log',
        text: l.entry_text,
        timestamp: l.created_at,
        severity: 'info',
      })
    }

    for (const r of (reliabilityRes.data || [])) {
      const name = r.staff?.name || 'Staff'
      const minutes = r.metadata?.minutes_late || '?'
      events.push({
        type: 'late',
        text: `${name} was ${minutes}min late`,
        timestamp: r.recorded_at,
        severity: 'warning',
      })
    }

    for (const t of (tipRes.data || [])) {
      events.push({
        type: 'tips',
        text: `Tips recorded: $${parseFloat(t.total_tips || t.amount || 0).toFixed(2)}`,
        timestamp: t.created_at,
        severity: 'info',
      })
    }

    for (const r of (recognitionRes.data || [])) {
      events.push({
        type: 'recognition',
        text: r.original_text || `${r.recipient_name || 'Staff'} recognized`,
        timestamp: r.created_at,
        severity: 'success',
      })
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

    res.json({ events: events.slice(0, 20) })
  } catch (err) {
    console.error('activity error:', err.message)
    // Return empty on error — some tables may not exist yet
    res.json({ events: [] })
  }
})

// GET /api/dashboard/intelligence
router.get('/intelligence', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const [qualityRes, demandRes] = await Promise.all([
      // Quality trend (last 4 weeks)
      db.from('weekly_quality_scores').select('week_start, score, grade').eq('group_id', groupId).order('week_start', { ascending: false }).limit(4),
      // Demand signals for current/next week
      db.from('demand_signals').select('day_of_week, signal_type, raw_mention').eq('group_id', groupId).eq('week_start', weekStart),
    ])

    const qualityTrend = (qualityRes.data || []).reverse().map(r => ({
      weekStart: r.week_start,
      score: r.score,
      grade: r.grade,
    }))

    const demandSignals = (demandRes.data || []).map(d => ({
      dayOfWeek: d.day_of_week,
      type: d.signal_type,
      rawMention: d.raw_mention,
    }))

    // Build insights array for the frontend
    const insights = []

    if (qualityTrend.length > 0) {
      const latest = qualityTrend[qualityTrend.length - 1]
      if (latest.grade === 'A' || latest.grade === 'A+') {
        insights.push({ type: 'good', text: `Schedule quality: ${latest.grade} (${latest.score}/100)` })
      } else if (latest.grade === 'B' || latest.grade === 'B+') {
        insights.push({ type: 'info', text: `Schedule quality: ${latest.grade} (${latest.score}/100)` })
      } else {
        insights.push({ type: 'warning', text: `Schedule quality: ${latest.grade} (${latest.score}/100) — needs attention` })
      }
    }

    for (const d of demandSignals) {
      if (d.type === 'high') {
        insights.push({ type: 'warning', text: `High demand expected ${d.dayOfWeek}: "${d.rawMention}"` })
      } else if (d.type === 'low') {
        insights.push({ type: 'info', text: `Low demand expected ${d.dayOfWeek}: "${d.rawMention}"` })
      }
    }

    if (insights.length === 0) {
      insights.push({ type: 'good', text: 'Everything looks good this week' })
    }

    res.json({ qualityTrend, demandSignals, insights })
  } catch (err) {
    console.error('intelligence error:', err.message)
    res.json({ qualityTrend: [], demandSignals: [], insights: [{ type: 'good', text: 'Everything looks good this week' }] })
  }
})

// Helper: format money
function formatMoney(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

// Helper: safe bot send
async function safeSend(bot, chatId, text) {
  try {
    if (bot && chatId) await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
  } catch (e) { console.warn('safeSend failed:', e.message) }
}

// Helper: fetch manager DM and group chat IDs
async function getSessionChats(db, groupId) {
  const { data: sess } = await db.from('setup_sessions').select('dm_chat_id, group_id').eq('group_id', groupId).single()
  return {
    managerDm: sess?.dm_chat_id,
    groupChat: sess?.group_id,
  }
}

// ─── STAFF ROUTES ────────────────────────────────────────────────────────────

// GET /api/staff
router.get('/staff', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const { data: staffList, error } = await db
      .from('staff')
      .select('id, name, role, active, created_at')
      .eq('group_id', groupId)
      .or('active.is.null,active.eq.true')
      .order('name', { ascending: true })
    if (error) throw error
    // registered status is complex to derive without user_id on staff; return false for all
    const result = (staffList || []).map(s => ({ ...s, registered: false }))
    res.json(result)
  } catch (err) {
    console.error('GET /staff error:', err.message)
    res.status(500).json({ error: 'Failed to load staff' })
  }
})

// POST /api/staff
router.post('/staff', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { name, role } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!role) return res.status(400).json({ error: 'name and role are required' })
    const db = supabase()
    const { data, error } = await db
      .from('staff')
      .insert({ group_id: groupId, name, role })
      .select()
      .single()
    if (error) throw error
    res.status(201).json(data)
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ ${name} (${role}) added via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /staff error:', err.message)
    res.status(500).json({ error: 'Failed to add staff' })
  }
})

// PATCH /api/staff/:id
router.patch('/staff/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: existing, error: findErr } = await db
      .from('staff')
      .select('id, name')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !existing) return res.status(404).json({ error: 'Staff not found' })
    const updates = {}
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.role !== undefined) updates.role = req.body.role
    const { data, error } = await db
      .from('staff')
      .update(updates)
      .eq('id', id)
      .eq('group_id', groupId)
      .select()
      .single()
    if (error) throw error
    res.json(data)
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ ${data.name}'s profile updated via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('PATCH /staff/:id error:', err.message)
    res.status(500).json({ error: 'Failed to update staff' })
  }
})

// DELETE /api/staff/:id
router.delete('/staff/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: existing, error: findErr } = await db
      .from('staff')
      .select('id, name')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !existing) return res.status(404).json({ error: 'Staff not found' })
    const name = existing.name
    const { error: staffErr } = await db.from('staff').update({ active: false }).eq('id', id).eq('group_id', groupId)
    if (staffErr) throw staffErr
    const weekStart = getCurrentWeekStart()
    // best-effort: cancel future assignments
    await db
      .from('schedule_assignments')
      .update({ status: 'cancelled' })
      .eq('staff_id', id)
      .eq('group_id', groupId)
      .gte('week_start', weekStart)
    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm, groupChat }) =>
      Promise.all([
        safeSend(bot, managerDm, `${name} removed from Relay via dashboard. 👋`),
        safeSend(bot, groupChat, `${name} has left the team. 👋`),
      ])
    ).catch(() => {})
  } catch (err) {
    console.error('DELETE /staff/:id error:', err.message)
    res.status(500).json({ error: 'Failed to remove staff' })
  }
})

// GET /api/staff/:id/stats
router.get('/staff/:id/stats', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: staffRow, error: findErr } = await db
      .from('staff')
      .select('id, name')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !staffRow) return res.status(404).json({ error: 'Staff not found' })

    const [assignRes, coverageRes, payRes] = await Promise.all([
      db.from('schedule_assignments').select('id', { count: 'exact', head: true }).eq('staff_id', id).eq('group_id', groupId),
      db.from('coverage_requests').select('id', { count: 'exact', head: true }).eq('requested_by', staffRow.name).eq('group_id', groupId),
      db.from('payroll_records')
        .select('week_start, total_gross_pay, total_hours')
        .eq('staff_id', id)
        .eq('group_id', groupId)
        .order('week_start', { ascending: false })
        .limit(4),
    ])

    const totalShifts = assignRes.count || 0
    const callouts = coverageRes.count || 0
    const reliabilityScore = totalShifts > 0 ? Math.round((totalShifts - callouts) / totalShifts * 100) : 100
    const payHistory = payRes.data || []
    res.json({ totalShifts, callouts, reliabilityScore, payHistory })
  } catch (err) {
    console.error('GET /staff/:id/stats error:', err.message)
    res.status(500).json({ error: 'Failed to load staff stats' })
  }
})

// ─── SHIFT ROUTES ────────────────────────────────────────────────────────────

// GET /api/shifts
router.get('/shifts', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const { data, error } = await db
      .from('shifts')
      .select('*')
      .eq('group_id', groupId)
      .order('day_of_week', { ascending: true })
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /shifts error:', err.message)
    res.status(500).json({ error: 'Failed to load shifts' })
  }
})

// POST /api/shifts
router.post('/shifts', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { name, day_of_week, start_time, end_time } = req.body
    if (!name || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ error: 'name, day_of_week, start_time, and end_time are required' })
    }
    const db = supabase()
    const { data, error } = await db
      .from('shifts')
      .insert({ group_id: groupId, name, day_of_week, start_time, end_time })
      .select()
      .single()
    if (error) throw error
    res.status(201).json(data)
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ New shift added: ${name} (${day_of_week}, ${start_time}–${end_time})`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /shifts error:', err.message)
    res.status(500).json({ error: 'Failed to add shift' })
  }
})

// PATCH /api/shifts/:id
router.patch('/shifts/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: existing, error: findErr } = await db
      .from('shifts')
      .select('id, name')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !existing) return res.status(404).json({ error: 'Shift not found' })
    const updates = {}
    if (req.body.name !== undefined) updates.name = req.body.name
    if (req.body.day_of_week !== undefined) updates.day_of_week = req.body.day_of_week
    if (req.body.start_time !== undefined) updates.start_time = req.body.start_time
    if (req.body.end_time !== undefined) updates.end_time = req.body.end_time
    const { data, error } = await db
      .from('shifts')
      .update(updates)
      .eq('id', id)
      .eq('group_id', groupId)
      .select()
      .single()
    if (error) throw error
    res.json(data)
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ ${data.name} updated via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('PATCH /shifts/:id error:', err.message)
    res.status(500).json({ error: 'Failed to update shift' })
  }
})

// DELETE /api/shifts/:id
router.delete('/shifts/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: existing, error: findErr } = await db
      .from('shifts')
      .select('id, name')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !existing) return res.status(404).json({ error: 'Shift not found' })
    // Check active assignments
    const { count } = await db
      .from('schedule_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('shift_id', id)
      .eq('group_id', groupId)
      .gte('week_start', getCurrentWeekStart())
    if (count > 0 && !req.body.force) {
      return res.status(409).json({ error: 'Shift has active assignments', assignmentCount: count, canForce: true })
    }
    const { error } = await db.from('shifts').delete().eq('id', id).eq('group_id', groupId)
    if (error) throw error
    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `Shift ${existing.name} removed via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('DELETE /shifts/:id error:', err.message)
    res.status(500).json({ error: 'Failed to delete shift' })
  }
})

// ─── SCHEDULE ROUTES ──────────────────────────────────────────────────────────

// GET /api/schedule
router.get('/schedule-list', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const [assignRes, staffRes, shiftRes] = await Promise.all([
      db.from('schedule_assignments').select('*').eq('group_id', groupId).eq('week_start', weekStart),
      db.from('staff').select('*').eq('group_id', groupId),
      db.from('shifts').select('*').eq('group_id', groupId),
    ])

    const assignments = assignRes.data || []
    const staffList = staffRes.data || []
    const shifts = shiftRes.data || []

    const staffMap = Object.fromEntries(staffList.map(s => [s.id, s]))
    const shiftMap = Object.fromEntries(shifts.map(s => [s.id, s]))

    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    const byStaff = {}
    for (const a of assignments) {
      const staff = staffMap[a.staff_id]
      const shift = shiftMap[a.shift_id]
      if (!staff || !shift) continue
      if (!byStaff[a.staff_id]) {
        byStaff[a.staff_id] = {
          staffId: a.staff_id,
          staffName: staff.name,
          roleName: staff.role,
          shifts: {},
          totalHours: 0,
        }
      }
      const day = shift.day_of_week
      const hours = parseShiftHours(shift.start_time, shift.end_time)
      if (!byStaff[a.staff_id].shifts[day]) byStaff[a.staff_id].shifts[day] = []
      byStaff[a.staff_id].shifts[day].push({
        shiftName: shift.name,
        startTime: shift.start_time,
        endTime: shift.end_time,
      })
      byStaff[a.staff_id].totalHours += hours
    }

    const staffResult = Object.values(byStaff).map(s => ({
      ...s,
      totalHours: Math.round(s.totalHours * 10) / 10,
    }))

    res.json({ weekStart, days: DAYS, staff: staffResult })
  } catch (err) {
    console.error('GET /schedule-list error:', err.message)
    res.status(500).json({ error: 'Failed to load schedule' })
  }
})

// POST /api/schedule/assign
router.post('/schedule/assign', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { staffId, shiftId, weekStart } = req.body
    if (!staffId || !shiftId || !weekStart) {
      return res.status(400).json({ error: 'staffId, shiftId, and weekStart are required' })
    }

    // B3: reject past weekStart (>= 7 days before today)
    const weekStartDate = new Date(weekStart)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    sevenDaysAgo.setHours(0, 0, 0, 0)
    if (weekStartDate < sevenDaysAgo) {
      return res.status(409).json({ error: 'weekStart is in the past; use /api/timeclock/override for historical corrections' })
    }

    const db = supabase()
    const [staffCheck, shiftCheck] = await Promise.all([
      db.from('staff').select('id, name, role, cross_training').eq('id', staffId).eq('group_id', groupId).single(),
      db.from('shifts').select('id, name').eq('id', shiftId).eq('group_id', groupId).single(),
    ])
    if (!staffCheck.data) return res.status(404).json({ error: 'Staff not found' })
    if (!shiftCheck.data) return res.status(404).json({ error: 'Shift not found' })

    // B2: role mismatch check
    const { data: requirements } = await db
      .from('shift_requirements')
      .select('role, count')
      .eq('shift_id', shiftId)
    if (requirements && requirements.length > 0) {
      const requiredRoles = [...new Set(requirements.map(r => r.role))]
      const staffRole = staffCheck.data.role
      const crossTraining = staffCheck.data.cross_training || []
      const roleMatch = requiredRoles.includes(staffRole) ||
        crossTraining.some(ct => requiredRoles.includes(ct))
      if (!roleMatch) {
        return res.status(409).json({
          error: `Role mismatch: ${staffRole} cannot fill ${shiftCheck.data.name} (requires: ${requiredRoles.join(', ')})`,
        })
      }
    }

    // B4: duplicate check
    const { data: existing } = await db
      .from('schedule_assignments')
      .select('id')
      .eq('group_id', groupId)
      .eq('staff_id', staffId)
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (existing) {
      return res.status(409).json({ error: 'Already assigned' })
    }

    const { error } = await db
      .from('schedule_assignments')
      .insert({ group_id: groupId, staff_id: staffId, shift_id: shiftId, week_start: weekStart, status: 'assigned' })
    if (error) throw error

    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ ${staffCheck.data.name} added to ${shiftCheck.data.name} via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /schedule/assign error:', err.message)
    res.status(500).json({ error: 'Failed to assign schedule' })
  }
})

// DELETE /api/schedule/assign
router.delete('/schedule/assign', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { staffId, shiftId, weekStart } = req.body
    if (!staffId || !shiftId || !weekStart) {
      return res.status(400).json({ error: 'staffId, shiftId, and weekStart are required' })
    }
    const db = supabase()
    const [staffCheck, shiftCheck] = await Promise.all([
      db.from('staff').select('id, name').eq('id', staffId).eq('group_id', groupId).single(),
      db.from('shifts').select('id, name').eq('id', shiftId).eq('group_id', groupId).single(),
    ])
    const staffName = staffCheck.data?.name || 'Staff'
    const shiftName = shiftCheck.data?.name || 'shift'

    const { error } = await db
      .from('schedule_assignments')
      .delete()
      .eq('staff_id', staffId)
      .eq('shift_id', shiftId)
      .eq('week_start', weekStart)
      .eq('group_id', groupId)
    if (error) throw error

    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `${staffName} removed from ${shiftName} via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('DELETE /schedule/assign error:', err.message)
    res.status(500).json({ error: 'Failed to remove assignment' })
  }
})

// POST /api/schedule/generate
router.post('/schedule/generate', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { weekStart } = req.body
    if (!weekStart) return res.status(400).json({ error: 'weekStart is required' })
    const result = await generateWeeklySchedule(groupId, weekStart)

    // The generator writes a JSONB draft to generated_schedules, but the
    // dashboard /schedule view + the /schedule/approve route both read from
    // the schedule_assignments TABLE. Sync the generated assignments into
    // that table so everything downstream can see them.
    const db = supabase()
    await db.from('schedule_assignments').delete().eq('group_id', groupId).eq('week_start', weekStart)
    if (result.assignments?.length > 0) {
      const rows = result.assignments.map(a => ({
        group_id: groupId,
        shift_id: a.shiftId,
        staff_id: a.staffId,
        week_start: weekStart,
        status: 'scheduled',
      }))
      const { error: insErr } = await db.from('schedule_assignments').insert(rows)
      if (insErr) console.error('sync schedule_assignments error:', insErr.message)
    }

    res.json(result)
  } catch (err) {
    console.error('POST /schedule/generate error:', err.message)
    res.status(500).json({ error: 'Failed to generate schedule' })
  }
})

// POST /api/schedule/approve
router.post('/schedule/approve', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { weekStart } = req.body
    if (!weekStart) return res.status(400).json({ error: 'weekStart is required' })
    const db = supabase()

    const { count } = await db
      .from('schedule_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (!count || count === 0) {
      return res.status(400).json({ error: 'No assignments found for this week' })
    }

    const [assignRes, staffRes, shiftRes] = await Promise.all([
      db.from('schedule_assignments').select('*').eq('group_id', groupId).eq('week_start', weekStart),
      db.from('staff').select('*').eq('group_id', groupId),
      db.from('shifts').select('*').eq('group_id', groupId),
    ])

    const assignments = assignRes.data || []
    const staffMap = Object.fromEntries((staffRes.data || []).map(s => [s.id, s]))
    const shiftMap = Object.fromEntries((shiftRes.data || []).map(s => [s.id, s]))

    const byStaff = {}
    for (const a of assignments) {
      const staff = staffMap[a.staff_id]
      const shift = shiftMap[a.shift_id]
      if (!staff || !shift) continue
      if (!byStaff[a.staff_id]) byStaff[a.staff_id] = { name: staff.name, shiftLabels: [] }
      byStaff[a.staff_id].shiftLabels.push(`${shift.name} (${shift.day_of_week})`)
    }

    const lines = Object.values(byStaff)
      .map(s => `• *${s.name}*: ${s.shiftLabels.join(', ')}`)
      .join('\n')
    const scheduleText = `📅 *Schedule — Week of ${weekStart}*\n\n${lines}`

    const bot = req.app.locals.bot
    const { groupChat } = await getSessionChats(db, groupId)
    await safeSend(bot, groupChat, scheduleText)

    res.json({ success: true, staffNotified: Object.keys(byStaff).length })
  } catch (err) {
    console.error('POST /schedule/approve error:', err.message)
    res.status(500).json({ error: 'Failed to approve schedule' })
  }
})

// ─── PAYROLL ROUTES ───────────────────────────────────────────────────────────

// GET /api/payroll
router.get('/payroll', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const week = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const { data: records, error } = await db
      .from('payroll_records')
      .select('id, staff_id, week_start, total_hours, total_gross_pay, total_late_deduction, shift_breakdown, staff(name, role)')
      .eq('group_id', groupId)
      .eq('week_start', week)
      .order('staff(name)', { ascending: true })
    if (error) throw error

    const result = (records || []).map(r => ({
      id: r.id,
      staff_id: r.staff_id,
      week_start: r.week_start,
      total_hours: r.total_hours,
      total_gross_pay: r.total_gross_pay,
      total_late_deduction: r.total_late_deduction,
      shift_breakdown: r.shift_breakdown,
      name: r.staff?.name,
      role: r.staff?.role,
    }))

    res.json(result)
  } catch (err) {
    console.error('GET /payroll error:', err.message)
    res.status(500).json({ error: 'Failed to load payroll' })
  }
})

// POST /api/payroll/revenue
router.post('/payroll/revenue', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { weekStart, revenue } = req.body
    if (!weekStart || revenue === undefined) return res.status(400).json({ error: 'weekStart and revenue are required' })
    const revenueNum = parseFloat(revenue)
    if (isNaN(revenueNum) || revenueNum <= 0) return res.status(400).json({ error: 'revenue must be a positive number' })
    const db = supabase()

    const { data: payrollRows } = await db
      .from('payroll_records')
      .select('total_gross_pay')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    const totalPayroll = (payrollRows || []).reduce((sum, r) => sum + (parseFloat(r.total_gross_pay) || 0), 0)
    const laborPercent = totalPayroll > 0 && revenueNum > 0 ? (totalPayroll / revenueNum * 100).toFixed(1) : null

    const { error } = await db
      .from('weekly_revenue')
      .upsert(
        { group_id: groupId, week_start: weekStart, revenue: revenueNum, total_labor_cost: totalPayroll, labor_percent: laborPercent },
        { onConflict: 'group_id,week_start' }
      )
    if (error) throw error

    res.json({ revenue: revenueNum, laborPercent, totalPayroll })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `📊 Revenue logged via dashboard: ${formatMoney(revenueNum)}\nLabor cost: ${laborPercent}% of revenue`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /payroll/revenue error:', err.message)
    res.status(500).json({ error: 'Failed to log revenue' })
  }
})

// ─── DAILY REVENUE ────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().split('T')[0]
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().split('T')[0]
}

async function recalcWeeklyRevenue(db, groupId, weekStart) {
  const weekEnd = addDays(weekStart, 6)
  const { data: rows } = await db
    .from('daily_revenue')
    .select('amount')
    .eq('group_id', groupId)
    .gte('entry_date', weekStart)
    .lte('entry_date', weekEnd)
  const total = (rows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0)

  const { data: existing } = await db
    .from('weekly_revenue')
    .select('total_labor_cost')
    .eq('group_id', groupId)
    .eq('week_start', weekStart)
    .maybeSingle()

  const laborCost = existing?.total_labor_cost ?? null
  const laborPct = (laborCost != null && total > 0)
    ? Number(((laborCost / total) * 100).toFixed(2))
    : null

  await db
    .from('weekly_revenue')
    .upsert(
      { group_id: groupId, week_start: weekStart, revenue: total, total_labor_cost: laborCost, labor_percent: laborPct },
      { onConflict: 'group_id,week_start' }
    )

  return { total: Number(total.toFixed(2)), laborPercent: laborPct }
}

const ALLOWED_CATEGORIES = new Set(['lunch', 'dinner', 'brunch', 'breakfast', 'bar', 'catering', 'other'])

// GET /api/revenue/daily?weekStart=YYYY-MM-DD
router.get('/revenue/daily', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEnd = addDays(weekStart, 6)
    const db = supabase()

    const { data, error } = await db
      .from('daily_revenue')
      .select('id, entry_date, amount, note, category, created_at')
      .eq('group_id', groupId)
      .gte('entry_date', weekStart)
      .lte('entry_date', weekEnd)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) throw error

    const days = {}
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i)
      days[d] = { total: 0, entries: [], byCategory: {} }
    }
    for (const r of data ?? []) {
      const key = String(r.entry_date).slice(0, 10)
      if (!days[key]) days[key] = { total: 0, entries: [], byCategory: {} }
      const amt = Number(r.amount)
      const cat = r.category || 'other'
      days[key].total = Number((Number(days[key].total) + amt).toFixed(2))
      days[key].byCategory[cat] = Number(((days[key].byCategory[cat] || 0) + amt).toFixed(2))
      days[key].entries.push({
        id: r.id,
        amount: amt,
        note: r.note,
        category: cat,
        created_at: r.created_at,
      })
    }
    const weekTotal = Object.values(days).reduce((s, d) => s + Number(d.total), 0)

    res.json({ weekStart, weekEnd, days, weekTotal: Number(weekTotal.toFixed(2)) })
  } catch (err) {
    console.error('GET /revenue/daily error:', err.message)
    res.status(500).json({ error: 'Failed to load daily revenue' })
  }
})

// POST /api/revenue/daily  body: { date, amount, note?, category? }
router.post('/revenue/daily', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { date, amount, note, category } = req.body ?? {}
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' })
    }
    let cat = (category || 'other').toLowerCase()
    if (!ALLOWED_CATEGORIES.has(cat)) cat = 'other'
    const db = supabase()

    const { data: inserted, error } = await db
      .from('daily_revenue')
      .insert({ group_id: groupId, entry_date: date, amount: amt, note: note || null, category: cat })
      .select()
      .single()
    if (error) throw error

    const weekStart = mondayOf(date)
    const { total } = await recalcWeeklyRevenue(db, groupId, weekStart)

    res.status(201).json({ entry: inserted, dayTotal: total })
  } catch (err) {
    console.error('POST /revenue/daily error:', err.message)
    res.status(500).json({ error: 'Failed to save revenue entry' })
  }
})

// DELETE /api/revenue/daily/:id
router.delete('/revenue/daily/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const db = supabase()

    const { data: found, error: fErr } = await db
      .from('daily_revenue')
      .select('id, entry_date')
      .eq('id', id)
      .eq('group_id', groupId)
      .maybeSingle()
    if (fErr) throw fErr
    if (!found) return res.status(404).json({ error: 'Entry not found' })

    const { error } = await db.from('daily_revenue').delete().eq('id', id).eq('group_id', groupId)
    if (error) throw error

    const weekStart = mondayOf(found.entry_date)
    await recalcWeeklyRevenue(db, groupId, weekStart)

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /revenue/daily/:id error:', err.message)
    res.status(500).json({ error: 'Failed to delete revenue entry' })
  }
})

// GET /api/payroll/spreadsheet
router.get('/payroll/spreadsheet', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const week = req.query.week || getCurrentWeekStart()
    const db = supabase()

    const { data: records, error } = await db
      .from('payroll_records')
      .select('staff_id, total_hours, total_gross_pay, staff(name, role)')
      .eq('group_id', groupId)
      .eq('week_start', week)
    if (error) throw error

    const rows = (records || []).map(r => {
      const name = r.staff?.name || ''
      const role = r.staff?.role || ''
      const hours = parseFloat(r.total_hours || 0).toFixed(2)
      const pay = parseFloat(r.total_gross_pay || 0).toFixed(2)
      return `"${name}","${role}",${hours},${pay}`
    })

    const csv = ['Name,Role,Hours,Gross Pay', ...rows].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${week}.csv"`)
    res.send(csv)
  } catch (err) {
    console.error('GET /payroll/spreadsheet error:', err.message)
    res.status(500).json({ error: 'Failed to export payroll' })
  }
})

// PATCH /api/payroll/:staffId/rate
router.patch('/payroll/:staffId/rate', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { staffId } = req.params
    const { rate } = req.body
    if (typeof rate !== 'number' || rate <= 0) {
      return res.status(400).json({ error: 'rate must be a positive number' })
    }
    const db = supabase()

    // Verify staff belongs to group
    const { data: staffRow, error: staffErr } = await db
      .from('staff')
      .select('id, role')
      .eq('id', staffId)
      .eq('group_id', groupId)
      .single()
    if (staffErr || !staffRow) return res.status(404).json({ error: 'Staff not found' })

    // Update role_rates
    const { error: rateErr } = await db
      .from('role_rates')
      .upsert(
        { group_id: groupId, role_name: staffRow.role, hourly_rate: rate },
        { onConflict: 'group_id,role_name' }
      )
    if (rateErr) throw rateErr

    // Wire retroactive payroll recompute (Track A — retroFix.js may be built concurrently)
    let recomputed = []
    try {
      const { recomputeAllWeeksForStaff } = await import('../payroll/retroFix.js')
      recomputed = await recomputeAllWeeksForStaff(staffId, groupId, db)
    } catch (importErr) {
      // retroFix.js not yet available — skip silently
      console.warn('retroFix not available:', importErr.message)
    }

    // A.05: warn (but do not reject) if rate is unusually high
    const responseBody = { staffId, rate, recomputed }
    if (rate > 150) responseBody.warning = 'Rate unusually high — please verify'
    res.json(responseBody)
  } catch (err) {
    console.error('PATCH /payroll/:staffId/rate error:', err.message)
    res.status(500).json({ error: 'Failed to update rate' })
  }
})

// ─── TIPS ROUTES ──────────────────────────────────────────────────────────────

// GET /api/tips
router.get('/tips', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weeks = Math.min(parseInt(req.query.weeks) || 4, 52)
    const db = supabase()
    const { data, error } = await db
      .from('tip_records')
      .select('*')
      .eq('group_id', groupId)
      .order('shift_date', { ascending: false })
      .limit(weeks * 7)
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /tips error:', err.message)
    res.status(500).json({ error: 'Failed to load tips' })
  }
})

// POST /api/tips
router.post('/tips', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { shiftDate, totalTips, splitMethod } = req.body
    if (!shiftDate || totalTips === undefined) return res.status(400).json({ error: 'shiftDate and totalTips are required' })
    const totalTipsNum = parseFloat(totalTips)
    const db = supabase()

    const { data: staffList } = await db
      .from('staff')
      .select('id, name')
      .eq('group_id', groupId)
      .or('active.is.null,active.eq.true')
    const staff = (staffList || []).map(s => ({ name: s.name, hours: 1 }))
    const method = splitMethod || 'equal'
    const splits = calculateTipSplit(totalTipsNum, staff, method)

    const { data, error } = await db
      .from('tip_records')
      .insert({
        group_id: groupId,
        shift_date: shiftDate,
        total_tips: totalTipsNum,
        split_method: method,
        splits: splits,
        mode: 'pool',
      })
      .select()
      .single()
    if (error) throw error

    res.status(201).json({ splits, total: totalTipsNum })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `💰 Tips logged via dashboard: ${formatMoney(totalTipsNum)} for ${shiftDate}`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /tips error:', err.message)
    res.status(500).json({ error: 'Failed to log tips' })
  }
})

// ─── SETTINGS ROUTES ──────────────────────────────────────────────────────────

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()

    const [sessionRes, budgetRes, overtimeRes] = await Promise.all([
      db.from('setup_sessions').select('group_name, setup_data').eq('group_id', groupId).single(),
      db.from('labor_budgets').select('weekly_budget').eq('group_id', groupId).maybeSingle(),
      db.from('overtime_settings').select('weekly_threshold, weekly_multiplier').eq('group_id', groupId).maybeSingle(),
    ])

    const session = sessionRes.data
    const budget = budgetRes.data
    const overtime = overtimeRes.data

    res.json({
      restaurantName: session?.group_name,
      tipMode: session?.setup_data?.tipMode,
      overtimeThreshold: overtime?.weekly_threshold,
      overtimeMultiplier: session?.setup_data?.overtimeMultiplier || overtime?.weekly_multiplier,
      weeklyBudget: budget?.weekly_budget,
    })
  } catch (err) {
    console.error('GET /settings error:', err.message)
    res.status(500).json({ error: 'Failed to load settings' })
  }
})

// PATCH /api/settings
router.patch('/settings', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { tipMode, overtimeThreshold, overtimeMultiplier, weeklyBudget, restaurantName } = req.body
    if (!tipMode && overtimeThreshold === undefined && overtimeMultiplier === undefined && weeklyBudget === undefined && !restaurantName) {
      return res.status(400).json({ error: 'At least one setting field is required' })
    }
    const db = supabase()

    const updates = []
    if (restaurantName) {
      updates.push(db.from('setup_sessions').update({ group_name: restaurantName }).eq('group_id', groupId))
    }
    if (tipMode !== undefined || overtimeMultiplier !== undefined) {
      const patch = {}
      if (tipMode !== undefined) patch.tipMode = tipMode
      if (overtimeMultiplier !== undefined) patch.overtimeMultiplier = overtimeMultiplier
      updates.push(
        db.rpc('jsonb_merge_setup_data', { p_group_id: groupId, p_patch: patch })
          .then(() => {})
          .catch(async () => {
            // Fallback: fetch and merge manually
            const { data: sess } = await db.from('setup_sessions').select('setup_data').eq('group_id', groupId).single()
            const merged = { ...(sess?.setup_data || {}), ...patch }
            return db.from('setup_sessions').update({ setup_data: merged }).eq('group_id', groupId)
          })
      )
    }
    if (overtimeThreshold !== undefined) {
      updates.push(
        db.from('overtime_settings')
          .upsert({ group_id: groupId, weekly_threshold: overtimeThreshold }, { onConflict: 'group_id' })
      )
    }
    if (weeklyBudget !== undefined) {
      updates.push(
        db.from('labor_budgets')
          .upsert({ group_id: groupId, weekly_budget: weeklyBudget }, { onConflict: 'group_id' })
      )
    }

    await Promise.all(updates)

    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `⚙️ Restaurant settings updated via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('PATCH /settings error:', err.message)
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

// ─── RULES ROUTES ─────────────────────────────────────────────────────────────

// GET /api/rules
router.get('/rules', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const { data, error } = await db
      .from('business_rules')
      .select('*, staff!business_rules_subject_staff_id_fkey(name), staff!business_rules_object_staff_id_fkey(name)')
      .eq('group_id', groupId)
      .or('active.is.null,active.eq.true')
      .order('created_at', { ascending: false })
    if (error) throw error

    // Supabase join aliases may vary; normalize the result
    const rules = (data || []).map(r => ({
      ...r,
      subject_name: r['staff!business_rules_subject_staff_id_fkey']?.name || null,
      object_name: r['staff!business_rules_object_staff_id_fkey']?.name || null,
    }))
    res.json(rules)
  } catch (err) {
    console.error('GET /rules error:', err.message)
    res.status(500).json({ error: 'Failed to load rules' })
  }
})

// POST /api/rules
router.post('/rules', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { type, constraintText, subjectStaffId, objectStaffId } = req.body
    if (!type || !constraintText) return res.status(400).json({ error: 'type and constraintText are required' })
    const db = supabase()
    // A.04: validate subjectStaffId exists before saving
    if (subjectStaffId != null) {
      const { data: subjectStaff, error: subjectErr } = await db
        .from('staff')
        .select('id')
        .eq('id', subjectStaffId)
        .eq('group_id', groupId)
        .single()
      if (subjectErr || !subjectStaff) return res.status(400).json({ error: 'Staff not found' })
    }
    const { data, error } = await db
      .from('business_rules')
      .insert({
        group_id: groupId,
        type,
        constraint_text: constraintText,
        subject_staff_id: subjectStaffId || null,
        object_staff_id: objectStaffId || null,
        active: true,
      })
      .select()
      .single()
    if (error) throw error
    res.status(201).json(data)
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `✅ New rule added via dashboard: ${constraintText}`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /rules error:', err.message)
    res.status(500).json({ error: 'Failed to add rule' })
  }
})

// DELETE /api/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { id } = req.params
    const db = supabase()
    const { data: existing, error: findErr } = await db
      .from('business_rules')
      .select('id')
      .eq('id', id)
      .eq('group_id', groupId)
      .single()
    if (findErr || !existing) return res.status(404).json({ error: 'Rule not found' })
    const { error } = await db
      .from('business_rules')
      .update({ active: false })
      .eq('id', id)
      .eq('group_id', groupId)
    if (error) throw error
    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ managerDm }) =>
      safeSend(bot, managerDm, `Rule removed via dashboard.`)
    ).catch(() => {})
  } catch (err) {
    console.error('DELETE /rules/:id error:', err.message)
    res.status(500).json({ error: 'Failed to delete rule' })
  }
})

// ─── COVERAGE ROUTES ──────────────────────────────────────────────────────────

// GET /api/coverage
router.get('/coverage', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const { data, error } = await db
      .from('coverage_requests')
      .select('*')
      .eq('group_id', groupId)
      .gte('created_at', new Date(Date.now() - 4 * 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /coverage error:', err.message)
    res.status(500).json({ error: 'Failed to load coverage requests' })
  }
})

// POST /api/coverage
router.post('/coverage', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { shiftId, reason } = req.body
    if (!shiftId) return res.status(400).json({ error: 'shiftId is required' })
    const db = supabase()

    const { data: shift, error: shiftErr } = await db
      .from('shifts')
      .select('*')
      .eq('id', shiftId)
      .eq('group_id', groupId)
      .single()
    if (shiftErr || !shift) return res.status(404).json({ error: 'Shift not found' })

    const shiftDesc = `${shift.name} ${shift.day_of_week} ${shift.start_time}-${shift.end_time}`
    const weekStart = getCurrentWeekStart()
    const { error } = await db.from('coverage_requests').insert({
      group_id: groupId,
      shift_description: shiftDesc,
      requested_by: 'Manager (Dashboard)',
      matched_shift_id: shiftId,
      week_start: weekStart,
      status: 'open',
    })
    if (error) throw error

    res.json({ success: true })
    // fire-and-forget notification
    const bot = req.app.locals.bot
    getSessionChats(db, groupId).then(({ groupChat }) =>
      safeSend(bot, groupChat, `📢 Coverage needed: ${shift.name} ${shift.day_of_week} ${shift.start_time}–${shift.end_time}`)
    ).catch(() => {})
  } catch (err) {
    console.error('POST /coverage error:', err.message)
    res.status(500).json({ error: 'Failed to create coverage request' })
  }
})

// ─── TIME CLOCK ROUTES ────────────────────────────────────────────────────────

// GET /api/timeclock
router.get('/timeclock', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const week = req.query.week || getCurrentWeekStart()
    const db = supabase()
    const { data, error } = await db
      .from('time_entries')
      .select('*, staff(name, role)')
      .eq('group_id', groupId)
      .gte('clock_in', week)
      .lt('clock_in', new Date(new Date(week).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('clock_in', { ascending: true })
    if (error) throw error

    const entries = (data || []).map(e => ({
      ...e,
      name: e.staff?.name,
      role: e.staff?.role,
    }))
    res.json(entries)
  } catch (err) {
    console.error('GET /timeclock error:', err.message)
    res.status(500).json({ error: 'Failed to load time clock entries' })
  }
})

// GET /api/timeclock/live
router.get('/timeclock/live', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()
    const { data, error } = await db
      .from('time_entries')
      .select('id, staff_id, clock_in, clock_out, staff(name, role)')
      .eq('group_id', groupId)
      .is('clock_out', null)
      .order('clock_in', { ascending: true })
    if (error) throw error

    const now = Date.now()
    const entries = (data || []).map(e => ({
      ...e,
      name: e.staff?.name,
      role: e.staff?.role,
      hoursSoFar: Math.round((now - new Date(e.clock_in).getTime()) / 3600000 * 100) / 100,
    }))
    res.json(entries)
  } catch (err) {
    console.error('GET /timeclock/live error:', err.message)
    res.status(500).json({ error: 'Failed to load live clock entries' })
  }
})

// POST /api/timeclock/override
router.post('/timeclock/override', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { staffId, action, time } = req.body
    if (!staffId || !action) return res.status(400).json({ error: 'staffId and action are required' })
    if (!['clock_out', 'clock_in', 'adjust'].includes(action)) {
      return res.status(400).json({ error: 'action must be clock_out, clock_in, or adjust' })
    }
    const db = supabase()

    const { data: staffRow, error: staffErr } = await db
      .from('staff')
      .select('id, name')
      .eq('id', staffId)
      .eq('group_id', groupId)
      .single()
    if (staffErr || !staffRow) return res.status(404).json({ error: 'Staff not found' })

    const staffName = staffRow.name
    const bot = req.app.locals.bot

    if (action === 'clock_out') {
      const result = await manualClockOut(staffId, groupId, time || new Date().toISOString(), db)
      res.json({ success: true, result })
      // fire-and-forget notification
      getSessionChats(db, groupId).then(({ managerDm }) =>
        safeSend(bot, managerDm, `⏰ Clock override: ${staffName} clocked out via dashboard.`)
      ).catch(() => {})
      return
    }

    if (action === 'clock_in') {
      const result = await manualClockIn(staffId, groupId, time || new Date().toISOString(), db)
      res.json({ success: true, result })
      // fire-and-forget notification
      getSessionChats(db, groupId).then(({ managerDm }) =>
        safeSend(bot, managerDm, `⏰ Clock override: ${staffName} clocked in via dashboard.`)
      ).catch(() => {})
      return
    }

    if (action === 'adjust') {
      let adjustedTime
      try {
        adjustedTime = time ? new Date(time).toISOString() : new Date().toISOString()
      } catch {
        return res.status(400).json({ error: 'Invalid time format — use ISO 8601' })
      }
      const { data: entry } = await db
        .from('time_entries')
        .select('id')
        .eq('staff_id', staffId)
        .eq('group_id', groupId)
        .is('clock_out', null)
        .order('clock_in', { ascending: false })
        .limit(1)
        .single()
      if (!entry) return res.status(404).json({ error: 'No open clock entry found' })
      await db.from('time_entries').update({ clock_out: adjustedTime }).eq('id', entry.id)
      res.json({ success: true })
      // fire-and-forget notification
      getSessionChats(db, groupId).then(({ managerDm }) =>
        safeSend(bot, managerDm, `⏰ Clock adjusted for ${staffName} via dashboard.`)
      ).catch(() => {})
      return
    }
  } catch (err) {
    console.error('POST /timeclock/override error:', err.message)
    res.status(500).json({ error: 'Failed to process clock override' })
  }
})

// ─── WEEKLY TIMECLOCK ─────────────────────────────────────────────────────────

// GET /api/timeclock/weekly?weekStart=YYYY-MM-DD
// Per-staff scheduled vs clocked hours + missed clock-outs + entry list.
router.get('/timeclock/weekly', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEnd = addDays(weekStart, 6)
    const weekEndExclusive = addDays(weekStart, 7)
    const db = supabase()

    const [staffRes, shiftsRes, assignRes, entriesRes] = await Promise.all([
      db.from('staff').select('id, name, role').eq('group_id', groupId).eq('active', true),
      db.from('shifts').select('id, name, start_time, end_time, day_of_week').eq('group_id', groupId),
      db.from('schedule_assignments').select('staff_id, shift_id').eq('group_id', groupId).eq('week_start', weekStart),
      db.from('time_entries').select('id, staff_id, shift_id, clock_in, clock_out')
        .eq('group_id', groupId)
        .gte('clock_in', `${weekStart}T00:00:00Z`)
        .lt('clock_in', `${weekEndExclusive}T00:00:00Z`),
    ])

    const shifts = shiftsRes.data ?? []
    const shiftMap = Object.fromEntries(shifts.map(s => [String(s.id), s]))
    const assignments = assignRes.data ?? []
    const entries = entriesRes.data ?? []

    const scheduledHoursByStaff = {}
    const shiftsByStaff = {}
    for (const a of assignments) {
      const sh = shiftMap[String(a.shift_id)]
      if (!sh) continue
      const hours = parseShiftHours(sh.start_time, sh.end_time)
      scheduledHoursByStaff[a.staff_id] = (scheduledHoursByStaff[a.staff_id] ?? 0) + hours
      shiftsByStaff[a.staff_id] = (shiftsByStaff[a.staff_id] ?? 0) + 1
    }

    const now = Date.now()
    const MISSED_THRESHOLD_MS = 12 * 60 * 60 * 1000

    const entriesByStaff = {}
    for (const e of entries) {
      const sid = e.staff_id
      if (!sid) continue
      if (!entriesByStaff[sid]) entriesByStaff[sid] = []
      const clockInMs = new Date(e.clock_in).getTime()
      const clockOutMs = e.clock_out ? new Date(e.clock_out).getTime() : null
      const hours = clockOutMs
        ? (clockOutMs - clockInMs) / 3600000
        : Math.min((now - clockInMs) / 3600000, 24)
      const missedClockOut = !e.clock_out && (now - clockInMs) > MISSED_THRESHOLD_MS
      entriesByStaff[sid].push({
        id: e.id,
        shiftId: e.shift_id,
        shiftName: shiftMap[String(e.shift_id)]?.name ?? null,
        clockIn: e.clock_in,
        clockOut: e.clock_out,
        hours: Number(hours.toFixed(2)),
        missedClockOut,
      })
    }

    const rows = (staffRes.data ?? []).map(s => {
      const hoursScheduled = Number((scheduledHoursByStaff[s.id] ?? 0).toFixed(2))
      const staffEntries = entriesByStaff[s.id] ?? []
      const hoursClocked = Number(staffEntries.reduce((sum, e) => sum + e.hours, 0).toFixed(2))
      const missedCount = staffEntries.filter(e => e.missedClockOut).length
      return {
        staffId: s.id,
        staffName: s.name,
        role: s.role,
        shiftsScheduled: shiftsByStaff[s.id] ?? 0,
        hoursScheduled,
        hoursClocked,
        variance: Number((hoursClocked - hoursScheduled).toFixed(2)),
        entries: staffEntries,
        missedClockOuts: missedCount,
      }
    }).sort((a, b) => a.staffName.localeCompare(b.staffName))

    res.json({ weekStart, weekEnd, rows })
  } catch (err) {
    console.error('GET /timeclock/weekly error:', err.message)
    res.status(500).json({ error: 'Failed to load weekly timeclock' })
  }
})

// ─── EVENT LOG ────────────────────────────────────────────────────────────────

// GET /api/events?weekStart=YYYY-MM-DD&limit=50
router.get('/events', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const weekStart = req.query.weekStart || getCurrentWeekStart()
    const weekEndExclusive = addDays(weekStart, 7)
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const db = supabase()

    const [coverageRes, tradeRes, payrollRes, staffRes] = await Promise.all([
      db.from('coverage_requests')
        .select('id, shift_description, requested_by, covered_by, status, created_at, covered_at')
        .eq('group_id', groupId)
        .gte('created_at', `${weekStart}T00:00:00Z`)
        .lt('created_at', `${weekEndExclusive}T00:00:00Z`)
        .order('created_at', { ascending: false }),
      db.from('trade_requests')
        .select('id, requester_name, accepted_by_name, shift_description, accepted_shift_description, status, created_at')
        .eq('group_id', groupId)
        .gte('created_at', `${weekStart}T00:00:00Z`)
        .lt('created_at', `${weekEndExclusive}T00:00:00Z`)
        .order('created_at', { ascending: false }),
      db.from('payroll_records')
        .select('staff_id, total_hours, total_gross_pay, week_start')
        .eq('group_id', groupId)
        .eq('week_start', weekStart),
      db.from('staff').select('id, name').eq('group_id', groupId),
    ])

    const staffMap = Object.fromEntries((staffRes.data ?? []).map(s => [String(s.id), s.name]))
    const events = []

    for (const c of coverageRes.data ?? []) {
      const fillMinutes = c.covered_at && c.created_at
        ? Math.round((new Date(c.covered_at) - new Date(c.created_at)) / 60000)
        : null
      events.push({
        eventType: 'coverage',
        timestamp: c.created_at,
        title: `${c.requested_by || 'Someone'} called out — ${c.shift_description}`,
        meta: c.status === 'covered'
          ? { status: 'covered', coveredBy: c.covered_by, fillMinutes }
          : { status: c.status },
      })
    }

    for (const t of tradeRes.data ?? []) {
      events.push({
        eventType: 'trade',
        timestamp: t.created_at,
        title: `Shift trade: ${t.requester_name}${t.accepted_by_name ? ` ↔ ${t.accepted_by_name}` : ' (open)'}`,
        meta: {
          status: t.status,
          from: t.shift_description,
          to: t.accepted_shift_description,
        },
      })
    }

    for (const p of payrollRes.data ?? []) {
      if (Number(p.total_hours) > 40) {
        events.push({
          eventType: 'overtime',
          timestamp: `${p.week_start}T00:00:00Z`,
          title: `${staffMap[String(p.staff_id)] || 'Unknown'} — overtime week`,
          meta: {
            totalHours: Number(p.total_hours),
            overtimeHours: Number((Number(p.total_hours) - 40).toFixed(2)),
            grossPay: Number(p.total_gross_pay),
          },
        })
      }
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

    res.json({ weekStart, events: events.slice(0, limit) })
  } catch (err) {
    console.error('GET /events error:', err.message)
    res.status(500).json({ error: 'Failed to load events' })
  }
})

// ─── FULL SETTINGS ────────────────────────────────────────────────────────────

// GET /api/settings/full — everything configurable in one call
router.get('/settings/full', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = supabase()

    const [sessionRes, staffRes, shiftsRes, ratesRes, overtimeRes, budgetRes, rulesRes] = await Promise.all([
      db.from('setup_sessions').select('group_id, group_name, setup_data').eq('group_id', groupId).single(),
      db.from('staff').select('id, name, role, active').eq('group_id', groupId).eq('active', true),
      db.from('shifts').select('*').eq('group_id', groupId),
      db.from('role_rates').select('role_name, hourly_rate').eq('group_id', groupId),
      db.from('overtime_settings').select('*').eq('group_id', groupId).maybeSingle(),
      db.from('labor_budgets').select('weekly_budget, currency').eq('group_id', groupId).maybeSingle(),
      db.from('business_rules').select('*').eq('group_id', groupId).or('active.is.null,active.eq.true'),
    ])

    const shiftIds = (shiftsRes.data ?? []).map(s => s.id)
    let requirements = []
    if (shiftIds.length > 0) {
      const { data } = await db.from('shift_requirements').select('*').in('shift_id', shiftIds)
      requirements = data ?? []
    }

    const session = sessionRes.data || {}
    const setupData = session.setup_data || {}

    res.json({
      restaurant: {
        groupId: session.group_id,
        name: session.group_name,
      },
      staff: (staffRes.data ?? []).map(s => ({ id: s.id, name: s.name, role: s.role })),
      shifts: (shiftsRes.data ?? []).map(s => ({
        id: s.id,
        name: s.name,
        dayOfWeek: s.day_of_week,
        startTime: s.start_time,
        endTime: s.end_time,
        requirements: requirements.filter(r => String(r.shift_id) === String(s.id))
          .map(r => ({ id: r.id, role: r.role, count: r.count })),
      })),
      rates: (ratesRes.data ?? []).map(r => ({ roleName: r.role_name, hourlyRate: Number(r.hourly_rate) })),
      overtime: overtimeRes.data || {
        overtime_enabled: false,
        weekly_threshold: 40,
        weekly_multiplier: 1.5,
        daily_overtime_enabled: false,
        daily_threshold: 8,
        daily_multiplier: 1.5,
      },
      tips: {
        mode: setupData.tipMode || 'pool',
        splitMethod: setupData.tipSplitMethod || 'hours',
        bohIncluded: setupData.tipBohIncluded ?? false,
      },
      budget: {
        weeklyBudget: budgetRes.data?.weekly_budget ?? null,
        currency: budgetRes.data?.currency || 'USD',
      },
      rules: rulesRes.data ?? [],
    })
  } catch (err) {
    console.error('GET /settings/full error:', err.message)
    res.status(500).json({ error: 'Failed to load full settings' })
  }
})

// PATCH /api/settings/full — update subsections independently
router.patch('/settings/full', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const body = req.body ?? {}
    const db = supabase()
    const errors = {}
    const updated = {}

    if (body.restaurant?.name !== undefined) {
      try {
        const { error } = await db.from('setup_sessions').update({ group_name: body.restaurant.name }).eq('group_id', groupId)
        if (error) throw error
        updated.restaurant = true
      } catch (e) { errors.restaurant = e.message }
    }

    if (body.overtime) {
      try {
        const ot = body.overtime
        const { error } = await db.from('overtime_settings').upsert({
          group_id: groupId,
          overtime_enabled: ot.overtime_enabled,
          weekly_threshold: ot.weekly_threshold,
          weekly_multiplier: ot.weekly_multiplier,
          daily_overtime_enabled: ot.daily_overtime_enabled,
          daily_threshold: ot.daily_threshold,
          daily_multiplier: ot.daily_multiplier,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id' })
        if (error) throw error
        updated.overtime = true
      } catch (e) { errors.overtime = e.message }
    }

    if (body.tips) {
      try {
        const { data: sess } = await db.from('setup_sessions').select('setup_data').eq('group_id', groupId).single()
        const merged = {
          ...(sess?.setup_data || {}),
          tipMode: body.tips.mode,
          tipSplitMethod: body.tips.splitMethod,
          tipBohIncluded: body.tips.bohIncluded,
        }
        const { error } = await db.from('setup_sessions').update({ setup_data: merged }).eq('group_id', groupId)
        if (error) throw error
        updated.tips = true
      } catch (e) { errors.tips = e.message }
    }

    if (body.budget?.weeklyBudget !== undefined) {
      try {
        const { error } = await db.from('labor_budgets').upsert({
          group_id: groupId,
          weekly_budget: Number(body.budget.weeklyBudget),
          currency: body.budget.currency || 'USD',
        }, { onConflict: 'group_id' })
        if (error) throw error
        updated.budget = true
      } catch (e) { errors.budget = e.message }
    }

    if (Object.keys(updated).length === 0 && Object.keys(errors).length === 0) {
      return res.status(400).json({ error: 'No updatable fields in body' })
    }
    res.json({ updated, errors: Object.keys(errors).length ? errors : undefined })
  } catch (err) {
    console.error('PATCH /settings/full error:', err.message)
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

// POST /api/rates — add/update a role rate (used by Settings pay-rates section)
router.post('/rates', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const { roleName, hourlyRate } = req.body ?? {}
    if (!roleName || typeof roleName !== 'string') return res.status(400).json({ error: 'roleName required' })
    const rate = Number(hourlyRate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 500) return res.status(400).json({ error: 'hourlyRate must be 0–500' })

    const db = supabase()
    const { data, error } = await db
      .from('role_rates')
      .upsert({ group_id: groupId, role_name: roleName, hourly_rate: rate, updated_at: new Date().toISOString() }, { onConflict: 'group_id,role_name' })
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('POST /rates error:', err.message)
    res.status(500).json({ error: 'Failed to save rate' })
  }
})

export default router
