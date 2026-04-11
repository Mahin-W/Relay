import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractDemandSignal,
  saveDemandSignal,
  getDemandSignals,
  generateDemandRecommendations,
  formatDemandRecommendations,
} from '../../intelligence/demandSignals.js'

// ── extractDemandSignal ──

await Promise.all([
  test('extractDemandSignal: big event Saturday expect full house → high, Saturday', () => {
    const result = extractDemandSignal('big event Saturday expect full house')
    assert.equal(result.type, 'high')
    assert.equal(result.dayOfWeek, 'Saturday')
    assert.equal(result.isWeekLevel, false)
  }),

  test('extractDemandSignal: slow Tuesday → low, Tuesday', () => {
    const result = extractDemandSignal("it's gonna be slow this Tuesday")
    assert.equal(result.type, 'low')
    assert.equal(result.dayOfWeek, 'Tuesday')
  }),

  test('extractDemandSignal: slow week probably → low, week-level, no day', () => {
    const result = extractDemandSignal('slow week probably')
    assert.equal(result.type, 'low')
    assert.equal(result.isWeekLevel, true)
    assert.equal(result.dayOfWeek, null)
  }),

  test('extractDemandSignal: game day Sunday → high, Sunday', () => {
    const result = extractDemandSignal('game day Sunday')
    assert.equal(result.type, 'high')
    assert.equal(result.dayOfWeek, 'Sunday')
  }),

  test('extractDemandSignal: unrelated coverage message → null', () => {
    const result = extractDemandSignal('can anyone cover my shift')
    assert.equal(result, null)
  }),

  test('extractDemandSignal: unrelated food comment → null', () => {
    const result = extractDemandSignal('the pasta was great')
    assert.equal(result, null)
  }),

  test('extractDemandSignal: busy alone → high, week-level', () => {
    const result = extractDemandSignal('busy')
    assert.equal(result.type, 'high')
    assert.equal(result.isWeekLevel, true)
  }),

  test('extractDemandSignal: SLOW WEEK case insensitive → low', () => {
    const result = extractDemandSignal('SLOW WEEK')
    assert.equal(result.type, 'low')
  }),

  test('extractDemandSignal: busy work false positive → null', () => {
    const result = extractDemandSignal("it's busy work I have to do tonight")
    assert.equal(result, null)
  }),

  test('extractDemandSignal: dead tired false positive → null', () => {
    const result = extractDemandSignal("I'm dead tired")
    assert.equal(result, null)
  }),

  test('extractDemandSignal: dead serious false positive → null', () => {
    assert.equal(extractDemandSignal("I'm dead serious about this"), null)
  }),

  test('extractDemandSignal: dead set false positive → null', () => {
    assert.equal(extractDemandSignal("she's dead set on leaving"), null)
  }),

  test('extractDemandSignal: deadline false positive → null', () => {
    assert.equal(extractDemandSignal("the deadline is Friday"), null)
  }),

  test('extractDemandSignal: quiet down false positive → null', () => {
    assert.equal(extractDemandSignal("quiet down everyone"), null)
  }),

  test('extractDemandSignal: rush hour false positive → null', () => {
    assert.equal(extractDemandSignal("rush hour traffic was bad"), null)
  }),

  test('extractDemandSignal: tonight with no day → isWeekLevel true', () => {
    const result = extractDemandSignal("it's gonna be packed tonight")
    assert.equal(result.type, 'high')
    assert.equal(result.isWeekLevel, true)
  }),

  test('extractDemandSignal: rawMention is populated', () => {
    const result = extractDemandSignal('big event this Friday')
    assert.ok(result.rawMention, 'rawMention should be set')
    assert.ok(result.rawMention.length > 0)
  }),

  // ── formatDemandRecommendations ──

  test('formatDemandRecommendations: high signal understaffed → non-null with mention and count', () => {
    const recs = [{
      type: 'add_staff',
      dayOfWeek: 'Saturday',
      currentCount: 3,
      historicalAvg: 5,
      signal: { type: 'high', rawMention: 'big event' },
    }]
    const result = formatDemandRecommendations(recs)
    assert.ok(result !== null)
    assert.ok(result.includes('Saturday'))
    assert.ok(result.includes('3'))
  }),

  test('formatDemandRecommendations: empty array → null', () => {
    assert.equal(formatDemandRecommendations([]), null)
  }),

  test('formatDemandRecommendations: contains header emoji', () => {
    const recs = [{
      type: 'add_staff',
      dayOfWeek: 'Friday',
      currentCount: 2,
      historicalAvg: 4,
      signal: { type: 'high', rawMention: 'packed' },
    }]
    const result = formatDemandRecommendations(recs)
    assert.ok(result.includes('\u{1F4E3}'))
  }),

  // ── generateDemandRecommendations ──

  test('generateDemandRecommendations: high signal, 3 staff, hist avg 5 → recommend add', async () => {
    const signals = [{ type: 'high', dayOfWeek: 'Friday', isWeekLevel: false, rawMention: 'big event' }]
    const assignments = [
      { day_of_week: 'Friday', staff_id: 1 },
      { day_of_week: 'Friday', staff_id: 2 },
      { day_of_week: 'Friday', staff_id: 3 },
      { day_of_week: 'Monday', staff_id: 4 },
    ]
    const db = {
      getDemandSignals: async () => signals,
      getHistoricalStaffCount: async (groupId, day) => ({ avg: 5, weekCount: 10 }),
    }
    const recs = await generateDemandRecommendations('g1', '2026-04-06', assignments, db)
    assert.ok(recs.length > 0)
    assert.equal(recs[0].type, 'add_staff')
    assert.equal(recs[0].dayOfWeek, 'Friday')
  }),

  test('generateDemandRecommendations: high signal, 5 staff, hist avg 4 → no recommendation', async () => {
    const signals = [{ type: 'high', dayOfWeek: 'Friday', isWeekLevel: false, rawMention: 'big event' }]
    const assignments = [
      { day_of_week: 'Friday', staff_id: 1 },
      { day_of_week: 'Friday', staff_id: 2 },
      { day_of_week: 'Friday', staff_id: 3 },
      { day_of_week: 'Friday', staff_id: 4 },
      { day_of_week: 'Friday', staff_id: 5 },
    ]
    const db = {
      getDemandSignals: async () => signals,
      getHistoricalStaffCount: async () => ({ avg: 4, weekCount: 10 }),
    }
    const recs = await generateDemandRecommendations('g1', '2026-04-06', assignments, db)
    assert.equal(recs.length, 0)
  }),

  test('generateDemandRecommendations: no signals → empty array', async () => {
    const db = {
      getDemandSignals: async () => [],
      getHistoricalStaffCount: async () => ({ avg: 5, weekCount: 10 }),
    }
    const recs = await generateDemandRecommendations('g1', '2026-04-06', [], db)
    assert.deepEqual(recs, [])
  }),

  test('generateDemandRecommendations: no historical data → FYI note', async () => {
    const signals = [{ type: 'high', dayOfWeek: 'Friday', isWeekLevel: false, rawMention: 'big event' }]
    const assignments = [
      { day_of_week: 'Friday', staff_id: 1 },
    ]
    const db = {
      getDemandSignals: async () => signals,
      getHistoricalStaffCount: async () => ({ avg: 0, weekCount: 0 }),
    }
    const recs = await generateDemandRecommendations('g1', '2026-04-06', assignments, db)
    assert.ok(recs.length > 0)
    assert.equal(recs[0].type, 'fyi')
  }),

  test('generateDemandRecommendations: low signal, overstaffed → recommend reduce', async () => {
    const signals = [{ type: 'low', dayOfWeek: 'Tuesday', isWeekLevel: false, rawMention: 'slow night' }]
    const assignments = [
      { day_of_week: 'Tuesday', staff_id: 1 },
      { day_of_week: 'Tuesday', staff_id: 2 },
      { day_of_week: 'Tuesday', staff_id: 3 },
      { day_of_week: 'Tuesday', staff_id: 4 },
      { day_of_week: 'Tuesday', staff_id: 5 },
    ]
    const db = {
      getDemandSignals: async () => signals,
      getHistoricalStaffCount: async () => ({ avg: 3, weekCount: 8 }),
    }
    const recs = await generateDemandRecommendations('g1', '2026-04-06', assignments, db)
    assert.ok(recs.length > 0)
    assert.equal(recs[0].type, 'reduce_staff')
  }),

  // ── saveDemandSignal + getDemandSignals ──

  test('saveDemandSignal + getDemandSignals: saves and retrieves via mock db', async () => {
    const store = []
    const db = {
      saveDemandSignal: async (groupId, weekStart, signal, sourceMessage, sourceUserId) => {
        const record = { group_id: groupId, week_start: weekStart, ...signal, source_message: sourceMessage, source_user_id: sourceUserId }
        store.push(record)
        return record
      },
      getDemandSignals: async (groupId, weekStart) => {
        return store.filter(r => r.group_id === groupId && r.week_start === weekStart)
      },
    }

    const signal = { type: 'high', dayOfWeek: 'Friday', isWeekLevel: false, rawMention: 'big event' }
    await saveDemandSignal('g1', '2026-04-06', signal, 'big event Friday', 'u1', db)
    const results = await getDemandSignals('g1', '2026-04-06', db)
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'high')
    assert.equal(results[0].dayOfWeek, 'Friday')
  }),
])
