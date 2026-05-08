import { createClient } from '@supabase/supabase-js'

let _client = null

export function getDb() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
      throw new Error('SUPABASE_URL + SUPABASE_ANON_KEY required')
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  }
  return _client
}

export function _setDbForTest(client) { _client = client }
