// PTO dual-surface (Epic 6 / WP-6.2).
//   • Chat NL: intent 'pto_balance_query' ("how much PTO do I have")
//   • Command: /pto
//   • Dashboard: call getBalance() from a route.

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { getBalance } from './ptoAccrual.js'
import { logger } from '../logger.js'

export function registerPtoFeature(deps = {}) {
  const balanceOf = deps.getBalance ?? getBalance

  const handler = async (ctx) => {
    const reply = ctx.reply ?? deps.reply
    try {
      const hours = await balanceOf(ctx.groupId, ctx.staffId ?? ctx.userId, deps.db ?? null)
      if (reply) await reply(`🌴 You have *${Number(hours).toFixed(1)} hours* of PTO available.`)
      return { ok: true, hours }
    } catch (err) {
      logger.error(`pto handler failed: ${err.message}`)
      if (reply) await reply('Could not load your PTO balance — please try again.')
      return { ok: false }
    }
  }

  registerCommand({ name: 'pto', role: 'any', help: 'Check your PTO balance', handler })
  registerIntent({
    name: 'pto_balance_query',
    triggers: [/how much (pto|vacation|time off)/i, /my pto/i, /pto balance/i, /vacation balance/i],
    promptHint: 'staff asking their PTO/vacation balance',
    handler,
  })
}
