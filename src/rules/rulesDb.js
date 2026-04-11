import { createClient } from '@supabase/supabase-js'

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null

export async function saveRule(groupId, rule, db = null) {
  if (db?.saveRule) return db.saveRule(groupId, rule)
  const { data, error } = await supabase
    .from('business_rules')
    .insert({
      group_id: groupId,
      type: rule.type,
      subject_staff_id: rule.subjectStaffId,
      object_staff_id: rule.objectStaffId,
      constraint_text: rule.constraint,
      raw_message: rule.raw,
      day_of_week: rule.dayOfWeek,
      latest_end_time: rule.latestEndTime,
      shift_id: rule.shiftId,
      active: rule.active ?? true,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getRules(groupId, db = null) {
  if (db?.getRules) return db.getRules(groupId)
  const { data, error } = await supabase
    .from('business_rules')
    .select('*')
    .eq('group_id', groupId)
    .eq('active', true)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function getRulesForStaff(groupId, staffId, db = null) {
  if (db?.getRulesForStaff) return db.getRulesForStaff(groupId, staffId)
  const { data, error } = await supabase
    .from('business_rules')
    .select('*')
    .eq('group_id', groupId)
    .eq('active', true)
    .or(`subject_staff_id.eq.${staffId},object_staff_id.eq.${staffId}`)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function deactivateRule(ruleId, groupId, db = null) {
  if (db?.deactivateRule) return db.deactivateRule(ruleId, groupId)
  const { data, error } = await supabase
    .from('business_rules')
    .update({ active: false })
    .eq('id', ruleId)
    .eq('group_id', groupId)
    .select()
    .single()
  if (error) throw error
  return data
}
