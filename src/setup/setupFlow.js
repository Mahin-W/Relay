import { createSetupSession, getSetupSession, clearGroupSetupData } from './setupDb.js'
import { logger } from '../logger.js'
import { handleWelcomeStep, handleAddStaffStep, resetStaffStep } from './staffSteps.js'
import { handlePhoneStep } from './phoneSteps.js'
import { handleAddShiftsStep, handleShiftRolesStep, resetShiftStep, resetShiftRolesStep, moveToStaffStepShared } from './shiftSteps.js'
import { handleRoleRatesStep } from './roleRatesSteps.js'
import { handleOvertimeStep } from './overtimeSteps.js'
import { handleTipSettingsStep } from './tipSettingsSteps.js'

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

  // /setup always starts fresh — wipe any existing config data for this group
  // (staff, shifts, assignments, availability). Historical data (payroll,
  // time_entries, coverage, tips, logs) is never touched. Running /setup means
  // "start over" even if a previous attempt was abandoned mid-wizard.
  const existing = await getSetupSession(groupId)
  const hadData = !!existing
  if (hadData) {
    await clearGroupSetupData(groupId)
  }

  await createSetupSession(groupId, groupName, managerId, dmChatId)

  const resetNote = hadData
    ? `\n_(Previous setup cleared — payroll and time clock history preserved.)_\n`
    : ''

  await bot.sendMessage(dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n${resetNote}\n` +
    `First — what's your restaurant called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' })

  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName}${hadData ? ' — data cleared' : ''}`)
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
    case 'role_rates':
      await handleRoleRatesStep(bot, msg, session, text)
      break
    case 'add_staff':
      await handleAddStaffStep(bot, msg, session, text)
      break
    case 'phone_number':
      await handlePhoneStep(bot, msg, session, text)
      break
    case 'tip_settings':
      await handleTipSettingsStep(bot, msg, session, text)
      break
    case 'overtime_setup':
      await handleOvertimeStep(bot, msg, session, text)
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
