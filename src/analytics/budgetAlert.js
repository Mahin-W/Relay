import { getDb } from '../db.js'
import { logger } from '../logger.js'

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Parse time strings like "11am", "5pm", "9:00 AM", "17:00" to minutes since midnight. */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, ' ')

  // 24-hour: "17:00"
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2])

  // 12-hour with optional minutes: "9:00 am", "3:00 pm", "9am", "3pm"
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (m12) {
    let h = parseInt(m12[1])
    const min = parseInt(m12[2] ?? '0')
    if (m12[3] === 'pm' && h !== 12) h += 12
    if (m12[3] === 'am' && h === 12) h = 0
    return h * 60 + min
  }

  return 0
}

/** Returns hours between start and end (handles overnight: if diff <= 0, add 24hrs). */
function shiftDurationHours(startTime, endTime) {
  const startMin = parseTimeToMinutes(startTime)
  const endMin = parseTimeToMinutes(endTime)
  let diffMin = endMin - startMin
  if (diffMin <= 0) diffMin += 24 * 60
  return diffMin / 60
}

function round2(n) {
  return Math.round(n * 100) / 100
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * Pure function: calculate projected labor cost from assignments, shifts, roles, and OT settings.
 * No DB, no LLM.
 */
export function calculateProjectedLaborCost(assignments, shifts, roles, overtimeSettings = {}) {
  if (!assignments?.length) {
    return {
      totalProjectedCost: 0,
      totalHours: 0,
      regularCost: 0,
      overtimeCost: 0,
      byRole: [],
      byDay: [],
      staffCount: 0,
    }
  }

  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))
  const roleMap = Object.fromEntries((roles ?? []).map(r => [String(r.id), r]))

  // First pass: gather per-staff hours and per-assignment data
  const staffHours = {}   // staffId -> { totalHours, assignments: [{ hours, rate, roleId, roleName, day }] }
  const roleAgg = {}      // roleId -> { roleName, hours, cost }  (cost filled after OT calc)
  const dayAgg = {}        // day -> { hours, cost }

  for (const a of assignments) {
    const shiftId = String(a.shiftId ?? a.shift_id ?? '')
    const shift = shiftMap[shiftId]
    if (!shift) continue

    const hours = shiftDurationHours(shift.start_time, shift.end_time)
    const roleId = String(a.roleId ?? a.role_id ?? '')
    const role = roleMap[roleId]
    const rate = role?.hourlyRate ?? role?.hourly_rate ?? 0
    const roleName = a.roleName ?? role?.roleName ?? 'Unknown'
    const day = a.dayOfWeek ?? a.day_of_week ?? shift.day_of_week ?? 'Unknown'

    const staffId = String(a.staffId ?? a.staff_id)
    if (!staffHours[staffId]) {
      staffHours[staffId] = { totalHours: 0, staffName: a.staffName ?? 'Unknown', entries: [] }
    }
    staffHours[staffId].totalHours += hours
    staffHours[staffId].entries.push({ hours, rate, roleId, roleName, day })
  }

  // Second pass: apply overtime rules per staff, accumulate role/day costs
  let totalRegular = 0
  let totalOvertime = 0
  let totalHours = 0

  const otEnabled = overtimeSettings.overtime_enabled === true
  const weeklyThreshold = overtimeSettings.weekly_threshold ?? 40
  const weeklyMultiplier = overtimeSettings.weekly_multiplier ?? 1.5
  const dailyOtEnabled = overtimeSettings.daily_overtime_enabled === true
  const dailyThreshold = overtimeSettings.daily_threshold ?? 8
  const dailyMultiplier = overtimeSettings.daily_multiplier ?? 1.5

  for (const [staffId, staff] of Object.entries(staffHours)) {
    totalHours += staff.totalHours

    if (!otEnabled) {
      // No overtime — all regular
      for (const e of staff.entries) {
        const cost = round2(e.hours * e.rate)
        totalRegular += cost
        // Accumulate role
        if (!roleAgg[e.roleId]) roleAgg[e.roleId] = { roleName: e.roleName, hours: 0, cost: 0 }
        roleAgg[e.roleId].hours += e.hours
        roleAgg[e.roleId].cost += cost
        // Accumulate day
        if (!dayAgg[e.day]) dayAgg[e.day] = { hours: 0, cost: 0 }
        dayAgg[e.day].hours += e.hours
        dayAgg[e.day].cost += cost
      }
      continue
    }

    // Weekly overtime: distribute OT across entries proportionally
    // Process entries in order; first entries are regular, later ones may be OT
    let regularHoursRemaining = Math.min(staff.totalHours, weeklyThreshold)
    let otHoursRemaining = Math.max(0, staff.totalHours - weeklyThreshold)

    for (const e of staff.entries) {
      let regHrs, otHrs
      if (regularHoursRemaining >= e.hours) {
        regHrs = e.hours
        otHrs = 0
        regularHoursRemaining -= e.hours
      } else {
        regHrs = regularHoursRemaining
        otHrs = e.hours - regularHoursRemaining
        regularHoursRemaining = 0
      }

      const regCost = round2(regHrs * e.rate)
      const otCost = round2(otHrs * e.rate * weeklyMultiplier)
      const entryCost = round2(regCost + otCost)

      totalRegular += regCost
      totalOvertime += otCost

      if (!roleAgg[e.roleId]) roleAgg[e.roleId] = { roleName: e.roleName, hours: 0, cost: 0 }
      roleAgg[e.roleId].hours += e.hours
      roleAgg[e.roleId].cost += entryCost

      if (!dayAgg[e.day]) dayAgg[e.day] = { hours: 0, cost: 0 }
      dayAgg[e.day].hours += e.hours
      dayAgg[e.day].cost += entryCost
    }
  }

  const byRole = Object.entries(roleAgg).map(([roleId, r]) => ({
    roleId: Number(roleId) || roleId,
    roleName: r.roleName,
    hours: round2(r.hours),
    cost: round2(r.cost),
  }))

  const byDay = Object.entries(dayAgg).map(([day, d]) => ({
    day,
    hours: round2(d.hours),
    cost: round2(d.cost),
  }))

  const uniqueStaff = new Set(
    assignments.map(a => String(a.staffId ?? a.staff_id))
  )

  return {
    totalProjectedCost: round2(totalRegular + totalOvertime),
    totalHours: round2(totalHours),
    regularCost: round2(totalRegular),
    overtimeCost: round2(totalOvertime),
    byRole,
    byDay,
    staffCount: uniqueStaff.size,
  }
}

/**
 * Pure function: format a budget alert message for Telegram.
 * budget = weekly dollar limit or null.
 */
export function formatBudgetAlert(projected, budget, weekStart) {
  const cost = `$${projected.totalProjectedCost.toFixed(2)}`
  const hours = `${projected.totalHours}hrs`

  const roleLines = projected.byRole
    .map(r => `• ${r.roleName}: ${r.hours}hrs — $${r.cost.toFixed(2)}`)
    .join('\n')

  const dayLines = projected.byDay
    .map(d => `• ${d.day}: ${d.hours}hrs — $${d.cost.toFixed(2)}`)
    .join('\n')

  // NO BUDGET SET
  if (budget == null) {
    return [
      `📊 *Schedule cost — Week of ${weekStart}*`,
      `Projected labor: ${cost} (${hours})`,
      '',
      '*By role:*',
      roleLines,
      '',
      '*By day:*',
      dayLines,
      '',
      'Tip: set a weekly budget with /setbudget [amount]',
      'to get over/under alerts automatically.',
    ].join('\n')
  }

  const variance = round2(Math.abs(projected.totalProjectedCost - budget))
  const pct = round2((variance / budget) * 100)

  // UNDER BUDGET
  if (projected.totalProjectedCost <= budget) {
    return [
      `✅ *Schedule cost — Week of ${weekStart}*`,
      '',
      `Projected labor: ${cost} (${hours})`,
      `Your budget: $${budget.toFixed(2)}`,
      `Under by: $${variance.toFixed(2)} (${pct}% of budget)`,
      '',
      '*By role:*',
      roleLines,
      '',
      '*By day:*',
      dayLines,
    ].join('\n')
  }

  // OVER BUDGET
  const mostExpensiveDay = projected.byDay.reduce(
    (max, d) => d.cost > max.cost ? d : max,
    projected.byDay[0]
  )

  return [
    `⚠️ *Over budget — Week of ${weekStart}*`,
    '',
    `Projected labor: ${cost} (${hours})`,
    `Your budget: $${budget.toFixed(2)}`,
    `OVER by: $${variance.toFixed(2)} (${pct}% over budget)`,
    '',
    `*Most expensive day:* ${mostExpensiveDay.day} ($${mostExpensiveDay.cost.toFixed(2)})`,
    '',
    '*By role:*',
    roleLines,
    '',
    '*By day:*',
    dayLines,
    '',
    'Reply *approve* to publish anyway,',
    'or *regenerate* for a different arrangement.',
  ].join('\n')
}

// ── DB functions ─────────────────────────────────────────────────────────────

/**
 * Get the weekly labor budget for a group.
 * Returns { weeklyBudget, currency } or null.
 */
export async function getBudget(groupId, db = null) {
  if (db?.getBudget) return db.getBudget(groupId)

  const { data, error } = await getDb()
    .from('labor_budgets')
    .select('weekly_budget, currency')
    .eq('group_id', groupId)
    .single()

  if (error) {
    if (error.code !== 'PGRST116') {
      logger.error(`getBudget error: ${error.message}`)
    }
    return null
  }

  return { weeklyBudget: Number(data.weekly_budget), currency: data.currency ?? 'USD' }
}

/**
 * Upsert the weekly labor budget for a group.
 */
export async function saveBudget(groupId, weeklyBudget, db = null) {
  if (db?.saveBudget) return db.saveBudget(groupId, weeklyBudget)

  const { data, error } = await getDb()
    .from('labor_budgets')
    .upsert({ group_id: groupId, weekly_budget: weeklyBudget }, { onConflict: 'group_id' })
    .select()
    .single()

  if (error) {
    logger.error(`saveBudget error: ${error.message}`)
    return null
  }

  return data
}
