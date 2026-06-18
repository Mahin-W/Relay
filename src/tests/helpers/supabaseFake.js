// In-memory chainable Supabase JS-client fake. Used to test the real
// dashRoutes.js + middleware against a faithful Supabase API surface
// without requiring a running Postgres or Supabase local stack.
//
// Supports the chainable methods dashRoutes.js actually uses:
//   .from(table)
//   .select(cols).eq.neq.in.is.not.lt.gt.gte.lte.order.limit.range
//   .insert(payload).select().single()
//   .update(payload).eq().select().single()
//   .upsert(payload, opts).select().single()
//   .delete().eq()
//   .single() / .maybeSingle()
//
// The store is a plain object keyed by table name. Tests can pre-seed it.

let _autoId = 1
function nextId() { return _autoId++ }

// Lossy-loose equality: PostgREST type-casts URL params, so strings like
// "1001" should match numeric ids. Also accepts ISO-string ↔ Date pairs.
function looseEq(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  // Numeric coercion when one side is string of digits / float
  const an = typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a
  const bn = typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b) ? Number(b) : b
  if (an === bn) return true
  // Boolean coercion: 'true'/'false'
  const ab = a === 'true' ? true : a === 'false' ? false : a
  const bb = b === 'true' ? true : b === 'false' ? false : b
  if (ab === bb) return true
  return false
}

// Parse string values that PostgREST embeds in or() filters.
// 'null' → null, 'true' → true, '42' → 42, etc.
function parsePostgrestValue(s) {
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

function applyFilters(rows, filters) {
  return rows.filter(row => filters.every(f => {
    const [op, col, val, val2] = f
    const cell = row[col]
    switch (op) {
      case 'eq':  return looseEq(cell, val)
      case 'neq': return !looseEq(cell, val)
      case 'in':  return Array.isArray(val) && val.some(v => looseEq(cell, v))
      case 'is':  return val === null ? cell == null : looseEq(cell, val)
      case 'not':
        if (val === 'is') return val2 === null ? cell != null : !looseEq(cell, val2)
        return !looseEq(cell, val2)
      case 'lt':  return cell != null && cell < val
      case 'lte': return cell != null && cell <= val
      case 'gt':  return cell != null && cell > val
      case 'gte': return cell != null && cell >= val
      case 'ilike': {
        if (cell == null) return false
        const re = new RegExp('^' + String(val).replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
        return re.test(String(cell))
      }
      case 'or': {
        return val.some(sub => applyFilters([row], [sub]).length === 1)
      }
      default: return true
    }
  }))
}

class Query {
  constructor(table, store) {
    this.table = table
    this.store = store
    this.filters = []
    this._select = '*'
    this._order = null
    this._limit = null
    this._range = null
    this._operation = null
    this._payload = null
    this._returnSingle = false
    this._upsertOpts = null
  }

  // Read
  select(cols = '*') {
    this._select = cols
    if (!this._operation) this._operation = 'select'
    return this
  }

  // Write
  insert(payload) { this._operation = 'insert'; this._payload = payload; return this }
  update(payload) { this._operation = 'update'; this._payload = payload; return this }
  upsert(payload, opts) { this._operation = 'upsert'; this._payload = payload; this._upsertOpts = opts ?? null; return this }
  delete() { this._operation = 'delete'; return this }

  // Filters
  eq(col, val)  { this.filters.push(['eq', col, val]); return this }
  neq(col, val) { this.filters.push(['neq', col, val]); return this }
  in(col, val)  { this.filters.push(['in', col, val]); return this }
  is(col, val)  { this.filters.push(['is', col, val]); return this }
  not(col, op, val) { this.filters.push(['not', col, op, val]); return this }
  lt(col, val)  { this.filters.push(['lt', col, val]); return this }
  lte(col, val) { this.filters.push(['lte', col, val]); return this }
  gt(col, val)  { this.filters.push(['gt', col, val]); return this }
  gte(col, val) { this.filters.push(['gte', col, val]); return this }
  ilike(col, pattern) { this.filters.push(['ilike', col, pattern]); return this }
  or(filterStr) {
    // Convert "col.eq.val,col.is.null" → array of [op, col, parsedValue]
    const parts = filterStr.split(',').map(p => {
      const [col, op, ...rest] = p.split('.')
      const rawVal = rest.join('.')
      return [op, col, parsePostgrestValue(rawVal)]
    })
    this.filters.push(['or', null, parts])
    return this
  }

  // Ordering / pagination
  order(col, opts = {}) { this._order = { col, asc: opts.ascending !== false }; return this }
  limit(n) { this._limit = n; return this }
  range(from, to) { this._range = [from, to]; return this }

  // Terminal modifiers
  single()      { this._returnSingle = 'strict'; return this._exec() }
  maybeSingle() { this._returnSingle = 'maybe'; return this._exec() }

  // Auto-resolve when awaited / .then'd
  then(resolve, reject) {
    return this._exec().then(resolve, reject)
  }
  catch(rej) { return this._exec().catch(rej) }

  async _exec() {
    try {
      const rows = this.store[this.table] || (this.store[this.table] = [])
      const op = this._operation || 'select'

      if (op === 'select') {
        let filtered = applyFilters(rows, this.filters).map(r => ({ ...r }))
        if (this._order) {
          filtered.sort((a, b) => {
            const av = a[this._order.col], bv = b[this._order.col]
            if (av === bv) return 0
            const cmp = av > bv ? 1 : -1
            return this._order.asc ? cmp : -cmp
          })
        }
        if (this._range) filtered = filtered.slice(this._range[0], this._range[1] + 1)
        else if (this._limit != null) filtered = filtered.slice(0, this._limit)

        if (this._returnSingle === 'strict') {
          if (filtered.length === 0) return { data: null, error: { message: 'no rows' } }
          if (filtered.length > 1) return { data: null, error: { message: 'multiple rows' } }
          return { data: filtered[0], error: null }
        }
        if (this._returnSingle === 'maybe') {
          return { data: filtered[0] ?? null, error: null }
        }
        return { data: filtered, error: null }
      }

      if (op === 'insert') {
        const items = Array.isArray(this._payload) ? this._payload : [this._payload]
        const inserted = items.map(p => ({
          id: p.id ?? nextId(),
          created_at: p.created_at ?? new Date().toISOString(),
          ...p,
        }))
        rows.push(...inserted)
        if (this._returnSingle === 'strict' || this._returnSingle === 'maybe') {
          return { data: inserted[0], error: null }
        }
        return { data: inserted, error: null }
      }

      if (op === 'update') {
        const matched = applyFilters(rows, this.filters)
        for (const m of matched) Object.assign(m, this._payload, { updated_at: new Date().toISOString() })
        if (this._returnSingle === 'strict') {
          if (matched.length === 0) return { data: null, error: null } // mirrors PG behavior
          return { data: { ...matched[0] }, error: null }
        }
        if (this._returnSingle === 'maybe') {
          return { data: matched[0] ? { ...matched[0] } : null, error: null }
        }
        return { data: matched.map(r => ({ ...r })), error: null }
      }

      if (op === 'upsert') {
        // Identify conflict columns from opts.onConflict (CSV) — fallback: 'id'
        const conflictCols = (this._upsertOpts?.onConflict || 'id').split(',').map(s => s.trim())
        const items = Array.isArray(this._payload) ? this._payload : [this._payload]
        const upserted = []
        for (const p of items) {
          const idx = rows.findIndex(r => conflictCols.every(c => r[c] === p[c]))
          if (idx >= 0) {
            Object.assign(rows[idx], p, { updated_at: new Date().toISOString() })
            upserted.push({ ...rows[idx] })
          } else {
            const inserted = { id: p.id ?? nextId(), created_at: p.created_at ?? new Date().toISOString(), ...p }
            rows.push(inserted)
            upserted.push({ ...inserted })
          }
        }
        if (this._returnSingle) return { data: upserted[0], error: null }
        return { data: upserted, error: null }
      }

      if (op === 'delete') {
        const matched = applyFilters(rows, this.filters)
        const matchedSet = new Set(matched)
        this.store[this.table] = rows.filter(r => !matchedSet.has(r))
        return { data: matched.map(r => ({ ...r })), error: null }
      }

      return { data: null, error: { message: `Unknown op ${op}` } }
    } catch (err) {
      return { data: null, error: { message: err.message } }
    }
  }
}

class FakeClient {
  constructor() {
    this.store = {}
    this.auth = {
      // Stub — dashRoutes uses requireAuth (cookie/JWT), not supabase.auth
      getSession: async () => ({ data: { session: null }, error: null }),
    }
  }

  from(table) { return new Query(table, this.store) }
  rpc(fn, args = {}) {
    if (fn === 'rekey_group') {
      const { old_group, new_group } = args
      for (const table of Object.keys(this.store)) {
        for (const row of this.store[table]) {
          if (row.group_id === old_group) row.group_id = new_group
        }
      }
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve({ data: null, error: null })
  }

  // Convenience for tests — preload a table
  _seed(table, rows) {
    this.store[table] = (this.store[table] || []).concat(rows.map(r => ({
      id: r.id ?? nextId(),
      created_at: r.created_at ?? new Date().toISOString(),
      ...r,
    })))
  }
  _reset() { this.store = {}; _autoId = 1 }
  _table(table) { return this.store[table] || (this.store[table] = []) }
}

// Singleton — every createClient() returns the same backing store so tests can
// pre-seed once and have all routes see the same data.
let _instance = null
export function getFakeClient() {
  if (!_instance) _instance = new FakeClient()
  return _instance
}

// Drop-in replacement for `createClient` from @supabase/supabase-js
export function createClient() { return getFakeClient() }

// Test helpers
export function resetFakeClient() {
  if (_instance) _instance._reset()
  _autoId = 1
}
export function seedTable(table, rows) {
  getFakeClient()._seed(table, rows)
}
