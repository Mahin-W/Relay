import { upsertStaffDm, upsertGroupMember } from '../db.js'
import { getSetupSessionByManager, getManagerGroup } from '../setup/setupDb.js'
import { startSetupDM, handleSetupMessage } from '../setup/setupFlow.js'
import { getAvailabilitySessionByDm } from '../availability/availabilityDb.js'
import { getPendingSchedule } from '../availability/availabilityDb.js'
import { handleAvailabilityReply } from '../availability/collectAvailability.js'
import { handleManagerReview } from '../schedule/reviewSchedule.js'
import { handleDmConfirmation, handleDmCoverageTradeOffer } from '../handleCoverage.js'
import { handleManagerTimeOffReply } from '../timeOff/handleTimeOff.js'
import { handleScheduleQuery, handleHoursQuery, isScheduleQuery, isHoursQuery } from '../schedule/selfService.js'
import { handleStaffPayQuery, handleStaffHistoryQuery, isPayQuery, isHistoryQuery } from '../payroll/staffPayService.js'
import { isDmConfirmation, parseMessage } from '../parseMessage.js'
import { getOutreachByUser } from '../db.js'
import { handleNewHireRegistration } from '../onboarding/handleNewHire.js'
import { logger } from '../logger.js'
import { isReceiptConfirmation, handleReceiptConfirmation } from '../schedule/readReceipts.js'

export async function handleDmMessage(bot, msg, isGroupAdmin, BOT_USERNAME) {
  const text = msg.text.trim()
  const userId = msg.from?.id
  const senderName = msg.from?.first_name || 'Someone'

  if (text.startsWith('/start')) {
    const param = text.replace('/start', '').trim()

    if (param.startsWith('setup_')) {
      const groupId = param.replace('setup_', '')
      const admin = await isGroupAdmin(groupId, userId)
      if (!admin) {
        await bot.sendMessage(msg.chat.id,
          `⚠️ You need to be a group admin to set up Relay.\n\nAsk a group admin to type */setup* in the group.`,
          { parse_mode: 'Markdown' })
        return
      }
      await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
      await startSetupDM(bot, msg, groupId)
      return
    }

    if (param.startsWith('register_')) {
      const groupId = param.replace('register_', '')
      await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
      await upsertGroupMember(userId, groupId, senderName, msg.from?.username)
      await handleNewHireRegistration(bot, msg, groupId)
      logger.bot(`${senderName} registered via group invite link (group ${groupId})`)
      return
    }

    await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
    await bot.sendMessage(msg.chat.id,
      `👋 Hey ${senderName}! You're registered with Relay.\n\n` +
      `When your restaurant group needs shift coverage, I'll DM you here to ask if you can help. ` +
      `Just reply *yes* and I'll confirm it in the group chat automatically.`,
      { parse_mode: 'Markdown' })
    logger.bot(`${senderName} registered via /start`)
    return
  }

  const setupSession = await getSetupSessionByManager(userId)
  if (setupSession) {
    try { await handleSetupMessage(bot, msg, setupSession) } catch (err) {
      logger.error(`Setup message handling failed: ${err.message}`)
    }
    return
  }

  const avSession = await getAvailabilitySessionByDm(msg.chat.id)
  if (avSession) {
    try { await handleAvailabilityReply(bot, msg, avSession) } catch (err) {
      logger.error(`Availability reply handling failed: ${err.message}`)
    }
    return
  }

  if (isReceiptConfirmation(text)) {
    try {
      await handleReceiptConfirmation(bot, msg)
      return
    } catch (err) {
      logger.error(`Receipt confirmation failed: ${err.message}`)
    }
  }

  const managerGroup = await getManagerGroup(userId)
  if (managerGroup) {
    // Check time-off approval/denial first
    if (/^(approve|deny)\s+\S+/i.test(text)) {
      try {
        const handled = await handleManagerTimeOffReply(bot, msg)
        if (handled) return
      } catch (err) {
        logger.error(`Manager time-off reply failed: ${err.message}`)
      }
    }

    const pendingSchedule = await getPendingSchedule(managerGroup.group_id)
    if (pendingSchedule) {
      try { await handleManagerReview(bot, msg, pendingSchedule, managerGroup) } catch (err) {
        logger.error(`Manager review handling failed: ${err.message}`)
      }
      return
    }
  }

  if (isHistoryQuery(text)) {
    try { await handleStaffHistoryQuery(bot, msg) } catch (err) {
      logger.error(`Staff pay history query failed: ${err.message}`)
    }
    return
  }

  if (isPayQuery(text)) {
    try { await handleStaffPayQuery(bot, msg) } catch (err) {
      logger.error(`Staff pay query failed: ${err.message}`)
    }
    return
  }

  if (isHoursQuery(text)) {
    try { await handleHoursQuery(bot, msg) } catch (err) {
      logger.error(`Hours query failed: ${err.message}`)
    }
    return
  }

  if (isScheduleQuery(text)) {
    try { await handleScheduleQuery(bot, msg) } catch (err) {
      logger.error(`Schedule query failed: ${err.message}`)
    }
    return
  }

  if (await isDmConfirmation(text)) {
    try { await handleDmConfirmation(bot, msg) } catch (err) {
      logger.error(`DM confirmation failed: ${err.message}`)
    }
    return
  }

  // Check if the DM is a trade offer in response to a coverage outreach
  if (/\btrade\b/i.test(text)) {
    try {
      const pendingRequest = await getOutreachByUser(userId)
      if (pendingRequest) {
        const intent = await parseMessage(text, senderName, 'DM')
        if (intent.type === 'trade_request') {
          await handleDmCoverageTradeOffer(bot, msg, intent, pendingRequest)
          return
        }
      }
    } catch (err) {
      logger.error(`DM trade offer handling failed: ${err.message}`)
    }
  }

  await bot.sendMessage(msg.chat.id,
    `To volunteer for a shift, just reply *yes* when I ask you.\n\nSend */start* if you haven't registered yet.`,
    { parse_mode: 'Markdown' })
}
