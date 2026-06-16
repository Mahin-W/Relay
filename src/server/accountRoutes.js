import express from 'express'
import { requireAuth } from './middleware.js'
import {
  getAccountByAuthId,
  ensureAccount,
  updateAccount,
  updateAccountSetupData,
  createAccountLink,
  getLinkedGroup,
} from './db/accounts.js'

const router = express.Router()

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
    const { businessName, setupData, onboardingComplete } = req.body || {}
    const updates = {}
    if (typeof businessName === 'string') updates.business_name = businessName
    if (typeof onboardingComplete === 'boolean') updates.onboarding_complete = onboardingComplete

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
