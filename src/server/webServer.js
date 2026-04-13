import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import authRoutes from './authRoutes.js'
import dashRoutes from './dashRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createWebServer(bot) {
  const app = express()

  app.use(express.json())
  app.use(cookieParser())
  app.use(cors({
    origin: [
      'https://getrelay-app.netlify.app',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:8888',
    ],
    credentials: true,
  }))

  // Serve public/ folder for local dev (Netlify serves this in production)
  const publicDir = path.join(__dirname, '../../public')
  app.use(express.static(publicDir))

  // Pass bot to routers via app.locals
  app.locals.bot = bot

  // API routes
  app.use('/api/auth', authRoutes)
  app.use('/api/dashboard', dashRoutes)

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'relay' }))

  // SPA fallback for /dashboard and /login
  app.get('/dashboard', (req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')))
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')))

  return app
}

export function startWebServer(bot, port = 3001) {
  const app = createWebServer(bot)
  app.listen(port, () => {
    console.log(`Web server running on port ${port}`)
  })
  return app
}
