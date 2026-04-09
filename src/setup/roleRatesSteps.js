import { updateRoleRate, getUniqueRolesForGroup } from './db/roles.js'
import { updateSetupSession } from './setupDb.js'
import { logger } from '../logger.js'

// Pure validator — exported for unit tests
export function parseRateInput(raw) {
  const cleaned = String(raw ?? '').trim().replace(/^\$/, '')
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  if (isNaN(n) || n <= 0) return null
  return n
}

// Moves to role_rates step (or skips to add_staff if no roles)
export async function moveToRoleRatesStep(bot, msg, session, db = null) {
  const _getUniqueRoles = db?.getUniqueRolesForGroup
    ? (gid) => db.getUniqueRolesForGroup(gid)
    : (gid) => getUniqueRolesForGroup(gid)
  const _updateSession = db?.updateSetupSession
    ? (gid, u) => db.updateSetupSession(gid, u)
    : (gid, u) => updateSetupSession(gid, u)

  const chatId = msg.chat.id
  const roles = await _getUniqueRoles(session.group_id)

  if (roles.length === 0) {
    await _updateSession(session.group_id, { step: 'add_staff' })
    await bot.sendMessage(chatId,
      `Great! Now let's add your staff.\n\nTell me who works there and their roles:\n\n` +
      `• _John and Sarah are servers, Mike is a cook_\n` +
      `• _Emma - manager, Tom - bartender, Lisa - host_\n\n` +
      `Send them all at once or one at a time. Send *done* when finished, or *skip* to skip.`,
      { parse_mode: 'Markdown' })
    return
  }

  await _updateSession(session.group_id, {
    step: 'role_rates',
    setup_data: { ...session.setup_data, role_rates_pending: roles, role_rates_saved: [] },
  })

  await bot.sendMessage(chatId,
    `💵 What's the hourly rate for *${roles[0]}*?\n` +
    `Enter a number (e.g. 15 or 15.50)`,
    { parse_mode: 'Markdown' })
}

export async function handleRoleRatesStep(bot, msg, session, text, db = null) {
  const _updateRoleRate = db?.updateRoleRate
    ? (gid, role, rate) => db.updateRoleRate(gid, role, rate)
    : (gid, role, rate) => updateRoleRate(gid, role, rate)
  const _updateSession = db?.updateSetupSession
    ? (gid, u) => db.updateSetupSession(gid, u)
    : (gid, u) => updateSetupSession(gid, u)

  const chatId = msg.chat.id
  const pending = session.setup_data?.role_rates_pending ?? []
  const saved = session.setup_data?.role_rates_saved ?? []
  const currentRole = pending[0]

  if (!currentRole) {
    logger.error('handleRoleRatesStep: no pending roles — this should not happen')
    return
  }

  const rate = parseRateInput(text)
  if (rate === null) {
    await bot.sendMessage(chatId,
      `That doesn't look right — enter a number like 15 or 15.50`)
    return
  }

  await _updateRoleRate(session.group_id, currentRole, rate)
  const newSaved = [...saved, { roleName: currentRole, hourlyRate: rate }]
  const newPending = pending.slice(1)

  if (newPending.length > 0) {
    // More roles to ask
    await _updateSession(session.group_id, {
      setup_data: {
        ...session.setup_data,
        role_rates_pending: newPending,
        role_rates_saved: newSaved,
      },
    })
    await bot.sendMessage(chatId,
      `💵 What's the hourly rate for *${newPending[0]}*?\n` +
      `Enter a number (e.g. 15 or 15.50)`,
      { parse_mode: 'Markdown' })
    return
  }

  // All done — show confirmation and move to add_staff
  const allSaved = newSaved
  const rateList = allSaved
    .map(r => `• ${r.roleName}: $${r.hourlyRate.toFixed(2)}/hr`)
    .join('\n')

  await _updateSession(session.group_id, {
    step: 'add_staff',
    setup_data: {
      ...session.setup_data,
      role_rates_pending: [],
      role_rates_saved: allSaved,
    },
  })

  await bot.sendMessage(chatId,
    `✅ Pay rates saved:\n${rateList}\n\n` +
    `You can update these anytime with /setrate\n\n` +
    `Now let's add your staff.\n\nTell me who works there and their roles:\n\n` +
    `• _John and Sarah are servers, Mike is a cook_\n` +
    `• _Emma - manager, Tom - bartender_\n\n` +
    `Send them all at once or one at a time. Send *done* when finished, or *skip* to skip.`,
    { parse_mode: 'Markdown' })

  logger.success(`Pay rates saved for group ${session.group_id}`)
}
