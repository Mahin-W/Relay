// Entitlements / feature flags (Epic 0 / WP-0.5).
//
// FLAT-FEE model: a group has one tier (free/starter/pro). Tiers unlock
// *features*, never seats — there is intentionally no headcount metering here.
// Base product features (anything not in PAID_FEATURES) are always allowed so
// existing free functionality can never be gated by accident.
//
// Usage:
//   if (await can(groupId, 'payouts')) { ... }
//   await requireFeature(groupId, 'payroll')   // throws if not entitled
//
// The tier → feature mapping below is PROVISIONAL (the exact tiers + prices are
// an open business decision). Change TIER_GRANTS without touching call sites.

import { getDb } from '../db.js'
import { logger } from '../logger.js'

// Paid features gated by tier. Anything not listed is "base" and always on.
export const PAID_FEATURES = [
  'payroll', 'payouts', 'pos', 'compliance', 'documents',
  'pto', 'calendar', 'api', 'sms', 'whatsapp',
]

// Cumulative grants per tier (provisional — see WP-7.7).
const TIER_GRANTS = {
  free:    [],
  starter: ['documents', 'pto', 'compliance', 'calendar'],
  pro:     ['documents', 'pto', 'compliance', 'calendar', 'payroll', 'payouts', 'pos', 'api', 'sms', 'whatsapp'],
}

export class FeatureNotEntitledError extends Error {
  constructor(groupId, feature) {
    super(`Group ${groupId} is not entitled to feature: ${feature}`)
    this.name = 'FeatureNotEntitledError'
    this.code = 'FEATURE_NOT_ENTITLED'
    this.feature = feature
    this.groupId = groupId
  }
}

/**
 * Whether a group may use a feature.
 * Base (non-paid) features are always allowed. Paid features require the tier
 * to grant them, unless an explicit override flips them on/off.
 * @param {string|number} groupId
 * @param {string} feature
 * @param {object|null} [db]
 * @returns {Promise<boolean>}
 */
export async function can(groupId, feature, db = null) {
  if (!feature) return false
  if (!PAID_FEATURES.includes(feature)) return true // base feature, always on

  const row = await getEntitlementRow(groupId, db)
  const overrides = row?.overrides ?? {}
  if (Object.prototype.hasOwnProperty.call(overrides, feature)) {
    return overrides[feature] === true
  }
  const tier = row?.tier ?? 'free'
  const grants = TIER_GRANTS[tier] ?? TIER_GRANTS.free
  return grants.includes(feature)
}

/**
 * Throw FeatureNotEntitledError if the group can't use the feature.
 */
export async function requireFeature(groupId, feature, db = null) {
  if (!(await can(groupId, feature, db))) {
    throw new FeatureNotEntitledError(groupId, feature)
  }
}

/**
 * Current tier for a group (defaults to 'free').
 */
export async function getTier(groupId, db = null) {
  const row = await getEntitlementRow(groupId, db)
  return row?.tier ?? 'free'
}

/**
 * Set a group's tier (called by billing, WP-7.7).
 */
export async function setTier(groupId, tier, db = null) {
  if (!TIER_GRANTS[tier]) { logger.error(`setTier: unknown tier '${tier}'`); return null }
  const row = { group_id: String(groupId), tier, updated_at: new Date().toISOString() }
  if (db?.upsertEntitlement) return db.upsertEntitlement(row)
  try {
    const { data, error } = await getDb()
      .from('entitlements')
      .upsert(row, { onConflict: 'group_id' })
      .select()
      .single()
    if (error) { logger.error(`setTier failed: ${error.message}`); return null }
    return data
  } catch (err) {
    logger.error(`setTier error: ${err.message}`)
    return null
  }
}

// ── internal ──────────────────────────────────────────────────────────────────
async function getEntitlementRow(groupId, db = null) {
  if (!groupId) return null
  if (db?.getEntitlementRow) return db.getEntitlementRow(String(groupId))
  try {
    const { data, error } = await getDb()
      .from('entitlements')
      .select('*')
      .eq('group_id', String(groupId))
      .maybeSingle()
    if (error) { logger.error(`getEntitlementRow failed: ${error.message}`); return null }
    return data ?? null
  } catch (err) {
    logger.error(`getEntitlementRow error: ${err.message}`)
    return null
  }
}
