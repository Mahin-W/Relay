import { updateSetupSession } from './setupDb.js'
import { saveOvertimeSettings } from './setupDb.js'
import { logger } from '../logger.js'

function parsePositiveFloat(text) {
  const n = parseFloat(text)
  return isNaN(n) ? null : n
}

// db injection wrapper — updateSetupSession doesn't take a db param natively
function _update(groupId, fields, db) {
  if (db?.updateSetupSession) return db.updateSetupSession(groupId, fields)
  return updateSetupSession(groupId, fields)
}

function _save(groupId, settings, db) {
  if (db?.saveOvertimeSettings) return db.saveOvertimeSettings(groupId, settings)
  return saveOvertimeSettings(groupId, settings)
}

async function finishOvertimeSetup(bot, msg, session, db) {
  const d = session.setup_data ?? {}
  const settings = {
    overtime_enabled: d.overtime_enabled ?? false,
    weekly_threshold: d.overtime_weekly_threshold ?? 40,
    weekly_multiplier: d.overtime_weekly_multiplier ?? 1.5,
    daily_overtime_enabled: d.overtime_daily_enabled ?? false,
    daily_threshold: d.overtime_daily_threshold ?? 8,
    daily_multiplier: 1.5,
  }
  await _save(session.group_id, settings, db)

  let summary = `✅ *Overtime settings saved:*\n`
  if (!settings.overtime_enabled) {
    summary += `• No overtime configured.`
  } else {
    summary += `• Weekly OT: after ${settings.weekly_threshold}hrs @ ${settings.weekly_multiplier}x pay\n`
    if (settings.daily_overtime_enabled) {
      summary += `• Daily OT: after ${settings.daily_threshold}hrs @ ${settings.daily_multiplier}x pay`
    }
  }
  await bot.sendMessage(msg.chat.id, summary, { parse_mode: 'Markdown' })

  await _update(session.group_id, { step: 'complete', setup_complete: true }, db)

  try {
    const managerName = msg.from?.first_name || 'The manager'
    await bot.sendMessage(
      session.group_id,
      `✅ *Relay Setup Complete*\n\n${managerName} has finished configuring Relay for this group.\nI'm now ready to handle shift coverage automatically.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    logger.error(`Could not announce setup complete: ${err.message}`)
  }

  logger.success(`Setup complete (with overtime) for group ${session.group_id}`)
}

export async function handleOvertimeStep(bot, msg, session, text, db = null) {
  const stage = session.setup_data?.overtime_stage ?? 'ask_enabled'
  const chatId = msg.chat.id
  const yn = text.toLowerCase().trim()

  if (stage === 'ask_enabled') {
    if (yn === 'yes') {
      await _update(session.group_id, {
        setup_data: { ...session.setup_data, overtime_enabled: true, overtime_stage: 'ask_weekly_threshold' },
      }, db)
      await bot.sendMessage(chatId,
        `After how many hours per *week* does overtime kick in? _(Most common: 40)_\nReply with a number.`,
        { parse_mode: 'Markdown' })
    } else if (yn === 'no') {
      const newData = { ...session.setup_data, overtime_enabled: false }
      await _update(session.group_id, { setup_data: newData }, db)
      await finishOvertimeSetup(bot, msg, { ...session, setup_data: newData }, db)
    } else {
      await bot.sendMessage(chatId, `Please reply *yes* or *no*.`, { parse_mode: 'Markdown' })
    }
    return
  }

  if (stage === 'ask_weekly_threshold') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 0 || n > 80) {
      await bot.sendMessage(chatId, `Enter a number between 1 and 80, like 40 or 35.`)
      return
    }
    await _update(session.group_id, {
      setup_data: { ...session.setup_data, overtime_weekly_threshold: n, overtime_stage: 'ask_weekly_multiplier' },
    }, db)
    await bot.sendMessage(chatId,
      `What's your overtime pay multiplier?\n• 1.5 = time and a half _(most common)_\n• 2.0 = double time\nReply with a number greater than 1.`,
      { parse_mode: 'Markdown' })
    return
  }

  if (stage === 'ask_weekly_multiplier') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 1.0 || n > 3.0) {
      await bot.sendMessage(chatId, `Enter a number like 1.5 or 2.0 (must be more than 1.0 and at most 3.0).`)
      return
    }
    await _update(session.group_id, {
      setup_data: { ...session.setup_data, overtime_weekly_multiplier: n, overtime_stage: 'ask_daily' },
    }, db)
    await bot.sendMessage(chatId,
      `Do you also pay *daily* overtime?\n_(Some states require extra pay after 8hrs/day)_\nReply *yes* or *no*.`,
      { parse_mode: 'Markdown' })
    return
  }

  if (stage === 'ask_daily') {
    if (yn === 'yes') {
      await _update(session.group_id, {
        setup_data: { ...session.setup_data, overtime_daily_enabled: true, overtime_stage: 'ask_daily_threshold' },
      }, db)
      await bot.sendMessage(chatId,
        `After how many hours in one day? _(Most common: 8)_\nReply with a number.`,
        { parse_mode: 'Markdown' })
    } else if (yn === 'no') {
      const newData = { ...session.setup_data, overtime_daily_enabled: false }
      await _update(session.group_id, { setup_data: newData }, db)
      await finishOvertimeSetup(bot, msg, { ...session, setup_data: newData }, db)
    } else {
      await bot.sendMessage(chatId, `Please reply *yes* or *no*.`, { parse_mode: 'Markdown' })
    }
    return
  }

  if (stage === 'ask_daily_threshold') {
    const n = parsePositiveFloat(text)
    if (!n || n <= 0 || n > 24) {
      await bot.sendMessage(chatId, `Enter a number between 1 and 24.`)
      return
    }
    const newData = { ...session.setup_data, overtime_daily_threshold: n }
    await _update(session.group_id, { setup_data: newData }, db)
    await finishOvertimeSetup(bot, msg, { ...session, setup_data: newData }, db)
  }
}

export async function startOvertimeStep(bot, chatId, groupId, setupData, db = null) {
  await _update(groupId, {
    step: 'overtime_setup',
    setup_data: { ...(setupData ?? {}), overtime_stage: 'ask_enabled' },
  }, db)
  await bot.sendMessage(chatId,
    `⏰ *Overtime settings*\nDoes your business pay overtime?\nReply *yes* or *no*`,
    { parse_mode: 'Markdown' })
}
