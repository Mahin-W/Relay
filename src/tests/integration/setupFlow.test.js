import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShift, parseStaff, parseShiftRequirements } from '../../parseMessage.js'

// Calls real Groq — needs GROQ_API_KEY in .env

// ── parseShift ───────────────────────────────────────────────────────────────

test('parseShift: single shift description', async () => {
  const shifts = await parseShift('Saturday Lunch 11am-3pm')
  assert.ok(Array.isArray(shifts), 'should return array')
  assert.ok(shifts.length >= 1, 'should parse at least 1 shift')
  assert.ok(shifts[0].name, 'shift should have a name')
  assert.ok(shifts[0].day_of_week, 'shift should have day_of_week')
})

test('parseShift: bulk description expands to multiple shifts', async () => {
  const shifts = await parseShift('Mon Tue Wed 9am-1pm and 1pm-5pm')
  assert.ok(shifts.length >= 3, `expected 6 shifts (3 days × 2 times), got ${shifts.length}`)
})

test('parseShift: returns empty array for non-shift text', async () => {
  const shifts = await parseShift('what is the weather like today')
  assert.ok(Array.isArray(shifts), 'should return array')
  assert.equal(shifts.length, 0)
})

// ── parseStaff ───────────────────────────────────────────────────────────────

test('parseStaff: extracts named staff with roles', async () => {
  const staff = await parseStaff('Alice and Bob are servers, Mike is a cook', 'Manager')
  assert.ok(staff.length >= 2, `expected at least 2 staff, got ${staff.length}`)
  const names = staff.map(s => s.name)
  assert.ok(names.some(n => n.toLowerCase().includes('alice')), 'should include Alice')
})

test('parseStaff: returns empty for no staff mentioned', async () => {
  const staff = await parseStaff('we open at 10am', 'Manager')
  assert.ok(Array.isArray(staff))
  assert.equal(staff.length, 0)
})

// ── parseShiftRequirements ───────────────────────────────────────────────────

test('parseShiftRequirements: extracts requirements for a shift', async () => {
  const reqs = await parseShiftRequirements('Saturday Lunch needs 2 servers and 1 cook', ['Saturday Lunch'])
  assert.ok(reqs.length >= 1, `expected at least 1 requirement, got ${reqs.length}`)
  const total = reqs.reduce((sum, r) => sum + r.count, 0)
  assert.ok(total >= 2, 'should require at least 2 people total')
})

test('parseShiftRequirements: expands all shifts', async () => {
  const shiftNames = ['Monday Morning', 'Wednesday Afternoon']
  const reqs = await parseShiftRequirements('all shifts need 1 manager', shiftNames)
  assert.ok(reqs.length >= 2, `expected requirement for each shift, got ${reqs.length}`)
})
