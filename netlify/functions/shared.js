/**
 * ⚠️ TEMPORARY — Netlify Functions (serverless) replacement for Express API.
 * When you deploy to Railway/Render, DELETE the entire netlify/functions/ folder
 * and update netlify.toml to proxy /api/* to your server URL instead.
 * The Express routes in src/server/ are the permanent version of this code.
 */

import { createClient } from '@supabase/supabase-js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'relay-dev-secret-change-in-production'

let _supabase
export function supabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  return _supabase
}

export function verifyAuth(event) {
  const cookieStr = event.headers.cookie || ''
  const cookies = Object.fromEntries(
    cookieStr.split(';').map(c => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }).filter(([k]) => k)
  )
  const token = cookies.relay_session
    || (event.headers.authorization || '').replace('Bearer ', '')

  if (!token) return null

  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  }
}

export function jsonWithCookie(body, token) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `relay_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`,
    },
    body: JSON.stringify(body),
  }
}

export function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  return monday.toISOString().split('T')[0]
}

export function parseShiftHours(startTime, endTime) {
  if (!startTime || !endTime) return 0
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)
  let hours = (eh + em / 60) - (sh + sm / 60)
  if (hours <= 0) hours += 24
  return hours
}
