import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { targetTierForAge, runEscalationSweep } from '../../coverage/escalationCron.js'

describe('targetTierForAge — boundary behavior', () => {
  test('age < 30 min → tier 0', () => {
    assert.equal(targetTierForAge(0), 0)
    assert.equal(targetTierForAge(15), 0)
    assert.equal(targetTierForAge(29.99), 0)
  })
  test('30 ≤ age < 60 → tier 1', () => {
    assert.equal(targetTierForAge(30), 1)
    assert.equal(targetTierForAge(45), 1)
    assert.equal(targetTierForAge(59.99), 1)
  })
  test('60 ≤ age < 120 → tier 2', () => {
    assert.equal(targetTierForAge(60), 2)
    assert.equal(targetTierForAge(90), 2)
    assert.equal(targetTierForAge(119.99), 2)
  })
  test('age ≥ 120 → tier 3', () => {
    assert.equal(targetTierForAge(120), 3)
    assert.equal(targetTierForAge(180), 3)
    assert.equal(targetTierForAge(9999), 3)
  })
})

// Mock Supabase chain that records calls and returns canned data per table.
function mockSupabase(state) {
  const sent = []
  const inserts = []
  const updates = []

  function chain(table) {
    const ctx = { table, filters: [], rowsToReturn: null, action: 'select' }

    const proxy = {
      select() { return proxy },
      eq(col, val) { ctx.filters.push([col, val]); return proxy },
      lt(col, val) { ctx.filters.push(['<', col, val]); return proxy },
      in(col, vals) { ctx.filters.push(['in', col, vals]); return proxy },
      maybeSingle() {
        return resolveSelect(ctx, true)
      },
      then(resolve) {
        return resolveSelect(ctx, false).then(resolve)
      },
      insert(row) {
        ctx.action = 'insert'
        inserts.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      },
      update(row) {
        ctx.action = 'update'
        ctx._update = row
        return proxy
      },
    }
    return proxy
  }

  function resolveSelect(ctx, single) {
    if (ctx.action === 'update') {
      const reqId = ctx.filters.find(f => f[0] === 'id')?.[1]
      const fromTier = ctx.filters.find(f => f[0] === 'escalation_tier')?.[1]
      updates.push({ reqId, fromTier, set: ctx._update })
      // Honor CAS: only succeed if state-stored tier matches fromTier
      const req = state.coverage_requests.find(r => r.id === reqId)
      if (req && (req.escalation_tier || 0) === fromTier) {
        req.escalation_tier = ctx._update.escalation_tier
        return Promise.resolve({ data: [{ id: reqId }], error: null })
      }
      return Promise.resolve({ data: [], error: null })
    }
    let rows = state[ctx.table] || []
    for (const f of ctx.filters) {
      if (f[0] === '<') rows = rows.filter(r => new Date(r[f[1]]).getTime() < new Date(f[2]).getTime())
      else if (f[0] === 'in') rows = rows.filter(r => f[2].includes(r[f[1]]))
      else rows = rows.filter(r => r[f[0]] === f[1])
    }
    if (single) return Promise.resolve({ data: rows[0] || null, error: null })
    return Promise.resolve({ data: rows, error: null })
  }

  return {
    from(table) { return chain(table) },
    _sent: sent,
    _inserts: inserts,
    _updates: updates,
  }
}

function mockBot() {
  const sent = []
  return {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return true },
    _sent: sent,
  }
}

describe('runEscalationSweep — tier 1 reminder path', () => {
  test('45-min-old open request advances 0→1 and re-DMs outreached staff', async () => {
    const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString()
    const state = {
      coverage_requests: [{
        id: 1, group_id: 'g1', group_name: 'Test',
        shift_description: 'Sat Lunch',
        requested_by: 'Alice', requester_telegram_id: 100,
        matched_shift_id: 5, week_start: '2026-04-27',
        created_at: fortyFiveMinAgo, status: 'open', escalation_tier: 0,
      }],
      coverage_outreach: [
        { request_id: 1, user_id: 200, asked_at: fortyFiveMinAgo },
        { request_id: 1, user_id: 300, asked_at: fortyFiveMinAgo },
        { request_id: 1, user_id: 100, asked_at: fortyFiveMinAgo }, // requester — should be skipped
      ],
      staff_dms: [
        { user_id: 200, first_name: 'Bob', dm_chat_id: 9200 },
        { user_id: 300, first_name: 'Carol', dm_chat_id: 9300 },
      ],
    }
    const bot = mockBot()
    const supabase = mockSupabase(state)
    const result = await runEscalationSweep(bot, { db: supabase })

    assert.equal(result.processed, 1)
    assert.equal(result.advanced, 1)
    assert.equal(state.coverage_requests[0].escalation_tier, 1)
    // Bob and Carol DM'd, requester (Alice, 100) skipped
    assert.equal(bot._sent.length, 2)
    assert.deepEqual(bot._sent.map(s => s.chatId).sort(), [9200, 9300])
    assert.match(bot._sent[0].text, /Reminder/)
  })
})

describe('runEscalationSweep — tier 2 manager-alert path', () => {
  test('75-min-old request at tier 1 advances to tier 2 and DMs manager', async () => {
    const seventyFiveMinAgo = new Date(Date.now() - 75 * 60 * 1000).toISOString()
    const state = {
      coverage_requests: [{
        id: 7, group_id: 'g1', group_name: 'Test',
        shift_description: 'Mon Dinner',
        requested_by: 'Dan', requester_telegram_id: 400,
        matched_shift_id: 9, week_start: '2026-04-27',
        created_at: seventyFiveMinAgo, status: 'open', escalation_tier: 1,
      }],
      coverage_outreach: [
        { request_id: 7, user_id: 401, asked_at: seventyFiveMinAgo },
        { request_id: 7, user_id: 402, asked_at: seventyFiveMinAgo },
      ],
      staff_dms: [],
      setup_sessions: [
        { group_id: 'g1', manager_id: 999, dm_chat_id: 8888, group_name: 'Test' },
      ],
    }
    const bot = mockBot()
    const supabase = mockSupabase(state)
    const result = await runEscalationSweep(bot, { db: supabase })

    assert.equal(result.advanced, 1)
    assert.equal(state.coverage_requests[0].escalation_tier, 2)
    assert.equal(bot._sent.length, 1)
    assert.equal(bot._sent[0].chatId, 8888)
    assert.match(bot._sent[0].text, /1 hour/)
    assert.match(bot._sent[0].text, /Staff asked:\*? 2/)
  })
})

describe('runEscalationSweep — covered/cancelled requests are ignored', () => {
  test('covered request is not advanced even though it is old', async () => {
    const oldTs = new Date(Date.now() - 200 * 60 * 1000).toISOString()
    const state = {
      coverage_requests: [{
        id: 11, group_id: 'g1', shift_description: 'X', requested_by: 'Y',
        requester_telegram_id: 1, matched_shift_id: 1, week_start: '2026-04-27',
        created_at: oldTs, status: 'covered', escalation_tier: 0,
      }],
    }
    const bot = mockBot()
    const supabase = mockSupabase(state)
    const result = await runEscalationSweep(bot, { db: supabase })
    assert.equal(result.processed, 0)
    assert.equal(result.advanced, 0)
    assert.equal(bot._sent.length, 0)
    assert.equal(state.coverage_requests[0].escalation_tier, 0)
  })
})
