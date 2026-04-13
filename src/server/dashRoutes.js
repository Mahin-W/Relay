import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from './middleware.js'

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
      stats: {
        staffCount,
        shiftsThisWeek,
        coverageRequests,
        avgFillMinutes,
        laborCost: Math.round(laborCost * 100) / 100,
        revenue,
        laborPercent,
        qualityScore: qualityRow?.score ?? null,
        qualityGrade: qualityRow?.grade ?? null,
        unconfirmedCount,
      }
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

export default router
