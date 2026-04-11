import { logger } from '../logger.js'
import { getCoverageResponseStats } from './coverageSpeed.js'

export function rankAvailableStaff(staff, coverageStats) {
  if (!staff || staff.length === 0) return []

  const statsMap = new Map()
  for (const s of coverageStats) {
    statsMap.set(s.staffName ?? s.name, s)
  }

  const ranked = staff.map(s => {
    const stats = statsMap.get(s.staffName)
    const hoursScore = Math.max(0, 1 - (s.hoursThisWeek / 40))
    let reliabilityScore = 0.5
    let speedScore = 0.5
    let reason = `${s.hoursThisWeek}hrs this week`

    if (stats) {
      reliabilityScore = stats.actualReliability ?? 0.5
      speedScore = Math.max(0, 1 - ((stats.avgResponseMinutes ?? 30) / 60))
      reason = `fast responder avg ${Math.round(stats.avgResponseMinutes)}min`
    }

    const score = (reliabilityScore * 0.5) + (speedScore * 0.3) + (hoursScore * 0.2)

    return {
      staffId: s.staffId,
      staffName: s.staffName,
      roleName: s.roleName,
      hoursThisWeek: s.hoursThisWeek,
      avgResponseMinutes: stats?.avgResponseMinutes ?? null,
      availabilityConfidence: stats ? 'high' : 'unknown',
      score,
      reason,
    }
  })

  ranked.sort((a, b) => b.score - a.score)
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }))
}

export async function getAvailableNow(groupId, shiftId, now = new Date(), db = null) {
  const _getAllStaff = db?.getAllStaffForGroup ?? (async () => [])
  const _getActiveIds = db?.getActiveStaffIds ?? (async () => [])
  const _getHours = db?.getWeeklyHours ?? (async () => ({}))

  const [allStaff, activeIds, hours] = await Promise.all([
    _getAllStaff(groupId),
    _getActiveIds(groupId, now),
    _getHours(groupId),
  ])

  const activeSet = new Set(activeIds.map(String))

  const available = allStaff
    .filter(s => !activeSet.has(String(s.id)))
    .filter(s => (hours[s.id] ?? 0) < 40)
    .map(s => ({
      staffId: s.id,
      staffName: s.name,
      roleName: s.role_name || 'Staff',
      hoursThisWeek: hours[s.id] ?? 0,
    }))

  const coverageStats = await getCoverageResponseStats(groupId, db)
  return rankAvailableStaff(available, coverageStats)
}

export function formatEmergencyResponse(rankedStaff, shiftName, timeUntilShift) {
  if (!rankedStaff || rankedStaff.length === 0) {
    return (
      `⚠️ *No staff appear available.* Everyone is either on shift, over hours, or has no response history.\n\n` +
      `You may need to call individually.`
    )
  }

  const lines = [`🚨 *Available for ${shiftName} in ${timeUntilShift}min:*`, '']
  for (const s of rankedStaff.slice(0, 5)) {
    lines.push(`${s.rank}. ${s.staffName} (${s.roleName}) — ${s.reason}`)
  }
  lines.push('')
  lines.push(`Sending coverage request to top ${Math.min(3, rankedStaff.length)} now.`)
  return lines.join('\n')
}

export async function handleEmergencyQuery(bot, msg, db = null) {
  const _getManagerGroup = db?.getManagerGroup ?? (async () => null)
  const _getNextShift = db?.getNextUpcomingShift ?? (async () => null)
  const _getMembers = db?.getGroupMembersWithDm ?? (async () => [])

  const chatId = String(msg.chat.id)

  const managerGroup = await _getManagerGroup(msg.from?.id)
  if (!managerGroup) {
    await bot.sendMessage(chatId, "I don't know which group you manage. Run /start in your group first.")
    return
  }

  const groupId = typeof managerGroup === 'string' ? managerGroup : managerGroup.group_id

  const nextShift = await _getNextShift(groupId)
  if (!nextShift) {
    await bot.sendMessage(chatId, 'No shifts left today — nothing to cover.')
    return
  }

  const timeUntilShift = 45
  const ranked = await getAvailableNow(groupId, nextShift.id ?? 0, new Date(), db)
  const response = formatEmergencyResponse(ranked, nextShift.name || 'upcoming shift', timeUntilShift)

  await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' })

  // DM top 3 immediately
  const members = await _getMembers(groupId)
  const top3 = ranked.slice(0, 3)

  for (const staff of top3) {
    const member = members.find(m =>
      String(m.userId) === String(staff.staffId) || m.firstName === staff.staffName
    )
    if (!member?.dmChatId) continue
    try {
      await bot.sendMessage(member.dmChatId,
        `🚨 *Emergency coverage needed* for *${nextShift.name || 'shift'}* — needed ASAP.\n\nCan you come in? Reply *yes* or *no*.`,
        { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`Emergency DM to ${staff.staffName} failed: ${err.message}`)
    }
  }

  if (top3.length > 0) {
    const names = top3.map(s => s.staffName).join(', ')
    await bot.sendMessage(chatId, `📬 Coverage request sent to: ${names}`)
  }
}
