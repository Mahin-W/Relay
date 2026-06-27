import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKey, validateKey, revokeKey } from '../../server/apiKeys.js'

function makeDb() {
  const rows = []
  return {
    rows,
    insertApiKey: async (row) => { rows.push(row); return { id: rows.length, ...row } },
    getApiKeyByHash: async (h) => rows.find(r => r.key_hash === h) ?? null,
    revokeApiKey: async (h, at) => { const r = rows.find(x => x.key_hash === h); if (r) r.revoked_at = at },
    insertAuditEvent: async () => {},
  }
}

describe('api keys', () => {
  it('generate→validate roundtrip succeeds with scope', async () => {
    const db = makeDb()
    const { plaintext } = await generateKey('g1', ['read', 'write'], db)
    assert.ok(plaintext.startsWith('relay_'))
    // only a hash is stored, never the plaintext
    assert.notEqual(db.rows[0].key_hash, plaintext)
    assert.ok(!('plaintext' in db.rows[0]))

    const v = await validateKey(plaintext, 'read', db)
    assert.equal(v.valid, true)
    assert.equal(v.groupId, 'g1')
  })

  it('rejects an unknown key', async () => {
    const db = makeDb()
    await generateKey('g1', ['read'], db)
    const v = await validateKey('relay_wrongkey', 'read', db)
    assert.equal(v.valid, false)
    assert.equal(v.reason, 'unknown')
  })

  it('rejects a missing scope', async () => {
    const db = makeDb()
    const { plaintext } = await generateKey('g1', ['read'], db)
    const v = await validateKey(plaintext, 'write', db)
    assert.equal(v.valid, false)
    assert.equal(v.reason, 'scope')
  })

  it('rejects a revoked key', async () => {
    const db = makeDb()
    const { plaintext } = await generateKey('g1', ['read'], db)
    await revokeKey(db.rows[0].key_hash, 'g1', db)
    const v = await validateKey(plaintext, 'read', db)
    assert.equal(v.valid, false)
    assert.equal(v.reason, 'revoked')
  })

  it('rejects a missing key', async () => {
    assert.deepEqual(await validateKey('', 'read', makeDb()), { valid: false, reason: 'missing' })
  })
})
