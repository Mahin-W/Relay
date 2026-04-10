import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function saveOnboardingRecord(groupId, name, role, startDate) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .insert({ group_id: groupId, name, role: role ?? null, start_date: startDate ?? null, status: 'pending' })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveOnboardingRecord failed: ${err.message}`)
    return null
  }
}

export async function getPendingOnboarding(groupId) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .order('announced_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPendingOnboarding failed: ${err.message}`)
    return []
  }
}

export async function completeOnboarding(id) {
  try {
    const { data, error } = await supabase
      .from('onboarding_pending')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`completeOnboarding failed: ${err.message}`)
    return null
  }
}
