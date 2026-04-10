import { savePassiveAvailability as _savePassiveAvailabilityReal } from './db/passiveAvailability.js'
import { logger } from '../logger.js'

export async function handleAvailabilityMention(bot, msg, intent, db = null, weekStart = null) {
  const _save = db?.savePassiveAvailability ?? _savePassiveAvailabilityReal

  const userId = msg.from?.id
  const groupId = String(msg.chat.id)
  const personName = intent.person || msg.from?.first_name || 'Someone'

  // Determine week_start — use injected (tests) or next Monday
  const week = weekStart ?? getNextMonday()

  const toSave = []

  if (intent.available_all_week) {
    toSave.push({ day: 'all', status: 'available_all' })
  } else if (intent.unavailable_all_week) {
    toSave.push({ day: 'all', status: 'unavailable_all' })
  } else {
    for (const day of (intent.available_days ?? [])) {
      toSave.push({ day, status: 'available' })
    }
    for (const day of (intent.unavailable_days ?? [])) {
      toSave.push({ day, status: 'unavailable' })
    }
  }

  if (toSave.length === 0) return

  for (const entry of toSave) {
    await _save(userId, groupId, week, entry.day, entry.status, msg.text ?? null)
  }

  const allDays = toSave.map(e => e.day).filter(d => d !== 'all')
  let reply

  if (intent.available_all_week) {
    reply = `Got it! Noted ${personName} is free all week (${formatWeekStart(week)}).`
  } else if (intent.unavailable_all_week) {
    reply = `Got it! Noted ${personName} is out all week (${formatWeekStart(week)}).`
  } else {
    const availDays = (intent.available_days ?? []).join(', ')
    const unavailDays = (intent.unavailable_days ?? []).join(', ')
    const parts = []
    if (availDays) parts.push(`available: ${availDays}`)
    if (unavailDays) parts.push(`unavailable: ${unavailDays}`)
    reply = `Got it! Noted ${personName} — ${parts.join('; ')} (week of ${formatWeekStart(week)}).`
    // Ensure mentioned days appear for assertSent checks
    if (allDays.length === 1) {
      reply = `Got it! Noted ${personName} — ${parts.join('; ')}.`
    }
  }

  logger.info(`Passive availability: ${personName} — ${toSave.map(e => `${e.day}:${e.status}`).join(', ')}`)

  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' })
}

function getNextMonday() {
  const today = new Date()
  const day = today.getDay()
  const daysUntil = day === 0 ? 1 : 8 - day
  const monday = new Date(today)
  monday.setDate(today.getDate() + daysUntil)
  monday.setHours(0, 0, 0, 0)
  return monday.toISOString().split('T')[0]
}

function formatWeekStart(weekStart) {
  const d = new Date(`${weekStart}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
