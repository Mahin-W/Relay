// Certifications dual-surface (Epic 5 / WP-5.4).
//   • Command: /certs → list your certs + status
//   • Chat NL: intent 'cert_upload' ("upload my food handler cert") → log metadata
//   • Dashboard: list/add from a route.
// Actual file attach happens in the dashboard doc vault (blocked-on-human); the
// chat path records the cert type and nudges to set the expiry date.

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { listCertifications, addCertification, isExpired, daysUntilExpiry } from './certifications.js'
import { logger } from '../logger.js'

const CERT_TYPES = [
  { re: /food ?handler/i, type: 'Food Handler' },
  { re: /serv ?safe/i, type: 'ServSafe' },
  { re: /(alcohol|tips certif|rbs|bartend)/i, type: 'Alcohol Service' },
  { re: /\bcpr\b/i, type: 'CPR' },
]
export function parseCertType(text) {
  for (const c of CERT_TYPES) if (c.re.test(String(text ?? ''))) return c.type
  return null
}

export function formatCertList(certs, asOf = new Date()) {
  if (!certs || certs.length === 0) return '📋 You have no certifications on file. Add one with /certs or in the dashboard.'
  const lines = certs.map(c => {
    let status
    if (!c.expires_date) status = 'no expiry set'
    else if (isExpired(c, asOf)) status = '❌ expired'
    else { const d = daysUntilExpiry(c, asOf); status = d <= 30 ? `⚠️ expires in ${d}d` : '✅ valid' }
    return `• ${c.cert_type} — ${status}`
  })
  return `📋 *Your certifications*\n${lines.join('\n')}`
}

export function registerCertificationsFeature(deps = {}) {
  const list = deps.listCertifications ?? listCertifications
  const add = deps.addCertification ?? addCertification

  const listHandler = async (ctx) => {
    const reply = ctx.reply ?? deps.reply
    try {
      const certs = await list(ctx.groupId, ctx.staffId ?? ctx.userId, deps.db ?? null)
      if (reply) await reply(formatCertList(certs))
      return { ok: true, count: certs.length }
    } catch (err) {
      logger.error(`/certs failed: ${err.message}`)
      if (reply) await reply('Could not load your certifications — please try again.')
      return { ok: false }
    }
  }

  const uploadHandler = async (ctx) => {
    const reply = ctx.reply ?? deps.reply
    const type = parseCertType(ctx.text)
    if (!type) {
      if (reply) await reply('Which certification? (e.g. food handler, ServSafe, alcohol service)')
      return { ok: false, reason: 'unknown_type' }
    }
    await add(ctx.groupId, ctx.staffId ?? ctx.userId, { certType: type }, ctx.userId, deps.db ?? null)
    if (reply) await reply(`📋 Logged your *${type}* certification. Add the expiry date (and attach the file) in the dashboard so I can remind you before it lapses.`)
    return { ok: true, type }
  }

  registerCommand({ name: 'certs', role: 'any', help: 'List your certifications and their status', handler: listHandler })
  registerIntent({
    name: 'cert_upload',
    triggers: [/upload my .*cert/i, /add my .*cert/i, /my (food ?handler|serv ?safe|cpr) cert/i],
    promptHint: 'staff wants to log/upload a certification',
    handler: uploadHandler,
  })
}
