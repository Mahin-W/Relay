import { createClient } from '@supabase/supabase-js'

let _client = null

// Prefer the service-role key in production: the server enforces tenant
// isolation in the route layer (every dashRoutes query filters by req.manager.groupId,
// every bot handler scopes by msg.chat.id). With migration 008 in place, anon
// has no DB access at all, so without service-role the server cannot read its
// own tables. The anon key is kept as a dev fallback only.
export function getDb() {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL + (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY) required')
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NODE_ENV === 'production') {
      console.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY is not set in production — falling back to anon key. ' +
        'After migration 008 (RLS lockdown), anon will lose DB access. Set SUPABASE_SERVICE_ROLE_KEY in Render env.')
    }
    _client = createClient(url, key)
  }
  return _client
}

export function _setDbForTest(client) { _client = client }
