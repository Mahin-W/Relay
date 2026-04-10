import { getNextWeekStart as liveGetNextWeekStart, formatScheduleMessage } from './generateSchedule.js'
import { getPublishedSchedule, saveGeneratedSchedule as liveSaveGeneratedSchedule } from '../availability/availabilityDb.js'
import { getStaffForGroup as liveGetStaffForGroup, getSetupSession as liveGetSetupSession } from '../setup/setupDb.js'
import { logger } from '../logger.js'

export { getNextWeekStart } from './generateSchedule.js'

export async function getPreviousWeekSchedule(groupId, db = null) {
  const _getPublishedSchedule = db?.getPreviousWeekSchedule ?? (() => getPublishedSchedule(groupId))
  const data = await _getPublishedSchedule()
  if (!data) return null
  return {
    assignments: data.assignments ?? [],
    weekStart: data.week_start,
    id: data.id,
  }
}

/**
 * Pure — clones assignments with new weekStart and status='scheduled'.
 */
export function buildCopiedSchedule(previousAssignments, newWeekStart) {
  return previousAssignments.map(a => ({
    ...a,
    weekStart: newWeekStart,
    status: 'scheduled',
  }))
}

/**
 * Pure — splits copied assignments into valid (staff still active) and stale (removed).
 */
export function detectStaleAssignments(copiedAssignments, activeStaff) {
  const activeIds = new Set(activeStaff.map(s => s.id))
  const valid = copiedAssignments.filter(a => activeIds.has(a.staffId))
  const stale = copiedAssignments.filter(a => !activeIds.has(a.staffId))
  return { valid, stale }
}

export async function handleCopySchedule(bot, msg, db = null) {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return

  const groupId = String(msg.chat.id)
  const userId = msg.from?.id

  // Admin check
  try {
    const member = await bot.getChatMember(groupId, userId)
    const isAdmin = ['creator', 'administrator'].includes(member?.status)
    if (!isAdmin) {
      await bot.sendMessage(groupId, '⚠️ Only admins can copy the schedule.')
      return
    }
  } catch {
    await bot.sendMessage(groupId, '⚠️ Only admins can copy the schedule.')
    return
  }

  const _getPreviousWeekSchedule = db?.getPreviousWeekSchedule ?? (() => getPublishedSchedule(groupId).then(d => d ? { assignments: d.assignments ?? [], weekStart: d.week_start, id: d.id } : null))
  const _saveGeneratedSchedule = db?.saveGeneratedSchedule ?? liveSaveGeneratedSchedule
  const _getStaffForGroup = db?.getStaffForGroup ?? (() => liveGetStaffForGroup(groupId))
  const _getSetupSession = db?.getSetupSession ?? (() => liveGetSetupSession(groupId))

  const prev = await _getPreviousWeekSchedule()
  if (!prev) {
    await bot.sendMessage(groupId,
      'No published schedule found to copy. Use /makeschedule to generate a new one.')
    return
  }

  const newWeekStart = liveGetNextWeekStart()
  const copied = buildCopiedSchedule(prev.assignments, newWeekStart)
  const activeStaff = await _getStaffForGroup()
  const { valid, stale } = detectStaleAssignments(copied, activeStaff)

  await _saveGeneratedSchedule(groupId, newWeekStart, valid, [], 'draft')

  const session = await _getSetupSession()
  if (!session?.dm_chat_id) {
    logger.error('handleCopySchedule: no dm_chat_id for group ' + groupId)
    return
  }

  const scheduleText = formatScheduleMessage(valid, [], newWeekStart)
  const staleText = stale.length > 0
    ? `\n⚠️ *Removed (no longer active):*\n${stale.map(s => `• ${s.staffName} — was on ${s.shiftName}`).join('\n')}`
    : ''

  await bot.sendMessage(session.dm_chat_id,
    `📋 *Draft — copied from last week*\n\n${scheduleText}${staleText}\n\nReply *approve* to publish, or *regenerate* to build from scratch.`,
    { parse_mode: 'Markdown' })
}
