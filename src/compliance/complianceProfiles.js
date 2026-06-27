// Jurisdiction compliance profiles (Epic 4 / WP-4.1).
//
// One profile per workplace (group_id) records the governing US state + optional
// city and a resolved `ruleset` that the downstream engines consume:
//   • breakPlanning.js  (WP-4.2) reads ruleset.meal / ruleset.rest
//   • minorLabor.js     (WP-4.3) reads ruleset.minor
//   • fair-workweek     (WP-4.4) reads ruleset.fairWorkweek / advanceNoticeDays
//
// This module owns the SEED rule data so the engines stay pure transforms.
// Rules here are a pragmatic baseline (federal FLSA + a few high-population
// states + Fair-Workweek cities); a profile's stored ruleset can override any
// of it. Setting a profile is compliance-sensitive, so every change is audited.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

// ── Federal baseline (FLSA) ─────────────────────────────────────────────
// FLSA mandates no meal/rest breaks for adults; minor (child-labor) limits do
// apply. States layer stricter rules on top.
export const FEDERAL_RULESET = Object.freeze({
  // Meal: unpaid; required once a shift reaches `afterHours`. null ⇒ not mandated.
  meal: { afterHours: null, durationMin: 30, paid: false },
  // Rest: paid; one break of `durationMin` per `perHours` worked. null ⇒ not mandated.
  rest: { perHours: null, durationMin: 10, paid: true },
  // Minor (child-labor) limits keyed by age band. Times are 24h 'HH:MM' local.
  // `14` band ⇒ applies to ages 14–15; `16` band ⇒ ages 16–17.
  minor: {
    '14': { earliest: '07:00', latestSchoolNight: '19:00', latestNonSchool: '21:00', maxDailySchool: 3, maxDailyNonSchool: 8, maxWeeklySchool: 18, maxWeeklyNonSchool: 40 },
    '16': { earliest: '06:00', latestSchoolNight: '22:00', latestNonSchool: '23:59', maxDailySchool: 8, maxDailyNonSchool: 12, maxWeeklySchool: 48, maxWeeklyNonSchool: 48 },
  },
  fairWorkweek: false,
  advanceNoticeDays: null,
})

// ── State overlays (only the fields that differ from federal) ───────────
export const STATE_RULESETS = Object.freeze({
  CA: { meal: { afterHours: 5, durationMin: 30, paid: false }, rest: { perHours: 4, durationMin: 10, paid: true },
        minor: { '16': { earliest: '05:00', latestSchoolNight: '22:00', latestNonSchool: '00:30', maxDailySchool: 4, maxDailyNonSchool: 8, maxWeeklySchool: 48, maxWeeklyNonSchool: 48 } } },
  NY: { meal: { afterHours: 6, durationMin: 30, paid: false },
        minor: { '16': { earliest: '06:00', latestSchoolNight: '22:00', latestNonSchool: '00:00', maxDailySchool: 8, maxDailyNonSchool: 8, maxWeeklySchool: 48, maxWeeklyNonSchool: 48 } } },
  WA: { meal: { afterHours: 5, durationMin: 30, paid: false }, rest: { perHours: 4, durationMin: 10, paid: true } },
  OR: { meal: { afterHours: 6, durationMin: 30, paid: false }, rest: { perHours: 4, durationMin: 10, paid: true }, fairWorkweek: true, advanceNoticeDays: 14 },
  IL: { meal: { afterHours: 7.5, durationMin: 20, paid: false } },
  CO: { meal: { afterHours: 5, durationMin: 30, paid: false }, rest: { perHours: 4, durationMin: 10, paid: true } },
  TX: {},
  FL: {},
})

// ── Fair-Workweek / predictive-scheduling city overlays ─────────────────
export const FAIR_WORKWEEK_CITIES = Object.freeze({
  'new york': { advanceNoticeDays: 14 },
  'nyc': { advanceNoticeDays: 14 },
  'chicago': { advanceNoticeDays: 10 },
  'philadelphia': { advanceNoticeDays: 14 },
  'san francisco': { advanceNoticeDays: 14 },
  'los angeles': { advanceNoticeDays: 14 },
  'seattle': { advanceNoticeDays: 14 },
})

const normState = (s) => (s ? String(s).trim().toUpperCase() : null)
const normCity = (c) => (c ? String(c).trim().toLowerCase() : null)

// ── Owner-customizable feature toggles ──────────────────────────────────
// Each compliance guardrail can be switched off per workplace by the owner
// (Dashboard → Settings → Compliance). Toggles live under `ruleset.enabled`;
// an absent flag means ENABLED (safe default). The evaluator reads these.
export const COMPLIANCE_FEATURES = Object.freeze(['breaks', 'minorLabor', 'fairWorkweek'])

/** Whether a guardrail is on for this ruleset (default true when unset). */
export function isFeatureEnabled(ruleset, feature) {
  return ruleset?.enabled?.[feature] !== false
}

/** Normalize an arbitrary toggle object to the known feature keys (default true). */
export function normalizeFeatures(enabled = {}) {
  const out = {}
  for (const k of COMPLIANCE_FEATURES) out[k] = enabled?.[k] !== false
  return out
}

/** Merge an overlay onto base, descending up to two object levels deep. */
function mergeRuleset(base, overlay) {
  if (!overlay) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v }
      for (const [ik, iv] of Object.entries(v)) {
        if (iv && typeof iv === 'object' && !Array.isArray(iv) && base[k][ik] && typeof base[k][ik] === 'object') {
          out[k][ik] = { ...base[k][ik], ...iv }
        }
      }
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Resolve the effective ruleset for a state (+ optional Fair-Workweek city),
 * layering federal → state → city. Returns a fresh (mutable) object.
 */
export function resolveRuleset(state, city = null) {
  const code = normState(state)
  let rs = mergeRuleset(FEDERAL_RULESET, code ? STATE_RULESETS[code] : null)
  const cityOverlay = FAIR_WORKWEEK_CITIES[normCity(city)]
  if (cityOverlay) rs = mergeRuleset(rs, { ...cityOverlay, fairWorkweek: true })
  return rs
}

/** Read a workplace's stored compliance profile, or null when unset. */
export async function getProfile(groupId, db = null) {
  if (db?.getComplianceProfile) return db.getComplianceProfile(groupId)
  try {
    const { data, error } = await getDb()
      .from('compliance_profiles')
      .select('*')
      .eq('group_id', String(groupId))
      .maybeSingle()
    if (error) { logger.error(`getProfile failed: ${error.message}`); return null }
    return data ?? null
  } catch (err) {
    logger.error(`getProfile error: ${err.message}`)
    return null
  }
}

/**
 * Effective ruleset for a workplace: the stored ruleset when a profile exists
 * and is non-empty, else resolved from the stored state/city, else federal.
 */
export async function getRuleset(groupId, db = null) {
  const p = await getProfile(groupId, db)
  if (p?.ruleset && Object.keys(p.ruleset).length > 0) return p.ruleset
  if (p?.state || p?.city) return resolveRuleset(p.state, p.city)
  return resolveRuleset(null)
}

/**
 * Set a workplace's jurisdiction. `ruleset` is resolved from state/city when not
 * explicitly provided. Upserts one row per group and audits the change.
 * @returns saved row, or null on failure.
 */
export async function setProfile(groupId, { state = null, city = null, ruleset = null } = {}, actorId = null, db = null) {
  if (!groupId) { logger.error('setProfile: groupId required'); return null }
  const code = normState(state)
  const cityVal = city ? String(city).trim() : null
  const resolved = ruleset ?? resolveRuleset(code, cityVal)
  const prev = await getProfile(groupId, db)
  const row = {
    group_id: String(groupId),
    state: code,
    city: cityVal,
    ruleset: resolved,
    updated_by: actorId != null ? String(actorId) : null,
    updated_at: new Date().toISOString(),
  }

  let saved
  if (db?.upsertComplianceProfile) {
    saved = await db.upsertComplianceProfile(row)
  } else {
    try {
      const { data, error } = await getDb()
        .from('compliance_profiles')
        .upsert(row, { onConflict: 'group_id' })
        .select()
        .single()
      if (error) { logger.error(`setProfile failed: ${error.message}`); return null }
      saved = data
    } catch (err) {
      logger.error(`setProfile error: ${err.message}`)
      return null
    }
  }

  if (prev?.state !== code || prev?.city !== cityVal) {
    await logEvent({
      groupId, actorId, actorType: 'owner',
      action: 'compliance.location.change', target: String(groupId),
      meta: { from: { state: prev?.state ?? null, city: prev?.city ?? null }, to: { state: code, city: cityVal } },
    }, db)
  }
  return saved
}
