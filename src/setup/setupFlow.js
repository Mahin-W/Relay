import { createSetupSession } from './setupDb.js'
import { logger } from '../logger.js'
import { handleWelcomeStep, handleAddStaffStep, resetStaffStep } from './staffSteps.js'
import { handleAddShiftsStep, handleShiftRolesStep, resetShiftStep, resetShiftRolesStep, moveToStaffStepShared } from './shiftSteps.js'

export async function startSetupDM(bot, msg, groupId) {
  const managerId = msg.from.id
  const dmChatId = msg.chat.id
  const managerName = msg.from.first_name || 'there'

  let groupName = `Group ${groupId}`
  try {
    const chat = await bot.getChat(groupId)
    groupName = chat.title || groupName
  } catch (err) {
    logger.error(`Could not fetch group info for ${groupId}: ${err.message}`)
  }

  await createSetupSession(groupId, groupName, managerId, dmChatId)

  await bot.sendMessage(dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n\n` +
    `First — what's your restaurant called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' })

  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName}`)
}

const RESET_RE = /^(reset|restart|clear|start over|redo)$/i

export async function handleSetupMessage(bot, msg, session) {
  const text = msg.text?.trim()
  if (!text) return

  if (RESET_RE.test(text)) {
    await handleReset(bot, msg, session)
    return
  }

  switch (session.step) {
    case 'welcome':
      await handleWelcomeStep(bot, msg, session, text)
      break
    case 'add_shifts':
      await handleAddShiftsStep(bot, msg, session, text)
      break
    case 'shift_roles':
      await handleShiftRolesStep(bot, msg, session, text)
      break
    case 'add_staff':
      await handleAddStaffStep(bot, msg, session, text)
      break
    default:
      break
  }
}

async function handleReset(bot, msg, session) {
  const chatId = msg.chat.id
  const groupId = session.group_id

  switch (session.step) {
    case 'welcome':
      await bot.sendMessage(chatId,
        `What's your restaurant called?\n_(Press send to use *"${session.group_name}"*)_`,
        { parse_mode: 'Markdown' })
      break
    case 'add_shifts':
      await resetShiftStep(bot, chatId, groupId)
      break
    case 'shift_roles':
      await resetShiftRolesStep(bot, chatId, groupId)
      break
    case 'add_staff':
      await resetStaffStep(bot, chatId, groupId)
      break
    default:
      await bot.sendMessage(chatId, `Nothing to reset at this step.`)
  }
}
