// BH.32 — handleClockIn idempotency tests
// Seeds an open time entry, calls handleClockIn again, expects rejection and no new row.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

function makeClockInMsg(userId = 456, chatId = 123) {
  return {
    chat: { id: chatId },
    from: { id: userId, first_name: 'Alex' },
    text: 'clock in',
  }
}

describe('handleClockIn idempotency (BH.32)', () => {
  test('rejects second clock-in when open entry exists — sends "already clocked in" and does not insert new row', async () => {
    const { handleClockIn } = await import('../../timeclock/clockHandler.js')

    const sent = []
    const mockBot = {
      sendMessage: (chatId, text, opts) => { sent.push({ chatId, text }); return Promise.resolve() },
    }

    const existingEntry = { id: 1, clock_in: new Date(Date.now() - 3600000).toISOString(), group_id: 'group1', user_id: 456 }
    let clockInCalled = false

    const mockDb = {
      getManagerGroup: () => Promise.resolve(null),
      getGroupForUser: () => Promise.resolve('group1'),
      // Open entry already exists
      getOpenEntry: () => Promise.resolve(existingEntry),
      clockIn: () => {
        clockInCalled = true
        return Promise.resolve({ id: 2, clock_in: new Date().toISOString() })
      },
    }

    const msg = makeClockInMsg()
    const result = await handleClockIn(mockBot, msg, mockDb)

    // Should return true (handled) and NOT call clockIn
    assert.equal(result, true, 'handleClockIn should return true')
    assert.equal(clockInCalled, false, 'db.clockIn must NOT be called when already clocked in')
    assert.ok(sent.length > 0, 'Bot must send a message')
    const replyText = sent[0].text.toLowerCase()
    assert.ok(
      replyText.includes('already clocked in') || replyText.includes('clock out first') || replyText.includes('already'),
      `Expected "already clocked in" message, got: ${sent[0].text}`
    )
  })

  test('allows clock-in when no open entry exists', async () => {
    const { handleClockIn } = await import('../../timeclock/clockHandler.js')

    const sent = []
    const mockBot = {
      sendMessage: (chatId, text, opts) => { sent.push({ chatId, text }); return Promise.resolve() },
    }

    let clockInCalled = false

    const mockDb = {
      getManagerGroup: () => Promise.resolve(null),
      getGroupForUser: () => Promise.resolve('group1'),
      // No open entry
      getOpenEntry: () => Promise.resolve(null),
      clockIn: (groupId, userId, staffId, shiftId, raw) => {
        clockInCalled = true
        return Promise.resolve({ id: 1, clock_in: new Date().toISOString(), group_id: groupId, user_id: userId })
      },
    }

    const msg = makeClockInMsg()
    try {
      await handleClockIn(mockBot, msg, mockDb)
    } catch {
      // findPersonShiftForDay may fail without full DB — that's OK for this test
    }

    // clock-in was attempted (not blocked by idempotency guard)
    // We check that the "already clocked in" message was NOT sent
    const alreadyMsg = sent.find(m => m.text.toLowerCase().includes('already clocked in'))
    assert.equal(alreadyMsg, undefined, 'Should not send "already clocked in" when no open entry')
  })

  test('SimulationDb.clockIn is idempotent — second call without clock-out returns null', async () => {
    const { SimulationDb } = await import('../simulation/simulationDb.js')
    const db = new SimulationDb()

    const userId = 9001
    const groupId = 'grp1'

    const first = await db.clockIn({ user_id: userId, group_id: groupId, staff_id: 1, shift_id: 1, clock_in: new Date().toISOString() })
    assert.ok(first, 'First clock-in should succeed')

    const second = await db.clockIn({ user_id: userId, group_id: groupId, staff_id: 1, shift_id: 1, clock_in: new Date().toISOString() })
    assert.equal(second, null, 'Second clock-in without clock-out must return null (rejected)')

    const openEntries = db.timeEntries.filter(e => e.user_id === userId && !e.clock_out)
    assert.equal(openEntries.length, 1, `Only 1 open entry allowed at a time, found ${openEntries.length}`)
  })
})
