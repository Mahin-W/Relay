// G1 (3.03): Gap reporting when a role+day is entirely unfillable due to day_off rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateWeeklySchedule } from '../../schedule/generateSchedule.js'

const WEEK = '2025-04-14'

// Devon is the only Cook but has a day_off rule for Wednesday.
// The Mon-Fri Dinner shift spans Wednesday. Gaps must include Wed Cook.

test('G1: day_off rule excludes only Cook → gap reported for that day', async () => {
  const mockData = {
    shifts: [
      { id: 10, name: 'Dinner', day_of_week: 'Wednesday', start_time: '17:00', end_time: '23:00' },
    ],
    staff: [
      { id: 100, name: 'Devon', role: 'Cook', userId: 'u-devon', dmChatId: null },
    ],
    availability: [
      { user_id: 'u-devon', available_all: true, unavailable: false, available_shift_ids: [] },
    ],
    requirements: [
      { shift_id: 10, role: 'Cook', count: 1 },
    ],
    // Devon has day_off on Wednesday
    rules: [
      { id: 1, type: 'day_off', subjectStaffId: 100, subject_staff_id: 100,
        dayOfWeek: 'Wednesday', day_of_week: 'Wednesday', active: true,
        constraint_text: 'Devon never Wednesday', constraint: 'Devon never Wednesday' },
    ],
  }

  const result = await generateWeeklySchedule('g-test', WEEK, mockData)

  assert.ok(Array.isArray(result.gaps), 'gaps is array')
  assert.equal(result.assignments.length, 0, 'Devon must NOT be assigned (day_off)')

  const wedCookGap = result.gaps.find(g =>
    g.dayOfWeek === 'Wednesday' && /cook/i.test(g.roleName ?? '')
  )
  assert.ok(wedCookGap, `Gap for Wed Cook must exist. Got: ${JSON.stringify(result.gaps)}`)
  assert.equal(wedCookGap.shortfall, 1, 'shortfall must be 1')
  assert.equal(wedCookGap.needed, 1, 'needed must be 1')
  assert.equal(wedCookGap.found, 0, 'found must be 0')
})

test('G1: no day_off rule → Cook IS assigned, no gap', async () => {
  const mockData = {
    shifts: [
      { id: 10, name: 'Dinner', day_of_week: 'Wednesday', start_time: '17:00', end_time: '23:00' },
    ],
    staff: [
      { id: 100, name: 'Devon', role: 'Cook', userId: 'u-devon', dmChatId: null },
    ],
    availability: [
      { user_id: 'u-devon', available_all: true, unavailable: false, available_shift_ids: [] },
    ],
    requirements: [
      { shift_id: 10, role: 'Cook', count: 1 },
    ],
    rules: [],
  }

  const result = await generateWeeklySchedule('g-test2', WEEK, mockData)
  assert.equal(result.assignments.length, 1, 'Devon should be assigned')
  assert.equal(result.gaps.length, 0, 'No gaps when Cook is available')
})

test('G1: gap shape has all required fields', async () => {
  const mockData = {
    shifts: [
      { id: 20, name: 'Wed Dinner', day_of_week: 'Wednesday', start_time: '17:00', end_time: '23:00' },
    ],
    staff: [
      { id: 200, name: 'Devon', role: 'Cook', userId: 'u-d', dmChatId: null },
    ],
    availability: [
      { user_id: 'u-d', available_all: true, unavailable: false, available_shift_ids: [] },
    ],
    requirements: [
      { shift_id: 20, role: 'Cook', count: 1 },
    ],
    rules: [
      { id: 9, type: 'day_off', subjectStaffId: 200, subject_staff_id: 200,
        dayOfWeek: 'Wednesday', day_of_week: 'Wednesday', active: true,
        constraint_text: 'Devon off Wednesday' },
    ],
  }

  const result = await generateWeeklySchedule('g-test3', WEEK, mockData)
  assert.ok(result.gaps.length > 0, 'gap exists')
  const g = result.gaps[0]
  assert.ok('shiftId' in g, 'gap has shiftId')
  assert.ok('shiftName' in g, 'gap has shiftName')
  assert.ok('dayOfWeek' in g, 'gap has dayOfWeek')
  assert.ok('roleName' in g, 'gap has roleName')
  assert.ok('needed' in g, 'gap has needed')
  assert.ok('found' in g, 'gap has found')
  assert.ok('shortfall' in g, 'gap has shortfall')
})
