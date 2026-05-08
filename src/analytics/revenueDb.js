import { getDb } from '../db.js'

function getMonday(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

// Recompute weekly_revenue from daily_revenue entries.
// Also preserves existing total_labor_cost so the revenue update
// doesn't erase previously calculated labor data.
export async function upsertWeeklyRevenueFromDaily(groupId, weekStart, db = null) {
  const _db = db ?? getDb()
  const weekEnd = addDays(weekStart, 7)
  const { data: daily } = await _db
    .from('daily_revenue')
    .select('amount')
    .eq('group_id', groupId)
    .gte('entry_date', weekStart)
    .lt('entry_date', weekEnd)
  const dailyTotal = (daily ?? []).reduce((s, r) => s + parseFloat(r.amount || 0), 0)

  const { data: existing } = await _db
    .from('weekly_revenue')
    .select('total_labor_cost')
    .eq('group_id', groupId)
    .eq('week_start', weekStart)
    .maybeSingle()
  const laborCost = parseFloat(existing?.total_labor_cost ?? 0)
  const laborPercent = dailyTotal > 0
    ? Math.round((laborCost / dailyTotal) * 100 * 10) / 10
    : 0

  const { data, error } = await _db
    .from('weekly_revenue')
    .upsert(
      { group_id: groupId, week_start: weekStart, revenue: dailyTotal, total_labor_cost: laborCost, labor_percent: laborPercent },
      { onConflict: 'group_id,week_start' }
    )
    .select()
    .single()
  if (error) throw error
  return { total: dailyTotal, laborCost, laborPercent, data }
}

// Unified entry point for all revenue logging (bot + dashboard).
// Inserts a daily_revenue row then recomputes weekly_revenue.
export async function logDailyRevenue(groupId, entryDate, amount, category, note, db = null) {
  const _db = db ?? getDb()
  const { data, error } = await _db
    .from('daily_revenue')
    .insert({
      group_id: groupId,
      entry_date: entryDate,
      amount: parseFloat(amount),
      category: category ?? null,
      note: note ?? null,
    })
    .select()
    .single()
  if (error) throw error
  const weekStart = getMonday(entryDate)
  await upsertWeeklyRevenueFromDaily(groupId, weekStart, _db)
  return data
}
