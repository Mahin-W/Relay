import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── Availability records ──────────────────────────────────────────────────────

// availableShiftIds: array of shift.id values the person can work
// availableAll: true if they can work any shift
// unavailable: true if they can't work at all this week
export async function saveAvailability(userId, groupId, weekStart, availableShiftIds, availableAll, unavailable, rawResponse) {
  try {
    const { data, error } = await supabase
      .from('availability')
      .upsert(
        {
          user_id: userId,
          group_id: groupId,
          week_start: weekStart,
          available_shift_ids: availableShiftIds ?? [],
          available_all: availableAll ?? false,
          unavailable: unavailable ?? false,
          raw_response: rawResponse,
          collected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,week_start,group_id' }
      )
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved availability for user ${userId} (week ${weekStart})`)
    return data
  } catch (err) {
    logger.error(`saveAvailability failed: ${err.message}`)
    return null
  }
}

export async function getAvailabilityForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getAvailabilityForGroup failed: ${err.message}`)
    return []
  }
}

// ── Availability sessions ─────────────────────────────────────────────────────

// shiftMap: { "1": { id, name, day_of_week, start_time, end_time }, "2": {...}, ... }
// Stored in session so we can parse numbered replies and re-display the list.
export async function createAvailabilitySession(userId, groupId, dmChatId, weekStart, shiftMap) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .upsert(
        {
          user_id: userId,
          group_id: groupId,
          dm_chat_id: dmChatId,
          week_start: weekStart,
          shift_map: shiftMap ?? {},
          status: 'pending',
        },
        { onConflict: 'user_id,week_start,group_id' }
      )
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`createAvailabilitySession failed: ${err.message}`)
    return null
  }
}

// Look up a pending session by DM chat ID (used when a DM comes in)
export async function getAvailabilitySessionByDm(dmChatId) {
  try {
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('dm_chat_id', dmChatId)
      .eq('status', 'pending')
      .gte('week_start', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAvailabilitySessionByDm failed: ${err.message}`)
    return null
  }
}

// Check if user already has a session for this week (any status)
export async function getAvailabilitySessionForUserWeek(userId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getAvailabilitySessionForUserWeek failed: ${err.message}`)
    return null
  }
}

export async function updateAvailabilitySessionStatus(userId, weekStart, status) {
  try {
    const { error } = await supabase
      .from('availability_sessions')
      .update({ status })
      .eq('user_id', userId)
      .eq('week_start', weekStart)
    if (error) throw error
  } catch (err) {
    logger.error(`updateAvailabilitySessionStatus failed: ${err.message}`)
  }
}

// Returns sessions still pending for this group+week (haven't responded yet)
export async function getPendingSessionsForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'pending')
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPendingSessionsForGroup failed: ${err.message}`)
    return []
  }
}

// Returns all sessions (any status) for this group+week — used to show total count
export async function getAllSessionsForGroup(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('availability_sessions')
      .select('*')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getAllSessionsForGroup failed: ${err.message}`)
    return []
  }
}

// Delete all availability sessions and responses for a group+week (for reset)
export async function resetAvailabilityForGroup(groupId, weekStart) {
  try {
    await supabase.from('availability_sessions').delete().eq('group_id', groupId).eq('week_start', weekStart)
    await supabase.from('availability').delete().eq('group_id', groupId).eq('week_start', weekStart)
    logger.db(`Reset availability for group ${groupId} week ${weekStart}`)
  } catch (err) {
    logger.error(`resetAvailabilityForGroup failed: ${err.message}`)
  }
}

// ── Generated schedules ───────────────────────────────────────────────────────

export async function saveGeneratedSchedule(groupId, weekStart, assignments, gaps) {
  try {
    // Supersede any existing draft for this group
    await supabase
      .from('generated_schedules')
      .update({ status: 'rejected' })
      .eq('group_id', groupId)
      .eq('status', 'draft')

    const { data, error } = await supabase
      .from('generated_schedules')
      .insert({
        group_id: groupId,
        week_start: weekStart,
        status: 'draft',
        assignments,
        gaps,
      })
      .select()
      .single()
    if (error) throw error
    logger.db(`Saved schedule draft id=${data.id} for group ${groupId}`)
    return data
  } catch (err) {
    logger.error(`saveGeneratedSchedule failed: ${err.message}`)
    return null
  }
}

export async function getPublishedSchedule(groupId) {
  try {
    const { data, error } = await supabase
      .from('generated_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPublishedSchedule failed: ${err.message}`)
    return null
  }
}

export async function getPendingSchedule(groupId) {
  try {
    const { data, error } = await supabase
      .from('generated_schedules')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPendingSchedule failed: ${err.message}`)
    return null
  }
}

export async function updateScheduleStatus(scheduleId, status) {
  try {
    const updates = { status }
    if (status === 'published') updates.published_at = new Date().toISOString()
    if (status === 'approved') updates.approved_at = new Date().toISOString()
    const { error } = await supabase
      .from('generated_schedules')
      .update(updates)
      .eq('id', scheduleId)
    if (error) throw error
  } catch (err) {
    logger.error(`updateScheduleStatus failed: ${err.message}`)
  }
}
