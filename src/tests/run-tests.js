#!/usr/bin/env node
// Runs all test suites and reports a combined pass/fail summary.
// node:test outputs TAP; we collect "# pass N" and "# fail N" lines.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const UNIT = [
  'unit/availabilityParser.test.js',
  'unit/shiftMatcher.test.js',
  'unit/scheduleGenerator.test.js',
  'unit/botAdmins.test.js',
]

const UNIT_GROQ = [
  'unit/parseMessage.test.js',
]

const INTEGRATION = [
  'integration/coverageFlow.test.js',
  'integration/setupFlow.test.js',
  'integration/botAdminFlow.test.js',
]

const E2E = [
  'e2e/fullWeekFlow.test.js',
]

const ALL_FILES = [...UNIT, ...UNIT_GROQ, ...INTEGRATION, ...E2E]

function runFile(file) {
  return new Promise((resolve) => {
    const fullPath = path.join(__dirname, file)
    const proc = spawn(process.execPath, ['--env-file=.env', '--test', fullPath], { env: process.env, cwd: path.join(__dirname, '../..') })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', d => { stdout += d; process.stdout.write(d) })
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(d) })

    proc.on('close', (code) => {
      // Parse TAP summary lines
      const passMatch = stdout.match(/^# pass (\d+)/m)
      const failMatch = stdout.match(/^# fail (\d+)/m)
      resolve({
        file,
        pass: passMatch ? parseInt(passMatch[1]) : 0,
        fail: failMatch ? parseInt(failMatch[1]) : 0,
        code,
      })
    })
  })
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Relay Bot Test Suite')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const results = []
  for (const file of ALL_FILES) {
    results.push(await runFile(file))
  }

  const totalPass = results.reduce((s, r) => s + r.pass, 0)
  const totalFail = results.reduce((s, r) => s + r.fail, 0)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Results by file:')
  for (const r of results) {
    const status = r.fail === 0 ? '✅' : '❌'
    console.log(`  ${status} ${r.file}: ${r.pass} pass, ${r.fail} fail`)
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  Total: ${totalPass} pass, ${totalFail} fail`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  if (totalFail > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
