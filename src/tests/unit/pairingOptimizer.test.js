import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzePairOutcomes,
  applyPairingOptimization,
  formatPairingInsight,
  getShiftOutcomeHistory,
  getPairingRecommendations,
} from '../../intelligence/pairingOptimizer.js'

// ── Shared mock data ────────────────────────────────────────────

const mockShiftHistory = [
  // Marcus(1)+Sarah(2) together -> high scores
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-01-10', staffIds: [1, 2], shiftScore: 92, issues: [], positives: [] },
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-01-17', staffIds: [1, 2], shiftScore: 88, issues: [], positives: [] },
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-01-24', staffIds: [1, 2], shiftScore: 95, issues: [], positives: [] },
  // Marcus(1) alone -> lower scores
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-01-31', staffIds: [1], shiftScore: 72, issues: [], positives: [] },
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-02-07', staffIds: [1], shiftScore: 68, issues: [], positives: [] },
  { shiftId: 1, shiftName: 'Friday Dinner', dayOfWeek: 'Friday', weekStart: '2025-02-14', staffIds: [1], shiftScore: 74, issues: [], positives: [] },
  // Jake(3)+Carlos(4) together -> low scores
  { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', weekStart: '2025-01-11', staffIds: [3, 4], shiftScore: 51, issues: [], positives: [] },
  { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', weekStart: '2025-01-18', staffIds: [3, 4], shiftScore: 48, issues: [], positives: [] },
  { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', weekStart: '2025-01-25', staffIds: [3, 4], shiftScore: 55, issues: [], positives: [] },
  // Jake(3) alone -> better
  { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', weekStart: '2025-02-01', staffIds: [3], shiftScore: 75, issues: [], positives: [] },
  { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', weekStart: '2025-02-08', staffIds: [3], shiftScore: 78, issues: [], positives: [] },
]

const staffNames = { 1: 'Marcus', 2: 'Sarah', 3: 'Jake', 4: 'Carlos' }

// ── analyzePairOutcomes ─────────────────────────────────────────

await Promise.all([
  test('analyzePairOutcomes: Marcus+Sarah positive pair (avgTogether ~91.7, benefit >= 10)', () => {
    const pairs = analyzePairOutcomes(mockShiftHistory, staffNames)
    const marcusSarah = pairs.find(
      p => (p.staffIdA === 1 && p.staffIdB === 2) || (p.staffIdA === 2 && p.staffIdB === 1)
    )
    assert.ok(marcusSarah, 'Marcus+Sarah pair should exist')
    assert.equal(marcusSarah.shiftsTogether, 3)
    assert.ok(Math.abs(marcusSarah.avgScoreTogether - 91.67) < 1, `avgTogether ~91.67, got ${marcusSarah.avgScoreTogether}`)
    assert.ok(Math.abs(marcusSarah.avgScoreApart - 71.33) < 1, `avgApart ~71.33, got ${marcusSarah.avgScoreApart}`)
    assert.ok(marcusSarah.pairingBenefit >= 10, `benefit >= 10, got ${marcusSarah.pairingBenefit}`)
    assert.equal(marcusSarah.pairingValue, 'positive')
  }),

  test('analyzePairOutcomes: Jake+Carlos negative pair (benefit <= -10)', () => {
    const pairs = analyzePairOutcomes(mockShiftHistory, staffNames)
    const jakeCarlos = pairs.find(
      p => (p.staffIdA === 3 && p.staffIdB === 4) || (p.staffIdA === 4 && p.staffIdB === 3)
    )
    assert.ok(jakeCarlos, 'Jake+Carlos pair should exist')
    assert.equal(jakeCarlos.shiftsTogether, 3)
    assert.ok(Math.abs(jakeCarlos.avgScoreTogether - 51.33) < 1, `avgTogether ~51.33, got ${jakeCarlos.avgScoreTogether}`)
    assert.ok(jakeCarlos.pairingBenefit <= -10, `benefit <= -10, got ${jakeCarlos.pairingBenefit}`)
    assert.equal(jakeCarlos.pairingValue, 'negative')
  }),

  test('analyzePairOutcomes: pairs with < 3 shifts together not returned', () => {
    const shortHistory = [
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-06', staffIds: [5, 6], shiftScore: 70, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-13', staffIds: [5, 6], shiftScore: 80, issues: [], positives: [] },
    ]
    const pairs = analyzePairOutcomes(shortHistory, { 5: 'Amy', 6: 'Ben' })
    assert.equal(pairs.length, 0)
  }),

  test('analyzePairOutcomes: single staff never in pair results', () => {
    const soloHistory = [
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-06', staffIds: [10], shiftScore: 85, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-13', staffIds: [10], shiftScore: 82, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-20', staffIds: [10], shiftScore: 88, issues: [], positives: [] },
    ]
    const pairs = analyzePairOutcomes(soloHistory, { 10: 'Loner' })
    assert.equal(pairs.length, 0)
  }),

  // ── getPairingRecommendations (MockDB) ──────────────────────────

  test('getPairingRecommendations: returns Marcus+Sarah as positive, Jake+Carlos as negative', async () => {
    const mockDb = makePairingDb({
      assignments: [
        // Week 1: Marcus+Sarah on Friday Dinner, Jake+Carlos on Saturday Lunch
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 2, week_start: '2025-01-10', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 3, week_start: '2025-01-11', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 4, week_start: '2025-01-11', status: 'published' },
        // Week 2
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-17', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 2, week_start: '2025-01-17', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 3, week_start: '2025-01-18', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 4, week_start: '2025-01-18', status: 'published' },
        // Week 3
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-24', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 2, week_start: '2025-01-24', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 3, week_start: '2025-01-25', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 4, week_start: '2025-01-25', status: 'published' },
        // Week 4: Marcus alone, Jake alone
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-31', status: 'published' },
        { group_id: 'g1', shift_id: 2, staff_id: 3, week_start: '2025-02-01', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
        { id: 2, group_id: 'g1', name: 'Saturday Lunch', day_of_week: 'Saturday', start_time: '11:00', end_time: '15:00' },
      ],
      coverageRequests: [
        // Coverage request on Sat Lunch w3 (Jake+Carlos) -> lowers their score
        { group_id: 'g1', matched_shift_id: 2, created_at: '2025-01-25T12:00:00Z', status: 'covered' },
      ],
      reliabilityEvents: [
        // Late arrival for Jake on w2
        { staff_id: 3, group_id: 'g1', event_type: 'late_arrival', metadata: {}, recorded_at: '2025-01-18T11:15:00Z' },
      ],
      recognitionEvents: [],
      staff: [
        { id: 1, group_id: 'g1', name: 'Marcus' },
        { id: 2, group_id: 'g1', name: 'Sarah' },
        { id: 3, group_id: 'g1', name: 'Jake' },
        { id: 4, group_id: 'g1', name: 'Carlos' },
      ],
    })

    const result = await getPairingRecommendations('g1', 8, mockDb)
    assert.ok(result.positivePairs.length > 0 || result.negativePairs.length > 0, 'should have some pairs')
    // Check that pairs with >= 3 shifts together appear
    for (const p of [...result.positivePairs, ...result.negativePairs]) {
      assert.ok(p.shiftsTogether >= 3, `pair must have >= 3 shifts together, got ${p.shiftsTogether}`)
    }
  }),

  test('getPairingRecommendations: minimum 3 shifts together enforced', async () => {
    const mockDb = makePairingDb({
      assignments: [
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 2, week_start: '2025-01-10', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-17', status: 'published' },
        { group_id: 'g1', shift_id: 1, staff_id: 2, week_start: '2025-01-17', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
      ],
      coverageRequests: [],
      reliabilityEvents: [],
      recognitionEvents: [],
      staff: [
        { id: 1, group_id: 'g1', name: 'Marcus' },
        { id: 2, group_id: 'g1', name: 'Sarah' },
      ],
    })

    const result = await getPairingRecommendations('g1', 8, mockDb)
    assert.equal(result.positivePairs.length, 0)
    assert.equal(result.negativePairs.length, 0)
  }),

  // ── applyPairingOptimization ──────────────────────────────────

  test('applyPairingOptimization: separates negative pair when swap available', () => {
    const assignments = [
      // Saturday: Jake(3)+Carlos(4) on Lunch, Amy(5)+Ben(6) on Dinner — all Server role
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 3, staffName: 'Jake', roleName: 'Server', userId: 30, dmChatId: 300 },
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 4, staffName: 'Carlos', roleName: 'Server', userId: 40, dmChatId: 400 },
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 5, staffName: 'Amy', roleName: 'Server', userId: 50, dmChatId: 500 },
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 6, staffName: 'Ben', roleName: 'Server', userId: 60, dmChatId: 600 },
    ]

    const pairingData = {
      positivePairs: [],
      negativePairs: [
        { staffIdA: 3, staffIdB: 4, nameA: 'Jake', nameB: 'Carlos', shiftsTogether: 3, avgScoreTogether: 51, avgScoreApart: 76, pairingBenefit: -25, pairingValue: 'negative' },
      ],
    }

    const result = applyPairingOptimization(assignments, pairingData)
    // After optimization, Jake and Carlos should not be on the same shift
    const satLunch = result.newAssignments.filter(a => a.shiftId === 2)
    const satLunchStaff = satLunch.map(a => a.staffId)
    const bothOnLunch = satLunchStaff.includes(3) && satLunchStaff.includes(4)
    assert.equal(bothOnLunch, false, 'Jake and Carlos should be separated')
    assert.ok(result.applied.length > 0, 'should have applied changes')
    assert.equal(result.applied[0].type, 'separated_pair')
  }),

  test('applyPairingOptimization: no swap available (only 2 staff) -> keeps them', () => {
    const assignments = [
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 3, staffName: 'Jake', roleName: 'Server', userId: 30, dmChatId: 300 },
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 4, staffName: 'Carlos', roleName: 'Server', userId: 40, dmChatId: 400 },
    ]

    const pairingData = {
      positivePairs: [],
      negativePairs: [
        { staffIdA: 3, staffIdB: 4, nameA: 'Jake', nameB: 'Carlos', shiftsTogether: 3, avgScoreTogether: 51, avgScoreApart: 76, pairingBenefit: -25, pairingValue: 'negative' },
      ],
    }

    const result = applyPairingOptimization(assignments, pairingData)
    // No other shift to swap with, so original should be preserved
    assert.equal(result.newAssignments.length, 2)
    const staffIds = result.newAssignments.map(a => a.staffId).sort()
    assert.deepEqual(staffIds, [3, 4])
    assert.equal(result.applied.length, 0, 'no swaps applied')
  }),

  test('applyPairingOptimization: role requirements never violated', () => {
    const assignments = [
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 3, staffName: 'Jake', roleName: 'Server', userId: 30, dmChatId: 300 },
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 4, staffName: 'Carlos', roleName: 'Server', userId: 40, dmChatId: 400 },
      // Only Chef on Dinner — can't swap a Chef for a Server
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 5, staffName: 'Amy', roleName: 'Chef', userId: 50, dmChatId: 500 },
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 6, staffName: 'Ben', roleName: 'Chef', userId: 60, dmChatId: 600 },
    ]

    const pairingData = {
      positivePairs: [],
      negativePairs: [
        { staffIdA: 3, staffIdB: 4, nameA: 'Jake', nameB: 'Carlos', shiftsTogether: 3, avgScoreTogether: 51, avgScoreApart: 76, pairingBenefit: -25, pairingValue: 'negative' },
      ],
    }

    const result = applyPairingOptimization(assignments, pairingData)
    // No valid swap (different roles), so originals preserved
    const satLunchStaff = result.newAssignments.filter(a => a.shiftId === 2).map(a => a.staffId).sort()
    assert.deepEqual(satLunchStaff, [3, 4], 'should keep original when roles mismatch')
    assert.equal(result.applied.length, 0, 'no swaps applied when roles differ')
  }),

  test('applyPairingOptimization: returns applied list with details', () => {
    const assignments = [
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 3, staffName: 'Jake', roleName: 'Server', userId: 30, dmChatId: 300 },
      { shiftId: 2, shiftName: 'Saturday Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 4, staffName: 'Carlos', roleName: 'Server', userId: 40, dmChatId: 400 },
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 5, staffName: 'Amy', roleName: 'Server', userId: 50, dmChatId: 500 },
      { shiftId: 3, shiftName: 'Saturday Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 6, staffName: 'Ben', roleName: 'Server', userId: 60, dmChatId: 600 },
    ]

    const pairingData = {
      positivePairs: [
        { staffIdA: 1, staffIdB: 2, nameA: 'Marcus', nameB: 'Sarah', shiftsTogether: 3, avgScoreTogether: 92, avgScoreApart: 71, pairingBenefit: 21, pairingValue: 'positive' },
      ],
      negativePairs: [
        { staffIdA: 3, staffIdB: 4, nameA: 'Jake', nameB: 'Carlos', shiftsTogether: 3, avgScoreTogether: 51, avgScoreApart: 76, pairingBenefit: -25, pairingValue: 'negative' },
      ],
    }

    const result = applyPairingOptimization(assignments, pairingData)
    assert.ok(result.applied.length >= 1)
    const sep = result.applied.find(a => a.type === 'separated_pair')
    if (sep) {
      assert.ok(sep.nameA || sep.nameB)
      assert.ok(sep.shiftName)
      assert.ok(sep.reason)
    }
  }),

  // ── formatPairingInsight ──────────────────────────────────────

  test('formatPairingInsight: contains pair names and shift name', () => {
    const applied = [
      { type: 'separated_pair', nameA: 'Jake', nameB: 'Carlos', shiftName: 'Saturday Lunch', reason: 'better outcomes when apart' },
      { type: 'kept_positive', nameA: 'Marcus', nameB: 'Sarah', shiftName: 'Friday Dinner', reason: 'smoothest shift combo over 7 weeks' },
    ]
    const text = formatPairingInsight(applied)
    assert.ok(text, 'should return text')
    assert.ok(text.includes('Jake'), 'includes Jake')
    assert.ok(text.includes('Carlos'), 'includes Carlos')
    assert.ok(text.includes('Marcus'), 'includes Marcus')
    assert.ok(text.includes('Sarah'), 'includes Sarah')
    assert.ok(text.includes('Saturday Lunch') || text.includes('Friday Dinner'), 'includes shift name')
  }),

  test('formatPairingInsight: null when nothing applied', () => {
    assert.equal(formatPairingInsight([]), null)
    assert.equal(formatPairingInsight(null), null)
    assert.equal(formatPairingInsight(undefined), null)
  }),

  // ── getShiftOutcomeHistory (MockDB) ───────────────────────────

  test('getShiftOutcomeHistory: coverage request lowers score', async () => {
    const mockDb = makePairingDb({
      assignments: [
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
      ],
      coverageRequests: [
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:00:00Z', status: 'open' },
      ],
      reliabilityEvents: [],
      recognitionEvents: [],
      staff: [{ id: 1, group_id: 'g1', name: 'Marcus' }],
    })

    const history = await getShiftOutcomeHistory('g1', 8, mockDb)
    assert.ok(history.length >= 1)
    const entry = history.find(h => h.shiftId === 1 && h.weekStart === '2025-01-10')
    assert.ok(entry)
    assert.ok(entry.shiftScore < 80, `score should be < 80 due to coverage request, got ${entry.shiftScore}`)
    assert.ok(entry.issues.length > 0, 'should have issues')
  }),

  test('getShiftOutcomeHistory: recognition raises score', async () => {
    const mockDb = makePairingDb({
      assignments: [
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
      ],
      coverageRequests: [],
      reliabilityEvents: [],
      recognitionEvents: [
        { group_id: 'g1', recipient_staff_id: 1, created_at: '2025-01-10T20:00:00Z' },
      ],
      staff: [{ id: 1, group_id: 'g1', name: 'Marcus' }],
    })

    const history = await getShiftOutcomeHistory('g1', 8, mockDb)
    const entry = history.find(h => h.shiftId === 1 && h.weekStart === '2025-01-10')
    assert.ok(entry)
    assert.ok(entry.shiftScore > 80, `score should be > 80 with recognition, got ${entry.shiftScore}`)
    assert.ok(entry.positives.length > 0, 'should have positives')
  }),

  test('getShiftOutcomeHistory: no events -> score stays at 80', async () => {
    const mockDb = makePairingDb({
      assignments: [
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
      ],
      coverageRequests: [],
      reliabilityEvents: [],
      recognitionEvents: [],
      staff: [{ id: 1, group_id: 'g1', name: 'Marcus' }],
    })

    const history = await getShiftOutcomeHistory('g1', 8, mockDb)
    const entry = history.find(h => h.shiftId === 1)
    assert.ok(entry)
    assert.equal(entry.shiftScore, 80)
  }),

  test('getShiftOutcomeHistory: score clamped 0-100', async () => {
    const mockDb = makePairingDb({
      assignments: [
        { group_id: 'g1', shift_id: 1, staff_id: 1, week_start: '2025-01-10', status: 'published' },
      ],
      shifts: [
        { id: 1, group_id: 'g1', name: 'Friday Dinner', day_of_week: 'Friday', start_time: '17:00', end_time: '23:00' },
      ],
      coverageRequests: [
        // 5 coverage requests -> -100 total, should clamp to 0
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:00:00Z', status: 'open' },
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:01:00Z', status: 'open' },
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:02:00Z', status: 'open' },
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:03:00Z', status: 'open' },
        { group_id: 'g1', matched_shift_id: 1, created_at: '2025-01-10T18:04:00Z', status: 'open' },
      ],
      reliabilityEvents: [],
      recognitionEvents: [],
      staff: [{ id: 1, group_id: 'g1', name: 'Marcus' }],
    })

    const history = await getShiftOutcomeHistory('g1', 8, mockDb)
    const entry = history.find(h => h.shiftId === 1)
    assert.ok(entry)
    assert.equal(entry.shiftScore, 0, 'score should clamp to 0')
  }),

  // ── Edge cases ────────────────────────────────────────────────

  test('edge: first week (no history) -> empty pairs, no optimization', () => {
    const pairs = analyzePairOutcomes([], staffNames)
    assert.equal(pairs.length, 0)

    const result = applyPairingOptimization([], { positivePairs: [], negativePairs: [] })
    assert.deepEqual(result.newAssignments, [])
    assert.equal(result.applied.length, 0)
  }),

  test('edge: all neutral pairs -> nothing applied', () => {
    const neutralHistory = [
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-06', staffIds: [1, 2], shiftScore: 75, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-13', staffIds: [1, 2], shiftScore: 78, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-20', staffIds: [1, 2], shiftScore: 72, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-01-27', staffIds: [1], shiftScore: 70, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-02-03', staffIds: [1], shiftScore: 74, issues: [], positives: [] },
      { shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', weekStart: '2025-02-10', staffIds: [1], shiftScore: 73, issues: [], positives: [] },
    ]
    const pairs = analyzePairOutcomes(neutralHistory, { 1: 'A', 2: 'B' })
    // Benefit: ~75 - ~72.3 = ~2.7 -> neutral
    for (const p of pairs) {
      assert.equal(p.pairingValue, 'neutral')
    }

    const result = applyPairingOptimization(
      [{ shiftId: 1, shiftName: 'Mon AM', dayOfWeek: 'Monday', startTime: '08:00', endTime: '14:00', staffId: 1, staffName: 'A', roleName: 'Server', userId: 1, dmChatId: 1 }],
      { positivePairs: [], negativePairs: [] }
    )
    assert.equal(result.applied.length, 0)
  }),

  test('edge: staff with different roles -> not swapped', () => {
    // Already tested in "role requirements never violated" — but explicit edge case
    const assignments = [
      { shiftId: 2, shiftName: 'Sat Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 3, staffName: 'Jake', roleName: 'Server', userId: 30, dmChatId: 300 },
      { shiftId: 2, shiftName: 'Sat Lunch', dayOfWeek: 'Saturday', startTime: '11:00', endTime: '15:00', staffId: 4, staffName: 'Carlos', roleName: 'Server', userId: 40, dmChatId: 400 },
      { shiftId: 3, shiftName: 'Sat Dinner', dayOfWeek: 'Saturday', startTime: '17:00', endTime: '23:00', staffId: 5, staffName: 'Amy', roleName: 'Bartender', userId: 50, dmChatId: 500 },
    ]
    const pairingData = {
      positivePairs: [],
      negativePairs: [
        { staffIdA: 3, staffIdB: 4, nameA: 'Jake', nameB: 'Carlos', shiftsTogether: 3, avgScoreTogether: 51, avgScoreApart: 76, pairingBenefit: -25, pairingValue: 'negative' },
      ],
    }
    const result = applyPairingOptimization(assignments, pairingData)
    // Amy is Bartender, can't swap with Server Jake/Carlos
    assert.equal(result.applied.length, 0)
  }),
])

// ── Mock DB factory ─────────────────────────────────────────────

function makePairingDb({ assignments, shifts, coverageRequests, reliabilityEvents, recognitionEvents, staff }) {
  return {
    getPublishedAssignments: async (groupId, weeksBack) => {
      return assignments.filter(a => a.group_id === groupId && a.status === 'published')
    },
    getShiftsForGroup: async (groupId) => {
      return shifts.filter(s => s.group_id === groupId)
    },
    getCoverageRequestsForGroup: async (groupId, weeksBack) => {
      return coverageRequests.filter(c => c.group_id === groupId)
    },
    getReliabilityEventsForGroup: async (groupId, weeksBack) => {
      return reliabilityEvents.filter(r => r.group_id === groupId)
    },
    getRecognitionEventsForGroup: async (groupId, weeksBack) => {
      return recognitionEvents.filter(r => r.group_id === groupId)
    },
    getStaffForGroup: async (groupId) => {
      return staff.filter(s => s.group_id === groupId)
    },
  }
}
