import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { logger } from './logger.js'
import { isBotAdmin } from './setup/setupDb.js'
import { handleDmMessage } from './routing/dmRouter.js'
import { handleGroupMessage } from './routing/groupRouter.js'
import { startReminderJobs } from './reminders/shiftReminders.js'
import { shouldSkip } from './preFilter.js'
import { startNoShowCron } from './noshow/noShowWarning.js'
import { getReliabilityScores } from './reliability/reliabilityDb.js'
import { formatReliabilityReport } from './reliability/reliabilityScore.js'
import { startBriefingCron, sendDailyBriefing } from './briefing/dailyBriefing.js'
import { updateRoleRate } from './setup/setupDb.js'

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']
const missing = REQUIRED_ENV.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill in all values.')
  process.exit(1)
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })

bot.deleteWebHook({ drop_pending_updates: true })
  .catch(() => {})
  .finally(() => bot.startPolling())

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
  startReminderJobs(bot)
  startNoShowCron(bot)
  startBriefingCron(bot)
})

async function isGroupAdmin(groupId, userId) {
  try {
    const member = await bot.getChatMember(groupId, userId)
    return ['creator', 'administrator'].includes(member.status)
  } catch (err) {
    logger.error(`isGroupAdmin check failed: ${err.message}`)
    return false
  }
}

async function isAuthorizedAdmin(groupId, userId) {
  const [telegramAdmin, botAdmin] = await Promise.all([
    isGroupAdmin(groupId, userId),
    isBotAdmin(groupId, userId),
  ])
  return telegramAdmin || botAdmin
}

bot.on('message', async (msg) => {
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type)
  const isDm = msg.chat.type === 'private'
  if (!msg.text) return

  if (isDm) {
    await handleDmMessage(bot, msg, isGroupAdmin, BOT_USERNAME)
    return
  }

  if (isGroup) {
    if (shouldSkip(msg.text)) return
    await handleGroupMessage(bot, msg, BOT_USERNAME, isAuthorizedAdmin, isGroupAdmin)
  }
})

bot.on('polling_error', (err) => {
  logger.error(`Polling error: ${err.message}`)
})

bot.onText(/^\/briefing/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  await sendDailyBriefing(bot, groupId)
  await bot.sendMessage(groupId, '📨 Briefing sent to your DM.')
})

bot.onText(/^\/setrate/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return // silent

  const parts = msg.text.trim().split(/\s+/)
  // /setrate [role] [amount] — role may be multiple words before the number
  if (parts.length < 3) {
    await bot.sendMessage(groupId, `Usage: /setrate [role] [amount]\nExample: /setrate Chef 16.50`)
    return
  }
  const amount = parseFloat(parts[parts.length - 1])
  const roleName = parts.slice(1, -1).join(' ')
  if (isNaN(amount) || amount <= 0 || !roleName) {
    await bot.sendMessage(groupId, `Usage: /setrate [role] [amount]\nExample: /setrate Chef 16.50`)
    return
  }
  await updateRoleRate(groupId, roleName, amount)
  await bot.sendMessage(groupId, `✅ ${roleName} rate updated to $${amount.toFixed(2)}/hr`)
})

bot.onText(/^\/reliability/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return // silent — don't reveal command

  const scores = await getReliabilityScores(groupId)
  const report = formatReliabilityReport(scores)
  if (session.dm_chat_id) {
    await bot.sendMessage(groupId, '📨 Reliability report sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, report, { parse_mode: 'Markdown' })
  }
})

process.on('SIGINT', () => {
  logger.bot('Shutting down gracefully...')
  bot.stopPolling()
  process.exit(0)
})
