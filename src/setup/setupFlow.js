import { createSetupSession, getSetupSession, clearGroupSetupData, updateSetupSession, getStaffForGroup, getShiftsForGroup } from './setupDb.js'
import { logger } from '../logger.js'
import { handleWelcomeStep, handleAddStaffStep, resetStaffStep } from './staffSteps.js'
import { handlePhoneStep } from './phoneSteps.js'
import { handleAddShiftsStep, handleShiftRolesStep, resetShiftStep, resetShiftRolesStep, moveToStaffStepShared } from './shiftSteps.js'
import { handleRoleRatesStep } from './roleRatesSteps.js'
import { handleOvertimeStep } from './overtimeSteps.js'
import { handleTipSettingsStep } from './tipSettingsSteps.js'

// Phrases that count as an explicit "yes, wipe my existing setup" confirmation.
// Intentionally narrow — a casual "yes" should not destroy a manager's data.
const WIPE_CONFIRM_RE = /^(yes\s*wipe|wipe\s*everything|wipe|confirm\s*wipe|start\s*over\s*and\s*wipe|reset\s*everything)$/i

async function performWipeAndStart(bot, dmChatId, groupId, groupName, managerId, managerName) {
  await clearGroupSetupData(groupId)
  await createSetupSession(groupId, groupName, managerId, dmChatId)
  await bot.sendMessage(dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n` +
    `_(Previous setup cleared — payroll and time clock history preserved.)_\n\n` +
    `First — what's your business called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' })
  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName} — data cleared after explicit confirm`)
}

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

  const existing = await getSetupSession(groupId)
  const hadData = !!existing

  // If the previous setup completed and the group has real configuration data
  // (staff or shifts), require an explicit "yes wipe" confirmation before
  // destroying it. Running /setup by accident has historically wiped restaurants.
  if (hadData && existing.setup_complete) {
    const [staff, shifts] = await Promise.all([
      getStaffForGroup(groupId).catch(() => []),
      getShiftsForGroup(groupId).catch(() => []),
    ])
    const hasMeaningfulData = (staff?.length ?? 0) > 0 || (shifts?.length ?? 0) > 0

    if (hasMeaningfulData) {
      // Park the session in 'confirm_wipe' so handleSetupMessage knows what to expect.
      // We flip setup_complete to false during the confirm window so the DM router
      // (which routes by getSetupSessionByManager filtered on setup_complete=false)
      // delivers the next message back here. Cancel restores it.
      await updateSetupSession(groupId, {
        step: 'confirm_wipe',
        manager_id: managerId,
        dm_chat_id: dmChatId,
        group_name: existing.group_name || groupName,
        setup_complete: false,
      })
      await bot.sendMessage(dmChatId,
        `⚠️ *${groupName} is already set up.*\n\n` +
        `You have *${staff?.length ?? 0} staff* and *${shifts?.length ?? 0} shifts* configured. ` +
        `Running /setup again will *delete all staff, shifts, schedule assignments, and availability* ` +
        `(payroll and time-clock history are preserved).\n\n` +
        `If that's what you want, reply with *yes wipe* to confirm.\n` +
        `Anything else cancels — your data stays untouched.`,
        { parse_mode: 'Markdown' })
      logger.bot(`Setup wipe confirmation requested for group ${groupId} (${staff?.length ?? 0} staff, ${shifts?.length ?? 0} shifts)`)
      return
    }
  }

  // Incomplete or empty prior setup — safe to wipe and restart.
  if (hadData) {
    await clearGroupSetupData(groupId)
  }

  await createSetupSession(groupId, groupName, managerId, dmChatId)

  const resetNote = hadData
    ? `\n_(Previous setup cleared — payroll and time clock history preserved.)_\n`
    : ''

  await bot.sendMessage(dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n${resetNote}\n` +
    `First — what's your business called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' })

  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName}${hadData ? ' — data cleared' : ''}`)
}

const RESET_RE = /^(reset|restart|clear|start over|redo)$/i

export async function handleSetupMessage(bot, msg, session) {
  const text = msg.text?.trim()
  if (!text) return

  // confirm_wipe is a destructive gate: only an explicit phrase proceeds; any
  // other reply (including a casual "yes" or "ok") cancels and leaves the
  // existing data alone.
  if (session.step === 'confirm_wipe') {
    if (WIPE_CONFIRM_RE.test(text)) {
      const managerName = msg.from?.first_name || 'there'
      await performWipeAndStart(bot, msg.chat.id, session.group_id, session.group_name, msg.from.id, managerName)
    } else {
      // Restore the session to its prior 'completed' state so the wizard exits cleanly.
      await updateSetupSession(session.group_id, { step: 'complete', setup_complete: true })
      await bot.sendMessage(msg.chat.id,
        `Got it — your existing setup is unchanged. If you really do want to start over, run /setup again and reply *yes wipe*.`,
        { parse_mode: 'Markdown' })
      logger.bot(`Setup wipe declined for group ${session.group_id}`)
    }
    return
  }

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
        `What's your business called?\n_(Press send to use *"${session.group_name}"*)_`,
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
