import express from 'express'
import { requireAuth, signTwoFactorToken, setTwoFactorCookie } from './middleware.js'
import {
  getAccountByAuthId,
  ensureAccount,
  updateAccount,
  updateAccountSetupData,
  createAccountLink,
  getLinkedGroup,
  getAccountTelegramDm,
} from './db/accounts.js'
import { generateCode, setCode, verifyCode, withinCooldown, getPending } from './twoFactor.js'
import { emailConfigured, sendEmail } from './email.js'

const router = express.Router()

function maskEmail(email) {
  if (!email || !email.includes('@')) return 'your email'
  const [user, domain] = email.split('@')
  return `${user[0]}${'•'.repeat(Math.max(1, user.length - 1))}@${domain}`
}

// Branded HTML email for the login confirmation code (with a plain-text fallback).
function loginCodeEmail(code) {
  return {
    subject: 'Your Relay login code',
    text: `Your Relay login code is ${code}. It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FAF7F2;padding:32px 16px;">
  <div style="max-width:440px;margin:0 auto;background:#FFFFFF;border:1px solid #E8DFD0;border-radius:16px;padding:40px 36px;text-align:center;">
    <div style="font-size:22px;font-weight:800;color:#1C1410;letter-spacing:-0.02em;margin-bottom:6px;">Relay</div>
    <div style="font-size:15px;color:#4A3F35;margin-bottom:28px;">Your login confirmation code</div>
    <div style="font-size:36px;font-weight:800;letter-spacing:10px;color:#D95F2B;background:#FDF0E8;border-radius:12px;padding:18px 0;">${code}</div>
    <div style="font-size:13px;color:#9A8880;line-height:1.6;margin-top:28px;">This code expires in 10 minutes.<br/>If you didn't try to sign in, you can safely ignore this email.</div>
  </div>
  <div style="text-align:center;color:#B8A99C;font-size:12px;margin-top:20px;">Relay · scheduling that runs on your team chat</div>
</div>`,
  }
}

// All account routes require an account-based (Supabase) session. Legacy
// phone-OTP sessions have no accountId and are rejected here.
function requireAccount(req, res, next) {
  if (req.manager?.authType !== 'account' || !req.manager.accountId) {
    return res.status(403).json({ error: 'Sign in with your Relay account to access this.' })
  }
  next()
}

// POST /api/account/bootstrap — idempotent; ensures the accounts row exists.
// (Backstop for the auth.users INSERT trigger.) Returns the account.
router.post('/bootstrap', requireAuth, requireAccount, async (req, res) => {
  try {
    const account = await ensureAccount(req.manager.accountId, req.manager.email)
    if (!account) return res.status(500).json({ error: 'Could not initialize account' })
    res.json({ account, connected: !!req.manager.groupId })
  } catch (err) {
    console.error('account bootstrap error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// GET /api/account — the account record + staging setup data.
router.get('/', requireAuth, requireAccount, async (req, res) => {
  try {
    const account = await getAccountByAuthId(req.manager.accountId)
    if (!account) return res.status(404).json({ error: 'Account not found' })
    res.json({
      id: account.id,
      email: account.email,
      businessName: account.business_name,
      setupData: account.setup_data || {},
      onboardingComplete: account.onboarding_complete,
      twoFactorEnabled: account.login_2fa_enabled !== false,
      connected: !!req.manager.groupId,
    })
  } catch (err) {
    console.error('get account error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// PATCH /api/account — update business name and/or merge a setup_data patch.
router.patch('/', requireAuth, requireAccount, async (req, res) => {
  try {
    const { businessName, setupData, onboardingComplete, twoFactorEnabled } = req.body || {}
    const updates = {}
    if (typeof businessName === 'string') updates.business_name = businessName
    if (typeof onboardingComplete === 'boolean') updates.onboarding_complete = onboardingComplete
    if (typeof twoFactorEnabled === 'boolean') updates.login_2fa_enabled = twoFactorEnabled

    if (Object.keys(updates).length) {
      await updateAccount(req.manager.accountId, updates)
    }
    if (setupData && typeof setupData === 'object') {
      await updateAccountSetupData(req.manager.accountId, setupData)
    }
    const account = await getAccountByAuthId(req.manager.accountId)
    res.json({
      id: account.id,
      businessName: account.business_name,
      setupData: account.setup_data || {},
      onboardingComplete: account.onboarding_complete,
    })
  } catch (err) {
    console.error('patch account error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// POST /api/account/link-code — generate a one-time Telegram linking deep link.
router.post('/link-code', requireAuth, requireAccount, async (req, res) => {
  try {
    const botUsername = process.env.BOT_USERNAME
    if (!botUsername) {
      return res.status(503).json({ error: 'Bot is still starting up — try again in a moment.' })
    }
    const link = await createAccountLink(req.manager.accountId)
    if (!link) return res.status(500).json({ error: 'Could not generate a linking code' })
    res.json({
      code: link.code,
      deepLink: `https://t.me/${botUsername}?start=link_${link.code}`,
      expiresAt: link.expires_at,
    })
  } catch (err) {
    console.error('link-code error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// POST /api/account/2fa/start — send a login confirmation code, if required.
// Returns { required:false } when 2FA is off, already verified this session, or
// no delivery channel is available (fail-open so owners aren't locked out).
router.post('/2fa/start', requireAuth, requireAccount, async (req, res) => {
  try {
    if (req.manager.twoFactorVerified) return res.json({ required: false })

    const account = await getAccountByAuthId(req.manager.accountId)
    if (!account || account.login_2fa_enabled === false) return res.json({ required: false })

    // Anti-flood: if a code was sent in the last minute, reuse it (no new email).
    if (withinCooldown(account.id)) {
      const p = getPending(account.id)
      return res.json({ required: true, channel: p.channel, hint: p.hint, resent: false })
    }

    const bot = req.app.locals.bot
    const dmChatId = await getAccountTelegramDm(account.id)

    let channel = null
    if (dmChatId && bot) channel = 'telegram'
    else if (account.email && emailConfigured()) channel = 'email'
    if (!channel) return res.json({ required: false, reason: 'no_channel' })

    const code = generateCode()

    if (channel === 'telegram') {
      await bot.sendMessage(dmChatId, `🔐 Your Relay login code: *${code}*\n\nExpires in 10 minutes.`, { parse_mode: 'Markdown' })
      const hint = 'your Telegram'
      setCode(account.id, code, { channel, hint })
      return res.json({ required: true, channel, hint })
    }

    const sent = await sendEmail({ to: account.email, ...loginCodeEmail(code) })
    if (!sent) return res.json({ required: false, reason: 'no_channel' })
    const hint = maskEmail(account.email)
    setCode(account.id, code, { channel, hint })
    return res.json({ required: true, channel, hint })
  } catch (err) {
    console.error('2fa start error:', err.message)
    res.status(500).json({ error: 'Could not send your login code — try again' })
  }
})

// POST /api/account/2fa/verify — check the code and unlock the session.
router.post('/2fa/verify', requireAuth, requireAccount, async (req, res) => {
  try {
    const { code } = req.body || {}
    if (!code) return res.status(400).json({ error: 'Enter the code' })
    const result = verifyCode(req.manager.accountId, String(code).trim())
    if (!result.ok) {
      const msgs = {
        none: 'No code requested — start again.',
        expired: 'That code expired — request a new one.',
        too_many: 'Too many attempts — request a new code.',
        incorrect: 'Incorrect code.',
      }
      return res.status(401).json({ error: msgs[result.reason] || 'Verification failed', reason: result.reason })
    }
    const token = signTwoFactorToken(req.manager.accountId)
    setTwoFactorCookie(res, token)
    res.json({ success: true, token })
  } catch (err) {
    console.error('2fa verify error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

// GET /api/account/connection-status — is a Telegram group connected yet?
router.get('/connection-status', requireAuth, requireAccount, async (req, res) => {
  try {
    const group = await getLinkedGroup(req.manager.accountId)
    res.json({
      connected: !!group?.group_id,
      groupId: group?.group_id ?? null,
      restaurantName: group?.group_name ?? null,
      setupComplete: group?.setup_complete ?? false,
      inviteLink: group?.setup_data?.invite_link ?? null,
    })
  } catch (err) {
    console.error('connection-status error:', err.message)
    res.status(500).json({ error: 'Something went wrong — try again' })
  }
})

export default router
