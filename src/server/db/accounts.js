import crypto from 'crypto'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

// ── Accounts ──────────────────────────────────────────────────────────────────

export async function getAccountByAuthId(authId) {
  try {
    const { data, error } = await getDb()
      .from('accounts')
      .select('*')
      .eq('id', authId)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAccountByAuthId failed: ${err.message}`)
    return null
  }
}

export const isProvisionalGroup = (id) => typeof id === 'string' && id.startsWith('web:')

// Ensure the account owns a group_id. Returns the group_id (provisional
// 'web:<accountId>' until a Telegram group is rekeyed onto it). Idempotent.
export async function ensureAccountGroup(accountId) {
  try {
    const existing = await getDb()
      .from('setup_sessions')
      .select('group_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (existing.data?.group_id) return existing.data.group_id
    const groupId = 'web:' + accountId
    await getDb()
      .from('setup_sessions')
      .insert({ group_id: groupId, account_id: accountId, setup_complete: false })
    return groupId
  } catch (err) {
    logger.error(`ensureAccountGroup failed: ${err.message}`)
    return null
  }
}

// Idempotent — backstop for the auth.users INSERT trigger (migration 010).
export async function ensureAccount(authId, email) {
  try {
    let account = await getAccountByAuthId(authId)
    if (!account) {
      const { data, error } = await getDb()
        .from('accounts')
        .upsert({ id: authId, email, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .select()
        .single()
      if (error) throw error
      account = data
    }
    await ensureAccountGroup(authId)
    return account
  } catch (err) {
    logger.error(`ensureAccount failed: ${err.message}`)
    return null
  }
}

export async function updateAccount(authId, updates) {
  try {
    const { data, error } = await getDb()
      .from('accounts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', authId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateAccount failed: ${err.message}`)
    return null
  }
}

// The account<->group bridge: the connected group for an account, if any.
export async function getLinkedGroup(accountId) {
  try {
    const { data, error } = await getDb()
      .from('setup_sessions')
      .select('group_id, group_name, setup_complete, setup_data')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getLinkedGroup failed: ${err.message}`)
    return null
  }
}

// The Telegram DM chat id for an account's owner, if reachable — used to deliver
// the login confirmation code. Prefers the connected group's recorded dm_chat_id,
// then falls back to the linked Telegram user's staff_dms entry.
export async function getAccountTelegramDm(accountId) {
  try {
    const { data: sess } = await getDb()
      .from('setup_sessions')
      .select('dm_chat_id')
      .eq('account_id', accountId)
      .not('dm_chat_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (sess?.dm_chat_id) return sess.dm_chat_id

    const { data: link } = await getDb()
      .from('account_links')
      .select('telegram_user_id')
      .eq('account_id', accountId)
      .not('telegram_user_id', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (link?.telegram_user_id) {
      const { data: dm } = await getDb()
        .from('staff_dms')
        .select('dm_chat_id')
        .eq('user_id', link.telegram_user_id)
        .maybeSingle()
      return dm?.dm_chat_id ?? null
    }
    return null
  } catch (err) {
    logger.error(`getAccountTelegramDm failed: ${err.message}`)
    return null
  }
}

// ── Account links (one-time deep-link codes) ─────────────────────────────────

function generateLinkCode() {
  // URL-safe, no ambiguous chars; prefixed so /start payloads are recognizable.
  return crypto.randomBytes(9).toString('base64url')
}

export async function createAccountLink(accountId, ttlMinutes = 60) {
  try {
    const code = generateLinkCode()
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString()
    const { data, error } = await getDb()
      .from('account_links')
      .insert({ account_id: accountId, code, expires_at: expiresAt })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`createAccountLink failed: ${err.message}`)
    return null
  }
}

export async function getAccountLinkByCode(code) {
  try {
    const { data, error } = await getDb()
      .from('account_links')
      .select('*')
      .eq('code', code)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAccountLinkByCode failed: ${err.message}`)
    return null
  }
}

// Bind a Telegram user to the account behind a (valid, unused) code.
// Returns { ok: true, account } or { ok: false, reason }.
export async function redeemAccountLink(code, telegramUserId) {
  try {
    const link = await getAccountLinkByCode(code)
    if (!link) return { ok: false, reason: 'not_found' }
    if (link.used_at) return { ok: false, reason: 'used' }
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return { ok: false, reason: 'expired' }
    }
    const { error } = await getDb()
      .from('account_links')
      .update({ telegram_user_id: telegramUserId, used_at: new Date().toISOString() })
      .eq('id', link.id)
    if (error) throw error
    const account = await getAccountByAuthId(link.account_id)
    return { ok: true, account }
  } catch (err) {
    logger.error(`redeemAccountLink failed: ${err.message}`)
    return { ok: false, reason: 'error' }
  }
}

// Resolve the account a Telegram user has linked to (most recent redeemed link).
export async function getAccountByTelegramUser(telegramUserId) {
  try {
    const { data, error } = await getDb()
      .from('account_links')
      .select('account_id, used_at')
      .eq('telegram_user_id', telegramUserId)
      .not('used_at', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    return await getAccountByAuthId(data.account_id)
  } catch (err) {
    logger.error(`getAccountByTelegramUser failed: ${err.message}`)
    return null
  }
}
