import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function getSetupSession(groupId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getSetupSession failed: ${err.message}`)
    return null
  }
}

export async function getSetupSessionByManager(managerId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('*')
      .eq('manager_id', managerId)
      .eq('setup_complete', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getSetupSessionByManager failed: ${err.message}`)
    return null
  }
}

export async function createSetupSession(groupId, groupName, managerId, dmChatId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .upsert(
        {
          group_id: groupId,
          group_name: groupName,
          manager_id: managerId,
          dm_chat_id: dmChatId,
          step: 'welcome',
          setup_data: {},
          setup_complete: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`createSetupSession failed: ${err.message}`)
    return null
  }
}

export async function updateSetupSession(groupId, updates) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateSetupSession failed: ${err.message}`)
    return null
  }
}

export async function getManagerGroup(managerId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('group_id, dm_chat_id, setup_data, group_name, manager_id, phone')
      .eq('manager_id', managerId)
      .eq('setup_complete', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getManagerGroup failed: ${err.message}`)
    return null
  }
}

export async function isSetupComplete(groupId) {
  try {
    const { data, error } = await supabase
      .from('setup_sessions')
      .select('setup_complete')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    return data?.setup_complete === true
  } catch (err) {
    logger.error(`isSetupComplete failed: ${err.message}`)
    return false
  }
}
