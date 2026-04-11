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
]

export function detectClockIntent(text) {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length > 80) return null // too long to be a clock command

  for (const re of CLOCK_IN_PATTERNS) {
    if (re.test(trimmed)) return 'clock_in'
  }
  for (const re of CLOCK_OUT_PATTERNS) {
    if (re.test(trimmed)) return 'clock_out'
  }
  return null
}
