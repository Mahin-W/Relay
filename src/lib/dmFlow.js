// Generic multi-step DM wizard (Epic 0 / WP-0.2).
//
// Generalizes the setup_sessions "stage" pattern (see setup/overtimeSteps.js):
// a flow is an ordered list of steps; each reply is parsed/validated, stored,
// and advances to the next step until completion.
//
// RESTART-SAFE: flow DEFINITIONS (including their onComplete handler) live in
// code and are registered once at startup via defineFlow(). A dm_flow_sessions
// row only holds collected answers + the step index — never a closure — so an
// in-flight wizard survives a process restart.
//
// Wiring (done when the first consumer needs it): the DM router calls
// handleFlowInput({ recipientId, text }) for any DM that isn't a command, and
// if it returns { handled:true } the message was consumed by an active flow.
//
//   defineFlow('payrun_confirm', {
//     steps: [ confirmStep('ok', 'Pay 6 staff, $4,210 from your account? (yes/no)') ],
//     onComplete: async (answers, ctx) => answers.ok ? runPayRun(ctx) : null,
//   })
//   await startFlow({ recipientId, groupId, flowName: 'payrun_confirm', context })

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { notify } from './notify.js'

const flows = new Map() // name -> { steps, onComplete?, completeMessage? }

// ── definition API ────────────────────────────────────────────────────────────
export function defineFlow(name, def) {
  if (!name || !def?.steps?.length) throw new Error('defineFlow: name and non-empty steps required')
  flows.set(name, def)
}
export function getFlow(name) { return flows.get(name) ?? null }
export function _resetFlowsForTesting() { flows.clear() }

/** A ready-made yes/no step. parse → true/false, or null (re-prompts). */
export function confirmStep(key, prompt, errorPrompt = 'Please reply *yes* or *no*.') {
  return { key, prompt, parse: parseYesNo, errorPrompt }
}

/** Parse an affirmative/negative reply. Returns true | false | null. */
export function parseYesNo(text) {
  const t = String(text ?? '').toLowerCase().trim()
  if (!t) return null
  if (/^(y|ye|yes|yea|yeah|yep|yup|sure|ok|okay|✅|👍|confirm|do it)$/.test(t)) return true
  if (/^(n|no|nope|nah|cancel|❌|stop|don'?t)$/.test(t)) return false
  return null
}

// ── pure reducer (no DB / no bot) ─────────────────────────────────────────────
// Given a flow def, the current session, and the user's reply, decide what
// happens next. Returns one of:
//   { invalid:true, reply }                              -> stay on step, re-prompt
//   { invalid:false, status:'active', stepIndex, answers, reply }
//   { invalid:false, status:'complete', answers, reply } -> run onComplete
export function applyFlowInput(flowDef, session, text) {
  const step = flowDef.steps[session.step_index]
  if (!step) return { invalid: true, reply: 'This conversation has already finished.' }

  const value = step.parse ? step.parse(text) : text
  if (step.parse && (value === null || value === undefined)) {
    return { invalid: true, reply: resolvePrompt(step.errorPrompt ?? 'Please try again.', session) }
  }

  const answers = { ...session.answers, [step.key]: value }
  const nextIndex = session.step_index + 1

  if (nextIndex >= flowDef.steps.length) {
    return { invalid: false, status: 'complete', answers, reply: flowDef.completeMessage ?? null }
  }
  const nextStep = flowDef.steps[nextIndex]
  return {
    invalid: false,
    status: 'active',
    stepIndex: nextIndex,
    answers,
    reply: resolvePrompt(nextStep.prompt, { ...session, answers }),
  }
}

function resolvePrompt(prompt, session) {
  return typeof prompt === 'function'
    ? prompt({ answers: session.answers ?? {}, context: session.context ?? {} })
    : prompt
}

// ── wired operations ──────────────────────────────────────────────────────────
/** Start a flow and send its first prompt. */
export async function startFlow({ recipientId, groupId = null, flowName, context = {} }, deps = {}) {
  const flowDef = getFlow(flowName)
  if (!flowDef) { logger.error(`startFlow: unknown flow '${flowName}'`); return { ok: false } }
  const store = deps.store ?? defaultStore
  const send = deps.send ?? notify

  const session = await store.create({ recipientId: String(recipientId), groupId: groupId != null ? String(groupId) : null, flowName, context })
  if (!session) { logger.error(`startFlow: failed to persist session for flow '${flowName}'`); return { ok: false } }
  const firstPrompt = resolvePrompt(flowDef.steps[0].prompt, { answers: {}, context })
  await send(recipientId, firstPrompt, { parse_mode: 'Markdown' })
  return { ok: true }
}

/** Feed a DM reply into the recipient's active flow, if any. */
export async function handleFlowInput({ recipientId, text }, deps = {}) {
  const store = deps.store ?? defaultStore
  const send = deps.send ?? notify

  const session = await store.getActive(String(recipientId))
  if (!session) return { handled: false }

  const flowDef = getFlow(session.flow_name)
  if (!flowDef) { logger.error(`handleFlowInput: session references unknown flow '${session.flow_name}'`); return { handled: false } }

  const result = applyFlowInput(flowDef, session, text)

  if (result.invalid) {
    await send(recipientId, result.reply, { parse_mode: 'Markdown' })
    return { handled: true, status: 'active' }
  }

  if (result.status === 'complete') {
    // Mark complete first so a re-reply can't double-process (money safety),
    // then run onComplete. Only claim success to the user if it actually ran.
    await store.update(session.id, { status: 'complete', answers: result.answers })
    if (flowDef.onComplete) {
      try {
        await flowDef.onComplete(result.answers, session.context ?? {}, { recipientId, groupId: session.group_id })
      } catch (err) {
        logger.error(`flow '${session.flow_name}' onComplete failed: ${err.message}`)
        await send(recipientId, '⚠️ Something went wrong completing that — please try again.', { parse_mode: 'Markdown' })
        return { handled: true, status: 'error', error: err.message }
      }
    }
    if (result.reply) await send(recipientId, result.reply, { parse_mode: 'Markdown' })
    return { handled: true, status: 'complete', answers: result.answers }
  }

  await store.update(session.id, { step_index: result.stepIndex, answers: result.answers })
  if (result.reply) await send(recipientId, result.reply, { parse_mode: 'Markdown' })
  return { handled: true, status: 'active' }
}

/** Cancel a recipient's active flow. */
export async function cancelFlow(recipientId, deps = {}) {
  const store = deps.store ?? defaultStore
  const session = await store.getActive(String(recipientId))
  if (session) await store.update(session.id, { status: 'cancelled' })
  return { cancelled: !!session }
}

// ── default Supabase-backed store ─────────────────────────────────────────────
const defaultStore = {
  async create({ recipientId, groupId, flowName, context }) {
    // Enforce one active flow: cancel any existing active one first.
    await getDb().from('dm_flow_sessions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('recipient_id', recipientId).eq('status', 'active')
    const { data, error } = await getDb().from('dm_flow_sessions')
      .insert([{ recipient_id: recipientId, group_id: groupId, flow_name: flowName, step_index: 0, answers: {}, context, status: 'active' }])
      .select().single()
    if (error) { logger.error(`dmFlow create failed: ${error.message}`); return null }
    return data
  },
  async getActive(recipientId) {
    const { data, error } = await getDb().from('dm_flow_sessions')
      .select('*').eq('recipient_id', recipientId).eq('status', 'active').maybeSingle()
    if (error) { logger.error(`dmFlow getActive failed: ${error.message}`); return null }
    return data ?? null
  },
  async update(id, fields) {
    const { error } = await getDb().from('dm_flow_sessions')
      .update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) logger.error(`dmFlow update failed: ${error.message}`)
  },
}
