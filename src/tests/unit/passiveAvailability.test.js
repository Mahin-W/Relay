import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import { handleAvailabilityMention } from '../../availability/passiveAvailability.js'

const GROUP_ID = '-100888777'
const USER_ID = 42
const WEEK = '2026-04-13' // a Monday

function makeMsg(overrides = {}) {
  return {
    chat: { id: GROUP_ID, type: 'supergroup', title: 'Test Kitchen' },
    from: { id: USER_ID, first_name: 'Alice' },
    ...overrides,
  }
}

function makeDb(overrides = {}) {
  const saved = []
  return {
    saved,
    savePassiveAvailability: async (userId, groupId, weekStart, day, status, rawText) => {
      saved.push({ userId, groupId, weekStart, day, status, rawText })
      return { id: saved.length, userId, groupId, weekStart, day, status }
    },
    ...overrides,
  }
}

await Promise.all([
  test('saves unavailable day when staff says they cannot work', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: ['Tuesday'],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 1)
    assert.equal(db.saved[0].day, 'Tuesday')
    assert.equal(db.saved[0].status, 'unavailable')
    assert.equal(db.saved[0].userId, USER_ID)
    assert.equal(db.saved[0].groupId, GROUP_ID)
    assert.equal(db.saved[0].weekStart, WEEK)
  }),

  test('saves available day when staff says they are free', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: ['Friday'],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 1)
    assert.equal(db.saved[0].day, 'Friday')
    assert.equal(db.saved[0].status, 'available')
  }),

  test('saves one record per mentioned day', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: ['Monday', 'Wednesday'],
      unavailable_days: ['Tuesday'],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 3)
    const days = db.saved.map(s => s.day).sort()
    assert.deepEqual(days, ['Monday', 'Tuesday', 'Wednesday'])
  }),

  test('saves available_all when staff says free all week', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: [],
      available_all_week: true,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 1)
    assert.equal(db.saved[0].day, 'all')
    assert.equal(db.saved[0].status, 'available_all')
  }),

  test('saves unavailable_all when staff says out all week', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: true,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 1)
    assert.equal(db.saved[0].day, 'all')
    assert.equal(db.saved[0].status, 'unavailable_all')
  }),

  test('replies with acknowledgement in group chat', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: ['Monday'],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    bot.assertSent(GROUP_ID, 'Got it')
    bot.assertSent(GROUP_ID, 'Alice')
  }),

  test('reply mentions the specific day', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: ['Thursday'],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    bot.assertSent(GROUP_ID, 'Thursday')
  }),

  test('stays silent and does not save when no days and no week flags', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    assert.equal(db.saved.length, 0)
    bot.assertSilent()
  }),

  test('uses msg.from.id as userId not person name', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const msg = makeMsg({ from: { id: 9999, first_name: 'Bob' } })
    const intent = {
      type: 'availability_mention',
      person: 'Bob',
      available_days: ['Saturday'],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: false,
    }
    await handleAvailabilityMention(bot, msg, intent, db, WEEK)
    assert.equal(db.saved[0].userId, 9999)
  }),

  test('reply for unavailable_all mentions out all week', async () => {
    const bot = new MockBot()
    const db = makeDb()
    const intent = {
      type: 'availability_mention',
      person: 'Alice',
      available_days: [],
      unavailable_days: [],
      available_all_week: false,
      unavailable_all_week: true,
    }
    await handleAvailabilityMention(bot, makeMsg(), intent, db, WEEK)
    bot.assertSent(GROUP_ID, 'Got it')
  }),
])
