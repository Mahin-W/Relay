import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

// ── DB operations ─────────────────────────────────────────────────────────────

export async function saveLaborRecord(groupId, weekStart, totalLaborCost, revenue, db = null) {
  if (db?.saveLaborRecord) return db.saveLaborRecord(groupId, weekStart, totalLaborCost, revenue)
  const laborPercent = revenue > 0 ? (totalLaborCost / revenue) * 100 : null
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('weekly_revenue')
    .upsert(
      { group_id: groupId, week_start: weekStart, revenue, total_labor_cost: totalLaborCost, labor_percent: laborPercent },
      { onConflict: 'group_id,week_start' }
    )
    .select()
    .single()
  if (error) { logger.error(`saveLaborRecord: ${error.message}`); return null }
  return data
}

export async function getLaborCostData(groupId, weekStart, db = null) {
  if (db?.getLaborCostData) return db.getLaborCostData(groupId, weekStart)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('weekly_revenue')
    .select('total_labor_cost, revenue, labor_percent')
    .eq('group_id', groupId)
    .eq('week_start', weekStart)
    .maybeSingle()
  if (error) { logger.error(`getLaborCostData: ${error.message}`); return null }
  if (!data) return null
  return {
    totalLaborCost: Number(data.total_labor_cost),
    revenue: data.revenue != null ? Number(data.revenue) : null,
    laborPercent: data.labor_percent != null ? Number(data.labor_percent) : null,
  }
}

export async function getBudget(groupId, db = null) {
  if (db?.getBudget) return db.getBudget(groupId)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('labor_budgets')
    .select('weekly_budget')
    .eq('group_id', groupId)
    .maybeSingle()
  if (error) { logger.error(`getBudget: ${error.message}`); return null }
  if (!data) return null
  return { weeklyBudget: Number(data.weekly_budget) }
}

export async function saveBudget(groupId, weeklyBudget, db = null) {
  if (db?.saveBudget) return db.saveBudget(groupId, weeklyBudget)
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('labor_budgets')
    .upsert({ group_id: groupId, weekly_budget: weeklyBudget }, { onConflict: 'group_id' })
    .select()
    .single()
  if (error) { logger.error(`saveBudget: ${error.message}`); return null }
  return data
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatMoney(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

export function formatLaborCostMessage(totalLaborCost, revenue, weekStart, budget = null) {
  const lines = [`📊 Labor Cost — Week of ${weekStart}`, '']
  lines.push(`Labor: ${formatMoney(totalLaborCost)}`)

  if (revenue != null) {
    const pct = revenue > 0 ? ((totalLaborCost / revenue) * 100).toFixed(1) : '0.0'
    lines.push(`Revenue: ${formatMoney(revenue)}`)
    lines.push(`Labor %: ${pct}%`)

    if (budget != null) {
      lines.push('')
      const diff = budget - totalLaborCost
      if (diff >= 0) {
        lines.push(`Budget: ${formatMoney(budget)}/wk — ${formatMoney(diff)} under budget ✅`)
      } else {
        lines.push(`⚠️ Over budget by ${formatMoney(Math.abs(diff))} (labor: ${formatMoney(totalLaborCost)} vs ${formatMoney(budget)} budget)`)
      }
    }
  } else {
    lines.push('Revenue: not set')
    lines.push('')
    lines.push('Set revenue with /setrevenue [amount]')
  }

  return lines.join('\n')
}

// ── Command handler ───────────────────────────────────────────────────────────

export async function handleLaborCostCommand(bot, chatId, groupId, weekStart, db = null) {
  const data = await getLaborCostData(groupId, weekStart, db)

  if (!data) {
    await bot.sendMessage(chatId, `No payroll data for week of ${weekStart}.`)
    return
  }

  const budgetRow = await getBudget(groupId, db)
  const budget = budgetRow?.weeklyBudget ?? null

  const text = formatLaborCostMessage(data.totalLaborCost, data.revenue, weekStart, budget)
  await bot.sendMessage(chatId, text)
}
