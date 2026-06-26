// Command registry (Epic 0 / WP-0.1) — ADDITIVE.
//
// New slash commands (/paypeople, /payrollsettings, /certs, ...) register here
// declaratively instead of growing the if-chain in routing/commandRouter.js.
// The registry is consulted as a FALLBACK: the existing handleGroupCommands()
// runs first and unchanged; only if it returns false does the router try
// dispatchCommand(). Empty registry → no behavior change.
//
// Role checks are pluggable: the caller passes deps.isAuthorized(role) so the
// registry stays decoupled from the bot's auth specifics.

import { logger } from '../logger.js'

const commands = new Map()
const aliasMap = new Map()

/**
 * @param {object} def
 * @param {string} def.name                 - command name without slash
 * @param {string[]} [def.aliases]
 * @param {'any'|'owner'|'admin'} [def.role] - required role (default 'any')
 * @param {(ctx:object)=>Promise<void>} def.handler
 * @param {string} [def.help]               - one-line help text
 */
export function registerCommand(def) {
  if (!def?.name || typeof def.handler !== 'function') {
    throw new Error('registerCommand: name and a handler function are required')
  }
  commands.set(def.name, def)
  for (const a of def.aliases ?? []) aliasMap.set(a, def.name)
}

export function getCommand(name) {
  if (commands.has(name)) return commands.get(name)
  if (aliasMap.has(name)) return commands.get(aliasMap.get(name))
  return null
}
export function listCommands() { return [...commands.values()] }
export function _resetCommandsForTesting() { commands.clear(); aliasMap.clear() }

/**
 * Dispatch a slash command if registered.
 * @param {string} name
 * @param {object} [ctx]   - passed to the handler
 * @param {object} [deps]  - { isAuthorized(role)->bool, reply(text) }
 * @returns {Promise<{handled:boolean, denied?:boolean}>}
 */
export async function dispatchCommand(name, ctx = {}, deps = {}) {
  const entry = getCommand(name)
  if (!entry) return { handled: false }

  const role = entry.role ?? 'any'
  if (role !== 'any') {
    // Fail CLOSED: a role-restricted command must never run without a way to
    // verify the caller. Missing isAuthorized = deny, not allow.
    if (typeof deps.isAuthorized !== 'function') {
      logger.error(`dispatchCommand: '/${name}' requires role '${role}' but no isAuthorized was provided — denying`)
      if (deps.reply) await deps.reply(`⚠️ You don't have permission to use /${name}.`)
      return { handled: true, denied: true }
    }
    const ok = await deps.isAuthorized(role)
    if (!ok) {
      if (deps.reply) await deps.reply(`⚠️ You don't have permission to use /${name}.`)
      return { handled: true, denied: true }
    }
  }
  await entry.handler(ctx)
  return { handled: true }
}

/** Help block for the registered commands (for /commands augmentation). */
export function formatCommandHelp() {
  return listCommands()
    .filter(c => c.help)
    .map(c => `• /${c.name} — ${c.help}`)
    .join('\n')
}
