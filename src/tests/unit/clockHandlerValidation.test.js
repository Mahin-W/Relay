// P1-10: Clock-in validation — must have assigned shift, can't clock in too early.
//
// Tests use the db injection pattern from clockIdempotency.test.js.
// manualClockIn in clockOverride.js is NOT tested here (it bypasses these checks).

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { handleClockIn } from '../../timeclock/clockHandler.js'

function makeMsg(userId = 7, chatId = 777) {
  return {
    chat: { id: chatId },
    from: { id: userId, first_name: 'Dana' },
    text: 'clock in',
  }
}

function makeDb(overrides = {}) {
  return {
    getManagerGroup: async () => null,
    getGroupForUser: async () => 'g1',
    getOpenEntry: async () => null,
    getStaffForGroup: async () => [],
    getGroupMembersWithDm: async () => [],
    clockIn: async (groupId, userId, staffId, shiftId, raw) =>
      ({ id: 99, clock_in: new Date().toISOString(), group_id: groupId, user_id: userId }),
    ...overrides,
  }
}

// Helper to build a shift with start_time N minutes from now
function shiftStartingInMinutes(n) {
  const d = new Date(Date.now() + n * 60 * 1000)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h}:${String(m).padStart(2, '0')}`
}

const bot = {
  sentMessages: [],
  sendMessage(chatId, text) {
    this.sentMessages.push({ chatId: String(chatId), text })
    return Promise.resolve()
  },
}

function makeFreshBot() {
  return {
    sentMessages: [],
    sendMessage(chatId, text) {
      this.sentMessages.push({ chatId: String(chatId), text })
      return Promise.resolve()
    },
  }
}

// ── (a) No assigned shift → reject ────────────────────────────────────────────

test('P1-10: no assigned shift → rejected with friendly message', async () => {
  const b = makeFreshBot()
  const db = makeDb({
    // findPersonShiftForDay returns empty
    findPersonShiftForDay: async () => ({ matches: [] }),
  })
  await handleClockIn(b, makeMsg(), db)
  const last = b.sentMessages.at(-1)
  assert.ok(last, 'Should send a message')
  const txt = last.text.toLowerCase()
  assert.ok(
    txt.includes('no shift') || txt.includes('not scheduled') || txt.includes('ask your manager') || txt.includes('assigned'),
    `Expected rejection message, got: "${last.text}"`
  )
})

// ── (b) Clock-in 3 hours early → reject ───────────────────────────────────────

test('P1-10: clock-in 3 hours before shift start → rejected', async () => {
  const b = makeFreshBot()
  // Fake the whole clock to noon so now+3h (15:00) never wraps past midnight —
  // otherwise the shift's wall-clock start reads as earlier-today (the past) and
  // the early-clock-in guard correctly doesn't fire, making the test time-flaky.
  const noon = new Date(); noon.setHours(12, 0, 0, 0)
  mock.timers.enable({ apis: ['Date'], now: noon.getTime() })
  try {
    const startTime = shiftStartingInMinutes(180) // 3 hours from faked now → 15:00
    const db = makeDb({
      findPersonShiftForDay: async () => ({
        matches: [{ shift: { id: 5, name: 'Dinner', start_time: startTime, end_time: '23:00' } }],
      }),
    })
    await handleClockIn(b, makeMsg(), db)
    const last = b.sentMessages.at(-1)
    assert.ok(last, 'Should send a message')
    const txt = last.text.toLowerCase()
    assert.ok(
      txt.includes('early') || txt.includes('before') || txt.includes('min'),
      `Expected early-clock-in rejection, got: "${last.text}"`
    )
  } finally {
    mock.timers.reset()
  }
})

// ── (c) Clock-in within grace window → allowed ────────────────────────────────

test('P1-10: clock-in within grace window (40 min before shift) → allowed', async () => {
  const b = makeFreshBot()
  let clockInCalled = false
  const startTime = shiftStartingInMinutes(40) // 40 min from now — within default 60-min grace
  const db = makeDb({
    findPersonShiftForDay: async () => ({
      matches: [{ shift: { id: 6, name: 'Lunch', start_time: startTime, end_time: '16:00' } }],
    }),
    clockIn: async (groupId, userId, staffId, shiftId) => {
      clockInCalled = true
      return { id: 100, clock_in: new Date().toISOString(), group_id: groupId, user_id: userId }
    },
  })
  await handleClockIn(b, makeMsg(), db)
  assert.equal(clockInCalled, true, 'clockIn should be called when within grace window')
  // Should NOT send an error message
  const last = b.sentMessages.at(-1)
  assert.ok(last, 'Should send a confirmation message')
  const txt = last.text.toLowerCase()
  assert.ok(
    !txt.includes('early') && !txt.includes('no shift') && !txt.includes('not scheduled'),
    `Expected success message, got: "${last.text}"`
  )
})

// ── (d) Clock-in right at shift start → allowed ───────────────────────────────

test('P1-10: clock-in at shift start time → allowed', async () => {
  const b = makeFreshBot()
  let clockInCalled = false
  const startTime = shiftStartingInMinutes(0) // right now
  const db = makeDb({
    findPersonShiftForDay: async () => ({
      matches: [{ shift: { id: 7, name: 'Morning', start_time: startTime, end_time: '14:00' } }],
    }),
    clockIn: async (groupId, userId) => {
      clockInCalled = true
      return { id: 101, clock_in: new Date().toISOString(), group_id: groupId, user_id: userId }
    },
  })
  await handleClockIn(b, makeMsg(), db)
  assert.equal(clockInCalled, true, 'clockIn should be allowed at shift start')
})
