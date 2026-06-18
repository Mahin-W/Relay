import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import path from 'path'
import { getDb } from '../db.js'
import authRoutes from './authRoutes.js'
import accountRoutes from './accountRoutes.js'
import setupRoutes from './setupRoutes.js'
import dashRoutes from './dashRoutes.js'
import marketingRoutes from './marketingRoutes.js'
import exportRoutes from './exportRoutes.js'

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : [
      'https://getrelay-app.netlify.app',
      'https://relay-68a.pages.dev',
      'http://localhost:3000',
      'http://localhost:8888',
    ]

// Builds the configured Express app (no listen/keep-alive). Exported so the
// route ordering — notably the public /api/public-config sitting above the
// auth-gated /api routers — is covered by tests.
export function createApp(bot, db) {
  const app = express()

  app.use(express.json())
  app.use(cookieParser())
  app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }))

  const publicDir = path.join(process.cwd(), 'public')
  app.use(express.static(publicDir))

  app.locals.bot = bot
  app.locals.db = db

  // Deep health check: a 200 means the web server is up AND Telegram polling is
  // live. Polling-dead returns 503 so an external monitor (and Render's
  // healthcheck) catches a bot that's silently stopped receiving messages — a
  // container restart re-establishes polling. Supabase reachability is reported
  // but does NOT fail the route (it's external; restarting wouldn't fix it).
  app.get('/health', async (req, res) => {
    const polling = typeof bot?.isPolling === 'function' ? bot.isPolling() : null
    let supabase = null
    try {
      const { error } = await getDb().from('setup_sessions').select('group_id').limit(1)
      supabase = !error
    } catch { supabase = false }
    const ok = polling !== false
    res.status(ok ? 200 : 503).json({
      ok, service: 'relay', polling, supabase, time: new Date().toISOString(),
    })
  })

  // Public config for the static frontend's Supabase Auth client. The anon key
  // is safe to expose (RLS denies anon; see migration 008). MUST be registered
  // before the auth-gated `/api` routers below, or they shadow it with a 401.
  app.get('/api/public-config', (req, res) =>
    res.json({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    }))

  app.use('/api/auth', authRoutes)
  app.use('/api/account/setup', setupRoutes) // wizard live-write API (must precede /api/account)
  app.use('/api/account', accountRoutes)  // account identity + Telegram linking codes
  app.use('/api', marketingRoutes)       // POST /api/waitlist — public, no auth
  app.use('/api', exportRoutes)          // GET  /api/export    — JWT-gated, group-scoped
  app.use('/api/dashboard', dashRoutes)  // legacy — dashboard.html uses these paths
  app.use('/api', dashRoutes)            // new — clean paths for updated clients

  app.get('/dashboard', (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')))
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')))
  app.get('/signup', (req, res) => res.sendFile(path.join(publicDir, 'login.html')))
  app.get('/onboarding', (req, res) => res.sendFile(path.join(publicDir, 'onboarding.html')))

  return app
}

export function startWebServer(bot, db) {
  const app = createApp(bot, db)
  const port = process.env.PORT || 10000

  // Return the server so the caller can close it on shutdown (graceful drain of
  // in-flight requests instead of killing them mid-Supabase-write).
  const server = app.listen(port, () => console.log(`Web server on port ${port}`))

  // Keep Render free tier awake
  setInterval(() => {
    fetch('https://relay-v5ne.onrender.com/health').catch(() => {})
  }, 14 * 60 * 1000)

  return server
}
