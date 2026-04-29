import { updateSetupSession } from './setupDb.js'
import { saveTipSettings } from './setupDb.js'
import { logger } from '../logger.js'

function _update(groupId, fields, db) {
  if (db?.updateSetupSession) return db.updateSetupSession(groupId, fields)
  return updateSetupSession(groupId, fields)
}

function _save(groupId, settings, db) {
  if (db?.saveTipSettings) return db.saveTipSettings(groupId, settings)
  return saveTipSettings(groupId, settings)
}

export async function startTipSettingsStep(bot, chatId, groupId, setupData, db = null) {
  await _update(groupId, {
    step: 'tip_settings',
    setup_data: { ...(setupData ?? {}), tip_stage: 'ask_mode' },
  }, db)
  await bot.sendMessage(chatId,
    `💰 *Tip settings*\nHow does your business handle tips?\n\n` +
    `1️⃣ Pool and split\n` +
    `2️⃣ Staff keep own\n` +
    `3️⃣ Cash manual\n\n` +
    `Reply 1, 2, or 3.`,
    { parse_mode: 'Markdown' })
}

export async function handleTipSettingsStep(bot, msg, session, text, db = null) {
  const stage = session.setup_data?.tip_stage ?? 'ask_mode'
  const chatId = msg.chat.id
  const input = text.toLowerCase().trim()

  if (stage === 'ask_mode') {
    if (input === '1' || input === 'pool') {
      await _update(session.group_id, {
        setup_data: { ...session.setup_data, tip_mode: 'pool', tip_stage: 'ask_split_method' },
      }, db)
      await bot.sendMessage(chatId,
        `How should tips be split?\n\n` +
        `1️⃣ By hours worked\n` +
        `2️⃣ Equal split\n` +
        `3️⃣ By role points\n\n` +
        `Reply 1, 2, or 3.`)
    } else if (input === '2' || input === 'individual') {
      await _save(session.group_id, { mode: 'individual', splitMethod: 'hours', bohIncluded: false }, db)
      await _finishTipSettings(bot, msg, session, 'individual', db)
    } else if (input === '3' || input === 'cash') {
      await _save(session.group_id, { mode: 'cash', splitMethod: 'hours', bohIncluded: false }, db)
      await _finishTipSettings(bot, msg, session, 'cash', db)
    } else {
      await bot.sendMessage(chatId, `Please reply *1*, *2*, or *3*.`, { parse_mode: 'Markdown' })
    }
    return
  }

  if (stage === 'ask_split_method') {
    let splitMethod
    if (input === '1' || input === 'hours') splitMethod = 'hours'
    else if (input === '2' || input === 'equal') splitMethod = 'equal'
    else if (input === '3' || input === 'points') splitMethod = 'points'
    else {
      await bot.sendMessage(chatId, `Please reply *1*, *2*, or *3*.`, { parse_mode: 'Markdown' })
      return
    }
    await _update(session.group_id, {
      setup_data: { ...session.setup_data, tip_split_method: splitMethod, tip_stage: 'ask_boh' },
    }, db)
    await bot.sendMessage(chatId,
      `Should back-of-house staff (cooks, dishwashers) be included in the tip pool?\n` +
      `Reply *yes* or *no*.`,
      { parse_mode: 'Markdown' })
    return
  }

  if (stage === 'ask_boh') {
    if (input === 'yes') {
      const settings = {
        mode: 'pool',
        splitMethod: session.setup_data?.tip_split_method ?? 'hours',
        bohIncluded: true,
      }
      await _save(session.group_id, settings, db)
      await _finishTipSettings(bot, msg, session, 'pool', db)
    } else if (input === 'no') {
      const settings = {
        mode: 'pool',
        splitMethod: session.setup_data?.tip_split_method ?? 'hours',
        bohIncluded: false,
      }
      await _save(session.group_id, settings, db)
      await _finishTipSettings(bot, msg, session, 'pool', db)
    } else {
      await bot.sendMessage(chatId, `Please reply *yes* or *no*.`, { parse_mode: 'Markdown' })
    }
    return
  }
}

async function _finishTipSettings(bot, msg, session, mode, db) {
  const chatId = msg.chat.id
  const labels = { pool: 'Pool and split', individual: 'Staff keep own', cash: 'Cash manual' }
  await bot.sendMessage(chatId,
    `✅ Tip settings saved: *${labels[mode] || mode}*\nYou can change this anytime with /tipmode`,
    { parse_mode: 'Markdown' })

  // Move to overtime_setup (next step after tip_settings)
  const { startOvertimeStep } = await import('./overtimeSteps.js')
  await startOvertimeStep(bot, chatId, session.group_id, session.setup_data, db)

  logger.success(`Tip settings saved for group ${session.group_id}: ${mode}`)
}
