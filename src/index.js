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
import { startBriefingCron, sendDailyBriefing, startSundayBriefingCron } from './briefing/dailyBriefing.js'
import { handleRotationCommand } from './fairness/rotationTracker.js'
import { handleCopySchedule } from './schedule/copySchedule.js'
import { handleWelcomeCommand } from './onboarding/handleNewHire.js'
import { startOvertimeStep } from './setup/overtimeSteps.js'
import { getManagerGroup } from './setup/setupDb.js'
import { sendPayrollSpreadsheet } from './payroll/spreadsheetGenerator.js'
import { updateRoleRate } from './setup/setupDb.js'
import { sendPayReport, formatStaffPayHistory } from './payroll/payReport.js'
import { getPayrollHistory } from './payroll/payDb.js'
import { handleRevenueInput, parseRevenueInput, getRevenueHistory, formatRevenueHistory } from './analytics/laborCost.js'
import { saveBudget, getBudget } from './analytics/budgetAlert.js'
import { handleLogCommand } from './managerLog/shiftLog.js'
import { handleClockStatus, handleTimesheetCommand } from './timeclock/clockCommands.js'
import { handleListRules, handleDeleteRule } from './rules/businessRules.js'
import { generateMoraleReport, formatMoraleReport } from './intelligence/moraleTracker.js'
import { handleTipModeCommand, handleTipHistory } from './operations/tipPool.js'
import { handleRecognitionHistory } from './engagement/recognition.js'
import { formatCrossTrainingRoster } from './intelligence/crossTraining.js'
import { generateTurnoverRiskReport, formatTurnoverRiskCommand } from './intelligence/turnoverRisk.js'
import { UnifiedBot } from './platform/UnifiedBot.js'
import { TelegramAdapter } from './platform/TelegramAdapter.js'
import { startWebServer } from './server/webServer.js'
import { handleShiftsCommand, handleEditShift, handleAddShift, handleRemoveShift } from './setup/shiftEditor.js'
import { handleViewStaff, handleRemoveStaff } from './setup/staffManager.js'
import { handleCoverageCommand } from './coverage/managerCoverage.js'
import { handleMissedClockOutCheck } from './timeclock/missedClockOut.js'
import { getDb } from './db.js'
import cron from 'node-cron'

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']
if (!process.env.CEREBRAS_API_KEY && !process.env.GROQ_API_KEY) {
  console.error('❌ Missing LLM key: set CEREBRAS_API_KEY or GROQ_API_KEY in .env')
  process.exit(1)
}
const missing = REQUIRED_ENV.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`)
  console.error('Copy .env.example to .env and fill in all values.')
  process.exit(1)
}

const _telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false })
const bot = new UnifiedBot()
bot.registerAdapter('telegram', new TelegramAdapter(_telegramBot))

bot.deleteWebHook({ drop_pending_updates: true })
  .catch(() => {})
  .finally(() => bot.startPolling())

// Start web dashboard server
startWebServer(bot)

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
  startSundayBriefingCron(bot)
  startPreferenceCron(bot)
}).catch((err) => {
  // If Telegram is unreachable at startup, crons must not silently never start.
  // Exit so the host (Render) restarts the process.
  logger.error(`bot.getMe() failed at startup: ${err.message}. Exiting so host restarts.`)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
  logger.error(`unhandledRejection: ${msg}`)
  // Exit so host restarts; staying alive after an unhandled rejection leaves the bot in
  // an unknown state (polling may be poisoned).
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err.message}\n${err.stack}`)
  process.exit(1)
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
  try {
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
  } catch (err) {
    // Per-message failures must never bring down the bot. Log with enough context
    // to identify the offending message, then move on.
    const chatId = msg?.chat?.id
    const userId = msg?.from?.id
    logger.error(`message handler crashed (chat=${chatId} user=${userId}): ${err.message}\n${err.stack}`)
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

bot.onText(/^\/pay/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return // silent

  const parts = msg.text.trim().split(/\s+/)
  const weekArg = parts[1] ?? null // e.g. /pay 2025-01-06
  if (!session.dm_chat_id) {
    await bot.sendMessage(groupId, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
    return
  }
  await bot.sendMessage(groupId, `📨 Pay summary sent to your DM.`)
  await sendPayReport(bot, groupId, weekArg)
})

bot.onText(/^\/staffpay/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession, getStaffForGroup } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return // silent

  const parts = msg.text.trim().split(/\s+/)
  const rawName = parts.slice(1).join(' ').replace(/^@/, '')
  if (!rawName) {
    await bot.sendMessage(groupId, `Usage: /staffpay @username or /staffpay FirstName`)
    return
  }

  const allStaff = await getStaffForGroup(groupId)
  const matched = allStaff.find(s =>
    s.name?.toLowerCase() === rawName.toLowerCase() ||
    s.username?.toLowerCase() === rawName.toLowerCase() ||
    s.name?.toLowerCase().includes(rawName.toLowerCase())
  )
  if (!matched) {
    await bot.sendMessage(groupId, `Could not find staff member "${rawName}".`)
    return
  }

  const history = await getPayrollHistory(matched.id, groupId)
  const report = formatStaffPayHistory(matched.name, history)
  if (session.dm_chat_id) {
    await bot.sendMessage(groupId, `📨 Pay history for ${matched.name} sent to your DM.`)
    await bot.sendMessage(session.dm_chat_id, report, { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(groupId, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
  }
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
  } else {
    await bot.sendMessage(groupId, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
  }
})

bot.onText(/^\/rotation/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  await handleRotationCommand(bot, msg)
})

bot.onText(/^\/copyschedule/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  await handleCopySchedule(bot, msg)
})

bot.onText(/^\/welcome(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const name = (match[1] || '').trim().replace(/^@/, '')
  await handleWelcomeCommand(bot, msg, name)
})

bot.onText(/^\/setovertime/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const session = await getManagerGroup(msg.from.id)
  if (!session) return
  await startOvertimeStep(bot, session.dm_chat_id, String(msg.chat.id), session.setup_data ?? {})
})

bot.onText(/^\/spreadsheet(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  if (!(await isBotAdmin(String(msg.chat.id), msg.from.id))) return
  const weekStart = match[1].trim() || null
  await bot.sendMessage(msg.chat.id, '📊 Generating payroll spreadsheet...')
  await sendPayrollSpreadsheet(bot, String(msg.chat.id), weekStart, null)
})

bot.onText(/^\/revenue(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const raw = match[1].trim()
  if (!raw) return bot.sendMessage(msg.chat.id, 'Usage: /revenue [amount]\nExample: /revenue 14500')
  const revenue = parseRevenueInput(raw)
  if (!revenue && revenue !== 0) return bot.sendMessage(msg.chat.id, "Couldn't parse that amount. Try: /revenue 14500")
  await handleRevenueInput(bot, msg, revenue)
})

bot.onText(/^\/labortrend/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(msg.from?.id)) return
  const history = await getRevenueHistory(groupId)
  const formatted = formatRevenueHistory(history)
  if (session.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, '📨 Labor trend sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, formatted, { parse_mode: 'Markdown' })
  }
})

bot.onText(/^\/setbudget(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return bot.sendMessage(msg.chat.id, '⚠️ Only admins can set the budget.')
  const raw = match[1].trim()
  const amount = parseFloat(raw.replace(/[$,]/g, ''))
  if (!amount || amount <= 0) {
    return bot.sendMessage(msg.chat.id, 'Usage: /setbudget 3200\nSets your weekly labor budget to $3,200')
  }
  await saveBudget(groupId, amount)
  await bot.sendMessage(msg.chat.id, `✅ Weekly labor budget set to $${amount.toFixed(2)}`)
})

bot.onText(/^\/budget$/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const b = await getBudget(String(msg.chat.id))
  if (!b) return await bot.sendMessage(msg.chat.id, 'No budget set. Use /setbudget [amount]')
  await bot.sendMessage(msg.chat.id, `💰 Weekly labor budget: $${b.weeklyBudget}`)
})

bot.onText(/^\/log(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return
  const args = (match[1] || '').trim()
  await handleLogCommand(bot, msg, args)
})

bot.onText(/^\/setmaxshifts(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return await bot.sendMessage(msg.chat.id, '⚠️ Only admins can change this setting.')
  const raw = (match[1] || '').trim().toLowerCase()
  const { getSetupSession, updateSetupSession } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session) return
  if (!raw || raw === 'none' || raw === 'no limit' || raw === '0') {
    const data = { ...(session.setup_data ?? {}), max_shifts_per_day: 0 }
    await updateSetupSession(groupId, { setup_data: data })
    await bot.sendMessage(msg.chat.id, '✅ No limit on shifts per day.')
    return
  }
  const n = parseInt(raw)
  if (isNaN(n) || n < 1 || n > 5) {
    return await bot.sendMessage(msg.chat.id, 'Usage: /setmaxshifts [1-5] or /setmaxshifts none')
  }
  const data = { ...(session.setup_data ?? {}), max_shifts_per_day: n }
  await updateSetupSession(groupId, { setup_data: data })
  await bot.sendMessage(msg.chat.id, `✅ Max shifts per person per day set to ${n}.`)
})

bot.onText(/^\/clockstatus/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleClockStatus(bot, msg)
})

bot.onText(/^\/timesheet(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  const staffName = (match[1] || '').trim().replace(/^@/, '') || null
  await handleTimesheetCommand(bot, msg, staffName)
})

bot.onText(/^\/rules/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  await handleListRules(bot, msg, groupId)
})

bot.onText(/^\/delrule(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const n = parseInt((match[1] || '').trim())
  if (isNaN(n)) {
    await bot.sendMessage(msg.chat.id, 'Usage: /delrule [number]\nSee /rules for the numbered list.')
    return
  }
  await handleDeleteRule(bot, msg, n, groupId)
})

bot.onText(/^\/morale/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const { getSetupSession, getStaffForGroup } = await import('./setup/setupDb.js')
  const session = await getSetupSession(groupId)
  if (!session || String(session.manager_id) !== String(userId)) return
  const allStaff = await getStaffForGroup(groupId)
  const report = await generateMoraleReport(groupId, allStaff)
  const formatted = formatMoraleReport(report)
  if (session.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, '📨 Morale report sent to your DM.')
    await bot.sendMessage(session.dm_chat_id, formatted, { parse_mode: 'Markdown' })
  } else {
    await bot.sendMessage(msg.chat.id, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
  }
})

bot.onText(/^\/tipmode(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const args = (match[1] || '').trim().split(/\s+/).filter(Boolean)
  await handleTipModeCommand(bot, msg, args)
})

bot.onText(/^\/tips$/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  await handleTipHistory(bot, msg)
})

// /setphone +1234567890 — DM command for managers to link their phone for web login
bot.onText(/^\/setphone(.*)/, async (msg, match) => {
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(msg.chat.id, 'Send /setphone in a DM with me, not in the group.')
    return
  }
  try {
    const { getManagerGroup, updateSetupSession } = await import('./setup/setupDb.js')
    const userId = msg.from?.id
    const session = await getManagerGroup(userId)
    if (!session) {
      await bot.sendMessage(msg.chat.id,
        "I couldn't find a Relay setup linked to your account. Make sure you've completed setup in your business's group first.")
      return
    }

    const raw = (match[1] || '').trim()
    if (!raw) {
      const current = session.phone
        ? `Your current number: ${session.phone}`
        : 'No phone number set yet.'
      await bot.sendMessage(msg.chat.id,
        `${current}\n\nSend your number like:\n/setphone +15550001234`)
      return
    }

    const digits = raw.replace(/\D/g, '')
    let normalized
    if (digits.length === 10) normalized = '+1' + digits
    else if (digits.length === 11 && digits[0] === '1') normalized = '+' + digits
    else if (digits.length > 7) normalized = '+' + digits
    else {
      await bot.sendMessage(msg.chat.id, "That doesn't look like a valid phone number. Try: /setphone +15550001234")
      return
    }

    await updateSetupSession(session.group_id, { phone: normalized })
    await bot.sendMessage(msg.chat.id,
      `✅ Phone number set to ${normalized}.\n\nYou can now log in at the Relay dashboard using this number.`)
  } catch (err) {
    logger.error(`/setphone failed: ${err.message}`)
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
  }
})

bot.onText(/^\/kudos(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const name = (match[1] || '').trim()
  await handleRecognitionHistory(bot, msg, name)
})

bot.onText(/^\/crosstraining/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const roster = await formatCrossTrainingRoster(groupId)
  await bot.sendMessage(msg.chat.id, roster, { parse_mode: 'Markdown' })
})

bot.onText(/^\/retention/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const managerDm = await getManagerGroup(userId)
  if (!managerDm?.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
    return
  }
  try {
    const report = await generateTurnoverRiskReport(groupId)
    const formatted = formatTurnoverRiskCommand(report)
    await bot.sendMessage(managerDm.dm_chat_id, formatted, { parse_mode: 'Markdown' })
    await bot.sendMessage(msg.chat.id, '📨 Retention report sent to your DM.')
  } catch (err) {
    logger.error(`/retention failed: ${err.message}`)
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
  }
})

bot.onText(/^\/quality/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  try {
    const { handleQualityCommand } = await import('./intelligence/scheduleQuality.js')
    await handleQualityCommand(bot, msg)
  } catch (err) {
    logger.error(`/quality failed: ${err.message}`)
  }
})

bot.onText(/^\/patterns/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const managerDm = await getManagerGroup(userId)
  if (!managerDm?.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, `⚠️ DM me first so I can send you reports. Message @${BOT_USERNAME} to get started.`)
    return
  }
  try {
    const { analyzeAllShifts, generateStaffingRecommendations, formatStaffingPatternAlert, detectSeasonalPatterns, formatSeasonalInsight } = await import('./intelligence/staffingPatterns.js')
    const patterns = await analyzeAllShifts(groupId, 8)
    const recs = generateStaffingRecommendations(patterns)
    let report = formatStaffingPatternAlert(recs) || 'No staffing patterns detected yet. Need 6+ weeks of schedule data.'
    const seasonal = await detectSeasonalPatterns(groupId)
    const seasonalText = formatSeasonalInsight(seasonal, new Date().getMonth())
    if (seasonalText) report += '\n\n' + seasonalText
    await bot.sendMessage(managerDm.dm_chat_id, report, { parse_mode: 'Markdown' })
    await bot.sendMessage(msg.chat.id, '📨 Staffing patterns report sent to your DM.')
  } catch (err) {
    logger.error(`/patterns failed: ${err.message}`)
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
  }
})

bot.onText(/^\/staffinsight(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  const isAdmin = await isAuthorizedAdmin(groupId, userId)
  if (!isAdmin) return
  const managerDm = await getManagerGroup(userId)
  if (!managerDm?.dm_chat_id) {
    await bot.sendMessage(msg.chat.id, `⚠️ DM me first so I can send you reports.`)
    return
  }
  const name = (match[1] || '').trim()
  if (!name) {
    await bot.sendMessage(msg.chat.id, 'Usage: /staffinsight [name]')
    return
  }
  try {
    const { getStaffForGroup } = await import('./setup/setupDb.js')
    const allStaff = await getStaffForGroup(groupId)
    const matched = allStaff.find(s => s.name?.toLowerCase().includes(name.toLowerCase()))
    if (!matched) {
      await bot.sendMessage(msg.chat.id, `Could not find staff member "${name}".`)
      return
    }
    const { calculateReliableAvailability, formatAvailabilityInsight } = await import('./intelligence/availabilityLearning.js')
    const reliability = await calculateReliableAvailability(matched.id, groupId, 8)
    const text = formatAvailabilityInsight(matched.name, reliability)
    await bot.sendMessage(managerDm.dm_chat_id, text, { parse_mode: 'Markdown' })
    await bot.sendMessage(msg.chat.id, `📨 Staff insight for ${matched.name} sent to your DM.`)
  } catch (err) {
    logger.error(`/staffinsight failed: ${err.message}`)
    await bot.sendMessage(msg.chat.id, 'Something went wrong — try again.')
  }
})

function startPreferenceCron(bot) {
  // Sunday at midnight — analyze edit patterns and save preferences
  cron.schedule('0 0 * * 0', async () => {
    try {
      const supabase = getDb()
      const { data: groups } = await supabase.from('setup_sessions').select('group_id, dm_chat_id').eq('setup_complete', true)
      if (!groups) return

      const { getEditHistory } = await import('./intelligence/preferenceDb.js')
      const { analyzePatterns, formatNewPatternAlert } = await import('./intelligence/preferenceTracker.js')
      const { savePreference } = await import('./intelligence/preferenceDb.js')

      for (const { group_id: groupId, dm_chat_id: dmChatId } of groups) {
        const history = await getEditHistory(groupId, 8)
        if (history.length < 2) continue
        const patterns = analyzePatterns(history)
        for (const p of patterns) {
          if (p.confidence >= 0.75) {
            await savePreference(groupId, { type: `avoid_${p.type === 'remove' ? 'day' : 'shift'}`, staffId: p.staffId, staffName: p.staffName, dayOfWeek: p.dayOfWeek ?? null, shiftId: p.shiftId ?? null, confidence: p.confidence, sampleSize: p.count, autoApply: true })
          } else if (p.confidence >= 0.5 && dmChatId) {
            const alertMsg = formatNewPatternAlert(p)
            try { await bot.sendMessage(dmChatId, alertMsg, { parse_mode: 'Markdown' }) } catch (_) {}
          }
        }
      }
      logger.info('Preference analysis cron complete')
    } catch (err) {
      logger.error(`Preference cron error: ${err.message}`)
    }
  })
  logger.info('Preference analysis cron started (Sunday midnight)')
}

bot.onText(/^\/shifts/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleShiftsCommand(bot, msg)
})

bot.onText(/^\/editshift(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleEditShift(bot, msg, (match[1] || '').trim())
})

bot.onText(/^\/addshift/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleAddShift(bot, msg)
})

bot.onText(/^\/removeshift(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleRemoveShift(bot, msg, (match[1] || '').trim())
})

bot.onText(/^\/staff/, async (msg) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleViewStaff(bot, msg)
})

bot.onText(/^\/removestaff(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleRemoveStaff(bot, msg, (match[1] || '').trim())
})

bot.onText(/^\/coverage(.*)/, async (msg, match) => {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return
  const isAdmin = await isAuthorizedAdmin(String(msg.chat.id), msg.from?.id)
  if (!isAdmin) return
  await handleCoverageCommand(bot, msg, match)
})

cron.schedule('*/15 * * * *', async () => {
  try {
    const supabase = getDb()
    const { data: groups } = await supabase.from('setup_sessions').select('group_id, setup_data').eq('setup_complete', true)
    for (const g of groups || []) {
      // Skip groups that have disabled the time clock
      if (g.setup_data?.timeclockEnabled === false) continue
      await handleMissedClockOutCheck(bot, g.group_id)
    }
  } catch (err) {
    logger.error(`Missed clock-out cron error: ${err.message}`)
  }
})

// Coverage-fill escalation: 30/60/120-min ladder for unanswered coverage requests.
cron.schedule('*/10 * * * *', async () => {
  try {
    const { runEscalationSweep } = await import('./coverage/escalationCron.js')
    const result = await runEscalationSweep(bot)
    if (result.advanced > 0) {
      logger.info(`Coverage escalation sweep: ${result.advanced} of ${result.processed} requests advanced`)
    }
  } catch (err) {
    logger.error(`Coverage escalation cron error: ${err.message}`)
  }
})
logger.info('Coverage escalation cron started (every 10 minutes)')

process.on('SIGINT', () => {
  logger.bot('Shutting down gracefully...')
  bot.stopPolling()
  process.exit(0)
})
