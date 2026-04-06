import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { logger } from './logger.js'
import { parseMessage, isDmConfirmation } from './parseMessage.js'
import { handleCoverageRequest, handleCoverageConfirmation, handleDmConfirmation } from './handleCoverage.js'
import { upsertGroupMember, upsertStaffDm } from './db.js'
import { getSetupSessionByManager, getSetupSession, isSetupComplete, getManagerGroup } from './setup/setupDb.js'
import { startSetupDM, handleSetupMessage } from './setup/setupFlow.js'
import { startAvailabilityCollection, handleAvailabilityReply } from './availability/collectAvailability.js'
import { getAvailabilitySessionByDm } from './availability/availabilityDb.js'
import { getPendingSchedule, resetAvailabilityForGroup } from './availability/availabilityDb.js'
import { generateWeeklySchedule, formatScheduleMessage, getNextWeekStart } from './schedule/generateSchedule.js'
import { handleManagerReview, publishSchedule } from './schedule/reviewSchedule.js'

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']
const missing = REQUIRED_ENV.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill in all values.')
  process.exit(1)
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })

// Stored on startup — needed to generate deep links for /setup
let BOT_USERNAME = ''

logger.bot('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
logger.bot('  Relay is starting up...')
logger.bot('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

bot.getMe().then((me) => {
  BOT_USERNAME = me.username
  logger.bot(`Running as @${BOT_USERNAME}`)
  logger.bot(`Environment: ${process.env.NODE_ENV}`)
  logger.bot('Listening for group messages...')
  logger.bot('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
})

// Returns true if userId is a creator or admin of groupId
async function isGroupAdmin(groupId, userId) {
  try {
    const member = await bot.getChatMember(groupId, userId)
    return ['creator', 'administrator'].includes(member.status)
  } catch (err) {
    logger.error(`isGroupAdmin check failed: ${err.message}`)
    return false
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type)
  const isDm = msg.chat.type === 'private'

  if (!msg.text) return

  const senderName = msg.from?.first_name || 'Someone'
  const userId = msg.from?.id

  // ── DM handling ────────────────────────────────────────────────────────────
  if (isDm) {
    const text = msg.text.trim()

    // /start — with or without a setup parameter
    if (text.startsWith('/start')) {
      const param = text.replace('/start', '').trim()

      if (param.startsWith('setup_')) {
        // Deep link from /setup command in a group
        const groupId = param.replace('setup_', '')
        const admin = await isGroupAdmin(groupId, userId)
        if (!admin) {
          await bot.sendMessage(
            msg.chat.id,
            `⚠️ You need to be a group admin to set up Relay.\n\nAsk a group admin to type */setup* in the group.`,
            { parse_mode: 'Markdown' }
          )
          return
        }
        // Register the manager's DM so they're reachable for availability/coverage
        await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
        await startSetupDM(bot, msg, groupId)
        return
      }

      if (param.startsWith('register_')) {
        // Deep link for staff who haven't messaged in the group yet
        const groupId = param.replace('register_', '')
        await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
        await upsertGroupMember(userId, groupId, senderName, msg.from?.username)
        // Fetch group name for a friendly message
        let groupName = 'your group'
        try {
          const chat = await bot.getChat(groupId)
          groupName = chat.title || groupName
        } catch (_) {}
        await bot.sendMessage(
          msg.chat.id,
          `👋 Hey ${senderName}! You're registered with Relay for *${groupName}*.\n\n` +
          `I'll DM you here when the schedule is ready or when shifts need coverage.`,
          { parse_mode: 'Markdown' }
        )
        logger.bot(`${senderName} registered via group invite link (group ${groupId})`)
        return
      }

      // Plain /start — staff registration (no group association)
      await upsertStaffDm(userId, senderName, msg.from?.username, msg.chat.id)
      await bot.sendMessage(
        msg.chat.id,
        `👋 Hey ${senderName}! You're registered with Relay.\n\n` +
        `When your restaurant group needs shift coverage, I'll DM you here to ask if you can help. ` +
        `Just reply *yes* and I'll confirm it in the group chat automatically.`,
        { parse_mode: 'Markdown' }
      )
      logger.bot(`${senderName} registered via /start`)
      return
    }

    // Check for an active setup session — route to setup flow first
    const setupSession = await getSetupSessionByManager(userId)
    if (setupSession) {
      try {
        await handleSetupMessage(bot, msg, setupSession)
      } catch (err) {
        logger.error(`Setup message handling failed: ${err.message}`)
      }
      return
    }

    // Availability reply — staff member responding to availability DM
    const avSession = await getAvailabilitySessionByDm(msg.chat.id)
    if (avSession) {
      try {
        await handleAvailabilityReply(bot, msg, avSession)
      } catch (err) {
        logger.error(`Availability reply handling failed: ${err.message}`)
      }
      return
    }

    // Manager schedule review — manager approving/regenerating a draft
    const managerGroup = await getManagerGroup(userId)
    if (managerGroup) {
      const pendingSchedule = await getPendingSchedule(managerGroup.group_id)
      if (pendingSchedule) {
        try {
          await handleManagerReview(bot, msg, pendingSchedule, managerGroup)
        } catch (err) {
          logger.error(`Manager review handling failed: ${err.message}`)
        }
        return
      }
    }

    // Coverage confirmation via DM
    if (await isDmConfirmation(text)) {
      try {
        await handleDmConfirmation(bot, msg)
      } catch (err) {
        logger.error(`DM confirmation failed: ${err.message}`)
      }
    } else {
      await bot.sendMessage(
        msg.chat.id,
        `To volunteer for a shift, just reply *yes* when I ask you.\n\nSend */start* if you haven't registered yet.`,
        { parse_mode: 'Markdown' }
      )
    }
    return
  }

  // ── Group handling ──────────────────────────────────────────────────────────
  if (!isGroup) return

  const groupName = msg.chat.title || 'Unknown Group'
  const groupId = String(msg.chat.id)

  logger.info(`[${groupName}] ${senderName}: ${msg.text}`)

  // Track this person as a group member (enables DM outreach)
  await upsertGroupMember(userId, groupId, senderName, msg.from?.username)

  // Helper: matches /command or /command@BotName
  const cmd = (name) => new RegExp(`^\\/${name}(@\\w+)?$`, 'i').test(msg.text.trim())

  // /register — post a registration link for staff who haven't messaged yet
  if (cmd('register')) {
    if (!BOT_USERNAME) {
      await bot.sendMessage(msg.chat.id, `⚠️ Bot is still starting up — try again in a moment.`)
      return
    }
    const link = `https://t.me/${BOT_USERNAME}?start=register_${groupId}`
    await bot.sendMessage(
      msg.chat.id,
      `📲 *Staff Registration Link*\n\n` +
      `Share this with any team members who haven't registered with Relay yet:\n\n` +
      `👉 [Click to register with Relay](${link})\n\n` +
      `Once they click it, I'll be able to DM them about availability and schedules.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    )
    return
  }

  // /availability — collect staff availability for next week
  if (cmd('availability')) {
    const admin = await isGroupAdmin(groupId, userId)
    if (!admin) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can collect availability.`)
      return
    }
    try {
      await startAvailabilityCollection(bot, msg, groupId, BOT_USERNAME)
    } catch (err) {
      logger.error(`startAvailabilityCollection failed: ${err.message}`)
    }
    return
  }

  // /resetavailability — clear all availability sessions and responses for next week
  if (cmd('resetavailability')) {
    const admin = await isGroupAdmin(groupId, userId)
    if (!admin) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can reset availability.`)
      return
    }
    try {
      const weekStart = getNextWeekStart()
      await resetAvailabilityForGroup(groupId, weekStart)
      await bot.sendMessage(msg.chat.id, `🗑️ Availability reset for next week. You can run */availability* again to start fresh.`, { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`resetAvailability failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return
  }

  // /makeschedule — generate weekly schedule from collected availability
  if (cmd('makeschedule')) {
    const admin = await isGroupAdmin(groupId, userId)
    if (!admin) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can generate the schedule.`)
      return
    }
    const setupDone = await isSetupComplete(groupId)
    if (!setupDone) {
      await bot.sendMessage(msg.chat.id, `⚠️ Please complete setup first with /setup.`)
      return
    }

    const managerGroup = await getManagerGroup(userId)
    if (!managerGroup?.dm_chat_id) {
      await bot.sendMessage(msg.chat.id, `⚠️ I need to be able to DM the manager. Please DM me at @${BOT_USERNAME} first.`)
      return
    }

    await bot.sendMessage(msg.chat.id, `⏳ Generating schedule...`)

    try {
      const weekStart = getNextWeekStart()
      const schedule = await generateWeeklySchedule(groupId, weekStart)
      const formatted = formatScheduleMessage(schedule.assignments, schedule.gaps, weekStart)

      await bot.sendMessage(
        managerGroup.dm_chat_id,
        `📋 *Draft Schedule Ready*\n\n${formatted}\n\n` +
        `Reply *approve* to publish this to the group, or *regenerate* for a different arrangement.`,
        { parse_mode: 'Markdown' }
      )

      await bot.sendMessage(
        msg.chat.id,
        `📋 Draft schedule sent to the manager for review.`
      )
    } catch (err) {
      logger.error(`makeschedule failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong generating the schedule — try again.`)
    }
    return
  }

  // /setup — start manager setup flow via DM deep link
  if (cmd('setup')) {
    if (!BOT_USERNAME) {
      await bot.sendMessage(msg.chat.id, `⚠️ Bot is still starting up — try again in a moment.`)
      return
    }

    // Check if setup already completed by someone else
    const existingSession = await getSetupSession(groupId)
    if (existingSession?.setup_complete && existingSession.manager_id !== userId) {
      // Notify the original manager in DM (if they have a DM chat registered)
      const managerDm = existingSession.dm_chat_id
      if (managerDm) {
        try {
          await bot.sendMessage(
            managerDm,
            `⚠️ *Heads up!*\n\n*${senderName}* just tried to run */setup* in *${groupName}*.\n\nIf you didn't authorize this, you may want to check your group admin settings.`,
            { parse_mode: 'Markdown' }
          )
        } catch (err) {
          logger.error(`Could not notify manager of setup attempt: ${err.message}`)
        }
      }
      await bot.sendMessage(
        msg.chat.id,
        `⚠️ Relay is already configured for this group. The original manager has been notified.`
      )
      return
    }

    // Allow original manager or first-time setup (must be admin)
    const admin = await isGroupAdmin(groupId, userId)
    if (!admin) {
      await bot.sendMessage(msg.chat.id, `⚠️ Only group admins can set up Relay.`)
      return
    }

    const deepLink = `https://t.me/${BOT_USERNAME}?start=setup_${groupId}`
    await bot.sendMessage(
      msg.chat.id,
      `Hi ${senderName}! I'll walk you through setup in a private chat to keep things tidy.\n\n` +
      `👉 [Click here to open our DM](${deepLink})\n\n` +
      `Once you've completed setup there, I'll be ready to go here.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    )
    return
  }

  try {
    const intent = await parseMessage(msg.text, senderName, groupName)
    logger.parse(`Intent: ${intent.type}`)

    switch (intent.type) {
      case 'coverage_request':
        await handleCoverageRequest(bot, msg, intent)
        break
      case 'coverage_confirmation':
        await handleCoverageConfirmation(bot, msg, intent)
        break
      case 'coverage_maybe': {
        const name = intent.person ? `${intent.person}, can` : 'Can'
        await bot.sendMessage(
          msg.chat.id,
          `${name} you fully commit? Reply *I can cover* to lock it in ✋`,
          { parse_mode: 'Markdown' }
        )
        break
      }
      case 'schedule_update':
        logger.info(`Schedule update noted: ${intent.details}`)
        break
      default:
        break
    }
  } catch (err) {
    logger.error(`Message handling failed: ${err.message}`)
  }
})

bot.on('polling_error', (err) => {
  logger.error(`Polling error: ${err.message}`)
})

process.on('SIGINT', () => {
  logger.bot('Shutting down gracefully...')
  bot.stopPolling()
  process.exit(0)
})
