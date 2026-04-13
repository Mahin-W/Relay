/**
 * ⚠️ TEMPORARY — Netlify Function replacement for src/server/authRoutes.js
 * DELETE when you move to Railway/Render. The Express version is the real one.
 *
 * Handles: /api/auth/request-code, /api/auth/verify-code, /api/auth/logout, /api/auth/me
 *
 * NOTE: OTP codes are stored in Supabase (login_otps table) instead of in-memory,
 * because Netlify Functions are stateless — each invocation is a fresh process.
 * You must create the login_otps table (see bottom of this file for SQL).
 */

import { supabase, verifyAuth, signToken, json, jsonWithCookie } from './shared.js'

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

export async function handler(event) {
  const path = event.path.replace('/.netlify/functions/auth', '').replace('/api/auth', '')
  const method = event.httpMethod

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() }
  }

  try {
    // POST /api/auth/request-code
    if (method === 'POST' && path === '/request-code') {
      const { phone } = JSON.parse(event.body || '{}')
      if (!phone) return json(400, { error: 'Phone number required' })

      const digits = phone.replace(/\D/g, '')
      if (!digits) return json(400, { error: 'Invalid phone number' })

      const db = supabase()

      // Rate limit — check for recent OTP
      const { data: recent } = await db
        .from('login_otps')
        .select('created_at')
        .eq('manager_id', digits)
        .gte('created_at', new Date(Date.now() - 60000).toISOString())
        .limit(1)
      if (recent?.length > 0) {
        return json(429, { error: 'Please wait before requesting another code' })
      }

      // Look up manager
      const { data: session } = await db
        .from('setup_sessions')
        .select('group_id, group_name, manager_id, dm_chat_id, setup_data')
        .eq('manager_id', digits)
        .eq('setup_complete', true)
        .maybeSingle()

      if (!session) {
        return json(404, { error: "This number isn't registered with Relay. Set up Relay first via Telegram." })
      }

      if (!session.dm_chat_id) {
        return json(400, { error: 'No DM channel found. Message the Relay bot on Telegram first.' })
      }

      const otp = generateOTP()

      // Store OTP in Supabase (upsert by manager_id)
      await db.from('login_otps').upsert({
        manager_id: String(session.manager_id),
        group_id: session.group_id,
        group_name: session.group_name,
        restaurant_name: session.setup_data?.restaurant_name || session.group_name || 'Your Restaurant',
        dm_chat_id: session.dm_chat_id,
        code: otp,
        attempts: 0,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      }, { onConflict: 'manager_id' })

      // Send OTP via Telegram Bot API directly (no bot instance in serverless)
      const botToken = process.env.TELEGRAM_BOT_TOKEN
      if (botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: session.dm_chat_id,
            text: `🔐 Your Relay login code: *${otp}*\n\nExpires in 10 minutes. Don't share this with anyone.`,
            parse_mode: 'Markdown',
          }),
        })
      }

      return json(200, { success: true, message: 'Code sent to your Telegram' })
    }

    // POST /api/auth/verify-code
    if (method === 'POST' && path === '/verify-code') {
      const { phone, code } = JSON.parse(event.body || '{}')
      if (!phone || !code) return json(400, { error: 'Phone and code required' })

      const digits = phone.replace(/\D/g, '')
      const db = supabase()

      const { data: stored } = await db
        .from('login_otps')
        .select('*')
        .eq('manager_id', digits)
        .maybeSingle()

      if (!stored) return json(400, { error: 'No code requested for this number' })

      if (new Date(stored.expires_at) < new Date()) {
        await db.from('login_otps').delete().eq('manager_id', digits)
        return json(400, { error: 'Code expired — request a new one' })
      }

      const attempts = (stored.attempts || 0) + 1
      if (attempts >= 5) {
        await db.from('login_otps').delete().eq('manager_id', digits)
        return json(429, { error: 'Too many attempts — request a new code' })
      }

      if (stored.code !== code) {
        await db.from('login_otps').update({ attempts }).eq('manager_id', digits)
        return json(401, { error: 'Incorrect code' })
      }

      // Success — delete OTP (single use)
      await db.from('login_otps').delete().eq('manager_id', digits)

      const token = signToken({
        managerId: stored.manager_id,
        groupId: stored.group_id,
        restaurantName: stored.restaurant_name,
      })

      return jsonWithCookie({
        success: true,
        restaurantName: stored.restaurant_name,
        redirect: '/dashboard',
      }, token)
    }

    // POST /api/auth/logout
    if (method === 'POST' && path === '/logout') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'relay_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
        },
        body: JSON.stringify({ success: true }),
      }
    }

    // GET /api/auth/me
    if (method === 'GET' && path === '/me') {
      const manager = verifyAuth(event)
      if (!manager) return json(401, { error: 'Not authenticated' })
      return json(200, {
        managerId: manager.managerId,
        groupId: manager.groupId,
        restaurantName: manager.restaurantName,
      })
    }

    return json(404, { error: 'Not found' })
  } catch (err) {
    console.error('auth function error:', err)
    return json(500, { error: 'Something went wrong — try again' })
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

/**
 * ⚠️ TEMPORARY TABLE — Run this SQL in Supabase to support serverless OTP storage.
 * DELETE this table when you move to Railway/Render (Express uses in-memory store).
 *
 * CREATE TABLE IF NOT EXISTS login_otps (
 *   manager_id TEXT PRIMARY KEY,
 *   group_id TEXT NOT NULL,
 *   group_name TEXT,
 *   restaurant_name TEXT,
 *   dm_chat_id BIGINT,
 *   code TEXT NOT NULL,
 *   attempts INTEGER DEFAULT 0,
 *   expires_at TIMESTAMPTZ NOT NULL,
 *   created_at TIMESTAMPTZ DEFAULT now()
 * );
 *
 * ALTER TABLE login_otps ENABLE ROW LEVEL SECURITY;
 * CREATE POLICY "Allow all for anon on login_otps" ON login_otps
 *   FOR ALL TO anon USING (true) WITH CHECK (true);
 */
