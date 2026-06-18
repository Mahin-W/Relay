// throttledBroadcast.test.js — P1-13
// Tests: broadcastDMs sends once per recipient, continues past failures, spaces sends.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { broadcastDMs } from '../../coverage/throttledBroadcast.js'

await test('P1-13: broadcastDMs calls send once per recipient', async () => {
  const calls = []
  const fakeSend = async (chatId, text) => {
    calls.push({ chatId, text })
  }

  const recipients = [
    { dmChatId: '101', firstName: 'Alice' },
    { dmChatId: '102', firstName: 'Bob' },
    { dmChatId: '103', firstName: 'Carol' },
  ]

  await broadcastDMs(fakeSend, recipients, (r) => `Hey ${r.firstName}!`, { delayMs: 0 })

  assert.equal(calls.length, 3, 'should call send exactly once per recipient')
  assert.equal(calls[0].chatId, '101')
  assert.equal(calls[1].chatId, '102')
  assert.equal(calls[2].chatId, '103')
  assert.ok(calls[0].text.includes('Alice'))
  assert.ok(calls[1].text.includes('Bob'))
  assert.ok(calls[2].text.includes('Carol'))
})

await test('P1-13: broadcastDMs continues past a failing send', async () => {
  const calls = []
  const errors = []

  const fakeSend = async (chatId, text) => {
    calls.push({ chatId, text })
    if (chatId === '102') throw new Error('Telegram 429')
  }

  const recipients = [
    { dmChatId: '101', firstName: 'Alice' },
    { dmChatId: '102', firstName: 'Bob' },   // this one throws
    { dmChatId: '103', firstName: 'Carol' },
  ]

  // Should not throw
  await broadcastDMs(fakeSend, recipients, (r) => `Hey ${r.firstName}!`, { delayMs: 0, onError: (err, r) => errors.push({ err, r }) })

  assert.equal(calls.length, 3, 'all 3 sends attempted (Bob throws but continues)')
  assert.equal(errors.length, 1, 'one error captured')
  assert.equal(errors[0].r.firstName, 'Bob')
})

await test('P1-13: broadcastDMs skips recipients with no dmChatId', async () => {
  const calls = []
  const fakeSend = async (chatId, text) => { calls.push({ chatId, text }) }

  const recipients = [
    { dmChatId: '101', firstName: 'Alice' },
    { dmChatId: null, firstName: 'Bob' },    // no DM — should be skipped
    { firstName: 'Carol' },                  // also no DM
  ]

  await broadcastDMs(fakeSend, recipients, (r) => `Hey ${r.firstName}!`, { delayMs: 0 })

  assert.equal(calls.length, 1, 'only Alice should be messaged')
  assert.equal(calls[0].chatId, '101')
})

await test('P1-13: broadcastDMs spaces sends by delayMs', async () => {
  const timestamps = []
  let fakeNow = 0
  const fakeSend = async (chatId) => { timestamps.push(fakeNow) }
  const fakeSleep = async (ms) => { fakeNow += ms }

  const recipients = [
    { dmChatId: '101', firstName: 'Alice' },
    { dmChatId: '102', firstName: 'Bob' },
    { dmChatId: '103', firstName: 'Carol' },
  ]

  await broadcastDMs(fakeSend, recipients, (r) => `Hey ${r.firstName}!`, { delayMs: 50, _sleep: fakeSleep })

  // Each send should be spaced by delayMs except the last one (no sleep after last)
  assert.equal(timestamps.length, 3)
  assert.equal(timestamps[0], 0)    // Alice — no sleep before first send
  assert.equal(timestamps[1], 50)   // Bob — after first sleep
  assert.equal(timestamps[2], 100)  // Carol — after second sleep
})
