import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { signToken, setCookieHeader, requireAuth } from './middleware.js'

const router = express.Router()

const otpStore = new Map()

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// POST /api/auth/request-code
router.post('/request-code', async (req, res) => {
  try {
    const { managerId } = req.body
    if (!managerId) return res.status(400).json({ error: 'Telegram ID required' })

    const id = String(managerId).replace(/\D/g, '')
    if (!id) return res.status(400).json({ error: 'Invalid Telegram ID' })

    // Rate limit — 60 second cooldown
    const existing = otpStore.get(id)
    if (existing && existing.createdAt > Date.now() - 60000) {
      return res.status(429).json({ error: 'Please wait before requesting another code' })
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data: session } = await supabase
      .from('setup_sessions')
      .select('group_id, group_name, manager_id, dm_chat_id')
      .eq('manager_id', id)
      .eq('setup_complete', true)
      .maybeSingle()

    if (!session) {
      return res.status(404).json({
        error: "Telegram ID not found. Make sure you've completed Relay setup."
      })
    }

    if (!session.dm_chat_id) {
      return res.status(400).json({
        error: 'No DM channel found. Message the Relay bot on Telegram first.'
      })
    }

    const otp = generateOTP()
    otpStore.set(id, {
      code: otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      createdAt: Date.now(),
      attempts: 0,
      groupId: session.group_id,
      restaurantName: session.group_name || 'Your Restaurant',
      dmChatId: session.dm_chat_id,
    })

    const bot = req.app.locals.bot
    if (bot) {
      await bot.sendMessage(session.dm_chat_id,
        `🔐 Your Relay login code: *${otp}*\n\nExpires in 10 minutes.`,
        { parse_mode: 'Markdown' })
    }

    res.json({ success: true })
  } catch (err) {
    console.error('request-code error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// POST /api/auth/verify-code
router.post('/verify-code', async (req, res) => {
  try {
    const { managerId, code } = req.body
    if (!managerId || !code) return res.status(400).json({ error: 'Telegram ID and code required' })

    const id = String(managerId).replace(/\D/g, '')
    const stored = otpStore.get(id)

    if (!stored) {
      return res.status(400).json({ error: 'No code requested for this ID' })
    }

    if (stored.expiresAt < Date.now()) {
      otpStore.delete(id)
      return res.status(400).json({ error: 'Code expired — request a new one' })
    }

    stored.attempts++
    if (stored.attempts >= 5) {
      otpStore.delete(id)
      return res.status(429).json({ error: 'Too many attempts — request a new code' })
    }

    if (stored.code !== code) {
      return res.status(401).json({ error: 'Incorrect code' })
    }

    otpStore.delete(id)
    const token = signToken({
      managerId: id,
      groupId: stored.groupId,
      restaurantName: stored.restaurantName,
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
