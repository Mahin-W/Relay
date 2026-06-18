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

let LLM_ON = true
mock.module('../../parsers/llm.js', { namedExports: { hasAnyLLM: () => LLM_ON } })
mock.module('../../parseMessage.js', { namedExports: {
  parseShift: async () => ([{ name: 'Lunch', day_of_week: 'Monday', start_time: '11:00 AM', end_time: '3:00 PM' }]),
  parseShiftRequirements: async () => ([{ shift_name: 'Lunch', role: 'Server', count: 2 }]),
  parseStaff: async () => ([{ name: 'Sam', role: 'Server' }]),
}})

const { resetFakeClient, seedTable } = supabaseFake
const setupRouter = (await import('../../server/setupRoutes.js')).default

const AUTH_ID = '00000000-0000-0000-0000-000000000042'
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
  LLM_ON = true
  resetFakeClient()
  seedTable('accounts', [{ id: AUTH_ID, email: 'o@shop.com', business_name: 'B', setup_data: {}, login_2fa_enabled: false }])
  seedTable('setup_sessions', [{ group_id: 'web:' + AUTH_ID, account_id: AUTH_ID, setup_complete: false }])
})

describe('setup parse routes', () => {
  test('POST /parse-shifts returns shifts with merged requirements', async () => {
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'lunch mon 11-3, 2 servers' })
    assert.equal(r.status, 200)
    assert.equal(r.body.shifts[0].name, 'Lunch')
    assert.deepEqual(r.body.shifts[0].requirements, [{ role: 'Server', count: 2 }])
  })
  test('POST /parse-staff returns staff', async () => {
    const r = await req('POST', '/api/account/setup/parse-staff', { text: 'Sam is a server' })
    assert.equal(r.body.staff[0].name, 'Sam')
  })
  test('503 when no LLM configured', async () => {
    LLM_ON = false
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'x' })
    assert.equal(r.status, 503)
    assert.equal(r.body.reason, 'no_llm')
  })
  test('400 when text over 2000 chars', async () => {
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'a'.repeat(2001) })
    assert.equal(r.status, 400)
  })
})
