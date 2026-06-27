// PTO accrual + balances (Epic 6 / WP-6.1, 6.2).
//
// Per-group accrual policy → per-employee running balance, with an append-only
// ledger and audit on every change. Pure math (computeAccrual / clampBalance) is
// separated from the DB-wired ops so it's trivially testable. Deduction is
// wired into time-off approval (handleTimeOff) at merge time.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

// ── pure helpers ──────────────────────────────────────────────────────────────
/** Hours accrued over N periods for a policy. */
export function computeAccrual(policy, periods = 1) {
  const rate = Number(policy?.accrual_hours_per_period ?? 0)
  if (!(rate > 0) || !(periods > 0)) return 0
  return Math.round(rate * periods * 100) / 100
}

/** New balance after a delta, clamped to [0, max]. */
export function clampBalance(current, delta, maxBalance = null) {
  let next = Number(current ?? 0) + Number(delta ?? 0)
  if (next < 0) next = 0
  if (maxBalance != null && next > Number(maxBalance)) next = Number(maxBalance)
  return Math.round(next * 100) / 100
}

// ── reads ─────────────────────────────────────────────────────────────────────
export async function getPolicy(groupId, db = null) {
  if (db?.getPtoPolicy) return db.getPtoPolicy(groupId)
  try {
    const { data, error } = await getDb().from('pto_policies').select('*').eq('group_id', String(groupId)).maybeSingle()
    if (error) { logger.error(`getPolicy failed: ${error.message}`); return null }
    return data ?? null
  } catch (err) { logger.error(`getPolicy error: ${err.message}`); return null }
}

export async function getBalance(groupId, staffId, db = null) {
  if (db?.getPtoBalance) return Number((await db.getPtoBalance(groupId, staffId))?.balance_hours ?? 0)
  try {
    const { data, error } = await getDb().from('pto_balances').select('balance_hours')
      .eq('group_id', String(groupId)).eq('staff_id', staffId).maybeSingle()
    if (error) { logger.error(`getBalance failed: ${error.message}`); return 0 }
    return Number(data?.balance_hours ?? 0)
  } catch (err) { logger.error(`getBalance error: ${err.message}`); return 0 }
}

// ── mutations ─────────────────────────────────────────────────────────────────
/**
 * Apply a balance change (+accrual / −usage), clamp, write ledger + audit.
 * @returns {Promise<{ok:boolean, balance:number, applied:number}>}
 */
export async function adjustBalance(groupId, staffId, deltaHours, reason, actorId = null, db = null) {
  const policy = await getPolicy(groupId, db)
  const current = await getBalance(groupId, staffId, db)
  const next = clampBalance(current, deltaHours, policy?.max_balance_hours ?? null)
  const applied = Math.round((next - current) * 100) / 100

  const balRow = { group_id: String(groupId), staff_id: staffId, balance_hours: next, updated_at: new Date().toISOString() }
  const ledRow = { group_id: String(groupId), staff_id: staffId, delta_hours: applied, reason: reason ?? null, balance_after: next }

  if (db?.upsertPtoBalance) {
    await db.upsertPtoBalance(balRow)
    if (db.insertPtoLedger) await db.insertPtoLedger(ledRow)
  } else {
    try {
      const { error: be } = await getDb().from('pto_balances').upsert(balRow, { onConflict: 'group_id,staff_id' })
      if (be) { logger.error(`adjustBalance upsert failed: ${be.message}`); return { ok: false, balance: current, applied: 0 } }
      const { error: le } = await getDb().from('pto_ledger').insert([ledRow])
      if (le) logger.error(`pto_ledger insert failed: ${le.message}`)
    } catch (err) { logger.error(`adjustBalance error: ${err.message}`); return { ok: false, balance: current, applied: 0 } }
  }

  await logEvent({ groupId, actorId, actorType: actorId ? 'manager' : 'system', action: 'pto.adjust', target: staffId, meta: { reason, delta: applied, balance: next } }, db)
  return { ok: true, balance: next, applied }
}

/** Accrue this period's hours for one employee. */
export async function accrue(groupId, staffId, periods = 1, db = null) {
  const policy = await getPolicy(groupId, db)
  const hours = computeAccrual(policy, periods)
  if (hours <= 0) return { ok: true, balance: await getBalance(groupId, staffId, db), applied: 0 }
  return adjustBalance(groupId, staffId, hours, 'accrual', null, db)
}

/** Deduct PTO (e.g. on time-off approval). Reports any shortfall. */
export async function deduct(groupId, staffId, hours, actorId = null, db = null) {
  const current = await getBalance(groupId, staffId, db)
  const want = Number(hours ?? 0)
  const res = await adjustBalance(groupId, staffId, -want, 'timeoff', actorId, db)
  const shortfall = Math.max(0, Math.round((want - (current - res.balance)) * 100) / 100)
  return { ...res, shortfall }
}
