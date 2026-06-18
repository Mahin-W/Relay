import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { expandShiftRows, groupParsedShifts, normalizeTime, splitNames, TEMPLATES } from '../../../public/onboardingHelpers.js'

describe('expandShiftRows', () => {
  test('one row → one shift per selected day, requirements carried', () => {
    const out = expandShiftRows([{ name: 'Lunch', days: ['Monday', 'Tuesday'], start: '11:00 AM', end: '3:00 PM', requirements: [{ role: 'Server', count: 2 }] }])
    assert.equal(out.length, 2)
    assert.equal(out[0].day_of_week, 'Monday')
    assert.deepEqual(out[1].requirements, [{ role: 'Server', count: 2 }])
  })
  test('rows with no name or no days are skipped', () => {
    assert.equal(expandShiftRows([{ name: '', days: ['Monday'] }, { name: 'X', days: [] }]).length, 0)
  })
})

describe('groupParsedShifts', () => {
  test('collapses identical name+time across days into one multi-day row', () => {
    const rows = groupParsedShifts([
      { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00 AM', end_time: '3:00 PM', requirements: [{ role: 'Server', count: 2 }] },
      { name: 'Lunch', day_of_week: 'Tuesday', start_time: '11:00 AM', end_time: '3:00 PM', requirements: [{ role: 'Server', count: 1 }] },
    ])
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].days, ['Monday', 'Tuesday'])
    assert.equal(rows[0].requirements[0].count, 2) // max merge
  })
})

describe('normalizeTime', () => {
  test('parses many formats to 12-hour display', () => {
    assert.equal(normalizeTime('11'), '11:00 AM')
    assert.equal(normalizeTime('11a'), '11:00 AM')
    assert.equal(normalizeTime('1330'), '1:30 PM')
    assert.equal(normalizeTime('5pm'), '5:00 PM')
    assert.equal(normalizeTime('12am'), '12:00 AM')
  })
  test('returns input unchanged when unparseable', () => {
    assert.equal(normalizeTime('lunchtime'), 'lunchtime')
  })
})

describe('splitNames', () => {
  test('splits on newlines and commas', () => {
    assert.deepEqual(splitNames('Sam, Alex\nJo'), ['Sam', 'Alex', 'Jo'])
  })
})

describe('TEMPLATES', () => {
  test('Restaurant template has roles and shifts', () => {
    assert.ok(TEMPLATES.Restaurant.roles.includes('Server'))
    assert.ok(TEMPLATES.Restaurant.shifts.length > 0)
  })
})
