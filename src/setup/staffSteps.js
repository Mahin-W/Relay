import { getShiftsForGroup, getStaffForGroup, saveStaff, deleteStaffForGroup, updateSetupSession } from './setupDb.js'
import { startPhoneStep } from './phoneSteps.js'
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
    await startPhoneStep(bot, msg.chat.id, session.group_id)
    return
  }

  if (/^skip$/i.test(text)) {
    await startPhoneStep(bot, msg.chat.id, session.group_id)
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

