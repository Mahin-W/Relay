// Pay-run dual-surface wiring (Epic 1 / WP-1.4).
//
// One service, three surfaces — all funnel through the same assemble → confirm
// → run path:
//   • Dashboard: call startPayRun() from a route.
//   • Chat NL:   intent 'pay_run_request' ("pay everyone", "run payroll").
//   • Command:   /paypeople (owner-only).
// The owner confirms in a DM (payrun_confirm flow). The assembled line items
// are frozen into the flow context at preview time, so the run pays EXACTLY
// what was shown — no re-assembly drift between preview and confirmation.

import { registerIntent } from '../parsers/intentRegistry.js'
import { registerCommand } from '../lib/commandRegistry.js'
import { defineFlow, confirmStep, startFlow } from '../lib/dmFlow.js'
import { assemblePayRun } from './payRunAssembler.js'
import { runPayRun } from './payRunEngine.js'
import { logger } from '../logger.js'

export const PAY_RUN_FLOW = 'payrun_confirm'

/**
 * Assemble the week's pay run, then open the owner confirm flow with a preview.
 * @param {object} p - { groupId, weekStart, initiatedBy, recipientId }
 * @param {object} [deps] - { assemble, startFlow, assembleDeps, flowDeps, reply }
 */
export async function startPayRun({ groupId, weekStart, initiatedBy, recipientId }, deps = {}) {
  const assemble = deps.assemble ?? assemblePayRun
  const start = deps.startFlow ?? startFlow
  const assembly = await assemble(groupId, weekStart, deps.assembleDeps ?? {})

  if (!assembly.items || assembly.items.length === 0) {
    if (deps.reply) await deps.reply(assembly.preview)
    return { ok: false, reason: 'nothing_to_pay', preview: assembly.preview }
  }

  await start({
    recipientId: recipientId ?? initiatedBy,
    groupId,
    flowName: PAY_RUN_FLOW,
    context: {
      groupId: String(groupId),
      weekStart: weekStart ?? null,
      initiatedBy: initiatedBy != null ? String(initiatedBy) : null,
      items: assembly.items,
      totalCents: assembly.totalCents,
      preview: assembly.preview,
    },
  }, deps.flowDeps ?? {})
  return { ok: true, preview: assembly.preview }
}

/** onComplete for the confirm flow: run (or cancel) the frozen pay run. */
export async function onPayRunConfirm(answers, context, _meta, deps = {}) {
  if (!answers.ok) {
    logger.bot(`pay run cancelled by ${context.initiatedBy}`)
    return { ran: false, cancelled: true }
  }
  const run = deps.runPayRun ?? runPayRun
  const result = await run({
    groupId: context.groupId,
    weekStart: context.weekStart,
    items: context.items,
    initiatedBy: context.initiatedBy,
  }, deps.runDeps ?? {})
  return { ran: true, result }
}

/** Register intent + command + flow. Call once at startup. */
export function registerPayRunFeature(deps = {}) {
  const start = deps.startPayRun ?? startPayRun

  defineFlow(PAY_RUN_FLOW, {
    steps: [confirmStep('ok', ({ context }) => `${context.preview}\n\nSend these payments from your account? (yes/no)`)],
    onComplete: (answers, context, meta) => onPayRunConfirm(answers, context, meta, deps.confirmDeps ?? {}),
  })

  const handler = (ctx) => start({
    groupId: ctx.groupId,
    weekStart: ctx.weekStart,
    initiatedBy: ctx.userId,
    recipientId: ctx.recipientId ?? ctx.userId,
  }, deps.startDeps ?? {})

  registerIntent({
    name: 'pay_run_request',
    triggers: [/pay (everyone|the team|staff|everybody|people)/i, /send out paychecks/i, /run payroll/i],
    promptHint: 'owner wants to run payroll / pay the team',
    handler,
  })

  registerCommand({
    name: 'paypeople',
    aliases: ['runpayroll'],
    role: 'owner',
    help: 'Run payroll — pay wages + non-cash tips to the team',
    handler,
  })
}
