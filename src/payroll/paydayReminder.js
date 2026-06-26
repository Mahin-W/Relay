// Payday reminders (Epic 2 / WP-2.3).
//
// Owner controls pay timing (no auto-run), so this only NUDGES: on payday (or
// `leadDays` before), DM the owner to run payroll. The decision is a pure fn so
// it's deterministic and testable; the runner does the notify.

import { logger } from '../logger.js'
import { notifyGroup } from '../lib/notify.js'

/**
 * Pure: should we send the payday nudge today?
 * @param {string} today  - 'YYYY-MM-DD'
 * @param {string} payday - 'YYYY-MM-DD'
 * @param {object} [opts] - { alreadySent=false, leadDays=0 }
 */
export function shouldRemindPayday(today, payday, opts = {}) {
  const { alreadySent = false, leadDays = 0 } = opts
  if (alreadySent || !today || !payday) return false
  const t = new Date(`${today}T00:00:00Z`)
  const p = new Date(`${payday}T00:00:00Z`)
  if (isNaN(t.getTime()) || isNaN(p.getTime())) return false
  const target = new Date(p.getTime() - leadDays * 86400000)
  return t.getTime() === target.getTime()
}

/**
 * Notify the owner if it's time. deps: { send }.
 * @returns {Promise<{reminded:boolean}>}
 */
export async function runPaydayReminder({ ownerDm, today, payday, alreadySent = false, leadDays = 0 }, deps = {}) {
  try {
    if (!shouldRemindPayday(today, payday, { alreadySent, leadDays })) return { reminded: false }
    const send = deps.send ?? notifyGroup
    if (ownerDm) await send(ownerDm, `📅 Payday is ${payday}. Run payroll when you're ready: /paypeople`, {})
    return { reminded: true }
  } catch (err) {
    logger.error(`runPaydayReminder failed: ${err.message}`)
    return { reminded: false }
  }
}
