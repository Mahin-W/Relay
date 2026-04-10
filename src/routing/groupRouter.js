import { upsertGroupMember, getOpenTradeRequest, getOpenRequest } from '../db.js'
import { parseMessage } from '../parseMessage.js'
import { handleCoverageRequest, handleCoverageConfirmation, handleCoverageCancel, handleTradeRequest, handleTradeOffer, handleCoverageTradeOffer, resolvePendingClarification } from '../handleCoverage.js'
import { handleTimeOffRequest } from '../timeOff/handleTimeOff.js'
import { handleLateArrival } from '../lateArrival/handleLateArrival.js'
import { handleAvailabilityMention } from '../availability/passiveAvailability.js'
import { handleOnCallOffer } from '../oncall/handleOnCall.js'
import { logger } from '../logger.js'
import { handleGroupCommands } from './commandRouter.js'
import { handleCopySchedule } from '../schedule/copySchedule.js'
import { handleNewHireAnnouncement } from '../onboarding/handleNewHire.js'

export async function handleGroupMessage(bot, msg, BOT_USERNAME, isAuthorizedAdmin, isGroupAdmin) {
  const groupName = msg.chat.title || 'Unknown Group'
  const groupId = String(msg.chat.id)
  const senderName = msg.from?.first_name || 'Someone'
  const userId = msg.from?.id

  logger.info(`[${groupName}] ${senderName}: ${msg.text}`)

  await upsertGroupMember(userId, groupId, senderName, msg.from?.username)

  const cmd = (name) => new RegExp(`^\\/${name}(@\\w+)?(\\s|$)`, 'i').test(msg.text.trim())

  const handled = await handleGroupCommands(bot, msg, cmd, BOT_USERNAME, isAuthorizedAdmin, isGroupAdmin)
  if (handled) return

  const pending = resolvePendingClarification(groupId, userId, msg.text)
  if (pending) {
    try {
      const intentWithPreResolved = { ...pending.intent, _preResolvedShift: pending.matchedShift, _preResolvedWeekStart: pending.matchedWeekStart }
      if (pending.intentType === 'coverage_request') {
        await handleCoverageRequest(bot, msg, intentWithPreResolved)
      } else if (pending.intentType === 'trade_request') {
        await handleTradeRequest(bot, msg, intentWithPreResolved)
      } else if (pending.intentType === 'trade_offer') {
        await handleTradeOffer(bot, msg, intentWithPreResolved, pending.intent.openTrade)
      }
    } catch (err) {
      logger.error(`Pending clarification handler failed: ${err.message}`)
    }
    return
  }

  try {
    const intent = await parseMessage(msg.text, senderName, groupName)
    logger.parse(`Intent: ${intent.type}`)

    switch (intent.type) {
      case 'cancel_coverage':
        await handleCoverageCancel(bot, msg)
        break
      case 'coverage_request':
        await handleCoverageRequest(bot, msg, intent)
        break
      case 'coverage_confirmation':
        await handleCoverageConfirmation(bot, msg, intent)
        break
      case 'trade_request': {
        const [openTrade, openCoverage] = await Promise.all([
          getOpenTradeRequest(groupId),
          getOpenRequest(groupId),
        ])
        if (openTrade && openTrade.requester_id !== userId) {
          await handleTradeOffer(bot, msg, intent, openTrade)
        } else if (openCoverage &&
                   openCoverage.requested_by?.toLowerCase() !== senderName.toLowerCase()) {
          await handleCoverageTradeOffer(bot, msg, intent, openCoverage)
        } else {
          await handleTradeRequest(bot, msg, intent)
        }
        break
      }
      case 'coverage_maybe': {
        const name = intent.person ? `${intent.person}, can` : 'Can'
        await bot.sendMessage(msg.chat.id,
          `${name} you fully commit? Reply *I can cover* to lock it in ✋`,
          { parse_mode: 'Markdown' })
        break
      }
      case 'time_off_request':
        await handleTimeOffRequest(bot, msg, intent)
        break
      case 'running_late':
        await handleLateArrival(bot, msg, intent)
        break
      case 'availability_mention':
        await handleAvailabilityMention(bot, msg, intent)
        break
      case 'on_call_offer':
        await handleOnCallOffer(bot, msg, intent)
        break
      case 'new_hire_announcement':
        await handleNewHireAnnouncement(bot, msg, intent)
        break
      case 'copy_schedule_request':
        await handleCopySchedule(bot, msg)
        break
      case 'schedule_update':
        logger.info(`Schedule update noted: ${intent.details}`)
        break
      default:
        break
    }
  } catch (err) {
    logger.error(`Message handling failed: ${err.message}`)
  }
}
