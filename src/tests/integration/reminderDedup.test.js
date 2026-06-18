// P1-29: schedule-reminder dedup persists to reminder_sends so a restart
// doesn't resend every reminder, with an in-memory cache as the fast path /
// graceful fallback.

process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, getFakeClient } = supabaseFake
const { wasReminderSent, markReminderSent, _resetReminderCacheForTesting } =
  await import('../../reminders/shiftReminders.js')

beforeEach(() => { resetFakeClient(); _resetReminderCacheForTesting() })

describe('reminder dedup persistence', () => {
  test('a sent reminder survives an in-memory cache clear (persisted to DB)', async () => {
    assert.equal(await wasReminderSent('k1'), false)
    await markReminderSent('k1')
    assert.equal(getFakeClient()._table('reminder_sends').length, 1)

    // Simulate a process restart by clearing the in-memory cache — the DB row
    // must still dedup.
    _resetReminderCacheForTesting()
    assert.equal(await wasReminderSent('k1'), true)
    assert.equal(await wasReminderSent('k2'), false)
  })

  test('marking the same key twice does not create a duplicate row', async () => {
    await markReminderSent('dup')
    await markReminderSent('dup')
    assert.equal(getFakeClient()._table('reminder_sends').length, 1)
  })
})
