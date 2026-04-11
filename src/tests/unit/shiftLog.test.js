import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeDMMsg, makeGroupMsg } from '../helpers/mocks.js'
import {
  detectShiftReference,
  formatLogEntry,
  formatLogBook,
  handleLogEntry,
  handleLogCommand,
} from '../../managerLog/shiftLog.js'

const mockShifts = [
  { name: 'Monday Lunch', day_of_week: 'Monday' },
  { name: 'Friday Dinner', day_of_week: 'Friday' },
]

// ── detectShiftReference ─────────────────────────────────────────────────────

describe('detectShiftReference', () => {
  it('detects day + meal period combined', () => {
    const ref = detectShiftReference('Friday dinner was rough', mockShifts)
    assert.equal(ref.dayOfWeek, 'Friday')
    assert.ok(ref.shiftName.toLowerCase().includes('dinner'))
  })

  it('detects day name alone', () => {
    const ref = detectShiftReference('Monday morning prep was slow', mockShifts)
    assert.equal(ref.dayOfWeek, 'Monday')
  })

  it('returns null for generic text', () => {
    const ref = detectShiftReference('general note no shift mentioned', mockShifts)
    assert.equal(ref, null)
  })

  it('returns null for empty string', () => {
    const ref = detectShiftReference('', mockShifts)
    assert.equal(ref, null)
  })

  it('detects meal period without day', () => {
    const ref = detectShiftReference('lunch was great', mockShifts)
    assert.ok(ref)
    assert.ok(ref.shiftName.toLowerCase().includes('lunch'))
  })

  it('exact shift name match takes priority', () => {
    const ref = detectShiftReference('Monday Lunch was amazing today', mockShifts)
    assert.equal(ref.shiftName, 'Monday Lunch')
    assert.equal(ref.dayOfWeek, 'Monday')
  })

  it('detects abbreviated day names', () => {
    const ref = detectShiftReference('Fri night was busy', mockShifts)
    assert.equal(ref.dayOfWeek, 'Friday')
  })

  it('detects time indicators like "last night"', () => {
    const ref = detectShiftReference('last night we ran out of salmon', mockShifts)
    assert.ok(ref)
  })

  it('detects "this morning"', () => {
    const ref = detectShiftReference('this morning delivery was late', mockShifts)
    assert.ok(ref)
    assert.equal(ref.dayOfWeek, 'today')
  })
})

// ── formatLogEntry ───────────────────────────────────────────────────────────

describe('formatLogEntry', () => {
  const baseEntry = {
    entry_text: 'Ran out of salmon during rush',
    shift_name: 'Friday Dinner',
    day_of_week: 'Friday',
    created_at: '2026-04-10T19:30:00.000Z',
  }

  it('contains entry text', () => {
    const out = formatLogEntry(baseEntry)
    assert.ok(out.includes('Ran out of salmon during rush'))
  })

  it('contains shift reference when present', () => {
    const out = formatLogEntry(baseEntry)
    assert.ok(out.includes('Friday Dinner'))
  })

  it('no shift line when shift_name is null', () => {
    const entry = { ...baseEntry, shift_name: null, day_of_week: null }
    const out = formatLogEntry(entry)
    assert.ok(!out.includes('\u{1F4CB}')) // no clipboard emoji
  })
})

// ── formatLogBook ────────────────────────────────────────────────────────────

describe('formatLogBook', () => {
  const entries = [
    {
      entry_text: 'Salmon ran out',
      shift_name: 'Friday Dinner',
      day_of_week: 'Friday',
      created_at: '2026-04-10T19:30:00.000Z',
    },
    {
      entry_text: 'New hire doing great',
      shift_name: null,
      day_of_week: null,
      created_at: '2026-04-09T14:00:00.000Z',
    },
  ]

  it('empty entries shows helpful message', () => {
    const out = formatLogBook([])
    assert.ok(out.includes('No log entries yet'))
  })

  it('single entry formats correctly', () => {
    const out = formatLogBook([entries[0]])
    assert.ok(out.includes('Salmon ran out'))
  })

  it('title appears in output', () => {
    const out = formatLogBook(entries, 'My Custom Title')
    assert.ok(out.includes('My Custom Title'))
  })

  it('multiple entries shown with timestamps', () => {
    const out = formatLogBook(entries)
    assert.ok(out.includes('Salmon ran out'))
    assert.ok(out.includes('New hire doing great'))
  })
})

// ── handleLogEntry ───────────────────────────────────────────────────────────

describe('handleLogEntry', () => {
  const mockEntries = [
    {
      id: 1,
      entry_text: 'Salmon ran out during Friday dinner rush',
      shift_name: 'Friday Dinner',
      day_of_week: 'Friday',
      created_at: '2026-04-10T19:30:00.000Z',
    },
    {
      id: 2,
      entry_text: 'New hire doing great on Monday lunch',
      shift_name: 'Monday Lunch',
      day_of_week: 'Monday',
      created_at: '2026-04-09T14:00:00.000Z',
    },
  ]

  function makeMockDb(overrides = {}) {
    return {
      saveLogEntry: async (groupId, managerId, text, shiftRef) => ({
        id: 1,
        group_id: groupId,
        manager_id: managerId,
        entry_text: text,
        shift_name: shiftRef?.shiftName ?? null,
        day_of_week: shiftRef?.dayOfWeek ?? null,
        created_at: new Date().toISOString(),
      }),
      getLogEntries: async (groupId, limit) => mockEntries,
      searchLogEntries: async (groupId, query) =>
        mockEntries.filter(e =>
          e.entry_text.toLowerCase().includes(query.toLowerCase())
        ),
      getManagerGroup: async (userId) => ({
        group_id: '-100999888',
        dm_chat_id: '12345',
      }),
      getShiftsForGroup: async (groupId) => mockShifts,
      ...overrides,
    }
  }

  it('saves entry to DB', async () => {
    const bot = new MockBot()
    let savedArgs = null
    const db = makeMockDb({
      saveLogEntry: async (groupId, managerId, text, shiftRef) => {
        savedArgs = { groupId, managerId, text, shiftRef }
        return {
          id: 1,
          group_id: groupId,
          manager_id: managerId,
          entry_text: text,
          shift_name: shiftRef?.shiftName ?? null,
          day_of_week: shiftRef?.dayOfWeek ?? null,
          created_at: new Date().toISOString(),
        }
      },
    })
    const msg = makeDMMsg({ text: 'Friday dinner was rough tonight' })
    await handleLogEntry(bot, msg, db)
    assert.ok(savedArgs)
    assert.equal(savedArgs.groupId, '-100999888')
    assert.equal(savedArgs.managerId, 12345)
  })

  it('replies with logged confirmation', async () => {
    const bot = new MockBot()
    const db = makeMockDb()
    const msg = makeDMMsg({ text: 'general note about inventory' })
    await handleLogEntry(bot, msg, db)
    bot.assertSent('12345', '\u{1F4DD} Logged')
  })

  it('includes shift reference in reply when detected', async () => {
    const bot = new MockBot()
    const db = makeMockDb()
    const msg = makeDMMsg({ text: 'Friday dinner was rough tonight' })
    await handleLogEntry(bot, msg, db)
    const last = bot.last
    assert.ok(last.text.includes('Linked to'))
  })

  it('shift reference saved in DB record', async () => {
    const bot = new MockBot()
    let savedShiftRef = null
    const db = makeMockDb({
      saveLogEntry: async (groupId, managerId, text, shiftRef) => {
        savedShiftRef = shiftRef
        return {
          id: 1,
          group_id: groupId,
          manager_id: managerId,
          entry_text: text,
          shift_name: shiftRef?.shiftName ?? null,
          day_of_week: shiftRef?.dayOfWeek ?? null,
          created_at: new Date().toISOString(),
        }
      },
    })
    const msg = makeDMMsg({ text: 'Friday dinner was rough tonight' })
    await handleLogEntry(bot, msg, db)
    assert.ok(savedShiftRef)
    assert.equal(savedShiftRef.dayOfWeek, 'Friday')
  })
})

// ── handleLogCommand ─────────────────────────────────────────────────────────

describe('handleLogCommand', () => {
  const mockEntries = [
    {
      id: 1,
      entry_text: 'Salmon ran out during Friday dinner rush',
      shift_name: 'Friday Dinner',
      day_of_week: 'Friday',
      created_at: '2026-04-10T19:30:00.000Z',
    },
    {
      id: 2,
      entry_text: 'New hire doing great on Monday lunch',
      shift_name: 'Monday Lunch',
      day_of_week: 'Monday',
      created_at: '2026-04-09T14:00:00.000Z',
    },
  ]

  function makeMockDb(overrides = {}) {
    return {
      saveLogEntry: async () => ({}),
      getLogEntries: async (groupId, limit) => mockEntries,
      searchLogEntries: async (groupId, query) =>
        mockEntries.filter(e =>
          e.entry_text.toLowerCase().includes(query.toLowerCase())
        ),
      getManagerGroup: async (userId) => ({
        group_id: '-100999888',
        dm_chat_id: '12345',
      }),
      getShiftsForGroup: async (groupId) => mockShifts,
      ...overrides,
    }
  }

  it('no args sends formatted log entries via DM', async () => {
    const bot = new MockBot()
    const db = makeMockDb()
    const msg = makeDMMsg({ text: '/log' })
    await handleLogCommand(bot, msg, '', db)
    const last = bot.last
    assert.ok(last.text.includes('Salmon ran out'))
  })

  it('with search args calls searchLogEntries', async () => {
    const bot = new MockBot()
    let searchedQuery = null
    const db = makeMockDb({
      searchLogEntries: async (groupId, query) => {
        searchedQuery = query
        return mockEntries.filter(e =>
          e.entry_text.toLowerCase().includes(query.toLowerCase())
        )
      },
    })
    const msg = makeDMMsg({ text: '/log salmon' })
    await handleLogCommand(bot, msg, 'salmon', db)
    assert.equal(searchedQuery, 'salmon')
    const last = bot.last
    assert.ok(last.text.includes('Search results'))
  })

  it('from group msg sends DM notification to group', async () => {
    const bot = new MockBot()
    const db = makeMockDb()
    const msg = makeGroupMsg({ text: '/log' })
    await handleLogCommand(bot, msg, '', db)
    bot.assertSent('-100999888', 'Log sent to your DM')
  })

  it('empty log shows helpful message', async () => {
    const bot = new MockBot()
    const db = makeMockDb({
      getLogEntries: async () => [],
    })
    const msg = makeDMMsg({ text: '/log' })
    await handleLogCommand(bot, msg, '', db)
    const last = bot.last
    assert.ok(last.text.includes('No log entries yet'))
  })

  it('search with no results shows helpful message', async () => {
    const bot = new MockBot()
    const db = makeMockDb({
      searchLogEntries: async () => [],
    })
    const msg = makeDMMsg({ text: '/log zebra' })
    await handleLogCommand(bot, msg, 'zebra', db)
    const last = bot.last
    assert.ok(last.text.includes('No log entries yet'))
  })
})
