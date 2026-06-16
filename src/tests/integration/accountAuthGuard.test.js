// Verifies the account-based auth path through requireAuth (Supabase token →
// account → resolved group) and the dashRoutes pre-connect guard: reads are
// allowed with a null group, mutations are blocked until a group is connected.
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

function app() {
  const a = express()
  a.use(express.json())
  a.locals.bot = null
  a.use('/api/account', accountRouter)
  a.use('/api/dashboard', dashRouter)  // legacy paths used by dashboard.html
  a.use('/api', dashRouter)            // clean paths
  return a
}

async function request(method, path, { token, body } = {}) {
  const server = createServer(app())
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body: data }
}

beforeEach(() => {
  resetFakeClient()
  // Auth trigger normally creates this; pre-seed for the test.
  seedTable('accounts', [{ id: AUTH_ID, email: 'owner@shop.com', business_name: 'Bagels', setup_data: {} }])
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

  test('account with no connected group: mutation blocked with 409', async () => {
    const r = await request('POST', '/api/staff', { token: supabaseToken(), body: { name: 'Sam', role: 'Server' } })
    assert.equal(r.status, 409)
    assert.equal(r.body.notConnected, true)
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
