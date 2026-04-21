// BUG 1.14 — Late-arrival shift-end validation tests
// When a shift's end_time has already passed, the bot must NOT fire a late-arrival
// notification to the manager — instead it replies to staff that the shift ended.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'
import { handleLateArrival } from '../../lateArrival/handleLateArrival.js'

function makeDb(overrides = {}) {
  return {
    getSetupSession: async () => ({
      dm_chat_id: '99999',
      group_id: '-100',
      group_name: 'Test Kitchen',
      manager_id: 777,
    }),
    findShiftForToday: async () => ({
      shift: { name: 'Lunch', start_time: '11:00 AM', end_time: '2:00 PM' },
    }),
    ...overrides,
  }
}

// Build a shift end_time that is 1 hour in the past (local time string)
function endedShiftEndTime() {
  const past = new Date(Date.now() - 3600000) // 1 hour ago
  const h = past.getHours()
  const m = past.getMinutes().toString().padStart(2, '0')
  const meridiem = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${h12}:${m} ${meridiem}`
}

// Build a shift end_time 2 hours in the future
function futureShiftEndTime() {
  const future = new Date(Date.now() + 7200000)
  const h = future.getHours()
  const m = future.getMinutes().toString().padStart(2, '0')
  const meridiem = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${h12}:${m} ${meridiem}`
}

describe('handleLateArrival — shift-end validation (1.14)', () => {
  test('shift ended 1h ago → staff gets "shift already ended" message, no manager DM', async () => {
    const bot = new MockBot()
    const db = makeDb({
      findShiftForToday: async () => ({
        shift: { name: 'Lunch', start_time: '11:00 AM', end_time: endedShiftEndTime() },
      }),
    })
    const msg = makeGroupMsg({ text: 'running 20 min late', from: { id: 12345, first_name: 'Alice' } })
    const intent = { type: 'running_late', person: 'Alice', minutes: 20, eta: null }

    await handleLateArrival(bot, msg, intent, db)

    // Manager DM must NOT be sent
    bot.assertSilent('99999')

    // Staff must get a message mentioning the shift ended
    const staffMsgs = bot.messagesTo(msg.chat.id)
    assert.ok(staffMsgs.length > 0, 'Bot must send a reply to the group')
    const replyText = staffMsgs.map(m => m.text.toLowerCase()).join(' ')
    assert.ok(
      replyText.includes('ended') || replyText.includes('no-show') || replyText.includes('manager'),
      `Expected shift-ended message, got: ${staffMsgs.map(m => m.text).join(' | ')}`
    )
  })

  test('shift ended 1h ago → reply does not contain "late" confirmation', async () => {
    const bot = new MockBot()
    const db = makeDb({
      findShiftForToday: async () => ({
        shift: { name: 'Dinner', start_time: '5:00 PM', end_time: endedShiftEndTime() },
      }),
    })
    const msg = makeGroupMsg({ text: 'running late sorry', from: { id: 12345, first_name: 'Bob' } })
    const intent = { type: 'running_late', person: 'Bob', minutes: null, eta: null }

    await handleLateArrival(bot, msg, intent, db)

    const groupMsgs = bot.messagesTo(msg.chat.id)
    const allText = groupMsgs.map(m => m.text).join(' ')

    // Must not say "Got it" (the normal running-late ack)
    assert.ok(
      !allText.includes('Got it') || allText.toLowerCase().includes('ended'),
      `Should not send normal "Got it" ack when shift ended. Got: ${allText}`
    )

    // Manager DM silent
    bot.assertSilent('99999')
  })

  test('shift still in progress → sends normal "Got it" ack AND DMs manager', async () => {
    const bot = new MockBot()
    const db = makeDb({
      findShiftForToday: async () => ({
        shift: { name: 'Evening', start_time: '4:00 PM', end_time: futureShiftEndTime() },
      }),
    })
    const msg = makeGroupMsg({ text: 'running 15 min late', from: { id: 12345, first_name: 'Carol' } })
    const intent = { type: 'running_late', person: 'Carol', minutes: 15, eta: null }

    await handleLateArrival(bot, msg, intent, db)

    // Group ack sent
    bot.assertSent(msg.chat.id, 'Got it')

    // Manager DM sent
    const managerMsgs = bot.messagesTo('99999')
    assert.ok(managerMsgs.length > 0, 'Manager DM should be sent when shift is still active')
    bot.assertSent('99999', 'Carol')
  })

  test('no shift found → still sends "Got it" and DMs manager (unchanged behavior)', async () => {
    const bot = new MockBot()
    const db = makeDb({
      findShiftForToday: async () => null,
    })
    const msg = makeGroupMsg({ text: 'running late', from: { id: 12345, first_name: 'Dave' } })
    const intent = { type: 'running_late', person: 'Dave', minutes: null, eta: null }

    await handleLateArrival(bot, msg, intent, db)

    bot.assertSent(msg.chat.id, 'Got it')
    bot.assertSent('99999', 'No shift found')
  })
})
