// Scoped API keys (Epic 7 / WP-7.4).
//
// generateKey returns the plaintext ONCE; only its sha256 hash is stored.
// validateKey hashes the presented key, looks it up, and checks scope + not
// revoked. Pure crypto + db-mockable, so the auth logic is testable without a DB.

import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

const hashKey = (plaintext) => crypto.createHash('sha256').update(String(plaintext)).digest('hex')

/** Create a new key. Returns { plaintext (show once), saved }. */
export async function generateKey(groupId, scopes = [], db = null) {
  const plaintext = `relay_${crypto.randomBytes(24).toString('hex')}`
  const row = { group_id: String(groupId), key_hash: hashKey(plaintext), scopes, created_at: new Date().toISOString() }
  let saved
  if (db?.insertApiKey) saved = await db.insertApiKey(row)
  else {
    try {
      const { data, error } = await getDb().from('api_keys').insert([row]).select().single()
      if (error) { logger.error(`generateKey failed: ${error.message}`); return null }
      saved = data
    } catch (err) { logger.error(`generateKey error: ${err.message}`); return null }
  }
  await logEvent({ groupId, actorType: 'system', action: 'apikey.create', meta: { scopes } }, db)
  return { plaintext, saved }
}

/** Validate a presented key for a required scope. */
export async function validateKey(plaintext, requiredScope = null, db = null) {
  if (!plaintext) return { valid: false, reason: 'missing' }
  const hash = hashKey(plaintext)
  let row
  if (db?.getApiKeyByHash) row = await db.getApiKeyByHash(hash)
  else {
    try {
      const { data, error } = await getDb().from('api_keys').select('*').eq('key_hash', hash).maybeSingle()
      if (error) { logger.error(`validateKey failed: ${error.message}`); return { valid: false, reason: 'error' } }
      row = data
    } catch (err) { logger.error(`validateKey error: ${err.message}`); return { valid: false, reason: 'error' } }
  }
  if (!row) return { valid: false, reason: 'unknown' }
  if (row.revoked_at) return { valid: false, reason: 'revoked' }
  if (requiredScope && !(row.scopes ?? []).includes(requiredScope)) return { valid: false, reason: 'scope' }
  return { valid: true, groupId: row.group_id, scopes: row.scopes ?? [] }
}

/** Revoke a key by its hash. */
export async function revokeKey(keyHash, groupId = null, db = null) {
  const at = new Date().toISOString()
  if (db?.revokeApiKey) { await db.revokeApiKey(keyHash, at); return { ok: true } }
  try {
    const { error } = await getDb().from('api_keys').update({ revoked_at: at }).eq('key_hash', keyHash)
    if (error) { logger.error(`revokeKey failed: ${error.message}`); return { ok: false } }
    if (groupId) await logEvent({ groupId, actorType: 'system', action: 'apikey.revoke' }, db)
    return { ok: true }
  } catch (err) { logger.error(`revokeKey error: ${err.message}`); return { ok: false } }
}
