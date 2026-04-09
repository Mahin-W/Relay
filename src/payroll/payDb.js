import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function savePeriodPayroll(groupId, weekStart, staffPaySummaries, db = null) {
  if (db?.savePeriodPayroll) return db.savePeriodPayroll(groupId, weekStart, staffPaySummaries)
  try {
    const rows = staffPaySummaries.map(s => ({
      group_id: groupId,
      staff_id: s.staffId,
      week_start: weekStart,
      total_hours: s.totalHours,
      total_late_minutes: s.totalLateMinutes,
      total_late_deduction: s.totalLateDeduction,
      total_gross_pay: s.totalGrossPay,
      shift_breakdown: s.shifts,
    }))
    const { error } = await supabase
      .from('payroll_records')
      .upsert(rows, { onConflict: 'staff_id,week_start,group_id' })
    if (error) throw error
    logger.db(`Payroll saved for ${rows.length} staff, week ${weekStart}`)
    return true
  } catch (err) {
    logger.error(`savePeriodPayroll failed: ${err.message}`)
    return false
  }
}

export async function getPayrollForWeek(groupId, weekStart, db = null) {
  if (db?.getPayrollForWeek) return db.getPayrollForWeek(groupId, weekStart)
  try {
    const { data, error } = await supabase
      .from('payroll_records')
      .select('*, staff(name, role)')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? null
  } catch (err) {
    logger.error(`getPayrollForWeek failed: ${err.message}`)
    return null
  }
}

export async function getPayrollHistory(staffId, groupId, weeksBack = 8, db = null) {
  if (db?.getPayrollHistory) return db.getPayrollHistory(staffId, groupId, weeksBack)
  try {
    const { data, error } = await supabase
      .from('payroll_records')
      .select('week_start, total_hours, total_gross_pay, total_late_minutes, total_late_deduction')
      .eq('staff_id', staffId)
      .eq('group_id', groupId)
      .order('week_start', { ascending: false })
      .limit(weeksBack)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPayrollHistory failed: ${err.message}`)
    return []
  }
}

export async function getLateEventsForWeek(groupId, weekStart, db = null) {
  if (db?.getLateEventsForWeek) return db.getLateEventsForWeek(groupId, weekStart)
  try {
    // weekStart is a YYYY-MM-DD string (Monday); week runs Mon–Sun
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 7)
    const { data, error } = await supabase
      .from('staff_reliability_events')
      .select('staff_id, metadata, recorded_at')
      .eq('group_id', groupId)
      .eq('event_type', 'late_arrival')
      .gte('recorded_at', weekStart)
      .lt('recorded_at', weekEnd.toISOString().split('T')[0])
    if (error) throw error
    return (data ?? []).map(ev => ({
      staffId: ev.staff_id,
      minutesLate: ev.metadata?.minutesLate ?? 0,
      shiftId: ev.metadata?.shiftId ?? null,
    }))
  } catch (err) {
    logger.error(`getLateEventsForWeek failed: ${err.message}`)
    return []
  }
}
