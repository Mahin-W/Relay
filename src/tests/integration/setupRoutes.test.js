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
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const setupRouter = (await import('../../server/setupRoutes.js')).default

const AUTH_ID = '00000000-0000-0000-0000-000000000042'
const PROV = 'web:' + AUTH_ID
function token() { return jwt.sign({ sub: AUTH_ID, email: 'o@shop.com', aud: 'authenticated', role: 'authenticated' }, process.env.SUPABASE_JWT_SECRET) }
function app() { const a = express(); a.use(express.json()); a.use('/api/account/setup', setupRouter); return a }
async function req(method, path, body) {
  const server = createServer(app()); await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => null)
  await new Promise(r => server.close(r)); return { status: res.status, body: data }
}

beforeEach(() => {
  resetFakeClient()
  seedTable('accounts', [{ id: AUTH_ID, email: 'o@shop.com', business_name: 'Bagels', setup_data: {}, login_2fa_enabled: false }])
  seedTable('setup_sessions', [{ group_id: PROV, account_id: AUTH_ID, setup_complete: false }])
})

describe('setup routes: roles/rates/business + resume', () => {
  test('POST /role creates a role_rates row at 0', async () => {
    const r = await req('POST', '/api/account/setup/role', { role: 'Server' })
    assert.equal(r.status, 201)
    const rows = getFakeClient()._table('role_rates')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].group_id, PROV)
    assert.equal(rows[0].role_name, 'Server')
  })
  test('POST /role does not clobber an existing rate', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 18 }])
    await req('POST', '/api/account/setup/role', { role: 'Server' })
    assert.equal(getFakeClient()._table('role_rates')[0].hourly_rate, 18)
  })
  test('PATCH /rate sets the hourly rate', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 0 }])
    const r = await req('PATCH', '/api/account/setup/rate', { role: 'Server', hourly_rate: 16.5 })
    assert.equal(r.status, 200)
    assert.equal(getFakeClient()._table('role_rates')[0].hourly_rate, 16.5)
  })
  test('GET / returns roles + staff + shifts + businessName for resume', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 16.5 }])
    seedTable('staff', [{ id: 1, group_id: PROV, name: 'Sam', role: 'Server', active: true }])
    const r = await req('GET', '/api/account/setup')
    assert.equal(r.status, 200)
    assert.equal(r.body.businessName, 'Bagels')
    assert.equal(r.body.roles[0].name, 'Server')
    assert.equal(r.body.roles[0].rate, 16.5)
    assert.equal(r.body.staff[0].name, 'Sam')
    assert.equal(r.body.connected, false)
  })
})
