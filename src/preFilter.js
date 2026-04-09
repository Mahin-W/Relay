// Words/phrases that must NEVER be skipped — all are shift-relevant signals.
const TRIGGERS = new Set([
  'ye', 'yea', 'yeah', 'yep', 'yup', 'ya', 'yes',
  'no', 'nah', 'nope', 'na', 'no thanks',
  "i'm in", "i'm out", 'in', 'out', 'pass',
  'omw', 'otw', 'here', 'done', 'wdym',
  "can't",
  // Confirmation emojis — valid coverage confirmations in group chat
  '👍', '✅', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿',
]);

// Truly irrelevant filler words/phrases.
const FILLERS = new Set([
  // already-established fillers
  'gg', 'rip', 'pls', 'fr', 'fr though', 'smh', 'bruh',
  'lmao', 'lol', 'haha', 'hehe', 'lmfao', 'rofl',
  // greetings (not actionable alone in a shift context)
  'hi', 'hey', 'sup', 'yo', 'hola', 'oi',
  // address terms (not actionable alone)
  'bro', 'sis', 'fam', 'bff',
  // pure reactions with no shift signal
  'ew', 'eww', 'aw', 'ooh', 'aah', 'duh',
  // strong exclamations (not shift-related)
  'omg', 'wtf',
  // meta-commentary / hedging filler (standalone, not actionable)
  'tbh', 'ngl', 'imo', 'fyi', 'btw', 'tmi', 'nbd', 'idc', 'atm', 'tbf',
  // gaming / internet slang with no shift meaning
  'npc',
]);

// Laugh/reaction variants with repeated or alternating chars.
//   lmao/lmfao variants : lmaooo, lmfaoo …
//   lol variants        : lol, lolol, lolll, loolol …
//   ha/he variants      : haha, hehheh, hahahahaha …
const LAUGH_RE = /^(lmf?ao+|l(o+l*)+|(h[ae]h?)+)$/i;

// Pure emoji / symbol strings — no Unicode letters or digits.
const ONLY_EMOJI_RE = /^[^\p{L}\p{N}]+$/u;

/**
 * Returns true if the message is irrelevant filler that should be dropped
 * before hitting the LLM, false if it should be processed.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function shouldSkip(text) {
  const norm = text.trim().toLowerCase();
  if (!norm) return true;

  // Explicit shift signals always pass through.
  if (TRIGGERS.has(norm)) return false;

  // Laugh/reaction variants.
  if (LAUGH_RE.test(norm)) return true;

  // Pure emoji / symbol strings.
  if (ONLY_EMOJI_RE.test(norm)) return true;

  // Known filler phrases.
  if (FILLERS.has(norm)) return true;

  return false;
}
