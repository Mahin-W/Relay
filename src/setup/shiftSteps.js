import { getShiftsForGroup, saveShift, saveShiftRequirement, deleteShiftsForGroup, deleteShiftRequirementsForGroup, updateSetupSession } from './setupDb.js'
import { parseShift, parseShiftRequirements } from '../parseMessage.js'
import { logger } from '../logger.js'

export async function handleAddShiftsStep(bot, msg, session, text) {
  if (/^(done|finish|finished|that'?s? it|thats it)$/i.test(text)) {
    const shifts = await getShiftsForGroup(session.group_id)
    if (shifts.length === 0) {
      await bot.sendMessage(msg.chat.id,
        `You haven't added any shifts yet. Add at least one, or send *skip* to continue without shifts.`,
        { parse_mode: 'Markdown' })
      return
    }
    await moveToShiftRolesStep(bot, msg, session)
    return
  }

  if (/^skip$/i.test(text)) {
    await moveToShiftRolesStep(bot, msg, session)
    return
  }

  const parsed = await parseShift(text)

  if (!parsed || parsed.length === 0) {
    await bot.sendMessage(msg.chat.id,
      `I couldn't quite parse that. Try something like:\n\n` +
      `_Saturday Lunch, 11am–3pm_\n` +
      `_2 shifts a day, 8am–12pm and 12pm–4pm, Mon–Fri_\n\n` +
      `Or send *done* if you're finished.`,
      { parse_mode: 'Markdown' })
    return
  }

  const results = await Promise.all(
    parsed.map(s => saveShift(session.group_id, s.name, s.day_of_week, s.start_time, s.end_time))
  )
  const saved = results.filter(Boolean)

  if (saved.length === 0) {
    await bot.sendMessage(msg.chat.id, `Something went wrong saving those shifts — try again?`)
    return
  }

  const list = parsed.map(s => `• *${s.name}* — ${s.day_of_week}, ${s.start_time}–${s.end_time}`).join('\n')
  await bot.sendMessage(msg.chat.id,
    `✅ Added ${saved.length} shift${saved.length > 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to finish.`,
    { parse_mode: 'Markdown' })
}

export async function moveToShiftRolesStep(bot, msg, session) {
  const shifts = await getShiftsForGroup(session.group_id)
  await updateSetupSession(session.group_id, { step: 'shift_roles' })

  const shiftList = shifts.map(s => `• *${s.name}*`).join('\n')
  await bot.sendMessage(msg.chat.id,
    `Now let's set role requirements for each shift.\n\nYour shifts:\n${shiftList}\n\n` +
    `Tell me how many of each role you need:\n\n` +
    `• _Saturday Lunch: 2 servers, 1 cook, 1 host_\n` +
    `• _All shifts need 1 manager and 2 servers_\n\n` +
    `Send *skip* to skip this step.`,
    { parse_mode: 'Markdown' })
}

export async function handleShiftRolesStep(bot, msg, session, text) {
  if (/^skip$/i.test(text) || /^(done|finish)$/i.test(text)) {
    await moveToStaffStepShared(bot, msg, session)
    return
  }

  const shifts = await getShiftsForGroup(session.group_id)
  const shiftNames = shifts.map(s => s.name)
  const reqs = await parseShiftRequirements(text, shiftNames)

  if (reqs.length === 0) {
    await bot.sendMessage(msg.chat.id,
      `I couldn't parse that. Try: _Saturday Lunch: 2 servers, 1 cook_\n\nOr send *skip* to continue.`,
      { parse_mode: 'Markdown' })
    return
  }

  const shiftMap = Object.fromEntries(shifts.map(s => [s.name.toLowerCase(), s]))
  let saved = 0
  for (const req of reqs) {
    const shift = shiftMap[req.shift_name.toLowerCase()]
      ?? shifts.find(s => s.name.toLowerCase().includes(req.shift_name.toLowerCase()))
    if (shift) {
      const result = await saveShiftRequirement(shift.id, req.role, req.count)
      if (result) saved++
    }
  }

  const list = reqs.map(r => `• ${r.count}× ${r.role} on *${r.shift_name}*`).join('\n')
  await bot.sendMessage(msg.chat.id,
    `✅ Saved ${saved} requirement${saved !== 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to continue to staff.`,
    { parse_mode: 'Markdown' })
}

export async function resetShiftStep(bot, chatId, groupId) {
  await deleteShiftsForGroup(groupId)
  await bot.sendMessage(chatId,
    `🗑️ All shifts cleared. Start fresh — describe your shifts:\n\n` +
    `_e.g. "Saturday Lunch, 11am–3pm" or "Mon–Fri, 2 shifts: 8am–12pm and 12pm–4pm"_\n\n` +
    `Send *done* when finished.`,
    { parse_mode: 'Markdown' })
}

export async function resetShiftRolesStep(bot, chatId, groupId) {
  await deleteShiftRequirementsForGroup(groupId)
  const shifts = await getShiftsForGroup(groupId)
  const shiftList = shifts.map(s => `• *${s.name}*`).join('\n')
  await bot.sendMessage(chatId,
    `🗑️ All role requirements cleared.\n\nYour shifts:\n${shiftList}\n\n` +
    `How many of each role do you need per shift?\n\n` +
    `_e.g. "Saturday Lunch: 2 servers, 1 cook"_\n\nSend *skip* to skip.`,
    { parse_mode: 'Markdown' })
}

// Shared helper — also used by staffSteps
export async function moveToStaffStepShared(bot, msg, session) {
  await updateSetupSession(session.group_id, { step: 'add_staff' })
  await bot.sendMessage(msg.chat.id,
    `Great! Now let's add your staff.\n\nTell me who works there and their roles:\n\n` +
    `• _John and Sarah are servers, Mike is a cook_\n` +
    `• _Emma - manager, Tom - bartender, Lisa - host_\n\n` +
    `Send them all at once or one at a time. Send *done* when finished, or *skip* to skip.`,
    { parse_mode: 'Markdown' })
}
