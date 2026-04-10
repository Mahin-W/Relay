import { saveOnboardingRecord as liveSaveOnboardingRecord, getPendingOnboarding as liveGetPendingOnboarding, completeOnboarding as liveCompleteOnboarding } from './onboardingDb.js'
import { getSetupSession as liveGetSetupSession } from '../setup/setupDb.js'
import { logger } from '../logger.js'

let _cachedBotUsername = null
async function getBotUsername(bot) {
  if (!_cachedBotUsername) {
    const me = await bot.getMe()
    _cachedBotUsername = me.username
  }
  return _cachedBotUsername
}

export async function handleNewHireAnnouncement(bot, msg, intent, db = null) {
  const _saveOnboardingRecord = db?.saveOnboardingRecord ?? liveSaveOnboardingRecord
  const _getSetupSession      = db?.getSetupSession      ?? (() => liveGetSetupSession(String(msg.chat.id)))

  const groupId    = String(msg.chat.id)
  const personName = intent.person || 'new team member'
  const botUsername = await getBotUsername(bot)

  const registrationLink = `t.me/${botUsername}?start=register_${groupId}`

  await bot.sendMessage(groupId,
    `👋 Welcome to the team, ${personName}!\n\n` +
    `${personName} — send me a DM to get set up with scheduling: ${registrationLink}`,
    { parse_mode: 'Markdown' })

  const session = await _getSetupSession()
  if (session?.dm_chat_id) {
    await bot.sendMessage(session.dm_chat_id,
      `✅ New hire announcement detected.\n\nI've posted a registration link for *${personName}* in the group. I'll notify you when they register.`,
      { parse_mode: 'Markdown' })
  }

  await _saveOnboardingRecord(groupId, personName, intent.role ?? null, intent.startDate ?? null)
  logger.bot(`New hire onboarding started: ${personName} in group ${groupId}`)
}

export async function handleNewHireRegistration(bot, msg, groupId, db = null) {
  const _getPendingOnboarding = db?.getPendingOnboarding ?? (() => liveGetPendingOnboarding(groupId))
  const _completeOnboarding   = db?.completeOnboarding   ?? liveCompleteOnboarding
  const _getSetupSession      = db?.getSetupSession      ?? (() => liveGetSetupSession(groupId))

  const staffName = msg.from?.first_name || 'New team member'
  const dmChatId  = msg.chat.id

  // Send welcome DM
  await bot.sendMessage(dmChatId,
    `👋 Welcome to the team!\n\n` +
    `I'm *Relay* — I handle shift scheduling.\n` +
    `Here's what I do:\n` +
    `• Send you your weekly schedule\n` +
    `• Alert you when someone needs coverage\n` +
    `• Let you check your shifts anytime\n\n` +
    `Your manager will add you to the schedule soon.\n` +
    `If you ever need anything, just DM me 👍`,
    { parse_mode: 'Markdown' })

  // Check for pending onboarding records and notify manager
  const pending = await _getPendingOnboarding(groupId)
  if (pending.length > 0) {
    const record = pending[0]  // use most recent
    await _completeOnboarding(record.id)

    const session = await _getSetupSession()
    if (session?.dm_chat_id) {
      await bot.sendMessage(session.dm_chat_id,
        `✅ *${staffName}* has registered with Relay and is ready to be added to the schedule.`,
        { parse_mode: 'Markdown' })
    }
    logger.bot(`New hire ${staffName} completed onboarding for group ${groupId}`)
  }
}

export async function handleWelcomeCommand(bot, msg, name) {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return

  const groupId = String(msg.chat.id)
  const userId  = msg.from?.id

  try {
    const member = await bot.getChatMember(groupId, userId)
    if (!['creator', 'administrator'].includes(member?.status)) return
  } catch {
    return
  }

  const displayName = name || 'new team member'
  const botUsername = await getBotUsername(bot)

  await bot.sendMessage(groupId,
    `👋 Welcome to the team, ${displayName}!\n\n` +
    `Send me a DM to get set up: t.me/${botUsername}?start=register_${groupId}`)
}
