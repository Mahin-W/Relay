import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkip } from '../../preFilter.js'

test('preFilter edge cases', async (t) => {
  await Promise.all([
    // ── CASUAL CONFIRMATIONS — must NOT skip ────────────────────────────────
    t.test("'ye' → no skip (slang yes)", () => assert.equal(shouldSkip('ye'), false)),
    t.test("'yea' → no skip", () => assert.equal(shouldSkip('yea'), false)),
    t.test("'yeah' → no skip", () => assert.equal(shouldSkip('yeah'), false)),
    t.test("'yep' → no skip (removed from filler list)", () => assert.equal(shouldSkip('yep'), false)),
    t.test("'yup' → no skip", () => assert.equal(shouldSkip('yup'), false)),
    t.test("'ya' → no skip", () => assert.equal(shouldSkip('ya'), false)),
    t.test("'yes' → no skip", () => assert.equal(shouldSkip('yes'), false)),

    // ── CASUAL DECLINES — must NOT skip ─────────────────────────────────────
    t.test("'no' → no skip (declining coverage request)", () => assert.equal(shouldSkip('no'), false)),
    t.test("'nah' → no skip (removed from filler list)", () => assert.equal(shouldSkip('nah'), false)),
    t.test("'nope' → no skip (removed from filler list)", () => assert.equal(shouldSkip('nope'), false)),
    t.test("'na' → no skip", () => assert.equal(shouldSkip('na'), false)),
    t.test("'no thanks' → no skip", () => assert.equal(shouldSkip('no thanks'), false)),
    t.test("\"can't\" → no skip (caught by trigger word)", () => assert.equal(shouldSkip("can't"), false)),

    // ── AMBIGUOUS SHORT PHRASES — must NOT skip ──────────────────────────────
    t.test("\"I'm in\" → no skip (volunteering for shift)", () => assert.equal(shouldSkip("I'm in"), false)),
    t.test("\"I'm out\" → no skip (declining or calling out)", () => assert.equal(shouldSkip("I'm out"), false)),
    t.test("'in' → no skip (volunteering)", () => assert.equal(shouldSkip('in'), false)),
    t.test("'out' → no skip (calling out)", () => assert.equal(shouldSkip('out'), false)),
    t.test("'pass' → no skip (declining shift)", () => assert.equal(shouldSkip('pass'), false)),
    t.test("'done' → no skip (finished with shift)", () => assert.equal(shouldSkip('done'), false)),
    t.test("'here' → no skip (checking in)", () => assert.equal(shouldSkip('here'), false)),
    t.test("'omw' → no skip (on my way)", () => assert.equal(shouldSkip('omw'), false)),
    t.test("'otw' → no skip (on the way)", () => assert.equal(shouldSkip('otw'), false)),
    t.test("'wdym' → no skip (asking for clarification about a shift)", () => assert.equal(shouldSkip('wdym'), false)),

    // ── SHOULD STILL SKIP (truly irrelevant) ────────────────────────────────
    t.test("'lmaooo' → skip (laugh variant)", () => assert.equal(shouldSkip('lmaooo'), true)),
    t.test("'lollll' → skip (laugh variant)", () => assert.equal(shouldSkip('lollll'), true)),
    t.test("'hahahahaha' → skip (laugh variant)", () => assert.equal(shouldSkip('hahahahaha'), true)),
    t.test("'🔥🔥🔥' → skip (pure emoji reaction)", () => assert.equal(shouldSkip('🔥🔥🔥'), true)),
    t.test("'💀' → skip (pure emoji reaction)", () => assert.equal(shouldSkip('💀'), true)),
    t.test("'gg' → skip", () => assert.equal(shouldSkip('gg'), true)),
    t.test("'rip' → skip", () => assert.equal(shouldSkip('rip'), true)),
    t.test("'pls' → skip (alone, no context)", () => assert.equal(shouldSkip('pls'), true)),
    t.test("'fr though' → skip", () => assert.equal(shouldSkip('fr though'), true)),

    // ── CONFIRMATION EMOJIS — must NOT skip (valid group coverage confirmations) ──
    t.test("'👍' → no skip (confirmation emoji)", () => assert.equal(shouldSkip('👍'), false)),
    t.test("'✅' → no skip (confirmation emoji)", () => assert.equal(shouldSkip('✅'), false)),
    t.test("'👍🏻' → no skip (confirmation emoji with skin tone)", () => assert.equal(shouldSkip('👍🏻'), false)),
    t.test("'👍🏼' → no skip (confirmation emoji with skin tone)", () => assert.equal(shouldSkip('👍🏼'), false)),
    t.test("'👍🏽' → no skip (confirmation emoji with skin tone)", () => assert.equal(shouldSkip('👍🏽'), false)),
    t.test("'👍🏾' → no skip (confirmation emoji with skin tone)", () => assert.equal(shouldSkip('👍🏾'), false)),
    t.test("'👍🏿' → no skip (confirmation emoji with skin tone)", () => assert.equal(shouldSkip('👍🏿'), false)),

    // ── IRRELEVANT REACTION EMOJIS — should still be skipped ───────────────────
    t.test("'😂' → skip (irrelevant reaction emoji)", () => assert.equal(shouldSkip('😂'), true)),
    t.test("'🤣' → skip (irrelevant reaction emoji)", () => assert.equal(shouldSkip('🤣'), true)),
    t.test("'💀' → skip (irrelevant reaction emoji)", () => assert.equal(shouldSkip('💀'), true)),
    t.test("'🔥' → skip (irrelevant reaction emoji)", () => assert.equal(shouldSkip('🔥'), true)),
  ])
})
