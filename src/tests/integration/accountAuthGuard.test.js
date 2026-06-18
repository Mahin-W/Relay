// Verifies the account-based auth path through requireAuth (Supabase token →
// account → resolved group) and the dashRoutes pre-connect guard. Every account
// has a provisional group_id ('web:<id>') from signup, so mutations are always
// allowed (writes go to the provisional group, never orphaned). The gate only
// blocks the rare case of a genuinely group-less account (legacy/migration).
//
// Run with:
//   node --experimental-test-module-mocks --test src/tests/integration/accountAuthGuard.test.js

process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'
process.env.SUPABASE_JWT_SECRET = 'supabase-test-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'

import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', {
  namedExports: { createClient: supabaseFake.createClient },
})
const { resetFakeClient, seedTable } = supabaseFake

const dashRouter = (await import('../../server/dashRoutes.js')).default
const accountRouter = (await import('../../server/accountRoutes.js')).default

const AUTH_ID = '00000000-0000-0000-0000-000000000042'

function supabaseToken(sub = AUTH_ID, email = 'owner@shop.com') {
  return jwt.sign({ sub, email, aud: 'authenticated', role: 'authenticated' }, process.env.SUPABASE_JWT_SECRET)
}

function twoFactorToken(accountId = AUTH_ID) {
  return jwt.sign({ accountId, twofa: true }, process.env.JWT_SECRET)
}

function app(bot = null) {
  const a = express()
  a.use(express.json())
  a.locals.bot = bot
  a.use('/api/account', accountRouter)
  a.use('/api/dashboard', dashRouter)  // legacy paths used by dashboard.html
  a.use('/api', dashRouter)            // clean paths
  return a
}

async function request(method, path, { token, body, bot = null, twofa } = {}) {
  const server = createServer(app(bot))
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  if (twofa) headers['x-relay-2fa'] = twofa
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body: data }
}

// Connect-guard tests isolate the group gate, so disable 2FA on the account.
beforeEach(() => {
  resetFakeClient()
  // Auth trigger normally creates this; pre-seed for the test.
  seedTable('accounts', [{ id: AUTH_ID, email: 'owner@shop.com', business_name: 'Bagels', setup_data: {}, login_2fa_enabled: false }])
  // Provisioning always creates a provisional group_id ('web:<accountId>') for
  // every account at signup, so setup_sessions is pre-seeded here to reflect that.
  seedTable('setup_sessions', [{ group_id: `web:${AUTH_ID}`, account_id: AUTH_ID, setup_complete: false }])
})

describe('account auth + pre-connect guard', () => {
  test('no token → 401', async () => {
    const r = await request('GET', '/api/dashboard/overview')
    assert.equal(r.status, 401)
  })

  test('account with no connected group: GET overview allowed (empty)', async () => {
    const r = await request('GET', '/api/dashboard/overview', { token: supabaseToken() })
    assert.equal(r.status, 200)
  })

  test('provisioned account (provisional group): mutation is allowed', async () => {
    // Every account gets a provisional 'web:<id>' group at signup. Writes must
    // not be blocked — they go to the provisional group, never orphaned.
    const r = await request('POST', '/api/staff', { token: supabaseToken(), body: { name: 'Sam', role: 'Server' } })
    assert.notEqual(r.status, 409)
    assert.notEqual(r.status, 401)
  })

  test('connected account: mutation allowed', async () => {
    seedTable('setup_sessions', [{ group_id: 'grp-42', group_name: 'Bagels', account_id: AUTH_ID, setup_complete: true }])
    const r = await request('POST', '/api/staff', { token: supabaseToken(), body: { name: 'Sam', role: 'Server' } })
    assert.notEqual(r.status, 409)
    assert.notEqual(r.status, 401)
  })

  test('account routes reject legacy/non-account context with 403', async () => {
    // A Supabase token resolves to an account, so /api/account/link-code works…
    seedTable('account_links', [])
    process.env.BOT_USERNAME = 'relay_test_bot'
    const r = await request('POST', '/api/account/link-code', { token: supabaseToken() })
    assert.equal(r.status, 200)
    assert.ok(r.body.deepLink.includes('start=link_'))
  })
})

describe('login confirmation code (2FA)', () => {
  // A connected account with 2FA on (default) and a Telegram DM on file.
  function seed2faAccount({ enabled = true } = {}) {
    resetFakeClient()
    seedTable('accounts', [{ id: AUTH_ID, email: 'owner@shop.com', business_name: 'Bagels', setup_data: {}, login_2fa_enabled: enabled }])
    seedTable('setup_sessions', [{ group_id: 'grp-42', group_name: 'Bagels', account_id: AUTH_ID, setup_complete: true, dm_chat_id: 5551234 }])
  }
  function botStub() {
    const sent = []
    return { sent, sendMessage: async (chatId, text) => { sent.push({ chatId, text }) } }
  }

  test('dashboard is locked until the code is verified', async () => {
    seed2faAccount()
    const r = await request('GET', '/api/dashboard/overview', { token: supabaseToken() })
    assert.equal(r.status, 401)
    assert.equal(r.body.twoFactorRequired, true)
  })

  test('a valid 2FA token unlocks the dashboard', async () => {
    seed2faAccount()
    const r = await request('GET', '/api/dashboard/overview', { token: supabaseToken(), twofa: twoFactorToken() })
    assert.equal(r.status, 200)
  })

  test('start sends a Telegram code, verify returns a working token', async () => {
    seed2faAccount()
    const bot = botStub()
    const start = await request('POST', '/api/account/2fa/start', { token: supabaseToken(), bot })
    assert.equal(start.body.required, true)
    assert.equal(start.body.channel, 'telegram')
    const code = String(bot.sent[0].text).match(/\b(\d{6})\b/)[1]

    const verify = await request('POST', '/api/account/2fa/verify', { token: supabaseToken(), body: { code } })
    assert.equal(verify.body.success, true)
    assert.ok(verify.body.token)

    // The returned token unlocks the dashboard.
    const ov = await request('GET', '/api/dashboard/overview', { token: supabaseToken(), twofa: verify.body.token })
    assert.equal(ov.status, 200)
  })

  test('wrong code is rejected', async () => {
    seed2faAccount()
    const bot = botStub()
    await request('POST', '/api/account/2fa/start', { token: supabaseToken(), bot })
    const verify = await request('POST', '/api/account/2fa/verify', { token: supabaseToken(), body: { code: '000000' } })
    assert.equal(verify.status, 401)
  })

  test('with 2FA disabled the dashboard is not locked', async () => {
    seed2faAccount({ enabled: false })
    const r = await request('GET', '/api/dashboard/overview', { token: supabaseToken() })
    assert.equal(r.status, 200)
  })
})
