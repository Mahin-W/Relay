import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkip } from '../../preFilter.js'

// ── SINGLE LETTERS ────────────────────────────────────────────────────────────
describe('single letters', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    test(`shouldSkip("${letter}") is false`, () => {
      assert.strictEqual(shouldSkip(letter), false)
    })
  }
})

// ── 2-LETTER: CONFIRMATIONS ──────────────────────────────────────────────────
describe('2-letter confirmations', () => {
  const cases = [
    ['ok',  false],
    ['kk',  false],
    ['ye',  false],
    ['ya',  false],
    ['fs',  false],
    ['np',  false],
    ['nw',  false],
    ['ig',  false],
    ['mb',  false],
    ['ty',  false],
    ['rn',  false],
    ['yh',  false],
    ['eh',  false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 2-LETTER: SHIFT-RELEVANT ─────────────────────────────────────────────────
describe('2-letter shift-relevant', () => {
  const cases = [
    ['on', false],
    ['up', false],
    ['go', false],
    ['in', false],
    ['na', false],
    ['no', false],
    ['nm', false],
    ['hm', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 2-LETTER: SKIP (greetings / reactions) ────────────────────────────────────
describe('2-letter skip (greetings/reactions)', () => {
  const cases = [
    ['hi', true],
    ['yo', true],
    ['ew', true],
    ['aw', true],
    ['oi', true],
    ['gg', true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: YES / CONFIRMATIONS ────────────────────────────────────────────
describe('3-letter yes/confirmations', () => {
  const cases = [
    ['yes', false],
    ['yep', false],
    ['yup', false],
    ['yea', false],
    ['yah', false],
    ['aye', false],
    ['mhm', false],
    ['ofc', false],
    ['bet', false],
    ['nod', false],
    ['igu', false],
    ['def', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: NO / DECLINES ──────────────────────────────────────────────────
describe('3-letter no/declines', () => {
  const cases = [
    ['nah', false],
    ['naw', false],
    ['nay', false],
    ['nvm', false],
    ['not', false],
    ['neg', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: QUESTIONS / CLARIFICATIONS ─────────────────────────────────────
describe('3-letter questions/clarifications', () => {
  const cases = [
    ['huh', false],
    ['hmm', false],
    ['wut', false],
    ['wat', false],
    ['why', false],
    ['who', false],
    ['how', false],
    ['idk', false],
    ['lmk', false],
    ['hm?', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: AVAILABILITY / DEPARTURE ───────────────────────────────────────
describe('3-letter availability/departure', () => {
  const cases = [
    ['omw', false],
    ['otw', false],
    ['brb', false],
    ['gtg', false],
    ['afk', false],
    ['bye', false],
    ['cya', false],
    ['eta', false],
    ['off', false],
    ['out', false],
    ['irl', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: SHIFT ACTIONS ───────────────────────────────────────────────────
describe('3-letter shift actions', () => {
  const cases = [
    ['in',  false],
    ['cut', false],
    ['run', false],
    ['sub', false],
    ['due', false],
    ['end', false],
    ['add', false],
    ['ask', false],
    ['got', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: ACKNOWLEDGMENTS ────────────────────────────────────────────────
describe('3-letter acknowledgments', () => {
  const cases = [
    ['thx', false],
    ['tnx', false],
    ['tks', false],
    ['kk',  false],
    ['ack', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── 3-LETTER: SOFT REACTIONS (still shift-relevant context) ──────────────────
describe('3-letter soft reactions (shift-relevant)', () => {
  const cases = [
    ['ugh',   false],
    ['meh',   false],
    ['yay',   false],
    ['boo',   false],
    ['wow',   false],
    ['doh',   false],
    ['yikes', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── GREETINGS (skip) ──────────────────────────────────────────────────────────
describe('greetings (skip)', () => {
  const cases = [
    ['hey',  true],
    ['sup',  true],
    ['hola', true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── ADDRESS TERMS (skip) ─────────────────────────────────────────────────────
describe('address terms (skip)', () => {
  const cases = [
    ['bro',  true],
    ['sis',  true],
    ['fam',  true],
    ['bff',  true],
    ['bruh', true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── EXCLAMATIONS (skip) ───────────────────────────────────────────────────────
describe('exclamations (skip)', () => {
  const cases = [
    ['omg', true],
    ['wtf', true],
    ['duh', true],
    ['eww', true],
    ['ooh', true],
    ['aah', true],
    ['smh', true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── META-COMMENTARY (skip) ────────────────────────────────────────────────────
describe('meta-commentary (skip)', () => {
  const cases = [
    ['tbh', true],
    ['ngl', true],
    ['imo', true],
    ['fyi', true],
    ['btw', true],
    ['tmi', true],
    ['nbd', true],
    ['idc', true],
    ['atm', true],
    ['rip', true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── LAUGH VARIANTS ────────────────────────────────────────────────────────────
describe('laugh variants', () => {
  const cases = [
    ['lol',        true],
    ['loll',       true],
    ['lollll',     true],
    ['lmao',       true],
    ['lmaoo',      true],
    ['lmaooo',     true],
    ['haha',       true],
    ['hahaha',     true],
    ['hahahahaha', true],
    ['hehe',       true],
    ['hehehe',     true],
    ['lmfao',      true],
    ['lmfaooo',    true],
    ['rofl',       true],
    ['hah',        true],
    ['lolol',      true],
    ['hehheh',     true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── PURE EMOJI (skip) ─────────────────────────────────────────────────────────
// Note: ✅ is in TRIGGERS (confirmation emoji) so it is NOT skipped.
describe('pure emoji reactions (skip)', () => {
  const cases = [
    ['🔥',     true],
    ['🔥🔥🔥', true],
    ['💀',     true],
    ['👀',     true],
    ['😂',     true],
    ['🙏',     true],
    ['😭',     true],
    ['💯',     true],
    ['🫡',     true],
    ['👎',     true],
    ['🤷',     true],
    ['❓',     true],
    ['‼️',     true],
    // ✅ is a confirmation trigger — must NOT be skipped
    ['✅',     false],
    ['❌',     true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── EXISTING TRIGGERS (regression) ───────────────────────────────────────────
describe('existing triggers (regression)', () => {
  const cases = [
    ['ye',       false],
    ['yea',      false],
    ['yeah',     false],
    ['yup',      false],
    ['ya',       false],
    ['nope',     false],
    ['nah',      false],
    ['na',       false],
    ['no thanks',false],
    ["can't",    false],
    ["i'm in",   false],
    ["i'm out",  false],
    ['pass',     false],
    ['done',     false],
    ['here',     false],
    ['wdym',     false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── CASE INSENSITIVITY ────────────────────────────────────────────────────────
describe('case insensitivity', () => {
  const cases = [
    ['OK',   false],
    ['Nah',  false],
    ['YEAH', false],
    ['LOL',  true],
    ['LMAO', true],
    ['OMG',  true],
    ['BRO',  true],
    ['HEY',  true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── WHITESPACE VARIANTS ───────────────────────────────────────────────────────
describe('whitespace variants', () => {
  const cases = [
    [' ok',     false],
    ['ok ',     false],
    [' yes ',   false],
    ['  lol  ', true],
    ['',         true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip(${JSON.stringify(input)}) is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── PUNCTUATION-AUGMENTED CONFIRMATIONS ──────────────────────────────────────
describe('punctuation-augmented confirmations', () => {
  const cases = [
    ['k!',      false],
    ['ok!',     false],
    ['yes!',    false],
    ['no!',     false],
    ['nah.',    false],
    ['yep!',    false],
    ["i'm in!", false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── COMMON WORKPLACE PHRASES ──────────────────────────────────────────────────
describe('common workplace phrases', () => {
  const cases = [
    ['asap', false],
    ['late', false],
    ['sick', false],
    ['sure', false],
    ['fine', false],
    ['omit', false],
    ['swap', false],
    ['open', false],
    ['free', false],
    ['busy', false],
    ['need', false],
    ['help', false],
    ['full', false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── NUMBERS AND TIMES ─────────────────────────────────────────────────────────
describe('numbers and times', () => {
  const cases = [
    ['5pm', false],
    ['8am', false],
    ['6',   false],
    ['10',  false],
    ['12',  false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── ALREADY HANDLED FILLERS (regression) ─────────────────────────────────────
describe('already handled fillers (regression)', () => {
  const cases = [
    ['gg',        true],
    ['pls',       true],
    ['fr',        true],
    ['fr though', true],
    ['smh',       true],
    ['bruh',      true],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── MISC SLANG ────────────────────────────────────────────────────────────────
describe('misc slang', () => {
  const cases = [
    ['lit',  false],
    ['cap',  false],
    ['npc',  true],
    ['vip',  false],
    ['pro',  false],
    ['noob', false],
    ['irl',  false],
    ['tbf',  true],
    ['imo',  true],
    ['ffs',  false],
    ['smh',  true],
    ['nvm',  false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})

// ── SHIFT WORKER SLANG ────────────────────────────────────────────────────────
describe('shift worker slang', () => {
  const cases = [
    ['on it',   false],
    ['on me',   false],
    ['my bad',  false],
    ['no way',  false],
    ['for sure',false],
    ['all good',false],
    ['not me',  false],
    ['i got',   false],
    ['i can',   false],
    ['i will',  false],
  ]
  for (const [input, expected] of cases) {
    test(`shouldSkip("${input}") is ${expected}`, () => {
      assert.strictEqual(shouldSkip(input), expected)
    })
  }
})
