// Comprehensive integration test for the REAL Express dashboard router.
// Mounts src/server/dashRoutes.js on Express, intercepts @supabase/supabase-js
// via Node's mock.module, and runs every route against a chainable in-memory
// Supabase fake.
//
// Run with:
//   node --experimental-test-module-mocks --test src/tests/integration/dashApiRoutesFull.test.js

// Pinch these BEFORE any module imports supabase
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'

// Replace @supabase/supabase-js BEFORE dashRoutes loads it
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', {
  namedExports: { createClient: supabaseFake.createClient },
})

// Now import the modules that depend on supabase
const router = (await import('../../server/dashRoutes.js')).default
const { signToken } = await import('../../server/middleware.js')

// ── Test app + helper ──────────────────────────────────────────────────────

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.locals.bot = null
  app.use('/api', router)
  return app
}

async function request(app, method, path, opts = {}) {
  const server = createServer(app)
  await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}${path}`
  const headers = { 'Content-Type': 'application/json', ...opts.headers }
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const ctype = res.headers.get('content-type') || ''
  const body = ctype.includes('json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body }
}

const TEST_GROUP = 'grp-test'
function authCookie(groupId = TEST_GROUP) {
  const token = signToken({ groupId, restaurantName: 'Test Restaurant' })
  return `relay_session=${token}`
}

// ── Seed fixtures ──────────────────────────────────────────────────────────

const STAFF_FIXTURES = [
  { id: 1001, group_id: TEST_GROUP, name: 'Alice', role: 'Server', active: true, hourly_rate: 15 },
  { id: 1002, group_id: TEST_GROUP, name: 'Bob',   role: 'Cook',   active: true, hourly_rate: 17 },
  { id: 1003, group_id: TEST_GROUP, name: 'Carol', role: 'Chef',   active: true, hourly_rate: 22 },
]
const SHIFTS_FIXTURES = [
  { id: 2001, group_id: TEST_GROUP, name: 'Mon Lunch',  day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true },
  { id: 2002, group_id: TEST_GROUP, name: 'Mon Dinner', day_of_week: 'Monday', start_time: '17:00', end_time: '23:00', active: true },
]
const SETUP_FIXTURE = {
  id: 1, group_id: TEST_GROUP, group_name: 'Test Restaurant',
  manager_id: 9001, dm_chat_id: 9001, manager_phone: '+19195550100',
  setup_complete: true, setup_data: { weeklyBudget: 8000 },
  step: 'complete',
}

beforeEach(() => {
  supabaseFake.resetFakeClient()
  supabaseFake.seedTable('staff', STAFF_FIXTURES)
  supabaseFake.seedTable('shifts', SHIFTS_FIXTURES)
  supabaseFake.seedTable('setup_sessions', [SETUP_FIXTURE])
})

// ═══════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════
describe('Auth', () => {
  test('GET /api/staff without cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/staff')
    assert.equal(status, 401)
  })

  test('GET /api/staff with bad cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: 'relay_session=invalid' },
    })
    assert.equal(status, 401)
  })

  test('GET /api/staff with valid auth → 200 and returns staff list', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    assert.ok(Array.isArray(body), 'should return array')
    assert.equal(body.length, 3, `expected 3 staff, got ${body.length}`)
  })

  test('Auth filters by groupId — different group sees empty', async () => {
    const app = createTestApp()
    const { body } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie('other-group') },
    })
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 0, 'other group should see no staff')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// STAFF CRUD
// ═══════════════════════════════════════════════════════════════════════════
describe('Staff CRUD', () => {
  test('POST /api/staff creates new staff', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: 'Dave', role: 'Bartender' },
    })
    assert.ok(status === 200 || status === 201, `expected 200/201, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.name, 'Dave')
    assert.equal(body.role, 'Bartender')
    assert.equal(body.group_id, TEST_GROUP)
  })

  test('POST /api/staff with empty name → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: '   ', role: 'Server' },
    })
    assert.equal(status, 400)
  })

  test('PATCH /api/staff/:id updates name', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', `/api/staff/1001`, {
      headers: { Cookie: authCookie() },
      body: { name: 'Alice Smith' },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}`)
    // Verify
    const { body } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie() },
    })
    const updated = body.find(s => s.id === 1001)
    assert.equal(updated.name, 'Alice Smith')
  })

  test('DELETE /api/staff/:id soft-deletes (active=false)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'DELETE', '/api/staff/1002', {
      headers: { Cookie: authCookie() },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}`)
    // Verify gone from active list
    const { body } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie() },
    })
    assert.ok(!body.find(s => s.id === 1002), 'deleted staff should not appear')
  })

  test('PATCH /api/staff/:id ignores foreign-group staff', async () => {
    // Add staff to another group
    supabaseFake.seedTable('staff', [
      { id: 9999, group_id: 'other', name: 'Foreign', role: 'Server', active: true },
    ])
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/staff/9999', {
      headers: { Cookie: authCookie() },
      body: { name: 'Hijacked' },
    })
    // Should 404 — not in our group
    assert.ok(status === 404 || status === 400, `expected 404/400, got ${status}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SHIFTS
// ═══════════════════════════════════════════════════════════════════════════
describe('Shifts CRUD', () => {
  test('GET /api/shifts returns seeded shifts', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/shifts', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 2)
  })

  test('POST /api/shifts creates with all fields', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { name: 'Sat Lunch', day_of_week: 'Saturday', start_time: '11:00', end_time: '15:00' },
    })
    assert.ok(status === 200 || status === 201, `expected 2xx, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.name, 'Sat Lunch')
    assert.equal(body.day_of_week, 'Saturday')
  })

  test('POST /api/shifts validates required fields', async () => {
    const app = createTestApp()
    for (const missing of ['name', 'day_of_week', 'start_time', 'end_time']) {
      const body = { name: 'X', day_of_week: 'Monday', start_time: '09:00', end_time: '17:00' }
      delete body[missing]
      const { status } = await request(app, 'POST', '/api/shifts', {
        headers: { Cookie: authCookie() }, body,
      })
      assert.equal(status, 400, `missing ${missing} should 400`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE ASSIGN
// ═══════════════════════════════════════════════════════════════════════════
describe('Schedule', () => {
  test('POST /api/schedule/assign with valid future week succeeds', async () => {
    const app = createTestApp()
    const futureWeek = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 1001, shiftId: 2001, weekStart: futureWeek },
    })
    assert.ok(status >= 200 && status < 400, `expected 2xx/3xx, got ${status}`)
  })

  test('POST /api/schedule/assign past week → 409', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 1001, shiftId: 2001, weekStart: '2020-01-06' },
    })
    assert.equal(status, 409)
    assert.ok(body?.error?.toLowerCase().includes('past'))
  })

  test('POST /api/schedule/assign missing fields → 400', async () => {
    const app = createTestApp()
    for (const missing of ['staffId', 'shiftId', 'weekStart']) {
      const body = { staffId: 1001, shiftId: 2001, weekStart: '2099-01-06' }
      delete body[missing]
      const { status } = await request(app, 'POST', '/api/schedule/assign', {
        headers: { Cookie: authCookie() }, body,
      })
      assert.equal(status, 400, `missing ${missing} should 400`)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PAYROLL
// ═══════════════════════════════════════════════════════════════════════════
describe('Payroll', () => {
  test('PATCH /api/payroll/:staffId/rate without rate → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/1001/rate', {
      headers: { Cookie: authCookie() }, body: {},
    })
    assert.equal(status, 400)
  })

  test('PATCH /api/payroll/:staffId/rate with negative → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/1001/rate', {
      headers: { Cookie: authCookie() }, body: { rate: -5 },
    })
    assert.equal(status, 400)
  })

  test('PATCH /api/payroll/:staffId/rate valid succeeds', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/1001/rate', {
      headers: { Cookie: authCookie() }, body: { rate: 18 },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}`)
  })

  test('POST /api/payroll/revenue with negative → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/payroll/revenue', {
      headers: { Cookie: authCookie() },
      body: { weekStart: '2026-04-21', revenue: -100 },
    })
    assert.equal(status, 400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// TIPS
// ═══════════════════════════════════════════════════════════════════════════
describe('Tips', () => {
  test('POST /api/tips missing fields → 400', async () => {
    const app = createTestApp()
    const { status: s1 } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() }, body: { totalTips: 200 },
    })
    assert.equal(s1, 400)
    const { status: s2 } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() }, body: { shiftDate: '2026-04-20' },
    })
    assert.equal(s2, 400)
  })

  test('POST /api/tips valid → 2xx', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() },
      body: { shiftDate: '2026-04-20', totalTips: 200 },
    })
    assert.ok(status >= 200 && status < 300, `got ${status}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RULES
// ═══════════════════════════════════════════════════════════════════════════
describe('Rules', () => {
  test('POST /api/rules without type → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/rules', {
      headers: { Cookie: authCookie() },
      body: { constraintText: 'Test rule' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/rules valid → 2xx', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/rules', {
      headers: { Cookie: authCookie() },
      body: { type: 'day_off', constraintText: 'Alice no Mondays', subjectStaffId: 1001, dayOfWeek: 'Monday' },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)}`)
  })

  test('GET /api/rules returns array', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/rules', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// COVERAGE
// ═══════════════════════════════════════════════════════════════════════════
describe('Coverage', () => {
  test('GET /api/coverage returns array', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/coverage', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body))
  })

  test('POST /api/coverage missing shiftId → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/coverage', {
      headers: { Cookie: authCookie() }, body: {},
    })
    assert.equal(status, 400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// TIMECLOCK
// ═══════════════════════════════════════════════════════════════════════════
describe('Timeclock', () => {
  test('GET /api/timeclock/live works', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/timeclock/live', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200)
    assert.ok(Array.isArray(body) || body?.entries !== undefined)
  })

  test('POST /api/timeclock/override invalid action → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() },
      body: { staffId: 1001, action: 'invalid_action' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/timeclock/override missing fields → 400', async () => {
    const app = createTestApp()
    const { status: s1 } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() }, body: { action: 'clock_out' },
    })
    assert.equal(s1, 400)
    const { status: s2 } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() }, body: { staffId: 1001 },
    })
    assert.equal(s2, 400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
describe('Settings', () => {
  test('GET /api/settings returns config', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/settings', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200, `got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body, 'should return body')
  })

  test('PATCH /api/settings persists weeklyBudget', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/settings', {
      headers: { Cookie: authCookie() },
      body: { weeklyBudget: 9500 },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}`)
  })

  test('GET /api/settings/full includes a compliance block with options', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', '/api/settings/full', {
      headers: { Cookie: authCookie() },
    })
    assert.equal(status, 200, `got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.compliance, 'compliance block present')
    assert.ok(Array.isArray(body.compliance.options.states) && body.compliance.options.states.length >= 50, 'state options populated')
    // unset profile ⇒ all guardrails default on
    assert.deepEqual(body.compliance.features, { breaks: true, minorLabor: true, fairWorkweek: true })
  })

  test('PATCH /api/settings/full saves compliance location + toggles', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'PATCH', '/api/settings/full', {
      headers: { Cookie: authCookie() },
      body: { compliance: { state: 'CA', city: 'San Francisco', features: { minorLabor: false } } },
    })
    assert.ok(status >= 200 && status < 300, `expected 2xx, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.updated?.compliance, true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-GROUP ISOLATION (RLS-like behavior)
// ═══════════════════════════════════════════════════════════════════════════
describe('Cross-group isolation', () => {
  test('Group A staff invisible to Group B JWT', async () => {
    const app = createTestApp()
    const { body } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie('group-b') },
    })
    assert.ok(Array.isArray(body))
    // Should be empty — other group's staff shouldn't leak
    assert.equal(body.length, 0)
  })

  test('Group A cannot delete Group B\'s staff', async () => {
    supabaseFake.seedTable('staff', [
      { id: 7777, group_id: 'group-b', name: 'BobB', role: 'Server', active: true },
    ])
    const app = createTestApp()
    const { status } = await request(app, 'DELETE', '/api/staff/7777', {
      headers: { Cookie: authCookie() },  // group A token trying to delete group B's row
    })
    // Should not succeed (404 or 400 acceptable, NOT 200)
    assert.ok(status === 404 || status >= 400, `cross-group delete should fail, got ${status}`)
  })

  test('Group A cannot read Group B\'s rules', async () => {
    supabaseFake.seedTable('business_rules', [
      { id: 8001, group_id: 'group-b', type: 'day_off', constraint_text: 'GROUP B SECRET', active: true },
    ])
    const app = createTestApp()
    const { body } = await request(app, 'GET', '/api/rules', {
      headers: { Cookie: authCookie() },
    })
    const leaked = (Array.isArray(body) ? body : []).find(r =>
      r.constraint_text === 'GROUP B SECRET')
    assert.ok(!leaked, 'Group B rules should not leak to Group A')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════
describe('Error handling', () => {
  test('Malformed JSON body → 4xx', async () => {
    const app = createTestApp()
    const server = createServer(app)
    await new Promise(r => server.listen(0, r))
    const { port } = server.address()
    const url = `http://127.0.0.1:${port}/api/staff`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie() },
      body: '{this is not json',
    })
    await new Promise(r => server.close(r))
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`)
  })

  test('Very long staff name handled', async () => {
    const app = createTestApp()
    const longName = 'X'.repeat(1000)
    const { status } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: longName, role: 'Server' },
    })
    // Either accept or reject, but should not 500
    assert.ok(status < 500, `long name should not 500, got ${status}`)
  })

  test('Path traversal in staff ID → 4xx', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/staff/../../etc/passwd', {
      headers: { Cookie: authCookie() },
    })
    assert.ok(status >= 400 && status < 500, `traversal should 4xx, got ${status}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P1-32 — staleAvailability flag on /api/schedule/status
// ═══════════════════════════════════════════════════════════════════════════
describe('Schedule status — staleAvailability (P1-32)', () => {
  const SCHED_GROUP = 'sched-grp'
  const SCHED_WEEK = '2025-07-14'
  // Schedule was generated at T0
  const SCHEDULE_CREATED_AT = '2025-07-10T10:00:00.000Z'
  // Availability submitted AFTER the schedule was generated (T0 + 1 hour)
  const AVAIL_AFTER = '2025-07-10T11:00:00.000Z'
  // Availability submitted BEFORE the schedule was generated (T0 - 1 hour)
  const AVAIL_BEFORE = '2025-07-10T09:00:00.000Z'

  test('staleAvailability=true when availability submitted after schedule was generated', async () => {
    supabaseFake.resetFakeClient()
    supabaseFake.seedTable('setup_sessions', [{
      id: 99, group_id: SCHED_GROUP, group_name: 'Test', manager_id: 1,
      dm_chat_id: 1, setup_complete: true, setup_data: {},
    }])
    // Seed a published schedule with a specific created_at
    supabaseFake.seedTable('generated_schedules', [{
      id: 501, group_id: SCHED_GROUP, week_start: SCHED_WEEK,
      status: 'published', published_at: SCHEDULE_CREATED_AT,
      created_at: SCHEDULE_CREATED_AT, assignments: [], gaps: [],
    }])
    // Seed availability row with collected_at AFTER schedule creation
    supabaseFake.seedTable('availability', [{
      id: 201, user_id: 1001, group_id: SCHED_GROUP, week_start: SCHED_WEEK,
      collected_at: AVAIL_AFTER,
    }])

    const app = createTestApp()
    const { status, body } = await request(app, 'GET', `/api/schedule/status?week=${SCHED_WEEK}`, {
      headers: { Cookie: authCookie(SCHED_GROUP) },
    })
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.staleAvailability, true,
      `Expected staleAvailability=true (avail at ${AVAIL_AFTER} > schedule at ${SCHEDULE_CREATED_AT}). Got: ${JSON.stringify(body)}`)
  })

  test('staleAvailability=false when availability submitted before schedule was generated', async () => {
    supabaseFake.resetFakeClient()
    supabaseFake.seedTable('setup_sessions', [{
      id: 99, group_id: SCHED_GROUP, group_name: 'Test', manager_id: 1,
      dm_chat_id: 1, setup_complete: true, setup_data: {},
    }])
    // Schedule created after availability
    supabaseFake.seedTable('generated_schedules', [{
      id: 502, group_id: SCHED_GROUP, week_start: SCHED_WEEK,
      status: 'published', published_at: SCHEDULE_CREATED_AT,
      created_at: SCHEDULE_CREATED_AT, assignments: [], gaps: [],
    }])
    // Availability submitted BEFORE schedule was created
    supabaseFake.seedTable('availability', [{
      id: 202, user_id: 1001, group_id: SCHED_GROUP, week_start: SCHED_WEEK,
      collected_at: AVAIL_BEFORE,
    }])

    const app = createTestApp()
    const { status, body } = await request(app, 'GET', `/api/schedule/status?week=${SCHED_WEEK}`, {
      headers: { Cookie: authCookie(SCHED_GROUP) },
    })
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.staleAvailability, false,
      `Expected staleAvailability=false (avail at ${AVAIL_BEFORE} < schedule at ${SCHEDULE_CREATED_AT}). Got: ${JSON.stringify(body)}`)
  })

  test('staleAvailability=false when no schedule exists yet', async () => {
    supabaseFake.resetFakeClient()
    // No generated_schedules, no availability
    const app = createTestApp()
    const { status, body } = await request(app, 'GET', `/api/schedule/status?week=${SCHED_WEEK}`, {
      headers: { Cookie: authCookie(SCHED_GROUP) },
    })
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.staleAvailability, false,
      `Expected staleAvailability=false when no schedule. Got: ${JSON.stringify(body)}`)
  })
})
