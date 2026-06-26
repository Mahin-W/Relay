// Intent registry (Epic 0 / WP-0.1) — ADDITIVE.
//
// New feature intents (tip/pay-run, pto query, payroll settings, ...) register
// here WITHOUT touching the carefully-tuned 14-intent SYSTEM_PROMPT in
// messageParsers.js. Matching is trigger-based (regex/keyword) so the common
// "pay everyone", "how much PTO", "set Maria to 1099" cases resolve with NO
// extra LLM call. The registry starts empty, so wiring it into the router is a
// zero-behavior-change addition until features register intents.
//
// Wiring (later, one line in groupRouter/dmRouter): after a message isn't a
// command, call matchIntent(text); if it returns a hit, dispatchIntent(name).

const intents = new Map()

/**
 * @param {object} def
 * @param {string} def.name              - intent name (e.g. 'pay_run_request')
 * @param {(RegExp|string)[]} def.triggers - regex or case-insensitive substrings
 * @param {(text:string)=>object} [def.extract] - pull fields from the text
 * @param {(ctx:object)=>Promise<void>} [def.handler] - dispatch handler
 * @param {string} [def.promptHint]      - optional hint for future LLM augmentation
 */
export function registerIntent(def) {
  if (!def?.name || !Array.isArray(def.triggers) || def.triggers.length === 0) {
    throw new Error('registerIntent: name and a non-empty triggers array are required')
  }
  intents.set(def.name, def)
}

export function getIntent(name) { return intents.get(name) ?? null }
export function listIntents() { return [...intents.values()] }
export function _resetIntentsForTesting() { intents.clear() }

function triggerMatches(trigger, text) {
  if (trigger instanceof RegExp) {
    trigger.lastIndex = 0 // a /g or /y trigger is stateful across .test() calls
    return trigger.test(text)
  }
  return text.toLowerCase().includes(String(trigger).toLowerCase())
}

/**
 * First registered intent whose trigger matches. Pure, no LLM.
 * @returns {{name:string, fields:object}|null}
 */
export function matchIntent(text) {
  const t = String(text ?? '')
  if (!t.trim()) return null
  for (const intent of intents.values()) {
    if (intent.triggers.some(trig => triggerMatches(trig, t))) {
      const fields = intent.extract ? (intent.extract(t) ?? {}) : {}
      return { name: intent.name, fields }
    }
  }
  return null
}

/** Run a registered intent's handler. */
export async function dispatchIntent(name, ctx = {}) {
  const intent = intents.get(name)
  if (!intent?.handler) return { handled: false }
  await intent.handler(ctx)
  return { handled: true }
}

/**
 * Optional prompt fragment for LLM-based augmentation. Empty when nothing is
 * registered, so callers that append it see no change to base behavior.
 */
export function buildIntentPromptSection() {
  const hinted = listIntents().filter(i => i.promptHint)
  if (hinted.length === 0) return ''
  return ['', 'ADDITIONAL INTENTS (registered features):',
    ...hinted.map(i => `- ${i.name}: ${i.promptHint}`)].join('\n')
}
