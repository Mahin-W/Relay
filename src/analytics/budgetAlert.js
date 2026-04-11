import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// Parse "9:00 AM" / "17:00" / "9am" style strings to decimal hours (0–24).
// Returns 0 if unparseable.
function parseTimeToHours(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, ' ')

  // 24-hour: "17:00"
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) return parseInt(m24[1]) + parseInt(m24[2]) / 60

  // 12-hour with optional minutes: "9:00 am", "3:00 pm", "9am", "3pm"
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (m12) {
    let h = parseInt(m12[1])
    const min = parseInt(m12[2] ?? '0')
    if (m12[3] === 'pm' && h !== 12) h += 12
    if (m12[3] === 'am' && h === 12) h = 0
    return h + min / 60
  }

  return 0
}

function shiftDurationHours(startTime, endTime) {
  const start = parseTimeToHours(startTime)
  const end = parseTimeToHours(endTime)
  let diff = end - start
  if (diff <= 0) diff += 24
  return diff
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * Get the weekly labor budget for a group.
 * Returns { weeklyBudget: number } or null if not set.
 */
export async function getBudget(groupId, db = null) {
  if (db?.getBudget) return db.getBudget(groupId)

  const { data, error } = await supabase
    .from('labor_budgets')
    .select('weekly_budget, currency')
    .eq('group_id', groupId)
    .single()

  if (error) {
    if (error.code !== 'PGRST116') { // PGRST116 = no rows found
      logger.error(`getBudget error: ${error.message}`)
    }
    return null
  }

  return { weeklyBudget: Number(data.weekly_budget), currency: data.currency ?? 'USD' }
}

/**
 * Save or update the weekly labor budget for a group.
 * Returns saved row or null on error.
 */
export async function saveBudget(groupId, weeklyBudget, db = null) {
  if (db?.saveBudget) return db.saveBudget(groupId, weeklyBudget)

  const { data, error } = await supabase
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

/**
 * Calculate projected labor cost from scheduled assignments.
 *
 * For each assignment, finds its shift by shiftId and computes duration in hours.
 * Multiplies by hourlyRate if present on the assignment, otherwise counts hours only.
 * Returns total projected dollar cost (or total hours if no rates are available).
 */
export function calculateProjectedLaborCost(assignments, shifts) {
  if (!assignments?.length) return 0

  const shiftMap = Object.fromEntries((shifts ?? []).map(s => [String(s.id), s]))

  let total = 0
  for (const a of assignments) {
    const shiftId = String(a.shiftId ?? a.shift_id ?? '')
    const shift = shiftMap[shiftId]
    if (!shift) continue

    const startTime = shift.startTime ?? shift.start_time
    const endTime = shift.endTime ?? shift.end_time
    const hours = shiftDurationHours(startTime, endTime)

    const rate = a.hourlyRate ?? a.hourly_rate ?? 0
    total += hours * (rate > 0 ? rate : 1) // multiply by rate when available, else count hours
  }

  return round2(total)
}

/**
 * Check if projected cost exceeds the weekly budget.
 * Returns a formatted alert string if over budget, null otherwise.
 */
export function checkBudgetAlert(projectedCost, weeklyBudget) {
  if (projectedCost <= weeklyBudget) return null

  const overage = round2(projectedCost - weeklyBudget)
  return (
    `⚠️ Budget Alert: Projected labor $${projectedCost.toFixed(2)} exceeds weekly budget ` +
    `$${weeklyBudget.toFixed(2)} (over by $${overage.toFixed(2)})`
  )
}

/**
 * Main function: fetch the group's budget and return an alert string (or null).
 *
 * 1. Get budget for group — if not set, return null.
 * 2. Calculate projected cost from assignments + shifts.
 * 3. Return checkBudgetAlert result.
 */
export async function getBudgetAlertForSchedule(groupId, assignments, shifts, db = null) {
  const budget = await getBudget(groupId, db)
  if (!budget) return null

  const projectedCost = calculateProjectedLaborCost(assignments, shifts)
  return checkBudgetAlert(projectedCost, budget.weeklyBudget)
}
