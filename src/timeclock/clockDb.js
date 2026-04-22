import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

export async function clockIn(groupId, userId, staffId, shiftId, rawText, db = null) {
  if (db?.clockIn) return db.clockIn(groupId, userId, staffId, shiftId, rawText)
  try {
    const { data, error } = await supabase
      .from('time_entries')
      .insert({
        group_id: groupId,
        user_id: userId,
        staff_id: staffId,
        shift_id: shiftId,
        clock_in: new Date().toISOString(),
        clock_in_raw: rawText,
      })
      .select()
      .single()
    if (error) throw error
    logger.db(`Clock-in saved: user ${userId}, shift ${shiftId}`)
    return data
  } catch (err) {
    logger.error(`clockIn failed: ${err.message}`)
    return null
  }
}

export async function clockOut(entryId, rawText, db = null) {
  if (db?.clockOut) return db.clockOut(entryId, rawText)
  try {
    // D.02: only update if clock_out is currently null — prevents silent overwrite
    const { data, error } = await supabase
      .from('time_entries')
      .update({
        clock_out: new Date().toISOString(),
        clock_out_raw: rawText,
      })
      .eq('id', entryId)
      .is('clock_out', null)
      .select()
      .single()
    if (error) throw error
    if (!data) {
      // Row exists but clock_out was already set — idempotency guard triggered
      logger.db(`Clock-out skipped (already clocked out): entry ${entryId}`)
      return null
    }
    logger.db(`Clock-out saved: entry ${entryId}`)
    return data
  } catch (err) {
    logger.error(`clockOut failed: ${err.message}`)
    return null
  }
}

export async function getOpenEntry(userId, groupId, db = null) {
  if (db?.getOpenEntry) return db.getOpenEntry(userId, groupId)
  try {
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getOpenEntry failed: ${err.message}`)
    return null
  }
}

export async function getTimeEntriesForWeek(groupId, weekStart, db = null) {
  if (db?.getTimeEntriesForWeek) return db.getTimeEntriesForWeek(groupId, weekStart)
  try {
    const start = new Date(`${weekStart}T00:00:00`)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)

    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('group_id', groupId)
      .gte('clock_in', start.toISOString())
      .lt('clock_in', end.toISOString())
      .not('clock_out', 'is', null)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getTimeEntriesForWeek failed: ${err.message}`)
    return []
  }
}

export async function getClockedInNow(groupId, db = null) {
  if (db?.getClockedInNow) return db.getClockedInNow(groupId)
  try {
    const { data, error } = await supabase
      .from('time_entries')
      .select('user_id, staff_id, shift_id, clock_in')
      .eq('group_id', groupId)
      .is('clock_out', null)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getClockedInNow failed: ${err.message}`)
    return []
  }
}

export async function getRecentEntries(userId, groupId, limit = 10, db = null) {
  if (db?.getRecentEntries) return db.getRecentEntries(userId, groupId, limit)
  try {
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .order('clock_in', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getRecentEntries failed: ${err.message}`)
    return []
  }
}
