import { logger } from '../logger.js'

// Minimal transactional email via Resend's HTTP API (no SDK dependency).
// Used for the login confirmation code when an account has no Telegram linked.
// If RESEND_API_KEY is unset, email is treated as unavailable (callers fall
// back / fail open) rather than erroring.

const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM = process.env.RESEND_FROM || 'Relay <onboarding@resend.dev>'

export function emailConfigured() {
  return !!RESEND_API_KEY
}

export async function sendEmail({ to, subject, text }) {
  if (!RESEND_API_KEY) {
    logger.error('sendEmail skipped — RESEND_API_KEY not set')
    return false
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
    })
    if (!res.ok) {
      logger.error(`sendEmail failed: ${res.status} ${await res.text().catch(() => '')}`)
      return false
    }
    return true
  } catch (err) {
    logger.error(`sendEmail error: ${err.message}`)
    return false
  }
}
