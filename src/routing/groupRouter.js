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
import { handlePartialCoverageOffer } from '../coverage/partialCoverage.js'
import { handleWhoIsWorkingQuery } from '../schedule/currentShift.js'
import { detectManagerCoverageRequest, handleManagerCoveragePost } from '../coverage/managerCoverage.js'
import { detectStaffRemoval, handleRemoveStaff } from '../setup/staffManager.js'
import { extractRevenueFromGroupMessage } from '../analytics/laborCost.js'

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

  // Skip LLM parsing for slash commands — they're handled by bot.onText in index.js
  // or by handleGroupCommands above. Prevents double-fire and wasteful API calls.
  if (msg.text.trim().startsWith('/')) return

  // ── F3: Revenue messages in group chat must be redirected to DM ──────────
  try {
    const revenueAmount = extractRevenueFromGroupMessage(msg.text)
    if (revenueAmount > 0) {
      // Find manager username for the mention
      let managerMention = 'Manager'
      try {
        const { getSetupSession } = await import('../setup/setupDb.js')
        const session = await getSetupSession(groupId)
        if (session?.manager_id) {
          // Use @username if available, otherwise generic "Manager"
          managerMention = `@manager`
        }
      } catch (_) {}
      await bot.sendMessage(
        msg.chat.id,
        `${managerMention}, please DM me that revenue figure (or enter it in the dashboard) so I can attribute it correctly.`
      )
      return
    }
  } catch (err) {
    logger.error(`Revenue redirect check failed: ${err.message}`)
  }

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
      case 'partial_coverage_offer':
        await handlePartialCoverageOffer(bot, msg, intent)
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
      case 'who_is_working_query':
        await handleWhoIsWorkingQuery(bot, msg)
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

  // Manager coverage detection — admin posts to create coverage request on behalf of staff
  try {
    const isAdmin = await isAuthorizedAdmin(groupId, userId)
    if (isAdmin) {
      const { getShiftsForGroup } = await import('../setup/shiftEditor.js')
      const shifts = await getShiftsForGroup(groupId)
      const shiftNames = shifts.map(s => s.name)
      const coverageIntent = await detectManagerCoverageRequest(msg.text, shiftNames)
      if (coverageIntent) {
        await handleManagerCoveragePost(bot, msg, coverageIntent)
        return
      }
      const { getStaffForGroup } = await import('../setup/setupDb.js')
      const allStaff = await getStaffForGroup(groupId)
      const staffNames = allStaff.map(s => s.name)
      const removalIntent = detectStaffRemoval(msg.text, staffNames)
      if (removalIntent) {
        await handleRemoveStaff(bot, msg, removalIntent)
        return
      }
    }
  } catch (err) {
    logger.error(`Manager passive detection failed: ${err.message}`)
  }

  // Passive recognition detection — fire and forget
  try {
    const { handleRecognition } = await import('../engagement/recognition.js')
    handleRecognition(bot, msg, groupId).catch(err => {
      logger.error(`Recognition handler error: ${err.message}`)
    })
  } catch (_) {}

  // Passive cross-training detection — fire and forget
  try {
    const { handleCrossTrainingMention } = await import('../intelligence/crossTraining.js')
    handleCrossTrainingMention(bot, msg, groupId).catch(err => {
      logger.error(`Cross-training handler error: ${err.message}`)
    })
  } catch (_) {}

  // Passive demand signal detection — fire and forget
  try {
    const { extractDemandSignal, saveDemandSignal } = await import('../intelligence/demandSignals.js')
    const signal = extractDemandSignal(msg.text)
    if (signal) {
      const now = new Date()
      const day = now.getDay()
      const diff = day === 0 ? -6 : 1 - day
      const monday = new Date(now)
      monday.setDate(now.getDate() + diff)
      const weekStart = monday.toISOString().split('T')[0]
      saveDemandSignal(groupId, weekStart, signal, msg.text, msg.from?.id).catch(() => {})
    }
  } catch (_) {}
}

// Alias for simulation/test imports that check for routeGroup export
export const routeGroup = handleGroupMessage
