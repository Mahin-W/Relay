process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, getFakeClient } = supabaseFake
const accounts = await import('../../server/db/accounts.js')

const AUTH_ID = '00000000-0000-0000-0000-000000000001'
beforeEach(() => resetFakeClient())

describe('account group provisioning', () => {
  test('ensureAccount creates exactly one provisional session', async () => {
    await accounts.ensureAccount(AUTH_ID, 'o@shop.com')
    await accounts.ensureAccount(AUTH_ID, 'o@shop.com') // idempotent
    const sessions = getFakeClient()._table('setup_sessions')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].group_id, 'web:' + AUTH_ID)
    assert.equal(sessions[0].account_id, AUTH_ID)
  })
  test('isProvisionalGroup flags web: ids', () => {
    assert.equal(accounts.isProvisionalGroup('web:abc'), true)
    assert.equal(accounts.isProvisionalGroup('-1001234567'), false)
    assert.equal(accounts.isProvisionalGroup(null), false)
  })
})
