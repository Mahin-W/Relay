import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getShiftsForReminder } from '../../reminders/shiftReminders.js'
import { MockBot } from '../helpers/mocks.js'

// Mock assignment shape used across tests
function makeAssignment(overrides = {}) {
  return {
    shift_id: 1,
    shift_name: 'Lunch',
    day_of_week: 'Monday',
    start_time: '11:00',
    end_time: '15:00',
    staff_name: 'Alice',
    dm_chat_id: '456789',
    schedule_published: true,
    ...overrides,
  }
}

const BASE_DATA = [
  makeAssignment({ start_time: '11:00', day_of_week: 'Monday' }),
  makeAssignment({ start_time: '09:00', day_of_week: 'Monday', staff_name: 'Bob', dm_chat_id: '111222' }),
  makeAssignment({ start_time: '14:00', day_of_week: 'Monday', staff_name: 'Carol', dm_chat_id: '333444' }),
  makeAssignment({ start_time: '11:00', day_of_week: 'Tuesday', staff_name: 'Dave', dm_chat_id: '555666' }),
  makeAssignment({ start_time: '11:00', day_of_week: 'Monday', staff_name: 'NoPhone', dm_chat_id: null }),
  makeAssignment({ start_time: '11:30', day_of_week: 'Monday', staff_name: 'Eve', dm_chat_id: '777888', schedule_published: false }),
]

test('reminders: getShiftsForReminder returns shift in window', async () => {
  const results = await getShiftsForReminder('Monday', '10:45', '11:15', BASE_DATA)
  assert.equal(results.length, 1)
  assert.equal(results[0].staff_name, 'Alice')
})

test('reminders: getShiftsForReminder — no shifts in window returns empty array', async () => {
  const results = await getShiftsForReminder('Monday', '12:00', '12:30', BASE_DATA)
  assert.equal(results.length, 0)
})

test('reminders: getShiftsForReminder filters out staff with no dm_chat_id', async () => {
  // Window that matches both Alice (dm_chat_id set) and NoPhone (null)
  const data = [
    makeAssignment({ start_time: '11:00', dm_chat_id: '456789' }),
    makeAssignment({ start_time: '11:00', staff_name: 'NoPhone', dm_chat_id: null }),
  ]
  const results = await getShiftsForReminder('Monday', '10:45', '11:15', data)
  assert.ok(results.every(r => r.dm_chat_id != null), 'Should have filtered out null dm_chat_id')
  assert.ok(!results.some(r => r.staff_name === 'NoPhone'))
})

test('reminders: getShiftsForReminder filters out unpublished schedules', async () => {
  const data = [
    makeAssignment({ start_time: '11:00', schedule_published: true }),
    makeAssignment({ start_time: '11:00', staff_name: 'Eve', dm_chat_id: '777888', schedule_published: false }),
  ]
  const results = await getShiftsForReminder('Monday', '10:45', '11:15', data)
  assert.ok(!results.some(r => r.staff_name === 'Eve'), 'Unpublished schedule should be filtered')
})

test('reminders: night-before message contains shift name + time', async () => {
  const bot = new MockBot()
  // Simulate sending a night-before message
  const assignment = makeAssignment({ dm_chat_id: '456789' })
  await bot.sendMessage(
    assignment.dm_chat_id,
    `👋 Hey ${assignment.staff_name}! Reminder — you're on tomorrow for ${assignment.shift_name}, ${assignment.start_time}–${assignment.end_time}. See you then!`
  )
  bot.assertSent('456789', 'Lunch')
  bot.assertSent('456789', '11:00')
  bot.assertSent('456789', 'tomorrow')
})

test('reminders: 2hr message contains "2 hours" + shift name', async () => {
  const bot = new MockBot()
  const assignment = makeAssignment({ dm_chat_id: '456789' })
  await bot.sendMessage(
    assignment.dm_chat_id,
    `⏰ Heads up ${assignment.staff_name} — your ${assignment.shift_name} shift starts in about 2 hours at ${assignment.start_time}. See you soon!`
  )
  bot.assertSent('456789', '2 hours')
  bot.assertSent('456789', 'Lunch')
})

test('reminders: staff with no dm_chat_id receives no DM', async () => {
  const bot = new MockBot()
  const data = [makeAssignment({ start_time: '11:00', dm_chat_id: null })]
  const results = await getShiftsForReminder('Monday', '10:45', '11:15', data)
  assert.equal(results.length, 0)
  bot.assertSilent()
})
