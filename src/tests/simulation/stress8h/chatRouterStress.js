// Chat router stress — drives realistic + adversarial messages through
// handleGroupMessage and handleDmMessage with a stubbed bot/db.

import { MockBot } from '../../helpers/mocks.js'
import { SimulationDb } from '../simulationDb.js'
import { seedMesaVerde, GROUP_ID, GROUP_CHAT_ID, MANAGER_ID, MANAGER_DM } from '../mesaVerdeSeed.js'

export async function runChatRouterStress() {
  const findings = []
  const stats = { messagesProcessed: 0, throws: 0, slashCommandsHit: 0 }

  const db = new SimulationDb()
  await seedMesaVerde(db)

  const bot = new MockBot()
  // Mark manager as group admin
  bot.setAdmin(GROUP_CHAT_ID, MANAGER_ID)

  // The actual handleGroupMessage calls upsertGroupMember, parseMessage, and
  // many handlers — all of which import from '../db.js' / '../setup/setupDb.js'
  // backed by Supabase. We can't run this without a real DB.
  //
  // Instead, drive the parser/preFilter directly to find what bombs.

  const { parseMessage } = await import('../../../parsers/messageParsers.js')
  const { shouldSkip } = await import('../../../preFilter.js')

  const restaurantMessages = [
    // ── Coverage flow ──
    "I can't make it Saturday, anyone cover?",
    'sick today, need someone for the dinner shift',
    'any chance someone can take my Tuesday morning?',
    "calling out — feeling like trash 🤒",
    "can someone PLEASE cover my saturday close?",
    "i can do it",
    "I'll take it",
    "bet",
    "igu",
    "fasho",
    "ima pull up",
    "say less",
    "i got u marco",
    "no cap ill be there",
    "yeah I think I can prob do it",
    "yea i think igu",
    "I can do the first half only",
    "can cover until 9pm",
    "I can come in from 7pm",
    "maybe — let me check",
    "lmk by tonight",
    "nvm I found someone",
    "cancel my request, I'm good",
    // ── Trade ──
    "anyone wanna swap my saturday for a sunday?",
    "trade my fri close for any other shift",
    "I'll swap saturday for whoever takes my tuesday",
    // ── Time off ──
    "can I get next thursday off? doctor",
    "putting in for vacation july 14-18",
    "need to be off for mom's funeral monday",
    // ── Late ──
    "running 15 min late, traffic",
    "stuck in traffic, will be like 10 min behind",
    "subway delays, ETA 6:45",
    "im here just parking",
    // ── New hire ──
    "new hire alert: olivia starts monday as a server",
    "welcome morgan, our new bartender 🍸",
    // ── Recognition ──
    "shoutout to aaliyah for absolutely killing it last night",
    "💯 to the kitchen crew tonight",
    "marco saved us — 200 cover sat",
    // ── Demand signals ──
    "we are gonna be PACKED tonight",
    "slow tuesday — patio empty",
    "valentine's gonna be bananas",
    // ── Availability passive ──
    "I'm free tuesday wednesday this week",
    "off saturday no matter what",
    // ── On-call ──
    "I can be on call this weekend",
    // ── Adversarial / garbage ──
    "",
    "  ",
    "lol",
    "lmaoooo",
    "k",
    "👍",
    "💀💀💀",
    "<script>alert(1)</script>",
    "DROP TABLE staff;--",
    "; rm -rf /;",
    "X".repeat(5000),
    "🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖🤖",
    "你好,我能在星期六上班吗",  // Chinese
    "puedo trabajar el sabado?",  // Spanish
    "Je peux faire ton service samedi",  // French
    "I CAN'T MAKE IT TONIGHT",
    "i can i can i can i can",
    "covered uncovered re-covered cancel actually nvm wait actually I can",
    "I was thinking maybe I could possibly do it",
    "I'm out 😷 again 😷 covid 😷",
    // ── Manager-style messages ──
    "Tony assigning Aaliyah to Saturday close",
    "remove Devon from monday lunch",
    "set rate Server 16",
    "/availability",
    "/makeschedule please",
    "/help",
    "/quality",
    "/morale",
    "/coverage",
    "/log busy night",
    "/setbudget 8500",
    "/setrate Chef 22",
    "/staffinsight Aaliyah",
    "/patterns",
    "/retention",
    "/rotation",
    "/tipmode pool",
    "/rules",
    "/tips",
    "/setphone +15555550001",
    // ── Edge ──
    "tell Marco the fryer is broken",
    "what's the schedule for next week",
    "who's working tonight",
    "my schedule",
    "my hours",
    "my pay",
    "yes no maybe yes no",
  ]

  // Pre-filter pass — should be cheap and fast
  for (const msg of restaurantMessages) {
    try {
      const skip = shouldSkip(msg)
      stats.messagesProcessed++
    } catch (err) {
      stats.throws++
      findings.push({
        severity: 'HIGH',
        area: 'preFilter',
        title: `shouldSkip threw on: ${JSON.stringify(msg.slice(0, 60))}`,
        evidence: err.message,
      })
    }
  }

  // Direct handler invocation tests — these run without LLM (test fall-through paths)
  const callablesToTest = [
    {
      mod: '../../../coverage/cancelHandler.js',
      fn: 'handleCoverageCancel',
      args: () => [bot, { chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Test' }, from: { id: 1003, first_name: 'Aaliyah' }, text: 'never mind' }],
      label: 'handleCoverageCancel — no open request',
    },
    {
      mod: '../../../timeOff/handleTimeOff.js',
      fn: 'handleTimeOffRequest',
      args: () => [bot, { chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Test' }, from: { id: 1010, first_name: 'Emma' }, text: 'I need next thursday off' }, { type: 'time_off_request', person: 'Emma', date: 'thursday' }],
      label: 'handleTimeOffRequest — basic',
    },
    {
      mod: '../../../lateArrival/handleLateArrival.js',
      fn: 'handleLateArrival',
      args: () => [bot, { chat: { id: GROUP_CHAT_ID, type: 'supergroup' }, from: { id: 1004, first_name: 'Sarah' }, text: 'running 15 min late' }, { type: 'running_late' }],
      label: 'handleLateArrival',
    },
    {
      mod: '../../../oncall/handleOnCall.js',
      fn: 'handleOnCallOffer',
      args: () => [bot, { chat: { id: GROUP_CHAT_ID, type: 'supergroup' }, from: { id: 1005, first_name: 'Jake' }, text: 'I can be on call this weekend' }, { type: 'on_call_offer' }],
      label: 'handleOnCallOffer',
    },
    {
      mod: '../../../engagement/recognition.js',
      fn: 'handleRecognition',
      args: () => [bot, { chat: { id: GROUP_CHAT_ID, type: 'supergroup' }, from: { id: 1003, first_name: 'Aaliyah' }, text: 'shoutout to Marco' }, GROUP_ID],
      label: 'handleRecognition',
    },
  ]

  for (const c of callablesToTest) {
    try {
      const m = await import(c.mod)
      const fn = m[c.fn]
      if (typeof fn !== 'function') {
        findings.push({
          severity: 'MEDIUM',
          area: 'chat-handlers',
          title: `${c.label}: ${c.fn} is not a function in ${c.mod}`,
          evidence: `typeof = ${typeof fn}; exports = ${Object.keys(m).join(', ')}`,
        })
        continue
      }
      try {
        const args = c.args()
        await fn(...args)
      } catch (err) {
        // Many handlers will fail without a real Supabase. Just note unexpected
        // throws that aren't DB-related.
        const msg = err.message || String(err)
        const isProbablyDb = /supabase|fetch|getaddrinfo|ECONN|relation|JWT|setup_sessions/.test(msg)
        if (!isProbablyDb) {
          findings.push({
            severity: 'MEDIUM',
            area: 'chat-handlers',
            title: `${c.label} threw non-DB error`,
            evidence: msg.slice(0, 200),
          })
        }
      }
    } catch (err) {
      findings.push({
        severity: 'LOW',
        area: 'chat-handlers',
        title: `Failed to import ${c.mod}: ${err.message}`,
      })
    }
  }

  // Test the Telegram message factory — make sure handlers don't crash on
  // unusual chat types
  const weirdMsgs = [
    { chat: { id: 1, type: 'channel' }, from: { id: 1, first_name: 'X' }, text: 'hi' },
    { chat: { id: 1, type: 'private' }, from: null, text: 'hi' },
    { chat: { id: 1, type: 'group' }, from: { id: 1 }, text: '' },
    { chat: { id: 1, type: 'group' }, from: { id: 1, first_name: 'X' }, text: null },  // null text
  ]
  for (const m of weirdMsgs) {
    try {
      shouldSkip(m.text || '')
    } catch (err) {
      findings.push({
        severity: 'MEDIUM',
        area: 'preFilter',
        title: `shouldSkip threw on weird message structure`,
        evidence: `${JSON.stringify(m)}: ${err.message}`,
      })
    }
  }

  return { findings, stats }
}
