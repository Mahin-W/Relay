/**
 * ⚠️ TEMPORARY — Netlify Function replacement for src/server/dashRoutes.js
 * DELETE when you move to Railway/Render. The Express version is the real one.
 *
 * Handles: /api/dashboard/overview, /api/dashboard/schedule,
 *          /api/dashboard/activity, /api/dashboard/intelligence
 */

import { supabase, verifyAuth, json, getCurrentWeekStart, parseShiftHours } from './shared.js'

export async function handler(event) {
  const path = event.path.replace('/.netlify/functions/dashboard', '').replace('/api/dashboard', '')
  const method = event.httpMethod

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() }
  }

  // All routes require auth
  const manager = verifyAuth(event)
  if (!manager) return json(401, { error: 'Not authenticated' })

  const groupId = manager.groupId
  const params = event.queryStringParameters || {}
  const db = supabase()

  try {
    // GET /api/dashboard/overview
    if (path === '/overview') {
      const weekStart = params.week || getCurrentWeekStart()

      const [staffRes, assignRes, coverageRes, payrollRes, revenueRes, qualityRes, receiptsRes] = await Promise.all([
        db.from('staff').select('id', { count: 'exact', head: true }).eq('group_id', groupId),
        db.from('schedule_assignments').select('id', { count: 'exact', head: true }).eq('group_id', groupId).eq('week_start', weekStart),
        db.from('coverage_requests').select('id, created_at, covered_at, status').eq('group_id', groupId).gte('created_at', weekStart),
        db.from('payroll_records').select('total_gross_pay').eq('group_id', groupId).eq('week_start', weekStart),
        db.from('weekly_revenue').select('revenue, labor_percent').eq('group_id', groupId).eq('week_start', weekStart).maybeSingle(),
        db.from('weekly_quality_scores').select('score, grade, week_start').eq('group_id', groupId).order('week_start', { ascending: false }).limit(1),
        db.from('schedule_receipts').select('id', { count: 'exact', head: true }).eq('group_id', groupId).eq('week_start', weekStart).is('confirmed_at', null),
      ])

      const coverageList = coverageRes.data || []
      const filled = coverageList.filter(c => c.covered_at && c.created_at)
      let avgFillMinutes = null
      if (filled.length > 0) {
        const totalMin = filled.reduce((sum, c) => sum + (new Date(c.covered_at) - new Date(c.created_at)) / 60000, 0)
        avgFillMinutes = Math.round(totalMin / filled.length)
      }

      const payrollRows = payrollRes.data || []
      const laborCost = payrollRows.reduce((sum, r) => sum + (parseFloat(r.total_gross_pay) || 0), 0)
      const revenue = revenueRes.data?.revenue ? parseFloat(revenueRes.data.revenue) : null
      const qualityRow = qualityRes.data?.[0] || null

      return json(200, {
        restaurantName: manager.restaurantName,
        weekStart,
        stats: {
          staffCount: staffRes.count || 0,
          shiftsThisWeek: assignRes.count || 0,
          coverageRequests: coverageList.length,
          avgFillMinutes,
          laborCost: Math.round(laborCost * 100) / 100,
          revenue,
          laborPercent: revenue ? Math.round((laborCost / revenue) * 100) : null,
          qualityScore: qualityRow?.score ?? null,
          qualityGrade: qualityRow?.grade ?? null,
          unconfirmedCount: receiptsRes.count || 0,
        }
      })
    }

    // GET /api/dashboard/schedule
    if (path === '/schedule') {
      const weekStart = params.week || getCurrentWeekStart()

      const [assignRes, staffRes, shiftRes] = await Promise.all([
        db.from('schedule_assignments').select('*').eq('group_id', groupId).eq('week_start', weekStart),
        db.from('staff').select('*').eq('group_id', groupId),
        db.from('shifts').select('*').eq('group_id', groupId),
      ])

      const staffMap = Object.fromEntries((staffRes.data || []).map(s => [s.id, s]))
      const shiftMap = Object.fromEntries((shiftRes.data || []).map(s => [s.id, s]))
      const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

      const byStaff = {}
      for (const a of (assignRes.data || [])) {
        const staff = staffMap[a.staff_id]
        const shift = shiftMap[a.shift_id]
        if (!staff || !shift) continue

        if (!byStaff[a.staff_id]) {
          byStaff[a.staff_id] = { staffId: a.staff_id, staffName: staff.name, roleName: staff.role, shifts: {}, totalHours: 0 }
        }
        if (!byStaff[a.staff_id].shifts[shift.day_of_week]) {
          byStaff[a.staff_id].shifts[shift.day_of_week] = []
        }
        byStaff[a.staff_id].shifts[shift.day_of_week].push({
          shiftName: shift.name, startTime: shift.start_time, endTime: shift.end_time,
        })
        byStaff[a.staff_id].totalHours += parseShiftHours(shift.start_time, shift.end_time)
      }

      const staffResult = Object.values(byStaff).map(s => ({ ...s, totalHours: Math.round(s.totalHours * 10) / 10 }))
      return json(200, { weekStart, days: DAYS, staff: staffResult })
    }

    // GET /api/dashboard/activity
    if (path === '/activity') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const [coverageRes, logRes, reliabilityRes] = await Promise.all([
        db.from('coverage_requests').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(20),
        db.from('manager_log_entries').select('*').eq('group_id', groupId).gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(20),
        db.from('staff_reliability_events').select('*, staff(name)').eq('group_id', groupId).gte('recorded_at', sevenDaysAgo).eq('event_type', 'late').order('recorded_at', { ascending: false }).limit(10),
      ])

      const events = []

      for (const c of (coverageRes.data || [])) {
        if (c.status === 'covered') {
          const fillMin = c.covered_at && c.created_at ? Math.round((new Date(c.covered_at) - new Date(c.created_at)) / 60000) : null
          events.push({ type: 'coverage_filled', text: `${c.covered_by} covered ${c.requested_by}'s ${c.shift_description}${fillMin ? ` (${fillMin}min)` : ''}`, timestamp: c.covered_at || c.created_at, severity: 'success' })
        } else if (c.status === 'open') {
          events.push({ type: 'callout', text: `${c.requested_by} needs ${c.shift_description} covered`, timestamp: c.created_at, severity: 'warning' })
        }
      }

      for (const l of (logRes.data || [])) {
        events.push({ type: 'log', text: l.entry_text, timestamp: l.created_at, severity: 'info' })
      }

      for (const r of (reliabilityRes.data || [])) {
        events.push({ type: 'late', text: `${r.staff?.name || 'Staff'} was ${r.metadata?.minutes_late || '?'}min late`, timestamp: r.recorded_at, severity: 'warning' })
      }

      events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      return json(200, { events: events.slice(0, 20) })
    }

    // GET /api/dashboard/intelligence
    if (path === '/intelligence') {
      const weekStart = params.week || getCurrentWeekStart()

      const [qualityRes, demandRes] = await Promise.all([
        db.from('weekly_quality_scores').select('week_start, score, grade').eq('group_id', groupId).order('week_start', { ascending: false }).limit(4),
        db.from('demand_signals').select('day_of_week, signal_type, raw_mention').eq('group_id', groupId).eq('week_start', weekStart),
      ])

      const qualityTrend = (qualityRes.data || []).reverse().map(r => ({ weekStart: r.week_start, score: r.score, grade: r.grade }))
      const demandSignals = (demandRes.data || []).map(d => ({ dayOfWeek: d.day_of_week, type: d.signal_type, rawMention: d.raw_mention }))

      const insights = []
      if (qualityTrend.length > 0) {
        const latest = qualityTrend[qualityTrend.length - 1]
        const type = (latest.grade === 'A' || latest.grade === 'A+') ? 'good' : (latest.grade === 'B' || latest.grade === 'B+') ? 'info' : 'warning'
        insights.push({ type, text: `Schedule quality: ${latest.grade} (${latest.score}/100)${type === 'warning' ? ' — needs attention' : ''}` })
      }
      for (const d of demandSignals) {
        if (d.type === 'high') insights.push({ type: 'warning', text: `High demand expected ${d.dayOfWeek}: "${d.rawMention}"` })
        else if (d.type === 'low') insights.push({ type: 'info', text: `Low demand expected ${d.dayOfWeek}: "${d.rawMention}"` })
      }
      if (insights.length === 0) insights.push({ type: 'good', text: 'Everything looks good this week' })

      return json(200, { qualityTrend, demandSignals, insights })
    }

    return json(404, { error: 'Not found' })
  } catch (err) {
    console.error('dashboard function error:', err)
    return json(500, { error: 'Failed to load data' })
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  }
}
