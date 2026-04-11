import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentWeekStart() {
  const today = new Date()
  const day = today.getDay()
  const daysToMonday = day === 0 ? -6 : 1 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysToMonday)
  monday.setHours(0, 0, 0, 0)
  return monday.toISOString().split('T')[0]
}

const STATUS_EMOJI = {
  excellent: '🟢',
  good: '🟢',
  watch: '🟡',
  high: '🔴',
  critical: '🔴',
}

function getStatusForPercent(percent) {
  if (percent < 25) return 'excellent'
  if (percent < 30) return 'good'
  if (percent < 35) return 'watch'
  if (percent < 40) return 'high'
  return 'critical'
}

// ── parseRevenueInput ────────────────────────────────────────────────────────

export function parseRevenueInput(text) {
  if (!text || typeof text !== 'string') return null

  // Match dollar amounts with optional commas, decimals, and k/K suffix
  const match = text.match(/\$?([\d,]+(?:\.\d+)?)\s*([kK])?/)
  if (!match) return null

  const numStr = match[1].replace(/,/g, '')
  const num = parseFloat(numStr)
  const hasK = !!match[2]

  if (isNaN(num)) return null

  return hasK ? num * 1000 : num
}

// ── calculateLaborCostPercent ────────────────────────────────────────────────

export function calculateLaborCostPercent(totalLaborCost, revenue) {
  if (!revenue || revenue === 0) {
    return {
      percent: null,
      label: 'Revenue is $0 — cannot calculate labor %',
      status: 'unknown',
      benchmark: 'Industry average: 25–35%',
    }
  }

  const percent = Math.round((totalLaborCost / revenue) * 1000) / 10

  let status, label
  if (percent < 25) {
    status = 'excellent'
    label = '🟢 Excellent — well below target'
  } else if (percent < 30) {
    status = 'good'
    label = '🟢 Good — within target'
  } else if (percent < 35) {
    status = 'watch'
    label = '🟡 Watch — at industry average'
  } else if (percent < 40) {
    status = 'high'
    label = '🔴 High — above target'
  } else {
    status = 'critical'
    label = '🔴 Critical — significantly over target'
  }

  return {
    percent,
    label,
    status,
    benchmark: 'Industry average: 25–35%',
  }
}

// ── formatLaborCostReport ────────────────────────────────────────────────────

export function formatLaborCostReport(weekStart, totalHours, totalLaborCost, revenue, percent, status, roleBreakdown) {
  const emoji = STATUS_EMOJI[status] || ''
  const { label, benchmark } = calculateLaborCostPercent(totalLaborCost, revenue)

  let report = `📊 *Labor Cost Report — Week of ${weekStart}*\n\n`
  report += `💰 Revenue: $${revenue}\n`
  report += `👥 Total labor: $${totalLaborCost}\n`
  report += `⏱️ Total hours: ${totalHours}hrs\n\n`
  report += `*Labor cost: ${percent}% ${emoji}*\n`
  report += `${label}\n`
  report += `${benchmark}\n`

  if (roleBreakdown && roleBreakdown.length > 0) {
    report += '\n*By role:*\n'
    for (const r of roleBreakdown) {
      report += `• ${r.role}: ${r.hours}hrs — $${r.cost} (${r.percent}%)\n`
    }
  }

  if (percent >= 35) {
    report += '\n⚠️ Consider reducing hours on slower shifts or reviewing staffing levels.'
  }

  return report
}

// ── formatRevenueHistory ─────────────────────────────────────────────────────

export function formatRevenueHistory(history) {
  if (!history || history.length === 0) {
    return 'No revenue history yet. Use /revenue to log weekly revenue.'
  }

  const n = history.length
  let output = `📈 *Labor cost trend — last ${n} weeks*\n\n`

  for (const h of history) {
    const emoji = STATUS_EMOJI[getStatusForPercent(h.laborPercent)] || ''
    output += `${h.weekStart}: $${h.revenue} rev → ${h.laborPercent}% labor ${emoji}\n`
  }

  const percents = history.map(h => h.laborPercent)
  const avg = Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10
  const best = Math.min(...percents)
  const worst = Math.max(...percents)

  output += `\nAverage: ${avg}% | Best: ${best}% | Worst: ${worst}%`

  return output
}

// ── DB functions ─────────────────────────────────────────────────────────────

export async function saveWeeklyRevenue(groupId, weekStart, revenue, totalLaborCost, laborPercent, db = null) {
  if (db?.saveWeeklyRevenue) return db.saveWeeklyRevenue(groupId, weekStart, revenue, totalLaborCost, laborPercent)

  const { data, error } = await supabase
    .from('weekly_revenue')
    .upsert(
      { group_id: groupId, week_start: weekStart, revenue, total_labor_cost: totalLaborCost, labor_percent: laborPercent },
      { onConflict: 'group_id,week_start' }
    )
    .select()
    .single()

  if (error) throw error
  return data
}

export async function getRevenueHistory(groupId, weeksBack = 8, db = null) {
  if (db?.getRevenueHistory) return db.getRevenueHistory(groupId, weeksBack)

  const { data, error } = await supabase
    .from('weekly_revenue')
    .select('week_start, revenue, total_labor_cost, labor_percent')
    .eq('group_id', groupId)
    .order('week_start', { ascending: false })
    .limit(weeksBack)

  if (error) throw error
  return (data || []).map(r => ({
    weekStart: r.week_start,
    revenue: r.revenue,
    totalLaborCost: r.total_labor_cost,
    laborPercent: r.labor_percent,
  }))
}

// ── handleRevenueInput ───────────────────────────────────────────────────────

export async function handleRevenueInput(bot, msg, revenue, db = null) {
  const groupId = String(msg.chat.id)
  const weekStart = getCurrentWeekStart()

  // Get setup session for manager DM
  const session = db?.getSetupSession ? await db.getSetupSession(groupId) : null

  // Get payroll for this week
  const payroll = db?.getPayrollForWeek ? await db.getPayrollForWeek(groupId, weekStart) : []

  if (!payroll || payroll.length === 0) {
    const chatId = session?.dm_chat_id || String(msg.chat.id)
    await bot.sendMessage(String(chatId), 'No payroll calculated yet this week. Publish the schedule first, then enter revenue.')
    return
  }

  // Calculate totals from payroll
  let totalHours = 0
  let totalLaborCost = 0
  const roleMap = {}

  for (const p of payroll) {
    totalHours += p.total_hours || 0
    totalLaborCost += p.total_gross_pay || 0

    if (p.shift_breakdown) {
      for (const s of p.shift_breakdown) {
        const role = s.role || 'Other'
        if (!roleMap[role]) roleMap[role] = { hours: 0, cost: 0 }
        roleMap[role].hours += s.hours || 0
        roleMap[role].cost += s.gross_pay || 0
      }
    }
  }

  const roleBreakdown = Object.entries(roleMap).map(([role, data]) => ({
    role,
    hours: data.hours,
    cost: data.cost,
    percent: revenue > 0 ? Math.round((data.cost / revenue) * 1000) / 10 : 0,
  }))

  const { percent, status } = calculateLaborCostPercent(totalLaborCost, revenue)

  // Save to DB
  await saveWeeklyRevenue(groupId, weekStart, revenue, totalLaborCost, percent, db)

  // Format and send report
  const report = formatLaborCostReport(weekStart, totalHours, totalLaborCost, revenue, percent, status, roleBreakdown)

  const dmChatId = session?.dm_chat_id
  if (dmChatId) {
    await bot.sendMessage(String(msg.chat.id), '📨 Labor cost report sent to your DM.')
    await bot.sendMessage(String(dmChatId), report, { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(String(msg.chat.id), report, { parse_mode: 'Markdown' })
  }
}
