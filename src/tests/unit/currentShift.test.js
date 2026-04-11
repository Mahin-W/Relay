import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  parseShiftTime,
  isShiftActive,
  getMinutesIntoShift,
  getMinutesUntilShiftEnd,
  getHoursRemainingFormatted,
  getCurrentShifts,
  getActiveShifts,
  getUpcomingShifts,
  formatCurrentRoster,
  handleWhoIsWorkingQuery,
} from '../../schedule/currentShift.js'

// ── Fixed dates for deterministic tests ──────────────────────────────────────

const monday11am = new Date('2025-01-06T11:00:00')
const monday1130am = new Date('2025-01-06T11:30:00')
const monday2pm = new Date('2025-01-06T14:00:00')
const monday345pm = new Date('2025-01-06T15:45:00')
const monday5pm = new Date('2025-01-06T17:00:00')
const monday9pm = new Date('2025-01-06T21:00:00')
const monday11pm = new Date('2025-01-06T23:00:00')
const tuesday1am = new Date('2025-01-07T01:00:00')
const wednesday2pm = new Date('2025-01-08T14:00:00')

// ── Test shifts ──────────────────────────────────────────────────────────────

const lunchShift = { startTime: '11am', endTime: '4pm', dayOfWeek: 'Monday' }
const dinnerShift = { startTime: '5pm', endTime: '11pm', dayOfWeek: 'Monday' }
const lateShift = { startTime: '10pm', endTime: '2am', dayOfWeek: 'Monday' }

// ── parseShiftTime ───────────────────────────────────────────────────────────

describe('parseShiftTime', () => {
  const refDate = new Date('2025-01-06T00:00:00')

  test('"11am" → 11:00', () => {
    const d = parseShiftTime('11am', refDate)
    assert.equal(d.getHours(), 11)
    assert.equal(d.getMinutes(), 0)
  })

  test('"5pm" → 17:00', () => {
    const d = parseShiftTime('5pm', refDate)
    assert.equal(d.getHours(), 17)
    assert.equal(d.getMinutes(), 0)
  })

  test('"11:30pm" → 23:30', () => {
    const d = parseShiftTime('11:30pm', refDate)
    assert.equal(d.getHours(), 23)
    assert.equal(d.getMinutes(), 30)
  })

  test('"12am" → 00:00', () => {
    const d = parseShiftTime('12am', refDate)
    assert.equal(d.getHours(), 0)
    assert.equal(d.getMinutes(), 0)
  })

  test('"12pm" → 12:00', () => {
    const d = parseShiftTime('12pm', refDate)
    assert.equal(d.getHours(), 12)
    assert.equal(d.getMinutes(), 0)
  })

  test('"2:30pm" → 14:30', () => {
    const d = parseShiftTime('2:30pm', refDate)
    assert.equal(d.getHours(), 14)
    assert.equal(d.getMinutes(), 30)
  })

  test('"23:00" → 23:00', () => {
    const d = parseShiftTime('23:00', refDate)
    assert.equal(d.getHours(), 23)
    assert.equal(d.getMinutes(), 0)
  })

  test('"9:00 AM" → 9:00', () => {
    const d = parseShiftTime('9:00 AM', refDate)
    assert.equal(d.getHours(), 9)
    assert.equal(d.getMinutes(), 0)
  })

  test('"1:30 PM" → 13:30', () => {
    const d = parseShiftTime('1:30 PM', refDate)
    assert.equal(d.getHours(), 13)
    assert.equal(d.getMinutes(), 30)
  })

  test('invalid input → null', () => {
    assert.equal(parseShiftTime(null, refDate), null)
    assert.equal(parseShiftTime('', refDate), null)
    assert.equal(parseShiftTime('banana', refDate), null)
    assert.equal(parseShiftTime(undefined, refDate), null)
  })
})

// ── isShiftActive ────────────────────────────────────────────────────────────

describe('isShiftActive', () => {
  test('lunchShift at exactly 11am (start) → false', () => {
    assert.equal(isShiftActive(lunchShift, monday11am), false)
  })

  test('lunchShift at 2pm → true', () => {
    assert.equal(isShiftActive(lunchShift, monday2pm), true)
  })

  test('lunchShift at 5pm (past end) → false', () => {
    assert.equal(isShiftActive(lunchShift, monday5pm), false)
  })

  test('dinnerShift at exactly 5pm (start) → false', () => {
    assert.equal(isShiftActive(dinnerShift, monday5pm), false)
  })

  test('dinnerShift at exactly 11pm (end) → false', () => {
    assert.equal(isShiftActive(dinnerShift, monday11pm), false)
  })

  test('dinnerShift at 9pm → true', () => {
    assert.equal(isShiftActive(dinnerShift, monday9pm), true)
  })

  test('lateShift at 11pm (after start, same day) → true', () => {
    assert.equal(isShiftActive(lateShift, monday11pm), true)
  })

  test('lateShift at tuesday 1am (midnight crossing) → true', () => {
    assert.equal(isShiftActive(lateShift, tuesday1am), true)
  })

  test('wrong day → false', () => {
    assert.equal(isShiftActive(lunchShift, wednesday2pm), false)
  })
})

// ── getMinutesIntoShift ──────────────────────────────────────────────────────

describe('getMinutesIntoShift', () => {
  test('at 11:30am into lunch → 30', () => {
    assert.equal(getMinutesIntoShift(lunchShift, monday1130am), 30)
  })

  test('at 2pm into lunch → 180', () => {
    assert.equal(getMinutesIntoShift(lunchShift, monday2pm), 180)
  })

  test('at 5pm (not active) → null', () => {
    assert.equal(getMinutesIntoShift(lunchShift, monday5pm), null)
  })
})

// ── getMinutesUntilShiftEnd ──────────────────────────────────────────────────

describe('getMinutesUntilShiftEnd', () => {
  test('at 11:30am lunch ends at 4pm → 270', () => {
    assert.equal(getMinutesUntilShiftEnd(lunchShift, monday1130am), 270)
  })

  test('at 3:45pm lunch ends at 4pm → 15', () => {
    assert.equal(getMinutesUntilShiftEnd(lunchShift, monday345pm), 15)
  })

  test('at 5pm (not active) → null', () => {
    assert.equal(getMinutesUntilShiftEnd(lunchShift, monday5pm), null)
  })
})

// ── getHoursRemainingFormatted ───────────────────────────────────────────────

describe('getHoursRemainingFormatted', () => {
  test('120 → "2hrs"', () => {
    assert.equal(getHoursRemainingFormatted(120), '2hrs')
  })

  test('90 → "1hr 30min"', () => {
    assert.equal(getHoursRemainingFormatted(90), '1hr 30min')
  })

  test('45 → "45min"', () => {
    assert.equal(getHoursRemainingFormatted(45), '45min')
  })

  test('5 → "5min"', () => {
    assert.equal(getHoursRemainingFormatted(5), '5min')
  })

  test('0 → "0min"', () => {
    assert.equal(getHoursRemainingFormatted(0), '0min')
  })
})

// ── getCurrentShifts ─────────────────────────────────────────────────────────

describe('getCurrentShifts', () => {
  test('returns shifts with computed status from mock DB', async () => {
    const mockDb = {
      getCurrentShifts: async (groupId) => {
        assert.equal(groupId, '123')
        return [
          {
            shiftId: 1, shiftName: 'Lunch', staffId: 10, staffName: 'Alice',
            roleName: 'Server', startTime: '11am', endTime: '4pm', dayOfWeek: 'Monday',
          },
          {
            shiftId: 2, shiftName: 'Dinner', staffId: 11, staffName: 'Bob',
            roleName: 'Cook', startTime: '5pm', endTime: '11pm', dayOfWeek: 'Monday',
          },
        ]
      },
    }

    const shifts = await getCurrentShifts('123', monday2pm, mockDb)
    assert.equal(shifts.length, 2)

    // Lunch at 2pm → active
    assert.equal(shifts[0].status, 'active')
    assert.equal(shifts[0].minutesIn, 180)
    assert.equal(shifts[0].minutesRemaining, 120)
    assert.equal(shifts[0].startsInMinutes, null)

    // Dinner at 2pm → upcoming
    assert.equal(shifts[1].status, 'upcoming')
    assert.equal(shifts[1].minutesIn, null)
    assert.equal(shifts[1].minutesRemaining, null)
    assert.equal(shifts[1].startsInMinutes, 180)
  })
})

// ── getUpcomingShifts ────────────────────────────────────────────────────────

describe('getUpcomingShifts', () => {
  test('filters to upcoming within N minutes', async () => {
    const mockDb = {
      getCurrentShifts: async () => [
        {
          shiftId: 1, shiftName: 'Lunch', staffId: 10, staffName: 'Alice',
          roleName: 'Server', startTime: '11am', endTime: '4pm', dayOfWeek: 'Monday',
        },
        {
          shiftId: 2, shiftName: 'Dinner', staffId: 11, staffName: 'Bob',
          roleName: 'Cook', startTime: '5pm', endTime: '11pm', dayOfWeek: 'Monday',
        },
      ],
    }

    // At 2pm, dinner starts in 180min — within 120 should not include it
    const within120 = await getUpcomingShifts('123', 120, monday2pm, mockDb)
    assert.equal(within120.length, 0)

    // Within 200 should include dinner (starts in 180)
    const within200 = await getUpcomingShifts('123', 200, monday2pm, mockDb)
    assert.equal(within200.length, 1)
    assert.equal(within200[0].shiftName, 'Dinner')
  })
})

// ── formatCurrentRoster ──────────────────────────────────────────────────────

describe('formatCurrentRoster', () => {
  test('formats active, upcoming, and ended shifts', () => {
    const shifts = [
      {
        shiftName: 'Lunch', staffName: 'Alice', roleName: 'Server',
        status: 'active', minutesIn: 180, minutesRemaining: 120,
        startTime: '11am', endTime: '4pm',
      },
      {
        shiftName: 'Dinner', staffName: 'Bob', roleName: 'Cook',
        status: 'upcoming', startsInMinutes: 60,
        startTime: '5pm', endTime: '11pm',
      },
      {
        shiftName: 'Breakfast', staffName: 'Cara', roleName: 'Host',
        status: 'ended', startTime: '7am', endTime: '11am',
        minutesIn: null, minutesRemaining: null, startsInMinutes: null,
      },
    ]

    const text = formatCurrentRoster(shifts, monday2pm)
    assert.ok(text.includes('On shift:'))
    assert.ok(text.includes('Alice'))
    assert.ok(text.includes('3hrs in'))
    assert.ok(text.includes('Starting soon'))
    assert.ok(text.includes('Bob'))
    assert.ok(text.includes('in 1hr'))
    assert.ok(text.includes('Ended today:'))
    assert.ok(text.includes('Cara'))
  })

  test('empty shifts → no shifts message', () => {
    const text = formatCurrentRoster([], monday2pm)
    assert.ok(text.includes('No shifts scheduled today'))
  })
})

// ── handleWhoIsWorkingQuery ──────────────────────────────────────────────────

describe('handleWhoIsWorkingQuery', () => {
  test('sends formatted roster to chat', async () => {
    const bot = new MockBot()
    const msg = {
      chat: { id: -100123, type: 'group' },
      from: { id: 999, first_name: 'Manager' },
    }
    const mockDb = {
      getCurrentShifts: async () => [
        {
          shiftId: 1, shiftName: 'Lunch', staffId: 10, staffName: 'Alice',
          roleName: 'Server', startTime: '11am', endTime: '4pm', dayOfWeek: 'Monday',
        },
      ],
    }

    await handleWhoIsWorkingQuery(bot, msg, mockDb, monday2pm)

    const sent = bot.lastMessage(String(-100123))
    assert.ok(sent, 'Bot should have sent a message')
    assert.ok(sent.text.includes('Alice'))
    assert.equal(sent.options.parse_mode, 'Markdown')
  })

  test('sends no-shifts message when empty', async () => {
    const bot = new MockBot()
    const msg = {
      chat: { id: -100123, type: 'group' },
      from: { id: 999, first_name: 'Manager' },
    }
    const mockDb = {
      getCurrentShifts: async () => [],
    }

    await handleWhoIsWorkingQuery(bot, msg, mockDb, monday2pm)

    const sent = bot.lastMessage(String(-100123))
    assert.ok(sent.text.includes('No shifts scheduled today'))
  })
})
