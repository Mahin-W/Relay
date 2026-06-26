import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withIdempotency, IdempotencyInProgressError } from '../../lib/idempotency.js'

// In-memory store implementing the db-mock interface.
function makeMemStore(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getIdempotencyKey: async (k) => map.get(k) ?? null,
    claimIdempotencyKey: async (k) => {
      if (map.has(k)) return false
      map.set(k, { key: k, status: 'pending', result: null })
      return true
    },
    completeIdempotencyKey: async (k, r) => {
      const row = map.get(k)
      if (row) { row.status = 'completed'; row.result = r }
    },
    failIdempotencyKey: async (k) => {
      const row = map.get(k)
      if (row && row.status === 'pending') map.delete(k)
    },
  }
}

describe('withIdempotency', () => {
  it('runs fn once and returns its result', async () => {
    const db = makeMemStore()
    let calls = 0
    const result = await withIdempotency('k1', async () => { calls++; return { ref: 'abc' } }, db)
    assert.equal(calls, 1)
    assert.deepEqual(result, { ref: 'abc' })
  })

  it('replays cached result without re-running fn', async () => {
    const db = makeMemStore()
    let calls = 0
    const fn = async () => { calls++; return { ref: 'once' } }
    const first = await withIdempotency('k1', fn, db)
    const second = await withIdempotency('k1', fn, db)
    assert.equal(calls, 1)
    assert.deepEqual(first, { ref: 'once' })
    assert.deepEqual(second, { ref: 'once' })
  })

  it('runs fn separately for different keys', async () => {
    const db = makeMemStore()
    let calls = 0
    await withIdempotency('a', async () => { calls++; return 1 }, db)
    await withIdempotency('b', async () => { calls++; return 2 }, db)
    assert.equal(calls, 2)
  })

  it('releases the claim when fn throws, allowing a deliberate retry', async () => {
    const db = makeMemStore()
    let calls = 0
    await assert.rejects(
      withIdempotency('k1', async () => { calls++; throw new Error('boom') }, db),
      /boom/
    )
    // claim released → key gone
    assert.equal(db.map.has('k1'), false)
    // retry re-runs and succeeds
    const out = await withIdempotency('k1', async () => { calls++; return 'ok' }, db)
    assert.equal(out, 'ok')
    assert.equal(calls, 2)
  })

  it('throws IdempotencyInProgressError when a prior attempt is still pending', async () => {
    const db = makeMemStore({ k1: { key: 'k1', status: 'pending', result: null } })
    let calls = 0
    await assert.rejects(
      withIdempotency('k1', async () => { calls++; return 1 }, db),
      (err) => err instanceof IdempotencyInProgressError
    )
    assert.equal(calls, 0)
  })

  it('caches undefined fn result as null and replays it', async () => {
    const db = makeMemStore()
    const first = await withIdempotency('k1', async () => undefined, db)
    const second = await withIdempotency('k1', async () => { throw new Error('should not run') }, db)
    assert.equal(first, undefined)
    assert.equal(second, null) // stored as null, replayed
  })

  it('rejects a missing key', async () => {
    await assert.rejects(withIdempotency('', async () => 1, makeMemStore()), /key required/)
  })

  it('rejects a non-function fn', async () => {
    await assert.rejects(withIdempotency('k', 'nope', makeMemStore()), /must be a function/)
  })
})
