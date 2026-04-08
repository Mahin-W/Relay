import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { logger } from './logger.js'
import { isBotAdmin } from './setup/setupDb.js'
import { handleDmMessage } from './routing/dmRouter.js'
import { handleGroupMessage } from './routing/groupRouter.js'
import { startReminderJobs } from './reminders/shiftReminders.js'

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
    await handleGroupMessage(bot, msg, BOT_USERNAME, isAuthorizedAdmin, isGroupAdmin)
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
