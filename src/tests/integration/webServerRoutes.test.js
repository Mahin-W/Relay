// Guards the webServer route ordering: the public /api/public-config endpoint
// (which the frontend needs to bootstrap Supabase Auth) must NOT be shadowed by
// the auth-gated /api routers. Regression test for that exact bug.
//
// Run with:
//   node --experimental-test-module-mocks --test src/tests/integration/webServerRoutes.test.js

process.env.SUPABASE_URL = 'http://supabase.test'
process.env.SUPABASE_ANON_KEY = 'anon-test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import * as supabaseFake from '../helpers/supabaseFake.js'
import { mock } from 'node:test'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })

const { createApp } = await import('../../server/webServer.js')

async function get(app, path) {
  const server = createServer(app)
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  const body = await res.json().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body }
}

describe('webServer route ordering', () => {
  test('GET /api/public-config is public and returns Supabase config', async () => {
    const app = createApp(null, null)
    const r = await get(app, '/api/public-config')
    assert.equal(r.status, 200)
    assert.equal(r.body.supabaseUrl, 'http://supabase.test')
    assert.equal(r.body.supabaseAnonKey, 'anon-test-key')
  })

  test('auth-gated /api routes still require auth', async () => {
    const app = createApp(null, null)
    const r = await get(app, '/api/dashboard/overview')
    assert.equal(r.status, 401)
  })

  test('GET /health is public', async () => {
    const app = createApp(null, null)
    const r = await get(app, '/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
  })
})
