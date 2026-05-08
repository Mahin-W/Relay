import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

const TIP_DEFAULTS = { mode: 'pool', splitMethod: 'hours', bohIncluded: false }

export async function saveTipSettings(groupId, settings, db = null) {
  if (db?.saveTipSettings) return db.saveTipSettings(groupId, settings)
  try {
    const { data, error } = await getDb()
      .from('restaurant_tip_settings')
      .upsert(
        {
          group_id: groupId,
          mode: settings.mode,
          split_method: settings.splitMethod,
          boh_included: settings.bohIncluded,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Tip settings saved for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveTipSettings failed: ${err.message}`)
    return null
  }
}

export async function getTipSettings(groupId, db = null) {
  if (db?.getTipSettings) {
    const result = await db.getTipSettings(groupId)
    return result ?? { ...TIP_DEFAULTS }
  }
  try {
    const { data, error } = await getDb()
      .from('restaurant_tip_settings')
      .select('*')
      .eq('group_id', groupId)
      .maybeSingle()
    if (error) throw error
    if (!data) return { ...TIP_DEFAULTS }
    return {
      mode: data.mode ?? TIP_DEFAULTS.mode,
      splitMethod: data.split_method ?? TIP_DEFAULTS.splitMethod,
      bohIncluded: data.boh_included ?? TIP_DEFAULTS.bohIncluded,
    }
  } catch (err) {
    logger.error(`getTipSettings failed: ${err.message}`)
    return { ...TIP_DEFAULTS }
  }
}
