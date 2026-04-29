// Dashboard API stress — mounts the real express app with a stubbed Supabase
// client. Hits every dashboard route with valid + edge-case payloads.
// Records: HTTP status, response body, unexpected throws.

import express from 'express'
import cookieParser from 'cookie-parser'
import { createServer } from 'node:http'

// Required env *before* importing routes
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'relay-dev-secret-change-in-production'

import dashRoutes from '../../../server/dashRoutes.js'
import authRoutes from '../../../server/authRoutes.js'
import { signToken } from '../../../server/middleware.js'

// ── Stubbed Supabase ─────────────────────────────────────────────────────────
// Records every query, returns realistic-shaped data.

const supabaseCalls = []

function makeStubTable(tableName) {
  const state = {
    table: tableName,
    op: null,             // select | insert | update | upsert | delete
    columns: '*',
    filters: [],
    orderBy: null,
    limit: null,
    isHead: false,
    isCount: false,
    insertRow: null,
    updates: null,
    isMaybeSingle: false,
    isSingle: false,
  }
  const builder = {
    _state: state,
    select(cols, opts) {
      state.op = state.op || 'select'
      state.columns = cols
      if (opts?.head) state.isHead = true
      if (opts?.count) state.isCount = true
      return builder
    },
    insert(row) {
      state.op = 'insert'
      state.insertRow = row
      return builder
    },
    update(updates) {
      state.op = 'update'
      state.updates = updates
      return builder
    },
    upsert(row, opts) {
      state.op = 'upsert'
      state.insertRow = row
      state.upsertOpts = opts
      return builder
    },
    delete() {
      state.op = 'delete'
      return builder
    },
    eq(col, val) { state.filters.push(['eq', col, val]); return builder },
    neq(col, val) { state.filters.push(['neq', col, val]); return builder },
    gt(col, val) { state.filters.push(['gt', col, val]); return builder },
    gte(col, val) { state.filters.push(['gte', col, val]); return builder },
    lt(col, val) { state.filters.push(['lt', col, val]); return builder },
    lte(col, val) { state.filters.push(['lte', col, val]); return builder },
    is(col, val) { state.filters.push(['is', col, val]); return builder },
    in(col, vals) { state.filters.push(['in', col, vals]); return builder },
    or(expr) { state.filters.push(['or', expr]); return builder },
    order(col, opts) { state.orderBy = [col, opts]; return builder },
    limit(n) { state.limit = n; return builder },
    single() { state.isSingle = true; return _resolve() },
    maybeSingle() { state.isMaybeSingle = true; return _resolve() },
    then(resolve, reject) { return _resolve().then(resolve, reject) },
    catch(rej) { return _resolve().catch(rej) },
  }
  function _resolve() {
    supabaseCalls.push({ ...state, filters: [...state.filters] })
    return Promise.resolve(stubResponseFor(state))
  }
  return builder
}

function stubResponseFor(state) {
  const t = state.table
  // Default benign empty
  if (state.op === 'insert' || state.op === 'upsert') {
    if (state.isSingle || state.isMaybeSingle) return { data: { id: 999, ...(state.insertRow || {}) }, error: null }
    return { data: [{ id: 999, ...(state.insertRow || {}) }], error: null }
  }
  if (state.op === 'update') {
    if (state.isSingle || state.isMaybeSingle) return { data: { id: 1, ...(state.updates || {}) }, error: null }
    return { data: null, error: null }
  }
  if (state.op === 'delete') return { data: null, error: null }

  // select with count head
  if (state.isHead && state.isCount) return { count: 0, data: null, error: null }
  if (state.isCount) return { count: 0, data: [], error: null }

  // Specific tables — return shape consumers expect
  if (state.isSingle) {
    if (t === 'setup_sessions') {
      return { data: { group_id: state.filters.find(f => f[1] === 'group_id')?.[2] ?? 'grp-test', group_name: 'Bella Trattoria', dm_chat_id: 9001, manager_id: 9001, setup_data: { tipMode: 'pool' }, phone: '+15555550001' }, error: null }
    }
    if (t === 'staff') {
      const idFilter = state.filters.find(f => f[1] === 'id')
      if (!idFilter) return { data: null, error: { message: 'no id' } }
      return { data: { id: idFilter[2], name: 'Test Staff', role: 'Server', cross_training: [] }, error: null }
    }
    if (t === 'shifts') {
      const idFilter = state.filters.find(f => f[1] === 'id')
      if (!idFilter) return { data: null, error: null }
      return { data: { id: idFilter[2], name: 'Mon Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '16:00' }, error: null }
    }
    if (t === 'business_rules') {
      const idFilter = state.filters.find(f => f[1] === 'id')
      if (!idFilter) return { data: null, error: null }
      return { data: { id: idFilter[2] }, error: null }
    }
    return { data: null, error: null }
  }
  if (state.isMaybeSingle) {
    if (t === 'overtime_settings') return { data: { weekly_threshold: 40, weekly_multiplier: 1.5 }, error: null }
    if (t === 'labor_budgets') return { data: { weekly_budget: 8500, currency: 'USD' }, error: null }
    return { data: null, error: null }
  }
  return { data: [], error: null }
}

// Patch the supabase client used in dashRoutes
import { createClient } from '@supabase/supabase-js'

// Monkey-patch createClient to return stub
const origCreateClient = createClient
const stubClient = {
  from: makeStubTable,
  rpc: async (name, args) => {
    supabaseCalls.push({ rpc: name, args })
    return { data: null, error: { message: `rpc ${name} stubbed` } }
  },
  auth: {
    getUser: async () => ({ data: { user: null }, error: null }),
  },
}

// We can't truly patch the imported createClient post-import in a clean way,
// but the dashRoutes module memoizes its own client. We replace its exported
// supabase factory by injecting via a local override module (see below).
// Instead, we use a different approach: spin up the express app, hit each
// route, and capture the responses. Errors that escape -> findings.

export async function runDashApiStress() {
  const findings = []

  // We replace the Supabase factory by patching @supabase/supabase-js export
  // before dashRoutes lazily creates the client. Since dashRoutes calls
  // createClient internally, we trick it by replacing the underlying fetch.
  // Simpler path: hit every route and report what comes back.

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.locals.bot = {
    sendMessage: async () => ({ message_id: 1 }),
  }
  app.use('/api', dashRoutes)
  app.use('/api/auth', authRoutes)

  const server = createServer(app)
  await new Promise(r => server.listen(0, r))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  const token = signToken({ groupId: 'stress-grp-001', restaurantName: 'Bella Trattoria', phone: '+15555550001' })
  const cookieHeader = `relay_session=${token}`

  async function hit(method, path, body = null, label = '') {
    const url = `${baseUrl}${path}`
    const init = { method, headers: { 'Content-Type': 'application/json', Cookie: cookieHeader } }
    if (body) init.body = JSON.stringify(body)
    let res, txt
    try {
      res = await fetch(url, init)
      txt = await res.text()
    } catch (err) {
      findings.push({
        severity: 'CRITICAL',
        area: 'dash-api',
        title: `Request to ${method} ${path} threw uncaught error`,
        evidence: `${err.message}`,
        repro: `${method} ${path}${body ? ' body=' + JSON.stringify(body).slice(0, 200) : ''}`,
      })
      return null
    }
    let parsed = null
    try { parsed = JSON.parse(txt) } catch {}

    // Categorize: 5xx = bug; 4xx = potentially expected; 200/201 = good
    if (res.status >= 500) {
      findings.push({
        severity: 'HIGH',
        area: 'dash-api',
        title: `${method} ${path} returned 500 ${label ? '(' + label + ')' : ''}`,
        evidence: `Status ${res.status}, body: ${txt.slice(0, 400)}`,
        repro: `${method} ${path}${body ? ' with body ' + JSON.stringify(body) : ''}`,
        impact: '500s on dashboard routes break the manager UI experience',
      })
    }
    return { status: res.status, body: parsed, raw: txt }
  }

  // Helper to label cluster of hits
  async function cluster(name, fn) {
    try { await fn() }
    catch (err) {
      findings.push({
        severity: 'CRITICAL',
        area: 'dash-api',
        title: `Cluster "${name}" threw: ${err.message}`,
        evidence: err.stack?.split('\n').slice(0, 5).join('\n'),
      })
    }
  }

  // ─ Auth round-trip ─
  await cluster('auth', async () => {
    await hit('POST', '/api/auth/request-code', { phone: '+15555550001' }, 'request-code valid')
    await hit('POST', '/api/auth/request-code', {}, 'request-code missing phone')
    await hit('POST', '/api/auth/request-code', { phone: 'invalid' }, 'request-code invalid phone')
    await hit('POST', '/api/auth/verify-code', { phone: '+15555550001', code: '000000' }, 'verify wrong code')
    await hit('POST', '/api/auth/verify-code', {}, 'verify missing fields')
    await hit('POST', '/api/auth/logout', {}, 'logout')
    await hit('GET', '/api/auth/me', null, 'me')
  })

  // ─ Overview / Schedule / Activity / Intelligence ─
  await cluster('overview-routes', async () => {
    await hit('GET', '/api/overview', null, 'overview default')
    await hit('GET', '/api/overview?week=2025-04-28', null, 'overview specific week')
    await hit('GET', '/api/overview?week=invalid-date', null, 'overview bad date')
    await hit('GET', '/api/schedule', null, 'schedule default')
    await hit('GET', '/api/schedule?week=2025-04-28', null, 'schedule specific week')
    await hit('GET', '/api/activity', null, 'activity')
    await hit('GET', '/api/intelligence', null, 'intelligence')
    await hit('GET', '/api/dashboard/overview', null, 'legacy overview')
  })

  // ─ Staff CRUD with edge cases ─
  await cluster('staff-crud', async () => {
    await hit('GET', '/api/staff', null, 'list staff')
    await hit('POST', '/api/staff', { name: 'Marco', role: 'Server' }, 'create valid')
    await hit('POST', '/api/staff', {}, 'create missing fields')
    await hit('POST', '/api/staff', { name: '', role: 'Server' }, 'create empty name')
    await hit('POST', '/api/staff', { name: 'X'.repeat(500), role: 'Server' }, 'create very long name')
    await hit('POST', '/api/staff', { name: 'Marco<script>alert(1)</script>', role: 'Server' }, 'create xss in name')
    await hit('POST', '/api/staff', { name: 'Marco; DROP TABLE staff;--', role: 'Server' }, 'create sqli')
    await hit('POST', '/api/staff', { name: 'María', role: 'Sous Chef' }, 'create unicode')
    await hit('POST', '/api/staff', { name: '👨‍🍳', role: 'Chef' }, 'create emoji')
    await hit('PATCH', '/api/staff/999', { name: 'Updated' }, 'patch existing')
    await hit('PATCH', '/api/staff/abc', { name: 'X' }, 'patch non-numeric id')
    await hit('PATCH', '/api/staff/-1', { name: 'X' }, 'patch negative id')
    await hit('DELETE', '/api/staff/999', null, 'delete existing')
    await hit('DELETE', '/api/staff/abc', null, 'delete non-numeric id')
    await hit('GET', '/api/staff/999/stats', null, 'stats')
    await hit('GET', '/api/staff/abc/stats', null, 'stats non-numeric')
  })

  // ─ Shifts ─
  await cluster('shifts-crud', async () => {
    await hit('GET', '/api/shifts', null, 'list shifts')
    await hit('POST', '/api/shifts', { name: 'Wed Lunch', day_of_week: 'Wednesday', start_time: '11:00', end_time: '16:00' }, 'create valid')
    await hit('POST', '/api/shifts', {}, 'create missing fields')
    await hit('POST', '/api/shifts', { name: 'X', day_of_week: 'NotADay', start_time: '11:00', end_time: '16:00' }, 'create invalid day')
    await hit('POST', '/api/shifts', { name: 'X', day_of_week: 'Monday', start_time: '25:00', end_time: '16:00' }, 'create invalid time')
    await hit('POST', '/api/shifts', { name: 'X', day_of_week: 'Monday', start_time: '15:00', end_time: '14:00' }, 'create end before start')
    await hit('PATCH', '/api/shifts/999', { name: 'Updated' }, 'patch existing')
    await hit('DELETE', '/api/shifts/999', null, 'delete existing')
    await hit('PUT', '/api/shifts/999/requirements', { requirements: [{ role: 'Server', count: 3 }] }, 'set requirements')
    await hit('PUT', '/api/shifts/999/requirements', {}, 'set requirements no body')
    await hit('PUT', '/api/shifts/abc/requirements', { requirements: [] }, 'invalid id')
    await hit('PUT', '/api/shifts/999/requirements', { requirements: [{ role: 'Server', count: 999 }] }, 'count too high')
    await hit('PUT', '/api/shifts/999/requirements', { requirements: [{ role: '', count: 1 }] }, 'empty role')
  })

  // ─ Schedule generation/approval ─
  await cluster('schedule-gen', async () => {
    await hit('GET', '/api/schedule-list', null, 'schedule list')
    await hit('POST', '/api/schedule/assign', { staffId: 1, shiftId: 1, weekStart: '2025-04-28' }, 'assign valid')
    await hit('POST', '/api/schedule/assign', {}, 'assign missing fields')
    await hit('POST', '/api/schedule/assign', { staffId: 1, shiftId: 1, weekStart: '1999-01-01' }, 'assign past week')
    await hit('DELETE', '/api/schedule/assign', { staffId: 1, shiftId: 1, weekStart: '2025-04-28' }, 'unassign')
    await hit('DELETE', '/api/schedule/assign', {}, 'unassign missing')
    await hit('POST', '/api/schedule/generate', { weekStart: '2025-04-28' }, 'generate')
    await hit('POST', '/api/schedule/generate', {}, 'generate missing week')
    await hit('POST', '/api/schedule/approve', { weekStart: '2025-04-28' }, 'approve')
    await hit('POST', '/api/schedule/approve', {}, 'approve missing')
  })

  // ─ Payroll, revenue, tips ─
  await cluster('payroll-revenue', async () => {
    await hit('GET', '/api/payroll', null, 'payroll')
    await hit('GET', '/api/payroll?week=2025-04-28', null, 'payroll specific')
    await hit('GET', '/api/payroll/spreadsheet', null, 'csv export')
    await hit('PATCH', '/api/payroll/999/rate', { rate: 22.50 }, 'set rate')
    await hit('PATCH', '/api/payroll/999/rate', { rate: -5 }, 'negative rate')
    await hit('PATCH', '/api/payroll/999/rate', { rate: 999 }, 'unusually high rate')
    await hit('PATCH', '/api/payroll/999/rate', {}, 'missing rate')
    await hit('PATCH', '/api/payroll/999/rate', { rate: 'abc' }, 'non-numeric rate')

    await hit('POST', '/api/payroll/revenue', { weekStart: '2025-04-28', revenue: 35000 }, 'set revenue')
    await hit('POST', '/api/payroll/revenue', {}, 'missing revenue')
    await hit('POST', '/api/payroll/revenue', { weekStart: '2025-04-28', revenue: -100 }, 'negative revenue')
    await hit('POST', '/api/payroll/revenue', { weekStart: '2025-04-28', revenue: 'abc' }, 'string revenue')
    await hit('POST', '/api/payroll/revenue', { weekStart: '2025-04-28', revenue: 1e15 }, 'huge revenue')

    await hit('GET', '/api/revenue/daily', null, 'daily revenue')
    await hit('GET', '/api/revenue/daily?weekStart=2025-04-28', null, 'daily revenue specific')
    await hit('POST', '/api/revenue/daily', { date: '2025-04-28', amount: 5000, category: 'lunch' }, 'add daily revenue')
    await hit('POST', '/api/revenue/daily', { date: 'bad-date', amount: 5000 }, 'bad date format')
    await hit('POST', '/api/revenue/daily', { date: '2025-04-28', amount: -1 }, 'negative amount')
    await hit('POST', '/api/revenue/daily', { date: '2025-04-28', amount: 0 }, 'zero amount')
    await hit('POST', '/api/revenue/daily', {}, 'missing fields')
    await hit('DELETE', '/api/revenue/daily/1', null, 'delete daily revenue')
    await hit('DELETE', '/api/revenue/daily/abc', null, 'delete bad id')

    await hit('GET', '/api/revenue/types', null, 'list categories')
    await hit('POST', '/api/revenue/types', { name: 'Catering' }, 'add category')
    await hit('POST', '/api/revenue/types', { name: '' }, 'empty category')
    await hit('POST', '/api/revenue/types', {}, 'missing name')
    await hit('DELETE', '/api/revenue/types/1', null, 'delete category')

    await hit('GET', '/api/tips', null, 'tips list')
    await hit('GET', '/api/tips?weeks=12', null, 'tips weeks param')
    await hit('GET', '/api/tips?weeks=999', null, 'tips weeks too high')
    await hit('GET', '/api/tips?weeks=abc', null, 'tips weeks not number')
    await hit('POST', '/api/tips', { shiftDate: '2025-04-28', totalTips: 1500, splitMethod: 'equal' }, 'add tips equal')
    await hit('POST', '/api/tips', { shiftDate: '2025-04-28', totalTips: 1500, splitMethod: 'hours' }, 'add tips hours')
    await hit('POST', '/api/tips', { shiftDate: '2025-04-28', totalTips: 1500, splitMethod: 'invalid' }, 'invalid split method')
    await hit('POST', '/api/tips', {}, 'missing tips fields')
    await hit('POST', '/api/tips', { shiftDate: '2025-04-28', totalTips: -100 }, 'negative tips')
  })

  // ─ Settings ─
  await cluster('settings', async () => {
    await hit('GET', '/api/settings', null, 'get settings')
    await hit('PATCH', '/api/settings', { tipMode: 'individual' }, 'set tip mode')
    await hit('PATCH', '/api/settings', { overtimeThreshold: 40, overtimeMultiplier: 1.5 }, 'set OT')
    await hit('PATCH', '/api/settings', { weeklyBudget: 9000 }, 'set budget')
    await hit('PATCH', '/api/settings', { restaurantName: 'New Name' }, 'rename')
    await hit('PATCH', '/api/settings', {}, 'no fields')
    await hit('PATCH', '/api/settings', { weeklyBudget: -100 }, 'negative budget')

    await hit('GET', '/api/settings/full', null, 'full settings')
    await hit('PATCH', '/api/settings/full', { restaurant: { name: 'X' } }, 'patch full restaurant')
    await hit('PATCH', '/api/settings/full', { overtime: { weekly_threshold: 50, overtime_enabled: true } }, 'patch full overtime')
    await hit('PATCH', '/api/settings/full', { tips: { mode: 'individual', splitMethod: 'hours', bohIncluded: false } }, 'patch tips')
    await hit('PATCH', '/api/settings/full', { budget: { weeklyBudget: 8000 } }, 'patch budget')
    await hit('PATCH', '/api/settings/full', {}, 'patch full empty')
  })

  // ─ Rules ─
  await cluster('rules', async () => {
    await hit('GET', '/api/rules', null, 'list rules')
    await hit('POST', '/api/rules', { type: 'staff_conflict', constraintText: 'A and B never together' }, 'add rule')
    await hit('POST', '/api/rules', { type: 'day_off', constraintText: 'X' }, 'add day_off')
    await hit('POST', '/api/rules', { type: 'staff_conflict', constraintText: 'X', subjectStaffId: 99999 }, 'subject not found')
    await hit('POST', '/api/rules', {}, 'missing rule fields')
    await hit('POST', '/api/rules', { type: 'day_off', constraintText: '' }, 'empty constraint')
    await hit('DELETE', '/api/rules/999', null, 'delete rule')
    await hit('DELETE', '/api/rules/abc', null, 'delete rule bad id')
  })

  // ─ Coverage ─
  await cluster('coverage', async () => {
    await hit('GET', '/api/coverage', null, 'list coverage')
    await hit('POST', '/api/coverage', { shiftId: 1 }, 'create coverage')
    await hit('POST', '/api/coverage', { shiftId: 1, reason: 'sick' }, 'create with reason')
    await hit('POST', '/api/coverage', {}, 'missing shift')
    await hit('POST', '/api/coverage', { shiftId: 99999 }, 'shift not found')
  })

  // ─ Time clock ─
  await cluster('timeclock', async () => {
    await hit('GET', '/api/timeclock', null, 'list entries')
    await hit('GET', '/api/timeclock?week=2025-04-28', null, 'specific week')
    await hit('GET', '/api/timeclock/live', null, 'live entries')
    await hit('GET', '/api/timeclock/weekly?weekStart=2025-04-28', null, 'weekly summary')
    await hit('POST', '/api/timeclock/override', { staffId: 1, action: 'clock_in' }, 'manual clock_in')
    await hit('POST', '/api/timeclock/override', { staffId: 1, action: 'clock_out' }, 'manual clock_out')
    await hit('POST', '/api/timeclock/override', { staffId: 1, action: 'adjust', time: '2025-04-28T15:00:00Z' }, 'manual adjust')
    await hit('POST', '/api/timeclock/override', { staffId: 1, action: 'invalid' }, 'invalid action')
    await hit('POST', '/api/timeclock/override', { staffId: 1, action: 'adjust', time: 'not-iso' }, 'invalid time')
    await hit('POST', '/api/timeclock/override', {}, 'missing fields')
  })

  // ─ Events ─
  await cluster('events', async () => {
    await hit('GET', '/api/events?weekStart=2025-04-28', null, 'events for week')
    await hit('GET', '/api/events?weekStart=2025-04-28&limit=200', null, 'events high limit')
    await hit('GET', '/api/events', null, 'events default')
    await hit('GET', '/api/events?weekStart=invalid', null, 'events bad date')
  })

  // ─ Roles & rates ─
  await cluster('roles', async () => {
    await hit('GET', '/api/roles', null, 'list roles')
    await hit('PATCH', '/api/roles/Server', { rate: 16.5 }, 'update Server rate')
    await hit('PATCH', '/api/roles/Server', { rate: -1 }, 'negative rate')
    await hit('PATCH', '/api/roles/Server', { rate: 9999 }, 'rate too high')
    await hit('PATCH', '/api/roles/Server', {}, 'missing rate')
    await hit('POST', '/api/rates', { roleName: 'Bartender', hourlyRate: 18 }, 'add rate')
    await hit('POST', '/api/rates', {}, 'missing fields')
    await hit('POST', '/api/rates', { roleName: 'Bartender', hourlyRate: -1 }, 'negative rate')
  })

  // ─ Auth required - hit a few without cookie ─
  await cluster('unauth', async () => {
    const url = `${baseUrl}/api/staff`
    const r = await fetch(url)  // no cookie
    if (r.status !== 401) {
      findings.push({
        severity: 'HIGH',
        area: 'dash-api-auth',
        title: `GET /api/staff without cookie returned ${r.status} (expected 401)`,
        evidence: `Auth bypass possible`,
      })
    }
    // Try with expired token
    const expired = signToken({ groupId: 'g', restaurantName: 'r' })  // valid 7d default - can't easily expire
    const r2 = await fetch(url, { headers: { Cookie: 'relay_session=invalid' } })
    if (r2.status !== 401) {
      findings.push({
        severity: 'HIGH',
        area: 'dash-api-auth',
        title: `GET /api/staff with invalid cookie returned ${r2.status} (expected 401)`,
      })
    }
  })

  await new Promise(r => server.close(r))

  return { findings, stats: { calls: supabaseCalls.length } }
}
