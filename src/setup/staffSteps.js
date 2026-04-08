import { getShiftsForGroup, getStaffForGroup, saveStaff, deleteStaffForGroup, updateSetupSession } from './setupDb.js'
import { parseStaff } from '../parseMessage.js'
import { logger } from '../logger.js'

export async function handleWelcomeStep(bot, msg, session, text) {
  const restaurantName = text.length > 0 ? text : session.group_name

  await updateSetupSession(session.group_id, {
    step: 'add_shifts',
    setup_data: { ...session.setup_data, restaurant_name: restaurantName },
  })

  await bot.sendMessage(msg.chat.id,
    `✅ Got it — *${restaurantName}*!\n\n` +
    `Now let's add your regular shifts. Describe each one like this:\n\n` +
    `• _Saturday Lunch, 11am–3pm_\n` +
    `• _Friday Close, 6pm–11pm_\n` +
    `• _Monday Brunch, 9am–2pm_\n\n` +
    `Send them one at a time. When you're done, send *done*.`,
    { parse_mode: 'Markdown' })
}

export async function handleAddStaffStep(bot, msg, session, text) {
  if (/^(done|finish|finished|that'?s? it|thats it)$/i.test(text)) {
    const [shifts, staff] = await Promise.all([
      getShiftsForGroup(session.group_id),
      getStaffForGroup(session.group_id),
    ])
    await completeSetup(bot, msg, session, shifts, staff)
    return
  }

  if (/^skip$/i.test(text)) {
    const shifts = await getShiftsForGroup(session.group_id)
    await completeSetup(bot, msg, session, shifts, [])
    return
  }

  const parsed = await parseStaff(text, msg.from?.first_name)
  if (!parsed || parsed.length === 0) {
    await bot.sendMessage(msg.chat.id,
      `I couldn't parse that. Try something like:\n\n_"Mahin and Sapna are cooks, Alex is a server"_\n\nOr send *done* to finish, or *reset* to clear and start over.`,
      { parse_mode: 'Markdown' })
    return
  }

  const results = await Promise.all(parsed.map(s => saveStaff(session.group_id, s.name, s.role)))
  const saved = results.filter(Boolean)

  if (saved.length === 0) {
    await bot.sendMessage(msg.chat.id, `Something went wrong — try again?`)
    return
  }

  const list = parsed.map(s => `• *${s.name}* — ${s.role}`).join('\n')
  await bot.sendMessage(msg.chat.id,
    `✅ Added ${saved.length} staff member${saved.length > 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to finish.`,
    { parse_mode: 'Markdown' })
}

export async function resetStaffStep(bot, chatId, groupId) {
  await deleteStaffForGroup(groupId)
  await bot.sendMessage(chatId,
    `🗑️ All staff cleared. Who works there and what are their roles?\n\n` +
    `_e.g. "Mahin and Sapna are cooks, Alex is a server"_\n\nSend *done* when finished.`,
    { parse_mode: 'Markdown' })
}

async function completeSetup(bot, msg, session, shifts, staff) {
  await updateSetupSession(session.group_id, {
    step: 'complete',
    setup_complete: true,
  })

  const shiftList = shifts.length > 0
    ? shifts.map(s => `• *${s.name}* — ${s.day_of_week}, ${s.start_time}–${s.end_time}`).join('\n')
    : '_None added_'

  const staffList = staff && staff.length > 0
    ? staff.map(s => `• *${s.name}* — ${s.role}`).join('\n')
    : '_None added_'

  await bot.sendMessage(msg.chat.id,
    `✅ *Setup complete!*\n\n*Shifts:*\n${shiftList}\n\n*Staff:*\n${staffList}\n\nRelay is now active in your group.`,
    { parse_mode: 'Markdown' })

  try {
    const managerName = msg.from?.first_name || 'The manager'
    await bot.sendMessage(
      session.group_id,
      `✅ *Relay Setup Complete*\n\n${managerName} has finished configuring Relay for this group.\nI'm now ready to handle shift coverage automatically.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error(`Could not send setup-complete message to group ${session.group_id}: ${err.message}`)
  }

  logger.success(`Setup complete for group ${session.group_id}`)
}
