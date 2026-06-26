// Idempotency guard (Epic 0 / WP-0.4).
//
// withIdempotency(key, fn) runs `fn` at most once per key. A completed run
// caches its result so a replay returns it without re-executing. If a previous
// attempt is still in flight (or crashed mid-run) the call throws
// IdempotencyInProgressError rather than risk double-executing a money move.
//
// This is a guard layer, NOT the only safety net: money operations also pass a
// provider-level idempotency key and keep their own ledger (WP-1.3). On fn
// failure the claim is released so a deliberate retry can re-run.
//
// Complements (does NOT replace) the lighter reminder_sends dedup in
// reminders/shiftReminders.js — use that for best-effort "did we already send
// this" checks; use withIdempotency when you need result caching + in-progress
// detection for an at-most-once money/external op. The default store hits
// Supabase; tests pass a `db` mock implementing get/claim/complete/fail.
//
// Failure mode note: if fn() succeeds but complete() can't persist, the key
// stays 'pending'. That is the SAFE direction for money (future calls get
// IdempotencyInProgressError rather than risk a re-run) — but it is logged
// loudly for manual reconcile, never swallowed silently.

import { getDb } from '../db.js'
import { logger } from '../logger.js'

export class IdempotencyInProgressError extends Error {
  constructor(key) {
    super(`Operation already in progress for idempotency key: ${key}`)
    this.name = 'IdempotencyInProgressError'
    this.code = 'IDEMPOTENT_IN_PROGRESS'
    this.key = key
  }
}

/**
 * Run `fn` at most once per `key`.
 * @param {string} key - stable, caller-chosen idempotency key
 * @param {() => Promise<any>} fn - the operation to guard
 * @param {object|null} [db] - mock store for tests
 * @returns {Promise<any>} fn's result (fresh on first run, cached on replay)
 * @throws {IdempotencyInProgressError} if a prior attempt is still pending
 */
export async function withIdempotency(key, fn, db = null) {
  if (!key) throw new Error('withIdempotency: key required')
  if (typeof fn !== 'function') throw new Error('withIdempotency: fn must be a function')
  const store = makeStore(db)

  const existing = await store.get(key)
  if (existing) {
    if (existing.status === 'completed') {
      logger.bot(`[idempotency] replay ${key} → cached result`)
      return existing.result
    }
    throw new IdempotencyInProgressError(key)
  }

  const claimed = await store.claim(key)
  if (!claimed) {
    // Lost a race between get() and claim() — re-check.
    const now = await store.get(key)
    if (now?.status === 'completed') return now.result
    throw new IdempotencyInProgressError(key)
  }

  try {
    const result = await fn()
    await store.complete(key, result ?? null)
    return result
  } catch (err) {
    await store.fail(key)
    throw err
  }
}

// ── store wiring ──────────────────────────────────────────────────────────────
function makeStore(db) {
  if (db) {
    return {
      get: (k) => db.getIdempotencyKey(k),
      claim: (k) => db.claimIdempotencyKey(k),
      complete: (k, r) => db.completeIdempotencyKey(k, r),
      fail: (k) => db.failIdempotencyKey(k),
    }
  }
  return defaultStore
}

// ── default Supabase-backed store ─────────────────────────────────────────────
// claim() and get() throw on real errors (we must know state before acting on
// money). complete()/fail() are best-effort: fn already ran, so we log rather
// than throw to avoid making a caller think a successful op failed.
const defaultStore = {
  async get(key) {
    const { data, error } = await getDb()
      .from('idempotency_keys')
      .select('*')
      .eq('key', key)
      .maybeSingle()
    if (error) throw new Error(`idempotency get failed: ${error.message}`)
    return data ?? null
  },

  async claim(key) {
    const { error } = await getDb()
      .from('idempotency_keys')
      .insert([{ key, status: 'pending' }])
    if (error) {
      if (error.code === '23505') return false // unique violation = already claimed
      throw new Error(`idempotency claim failed: ${error.message}`)
    }
    return true
  },

  async complete(key, result) {
    // Retry once to shrink the stuck-pending window; if it still fails, log
    // LOUD for manual reconcile (the op succeeded — key just isn't recorded).
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await getDb()
        .from('idempotency_keys')
        .update({ status: 'completed', result, completed_at: new Date().toISOString() })
        .eq('key', key)
      if (!error) return
      if (attempt === 1) {
        logger.error(`CRITICAL idempotency complete failed for ${key} after retry: ${error.message} — op succeeded but key left 'pending'; MANUAL RECONCILE may be needed`)
      }
    }
  },

  async fail(key) {
    const { error } = await getDb()
      .from('idempotency_keys')
      .delete()
      .eq('key', key)
      .eq('status', 'pending')
    if (error) logger.error(`idempotency fail-release failed for ${key}: ${error.message}`)
  },
}
