#!/usr/bin/env node
/**
 * Relay Migration Runner
 * ESM — matches package.json "type": "module"
 *
 * Usage:
 *   node scripts/migrate.js                          # run all pending
 *   node scripts/migrate.js --file=scripts/migrations/001_foo.sql
 *   node scripts/migrate.js "ALTER TABLE x ADD COLUMN y TEXT;"
 *   node scripts/migrate.js --dry-run
 *   node scripts/migrate.js --force
 *   node scripts/migrate.js --help
 *
 * Execution strategy (in priority order):
 *   1. supabase db query --linked   (needs SUPABASE_ACCESS_TOKEN + linked project)
 *   2. supabase db query --db-url   (needs SUPABASE_DB_URL or POSTGRES_URL in .env)
 *   3. Supabase Management API      (needs SUPABASE_ACCESS_TOKEN in .env)
 *   4. Print SQL for manual paste   (always available fallback)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !process.env[key]) process.env[key] = val
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = join(__dirname, 'migrations')
const LOG_FILE = join(MIGRATIONS_DIR, '.migrate_log')
const PROJECT_REF = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0]

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flags = {
  dryRun:  args.includes('--dry-run'),
  force:   args.includes('--force'),
  help:    args.includes('--help') || args.includes('-h'),
}
const fileFlag = args.find(a => a.startsWith('--file='))
const specificFile = fileFlag ? fileFlag.replace('--file=', '') : null
const inlineSql = args.find(a => !a.startsWith('--'))

// ── Help ──────────────────────────────────────────────────────────────────────
if (flags.help) {
  console.log(`
╔══════════════════════════════════════════════════╗
║          Relay Migration Runner — Help           ║
╚══════════════════════════════════════════════════╝

Usage:
  node scripts/migrate.js                          Run all pending migrations
  node scripts/migrate.js --dry-run                Print SQL without executing
  node scripts/migrate.js --force                  Re-run already-completed migrations
  node scripts/migrate.js --file=<path>            Run a specific SQL file
  node scripts/migrate.js "<SQL>"                  Run inline SQL string
  node scripts/migrate.js --help                   Show this help

Environment variables (.env):
  SUPABASE_URL           Required — your Supabase project URL
  SUPABASE_ACCESS_TOKEN  Enables automatic execution via CLI / Management API
  SUPABASE_DB_URL        Direct Postgres connection string (alternative)
  SUPABASE_SERVICE_KEY   Service role key (alternative to access token)

Execution strategy (tried in order):
  1. supabase CLI  (supabase db query --linked)
  2. Direct DB URL (supabase db query --db-url)
  3. Management API REST call
  4. Print SQL for manual paste in Supabase dashboard

Migration log: scripts/migrations/.migrate_log  (gitignored)
`)
  process.exit(0)
}

// ── Validate env ──────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_SERVICE_KEY
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL

if (!SUPABASE_URL) {
  console.error('❌  SUPABASE_URL is not set in .env — cannot proceed.')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function banner(text) {
  const line = '─'.repeat(text.length + 4)
  console.log(`\n╔${line}╗\n║  ${text}  ║\n╚${line}╝`)
}

function readLog() {
  if (!existsSync(LOG_FILE)) return new Set()
  return new Set(
    readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
  )
}

function writeLog(completed) {
  writeFileSync(LOG_FILE, [...completed].join('\n') + '\n', 'utf8')
}

/** Determine which execution strategy is available */
function detectStrategy() {
  // 1. supabase CLI available + project linked? (works without a personal access token)
  try {
    const linked = existsSync(join(ROOT, 'supabase', '.temp', 'project-ref'))
    execSync('supabase --version', { stdio: 'pipe' })
    if (linked) return 'cli-linked'
  } catch {}

  // 2. Direct DB URL available?
  if (SUPABASE_DB_URL) return 'cli-dburl'

  // 3. Management API (needs access token + project ref)
  if (SUPABASE_ACCESS_TOKEN && PROJECT_REF) return 'management-api'

  // 4. Fallback — print only
  return 'print'
}

/** Execute SQL using the detected strategy */
async function executeSql(sql, label = 'SQL') {
  if (!sql || !sql.trim()) {
    console.log(`  ⚠️  ${label}: empty — skipping`)
    return true
  }

  const strategy = detectStrategy()

  if (flags.dryRun) {
    console.log(`\n  [dry-run] ${label}`)
    console.log('  ' + '─'.repeat(50))
    // Print SQL lines, never exposing secrets
    sql.split('\n').forEach(l => console.log('  ' + l))
    console.log('  ' + '─'.repeat(50))
    return true
  }

  if (strategy === 'cli-linked') {
    return execViaCli(`supabase db query --linked`, sql, label)
  }

  if (strategy === 'cli-dburl') {
    const escaped = SUPABASE_DB_URL.replace(/'/g, "\\'")
    return execViaCli(`supabase db query --db-url '${escaped}'`, sql, label)
  }

  if (strategy === 'management-api') {
    return await execViaManagementApi(sql, label)
  }

  // Fallback: print for manual execution
  printForManual(sql, label)
  return null // null = "not executed, needs manual"
}

function execViaCli(cmd, sql, label) {
  try {
    // Write SQL to a temp file to avoid shell quoting issues
    const tmpFile = join(MIGRATIONS_DIR, '.tmp_migration.sql')
    writeFileSync(tmpFile, sql, 'utf8')
    const out = execSync(`${cmd} --file '${tmpFile}'`, {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env },
    }).toString()
    try { execSync(`rm -f '${tmpFile}'`, { stdio: 'pipe' }) } catch {}
    if (out.trim()) console.log('  ' + out.trim().split('\n').join('\n  '))
    return true
  } catch (err) {
    const msg = err.stderr?.toString() || err.stdout?.toString() || err.message
    console.error(`  ❌  CLI error for ${label}:\n  ${msg.split('\n').join('\n  ')}`)
    return false
  }
}

async function execViaManagementApi(sql, label) {
  // Supabase Management API: POST /v1/projects/{ref}/database/query
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    })
    const text = await resp.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    if (!resp.ok) {
      console.error(`  ❌  Management API error for ${label}: HTTP ${resp.status}`)
      console.error('  ' + (typeof body === 'string' ? body : JSON.stringify(body, null, 2)).split('\n').join('\n  '))
      return false
    }
    return true
  } catch (err) {
    console.error(`  ❌  Network error for ${label}: ${err.message}`)
    return false
  }
}

function printForManual(sql, label) {
  console.log(`
  ⚠️  No execution method available. Run this SQL manually in Supabase:
  → https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new

  ─── ${label} ───────────────────────────────────────────`)
  sql.split('\n').forEach(l => console.log('  ' + l))
  console.log('  ' + '─'.repeat(50))
  console.log(`
  To enable automatic execution, add to .env:
    SUPABASE_ACCESS_TOKEN=<your personal access token>
  Get one at: https://supabase.com/dashboard/account/tokens
`)
}

function printStrategy() {
  const s = detectStrategy()
  const labels = {
    'cli-linked':      '🔗  supabase CLI (linked project)',
    'cli-dburl':       '🔗  supabase CLI (direct DB URL)',
    'management-api':  '🌐  Supabase Management API',
    'print':           '📋  Print-only — add SUPABASE_ACCESS_TOKEN or link project for auto-execution',
  }
  console.log(`  Strategy: ${labels[s] || s}`)
}

// ── Run all migrations ────────────────────────────────────────────────────────
async function runAll() {
  banner('Relay Migration Runner')

  if (!existsSync(MIGRATIONS_DIR)) {
    console.log('  ℹ️  No migrations/ folder found — nothing to run.')
    return
  }

  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort()

  if (allFiles.length === 0) {
    console.log('  ℹ️  No .sql files in scripts/migrations/ — nothing to run.')
    return
  }

  printStrategy()

  const completed = readLog()
  const toRun = flags.force ? allFiles : allFiles.filter(f => !completed.has(f))

  if (toRun.length === 0) {
    console.log(`\n  ✅  All ${allFiles.length} migration(s) already run. Use --force to re-run.\n`)
    return
  }

  console.log(`\n  Pending: ${toRun.length} of ${allFiles.length} migration(s)\n`)

  let ran = 0, failed = 0, manual = 0

  for (const file of toRun) {
    const filePath = join(MIGRATIONS_DIR, file)
    const sql = readFileSync(filePath, 'utf8').trim()

    process.stdout.write(`  Running: ${file} ... `)

    if (!sql) {
      console.log('⏭  (empty)')
      completed.add(file)
      continue
    }

    // Print SQL snippet (first line only, never secrets)
    const preview = sql.split('\n')[0].slice(0, 60)
    console.log(`\n  ┌ ${preview}${sql.split('\n')[0].length > 60 ? '…' : ''}`)

    const result = await executeSql(sql, file)

    if (result === true) {
      console.log(`  └ ✅  ${file}`)
      completed.add(file)
      ran++
    } else if (result === null) {
      console.log(`  └ 📋  ${file} (needs manual execution)`)
      manual++
    } else {
      console.log(`  └ ❌  ${file}`)
      failed++
      if (!flags.dryRun) {
        writeLog(completed)
        console.error(`\n  ⛔  Stopped on failure. Fix the error above then re-run.\n`)
        process.exit(1)
      }
    }
  }

  if (!flags.dryRun) writeLog(completed)

  console.log('\n' + '─'.repeat(54))
  if (flags.dryRun) {
    console.log(`  Dry run complete. ${toRun.length} migration(s) shown.\n`)
  } else if (manual > 0) {
    console.log(`  Done. ${ran} run automatically, ${manual} need manual execution.\n`)
  } else {
    console.log(`  ✅  All done. ${ran} migration(s) run successfully.\n`)
  }
}

// ── Run a specific file ───────────────────────────────────────────────────────
async function runFile(filePath) {
  banner('Relay Migration Runner')
  printStrategy()

  const resolved = resolve(filePath)
  if (!existsSync(resolved)) {
    console.error(`  ❌  File not found: ${resolved}`)
    process.exit(1)
  }

  const sql = readFileSync(resolved, 'utf8').trim()
  const label = resolved.split('/').pop()

  console.log(`\n  Running: ${label}\n`)
  const result = await executeSql(sql, label)

  if (result === true) {
    console.log(`  ✅  ${label} complete.\n`)
    // Add to log if it's in the migrations dir
    const fname = label
    if (existsSync(MIGRATIONS_DIR)) {
      const completed = readLog()
      completed.add(fname)
      writeLog(completed)
    }
  } else if (result === null) {
    console.log(`  📋  Needs manual execution (see above).\n`)
  } else {
    console.error(`  ❌  Failed.\n`)
    process.exit(1)
  }
}

// ── Run inline SQL ────────────────────────────────────────────────────────────
async function runInline(sql) {
  banner('Relay Migration Runner')
  printStrategy()
  console.log('\n  Running inline SQL...\n')
  const result = await executeSql(sql, 'inline')
  if (result === true) {
    console.log('  ✅  Done.\n')
  } else if (result === null) {
    console.log('  📋  Needs manual execution (see above).\n')
  } else {
    console.error('  ❌  Failed.\n')
    process.exit(1)
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (inlineSql) {
  await runInline(inlineSql)
} else if (specificFile) {
  await runFile(specificFile)
} else {
  await runAll()
}
