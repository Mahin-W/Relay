import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage } from '../../parsers/messageParsers.js'

await Promise.all([
  test('"I\'m on call this week" → on_call_offer with all_week: true', async () => {
    const result = await parseMessage("I'm on call this week", 'Alice', 'Kitchen Staff')
    assert.equal(result.type, 'on_call_offer', `Expected on_call_offer, got ${result.type}`)
    assert.equal(result.all_week, true)
  }),

  test('"ping me if you need someone" → on_call_offer', async () => {
    const result = await parseMessage('ping me if you need someone', 'Bob', 'Kitchen Staff')
    assert.equal(result.type, 'on_call_offer', `Expected on_call_offer, got ${result.type}`)
  }),

  test('"I can pick up extra shifts" → on_call_offer', async () => {
    const result = await parseMessage('I can pick up extra shifts', 'Carol', 'Kitchen Staff')
    assert.equal(result.type, 'on_call_offer', `Expected on_call_offer, got ${result.type}`)
  }),

  test('"available if anyone needs coverage" → on_call_offer', async () => {
    const result = await parseMessage('available if anyone needs coverage', 'Dave', 'Kitchen Staff')
    assert.equal(result.type, 'on_call_offer', `Expected on_call_offer, got ${result.type}`)
  }),

  test('"I can cover that" → coverage_confirmation NOT on_call_offer', async () => {
    const result = await parseMessage('I can cover that', 'Eve', 'Kitchen Staff')
    assert.equal(result.type, 'coverage_confirmation', `Expected coverage_confirmation, got ${result.type}`)
  }),

  test('"I\'m available Monday" → availability_mention NOT on_call_offer', async () => {
    const result = await parseMessage("I'm available Monday", 'Frank', 'Kitchen Staff')
    assert.equal(result.type, 'availability_mention', `Expected availability_mention, got ${result.type}`)
  }),

  test('"can anyone cover my shift" → coverage_request NOT on_call_offer', async () => {
    const result = await parseMessage('can anyone cover my shift', 'Grace', 'Kitchen Staff')
    assert.equal(result.type, 'coverage_request', `Expected coverage_request, got ${result.type}`)
  }),
])
