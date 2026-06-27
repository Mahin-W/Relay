// New-hire onboarding checklist (Epic 5 / WP-5.3).
//
// A chat-native onboarding flow: the new hire confirms their details, then gets
// a checklist nudging them to set up direct deposit (/setuppay) and upload certs
// (/certs). Pure checklist builder + a dmFlow confirm; status is derived from the
// bank/cert features built earlier.

import { registerCommand } from '../lib/commandRegistry.js'
import { defineFlow, confirmStep, startFlow } from '../lib/dmFlow.js'

export const ONBOARDING_FLOW = 'onboarding_confirm'

const STEPS = [
  { key: 'details', label: 'Confirm your details' },
  { key: 'directDeposit', label: 'Set up direct deposit (/setuppay)' },
  { key: 'certs', label: 'Upload required certifications (/certs)' },
]

/** Pure: build the checklist with per-step done flags. */
export function buildChecklist({ detailsConfirmed = false, hasBankAccount = false, hasCerts = false } = {}) {
  const done = { details: detailsConfirmed, directDeposit: hasBankAccount, certs: hasCerts }
  return STEPS.map(s => ({ key: s.key, label: s.label, done: !!done[s.key] }))
}

export function formatChecklist(checklist) {
  const lines = checklist.map(c => `${c.done ? '✅' : '⬜'} ${c.label}`)
  const remaining = checklist.filter(c => !c.done).length
  return `📋 *Onboarding*\n${lines.join('\n')}${remaining === 0 ? '\n\nAll done — welcome aboard! 🎉' : ''}`
}

export async function onOnboardingComplete(answers, context, _meta, deps = {}) {
  const send = deps.send
  const to = context.recipientId ?? context.staffId
  if (!answers.confirmed) {
    if (send) await send(to, 'No problem — ping your manager if anything looks off.', {})
    return { confirmed: false }
  }
  const checklist = buildChecklist({ detailsConfirmed: true })
  if (send) await send(to, `${formatChecklist(checklist)}\n\nNext: */setuppay* for direct deposit, then */certs* to add your certifications.`, {})
  return { confirmed: true }
}

export function registerOnboardingFeature(deps = {}) {
  const start = deps.startFlow ?? startFlow

  defineFlow(ONBOARDING_FLOW, {
    steps: [confirmStep('confirmed', ({ context }) =>
      `Welcome${context.name ? ` ${context.name}` : ''}! You're set up as *${context.role || 'staff'}*. Ready to finish onboarding? (yes/no)`)],
    onComplete: (answers, context, meta) => onOnboardingComplete(answers, context, meta, deps.confirmDeps ?? {}),
  })

  registerCommand({
    name: 'onboarding',
    role: 'any',
    help: 'Start/resume your onboarding checklist',
    handler: (ctx) => start({
      recipientId: ctx.staffId ?? ctx.userId,
      groupId: ctx.groupId,
      flowName: ONBOARDING_FLOW,
      context: { staffId: ctx.staffId ?? ctx.userId, recipientId: ctx.staffId ?? ctx.userId, name: ctx.name, role: ctx.role },
    }, deps.flowDeps ?? {}),
  })
}
