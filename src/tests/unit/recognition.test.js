import { describe, it, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, MockDB, makeGroupMsg } from '../helpers/mocks.js'
import {
  detectRecognition,
  formatGroupShoutout,
  handleRecognition,
  saveRecognitionEvent,
  getRecognitionHistory,
  getRecognitionLeaderboard,
  _clearCooldownForTest,
} from '../../engagement/recognition.js'

const mockStaff = [
  { id: 1, name: 'Marcus' },
  { id: 2, name: 'Sarah' },
  { id: 3, name: 'Jake' },
]

// ── detectRecognition ────────────────────────────────────────────────────────

await describe('detectRecognition', { concurrency: true }, async () => {

  await it('shoutout with individual name', () => {
    const r = detectRecognition('shoutout Marcus for covering last minute', mockStaff)
    assert.equal(r.recipientType, 'individual')
    assert.equal(r.recipientName, 'Marcus')
  })

  await it('great job everyone → team', () => {
    const r = detectRecognition('great job everyone tonight', mockStaff)
    assert.equal(r.recipientType, 'team')
  })

  await it('props to the kitchen crew → role', () => {
    const r = detectRecognition('props to the kitchen crew', mockStaff)
    assert.equal(r.recipientType, 'role')
  })

  await it('kudos to Sarah → individual', () => {
    const r = detectRecognition('kudos to Sarah', mockStaff)
    assert.equal(r.recipientType, 'individual')
    assert.equal(r.recipientName, 'Sarah')
  })

  await it('crushed it tonight → team (no specific recipient)', () => {
    const r = detectRecognition('crushed it tonight', mockStaff)
    assert.equal(r.recipientType, 'team')
  })

  await it('GREAT JOB MARCUS → individual, case insensitive', () => {
    const r = detectRecognition('GREAT JOB MARCUS', mockStaff)
    assert.equal(r.recipientType, 'individual')
    assert.equal(r.recipientName, 'Marcus')
  })

  await it('can anyone cover my shift → null', () => {
    const r = detectRecognition('can anyone cover my shift', mockStaff)
    assert.equal(r, null)
  })

  await it('tips were great → null', () => {
    const r = detectRecognition('tips were great', mockStaff)
    assert.equal(r, null)
  })

  await it('the schedule looks good → null', () => {
    const r = detectRecognition('the schedule looks good', mockStaff)
    assert.equal(r, null)
  })

  await it('great pasta → null', () => {
    const r = detectRecognition('great pasta', mockStaff)
    assert.equal(r, null)
  })

  await it('great, got it → null (NOT a trigger)', () => {
    const r = detectRecognition('great, got it', mockStaff)
    assert.equal(r, null)
  })

  await it('thank you Sarah for staying late → individual', () => {
    const r = detectRecognition('thank you Sarah for staying late', mockStaff)
    assert.equal(r.recipientType, 'individual')
    assert.equal(r.recipientName, 'Sarah')
  })

  await it('big thanks to the servers tonight → role', () => {
    const r = detectRecognition('big thanks to the servers tonight', mockStaff)
    assert.equal(r.recipientType, 'role')
  })

  await it('Jake is the MVP tonight → individual', () => {
    const r = detectRecognition('Jake is the MVP tonight', mockStaff)
    assert.equal(r.recipientType, 'individual')
    assert.equal(r.recipientName, 'Jake')
  })

  await it('the whole crew stepped up → team', () => {
    const r = detectRecognition('the whole crew stepped up', mockStaff)
    assert.equal(r.recipientType, 'team')
  })

  await it('returns reason from surrounding text', () => {
    const r = detectRecognition('shoutout Marcus for covering last minute', mockStaff)
    assert.ok(r.reason, 'reason should be set')
    assert.ok(r.reason.length > 0, 'reason should not be empty')
  })

  await it('preserves originalText', () => {
    const text = 'great job everyone tonight'
    const r = detectRecognition(text, mockStaff)
    assert.equal(r.originalText, text)
  })
})

// ── formatGroupShoutout ──────────────────────────────────────────────────────

await describe('formatGroupShoutout', { concurrency: true }, async () => {

  await it('individual shoutout contains name, reason, and manager', () => {
    const recognition = {
      recipientType: 'individual',
      recipientName: 'Marcus',
      reason: 'covering last minute',
      originalText: 'shoutout Marcus for covering last minute',
    }
    const text = formatGroupShoutout(recognition, 'Chef Mike')
    assert.ok(text.includes('Marcus'), 'should include recipient name')
    assert.ok(text.includes('covering last minute'), 'should include reason')
    assert.ok(text.includes('Chef Mike'), 'should include manager name')
  })

  await it('team shoutout contains original text and manager', () => {
    const recognition = {
      recipientType: 'team',
      recipientName: null,
      reason: null,
      originalText: 'great job everyone tonight',
    }
    const text = formatGroupShoutout(recognition, 'Chef Mike')
    assert.ok(text.includes('great job everyone tonight'), 'should include original text')
    assert.ok(text.includes('Chef Mike'), 'should include manager name')
    assert.ok(text.includes('team') || text.includes('Team'), 'should reference team')
  })
})

// ── handleRecognition (MockBot, MockDB) ──────────────────────────────────────

await describe('handleRecognition', { concurrency: false }, async () => {
  // Clear the production cooldown map between tests so shared module-level state
  // doesn't cause tests to interfere with each other (P1-31 cooldown side effect).
  beforeEach(() => _clearCooldownForTest())

  function makeRecognitionDb() {
    const db = {
      recognitionEvents: [],
      moraleEvents: [],
      staff: [],
      async getStaffByGroupId(groupId) {
        return this.staff.filter(s => s.group_id === String(groupId))
      },
      async saveRecognitionEvent(groupId, managerId, recognition) {
        const row = { id: db.recognitionEvents.length + 1, group_id: groupId, manager_id: managerId, ...recognition, created_at: new Date().toISOString() }
        db.recognitionEvents.push(row)
        return row
      },
      async saveMoraleEvent(groupId, staffId, event) {
        db.moraleEvents.push({ group_id: groupId, staff_id: staffId, ...event })
      },
    }
    return db
  }

  await it('posts shoutout to group chat on recognition', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [
      { id: 1, name: 'Marcus', group_id: '-100999888' },
      { id: 2, name: 'Sarah', group_id: '-100999888' },
    ]
    const msg = makeGroupMsg({ text: 'shoutout Marcus for covering last minute' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    const sent = bot.lastMessage(msg.chat.id)
    assert.ok(sent, 'should have sent a message')
    assert.ok(sent.text.includes('Marcus'), 'message should mention Marcus')
  })

  await it('saves recognition event to DB', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [
      { id: 1, name: 'Marcus', group_id: '-100999888' },
    ]
    const msg = makeGroupMsg({ text: 'great job Marcus' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    assert.equal(db.recognitionEvents.length, 1, 'should save one recognition event')
  })

  await it('non-recognition message → no post, no save', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]
    const msg = makeGroupMsg({ text: 'can someone cover Tuesday?' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    bot.assertSilent()
    assert.equal(db.recognitionEvents.length, 0)
  })

  await it('unknown name → posts as team recognition', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]
    const msg = makeGroupMsg({ text: 'shoutout to Danny for being awesome' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    const sent = bot.lastMessage(msg.chat.id)
    assert.ok(sent, 'should still post')
  })

  await it('saves morale event for individual recipient', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [
      { id: 1, name: 'Marcus', group_id: '-100999888' },
    ]
    const msg = makeGroupMsg({ text: 'kudos to Marcus' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    assert.equal(db.moraleEvents.length, 1, 'should save morale event')
    assert.equal(db.moraleEvents[0].staff_id, 1)
    assert.equal(db.moraleEvents[0].type, 'recognition_received')
    assert.equal(db.moraleEvents[0].sentiment, 'positive')
  })

  await it('uses reply_to_message_id in sent message', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]
    const msg = makeGroupMsg({ text: 'great job Marcus' })
    await handleRecognition(bot, msg, msg.chat.id, db)
    const sent = bot.lastMessage(msg.chat.id)
    assert.ok(sent.options.reply_to_message_id, 'should set reply_to_message_id')
    assert.equal(sent.options.reply_to_message_id, msg.message_id)
  })

  // ── P1-31: recognition cooldown ────────────────────────────────────────────

  await it('P1-31: second identical recognition within cooldown window is suppressed', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]

    const baseMsg = makeGroupMsg({ text: 'shoutout Marcus for covering' })
    const now = Date.now()
    const _cooldownMap = new Map()  // isolated per-test map

    // First kudos — should go through
    await handleRecognition(bot, baseMsg, baseMsg.chat.id, db, { now, _cooldownMap })
    assert.equal(db.recognitionEvents.length, 1, 'first recognition should be saved')
    assert.equal(bot.sentMessages.length, 1, 'first recognition should post')

    // Second identical kudos 30 seconds later (within 60s window) — should be suppressed
    await handleRecognition(bot, baseMsg, baseMsg.chat.id, db, { now: now + 30_000, _cooldownMap })
    assert.equal(db.recognitionEvents.length, 1, 'second recognition within window should NOT be saved')
    assert.equal(bot.sentMessages.length, 1, 'second recognition within window should NOT post')
  })

  await it('P1-31: same recognition after cooldown window expires is allowed', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]

    const baseMsg = makeGroupMsg({ text: 'shoutout Marcus for covering' })
    const now = Date.now()
    const _cooldownMap = new Map()  // isolated per-test map

    // First kudos
    await handleRecognition(bot, baseMsg, baseMsg.chat.id, db, { now, _cooldownMap })
    assert.equal(db.recognitionEvents.length, 1, 'first kudos saved')

    // Second kudos 90 seconds later (past 60s window) — should be allowed
    await handleRecognition(bot, baseMsg, baseMsg.chat.id, db, { now: now + 90_000, _cooldownMap })
    assert.equal(db.recognitionEvents.length, 2, 'kudos after window should be saved')
    assert.equal(bot.sentMessages.length, 2, 'kudos after window should post')
  })

  await it('P1-31: different recognizer can kudos same recipient immediately', async () => {
    const bot = new MockBot()
    const db = makeRecognitionDb()
    db.staff = [{ id: 1, name: 'Marcus', group_id: '-100999888' }]

    const now = Date.now()
    const _cooldownMap = new Map()  // isolated per-test map
    const msg1 = makeGroupMsg({ text: 'shoutout Marcus', from: { id: 111, first_name: 'Chef1' } })
    const msg2 = makeGroupMsg({ text: 'shoutout Marcus', from: { id: 222, first_name: 'Chef2' } })

    await handleRecognition(bot, msg1, msg1.chat.id, db, { now, _cooldownMap })
    await handleRecognition(bot, msg2, msg2.chat.id, db, { now: now + 5_000, _cooldownMap })

    assert.equal(db.recognitionEvents.length, 2, 'different managers can both kudos Marcus')
    assert.equal(bot.sentMessages.length, 2, 'both should post')
  })
})

// ── getRecognitionHistory (MockDB) ───────────────────────────────────────────

await describe('getRecognitionHistory', { concurrency: true }, async () => {
  function makeHistoryDb(events) {
    return {
      async getRecognitionHistory(groupId, staffId, weeksBack) {
        let filtered = events.filter(e => e.group_id === String(groupId))
        if (staffId) filtered = filtered.filter(e => e.recipient_staff_id === staffId)
        return filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      },
    }
  }

  const now = new Date()
  const events = [
    { group_id: '-100', recipient_staff_id: 1, recipient_name: 'Marcus', created_at: new Date(now - 1000).toISOString() },
    { group_id: '-100', recipient_staff_id: 2, recipient_name: 'Sarah', created_at: new Date(now - 2000).toISOString() },
    { group_id: '-100', recipient_staff_id: 1, recipient_name: 'Marcus', created_at: new Date(now - 3000).toISOString() },
  ]

  await it('returns events for specific staffId', async () => {
    const db = makeHistoryDb(events)
    const result = await getRecognitionHistory('-100', 1, 8, db)
    assert.equal(result.length, 2)
    assert.ok(result.every(e => e.recipient_staff_id === 1))
  })

  await it('returns all events when staffId is null', async () => {
    const db = makeHistoryDb(events)
    const result = await getRecognitionHistory('-100', null, 8, db)
    assert.equal(result.length, 3)
  })

  await it('results ordered DESC by created_at', async () => {
    const db = makeHistoryDb(events)
    const result = await getRecognitionHistory('-100', null, 8, db)
    for (let i = 1; i < result.length; i++) {
      assert.ok(new Date(result[i - 1].created_at) >= new Date(result[i].created_at), 'should be DESC order')
    }
  })

  await it('empty events → empty array', async () => {
    const db = makeHistoryDb([])
    const result = await getRecognitionHistory('-100', null, 8, db)
    assert.deepEqual(result, [])
  })
})

// ── getRecognitionLeaderboard (MockDB) ───────────────────────────────────────

await describe('getRecognitionLeaderboard', { concurrency: true }, async () => {
  function makeLeaderboardDb(events) {
    return {
      async getRecognitionLeaderboard(groupId, weeksBack) {
        const counts = {}
        for (const e of events.filter(ev => ev.group_id === String(groupId) && ev.recipient_staff_id)) {
          const key = e.recipient_staff_id
          if (!counts[key]) counts[key] = { staffId: key, staffName: e.recipient_name, count: 0, lastRecognized: e.created_at }
          counts[key].count++
          if (e.created_at > counts[key].lastRecognized) counts[key].lastRecognized = e.created_at
        }
        return Object.values(counts).sort((a, b) => b.count - a.count)
      },
    }
  }

  const now = new Date()
  const events = [
    { group_id: '-100', recipient_staff_id: 1, recipient_name: 'Marcus', created_at: new Date(now - 1000).toISOString() },
    { group_id: '-100', recipient_staff_id: 1, recipient_name: 'Marcus', created_at: new Date(now - 2000).toISOString() },
    { group_id: '-100', recipient_staff_id: 1, recipient_name: 'Marcus', created_at: new Date(now - 3000).toISOString() },
    { group_id: '-100', recipient_staff_id: 2, recipient_name: 'Sarah', created_at: new Date(now - 1500).toISOString() },
  ]

  await it('sorted by count DESC', async () => {
    const db = makeLeaderboardDb(events)
    const result = await getRecognitionLeaderboard('-100', 4, db)
    assert.equal(result.length, 2)
    assert.equal(result[0].staffName, 'Marcus')
    assert.equal(result[0].count, 3)
    assert.equal(result[1].staffName, 'Sarah')
    assert.equal(result[1].count, 1)
  })

  await it('correct count per staff', async () => {
    const db = makeLeaderboardDb(events)
    const result = await getRecognitionLeaderboard('-100', 4, db)
    const marcus = result.find(r => r.staffName === 'Marcus')
    assert.equal(marcus.count, 3)
  })

  await it('empty events → empty array', async () => {
    const db = makeLeaderboardDb([])
    const result = await getRecognitionLeaderboard('-100', 4, db)
    assert.deepEqual(result, [])
  })
})
