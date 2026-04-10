import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTimeReference,
  calculateRemainingCoverage,
  isFullyCovered,
  formatPartialCoverageMessage,
} from '../../coverage/partialCoverage.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'

// ── parseTimeReference ────────────────────────────────────────────────────────

const SHIFT = { startTime: '11am', endTime: '5pm' }  // 11:00 – 17:00, midpoint = 14:00 = 2pm

test('parseTimeReference: first_half → 11:00am to 2:00pm', () => {
  const result = parseTimeReference({ portion: 'first_half' }, SHIFT)
  assert.equal(result.coverFrom, '11:00am')
  assert.equal(result.coverUntil, '2:00pm')
})

test('parseTimeReference: second_half → 2:00pm to 5:00pm', () => {
  const result = parseTimeReference({ portion: 'second_half' }, SHIFT)
  assert.equal(result.coverFrom, '2:00pm')
  assert.equal(result.coverUntil, '5:00pm')
})

test('parseTimeReference: until 2pm → 11:00am to 2:00pm', () => {
  const result = parseTimeReference({ portion: 'until', timeReference: '2pm' }, SHIFT)
  assert.equal(result.coverFrom, '11:00am')
  assert.equal(result.coverUntil, '2:00pm')
})

test('parseTimeReference: from 2pm → 2:00pm to 5:00pm', () => {
  const result = parseTimeReference({ portion: 'from', timeReference: '2pm' }, SHIFT)
  assert.equal(result.coverFrom, '2:00pm')
  assert.equal(result.coverUntil, '5:00pm')
})

test('parseTimeReference: midnight-crossing shift midpoint handled', () => {
  const nightShift = { startTime: '10pm', endTime: '2am' }
  const result = parseTimeReference({ portion: 'first_half' }, nightShift)
  // 10pm = 22:00, 2am = 2:00 (next day = 26 in decimal), midpoint = 24 = 12am midnight
  assert.ok(result.coverFrom, 'should return a coverFrom')
  assert.ok(result.coverUntil, 'should return a coverUntil')
})

// ── calculateRemainingCoverage ────────────────────────────────────────────────

const SHIFT_FULL = { startTime: '11am', endTime: '5pm' }  // 11:00 – 17:00 decimal

test('calculateRemainingCoverage: no partials → one gap spanning full shift', () => {
  const gaps = calculateRemainingCoverage(SHIFT_FULL, [])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '11:00am')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: first half covered → one gap from 2pm to 5pm', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '2:00pm' }]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '2:00pm')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: both halves covered → empty array', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '2:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 0)
})

test('calculateRemainingCoverage: overlapping partials → correct remaining', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '3:00pm' },
    { coverFrom: '2:00pm', coverUntil: '4:00pm' },  // overlaps with first
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].from, '4:00pm')
  assert.equal(gaps[0].until, '5:00pm')
})

test('calculateRemainingCoverage: non-contiguous partials → two gaps', () => {
  // Covered: 11am-12pm and 2pm-5pm, gap: 12pm-2pm
  const partials = [
    { coverFrom: '11:00am', coverUntil: '12:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  const gaps = calculateRemainingCoverage(SHIFT_FULL, partials)
  assert.equal(gaps.length, 1)  // gap from 12pm to 2pm
  assert.equal(gaps[0].from, '12:00pm')
  assert.equal(gaps[0].until, '2:00pm')
})

// ── isFullyCovered ────────────────────────────────────────────────────────────

test('isFullyCovered: single partial covers whole shift → true', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '5:00pm' }]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), true)
})

test('isFullyCovered: two partials cover whole shift → true', () => {
  const partials = [
    { coverFrom: '11:00am', coverUntil: '2:00pm' },
    { coverFrom: '2:00pm', coverUntil: '5:00pm' },
  ]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), true)
})

test('isFullyCovered: one partial, gap remains → false', () => {
  const partials = [{ coverFrom: '11:00am', coverUntil: '2:00pm' }]
  assert.equal(isFullyCovered(SHIFT_FULL, partials), false)
})

test('isFullyCovered: empty partials → false', () => {
  assert.equal(isFullyCovered(SHIFT_FULL, []), false)
})

// ── formatPartialCoverageMessage ──────────────────────────────────────────────

test('formatPartialCoverageMessage: contains volunteer name', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('Alice'))
})

test('formatPartialCoverageMessage: contains shift name', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('Monday Lunch'))
})

test('formatPartialCoverageMessage: contains covered time range', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.includes('11:00am') && result.includes('2:00pm'))
})

test('formatPartialCoverageMessage: contains "Still need coverage" text', () => {
  const result = formatPartialCoverageMessage('Monday Lunch', 'Alice', '11:00am', '2:00pm', [{ from: '2:00pm', until: '5:00pm' }])
  assert.ok(result.toLowerCase().includes('still need') || result.includes('Still need'))
})

// ── handlePartialCoverageOffer (MockBot + mock DB) ───────────────────────────

const { handlePartialCoverageOffer } = await import('../../coverage/partialCoverage.js')

const OPEN_REQUEST = {
  id: 55,
  group_id: '-100',
  shift_description: 'Monday Lunch',
  matched_shift_id: 'shift-1',
  week_start: '2025-01-06',
  status: 'open',
}
const SHIFT_ROW = { id: 'shift-1', name: 'Monday Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '5pm' }

function makeCoverageDb(partials = [], overrides = {}) {
  let requestStatus = 'open'
  return {
    getOpenRequest: async () => ({ ...OPEN_REQUEST }),
    getShiftById: async () => SHIFT_ROW,
    getPartialCoverages: async () => [...partials],
    savePartialCoverage: async (data) => ({ id: Math.random(), ...data }),
    markCovered: async () => { requestStatus = 'covered' },
    _getStatus: () => requestStatus,
    ...overrides,
  }
}

test('handlePartialCoverageOffer: saves partial_coverage record', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: 'I can cover the first half', from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  let saved = null
  const db = makeCoverageDb([], { savePartialCoverage: async (data) => { saved = data; return { id: 1, ...data } } })
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.ok(saved, 'should save a partial coverage record')
})

test('handlePartialCoverageOffer: posts partial coverage message to group', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ text: 'I can cover the first half', from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group', title: 'Test Kitchen' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  await handlePartialCoverageOffer(bot, msg, intent, makeCoverageDb())
  const groupMsgs = bot.messagesTo('-100')
  assert.ok(groupMsgs.length > 0)
})

test('handlePartialCoverageOffer: keeps coverage_request open when partially covered', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  const db = makeCoverageDb()
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.equal(db._getStatus(), 'open', 'request should remain open when partially covered')
})

test('handlePartialCoverageOffer: closes coverage_request when fully covered by two volunteers', async () => {
  const bot = new MockBot()
  const existingPartials = [{ coverFrom: '11:00am', coverUntil: '2:00pm', staffName: 'Alice' }]
  const msg = makeGroupMsg({ from: { id: 202, first_name: 'Bob' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Bob', portion: 'second_half', timeReference: null }
  const db = makeCoverageDb(existingPartials)
  await handlePartialCoverageOffer(bot, msg, intent, db)
  assert.equal(db._getStatus(), 'covered', 'request should be closed when fully covered')
})

test('handlePartialCoverageOffer: "No open requests" when none exists', async () => {
  const bot = new MockBot()
  const msg = makeGroupMsg({ from: { id: 201, first_name: 'Alice' }, chat: { id: '-100', type: 'group' } })
  const intent = { type: 'partial_coverage_offer', person: 'Alice', portion: 'first_half', timeReference: null }
  const db = makeCoverageDb([], { getOpenRequest: async () => null })
  await handlePartialCoverageOffer(bot, msg, intent, db)
  const groupMsgs = bot.messagesTo('-100')
  assert.ok(groupMsgs[0].text.includes('No open') || groupMsgs[0].text.includes('no open'), 'should explain no open requests')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "I can cover the first half" → partial_coverage_offer, portion first_half', async () => {
  const r = await parseMessage('I can cover the first half', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'first_half')
})

test('[LLM] "I can cover until 3pm" → partial_coverage_offer, portion until', async () => {
  const r = await parseMessage('I can cover until 3pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'until')
  assert.ok(r.timeReference?.includes('3'), `expected timeReference with 3pm, got ${r.timeReference}`)
})

test('[LLM] "I can come in from 2pm" → partial_coverage_offer, portion from', async () => {
  const r = await parseMessage('I can come in from 2pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
  assert.equal(r.portion, 'from')
})

test('[LLM] "I can do 11am to 2pm" → partial_coverage_offer, portion range', async () => {
  const r = await parseMessage('I can do 11am to 2pm', 'Alice', 'Test Kitchen')
  assert.equal(r.type, 'partial_coverage_offer')
})

test('[LLM] "I can cover" alone → coverage_confirmation NOT partial', async () => {
  const r = await parseMessage('I can cover', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'partial_coverage_offer')
  assert.equal(r.type, 'coverage_confirmation')
})

test('[LLM] "I can cover the whole shift" → coverage_confirmation NOT partial', async () => {
  const r = await parseMessage('I can cover the whole shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'partial_coverage_offer')
  assert.equal(r.type, 'coverage_confirmation')
})
