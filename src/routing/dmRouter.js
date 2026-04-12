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
import { handleLogEntry } from '../managerLog/shiftLog.js'
import { detectClockIntent } from '../timeclock/clockDetector.js'
import { handleClockIn, handleClockOut } from '../timeclock/clockHandler.js'
import { handleWhoIsWorkingQuery } from '../schedule/currentShift.js'
import { getPendingRule, handleRuleConfirmation, handlePotentialRule } from '../rules/businessRules.js'
import { isEarnedWageQuery, handleEarnedWageQuery } from '../engagement/earnedWage.js'
import { handleTipMessage } from '../operations/tipPool.js'

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

  // Time clock — fast-path keyword detection (no LLM)
  const clockIntent = detectClockIntent(text)
  if (clockIntent === 'clock_in') {
    try {
      await handleClockIn(bot, msg)
      return
    } catch (err) {
      logger.error(`Clock-in failed: ${err.message}`)
    }
  }
  if (clockIntent === 'clock_out') {
    try {
      await handleClockOut(bot, msg)
      return
    } catch (err) {
      logger.error(`Clock-out failed: ${err.message}`)
    }
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
    // Check pending rule confirmation first (yes/no to "save this rule?")
    if (getPendingRule(userId)) {
      try {
        const handled = await handleRuleConfirmation(bot, msg)
        if (handled) return
      } catch (err) {
        logger.error(`Rule confirmation failed: ${err.message}`)
      }
    }

    // Check time-off approval/denial
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

  // Earned wage query — staff asks "how much have I made"
  if (isEarnedWageQuery(text)) {
    try { await handleEarnedWageQuery(bot, msg) } catch (err) {
      logger.error(`Earned wage query failed: ${err.message}`)
    }
    return
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

  // Emergency availability — fast-path keyword detection (manager only)
  const emergencyTriggers = [
    'who can work tonight right now', 'who can work now', 'who is available now',
    'emergency coverage', 'need someone now', 'who can come in',
    'last minute coverage', 'need someone asap', 'need someone immediately',
  ]
  if (managerGroup && emergencyTriggers.some(t => text.toLowerCase().includes(t))) {
    try {
      const { handleEmergencyQuery } = await import('../intelligence/emergencyAvailability.js')
      await handleEmergencyQuery(bot, msg)
      return
    } catch (err) {
      logger.error(`Emergency availability query failed: ${err.message}`)
    }
  }

  // "Who is working" query — fast-path keyword detection
  const whoTriggers = ['who is working', 'who works', 'whos working', "who's on", 'current staff', 'on shift now', 'whos on now', 'who is on']
  if (whoTriggers.some(t => text.toLowerCase().includes(t))) {
    try { await handleWhoIsWorkingQuery(bot, msg) } catch (err) {
      logger.error(`Who is working query failed: ${err.message}`)
    }
    return
  }

  // Passive business rule detection — manager DMs that sound like scheduling rules
  const managerGroupForRules = managerGroup || await getManagerGroup(userId)
  if (managerGroupForRules && text.length > 10 && !text.startsWith('/')) {
    try {
      const wasRule = await handlePotentialRule(bot, msg, managerGroupForRules.group_id)
      if (wasRule) return
    } catch (err) {
      logger.error(`Potential rule detection failed: ${err.message}`)
    }
  }

  // Tip message — manager says "tips were $840 tonight"
  if (managerGroupForRules) {
    try {
      const tipHandled = await handleTipMessage(bot, msg)
      if (tipHandled) return
    } catch (err) {
      logger.error(`Tip message handling failed: ${err.message}`)
    }
  }

  // Manager shift log — catch manager free-text DMs that look like shift notes
  // Skip questions and general chat to avoid accidental logging
  const managerGroupForLog = managerGroupForRules || await getManagerGroup(userId)
  const looksLikeQuestion = /\?/.test(text) || /^(how|what|when|where|why|who|can|does|is|do|will|should|could|would|help)\b/i.test(text)
  if (managerGroupForLog && text.length > 10 && !text.startsWith('/') && !looksLikeQuestion) {
    try {
      const logged = await handleLogEntry(bot, msg)
      if (logged) return
    } catch (err) {
      logger.error(`Log entry failed: ${err.message}`)
    }
  }

  await bot.sendMessage(msg.chat.id,
    `To volunteer for a shift, just reply *yes* when I ask you.\n\nSend */start* if you haven't registered yet.`,
    { parse_mode: 'Markdown' })
}
