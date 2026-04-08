import { createClient } from '@supabase/supabase-js'
import { logger } from '../logger.js'
import { formatWeekLabel } from './generateSchedule.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── Live DB functions ─────────────────────────────────────────────────────────

async function _liveSaveReceipt(groupId, staffId, weekStart, dmChatId) {
  try {
    const { data, error } = await supabase
      .from('schedule_receipts')
      .upsert(
        { group_id: groupId, staff_id: staffId, week_start: weekStart, dm_chat_id: String(dmChatId ?? ''), status: 'sent' },
        { onConflict: 'staff_id,week_start' }
      )
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`saveReceipt failed: ${err.message}`)
    return null
  }
}

async function _liveUpdateReceiptStatus(staffId, weekStart, status) {
  try {
    const updates = { status }
    if (status === 'confirmed') updates.confirmed_at = new Date().toISOString()
    const { data, error } = await supabase
      .from('schedule_receipts')
      .update(updates)
      .eq('staff_id', staffId)
      .eq('week_start', weekStart)
      .eq('status', 'sent')
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`updateReceiptStatus failed: ${err.message}`)
    return null
  }
}

async function _liveGetPendingReceipt(chatId) {
  try {
    const { data, error } = await supabase
      .from('schedule_receipts')
      .select('*')
      .eq('dm_chat_id', String(chatId))
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getPendingReceipt failed: ${err.message}`)
    return null
  }
}

async function _liveGetUnconfirmedStaff(groupId, weekStart) {
  try {
    const { data, error } = await supabase
      .from('schedule_receipts')
      .select('staff_id, dm_chat_id, staff:staff(name)')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .eq('status', 'sent')
    if (error) throw error
    return (data ?? []).map(r => ({
      id: r.staff_id,
      name: r.staff?.name ?? 'Unknown',
      dmChatId: r.dm_chat_id,
    }))
  } catch (err) {
    logger.error(`getUnconfirmedStaff DB failed: ${err.message}`)
    return []
  }
}

// ── Exported functions ────────────────────────────────────────────────────────

// Returns true if DM text is a schedule confirmation
export function isReceiptConfirmation(text) {
  return /got it|gotit|👍|confirmed/i.test((text ?? '').trim())
}

export async function sendPersonalSchedule(bot, groupId, staffMember, assignments, weekStart, db = null) {
  const _saveReceipt = db?.saveReceipt ?? _liveSaveReceipt

  const myShifts = assignments.filter(a => a.staffId === staffMember.id)
  const weekLabel = formatWeekLabel(weekStart)

  if (staffMember.dmChatId) {
    let text
    if (myShifts.length === 0) {
      text = `👋 You're not scheduled next week. Enjoy the time off!`
    } else {
      const lines = myShifts.map(s => `• ${s.dayOfWeek} — ${s.shiftName}, ${s.startTime}–${s.endTime}`).join('\n')
      text = `📅 *Your schedule for week of ${weekLabel}*\n\n${lines}\n\nReply *got it* to confirm you've seen this 👍`
    }
    await bot.sendMessage(staffMember.dmChatId, text, { parse_mode: 'Markdown' })
  }

  await _saveReceipt(groupId, staffMember.id, weekStart, staffMember.dmChatId)
}

export async function handleReceiptConfirmation(bot, msg, db = null) {
  const _getPendingReceipt = db?.getPendingReceipt ?? _liveGetPendingReceipt
  const _updateReceiptStatus = db?.updateReceiptStatus ?? _liveUpdateReceiptStatus

  const chatId = msg.chat.id
  const receipt = await _getPendingReceipt(chatId)
  if (!receipt) return

  await _updateReceiptStatus(receipt.staff_id, receipt.week_start, 'confirmed')
  await bot.sendMessage(chatId, `✅ Got it! You're confirmed for next week.`)
}

export async function getUnconfirmedStaff(groupId, weekStart, db = null) {
  const _getUnconfirmedStaff = db?.getUnconfirmedStaff ?? _liveGetUnconfirmedStaff
  return _getUnconfirmedStaff(groupId, weekStart)
}

export async function sendReceiptReminders(bot, groupId, weekStart, db = null) {
  const unconfirmed = await getUnconfirmedStaff(groupId, weekStart, db)

  let count = 0
  for (const staff of unconfirmed) {
    if (!staff.dmChatId) continue
    try {
      await bot.sendMessage(
        staff.dmChatId,
        `👋 Hey ${staff.name} — just a reminder to confirm your schedule for next week. Reply *got it* when you've seen it.`,
        { parse_mode: 'Markdown' }
      )
      count++
    } catch (err) {
      logger.error(`Could not send reminder to ${staff.name}: ${err.message}`)
    }
  }

  return count
}
