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

// Idempotent — backstop for the auth.users INSERT trigger (migration 010).
export async function ensureAccount(authId, email) {
  try {
    const existing = await getAccountByAuthId(authId)
    if (existing) return existing
    const { data, error } = await getDb()
      .from('accounts')
      .upsert({ id: authId, email, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      .select()
      .single()
    if (error) throw error
    return data
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

// Merge a patch into the staging setup_data JSONB (read-modify-write).
export async function updateAccountSetupData(authId, patch) {
  try {
    const account = await getAccountByAuthId(authId)
    if (!account) return null
    const merged = { ...(account.setup_data || {}), ...patch }
    return await updateAccount(authId, { setup_data: merged })
  } catch (err) {
    logger.error(`updateAccountSetupData failed: ${err.message}`)
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
