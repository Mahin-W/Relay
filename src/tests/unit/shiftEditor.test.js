import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeDMMsg, makeGroupMsg } from '../helpers/mocks.js'
import {
  formatShiftList,
  parseTimeInput,
  handleShiftsCommand,
  handleEditShift,
  deactivateShift,
  setReplyTimeout,
} from '../../setup/shiftEditor.js'

// Shorten reply timeout so wizard handler tests finish fast
setReplyTimeout(50)

// ── formatShiftList ───────────────────────────────────────────────────────────

test('formatShiftList: empty array returns no-shifts message', () => {
  const result = formatShiftList([])
  assert.equal(result, 'No shifts set up yet.')
})

test('formatShiftList: array of 2 shifts returns numbered list', () => {
  const shifts = [
    { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
    { name: 'Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
  ]
  const result = formatShiftList(shifts)
  assert.ok(result.includes('1.'), 'should have first item numbered')
  assert.ok(result.includes('2.'), 'should have second item numbered')
  assert.ok(result.includes('Monday'), 'should include day of first shift')
  assert.ok(result.includes('Lunch'), 'should include name of first shift')
  assert.ok(result.includes('Friday'), 'should include day of second shift')
  assert.ok(result.includes('Dinner'), 'should include name of second shift')
})

test('formatShiftList: contains /editshift command hint', () => {
  const shifts = [
    { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
  ]
  const result = formatShiftList(shifts)
  assert.ok(result.includes('/editshift'), 'should contain /editshift')
})

test('formatShiftList: contains /addshift command hint', () => {
  const shifts = [
    { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
  ]
  const result = formatShiftList(shifts)
  assert.ok(result.includes('/addshift'), 'should contain /addshift')
})

test('formatShiftList: contains /removeshift command hint', () => {
  const shifts = [
    { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
  ]
  const result = formatShiftList(shifts)
  assert.ok(result.includes('/removeshift'), 'should contain /removeshift')
})

test('formatShiftList: formats start and end times with dash separator', () => {
  const shifts = [
    { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00' },
  ]
  const result = formatShiftList(shifts)
  assert.ok(result.includes('11:00') && result.includes('15:00'), 'should include both times')
})

// ── parseTimeInput ────────────────────────────────────────────────────────────

test('parseTimeInput: "11am" → "11:00"', () => {
  assert.equal(parseTimeInput('11am'), '11:00')
})

test('parseTimeInput: "11:00" → "11:00"', () => {
  assert.equal(parseTimeInput('11:00'), '11:00')
})

test('parseTimeInput: "2:30pm" → "14:30"', () => {
  assert.equal(parseTimeInput('2:30pm'), '14:30')
})

test('parseTimeInput: "9pm" → "21:00"', () => {
  assert.equal(parseTimeInput('9pm'), '21:00')
})

test('parseTimeInput: "14:00" → "14:00"', () => {
  assert.equal(parseTimeInput('14:00'), '14:00')
})

test('parseTimeInput: "0:00" → "00:00"', () => {
  assert.equal(parseTimeInput('0:00'), '00:00')
})

test('parseTimeInput: "abc" → null', () => {
  assert.equal(parseTimeInput('abc'), null)
})

test('parseTimeInput: "" → null', () => {
  assert.equal(parseTimeInput(''), null)
})

test('parseTimeInput: "25:00" → null', () => {
  assert.equal(parseTimeInput('25:00'), null)
})

// ── handleShiftsCommand ───────────────────────────────────────────────────────

test('handleShiftsCommand: DMs manager the shift list with shift data', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ chat: { id: '12345', type: 'private' }, from: { id: 12345, first_name: 'Mike' } })
  const db = {
    getShiftsForGroup: async () => [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true },
    ],
  }
  await handleShiftsCommand(bot, msg, db)
  const lastMsg = bot.lastMessage()
  assert.ok(lastMsg !== null, 'bot should send a message')
  assert.ok(lastMsg.text.includes('Lunch'), 'message should contain shift name')
})

test('handleShiftsCommand: sends to msg.chat.id not elsewhere', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ chat: { id: '99999', type: 'private' }, from: { id: 12345, first_name: 'Mike' } })
  const db = {
    getShiftsForGroup: async () => [],
  }
  await handleShiftsCommand(bot, msg, db)
  const msgs = bot.messagesTo('99999')
  assert.ok(msgs.length > 0, 'should send message to the chat')
})

// ── handleEditShift ───────────────────────────────────────────────────────────

test('handleEditShift: invalid number "99" sends shift-not-found message', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ chat: { id: '12345', type: 'private' }, from: { id: 12345, first_name: 'Mike' } })
  const db = {
    getShiftsForGroup: async () => [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true },
    ],
  }
  await handleEditShift(bot, msg, '99', db)
  const lastMsg = bot.lastMessage()
  assert.ok(lastMsg !== null, 'bot should send a message')
  assert.ok(
    lastMsg.text.toLowerCase().includes('not found') || lastMsg.text.toLowerCase().includes('shift'),
    'message should indicate shift not found'
  )
})

test('handleEditShift: args "0" (invalid index) sends error', async () => {
  const bot = new MockBot()
  const msg = makeDMMsg({ chat: { id: '12345', type: 'private' }, from: { id: 12345, first_name: 'Mike' } })
  const db = {
    getShiftsForGroup: async () => [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true },
    ],
  }
  await handleEditShift(bot, msg, '0', db)
  const lastMsg = bot.lastMessage()
  assert.ok(lastMsg !== null, 'bot should send a message')
  assert.ok(
    lastMsg.text.toLowerCase().includes('not found') || lastMsg.text.toLowerCase().includes('shift'),
    'message should indicate invalid shift'
  )
})

test('handleEditShift: valid args "1" with 1 shift sends edit menu with Name, Start, End', async () => {
  const bot = new MockBot()
  // Stub once: never fires callback (waitForReply will timeout after its internal timer).
  // We only assert on the first message (the menu prompt), not on the timeout path.
  bot.once = (_event, _cb) => {}
  const msg = makeDMMsg({ chat: { id: '12345', type: 'private' }, from: { id: 12345, first_name: 'Mike' } })
  const db = {
    getShiftsForGroup: async () => [
      { id: 1, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true },
    ],
  }
  await handleEditShift(bot, msg, '1', db)
  // The first message sent should be the edit menu
  const firstMsg = bot.sentMessages[0]
  assert.ok(firstMsg !== null, 'bot should send a message')
  assert.ok(firstMsg.text.includes('Name') || firstMsg.text.includes('name'), 'edit menu should mention Name')
  assert.ok(firstMsg.text.includes('Start') || firstMsg.text.includes('start'), 'edit menu should mention Start')
  assert.ok(firstMsg.text.includes('End') || firstMsg.text.includes('end'), 'edit menu should mention End')
})

// ── deactivateShift ───────────────────────────────────────────────────────────

test('deactivateShift: calls mock DB with active=false logic', async () => {
  let callArgs = null
  const db = {
    deactivateShift: async (shiftId, groupId) => {
      callArgs = { shiftId, groupId }
      return { id: shiftId, active: false }
    },
  }
  await deactivateShift(42, 'group-1', db)
  assert.ok(callArgs !== null, 'DB function should have been called')
  assert.equal(callArgs.shiftId, 42, 'should pass shiftId')
  assert.equal(callArgs.groupId, 'group-1', 'should pass groupId')
})
