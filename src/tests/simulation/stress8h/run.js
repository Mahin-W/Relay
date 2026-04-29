#!/usr/bin/env node
// Master orchestrator — runs every stress phase, aggregates findings,
// writes BUG_REPORT.md.

import fs from 'node:fs/promises'
import path from 'node:path'

import { runSchemaAudit } from './schemaAudit.js'
import { runFeatureStress } from './featureStress.js'
import { runConcurrencyStress } from './concurrencyStress.js'
import { runChatRouterStress } from './chatRouterStress.js'
import { runCommandStress } from './commandStress.js'
import { runDashApiStress } from './dashApiStress.js'
import { runExpandedSixMonth } from './expandedSixMonth.js'

const REPORT_PATH = path.join(process.cwd(), 'BUG_REPORT.md')

async function main() {
  const startedAt = Date.now()
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('  RELAY — 8-HOUR RESTAURANT STRESS TEST')
  console.log('  Goal: stress every chat command, dashboard route, smart feature,')
  console.log('  and DB pathway — find what breaks.')
  console.log('═══════════════════════════════════════════════════════════════════\n')

  const allFindings = []
  const phases = [
    { name: 'Schema Audit',         fn: runSchemaAudit },
    { name: 'Feature Stress',       fn: runFeatureStress },
    { name: 'Command Stress',       fn: runCommandStress },
    { name: 'Concurrency Stress',   fn: runConcurrencyStress },
    { name: 'Chat Router Stress',   fn: runChatRouterStress },
    { name: 'Dashboard API Stress', fn: runDashApiStress },
    { name: 'Expanded 6-Month Sim', fn: runExpandedSixMonth },
  ]

  const phaseResults = {}
  for (const phase of phases) {
    process.stdout.write(`▸ ${phase.name.padEnd(28)}…  `)
    const t0 = Date.now()
    try {
      const r = await phase.fn()
      const ms = Date.now() - t0
      console.log(`done in ${(ms / 1000).toFixed(1)}s — ${r.findings.length} findings`)
      phaseResults[phase.name] = r
      for (const f of r.findings) allFindings.push({ ...f, phase: phase.name })
    } catch (err) {
      const ms = Date.now() - t0
      console.log(`THREW after ${(ms / 1000).toFixed(1)}s`)
      console.error(`  ${err.message}\n  ${err.stack?.split('\n').slice(1, 4).join('\n  ')}`)
      phaseResults[phase.name] = { findings: [], stats: {}, error: err.message }
      allFindings.push({
        phase: phase.name,
        severity: 'CRITICAL',
        area: 'harness',
        title: `${phase.name} harness threw`,
        evidence: err.stack?.split('\n').slice(0, 5).join('\n'),
      })
    }
  }

  const totalMs = Date.now() - startedAt
  console.log(`\n  Total runtime: ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`  Total findings: ${allFindings.length}\n`)

  // Build report
  await writeReport(allFindings, phaseResults, totalMs)

  console.log(`\n📄 Report written to: ${REPORT_PATH}`)

  // Exit cleanly even with findings
  process.exit(0)
}

async function writeReport(findings, phaseResults, totalMs) {
  const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] }
  for (const f of findings) {
    const sev = (f.severity || 'LOW').toUpperCase()
    if (bySev[sev]) bySev[sev].push(f)
    else bySev.LOW.push(f)
  }
  // Group by area within severity
  const byArea = {}
  for (const f of findings) {
    if (!byArea[f.area || 'misc']) byArea[f.area || 'misc'] = []
    byArea[f.area || 'misc'].push(f)
  }

  const lines = []
  lines.push('# Relay — 8-Hour Stress Test Bug Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Runtime: ${(totalMs / 1000).toFixed(1)}s`)
  lines.push(`Total findings: ${findings.length} (` +
    `${bySev.CRITICAL.length} critical, ` +
    `${bySev.HIGH.length} high, ` +
    `${bySev.MEDIUM.length} medium, ` +
    `${bySev.LOW.length} low)`)
  lines.push('')
  lines.push('## Phase Summary')
  lines.push('')
  lines.push('| Phase | Findings | Stats |')
  lines.push('|---|---|---|')
  for (const [name, r] of Object.entries(phaseResults)) {
    const statsStr = Object.entries(r.stats || {}).map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 200)
    lines.push(`| ${name} | ${r.findings?.length ?? 0}${r.error ? ' (HARNESS THREW)' : ''} | ${statsStr || '—'} |`)
  }
  lines.push('')

  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const items = bySev[sev]
    if (items.length === 0) continue
    lines.push(`## ${sev} (${items.length})`)
    lines.push('')
    let n = 0
    for (const f of items) {
      n++
      lines.push(`### ${sev}-${n}. ${f.title}`)
      lines.push('')
      lines.push(`- **Phase**: ${f.phase ?? '?'}`)
      lines.push(`- **Area**: ${f.area ?? '?'}`)
      if (f.evidence) {
        lines.push('- **Evidence**:')
        lines.push('')
        lines.push('```')
        lines.push(String(f.evidence).slice(0, 1200))
        lines.push('```')
        lines.push('')
      }
      if (f.repro) lines.push(`- **Repro**: \`${f.repro}\``)
      if (f.impact) lines.push(`- **Impact**: ${f.impact}`)
      if (f.suggestedFix) lines.push(`- **Suggested fix**: ${f.suggestedFix}`)
      lines.push('')
    }
  }

  lines.push('## Findings By Area')
  lines.push('')
  for (const area of Object.keys(byArea).sort()) {
    lines.push(`- **${area}**: ${byArea[area].length}`)
  }
  lines.push('')

  await fs.writeFile(REPORT_PATH, lines.join('\n'))
}

main().catch(err => {
  console.error('FATAL:', err.message)
  console.error(err.stack)
  process.exit(2)
})
