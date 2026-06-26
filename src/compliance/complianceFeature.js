// Location & compliance dual-surface (Epic 4 / WP-4.1).
//
// The owner sets the workplace's governing jurisdiction from any surface:
//   • Command:  /setlocation <state | city, state>   (owner-only)
//   • Chat NL:  intent 'set_location' ("we're in California", "set location to CA")
//   • Dashboard: Settings → "Location & compliance" calls setProfile() directly.
// Thin adapter: all logic lives in complianceProfiles.js. Setting location is
// compliance-sensitive, so the service audits it; the command is owner-gated.

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { setProfile } from './complianceProfiles.js'

// Full US state/territory name → 2-letter code (so "California" resolves).
export const STATE_NAME_TO_CODE = Object.freeze({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'd.c.': 'DC',
})
const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE))

/**
 * Parse a free-text location into { state, city }.
 * Accepts: "CA", "California", "San Francisco, CA", "San Francisco California",
 * "set location to NY", "we're in Chicago, IL".
 */
export function parseLocation(text) {
  let t = String(text ?? '').trim()
  if (!t) return { state: null, city: null }
  // strip leading command/verb noise
  t = t.replace(/^\/?set\s*location(\s+(to|is|=))?\s*/i, '')
       .replace(/^(we'?re|we are|located|location|based)\s+(in|at|is)?\s*/i, '')
       .trim()
  if (!t) return { state: null, city: null }

  let state = null
  let city = null

  if (t.includes(',')) {
    const [c, s] = t.split(',').map(x => x.trim())
    city = c || null
    state = resolveState(s)
    if (!state && s) city = [c, s].filter(Boolean).join(', ') // couldn't map → keep as-is
    return { state, city }
  }

  // No comma: try a trailing 2-letter code or full state name.
  const lower = t.toLowerCase()
  // longest full-name match anywhere
  for (const name of Object.keys(STATE_NAME_TO_CODE)) {
    if (lower === name || lower.endsWith(' ' + name)) {
      state = STATE_NAME_TO_CODE[name]
      const rest = t.slice(0, lower.lastIndexOf(name)).trim()
      city = rest || null
      return { state, city }
    }
  }
  const tokens = t.split(/\s+/)
  const last = tokens[tokens.length - 1].toUpperCase()
  if (STATE_CODES.has(last)) {
    state = last
    city = tokens.slice(0, -1).join(' ') || null
    return { state, city }
  }
  // Single token that's a state name handled above; otherwise treat as city.
  return { state: null, city: t }
}

function resolveState(s) {
  if (!s) return null
  const up = s.trim().toUpperCase()
  if (STATE_CODES.has(up)) return up
  return STATE_NAME_TO_CODE[s.trim().toLowerCase()] ?? null
}

export function registerComplianceFeature(deps = {}) {
  const save = deps.setProfile ?? setProfile

  const handler = async (ctx = {}) => {
    const reply = ctx.reply ?? deps.reply
    const loc = (ctx.fields && (ctx.fields.state || ctx.fields.city))
      ? { state: ctx.fields.state ?? null, city: ctx.fields.city ?? null }
      : parseLocation(ctx.text ?? ctx.args ?? '')

    if (!loc.state && !loc.city) {
      if (reply) await reply('Tell me your location — e.g. “set location to CA” or “/setlocation San Francisco, CA”.')
      return { ok: false, reason: 'unparsed' }
    }

    const saved = await save(ctx.groupId, loc, ctx.actorId ?? ctx.userId ?? null, deps.db)
    if (!saved) {
      if (reply) await reply('Couldn’t save your location — please try again.')
      return { ok: false, reason: 'save_failed' }
    }

    if (reply) {
      const where = [saved.city, saved.state].filter(Boolean).join(', ')
      const fw = saved.ruleset?.fairWorkweek ? ' This city has Fair Workweek (predictive scheduling) rules.' : ''
      await reply(`📍 Location set to ${where}. Labor-law compliance rules are now active for scheduling.${fw}`)
    }
    return { ok: true, profile: saved }
  }

  registerCommand({
    name: 'setlocation',
    role: 'owner',
    help: 'Set your workplace location for labor-law compliance (e.g. /setlocation CA)',
    handler,
  })

  registerIntent({
    name: 'set_location',
    triggers: [/set\s*(our\s*)?location/i, /^we'?re (in|at|located)/i, /change (our )?location/i],
    extract: (text) => parseLocation(text),
    promptHint: 'owner is setting the workplace state/city for compliance',
    handler,
  })
}
