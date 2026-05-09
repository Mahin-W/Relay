import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import path from 'path'
import authRoutes from './authRoutes.js'
import dashRoutes from './dashRoutes.js'
import marketingRoutes from './marketingRoutes.js'

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : [
      'https://getrelay-app.netlify.app',
      'https://relay-68a.pages.dev',
      'http://localhost:3000',
      'http://localhost:8888',
    ]

export function startWebServer(bot, db) {
  const app = express()
  const port = process.env.PORT || 10000

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

  app.use('/api/auth', authRoutes)
  app.use('/api', marketingRoutes)       // POST /api/waitlist — public, no auth
  app.use('/api/dashboard', dashRoutes)  // legacy — dashboard.html uses these paths
  app.use('/api', dashRoutes)            // new — clean paths for updated clients

  app.get('/health', (req, res) =>
    res.json({ ok: true, service: 'relay', time: new Date().toISOString() }))

  app.get('/dashboard', (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')))
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')))

  app.listen(port, () => console.log(`Web server on port ${port}`))

  // Keep Render free tier awake
  setInterval(() => {
    fetch('https://relay-v5ne.onrender.com/health').catch(() => {})
  }, 14 * 60 * 1000)
}
