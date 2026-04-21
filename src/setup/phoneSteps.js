import { updateSetupSession } from './setupDb.js'
import { startTipSettingsStep } from './tipSettingsSteps.js'

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits[0] === '1') return '+' + digits
  if (digits.length > 7) return '+' + digits
  return null
}

export async function startPhoneStep(bot, chatId, groupId) {
  await updateSetupSession(groupId, { step: 'phone_number' })
  await bot.sendMessage(chatId,
    `📱 *One last thing!*\n\nWhat's your phone number?\n\nYou'll use this to log in to the Relay web dashboard.\n\n_e.g. +1 555 123 4567_`,
    { parse_mode: 'Markdown' })
}

export async function handlePhoneStep(bot, msg, session, text) {
  const chatId = msg.chat.id
  const phone = normalizePhone(text)

  if (!phone) {
    await bot.sendMessage(chatId,
      `That doesn't look like a valid phone number. Try again:\n\n_e.g. +1 555 123 4567 or 5551234567_`,
      { parse_mode: 'Markdown' })
    return
  }

  await updateSetupSession(session.group_id, {
    step: 'tip_settings',
    phone,
  })

  await bot.sendMessage(chatId, `✅ Got it — *${phone}*`, { parse_mode: 'Markdown' })
  await startTipSettingsStep(bot, chatId, session.group_id, session.setup_data ?? {})
}
