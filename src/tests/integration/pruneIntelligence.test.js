// P1-18: nightly prune deletes intelligence rows older than the retention window
// and leaves recent ones untouched.

process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const { pruneOldIntelligence, RETENTION_DAYS } = await import('../../maintenance/pruneIntelligence.js')

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

beforeEach(() => resetFakeClient())

describe('pruneOldIntelligence', () => {
  test('deletes rows older than the retention window, keeps recent ones', async () => {
    seedTable('morale_events', [
      { id: 1, group_id: 'g', created_at: daysAgo(RETENTION_DAYS + 10) }, // stale → delete
      { id: 2, group_id: 'g', created_at: daysAgo(30) },                  // recent → keep
    ])
    seedTable('discovered_patterns', [
      { id: 1, group_id: 'g', created_at: daysAgo(RETENTION_DAYS + 1) },  // stale → delete
    ])

    const result = await pruneOldIntelligence()

    assert.equal(result.morale_events, 'ok')
    const morale = getFakeClient()._table('morale_events')
    assert.equal(morale.length, 1)
    assert.equal(morale[0].id, 2)
    assert.equal(getFakeClient()._table('discovered_patterns').length, 0)
  })
})
