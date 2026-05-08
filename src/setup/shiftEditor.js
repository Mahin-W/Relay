import { getDb } from '../db.js'

// ── DB functions ──────────────────────────────────────────────────────────────

export async function getShiftsForGroup(groupId, db = null) {
  try {
    const { data, error } = await getDb()
      .from('shifts')
      .select('*')
      .eq('group_id', String(groupId))
      .eq('active', true)
      .order('day_of_week')
      .order('start_time')
    if (error) throw error
    return data ?? []
  } catch (err) {
    console.error('[shiftEditor] getShiftsForGroup error:', err.message)
    return []
  }
}

export async function updateShift(shiftId, groupId, changes, db = null) {
  try {
    const fields = {}
    if (changes.name !== undefined) fields.name = changes.name
    if (changes.start_time !== undefined) fields.start_time = changes.start_time
    if (changes.end_time !== undefined) fields.end_time = changes.end_time
    const { data, error } = await getDb()
      .from('shifts')
      .update(fields)
      .eq('id', shiftId)
      .eq('group_id', String(groupId))
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    console.error('[shiftEditor] updateShift error:', err.message)
    return null
  }
}

export async function deactivateShift(shiftId, groupId, db = null) {
  try {
    if (db?.deactivateShift) {
      return await db.deactivateShift(shiftId, groupId)
    }
    const { data, error } = await getDb()
      .from('shifts')
      .update({ active: false })
      .eq('id', shiftId)
      .eq('group_id', String(groupId))
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    console.error('[shiftEditor] deactivateShift error:', err.message)
    return null
  }
}

export async function createShift(groupId, shiftData, db = null) {
  try {
    const { data, error } = await getDb()
      .from('shifts')
      .insert({
        group_id: String(groupId),
        name: shiftData.name,
        day_of_week: shiftData.dayOfWeek,
        start_time: shiftData.startTime,
        end_time: shiftData.endTime,
        active: true,
      })
      .select()
      .single()
    if (error) throw error
    return data
  } catch (err) {
    console.error('[shiftEditor] createShift error:', err.message)
    return null
  }
}

// ── Pure functions ────────────────────────────────────────────────────────────

export function formatShiftList(shifts) {
  if (!shifts || shifts.length === 0) return 'No shifts set up yet.'
  const lines = shifts.map((s, i) => `${i + 1}. ${s.day_of_week} ${s.name} (${s.start_time}–${s.end_time})`)
  return `📋 *Your shifts:*\n${lines.join('\n')}\n\n/editshift [n] · /addshift · /removeshift [n]`
}

export function parseTimeInput(text) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim().toLowerCase()
  if (!trimmed) return null

  const ampmMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10)
    const minutes = parseInt(ampmMatch[2] ?? '0', 10)
    const period = ampmMatch[3]
    if (hours < 1 || hours > 12) return null
    if (period === 'am') {
      if (hours === 12) hours = 0
    } else {
      if (hours !== 12) hours += 12
    }
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  const h24Match = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  if (h24Match) {
    const hours = parseInt(h24Match[1], 10)
    const minutes = parseInt(h24Match[2], 10)
    if (hours < 0 || hours > 23) return null
    if (minutes < 0 || minutes > 59) return null
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  return null
}

// ── Reply collector ───────────────────────────────────────────────────────────

let _replyTimeoutMs = 120_000
export function setReplyTimeout(ms) { _replyTimeoutMs = ms }

function waitForReply(bot, chatId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), _replyTimeoutMs)
    bot.once('message', (reply) => {
      if (String(reply.chat.id) === String(chatId)) {
        clearTimeout(timer)
        resolve(reply)
      }
    })
  })
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleShiftsCommand(bot, msg, db = null) {
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup
  const chatId = msg.chat.id
  try {
    const groupId = msg.chat.type === 'private' ? chatId : chatId
    const shifts = await _getShiftsForGroup(groupId)
    const text = formatShiftList(shifts)
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[shiftEditor] handleShiftsCommand error:', err.message)
    await bot.sendMessage(chatId, 'Something went wrong loading shifts.')
  }
}

export async function handleEditShift(bot, msg, args, db = null) {
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup
  const _updateShift = db?.updateShift ?? updateShift
  const chatId = msg.chat.id
  try {
    const groupId = msg.chat.type === 'private' ? chatId : chatId
    const shifts = await _getShiftsForGroup(groupId)
    const index = parseInt(args, 10)

    if (!index || index < 1 || index > shifts.length) {
      await bot.sendMessage(chatId, 'Shift not found. Use /shifts to see the list.')
      return
    }

    const shift = shifts[index - 1]
    await bot.sendMessage(
      chatId,
      `Editing *${shift.day_of_week} ${shift.name}* (${shift.start_time}–${shift.end_time})\n\nWhat would you like to change?\n1. Name\n2. Start time\n3. End time\n4. All fields`,
      { parse_mode: 'Markdown' }
    )

    const reply = await waitForReply(bot, chatId)
    if (!reply) {
      await bot.sendMessage(chatId, 'Edit timed out.')
      return
    }

    const choice = reply.text?.trim()
    if (choice === '1') {
      await bot.sendMessage(chatId, 'Enter the new name:')
      const nameReply = await waitForReply(bot, chatId)
      if (!nameReply) return
      await _updateShift(shift.id, groupId, { name: nameReply.text.trim() })
      await bot.sendMessage(chatId, '✅ Name updated.')
    } else if (choice === '2') {
      await bot.sendMessage(chatId, 'Enter the new start time (e.g. 11am or 11:00):')
      const timeReply = await waitForReply(bot, chatId)
      if (!timeReply) return
      const parsed = parseTimeInput(timeReply.text.trim())
      if (!parsed) {
        await bot.sendMessage(chatId, 'Invalid time format. Edit cancelled.')
        return
      }
      await _updateShift(shift.id, groupId, { start_time: parsed })
      await bot.sendMessage(chatId, '✅ Start time updated.')
    } else if (choice === '3') {
      await bot.sendMessage(chatId, 'Enter the new end time (e.g. 4pm or 16:00):')
      const timeReply = await waitForReply(bot, chatId)
      if (!timeReply) return
      const parsed = parseTimeInput(timeReply.text.trim())
      if (!parsed) {
        await bot.sendMessage(chatId, 'Invalid time format. Edit cancelled.')
        return
      }
      await _updateShift(shift.id, groupId, { end_time: parsed })
      await bot.sendMessage(chatId, '✅ End time updated.')
    } else if (choice === '4') {
      await bot.sendMessage(chatId, 'Enter the new name:')
      const nameReply = await waitForReply(bot, chatId)
      if (!nameReply) return
      await bot.sendMessage(chatId, 'Enter the new start time:')
      const startReply = await waitForReply(bot, chatId)
      if (!startReply) return
      const startParsed = parseTimeInput(startReply.text.trim())
      if (!startParsed) {
        await bot.sendMessage(chatId, 'Invalid start time. Edit cancelled.')
        return
      }
      await bot.sendMessage(chatId, 'Enter the new end time:')
      const endReply = await waitForReply(bot, chatId)
      if (!endReply) return
      const endParsed = parseTimeInput(endReply.text.trim())
      if (!endParsed) {
        await bot.sendMessage(chatId, 'Invalid end time. Edit cancelled.')
        return
      }
      await _updateShift(shift.id, groupId, {
        name: nameReply.text.trim(),
        start_time: startParsed,
        end_time: endParsed,
      })
      await bot.sendMessage(chatId, '✅ Shift updated.')
    } else {
      await bot.sendMessage(chatId, 'Invalid choice. Edit cancelled.')
    }
  } catch (err) {
    console.error('[shiftEditor] handleEditShift error:', err.message)
    await bot.sendMessage(chatId, 'Something went wrong editing the shift.')
  }
}

export async function handleAddShift(bot, msg, db = null) {
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup
  const _createShift = db?.createShift ?? createShift
  const chatId = msg.chat.id
  try {
    const groupId = msg.chat.type === 'private' ? chatId : chatId

    await bot.sendMessage(chatId, 'What is the name of the new shift? (e.g. Lunch, Evening)')
    const nameReply = await waitForReply(bot, chatId)
    if (!nameReply) { await bot.sendMessage(chatId, 'Timed out.'); return }
    const name = nameReply.text.trim()

    await bot.sendMessage(chatId, 'Which day? (e.g. Monday, Tuesday, … or All)')
    const dayReply = await waitForReply(bot, chatId)
    if (!dayReply) { await bot.sendMessage(chatId, 'Timed out.'); return }
    const dayOfWeek = dayReply.text.trim()

    let startTime = null
    while (!startTime) {
      await bot.sendMessage(chatId, 'Start time? (e.g. 11am or 11:00)')
      const startReply = await waitForReply(bot, chatId)
      if (!startReply) { await bot.sendMessage(chatId, 'Timed out.'); return }
      startTime = parseTimeInput(startReply.text.trim())
      if (!startTime) await bot.sendMessage(chatId, 'Invalid time format. Try again.')
    }

    let endTime = null
    while (!endTime) {
      await bot.sendMessage(chatId, 'End time? (e.g. 4pm or 16:00)')
      const endReply = await waitForReply(bot, chatId)
      if (!endReply) { await bot.sendMessage(chatId, 'Timed out.'); return }
      endTime = parseTimeInput(endReply.text.trim())
      if (!endTime) await bot.sendMessage(chatId, 'Invalid time format. Try again.')
    }

    await _createShift(groupId, { name, dayOfWeek: dayOfWeek, startTime, endTime })
    const shifts = await _getShiftsForGroup(groupId)
    await bot.sendMessage(chatId, `✅ Shift added!\n\n${formatShiftList(shifts)}`, { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[shiftEditor] handleAddShift error:', err.message)
    await bot.sendMessage(chatId, 'Something went wrong adding the shift.')
  }
}

export async function handleRemoveShift(bot, msg, args, db = null) {
  const _getShiftsForGroup = db?.getShiftsForGroup ?? getShiftsForGroup
  const _deactivateShift = db?.deactivateShiftFn ?? deactivateShift
  const _getAssignments = db?.getActiveAssignments ?? getActiveAssignments
  const chatId = msg.chat.id
  try {
    const groupId = msg.chat.type === 'private' ? chatId : chatId
    const shifts = await _getShiftsForGroup(groupId)
    const index = parseInt(args, 10)

    if (!index || index < 1 || index > shifts.length) {
      await bot.sendMessage(chatId, 'Shift not found. Use /shifts to see the list.')
      return
    }

    const shift = shifts[index - 1]
    const assignments = await _getAssignments(shift.id, groupId)
    const activeCount = assignments.length

    if (activeCount > 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ This shift has ${activeCount} active assignment${activeCount > 1 ? 's' : ''} this week. Remove anyway? Reply *yes* or *no*`,
        { parse_mode: 'Markdown' }
      )
      const confirmReply = await waitForReply(bot, chatId)
      if (!confirmReply || confirmReply.text?.trim().toLowerCase() !== 'yes') {
        await bot.sendMessage(chatId, 'Cancelled.')
        return
      }
    }

    await _deactivateShift(shift.id, groupId)
    await bot.sendMessage(chatId, `✅ Shift "${shift.name}" removed.`)
  } catch (err) {
    console.error('[shiftEditor] handleRemoveShift error:', err.message)
    await bot.sendMessage(chatId, 'Something went wrong removing the shift.')
  }
}

async function getActiveAssignments(shiftId, groupId) {
  try {
    const { data, error } = await getDb()
      .from('schedule_assignments')
      .select('*')
      .eq('shift_id', shiftId)
      .eq('group_id', String(groupId))
      .neq('status', 'cancelled')
    if (error) throw error
    return data ?? []
  } catch (err) {
    console.error('[shiftEditor] getActiveAssignments error:', err.message)
    return []
  }
}
