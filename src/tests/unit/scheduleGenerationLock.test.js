// G2 (BH.06): Concurrent generateWeeklySchedule calls for same groupId+weekStart
// must return the same promise (deduplication / serialization lock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateWeeklySchedule } from '../../schedule/generateSchedule.js'

const WEEK = '2025-05-05'
const GROUP = 'lock-test-group'

function buildMock() {
  return {
    shifts: [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
    ],
    staff: [
      { id: 10, name: 'Alice', role: 'Server', userId: 'u1', dmChatId: null },
    ],
    availability: [
      { user_id: 'u1', available_all: true, unavailable: false, available_shift_ids: [] },
    ],
    requirements: [
      { shift_id: 1, role: 'server', count: 1 },
    ],
    rules: [],
  }
}

test('G2: concurrent calls for same groupId+weekStart return the same result object (===)', async () => {
  const [r1, r2] = await Promise.all([
    generateWeeklySchedule(GROUP, WEEK, buildMock()),
    generateWeeklySchedule(GROUP, WEEK, buildMock()),
  ])
  // They must be the exact same object reference — second call joined the first promise
  assert.ok(r1 === r2, `Expected both calls to return the same result object. Got r1=${JSON.stringify(r1)?.slice(0,100)} r2=${JSON.stringify(r2)?.slice(0,100)}`)
})

test('G2: different groupId+weekStart keys run independently', async () => {
  const [r1, r2] = await Promise.all([
    generateWeeklySchedule('lock-g1', WEEK, buildMock()),
    generateWeeklySchedule('lock-g2', WEEK, buildMock()),
  ])
  // Different groups produce independent results (may or may not be ===, but both valid)
  assert.ok(Array.isArray(r1.assignments), 'r1 has assignments')
  assert.ok(Array.isArray(r2.assignments), 'r2 has assignments')
})

test('G2: generateSchedule.js contains a locking primitive', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/schedule/generateSchedule.js', 'utf8')
  const hasLock = /lock|mutex|inProgress|in_progress|generating|semaphore|_inflight/i.test(src)
  assert.ok(hasLock, 'generateSchedule.js must contain a locking primitive (_inflight, lock, mutex, etc.)')
})
