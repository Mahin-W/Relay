// Verifies the Supabase access-token verification path supports BOTH modern
// asymmetric (ES256 via JWKS) and legacy HS256 tokens. Regression test for the
// reload-loop bug where ES256 tokens were rejected because only HS256 was tried.
//
// Run with:
//   node --experimental-test-module-mocks --test src/tests/integration/supabaseTokenVerify.test.js

process.env.SUPABASE_URL = 'https://proj.supabase.test'
process.env.SUPABASE_ANON_KEY = 'anon-key'
process.env.SUPABASE_JWT_SECRET = 'legacy-hs256-secret-value-1234567890'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'

import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })

const { verifySupabaseToken } = await import('../../server/middleware.js')

// ── ES256 keypair + JWKS, mirroring a modern Supabase project ──
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const KID = 'test-kid-1'
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'ES256' }
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' })

const realFetch = global.fetch
function mockJwks(keys) {
  global.fetch = async () => ({ json: async () => ({ keys }) })
}

describe('verifySupabaseToken', () => {
  test('verifies an ES256 token against the JWKS', async () => {
    mockJwks([jwk])
    const token = jwt.sign({ sub: 'user-123', email: 'a@b.com' }, privatePem, { algorithm: 'ES256', keyid: KID })
    const payload = await verifySupabaseToken(token)
    assert.equal(payload.sub, 'user-123')
    assert.equal(payload.email, 'a@b.com')
    global.fetch = realFetch
  })

  test('rejects an ES256 token signed by a different key', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    mockJwks([jwk])  // JWKS only has the legit key
    const forged = jwt.sign({ sub: 'evil' }, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), { algorithm: 'ES256', keyid: KID })
    await assert.rejects(() => verifySupabaseToken(forged))
    global.fetch = realFetch
  })

  test('still verifies a legacy HS256 token', async () => {
    const token = jwt.sign({ sub: 'user-9' }, process.env.SUPABASE_JWT_SECRET, { algorithm: 'HS256' })
    const payload = await verifySupabaseToken(token)
    assert.equal(payload.sub, 'user-9')
  })

  test('rejects a malformed token', async () => {
    await assert.rejects(() => verifySupabaseToken('not-a-jwt'))
  })
})
