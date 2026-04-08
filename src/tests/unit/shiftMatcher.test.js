import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchShift } from '../../shiftMatcher.js'

// All tests pass shifts directly — skips the DB call entirely.

const FRIDAY_MORNING = { id: 1, name: 'Friday Morning', day_of_week: 'Friday', start_time: '8:00 AM', end_time: '12:00 PM' }
const FRIDAY_EVENING = { id: 2, name: 'Friday Evening', day_of_week: 'Friday', start_time: '5:00 PM', end_time: '9:00 PM' }
const SATURDAY_LUNCH = { id: 3, name: 'Saturday Lunch', day_of_week: 'Saturday', start_time: '11:00 AM', end_time: '3:00 PM' }

test('exact name match returns that shift', async () => {
  const result = await matchShift('g1', 'Friday Morning', 'cover my friday morning shift', [FRIDAY_MORNING, SATURDAY_LUNCH])
  assert.equal(result.id, FRIDAY_MORNING.id)
  assert.equal(result.low_confidence, false)
})

test('day + time signal picks correct shift among same-day options', async () => {
  const result = await matchShift('g1', 'friday evening', 'can anyone cover my friday 5pm shift', [FRIDAY_MORNING, FRIDAY_EVENING])
  assert.equal(result.id, FRIDAY_EVENING.id)
})

test('low_confidence when runner-up is close in score', async () => {
  // Two shifts with identical day — only different times. Message gives no time signal.
  const result = await matchShift('g1', 'friday', 'cover my friday shift', [FRIDAY_MORNING, FRIDAY_EVENING])
  assert.equal(result.low_confidence, true)
})

test('single shift always returns without low_confidence when message has signal', async () => {
  const result = await matchShift('g1', 'Saturday Lunch', 'I need coverage Saturday Lunch', [SATURDAY_LUNCH])
  assert.equal(result.id, SATURDAY_LUNCH.id)
  assert.equal(result.low_confidence, false)
})

test('single shift returns low_confidence when message has no signal', async () => {
  const result = await matchShift('g1', 'something', 'hey', [SATURDAY_LUNCH])
  assert.equal(result.id, SATURDAY_LUNCH.id)
  assert.equal(result.low_confidence, true)
})

test('no matching shifts returns null', async () => {
  const result = await matchShift('g1', 'tuesday', 'cover tuesday', [FRIDAY_MORNING, SATURDAY_LUNCH])
  // No score > 0 → returns null
  assert.equal(result, null)
})

test('empty shifts array returns null', async () => {
  const result = await matchShift('g1', 'any shift', 'help', [])
  assert.equal(result, null)
})
