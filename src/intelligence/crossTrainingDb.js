import { getDb } from '../db.js'

export async function saveCrossTraining(groupId, staffId, roleId, proficiency, db = null) {
  if (db?.saveCrossTraining) return db.saveCrossTraining(groupId, staffId, roleId, proficiency)
  const { data, error } = await getDb()
    .from('cross_training')
    .upsert({
      group_id: groupId,
      staff_id: staffId,
      role_id: roleId,
      proficiency,
      active: true,
    }, { onConflict: 'group_id,staff_id,role_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function removeCrossTraining(groupId, staffId, roleId, db = null) {
  if (db?.removeCrossTraining) return db.removeCrossTraining(groupId, staffId, roleId)
  const { data, error } = await getDb()
    .from('cross_training')
    .update({ active: false })
    .eq('group_id', groupId)
    .eq('staff_id', staffId)
    .eq('role_id', roleId)
    .select()
    .single()
  if (error) return false
  return true
}

export async function getCrossTrainingForStaff(staffId, groupId, includeTraining = false, db = null) {
  if (db?.getCrossTrainingForStaff) return db.getCrossTrainingForStaff(staffId, groupId, includeTraining)
  let query = getDb()
    .from('cross_training')
    .select('role_id, proficiency')
    .eq('staff_id', staffId)
    .eq('group_id', groupId)
    .eq('active', true)
  if (!includeTraining) {
    query = query.neq('proficiency', 'training')
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map(r => ({
    roleId: r.role_id,
    roleName: r.role_name ?? `Role ${r.role_id}`,
    proficiency: r.proficiency,
  }))
}

export async function getCrossTrainedForRole(groupId, roleId, db = null) {
  if (db?.getCrossTrainedForRole) return db.getCrossTrainedForRole(groupId, roleId)
  const { data, error } = await getDb()
    .from('cross_training')
    .select('staff_id, proficiency, staff(name)')
    .eq('group_id', groupId)
    .eq('role_id', roleId)
    .eq('active', true)
    .neq('proficiency', 'training')
  if (error) throw error
  const rows = (data ?? []).map(r => ({
    staffId: r.staff_id,
    staffName: r.staff?.name ?? 'Unknown',
    proficiency: r.proficiency,
  }))
  // Sort: proficient first, competent second
  const order = { proficient: 0, competent: 1 }
  rows.sort((a, b) => (order[a.proficiency] ?? 2) - (order[b.proficiency] ?? 2))
  return rows
}

export async function getAllCrossTraining(groupId, db = null) {
  if (db?.getAllCrossTraining) return db.getAllCrossTraining(groupId)
  const { data, error } = await getDb()
    .from('cross_training')
    .select('staff_id, role_id, proficiency, staff(name)')
    .eq('group_id', groupId)
    .eq('active', true)
  if (error) throw error
  const grouped = {}
  for (const r of (data ?? [])) {
    if (!grouped[r.staff_id]) grouped[r.staff_id] = []
    grouped[r.staff_id].push({
      roleId: r.role_id,
      roleName: r.role_name ?? `Role ${r.role_id}`,
      proficiency: r.proficiency,
    })
  }
  return grouped
}
