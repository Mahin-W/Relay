// Exhaustive edge-case diagnostic — run with: node src/tests/unit/preFilter-exhaustive.js
// NOT a node:test file — just prints pass/fail counts and every mismatch.
import { shouldSkip } from '../../preFilter.js'

// [text, expectedSkip, reason]
const cases = [

  // ── SINGLE LETTERS ────────────────────────────────────────────────────────
  // Standalone single letters are too sparse to skip — let LLM decide
  ['a', false, 'single letter'],
  ['b', false, 'single letter'],
  ['c', false, 'single letter'],
  ['d', false, 'single letter'],
  ['e', false, 'single letter'],
  ['f', false, 'single letter'],
  ['g', false, 'single letter'],
  ['h', false, 'single letter'],
  ['i', false, 'single letter'],
  ['j', false, 'single letter'],
  ['k', false, 'ok shorthand — confirmation'],
  ['l', false, 'single letter'],
  ['m', false, 'single letter'],
  ['n', false, '"no" shorthand — decline'],
  ['o', false, 'single letter'],
  ['p', false, 'single letter'],
  ['q', false, 'single letter'],
  ['r', false, 'single letter'],
  ['s', false, 'single letter'],
  ['t', false, 'single letter'],
  ['u', false, 'single letter'],
  ['v', false, 'single letter'],
  ['w', false, 'single letter'],
  ['x', false, 'single letter'],
  ['y', false, '"yes" / "why" shorthand'],
  ['z', false, 'single letter'],

  // ── 2-LETTER: CONFIRMATIONS ───────────────────────────────────────────────
  ['ok', false, 'okay — confirmation'],
  ['kk', false, 'ok ok — confirmation'],
  ['ye', false, 'yes — already trigger'],
  ['ya', false, 'yes — already trigger'],
  ['fs', false, 'for sure — strong confirmation'],
  ['np', false, 'no problem — confirmation/ack'],
  ['nw', false, 'no worries — ack'],
  ['ig', false, 'I guess — soft yes'],
  ['mb', false, 'my bad — ack/apology'],
  ['ty', false, 'thank you — ack'],
  ['rn', false, 'right now — time signal'],
  ['yh', false, 'yeah — yes variant'],
  ['eh', false, 'uncertain — soft yes/no signal'],

  // ── 2-LETTER: SHIFT-RELEVANT ──────────────────────────────────────────────
  ['on', false, '"I\'m on it" — shift action'],
  ['up', false, '"I\'m up for it" — availability'],
  ['go', false, '"I\'ll go" / cover signal'],
  ['in', false, 'already trigger'],
  ['na', false, 'already trigger'],
  ['no', false, 'already trigger'],
  ['nm', false, 'never mind — could cancel coverage'],
  ['hm', false, 'thinking — clarification hint'],

  // ── 2-LETTER: SKIP (greetings / reactions) ────────────────────────────────
  ['hi', true,  'greeting — not actionable alone'],
  ['yo', true,  'greeting — not actionable alone'],
  ['ew', true,  'disgust reaction — not shift-related'],
  ['aw', true,  'sympathy noise — not actionable'],
  ['oi', true,  'exclamation — not actionable'],
  ['gg', true,  'gaming slang — already filler'],

  // ── 3-LETTER: YES / CONFIRMATIONS ────────────────────────────────────────
  ['yes', false, 'already trigger'],
  ['yep', false, 'already trigger'],
  ['yup', false, 'already trigger'],
  ['yea', false, 'already trigger'],
  ['yah', false, 'yes variant'],
  ['aye', false, 'yes (formal/nautical)'],
  ['mhm', false, 'mmhm — affirmative'],
  ['ofc', false, 'of course — strong yes'],
  ['bet', false, 'slang yes/confirmation'],
  ['nod', false, 'agreement gesture'],
  ['igu', false, 'I got you — confirmation'],
  ['def', false, 'definitely — strong yes'],

  // ── 3-LETTER: NO / DECLINES ──────────────────────────────────────────────
  ['nah', false, 'already trigger'],
  ['naw', false, 'no variant — decline'],
  ['nay', false, 'no — formal decline'],
  ['nvm', false, 'never mind — could cancel coverage'],
  ['not', false, '"not me" — soft decline context'],
  ['neg', false, 'negative — decline signal'],

  // ── 3-LETTER: QUESTIONS / CLARIFICATIONS ─────────────────────────────────
  ['huh', false, 'confusion — asks for clarification'],
  ['hmm', false, 'thinking/unsure — shift-relevant'],
  ['wut', false, 'what — clarification request'],
  ['wat', false, 'what — clarification request'],
  ['why', false, 'question about shift'],
  ['who', false, 'asking who covers'],
  ['how', false, 'asking how shift works'],
  ['idk', false, 'I don\'t know — uncertain about shift'],
  ['lmk', false, 'let me know — about shift'],
  ['hm?', false, 'thinking question'],

  // ── 3-LETTER: AVAILABILITY / DEPARTURE ───────────────────────────────────
  ['omw', false, 'already trigger'],
  ['otw', false, 'already trigger'],
  ['brb', false, 'be right back — availability signal'],
  ['gtg', false, 'gotta go — departure signal'],
  ['afk', false, 'away from keyboard — availability'],
  ['bye', false, 'leaving — could signal end of shift'],
  ['cya', false, 'see ya — departure signal'],
  ['eta', false, 'arrival time — shift timing signal'],
  ['off', false, '"day off" or "I\'m off" — shift status'],
  ['out', false, 'already trigger'],
  ['irl', false, '"in real life" — context for covering'],

  // ── 3-LETTER: SHIFT ACTIONS ───────────────────────────────────────────────
  ['in',   false, 'already trigger'],
  ['cut',  false, '"my shift was cut" — shift status'],
  ['run',  false, '"I\'ll run this shift" — action'],
  ['sub',  false, '"I\'ll sub" — substitution offer'],
  ['due',  false, '"my shift is due" — shift timing'],
  ['end',  false, '"shift end" — timing signal'],
  ['add',  false, '"add me" to a shift — action'],
  ['ask',  false, 'asking about coverage'],
  ['got',  false, '"I got it" — taking shift'],

  // ── 3-LETTER: ACKNOWLEDGMENTS ────────────────────────────────────────────
  ['thx', false, 'thanks — acknowledging coverage'],
  ['tnx', false, 'thanks variant'],
  ['tks', false, 'thanks variant'],
  ['kk',  false, 'ok ok — acknowledgment'],
  ['ack', false, 'acknowledged'],

  // ── 3-LETTER: SOFT REACTIONS (still shift-relevant context) ──────────────
  ['ugh', false, '"ugh I can\'t cover" — frustration signal'],
  ['meh', false, '"meh I guess I can cover" — reluctance signal'],
  ['yay', false, '"yay someone covered" — positive reaction'],
  ['boo', false, '"boo I can\'t make it" — disappointment signal'],
  ['wow', false, '"wow that\'s a lot of shifts" — reaction with context'],
  ['doh', false, '"doh I forgot" — could signal shift issue'],
  ['yikes', false, 'concern about shift — relevant'],

  // ── 3-LETTER: GREETINGS (skip — not actionable alone) ────────────────────
  ['hey', true,  'greeting only — not actionable alone'],
  ['sup', true,  'greeting only'],
  ['hola', true, 'greeting only'],

  // ── 3-LETTER: ADDRESS TERMS (skip) ───────────────────────────────────────
  ['bro', true, 'address term only'],
  ['sis', true, 'address term only'],
  ['fam', true, 'address term only'],
  ['bff', true, 'address term only'],
  ['bruh', true, 'already filler'],

  // ── 3-LETTER: EXCLAMATIONS (skip) ────────────────────────────────────────
  ['omg', true, 'exclamation — not actionable'],
  ['wtf', true, 'exclamation — not actionable'],
  ['duh', true, 'dismissive — not actionable'],
  ['eww', true, 'disgust — not shift-related'],
  ['ooh', true, 'reaction — not actionable'],
  ['aah', true, 'reaction — not actionable'],
  ['smh', true, 'already filler'],

  // ── 3-LETTER: META-COMMENTARY (skip) ─────────────────────────────────────
  ['tbh', true, 'to be honest — meta, not actionable'],
  ['ngl', true, 'not gonna lie — meta filler'],
  ['imo', true, 'in my opinion — meta, not actionable'],
  ['fyi', true, 'for your info — standalone filler'],
  ['btw', true, 'by the way — standalone filler'],
  ['tmi', true, 'too much info — filler'],
  ['nbd', true, 'no big deal — standalone filler'],
  ['idc', true, '"I don\'t care" — dismissal, not coverage action'],
  ['atm', true, 'at the moment — standalone filler'],
  ['rip', true, 'already filler'],

  // ── LAUGH VARIANTS ───────────────────────────────────────────────────────
  ['lol',       true, 'laugh'],
  ['loll',      true, 'laugh variant'],
  ['lollll',    true, 'laugh variant — already tested'],
  ['lmao',      true, 'laugh'],
  ['lmaoo',     true, 'laugh variant'],
  ['lmaooo',    true, 'laugh variant — already tested'],
  ['haha',      true, 'laugh'],
  ['hahaha',    true, 'laugh variant'],
  ['hahahahaha',true, 'laugh variant — already tested'],
  ['hehe',      true, 'laugh'],
  ['hehehe',    true, 'laugh variant'],
  ['lmfao',     true, 'laugh'],
  ['lmfaooo',   true, 'laugh variant'],
  ['rofl',      true, 'already filler'],
  ['hah',       true, 'laugh single'],
  ['lolol',     true, 'laugh variant'],
  ['hehheh',    true, 'laugh variant'],

  // ── PURE EMOJI (skip) ────────────────────────────────────────────────────
  ['🔥',         true, 'pure emoji reaction'],
  ['🔥🔥🔥',     true, 'pure emoji — already tested'],
  ['💀',         true, 'pure emoji — already tested'],
  ['👀',         true, 'pure emoji reaction'],
  ['😂',         true, 'laugh emoji'],
  ['🙏',         true, 'pure emoji'],
  ['😭',         true, 'pure emoji'],
  ['💯',         true, 'pure emoji'],
  ['🫡',         true, 'pure emoji'],
  ['👎',         true, 'pure emoji'],
  ['🤷',         true, 'pure emoji'],
  ['❓',         true, 'pure punctuation/emoji'],
  ['‼️',         true, 'pure emoji'],
  ['✅',         true, 'pure emoji'],
  ['❌',         true, 'pure emoji'],

  // ── EXISTING TRIGGERS (regression) ───────────────────────────────────────
  ['ye',       false, 'already trigger'],
  ['yea',      false, 'already trigger'],
  ['yeah',     false, 'already trigger'],
  ['yup',      false, 'already trigger'],
  ['ya',       false, 'already trigger'],
  ['nope',     false, 'already trigger'],
  ['nah',      false, 'already trigger'],
  ['na',       false, 'no thanks — already trigger'],
  ['no thanks',false, 'already trigger'],
  ["can't",    false, 'already trigger'],
  ["i'm in",   false, 'already trigger'],
  ["i'm out",  false, 'already trigger'],
  ['pass',     false, 'already trigger'],
  ['done',     false, 'already trigger'],
  ['here',     false, 'already trigger'],
  ['wdym',     false, 'already trigger'],

  // ── CASE INSENSITIVITY ────────────────────────────────────────────────────
  ['OK',     false, 'uppercase ok'],
  ['Nah',    false, 'mixed-case trigger'],
  ['YEAH',   false, 'uppercase trigger'],
  ['LOL',    true,  'uppercase laugh'],
  ['LMAO',   true,  'uppercase laugh'],
  ['OMG',    true,  'uppercase filler'],
  ['BRO',    true,  'uppercase filler'],
  ['HEY',    true,  'uppercase greeting'],

  // ── WHITESPACE VARIANTS ───────────────────────────────────────────────────
  [' ok',       false, 'leading space'],
  ['ok ',       false, 'trailing space'],
  [' yes ',     false, 'padded trigger'],
  ['  lol  ',   true,  'padded laugh'],
  ['',           true, 'empty string — always skip'],

  // ── PUNCTUATION-AUGMENTED CONFIRMATIONS ───────────────────────────────────
  ['k!',    false, 'k with punctuation — confirmation'],
  ['ok!',   false, 'ok with punctuation'],
  ['yes!',  false, 'yes with exclamation'],
  ['no!',   false, 'no with exclamation'],
  ['nah.',  false, 'nah with period'],
  ['yep!',  false, 'yep with exclamation'],
  ["i'm in!", false, "i'm in with exclamation"],

  // ── COMMON WORKPLACE PHRASES ──────────────────────────────────────────────
  ['asap',  false, 'as soon as possible — timing signal'],
  ['late',  false, '"running late" — arrival signal'],
  ['sick',  false, '"calling in sick" — coverage trigger'],
  ['sure',  false, 'sure — confirmation'],
  ['fine',  false, '"fine I\'ll cover" — reluctant yes'],
  ['omit',  false, 'omit from schedule — shift action'],
  ['swap',  false, 'shift swap — trade signal'],
  ['open',  false, '"open shift" — shift availability'],
  ['free',  false, '"I\'m free" — availability signal'],
  ['busy',  false, '"I\'m busy" — unavailability signal'],
  ['need',  false, '"need coverage" — request signal'],
  ['help',  false, '"need help" — coverage signal'],
  ['full',  false, '"shift is full" — status signal'],

  // ── NUMBERS AND TIMES ─────────────────────────────────────────────────────
  ['5pm',   false, 'shift time — relevant'],
  ['8am',   false, 'shift time — relevant'],
  ['6',     false, 'could be shift number or time'],
  ['10',    false, 'could be time'],
  ['12',    false, 'could be noon'],

  // ── ALREADY HANDLED FILLERS (regression) ─────────────────────────────────
  ['gg',       true, 'already filler'],
  ['pls',      true, 'already filler'],
  ['fr',       true, 'already filler'],
  ['fr though',true, 'already filler'],
  ['smh',      true, 'already filler'],
  ['bruh',     true, 'already filler'],

  // ── MISC SLANG ────────────────────────────────────────────────────────────
  ['lit',    false, '"shift is lit" — could be shift-related'],
  ['cap',    false, '"no cap I can cover" — context matters'],
  ['npc',    true,  'gaming term — not shift-related'],
  ['vip',    false, 'could refer to VIP shift — relevant context'],
  ['pro',    false, '"I\'m a pro" — self-description, let LLM handle'],
  ['noob',   false, 'could be shift-related context'],
  ['irl',    false, '"in real life I can cover" — context'],
  ['tbf',    true,  'to be fair — standalone meta filler'],
  ['imo',    true,  'in my opinion — standalone meta filler'],
  ['ffs',    false, 'frustration — could be about shift (let LLM handle)'],
  ['smh',    true,  'already filler'],
  ['nvm',    false, 'never mind — could cancel coverage'],

  // ── SHIFT WORKER SLANG ────────────────────────────────────────────────────
  ['on it',  false, '"I\'m on it" — taking responsibility'],
  ['on me',  false, '"I\'ll cover" — volunteering'],
  ['my bad', false, '"my bad I need coverage" — relevant'],
  ['no way', false, '"no way I can cover" — strong decline'],
  ['for sure', false, '"for sure I\'ll cover" — confirmation'],
  ['all good', false, '"all good I found coverage" — status update'],
  ['not me', false, '"not me for this shift" — clear decline'],
  ['i got',  false, '"I got this shift" — volunteering'],
  ['i can',  false, '"I can cover" — availability'],
  ['i will', false, '"I will cover" — commitment'],
]

let pass = 0, fail = 0
const failures = []

for (const [text, expectedSkip, reason] of cases) {
  const actual = shouldSkip(text)
  if (actual === expectedSkip) {
    pass++
  } else {
    fail++
    failures.push({ text, expectedSkip, actual, reason })
  }
}

const total = pass + fail
console.log(`\n${'─'.repeat(60)}`)
console.log(`  preFilter exhaustive audit: ${total} cases`)
console.log(`  ✔ pass ${pass}   ✘ fail ${fail}`)
console.log(`${'─'.repeat(60)}`)

if (failures.length) {
  console.log('\nMISMATCHES:\n')
  for (const { text, expectedSkip, actual, reason } of failures) {
    const expected = expectedSkip ? 'SKIP' : 'pass'
    const got      = actual      ? 'SKIP' : 'pass'
    console.log(`  "${text}" → expected ${expected}, got ${got}`)
    console.log(`    reason: ${reason}\n`)
  }
} else {
  console.log('\n  All cases match expected behaviour.\n')
}
