import { getDb } from '../db.js'
import { logger } from '../logger.js'

async function liveQuery(sql, params) {
  const { data, error } = await getDb().rpc('exec_sql', { sql, params })
  if (error) throw error
  return data
}

export async function getActiveStaff(groupId, db = null) {
  try {
    if (db?.getActiveStaff) return db.getActiveStaff(groupId)
    const _query = db?.query ?? liveQuery
    const { rows } = await _query(
      'SELECT * FROM staff WHERE group_id=$1 AND active=true ORDER BY name ASC',
      [groupId]
    )
    return rows ?? []
  } catch (err) {
    logger.error(`getActiveStaff failed: ${err.message}`)
    return []
  }
}

export async function deactivateStaff(staffId, groupId, db = null) {
  try {
    const _query = db?.query ?? liveQuery
    await _query(
      'UPDATE staff SET active=false WHERE id=$1 AND group_id=$2',
      [staffId, groupId]
    )
    return true
  } catch (err) {
    logger.error(`deactivateStaff failed: ${err.message}`)
    return false
  }
}

export async function cancelFutureAssignments(staffId, db = null) {
  try {
    const _query = db?.query ?? liveQuery
    await _query(
      "UPDATE schedule_assignments SET status='cancelled' WHERE staff_id=$1 AND week_start >= CURRENT_DATE",
      [staffId]
    )
    return true
  } catch (err) {
    logger.error(`cancelFutureAssignments failed: ${err.message}`)
    return false
  }
}

export function formatStaffList(staff) {
  if (!staff || staff.length === 0) return 'No staff registered yet.'
  const lines = staff.map((s, i) => `${i + 1}. ${s.name} — ${s.role}`).join('\n')
  return `👥 *Staff (${staff.length} active):*\n${lines}\n\n/removestaff [n] to remove`
}

const REMOVAL_WORDS = [
  'remove',
  'fire',
  'fired',
  'quit',
  'no longer works here',
  'left the team',
  "doesn't work here anymore",
  "doesnt work here anymore",
  'leaving',
]

export function detectStaffRemoval(text, staffNames) {
  const lower = text.toLowerCase()
  const hasRemovalWord = REMOVAL_WORDS.some(w => lower.includes(w))
  if (!hasRemovalWord) return null
  for (const name of staffNames) {
    if (lower.includes(name.toLowerCase())) return name
  }
  return null
}

export function fuzzyFindStaff(query, staff) {
  const trimmed = query.trim()
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1
    return (idx >= 0 && idx < staff.length) ? staff[idx] : null
  }
  const q = trimmed.toLowerCase()
  return staff.find(s => s.name.toLowerCase().includes(q)) ?? null
}

function waitForReply(bot, chatId, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    bot.once('message', (reply) => {
      if (String(reply.chat.id) === String(chatId)) {
        clearTimeout(timer)
        resolve(reply)
      }
    })
  })
}

export async function handleViewStaff(bot, msg, db = null) {
  try {
    const groupId = msg.chat.id
    const staff = await getActiveStaff(groupId, db)
    const text = formatStaffList(staff)
    await bot.sendMessage(groupId, text, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error(`handleViewStaff failed: ${err.message}`)
  }
}

export async function handleRemoveStaff(bot, msg, args, db = null) {
  try {
    const chatId = msg.chat.id
    const groupId = msg.chat.id

    const staff = await getActiveStaff(groupId, db)
    const found = fuzzyFindStaff(args, staff)

    if (!found) {
      await bot.sendMessage(chatId, "Couldn't find that person. Use /staff to see the list.")
      return
    }

    await bot.sendMessage(
      chatId,
      `Remove ${found.name} (${found.role})?\nThey won't get schedules or coverage requests.\nPay history is kept.\nReply yes to confirm.`
    )

    const reply = await waitForReply(bot, chatId)
    if (!reply) return

    if (reply.text?.toLowerCase().trim() === 'yes') {
      await deactivateStaff(found.id, groupId, db)
      await cancelFutureAssignments(found.id, db)
      await bot.sendMessage(groupId, `${found.name} has left Relay 👋`)
    } else {
      await bot.sendMessage(chatId, 'Cancelled.')
    }
  } catch (err) {
    logger.error(`handleRemoveStaff failed: ${err.message}`)
  }
}
