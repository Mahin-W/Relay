import { createClient } from '@supabase/supabase-js'
import { logger } from '../../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const DEFAULTS = {
  overtime_enabled: true,
  weekly_threshold: 40,
  weekly_multiplier: 1.5,
  daily_overtime_enabled: false,
  daily_threshold: 8,
  daily_multiplier: 1.5,
}

export async function saveOvertimeSettings(groupId, settings, db = null) {
  if (db?.saveOvertimeSettings) return db.saveOvertimeSettings(groupId, settings)
  try {
    const { data, error } = await supabase
      .from('overtime_settings')
      .upsert(
        { group_id: groupId, ...settings, updated_at: new Date().toISOString() },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Overtime settings saved for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveOvertimeSettings failed: ${err.message}`)
    return null
  }
}

export async function getOvertimeSettings(groupId, db = null) {
  if (db?.getOvertimeSettings) {
    const result = await db.getOvertimeSettings(groupId)
    return result ?? { ...DEFAULTS }
  }
  try {
    const { data, error } = await supabase
      .from('overtime_settings')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    if (!data) return { ...DEFAULTS }
    return {
      overtime_enabled: data.overtime_enabled ?? DEFAULTS.overtime_enabled,
      weekly_threshold: Number(data.weekly_threshold ?? DEFAULTS.weekly_threshold),
      weekly_multiplier: Number(data.weekly_multiplier ?? DEFAULTS.weekly_multiplier),
      daily_overtime_enabled: data.daily_overtime_enabled ?? DEFAULTS.daily_overtime_enabled,
      daily_threshold: Number(data.daily_threshold ?? DEFAULTS.daily_threshold),
      daily_multiplier: Number(data.daily_multiplier ?? DEFAULTS.daily_multiplier),
    }
  } catch (err) {
    logger.error(`getOvertimeSettings failed: ${err.message}`)
    return { ...DEFAULTS }
  }
}
