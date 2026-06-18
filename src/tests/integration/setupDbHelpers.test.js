process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const staff = await import('../../setup/db/staff.js')
const shifts = await import('../../setup/db/shifts.js')
const roles = await import('../../setup/db/roles.js')

beforeEach(() => resetFakeClient())

describe('setup db helpers', () => {
  test('updateStaffById changes name/role within group', async () => {
    seedTable('staff', [{ id: 1, group_id: 'g', name: 'Sam', role: 'Server' }])
    await staff.updateStaffById(1, 'g', { role: 'Cook' })
    assert.equal(getFakeClient()._table('staff')[0].role, 'Cook')
  })
  test('deleteStaffById removes the row', async () => {
    seedTable('staff', [{ id: 1, group_id: 'g', name: 'Sam', role: 'Server' }])
    await staff.deleteStaffById(1, 'g')
    assert.equal(getFakeClient()._table('staff').length, 0)
  })
  test('deleteShiftById removes shift and its requirements', async () => {
    seedTable('shifts', [{ id: 5, group_id: 'g', name: 'Lunch' }])
    seedTable('shift_requirements', [{ id: 1, shift_id: 5, role: 'Server', count: 2 }])
    await shifts.deleteShiftById(5, 'g')
    assert.equal(getFakeClient()._table('shifts').length, 0)
    assert.equal(getFakeClient()._table('shift_requirements').length, 0)
  })
  test('deleteRole removes the role_rates row', async () => {
    seedTable('role_rates', [{ id: 1, group_id: 'g', role_name: 'Server', hourly_rate: 0 }])
    await roles.deleteRole('g', 'Server')
    assert.equal(getFakeClient()._table('role_rates').length, 0)
  })
})
