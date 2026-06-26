// Channel-agnostic notification fan-out (Epic 0 / WP-0.3).
//
// One place to send a message to a staff member regardless of platform.
// Channels register a sender at startup; recipients are resolved through the
// platform_contacts table. Telegram is the only channel today — SMS/WhatsApp
// drop in later with ZERO changes to any caller (WP-7.1/7.2).
//
// Wiring (done once at bot startup, e.g. in index.js):
//   import { registerChannel } from './lib/notify.js'
//   registerChannel('telegram', (chatId, text, opts) => bot.sendMessage(chatId, text, opts))
//
// This is for NEW notifications. Existing bot.sendMessage call sites are left
// untouched; new epics call notify()/notifyGroup() exclusively.

import { getDb } from '../db.js'
import { logger } from '../logger.js'

// Lowest index wins when a staff member has contacts on multiple platforms,
// so we deliver once via the most reliable channel they have.
const PLATFORM_PRIORITY = ['telegram', 'sms', 'whatsapp']

const channels = new Map() // platform -> (chatId, text, opts) => Promise

/** Register a platform sender (called once at startup). */
export function registerChannel(platform, sendFn) {
  if (!platform || typeof sendFn !== 'function') {
    throw new Error('registerChannel: platform and a sendFn are required')
  }
  channels.set(platform, sendFn)
}

export function hasChannel(platform) { return channels.has(platform) }

/** Test isolation — clear registered channels. */
export function _resetChannelsForTesting() { channels.clear() }

/**
 * Notify a single staff member on their best available channel.
 * @param {string|number} staffId  - staff table id (resolved via platform_contacts)
 * @param {string} message
 * @param {object} [opts]          - passed through to the channel sender (e.g. parse_mode)
 * @param {object|null} [db]       - mock for tests (getContactsForStaff)
 * @returns {Promise<{delivered:boolean, platform?:string, error?:string}>}
 */
export async function notify(staffId, message, opts = {}, db = null) {
  if (!staffId || !message) {
    logger.error('notify: staffId and message are required')
    return { delivered: false }
  }
  const contacts = await resolveContacts(staffId, db)
  if (contacts.length === 0) {
    logger.bot(`notify: no contacts for staff ${staffId}`)
    return { delivered: false }
  }
  for (const platform of PLATFORM_PRIORITY) {
    const contact = contacts.find(c => c.platform === platform)
    if (contact && channels.has(platform)) {
      try {
        await channels.get(platform)(contact.chatId, message, opts)
        return { delivered: true, platform }
      } catch (err) {
        logger.error(`notify via ${platform} failed for staff ${staffId}: ${err.message}`)
        return { delivered: false, platform, error: err.message }
      }
    }
  }
  logger.bot(`notify: no registered channel matches staff ${staffId}'s contacts`)
  return { delivered: false }
}

/**
 * Notify a whole group (Telegram group chat).
 * @param {string|number} groupId  - the Telegram chat id
 */
export async function notifyGroup(groupId, message, opts = {}) {
  if (!groupId || !message) {
    logger.error('notifyGroup: groupId and message are required')
    return { delivered: false }
  }
  const send = channels.get('telegram')
  if (!send) {
    logger.error('notifyGroup: telegram channel not registered')
    return { delivered: false }
  }
  try {
    await send(groupId, message, opts)
    return { delivered: true, platform: 'telegram' }
  } catch (err) {
    logger.error(`notifyGroup failed for ${groupId}: ${err.message}`)
    return { delivered: false, error: err.message }
  }
}

// ── internal ──────────────────────────────────────────────────────────────────
// Resolve a staff member's reachable contacts. platform_contacts is the
// forward-looking multi-channel table (populated by payout onboarding etc.);
// until a staff member has a row there, fall back to the legacy Telegram path
// (staff_members → staff_dms) so existing staff are still reachable today.
// (Channel send still goes through the registry; converge with platform/UnifiedBot later.)
async function resolveContacts(staffId, db) {
  if (db?.getContactsForStaff) return db.getContactsForStaff(staffId)
  try {
    const { data, error } = await getDb()
      .from('platform_contacts')
      .select('platform, platform_user_id, platform_chat_id')
      .eq('staff_id', staffId)
    if (error) logger.error(`resolveContacts (platform_contacts) failed: ${error.message}`)
    const contacts = (data ?? []).map(r => ({
      platform: r.platform,
      chatId: r.platform_chat_id || r.platform_user_id,
    }))
    if (contacts.length > 0) return contacts
    return await resolveTelegramFallback(staffId)
  } catch (err) {
    logger.error(`resolveContacts error: ${err.message}`)
    return []
  }
}

async function resolveTelegramFallback(staffId) {
  try {
    const { data: sm } = await getDb()
      .from('staff_members').select('telegram_id').eq('staff_id', staffId).limit(1)
    const tgId = sm?.[0]?.telegram_id
    if (!tgId) return []
    const { data: dm } = await getDb()
      .from('staff_dms').select('dm_chat_id').eq('user_id', tgId).maybeSingle()
    if (!dm?.dm_chat_id) return []
    return [{ platform: 'telegram', chatId: String(dm.dm_chat_id) }]
  } catch (err) {
    logger.error(`notify telegram fallback failed: ${err.message}`)
    return []
  }
}
