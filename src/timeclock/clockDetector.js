// Fast-path keyword matching for clock in/out intent.
// No LLM call — pure regex. Returns { type: 'clock_in' | 'clock_out' | null }

const CLOCK_IN_PATTERNS = [
  /\bclock(?:ed|ing)?\s*in\b/i,
  /\bchecke?d?\s*in\b/i,
  /\bon\s+the\s+clock\b/i,
  /\bstarting\s+(?:my\s+)?shift\b/i,
  /\bstarting\s+work\b/i,
  /^(?:i'?m\s+)?here$/i,
  /^i'?m\s+here\b/i,
  // Natural variants
  /\bpunching?\s+in\b/i,
  /^i'?m\s+in\b/i,
  /^just\s+arrived\b/i,
  /^just\s+got\s+here\b/i,
  /^made\s+it\b/i,
  /^arrived\b/i,
]

const CLOCK_OUT_PATTERNS = [
  /\bclock(?:ed|ing)?\s*out\b/i,
  /\bchecke?d?\s*out\b/i,
  /\boff\s+the\s+clock\b/i,
  /\bheading\s+out\b/i,
  /\bleaving\s+(?:now|work)?\b/i,
  /\bfinished\s+(?:my\s+)?shift\b/i,
  /\bdone\s+for\s+(?:the\s+)?(?:day|night|today)\b/i,
  /\bend(?:ing)?\s+(?:my\s+)?shift\b/i,
  // Natural variants
  /\bpunching?\s+out\b/i,
  /^heading\s+home\b/i,
  /^calling\s+it\b/i,
  /^outta\s+here\b/i,
]

// Patterns that should NEVER fire clock intent — questions and references to others
const NON_INTENT_PATTERNS = [
  /\?$/,                         // ends with a question mark
  /^(?:how|when|who|where|why|what)\b/i,  // interrogatives
  /\bdid\s+(?:\w+\s+){0,3}clock\b/i,      // "did Marcus clock in?", "did anyone clock in"
  /\bwho\s+(?:\w+\s+){0,3}clock(?:ed|ing)?\b/i, // "who clocked in early"
  /\bcan\s+I\s+clock\b/i,        // "can I clock in?"
  /\bhad\s+clock\b/i,            // "I had clock issues"
  /\bclock\s+(?:issues?|problems?|trouble)\b/i,
]

export function detectClockIntent(text) {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length > 80) return null // too long to be a clock command

  // Reject questions and references to others' clock activity
  for (const re of NON_INTENT_PATTERNS) {
    if (re.test(trimmed)) return null
  }

  for (const re of CLOCK_IN_PATTERNS) {
    if (re.test(trimmed)) return 'clock_in'
  }
  for (const re of CLOCK_OUT_PATTERNS) {
    if (re.test(trimmed)) return 'clock_out'
  }
  return null
}
