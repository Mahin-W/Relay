import { getGroupMembersWithDm } from '../db.js'
import { getSetupSession, getShiftsForGroup } from '../setup/setupDb.js'
import {
  createAvailabilitySession,
  getAvailabilitySessionForUserWeek,
  saveAvailability,
  updateAvailabilitySessionStatus,
  getPendingSessionsForGroup,
  getAllSessionsForGroup,
} from './availabilityDb.js'
import { getNextWeekStart, formatWeekLabel } from '../schedule/generateSchedule.js'
import { logger } from '../logger.js'

const DAY_ORDER = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 }

// Build the numbered shift list and shift_map for a group.
// shiftMap: { "1": { id, name, day_of_week, start_time, end_time }, ... }
function buildShiftMap(shifts) {
  const sorted = [...shifts].sort(
    (a, b) => (DAY_ORDER[a.day_of_week] ?? 8) - (DAY_ORDER[b.day_of_week] ?? 8)
  )
  const shiftMap = {}
  sorted.forEach((s, i) => {
    shiftMap[String(i + 1)] = {
      id: s.id,
      name: s.name,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
    }
  })
  return shiftMap
}

// Format the numbered shift list for display in a DM
function formatShiftList(shiftMap) {
  return Object.entries(shiftMap)
    .map(([n, s]) => `${n}. ${s.day_of_week} — ${s.name} (${s.start_time}–${s.end_time})`)
    .join('\n')
}

// Called when manager types /availability in the group
export async function startAvailabilityCollection(bot, msg, groupId, botUsername) {
  const setupSession = await getSetupSession(groupId)
  if (!setupSession?.setup_complete) {
    await bot.sendMessage(msg.chat.id, `⚠️ Please complete setup first with /setup.`)
    return
  }

  const shifts = await getShiftsForGroup(groupId)
  if (shifts.length === 0) {
    await bot.sendMessage(msg.chat.id, `⚠️ No shifts are configured yet. Complete setup first.`)
    return
  }

  const weekStart = getNextWeekStart()
  const weekLabel = formatWeekLabel(weekStart)
  const restaurantName = setupSession.setup_data?.restaurant_name || setupSession.group_name
  const managerName = msg.from?.first_name || 'The manager'
  const shiftMap = buildShiftMap(shifts)
  const shiftListText = formatShiftList(shiftMap)

  // Post to group
  await bot.sendMessage(
    msg.chat.id,
    `📅 *Collecting availability for next week (${weekLabel})*\n\nI'm DMing each team member now. I'll update you on who still needs to respond.`,
    { parse_mode: 'Markdown' }
  )

  const dmPool = await getGroupMembersWithDm(groupId)

  // Always include the manager — they have a dm_chat_id in the setup session
  // even if they never sent a plain /start. Add them if not already in the pool.
  if (setupSession.manager_id && setupSession.dm_chat_id) {
    const managerInPool = dmPool.some(m => m.userId === setupSession.manager_id)
    if (!managerInPool) {
      dmPool.push({
        userId: setupSession.manager_id,
        firstName: msg.from?.first_name || 'Manager',
        dmChatId: setupSession.dm_chat_id,
      })
    }
  }

  if (dmPool.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      `⚠️ No staff have registered yet. Ask everyone to message @${botUsername} to get started.`
    )
    return
  }

  const unreachable = []
  let dmedCount = 0
  let alreadyResponded = 0

  for (const member of dmPool) {
    const existing = await getAvailabilitySessionForUserWeek(member.userId, weekStart)

    if (existing?.status === 'responded') {
      alreadyResponded++
      continue
    }

    // Send DM — whether new or a reminder to a pending user
    const isReminder = existing?.status === 'pending'
    const dmText = buildAvailabilityDm(member.firstName, managerName, restaurantName, weekLabel, shiftListText, isReminder)

    try {
      await bot.sendMessage(member.dmChatId, dmText, { parse_mode: 'Markdown' })
      await createAvailabilitySession(member.userId, groupId, member.dmChatId, weekStart, shiftMap)
      dmedCount++
      logger.bot(`Availability DM ${isReminder ? '(reminder) ' : ''}sent to ${member.firstName}`)
    } catch (err) {
      logger.error(`Could not DM ${member.firstName}: ${err.message}`)
      unreachable.push(member.firstName)
    }
  }

  // Post status to group
  const allSessions = await getAllSessionsForGroup(groupId, weekStart)
  const totalAsked = allSessions.length
  const respondedCount = allSessions.filter(s => s.status === 'responded').length + alreadyResponded
  const pendingCount = totalAsked - respondedCount

  let statusMsg = `📬 Availability requests sent to ${dmedCount} team member${dmedCount !== 1 ? 's' : ''}.`
  if (alreadyResponded > 0) statusMsg += ` (${alreadyResponded} already responded.)`

  if (pendingCount > 0) {
    statusMsg += `\n\nStill waiting on *${pendingCount}* response${pendingCount !== 1 ? 's' : ''}. Run */availability* again to send reminders.`
  }

  if (unreachable.length > 0) {
    statusMsg +=
      `\n\n⚠️ Couldn't reach: ${unreachable.map(n => `*${n}*`).join(', ')}.\nAsk them to message *@${botUsername}* first.`
  }

  await bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'Markdown' })
}

function buildAvailabilityDm(firstName, managerName, restaurantName, weekLabel, shiftListText, isReminder) {
  const opener = isReminder
    ? `👋 Hi ${firstName}! Just a reminder — ${managerName} at *${restaurantName}* still needs your availability for next week.`
    : `👋 Hi ${firstName}! ${managerName} at *${restaurantName}* is building next week's schedule.`

  return (
    `${opener}\n\n` +
    `📅 *Next week: ${weekLabel}*\n\n` +
    `Which shifts can you work? Reply with the shift numbers:\n\n` +
    `${shiftListText}\n\n` +
    `• Reply with numbers like *1 3 5*\n` +
    `• Or *all* to work every shift\n` +
    `• Or *off* if you can't work next week at all`
  )
}

// Called when a DM comes in and there's a pending availability session
export async function handleAvailabilityReply(bot, msg, session) {
  const userId = msg.from?.id
  const text = msg.text?.trim()
  if (!text || !userId) return

  const lower = text.toLowerCase()
  const shiftMap = session.shift_map ?? {}

  // ── Unavailable ──────────────────────────────────────────────────────────────
  if (/^(off|can'?t|no|nope|none|unavailable|not available|busy all week)$/i.test(lower)) {
    await saveAvailability(userId, session.group_id, session.week_start, [], false, true, text)
    await updateAvailabilitySessionStatus(userId, session.week_start, 'responded')
    await bot.sendMessage(msg.chat.id, `Got it — you're off next week. Rest up! 😊`)
    logger.bot(`User ${userId} marked unavailable for week ${session.week_start}`)
    await checkAllResponded(bot, session)
    return
  }

  // ── All shifts ───────────────────────────────────────────────────────────────
  if (/^(all|all shifts|every shift|every day|all week|available all|yes all)$/i.test(lower)) {
    const allShiftIds = Object.values(shiftMap).map(s => Number(s.id))
    await saveAvailability(userId, session.group_id, session.week_start, allShiftIds, true, false, text)
    await updateAvailabilitySessionStatus(userId, session.week_start, 'responded')
    await bot.sendMessage(
      msg.chat.id,
      `✅ Got it — you're available for *all shifts* next week!`,
      { parse_mode: 'Markdown' }
    )
    logger.bot(`User ${userId} available all shifts for week ${session.week_start}`)
    await checkAllResponded(bot, session)
    return
  }

  // ── Numbered selection ───────────────────────────────────────────────────────
  const numbers = (text.match(/\d+/g) ?? []).map(String)
  const matchedShifts = numbers
    .filter(n => shiftMap[n])
    .map(n => shiftMap[n])

  if (matchedShifts.length === 0) {
    const shiftListText = formatShiftList(shiftMap)
    await bot.sendMessage(
      msg.chat.id,
      `I didn't catch that. Reply with shift numbers:\n\n${shiftListText}\n\n` +
      `• Numbers like *1 3 5*\n• *all* for every shift\n• *off* if you can't work`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  const shiftIds = matchedShifts.map(s => Number(s.id))
  await saveAvailability(userId, session.group_id, session.week_start, shiftIds, false, false, text)
  await updateAvailabilitySessionStatus(userId, session.week_start, 'responded')

  await bot.sendMessage(
    msg.chat.id,
    `✅ Got it! I'll factor that in when building the schedule. I'll DM you your assigned shifts once it's ready.`
  )

  logger.bot(`User ${userId} available for ${shiftIds.length} shift(s) week ${session.week_start}`)
  await checkAllResponded(bot, session)
}

async function checkAllResponded(bot, session) {
  try {
    const pending = await getPendingSessionsForGroup(session.group_id, session.week_start)
    if (pending.length > 0) return

    const weekLabel = formatWeekLabel(session.week_start)
    const setupSession = await getSetupSession(session.group_id)

    if (setupSession?.dm_chat_id) {
      await bot.sendMessage(
        setupSession.dm_chat_id,
        `✅ All staff have responded for *${weekLabel}*!\n\nRun */makeschedule* in the group to generate the schedule.`,
        { parse_mode: 'Markdown' }
      )
    }

    await bot.sendMessage(
      session.group_id,
      `✅ All availability collected for ${weekLabel}! Run */makeschedule* to generate the schedule.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error(`checkAllResponded failed: ${err.message}`)
  }
}
