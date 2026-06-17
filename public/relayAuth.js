// Shared Supabase Auth helper for the Relay dashboard frontend.
// Loaded as an ES module: <script type="module">.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

let _client = null

export async function getSupabase() {
  if (_client) return _client
  const cfg = await fetch('/api/public-config').then(r => r.json())
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Supabase is not configured on the server.')
  }
  _client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  })
  return _client
}

export async function getAccessToken() {
  const sb = await getSupabase()
  const { data } = await sb.auth.getSession()
  return data.session?.access_token || null
}

// Redirect to login if there's no active session; otherwise return the token.
export async function requireSession(redirect = '/login') {
  const token = await getAccessToken()
  if (!token) {
    window.location.href = redirect
    throw new Error('No active session')
  }
  return token
}

export async function signOut(redirect = '/login') {
  try {
    const sb = await getSupabase()
    await sb.auth.signOut()
  } catch { /* ignore */ }
  try { localStorage.removeItem('relay_2fa') } catch {}
  window.location.href = redirect
}

// Login confirmation code (2FA) proof, stored after /2fa/verify and sent as a
// header on every authed request (more robust than a cross-origin cookie).
export function getTwoFactorToken() {
  try { return localStorage.getItem('relay_2fa') } catch { return null }
}
export function setTwoFactorToken(token) {
  try { token ? localStorage.setItem('relay_2fa', token) : localStorage.removeItem('relay_2fa') } catch {}
}

// Authenticated fetch helper — attaches the Supabase access token as a Bearer.
export async function authFetch(path, { method = 'GET', body = null } = {}) {
  const token = await getAccessToken()
  const headers = {}
  if (token) headers['Authorization'] = 'Bearer ' + token
  const twofa = getTwoFactorToken()
  if (twofa) headers['x-relay-2fa'] = twofa
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    // Don't bounce to /login when we're already there — that creates a reload
    // loop if the server rejects the session. Let the caller handle it.
    if (!location.pathname.startsWith('/login')) window.location.href = '/login'
    const e = new Error('Unauthorized'); e.status = 401; throw e
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error || `HTTP ${res.status}`)
  }
  return res.status === 204 ? null : res.json()
}

// After sign-in: ensure the account row exists, then route to the right place.
export async function routeAfterAuth() {
  try {
    await authFetch('/api/account/bootstrap', { method: 'POST' })
    const status = await authFetch('/api/account/connection-status')
    if (status.connected && status.setupComplete) {
      window.location.href = '/dashboard'
    } else {
      window.location.href = '/onboarding'
    }
  } catch (err) {
    window.location.href = '/onboarding'
  }
}
