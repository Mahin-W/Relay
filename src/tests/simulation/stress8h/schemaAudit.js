// Schema audit — parse supabase-schema.sql and grep the codebase for db.from('X')
// references. Reports tables/columns referenced in code but missing from schema.

import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()

export async function runSchemaAudit() {
  const findings = []

  const schemaPath = path.join(ROOT, 'supabase-schema.sql')
  const schemaSql = await fs.readFile(schemaPath, 'utf8')

  // Extract table names from CREATE TABLE
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi
  const tables = new Set()
  let m
  while ((m = tableRegex.exec(schemaSql)) !== null) tables.add(m[1].toLowerCase())

  // Extract columns per table — naive: look between CREATE TABLE foo ( and the matching )
  const columnsByTable = {}
  const tableBodyRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi
  while ((m = tableBodyRegex.exec(schemaSql)) !== null) {
    const t = m[1].toLowerCase()
    const body = m[2]
    const cols = []
    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '')
      if (!trimmed) continue
      if (/^(CONSTRAINT|UNIQUE|CHECK|PRIMARY|FOREIGN|REFERENCES)/i.test(trimmed)) continue
      const colMatch = trimmed.match(/^(\w+)\s+\w/)
      if (colMatch) cols.push(colMatch[1].toLowerCase())
    }
    columnsByTable[t] = cols
  }
  // Also pick up ALTER TABLE foo ADD COLUMN bar ...
  const alterRegex = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi
  while ((m = alterRegex.exec(schemaSql)) !== null) {
    const t = m[1].toLowerCase()
    const c = m[2].toLowerCase()
    columnsByTable[t] = columnsByTable[t] || []
    if (!columnsByTable[t].includes(c)) columnsByTable[t].push(c)
  }

  // Walk source files, find db.from('X') and .select('a, b, c')
  const srcFiles = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'tests', 'public', 'docs', 'scripts'].includes(e.name)) continue
        await walk(full)
      } else if (e.isFile() && e.name.endsWith('.js')) {
        srcFiles.push(full)
      }
    }
  }
  await walk(path.join(ROOT, 'src'))

  const tableRefs = new Map()       // table -> Set of files
  const columnRefs = new Map()      // table -> Map(col -> Set of files)

  // pattern: .from('foo') or .from("foo")
  const fromRe = /\.from\(\s*['"`]([\w_]+)['"`]\s*\)/g
  // Capture chained .select('cols') after .from. The gap between them must be
  // small (a single chain of fluent calls, no intervening other .from()) or
  // we'd cross-attribute columns from one query to another table in the same file.
  const selChain = /\.from\(\s*['"`]([\w_]+)['"`]\s*\)((?:(?!\.from\()[\s\S]){0,200}?)\.select\(\s*['"`]([^'"`]+)['"`]/g

  for (const f of srcFiles) {
    const txt = await fs.readFile(f, 'utf8')
    fromRe.lastIndex = 0
    let r
    while ((r = fromRe.exec(txt)) !== null) {
      const t = r[1].toLowerCase()
      if (!tableRefs.has(t)) tableRefs.set(t, new Set())
      tableRefs.get(t).add(path.relative(ROOT, f))
    }
    selChain.lastIndex = 0
    while ((r = selChain.exec(txt)) !== null) {
      const t = r[1].toLowerCase()
      // Strip out any join syntax — alias:table(col1, col2) or table(col1, col2)
      // Repeat until no parens remain. The columns inside the parens belong to
      // the joined table, not the outer FROM table.
      let raw = r[3]
      let prev
      do {
        prev = raw
        // Strip out any "[alias:]tableName ( col1, col2, ... )" join expression.
        // Allow whitespace before the parens (Supabase tolerates it).
        raw = raw.replace(/[\w!]*[\w]\s*\([^()]*\)/g, '')
      } while (raw !== prev)
      const cols = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      if (!columnRefs.has(t)) columnRefs.set(t, new Map())
      const m2 = columnRefs.get(t)
      for (const c of cols) {
        if (c === '*' || c.startsWith('!')) continue
        if (c.includes(':')) continue  // alias syntax remnant
        if (!m2.has(c)) m2.set(c, new Set())
        m2.get(c).add(path.relative(ROOT, f))
      }
    }
  }

  // Compare — tables
  for (const [t, files] of tableRefs) {
    if (!tables.has(t)) {
      findings.push({
        severity: 'CRITICAL',
        area: 'db-schema',
        title: `Table "${t}" referenced in code but missing from supabase-schema.sql`,
        evidence: `Referenced in: ${[...files].slice(0, 5).join(', ')}${files.size > 5 ? ` (+${files.size - 5} more)` : ''}`,
        impact: `Production query against "${t}" returns PGRST205 (table not found). Any endpoint/handler touching it → 500.`,
        suggestedFix: `Either add CREATE TABLE ${t} (...) to supabase-schema.sql with the columns the code expects, or rename the .from('${t}') call to the actual table name.`,
      })
    }
  }

  // Filter the column refs more carefully — skip Supabase relational
  // select expressions like "staff:staff_id(name)" which look like cols but
  // are joins. Also skip column names that are clearly aliased or contain
  // parens / colons / spaces.
  for (const [t, colsMap] of columnRefs) {
    if (!tables.has(t)) continue
    const knownCols = new Set(columnsByTable[t] || [])
    for (const [c, files] of colsMap) {
      if (!c) continue
      if (c.includes(':') || c.includes('(') || c.includes(')') || c.includes(' ')) continue  // join syntax
      if (c.includes('!')) continue  // hint syntax
      if (knownCols.has(c)) continue
      // Heuristic: if the colname looks like a table (we know about it as a
      // table) the user is doing a relational join — skip.
      if (tables.has(c)) continue
      // Common false positives from join targets
      if (['staff', 'shifts', 'staff_dms'].includes(c)) continue
      findings.push({
        severity: 'HIGH',
        area: 'db-schema',
        title: `Column ${t}.${c} referenced in code but not declared in supabase-schema.sql`,
        evidence: `Referenced in: ${[...files].slice(0, 3).join(', ')}`,
        impact: `If column truly missing in production: SELECT returns PGRST204 (column not found) and route 500s. If column exists but was added via an out-of-band migration: docs are stale; replicating the schema in a new Supabase project will break this feature.`,
        suggestedFix: `Verify the column exists in production Supabase. If yes, add it to supabase-schema.sql so a fresh deploy works. If no, fix the code.`,
      })
    }
  }

  return { findings, stats: { schemaTableCount: tables.size, codeTableRefs: tableRefs.size } }
}
