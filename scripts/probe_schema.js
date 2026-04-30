// Probe production Supabase to see which tables/columns/FKs from the
// reconciliation SQL actually exist. Output: which ones are missing.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const TABLES = [
  'weekly_quality_scores',
  'restaurant_tip_settings',
  'cross_training',
  'recurring_constraints',
  'discovered_patterns',
  'coverage_confirmations',
  'staff_availability_windows',
  'staff_members',
  'availability_outcomes',
]

const COLUMN_PROBES = [
  ['role_rates',   'updated_at'],
  ['time_entries', 'alerted_at'],
]

const RLS_PROBES = [
  // tables that need anon insert/update — we test by trying an insert and looking
  // for "row violates row-level security" rather than "relation does not exist"
  'tip_records',
  'recognition_events',
  'schedule_quality_scores',
  'daily_revenue',
  'revenue_types',
  'weekly_quality_scores',
  'restaurant_tip_settings',
  'cross_training',
  'recurring_constraints',
  'discovered_patterns',
  'coverage_confirmations',
  'staff_availability_windows',
  'staff_members',
  'availability_outcomes',
]

// FK probe: try to embed staff(name) from time_entries — succeeds only if FK exists
async function probeFk() {
  const { error } = await supabase
    .from('time_entries')
    .select('id, staff(name)')
    .limit(1)
  if (!error) return { ok: true }
  if (/Could not find a relationship/i.test(error.message)) return { ok: false, reason: 'fk-missing' }
  if (/relation .* does not exist/i.test(error.message)) return { ok: false, reason: 'table-missing' }
  return { ok: false, reason: error.message }
}

async function probeTable(name) {
  const { error } = await supabase.from(name).select('id', { head: true, count: 'exact' }).limit(1)
  if (!error) return { exists: true }
  if (/relation .* does not exist/i.test(error.message) || error.code === 'PGRST205' || /Could not find the table/i.test(error.message)) {
    return { exists: false }
  }
  // RLS or other error — table exists, query failed for other reason
  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return { exists: true, rls_blocked: true }
  }
  return { exists: 'unknown', error: error.message }
}

async function probeColumn(table, col) {
  const { error } = await supabase.from(table).select(col).limit(1)
  if (!error) return { exists: true }
  if (/Could not find the .* column/i.test(error.message) || error.code === 'PGRST204') {
    return { exists: false }
  }
  if (/relation .* does not exist/i.test(error.message)) {
    return { exists: false, table_missing: true }
  }
  return { exists: 'unknown', error: error.message }
}

async function probeRlsAnonInsert(table) {
  // Try a deliberately-malformed insert. If RLS rejects, we get 42501.
  // If RLS allows but schema rejects, we get something else (good sign).
  // If table doesn't exist, we get PGRST205.
  const { error } = await supabase.from(table).insert({ __probe__: true }).select()
  if (!error) return { allows_insert: true }
  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return { allows_insert: false, rls_blocked: true }
  }
  if (/relation .* does not exist/i.test(error.message) || error.code === 'PGRST205') {
    return { allows_insert: false, table_missing: true }
  }
  // Schema error / column doesn't exist / etc — RLS isn't blocking us
  return { allows_insert: true, schema_error: error.message }
}

console.log('# Probing production Supabase\n')

const missing = {
  tables: [],
  columns: [],
  fk: false,
  rls: [],
}

console.log('## Tables')
for (const t of TABLES) {
  const r = await probeTable(t)
  const status = r.exists === true ? '✅' : r.exists === false ? '❌ MISSING' : '⚠️ ' + (r.error || '?')
  console.log(`  ${t.padEnd(34)} ${status}`)
  if (r.exists === false) missing.tables.push(t)
}

console.log('\n## Columns on existing tables')
for (const [tbl, col] of COLUMN_PROBES) {
  const r = await probeColumn(tbl, col)
  const status = r.exists === true ? '✅' : r.exists === false ? '❌ MISSING' : '⚠️ ' + (r.error || '?')
  console.log(`  ${tbl}.${col}`.padEnd(36) + ` ${status}`)
  if (r.exists === false && !r.table_missing) missing.columns.push([tbl, col])
}

console.log('\n## time_entries → staff FK (PostgREST embed)')
const fk = await probeFk()
console.log(`  time_entries.staff(name)            ${fk.ok ? '✅' : '❌ MISSING (' + fk.reason + ')'}`)
if (!fk.ok && fk.reason === 'fk-missing') missing.fk = true

console.log('\n## RLS anon-insert policies')
for (const t of RLS_PROBES) {
  const r = await probeRlsAnonInsert(t)
  let status
  if (r.allows_insert) status = '✅'
  else if (r.table_missing) status = '⏭️  (table not yet created — RLS policy will be created with table)'
  else if (r.rls_blocked) status = '❌ RLS BLOCKING'
  else status = '⚠️ ' + (r.error || '?')
  console.log(`  ${t.padEnd(34)} ${status}`)
  if (r.rls_blocked) missing.rls.push(t)
}

console.log('\n# SUMMARY')
console.log(`  Missing tables:     ${missing.tables.length}`)
console.log(`  Missing columns:    ${missing.columns.length}`)
console.log(`  FK missing:         ${missing.fk}`)
console.log(`  RLS blocking:       ${missing.rls.length}`)

console.log('\n# JSON')
console.log(JSON.stringify(missing, null, 2))
