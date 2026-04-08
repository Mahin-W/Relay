import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage, isDmConfirmation } from '../../parseMessage.js'

// Calls real Groq — needs GROQ_API_KEY in .env

test('explicit coverage request → coverage_request', async () => {
  const r = await parseMessage('Can anyone cover my shift?', 'Alice', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

test('calling in sick → coverage_request', async () => {
  const r = await parseMessage("I'm calling in sick today, need someone to cover", 'Bob', 'Test Group')
  assert.equal(r.type, 'coverage_request')
})

test('coverage with day → shift field has day info', async () => {
  const r = await parseMessage('Can anyone grab my Friday morning shift?', 'Alice', 'Test Group')
  assert.equal(r.type, 'coverage_request')
  assert.ok(r.shift?.toLowerCase().includes('friday'), `expected shift to mention friday, got: ${r.shift}`)
})

test('formal confirmation → coverage_confirmation', async () => {
  const r = await parseMessage('I can cover that shift', 'Mike', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

test('slang confirmation "bet" → coverage_confirmation', async () => {
  const r = await parseMessage('bet', 'Mike', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

test('slang confirmation "igu" → coverage_confirmation', async () => {
  const r = await parseMessage('igu', 'Sarah', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

test('"say less" → coverage_confirmation', async () => {
  const r = await parseMessage('say less', 'Jay', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

test('genuine maybe → coverage_maybe', async () => {
  const r = await parseMessage('maybe, let me check my schedule', 'Sam', 'Test Group')
  assert.equal(r.type, 'coverage_maybe')
})

test('cancel coverage → cancel_coverage', async () => {
  const r = await parseMessage('never mind, I found someone', 'Alice', 'Test Group')
  assert.equal(r.type, 'cancel_coverage')
})

test('trade request → trade_request', async () => {
  const r = await parseMessage('trade my monday morning shift, anyone?', 'Alice', 'Test Group')
  assert.equal(r.type, 'trade_request')
})

test('irrelevant message → irrelevant', async () => {
  const r = await parseMessage('What time does the restaurant open?', 'Someone', 'Test Group')
  assert.equal(r.type, 'irrelevant')
})

test('hedge + commitment → coverage_confirmation', async () => {
  const r = await parseMessage('yea i think igu', 'Tony', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

test('👍 emoji → coverage_confirmation', async () => {
  const r = await parseMessage('👍', 'Dana', 'Test Group')
  assert.equal(r.type, 'coverage_confirmation')
})

// isDmConfirmation tests

test('isDmConfirmation: "yes" → true', async () => {
  const result = await isDmConfirmation('yes')
  assert.equal(result, true)
})

test('isDmConfirmation: "nah cant make it" → false', async () => {
  const result = await isDmConfirmation("nah can't make it")
  assert.equal(result, false)
})
