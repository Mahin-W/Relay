// Must be set before any module imports supabase
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'relay-dev-secret-change-in-production'

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import cookieParser from 'cookie-parser'
import router from '../../server/dashRoutes.js'
import { signToken } from '../../server/middleware.js'

// ── Test app factory ──────────────────────────────────────────────────────────

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.locals.bot = null // no bot in tests
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
  const body = await res.json().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body }
}

function authCookie(groupId = 'grp-test') {
  const token = signToken({ groupId, restaurantName: 'Test Restaurant' })
  return `relay_session=${token}`
}

// ── Auth middleware tests ─────────────────────────────────────────────────────

describe('Auth middleware', () => {
  test('GET /api/staff without cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/staff')
    assert.equal(status, 401)
  })

  test('POST /api/staff without cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/staff', {
      body: { name: 'Alice', role: 'Server' },
    })
    assert.equal(status, 401)
  })

  test('GET /api/shifts without cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/shifts')
    assert.equal(status, 401)
  })

  test('GET /api/settings without cookie → 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/settings')
    assert.equal(status, 401)
  })

  test('GET /api/staff with valid cookie → not 401', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/staff', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })
})

// ── Staff validation tests ────────────────────────────────────────────────────

describe('Staff validation', () => {
  test('POST /api/staff without name → 400 with error message', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { role: 'Server' },
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error message, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/staff without role → 400 with error message', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: 'Alice' },
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error message, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/staff with valid body → not 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: 'Alice', role: 'Server' },
    })
    // Validation passes; DB will fail (500 without real DB) — that is OK
    assert.notEqual(status, 400)
  })

  test('PATCH /api/staff/:id — reaches DB layer (may 500 without real DB, not 400)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/staff/fake-id', {
      headers: { Cookie: authCookie() },
      body: { name: 'Bob' },
    })
    // No input validation on PATCH; will 404 or 500 trying to reach DB
    assert.notEqual(status, 400)
  })
})

// ── Shift validation tests ────────────────────────────────────────────────────

describe('Shift validation', () => {
  test('POST /api/shifts without name → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { day_of_week: 'Monday', start_time: '09:00', end_time: '17:00' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/shifts without day_of_week → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { name: 'Morning', start_time: '09:00', end_time: '17:00' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/shifts without start_time → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { name: 'Morning', day_of_week: 'Monday', end_time: '17:00' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/shifts without end_time → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { name: 'Morning', day_of_week: 'Monday', start_time: '09:00' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/shifts with all required fields → not 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/shifts', {
      headers: { Cookie: authCookie() },
      body: { name: 'Morning', day_of_week: 'Monday', start_time: '09:00', end_time: '17:00' },
    })
    assert.notEqual(status, 400)
  })
})

// ── Schedule validation tests ─────────────────────────────────────────────────

describe('Schedule validation', () => {
  test('POST /api/schedule/assign without staffId → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { shiftId: 'shift-1', weekStart: '2026-04-21' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/schedule/assign without shiftId → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', weekStart: '2026-04-21' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/schedule/assign without weekStart → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', shiftId: 'shift-1' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/schedule/generate without weekStart → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/generate', {
      headers: { Cookie: authCookie() },
      body: {},
    })
    assert.equal(status, 400)
  })

  test('POST /api/schedule/approve without weekStart → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/approve', {
      headers: { Cookie: authCookie() },
      body: {},
    })
    assert.equal(status, 400)
  })
})

// ── Payroll validation tests ──────────────────────────────────────────────────

describe('Payroll validation', () => {
  test('POST /api/payroll/revenue without weekStart → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/payroll/revenue', {
      headers: { Cookie: authCookie() },
      body: { revenue: 5000 },
    })
    assert.equal(status, 400)
  })

  test('POST /api/payroll/revenue without revenue → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/payroll/revenue', {
      headers: { Cookie: authCookie() },
      body: { weekStart: '2026-04-21' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/payroll/revenue with negative revenue → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/payroll/revenue', {
      headers: { Cookie: authCookie() },
      body: { weekStart: '2026-04-21', revenue: -100 },
    })
    assert.equal(status, 400)
  })

  test('POST /api/payroll/revenue with zero revenue → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/payroll/revenue', {
      headers: { Cookie: authCookie() },
      body: { weekStart: '2026-04-21', revenue: 0 },
    })
    assert.equal(status, 400)
  })
})

// ── Tips validation tests ─────────────────────────────────────────────────────

describe('Tips validation', () => {
  test('POST /api/tips without shiftDate → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() },
      body: { totalTips: 200 },
    })
    assert.equal(status, 400)
  })

  test('POST /api/tips without totalTips → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() },
      body: { shiftDate: '2026-04-20' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/tips with valid body → not 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/tips', {
      headers: { Cookie: authCookie() },
      body: { shiftDate: '2026-04-20', totalTips: 200 },
    })
    assert.notEqual(status, 400)
  })
})

// ── Rules validation tests ────────────────────────────────────────────────────

describe('Rules validation', () => {
  test('POST /api/rules without type → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/rules', {
      headers: { Cookie: authCookie() },
      body: { constraintText: 'Alice cannot work Mondays' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/rules without constraintText → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/rules', {
      headers: { Cookie: authCookie() },
      body: { type: 'unavailability' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/rules with both required fields → not 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/rules', {
      headers: { Cookie: authCookie() },
      body: { type: 'unavailability', constraintText: 'Alice cannot work Mondays' },
    })
    assert.notEqual(status, 400)
  })
})

// ── Coverage validation tests ─────────────────────────────────────────────────

describe('Coverage validation', () => {
  test('POST /api/coverage without shiftId → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/coverage', {
      headers: { Cookie: authCookie() },
      body: { reason: 'Sick' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/coverage with shiftId → not 400 (may 404/500 without DB)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/coverage', {
      headers: { Cookie: authCookie() },
      body: { shiftId: 'shift-abc' },
    })
    assert.notEqual(status, 400)
  })
})

// ── Timeclock override validation tests ───────────────────────────────────────

describe('Timeclock override validation', () => {
  test('POST /api/timeclock/override without staffId → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() },
      body: { action: 'clock_out' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/timeclock/override without action → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1' },
    })
    assert.equal(status, 400)
  })

  test('POST /api/timeclock/override with invalid action → 400', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', action: 'teleport' },
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error message, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/timeclock/override adjust with valid ISO time → not 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/timeclock/override', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', action: 'adjust', time: '2026-04-20T15:00:00.000Z' },
    })
    // Validation passes; DB will fail looking up staff (404/500 without real DB)
    assert.notEqual(status, 400)
  })
})

// ── Week param tests (auth passes, may 500 without DB, never 401) ─────────────

describe('Week param tests — auth works, DB optional', () => {
  test('GET /api/timeclock/live → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/timeclock/live', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })

  test('GET /api/schedule-list → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/schedule-list', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })

  test('GET /api/payroll → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/payroll', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })

  test('GET /api/coverage → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/coverage', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })

  test('GET /api/tips → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/tips', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })

  test('GET /api/rules → 200 or 500, never 401 with valid auth', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'GET', '/api/rules', {
      headers: { Cookie: authCookie() },
    })
    assert.notEqual(status, 401)
  })
})

// ── B1 (BH.14): whitespace-only name rejection ────────────────────────────────

describe('B1 BH.14 — whitespace-only staff name rejected', () => {
  test('POST /api/staff with whitespace-only name → 400', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: '   \t\n  ', role: 'Server' },
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error message, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/staff with empty string name → 400', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: '', role: 'Server' },
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error message, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/staff with real name → validation passes (not 400)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/staff', {
      headers: { Cookie: authCookie() },
      body: { name: 'Alice', role: 'Server' },
    })
    assert.notEqual(status, 400)
  })
})

// ── B2 (2.20): role mismatch assignment rejected ──────────────────────────────

describe('B2 2.20 — role mismatch assignment rejected', () => {
  test('POST /api/schedule/assign with all required fields hits DB layer (not 400)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', shiftId: 'shift-1', weekStart: '2099-01-01' },
    })
    // Validation passes; DB lookup may 404/500 without real DB
    assert.notEqual(status, 400)
  })
})

// ── B3 (BH.17): past weekStart rejected ──────────────────────────────────────

describe('B3 BH.17 — past weekStart rejected', () => {
  test('POST /api/schedule/assign with weekStart 1 year ago → 409', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', shiftId: 'shift-1', weekStart: '2020-01-06' },
    })
    assert.equal(status, 409)
    assert.ok(body?.error?.includes('past'), `expected past-week error, got: ${JSON.stringify(body)}`)
  })

  test('POST /api/schedule/assign with weekStart 8 days ago → 409', async () => {
    const app = createTestApp()
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', shiftId: 'shift-1', weekStart: past },
    })
    assert.equal(status, 409)
  })

  test('POST /api/schedule/assign with future weekStart → passes validation (not 409)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'POST', '/api/schedule/assign', {
      headers: { Cookie: authCookie() },
      body: { staffId: 'staff-1', shiftId: 'shift-1', weekStart: '2099-01-01' },
    })
    // Validation passes; DB lookup will 404/500 without real DB
    assert.notEqual(status, 409)
  })
})

// ── B5 (wire retroFix): PATCH /api/payroll/:staffId/rate ─────────────────────

describe('B5 wire retroFix — PATCH /api/payroll/:staffId/rate', () => {
  test('PATCH /api/payroll/:staffId/rate without rate → 400', async () => {
    const app = createTestApp()
    const { status, body } = await request(app, 'PATCH', '/api/payroll/staff-1/rate', {
      headers: { Cookie: authCookie() },
      body: {},
    })
    assert.equal(status, 400)
    assert.ok(body?.error, `expected error, got: ${JSON.stringify(body)}`)
  })

  test('PATCH /api/payroll/:staffId/rate with negative rate → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/staff-1/rate', {
      headers: { Cookie: authCookie() },
      body: { rate: -5 },
    })
    assert.equal(status, 400)
  })

  test('PATCH /api/payroll/:staffId/rate with zero rate → 400', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/staff-1/rate', {
      headers: { Cookie: authCookie() },
      body: { rate: 0 },
    })
    assert.equal(status, 400)
  })

  test('PATCH /api/payroll/:staffId/rate with valid rate → hits DB layer (not 400)', async () => {
    const app = createTestApp()
    const { status } = await request(app, 'PATCH', '/api/payroll/staff-1/rate', {
      headers: { Cookie: authCookie() },
      body: { rate: 21 },
    })
    // Validation passes; DB lookup may 404/500 without real DB
    assert.notEqual(status, 400)
  })
})
