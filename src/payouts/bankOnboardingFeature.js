// Direct-deposit onboarding dual-surface (Epic 1 / WP-1.2).
//
// Staff set up their own bank for pay from any surface:
//   • Command:  /setuppay (role 'any' — each staff onboards themselves)
//   • Chat NL:  intent 'direct_deposit_setup' ("set up my direct deposit")
//   • Dashboard: call startOnboarding() from a route.
// Delivers the provider's hosted onboarding link by DM, or a graceful message
// when payouts aren't configured for the workplace yet.

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { startOnboarding } from './bankOnboarding.js'

export function registerBankOnboardingFeature(deps = {}) {
  const start = deps.startOnboarding ?? startOnboarding

  const handler = async (ctx) => {
    const res = await start({ groupId: ctx.groupId, staffId: ctx.staffId ?? ctx.userId }, deps.startDeps ?? {})
    const reply = ctx.reply ?? deps.reply
    if (reply) {
      if (res.ok) await reply(`🏦 Set up your direct deposit here:\n${res.link}`)
      else if (res.reason === 'not_configured') await reply(`Direct deposit isn't enabled for your workplace yet — your manager needs to turn on payouts.`)
      else await reply(`Something went wrong starting direct-deposit setup — please try again.`)
    }
    return res
  }

  registerCommand({
    name: 'setuppay',
    role: 'any',
    help: 'Set up your direct deposit (bank) for pay',
    handler,
  })

  registerIntent({
    name: 'direct_deposit_setup',
    triggers: [/set up my (direct deposit|bank|pay)/i, /add my bank/i, /direct deposit/i],
    promptHint: 'staff wants to set up direct deposit',
    handler,
  })
}
