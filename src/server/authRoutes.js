import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { signToken, setCookieHeader, requireAuth } from './middleware.js'

const router = express.Router()

// In-memory OTP store — key: normalized phone, value: { code, expiresAt, attempts, ... }
const otpStore = new Map()

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits[0] === '1') return '+' + digits
  return '+' + digits
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// POST /api/auth/request-code
router.post('/request-code', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone number required' })

    const normalized = normalizePhone(phone)

    // Rate limit — 60 second cooldown per phone
    const existing = otpStore.get(normalized)
    if (existing && existing.expiresAt > Date.now() && existing.createdAt > Date.now() - 60000) {
      return res.status(429).json({ error: 'Please wait before requesting another code' })
    }

    // Look up manager by manager_id in setup_sessions
    // manager_id is a Telegram user ID (BIGINT), so we match against the phone digits
    // But the actual auth flow: manager_id is a Telegram ID, dm_chat_id is where we send the OTP
    // We need to find the session by matching phone to a known identifier
    // Since Telegram IDs aren't phone numbers, we look up by manager_id directly
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

    // First try: match manager_id as the phone digits (Telegram user IDs are numeric)
    const digits = phone.replace(/\D/g, '')
    const { data: session } = await supabase
      .from('setup_sessions')
      .select('group_id, group_name, manager_id, dm_chat_id, setup_data')
      .eq('manager_id', digits)
      .eq('setup_complete', true)
      .maybeSingle()

    if (!session) {
      return res.status(404).json({
        error: 'Phone number not registered with Relay. Set up Relay first via Telegram.'
      })
    }

    if (!session.dm_chat_id) {
      return res.status(400).json({
        error: 'No DM channel found. Message the Relay bot on Telegram first.'
      })
    }

    const otp = generateOTP()
    otpStore.set(normalized, {
      code: otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now(),
      attempts: 0,
      managerId: String(session.manager_id),
      groupId: session.group_id,
      groupName: session.group_name,
      restaurantName: session.setup_data?.restaurant_name || session.group_name || 'Your Restaurant'
    })

    // Send OTP via Telegram bot
    const bot = req.app.locals.bot
    if (bot) {
      await bot.sendMessage(session.dm_chat_id,
        `🔐 Your Relay login code: *${otp}*\n\nExpires in 10 minutes. Don't share this with anyone.`,
        { parse_mode: 'Markdown' })
    }

    res.json({ success: true, message: 'Code sent to your Telegram' })
  } catch (err) {
    console.error('request-code error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// POST /api/auth/verify-code
router.post('/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' })

    const normalized = normalizePhone(phone)
    const stored = otpStore.get(normalized)

    if (!stored) {
      return res.status(400).json({ error: 'No code requested for this number' })
    }

    if (stored.expiresAt < Date.now()) {
      otpStore.delete(normalized)
      return res.status(400).json({ error: 'Code expired — request a new one' })
    }

    stored.attempts++
    if (stored.attempts >= 5) {
      otpStore.delete(normalized)
      return res.status(429).json({ error: 'Too many attempts — request a new code' })
    }

    if (stored.code !== code) {
      return res.status(401).json({ error: 'Incorrect code' })
    }

    // Success — single use
    otpStore.delete(normalized)
    const token = signToken({
      managerId: stored.managerId,
      groupId: stored.groupId,
      restaurantName: stored.restaurantName,
      phone: normalized
    })
    setCookieHeader(res, token)

    res.json({
      success: true,
      restaurantName: stored.restaurantName,
      redirect: '/dashboard'
    })
  } catch (err) {
    console.error('verify-code error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'relay_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  res.json({ success: true })
})

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({
    managerId: req.manager.managerId,
    groupId: req.manager.groupId,
    restaurantName: req.manager.restaurantName
  })
})

export default router
