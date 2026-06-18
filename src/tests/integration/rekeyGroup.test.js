process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const { rekeyGroup } = await import('../../setup/db/rekey.js')

beforeEach(() => resetFakeClient())

describe('rekeyGroup', () => {
  test('moves every group_id row from old to new, idempotently', async () => {
    seedTable('staff', [{ id: 1, group_id: 'web:a', name: 'Sam', role: 'Server' }])
    seedTable('role_rates', [{ id: 1, group_id: 'web:a', role_name: 'Server', hourly_rate: 0 }])
    seedTable('setup_sessions', [{ group_id: 'web:a', account_id: 'a' }])

    const ok = await rekeyGroup('web:a', '-100123')
    assert.equal(ok, true)
    assert.equal(getFakeClient()._table('staff')[0].group_id, '-100123')
    assert.equal(getFakeClient()._table('role_rates')[0].group_id, '-100123')
    assert.equal(getFakeClient()._table('setup_sessions')[0].group_id, '-100123')

    await rekeyGroup('web:a', '-100123') // re-run: no rows match old anymore
    assert.equal(getFakeClient()._table('staff').length, 1)
  })
})
