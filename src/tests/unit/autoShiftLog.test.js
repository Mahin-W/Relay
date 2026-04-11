import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  buildShiftNarrative,
  compileShiftData,
  autoLogShift,
  formatLogEntry,
} from '../../managerLog/shiftLog.js'

// ── Test data ───────────────────────────────────────────────────────────────

const cleanShift = {
  shiftName: 'Tuesday Lunch',
  dayOfWeek: 'Tuesday',
  date: '2025-01-07',
  staffScheduled: [{ staffId: 1, staffName: 'Alice' }],
  callouts: [],
  coverageEvents: [],
  lateArrivals: [],
  noShows: [],
  fullyCovered: true,
}

const chaosShift = {
  shiftName: 'Friday Dinner',
  dayOfWeek: 'Friday',
  date: '2025-01-10',
  staffScheduled: [
    { staffId: 1, staffName: 'Marcus' },
    { staffId: 2, staffName: 'Dani' },
    { staffId: 3, staffName: 'Sarah' },
  ],
  callouts: [{ staffName: 'Marcus', reportedAt: '2025-01-10T16:02:00Z', minutesBefore: 58 }],
  coverageEvents: [{
    requestedBy: 'Marcus',
    coveredBy: 'Dani',
    requestedAt: '2025-01-10T16:02:00Z',
    confirmedAt: '2025-01-10T16:10:00Z',
    fillMinutes: 8,
    wasPartial: false,
  }],
  lateArrivals: [{ staffName: 'Sarah', minutesLate: 17 }],
  noShows: [],
  fullyCovered: true,
}

const noShowShift = {
  shiftName: 'Saturday Brunch',
  dayOfWeek: 'Saturday',
  date: '2025-01-11',
  staffScheduled: [{ staffId: 1, staffName: 'Jake' }],
  callouts: [],
  coverageEvents: [],
  lateArrivals: [],
  noShows: [{ staffName: 'Jake' }],
  fullyCovered: false,
}

const partialShift = {
  shiftName: 'Sunday Dinner',
  dayOfWeek: 'Sunday',
  date: '2025-01-12',
  staffScheduled: [
    { staffId: 1, staffName: 'Marcus' },
    { staffId: 2, staffName: 'Emma' },
  ],
  callouts: [{ staffName: 'Marcus', reportedAt: '2025-01-12T15:00:00Z', minutesBefore: 60 }],
  coverageEvents: [{
    requestedBy: 'Marcus',
    coveredBy: 'Emma',
    requestedAt: '2025-01-12T15:00:00Z',
    confirmedAt: '2025-01-12T15:15:00Z',
    fillMinutes: 15,
    wasPartial: true,
    partialFrom: '5:00pm',
    partialTo: '8:00pm',
  }],
  lateArrivals: [],
  noShows: [],
  fullyCovered: true,
}

// ── buildShiftNarrative ─────────────────────────────────────────────────────

describe('buildShiftNarrative', () => {
  it('clean shift: contains shift name, date, "Clean shift", no event text', () => {
    const out = buildShiftNarrative(cleanShift)
    assert.ok(out.includes('*Tuesday Lunch*'), 'should contain bold shift name')
    assert.ok(out.includes('Tuesday'), 'should contain day')
    assert.ok(out.includes('2025-01-07'), 'should contain date')
    assert.ok(out.includes('Clean shift'), 'should say clean shift')
    assert.ok(!out.includes('called out'), 'should not mention callouts')
    assert.ok(!out.includes('covered'), 'should not mention coverage')
    assert.ok(!out.includes('late'), 'should not mention late')
  })

  it('chaos shift: contains all event details', () => {
    const out = buildShiftNarrative(chaosShift)
    assert.ok(out.includes('Marcus'), 'should mention Marcus callout')
    assert.ok(out.includes('called out'), 'should say called out')
    assert.ok(out.includes('58'), 'should mention 58min before')
    assert.ok(out.includes('Dani'), 'should mention Dani covering')
    assert.ok(out.includes('covered'), 'should say covered')
    assert.ok(out.includes('8'), 'should mention 8min to confirm')
    assert.ok(out.includes('Sarah'), 'should mention Sarah late')
    assert.ok(out.includes('17'), 'should mention 17min late')
    assert.ok(out.includes('Full coverage achieved'), 'should note full coverage')
  })

  it('no show: contains no-show name and understaffed warning', () => {
    const out = buildShiftNarrative(noShowShift)
    assert.ok(out.includes('Jake'), 'should mention Jake')
    assert.ok(out.includes('no-showed'), 'should say no-showed')
    assert.ok(out.includes('understaffed'), 'should warn understaffed')
  })

  it('partial coverage: contains partial time range', () => {
    const out = buildShiftNarrative(partialShift)
    assert.ok(out.includes('Emma'), 'should mention Emma')
    assert.ok(out.includes('5:00pm'), 'should mention partial from')
    assert.ok(out.includes('8:00pm'), 'should mention partial to')
  })
})

// ── compileShiftData ────────────────────────────────────────────────────────

describe('compileShiftData', () => {
  it('returns correct structure from mock DB', async () => {
    const db = {
      getScheduleAssignments: async () => [
        { staff_id: 1, staff_name: 'Alice' },
        { staff_id: 2, staff_name: 'Bob' },
      ],
      getCoverageRequestsForShift: async () => [{
        requested_by: 'Alice',
        covered_by: 'Bob',
        status: 'covered',
        created_at: '2025-01-07T10:00:00Z',
        covered_at: '2025-01-07T10:05:00Z',
      }],
      getReliabilityEventsForDate: async () => [
        { staff_id: 1, event_type: 'late_arrival', metadata: { minutes_late: 12, staff_name: 'Alice' } },
      ],
      getNoShowEventsForShift: async () => [],
    }

    const result = await compileShiftData('-100', 'shift-1', '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)
    assert.ok(Array.isArray(result.staffScheduled))
    assert.equal(result.staffScheduled.length, 2)
    assert.ok(Array.isArray(result.coverageEvents))
    assert.equal(result.coverageEvents.length, 1)
    assert.ok(Array.isArray(result.lateArrivals))
    assert.equal(result.lateArrivals.length, 1)
    assert.ok(Array.isArray(result.noShows))
    assert.equal(result.shiftName, 'Tuesday Lunch')
    assert.equal(result.dayOfWeek, 'Tuesday')
  })

  it('empty DB results produce empty arrays', async () => {
    const db = {
      getScheduleAssignments: async () => [],
      getCoverageRequestsForShift: async () => [],
      getReliabilityEventsForDate: async () => [],
      getNoShowEventsForShift: async () => [],
    }

    const result = await compileShiftData('-100', 'shift-1', '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)
    assert.deepEqual(result.staffScheduled, [])
    assert.deepEqual(result.callouts, [])
    assert.deepEqual(result.coverageEvents, [])
    assert.deepEqual(result.lateArrivals, [])
    assert.deepEqual(result.noShows, [])
  })
})

// ── autoLogShift ────────────────────────────────────────────────────────────

describe('autoLogShift', () => {
  it('calls saveLogEntry with narrative, managerId=null, bot stays silent', async () => {
    const bot = new MockBot()
    let savedArgs = null
    const db = {
      getLogEntryForShiftDate: async () => null,
      getScheduleAssignments: async () => [{ staff_id: 1, staff_name: 'Alice' }],
      getCoverageRequestsForShift: async () => [],
      getReliabilityEventsForDate: async () => [],
      getNoShowEventsForShift: async () => [],
      saveLogEntry: async (groupId, managerId, text, shiftRef) => {
        savedArgs = { groupId, managerId, text, shiftRef }
        return { id: 1 }
      },
    }

    await autoLogShift(bot, '-100', 'shift-1', '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)

    assert.ok(savedArgs, 'saveLogEntry should have been called')
    assert.equal(savedArgs.groupId, '-100')
    assert.equal(savedArgs.managerId, null, 'managerId should be null for auto entries')
    assert.ok(savedArgs.text.includes('Tuesday Lunch'), 'narrative should contain shift name')
    assert.ok(savedArgs.shiftRef.shiftName, 'should have shiftRef.shiftName')
    bot.assertSilent()
  })

  it('skips if log entry already exists for shift+date', async () => {
    const bot = new MockBot()
    let saveWasCalled = false
    const db = {
      getLogEntryForShiftDate: async () => ({ id: 99, entry_text: 'already logged' }),
      saveLogEntry: async () => { saveWasCalled = true },
    }

    await autoLogShift(bot, '-100', 'shift-1', '2025-01-07', 'Tuesday Lunch', 'Tuesday', db)

    assert.ok(!saveWasCalled, 'saveLogEntry should NOT be called when entry already exists')
    bot.assertSilent()
  })
})

// ── formatLogEntry — auto indicator ─────────────────────────────────────────

describe('formatLogEntry — auto indicator', () => {
  const baseEntry = {
    entry_text: 'Clean shift. No issues.',
    shift_name: 'Tuesday Lunch',
    day_of_week: 'Tuesday',
    created_at: '2025-01-07T12:00:00.000Z',
    manager_id: null,
  }

  it('shows "(auto)" when manager_id is null', () => {
    const out = formatLogEntry(baseEntry)
    assert.ok(out.includes('_(auto)_'), 'should contain italic auto indicator')
  })

  it('no "(auto)" when manager_id is set', () => {
    const entry = { ...baseEntry, manager_id: 12345 }
    const out = formatLogEntry(entry)
    assert.ok(!out.includes('(auto)'), 'should NOT contain auto indicator')
  })
})
