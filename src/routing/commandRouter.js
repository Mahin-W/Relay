import { getSetupSession, getBotAdmins, addBotAdmin, removeBotAdmin } from '../setup/setupDb.js'
import { startAvailabilityCollection } from '../availability/collectAvailability.js'
import { resetAvailabilityForGroup, getPublishedSchedule } from '../availability/availabilityDb.js'
import { generateWeeklySchedule, formatScheduleMessage, getNextWeekStart, formatWeekLabel } from '../schedule/generateSchedule.js'
import { getManagerGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'
import { formatClopeningWarning } from '../schedule/clopen.js'
import { calculateWeeklyHours, formatHoursWarning } from '../schedule/hoursTracker.js'
import { getUnconfirmedStaff } from '../schedule/readReceipts.js'

// Returns true if a command was handled, false otherwise
export async function handleGroupCommands(bot, msg, cmd, BOT_USERNAME, isAuthorizedAdmin, isGroupAdmin) {
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const senderName = msg.from?.first_name || 'Someone'
  const groupName = msg.chat.title || 'Unknown Group'

  if (cmd('register')) {
    if (!BOT_USERNAME) { await bot.sendMessage(msg.chat.id, `⚠️ Bot is still starting up — try again in a moment.`); return true }
    const link = `https://t.me/${BOT_USERNAME}?start=register_${groupId}`
    await bot.sendMessage(msg.chat.id,
      `📲 *Staff Registration Link*\n\nShare this with any team members who haven't registered:\n\n👉 [Click to register with Relay](${link})\n\nOnce they click it, I'll be able to DM them about availability and schedules.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true })
    return true
  }

  if (cmd('availability')) {
    const admin = await isAuthorizedAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can collect availability.`); return true }
    try { await startAvailabilityCollection(bot, msg, groupId, BOT_USERNAME) } catch (err) {
      logger.error(`startAvailabilityCollection failed: ${err.message}`)
    }
    return true
  }

  if (cmd('resetavailability')) {
    const admin = await isAuthorizedAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can reset availability.`); return true }
    try {
      await resetAvailabilityForGroup(groupId, getNextWeekStart())
      await bot.sendMessage(msg.chat.id, `🗑️ Availability reset for next week. Run */availability* again to start fresh.`, { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`resetAvailability failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return true
  }

  if (cmd('makeschedule')) {
    const admin = await isAuthorizedAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can generate the schedule.`); return true }
    const managerGroup = await getManagerGroup(userId)
    if (!managerGroup?.dm_chat_id) {
      await bot.sendMessage(msg.chat.id, `⚠️ I need to be able to DM the manager. Please DM me at @${BOT_USERNAME} first.`)
      return true
    }
    await bot.sendMessage(msg.chat.id, `⏳ Generating schedule...`)
    try {
      const weekStart = getNextWeekStart()
      const schedule = await generateWeeklySchedule(groupId, weekStart)
      const formatted = formatScheduleMessage(schedule.assignments, schedule.gaps, weekStart)
      const clopeningWarn = formatClopeningWarning(schedule.clopenings ?? [])
      const hoursWarn = formatHoursWarning(schedule.hoursIssues ?? { overtime: [], underScheduled: [] })
      const hasWarnings = clopeningWarn || hoursWarn
      const reviewPrompt = hasWarnings
        ? `Reply *approve anyway* to publish despite warnings, *approve* if you've fixed them, or *regenerate* for a different arrangement.`
        : `Reply *approve* to publish, or *regenerate* for a different arrangement.`
      await bot.sendMessage(managerGroup.dm_chat_id,
        `📋 *Draft Schedule Ready*\n\n${formatted}${clopeningWarn}${hoursWarn}\n${reviewPrompt}`,
        { parse_mode: 'Markdown' })
      await bot.sendMessage(msg.chat.id, `📋 Draft schedule sent to the manager for review.`)
    } catch (err) {
      logger.error(`makeschedule failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong generating the schedule — try again.`)
    }
    return true
  }

  if (cmd('schedule')) {
    try {
      const schedule = await getPublishedSchedule(groupId)
      if (!schedule) {
        await bot.sendMessage(msg.chat.id, `No published schedule yet. Run */makeschedule* to generate one.`, { parse_mode: 'Markdown' })
      } else {
        const formatted = formatScheduleMessage(schedule.assignments ?? [], schedule.gaps ?? [], schedule.week_start)
        await bot.sendMessage(msg.chat.id, `📋 *Current Schedule*\n\n${formatted}`, { parse_mode: 'Markdown' })
      }
    } catch (err) {
      logger.error(`/schedule failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return true
  }

  if (cmd('receipts')) {
    const admin = await isAuthorizedAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can check receipt status.`); return true }
    try {
      const weekStart = getNextWeekStart()
      const unconfirmed = await getUnconfirmedStaff(groupId, weekStart)
      if (unconfirmed.length === 0) {
        await bot.sendMessage(msg.chat.id, `✅ All staff have confirmed next week's schedule.`)
      } else {
        const names = unconfirmed.map(s => `• ${s.name}`).join('\n')
        await bot.sendMessage(msg.chat.id, `⏳ *Awaiting confirmation from:*\n${names}`, { parse_mode: 'Markdown' })
      }
    } catch (err) {
      logger.error(`/receipts failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return true
  }

  if (cmd('hours')) {
    const admin = await isAuthorizedAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can view hour summaries.`); return true }
    try {
      const schedule = await getPublishedSchedule(groupId)
      if (!schedule) {
        await bot.sendMessage(msg.chat.id, `No published schedule yet. Run */makeschedule* to generate one.`, { parse_mode: 'Markdown' })
        return true
      }
      const hoursMap = calculateWeeklyHours(schedule.assignments ?? [], [])
      const entries = Object.values(hoursMap).sort((a, b) => b.totalHours - a.totalHours)
      if (entries.length === 0) {
        await bot.sendMessage(msg.chat.id, `No scheduled hours found for this week.`)
        return true
      }
      const weekLabel = formatWeekLabel(schedule.week_start)
      const lines = entries.map(e =>
        `${e.staffName}: ${e.totalHours.toFixed(1)} hrs (${e.shiftCount} shift${e.shiftCount !== 1 ? 's' : ''})`
      ).join('\n')
      const totalHours = entries.reduce((sum, e) => sum + e.totalHours, 0)
      await bot.sendMessage(msg.chat.id,
        `📊 *Scheduled hours — week of ${weekLabel}*\n\n${lines}\n\nTotal: ${totalHours.toFixed(1)} hrs across ${entries.length} staff`,
        { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`/hours failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return true
  }

  if (cmd('addadmin')) {
    const setupSession = await getSetupSession(groupId)
    if (!setupSession?.setup_complete || String(setupSession.manager_id) !== String(userId)) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only the manager who set up Relay can add admins.`); return true
    }
    const target = msg.reply_to_message?.from
    if (!target || target.is_bot) { await bot.sendMessage(msg.chat.id, `Reply to someone's message with /addadmin to grant them admin access.`); return true }
    if (String(target.id) === String(userId)) { await bot.sendMessage(msg.chat.id, `You're already the manager 😄`); return true }
    const result = await addBotAdmin(groupId, target.id, target.first_name)
    if (result === 'already') {
      await bot.sendMessage(msg.chat.id, `${target.first_name} is already a Relay admin.`)
    } else {
      await bot.sendMessage(msg.chat.id, `✅ *${target.first_name}* is now a Relay admin and can run scheduling commands.`, { parse_mode: 'Markdown' })
      logger.bot(`${senderName} added ${target.first_name} as bot admin in ${groupName}`)
    }
    return true
  }

  if (cmd('removeadmin')) {
    const setupSession = await getSetupSession(groupId)
    if (!setupSession?.setup_complete || String(setupSession.manager_id) !== String(userId)) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only the manager who set up Relay can remove admins.`); return true
    }
    const target = msg.reply_to_message?.from
    if (!target || target.is_bot) { await bot.sendMessage(msg.chat.id, `Reply to someone's message with /removeadmin to revoke their admin access.`); return true }
    const result = await removeBotAdmin(groupId, target.id)
    if (result === 'not_found') {
      await bot.sendMessage(msg.chat.id, `${target.first_name} isn't a Relay admin.`)
    } else {
      await bot.sendMessage(msg.chat.id, `✅ *${target.first_name}* no longer has Relay admin access.`, { parse_mode: 'Markdown' })
      logger.bot(`${senderName} removed ${target.first_name} as bot admin in ${groupName}`)
    }
    return true
  }

  if (cmd('admins')) {
    const botAdmins = await getBotAdmins(groupId)
    if (botAdmins.length === 0) {
      await bot.sendMessage(msg.chat.id, `No additional Relay admins set.\n\nReply to someone's message with /addadmin to grant them access.`)
    } else {
      const list = botAdmins.map(a => `• ${a.firstName}`).join('\n')
      await bot.sendMessage(msg.chat.id, `👤 *Relay Admins*\n\n${list}`, { parse_mode: 'Markdown' })
    }
    return true
  }

  if (cmd('setup')) {
    if (!BOT_USERNAME) { await bot.sendMessage(msg.chat.id, `⚠️ Bot is still starting up — try again in a moment.`); return true }
    const existingSession = await getSetupSession(groupId)
    if (existingSession?.setup_complete && existingSession.manager_id !== userId) {
      const managerDm = existingSession.dm_chat_id
      if (managerDm) {
        try {
          await bot.sendMessage(managerDm,
            `⚠️ *Heads up!*\n\n*${senderName}* just tried to run */setup* in *${groupName}*.\n\nIf you didn't authorize this, check your group admin settings.`,
            { parse_mode: 'Markdown' })
        } catch (err) { logger.error(`Could not notify manager: ${err.message}`) }
      }
      await bot.sendMessage(msg.chat.id, `⚠️ Relay is already configured for this group. The original manager has been notified.`)
      return true
    }
    const admin = await isGroupAdmin(groupId, userId)
    if (!admin) { await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can set up Relay.`); return true }
    const deepLink = `https://t.me/${BOT_USERNAME}?start=setup_${groupId}`
    await bot.sendMessage(msg.chat.id,
      `Hi ${senderName}! I'll walk you through setup in a private chat.\n\n👉 [Click here to open our DM](${deepLink})\n\nOnce you've completed setup there, I'll be ready to go here.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true })
    return true
  }

  if (cmd('commands') || cmd('help')) {
    await bot.sendMessage(msg.chat.id,
      `📋 *Relay — Commands & Features*\n\n` +

      `*Setup & Registration*\n` +
      `• /setup — Configure Relay for this group _(group admins only)_\n` +
      `• /register — Get a link for staff to register with the bot\n\n` +

      `*Scheduling*\n` +
      `• /availability — DM all staff to collect availability _(admins only)_\n` +
      `• /resetavailability — Wipe availability and start fresh _(admins only)_\n` +
      `• /makeschedule — Generate a draft schedule for manager review _(admins only)_\n` +
      `• /schedule — View the current published schedule\n\n` +

      `*Admin Management*\n` +
      `• /addadmin — Reply to someone's message to grant them admin access _(manager only)_\n` +
      `• /removeadmin — Reply to someone's message to revoke admin access _(manager only)_\n` +
      `• /admins — List all current Relay admins\n\n` +

      `*Natural Language — just type naturally:*\n` +
      `• _"Can't make my Friday shift"_ → posts coverage request + DMs staff\n` +
      `• _"I can cover"_ / _"bet"_ / _"igu"_ / 👍 → volunteers for open shift\n` +
      `• _"trade my Monday shift"_ → proposes a shift trade (or resolves open coverage via swap)\n` +
      `• _"never mind, I found someone"_ → cancels your open coverage request\n\n` +

      `*In DMs with the bot:*\n` +
      `• Reply *yes* when asked about a coverage request to volunteer\n` +
      `• Reply *"trade my [shift]"* when asked about coverage to propose a swap instead`,
      { parse_mode: 'Markdown' })
    return true
  }

  return false
}
