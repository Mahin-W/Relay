// Pay stub dual-surface (Epic 2 / WP-2.1).
//   • Command:  /paystub (role 'any')
//   • Chat NL:  intent 'pay_stub_request' ("my pay stub")
//   • Dashboard: call the formatter from a route.
// Delivers the staff member's latest stub by reply/DM.

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { formatPayStub } from './payStub.js'
import { getPayrollHistory } from './payDb.js'
import { logger } from '../logger.js'

export function registerPayStubFeature(deps = {}) {
  const getLatest = deps.getLatestPayroll ?? (async (staffId, groupId) => {
    const hist = await getPayrollHistory(staffId, groupId, 1, deps.db ?? null)
    return hist?.[0] ?? null
  })

  const handler = async (ctx) => {
    const reply = ctx.reply ?? deps.reply
    try {
      const record = await getLatest(ctx.staffId ?? ctx.userId, ctx.groupId)
      const stub = formatPayStub(record, { name: ctx.name })
      if (reply) await reply(stub)
      return { ok: true, hasData: !!record }
    } catch (err) {
      logger.error(`payStub handler failed: ${err.message}`)
      if (reply) await reply('Could not load your pay stub — please try again.')
      return { ok: false }
    }
  }

  registerCommand({ name: 'paystub', role: 'any', help: 'Get your latest pay stub', handler })
  registerIntent({
    name: 'pay_stub_request',
    triggers: [/pay ?stub/i, /my paystub/i, /send my pay stub/i],
    promptHint: 'staff wants their pay stub',
    handler,
  })
}
