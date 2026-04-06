import 'dotenv/config'
import { parseMessage } from './parseMessage.js'

const tests = [
  { text: "hey can anyone cover my Saturday lunch shift", sender: "Mike", expected: "coverage_request" },
  { text: "I can cover that no problem", sender: "Sarah", expected: "coverage_confirmation" },
  { text: "what time does service start tomorrow", sender: "Jake", expected: "irrelevant" },
  { text: "👍", sender: "Tom", expected: "irrelevant" },
  { text: "I need someone for Friday 6pm to close, family emergency", sender: "Lisa", expected: "coverage_request" },
  { text: "I'll take it", sender: "Carlos", expected: "coverage_confirmation" },
  { text: "calling in sick for tomorrow morning", sender: "Emma", expected: "coverage_request" },
  { text: "hey everyone don't forget we have a staff meeting Monday", sender: "Manager", expected: "irrelevant" },
]

let passed = 0

for (const test of tests) {
  const intent = await parseMessage(test.text, test.sender, 'Test Restaurant')
  const ok = intent.type === test.expected
  if (ok) passed++

  console.log(ok ? '✅ PASS' : '❌ FAIL')
  console.log(`  Input:    "${test.text}" (from ${test.sender})`)
  console.log(`  Expected: ${test.expected}`)
  console.log(`  Got:      ${JSON.stringify(intent)}`)
  console.log('─'.repeat(60))
}

console.log(`\n${passed}/8 tests passed`)
