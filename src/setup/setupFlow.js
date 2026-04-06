import { createSetupSession, updateSetupSession, saveShift, getShiftsForGroup, deleteShiftsForGroup, deleteShiftRequirementsForGroup, saveStaff, getStaffForGroup, deleteStaffForGroup, saveShiftRequirement } from './setupDb.js'
import { parseShift, parseStaff, parseShiftRequirements } from '../parseMessage.js'
import { logger } from '../logger.js'

// Called when manager clicks the deep link and opens DM with /start setup_GROUPID
export async function startSetupDM(bot, msg, groupId) {
  const managerId = msg.from.id
  const dmChatId = msg.chat.id
  const managerName = msg.from.first_name || 'there'

  // Fetch group name from Telegram — bot must still be in the group
  let groupName = `Group ${groupId}`
  try {
    const chat = await bot.getChat(groupId)
    groupName = chat.title || groupName
  } catch (err) {
    logger.error(`Could not fetch group info for ${groupId}: ${err.message}`)
  }

  await createSetupSession(groupId, groupName, managerId, dmChatId)

  await bot.sendMessage(
    dmChatId,
    `👋 Hey ${managerName}! Let's set up Relay for *${groupName}*.\n\n` +
    `First — what's your restaurant called?\n` +
    `_(Press send to use *"${groupName}"*)_`,
    { parse_mode: 'Markdown' }
  )

  logger.bot(`Setup DM started for group ${groupId} (${groupName}) by ${managerName}`)
}

const RESET_RE = /^(reset|restart|clear|start over|redo)$/i

// Routes incoming DM messages to the right setup step
export async function handleSetupMessage(bot, msg, session) {
  const text = msg.text?.trim()
  if (!text) return

  // Universal reset — clears data for the current step and replays its prompt
  if (RESET_RE.test(text)) {
    await handleReset(bot, msg, session)
    return
  }

  switch (session.step) {
    case 'welcome':
      await handleWelcomeStep(bot, msg, session, text)
      break
    case 'add_shifts':
      await handleAddShiftsStep(bot, msg, session, text)
      break
    case 'shift_roles':
      await handleShiftRolesStep(bot, msg, session, text)
      break
    case 'add_staff':
      await handleAddStaffStep(bot, msg, session, text)
      break
    default:
      break
  }
}

async function handleReset(bot, msg, session) {
  const chatId = msg.chat.id
  const groupId = session.group_id

  switch (session.step) {
    case 'welcome':
      await bot.sendMessage(chatId,
        `What's your restaurant called?\n_(Press send to use *"${session.group_name}"*)_`,
        { parse_mode: 'Markdown' })
      break

    case 'add_shifts':
      await deleteShiftsForGroup(groupId)
      await bot.sendMessage(chatId,
        `🗑️ All shifts cleared. Start fresh — describe your shifts:\n\n` +
        `_e.g. "Saturday Lunch, 11am–3pm" or "Mon–Fri, 2 shifts: 8am–12pm and 12pm–4pm"_\n\n` +
        `Send *done* when finished.`,
        { parse_mode: 'Markdown' })
      break

    case 'shift_roles': {
      await deleteShiftRequirementsForGroup(groupId)
      const shifts = await getShiftsForGroup(groupId)
      const shiftList = shifts.map(s => `• *${s.name}*`).join('\n')
      await bot.sendMessage(chatId,
        `🗑️ All role requirements cleared.\n\nYour shifts:\n${shiftList}\n\n` +
        `How many of each role do you need per shift?\n\n` +
        `_e.g. "Saturday Lunch: 2 servers, 1 cook"_\n\nSend *skip* to skip.`,
        { parse_mode: 'Markdown' })
      break
    }

    case 'add_staff':
      await deleteStaffForGroup(groupId)
      await bot.sendMessage(chatId,
        `🗑️ All staff cleared. Who works there and what are their roles?\n\n` +
        `_e.g. "Mahin and Sapna are cooks, Alex is a server"_\n\nSend *done* when finished.`,
        { parse_mode: 'Markdown' })
      break

    default:
      await bot.sendMessage(chatId, `Nothing to reset at this step.`)
  }
}

async function handleWelcomeStep(bot, msg, session, text) {
  // Empty input or whitespace → use group name
  const restaurantName = text.length > 0 ? text : session.group_name

  await updateSetupSession(session.group_id, {
    step: 'add_shifts',
    setup_data: { ...session.setup_data, restaurant_name: restaurantName },
  })

  await bot.sendMessage(
    msg.chat.id,
    `✅ Got it — *${restaurantName}*!\n\n` +
    `Now let's add your regular shifts. Describe each one like this:\n\n` +
    `• _Saturday Lunch, 11am–3pm_\n` +
    `• _Friday Close, 6pm–11pm_\n` +
    `• _Monday Brunch, 9am–2pm_\n\n` +
    `Send them one at a time. When you're done, send *done*.`,
    { parse_mode: 'Markdown' }
  )
}

async function handleAddShiftsStep(bot, msg, session, text) {
  // Done / finish — move to staff step
  if (/^(done|finish|finished|that'?s? it|thats it)$/i.test(text)) {
    const shifts = await getShiftsForGroup(session.group_id)
    if (shifts.length === 0) {
      await bot.sendMessage(
        msg.chat.id,
        `You haven't added any shifts yet. Add at least one, or send *skip* to continue without shifts.`,
        { parse_mode: 'Markdown' }
      )
      return
    }
    await moveToShiftRolesStep(bot, msg, session)
    return
  }

  // Skip shifts entirely — go straight to shift roles
  if (/^skip$/i.test(text)) {
    await moveToShiftRolesStep(bot, msg, session)
    return
  }

  // Try to parse as one or many shifts
  const parsed = await parseShift(text)

  if (!parsed || parsed.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      `I couldn't quite parse that. Try something like:\n\n` +
      `_Saturday Lunch, 11am–3pm_\n` +
      `_2 shifts a day, 8am–12pm and 12pm–4pm, Mon–Fri_\n\n` +
      `Or send *done* if you're finished.`,
      { parse_mode: 'Markdown' }
    )
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
  await bot.sendMessage(
    msg.chat.id,
    `✅ Added ${saved.length} shift${saved.length > 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to finish.`,
    { parse_mode: 'Markdown' }
  )
}

async function moveToShiftRolesStep(bot, msg, session) {
  const shifts = await getShiftsForGroup(session.group_id)
  await updateSetupSession(session.group_id, { step: 'shift_roles' })

  const shiftList = shifts.map(s => `• *${s.name}*`).join('\n')
  await bot.sendMessage(
    msg.chat.id,
    `Now let's set role requirements for each shift.\n\nYour shifts:\n${shiftList}\n\n` +
    `Tell me how many of each role you need:\n\n` +
    `• _Saturday Lunch: 2 servers, 1 cook, 1 host_\n` +
    `• _All shifts need 1 manager and 2 servers_\n` +
    `• _Morning shifts: 1 cook, 2 servers. Evening: 1 bartender, 1 server_\n\n` +
    `Send *skip* to skip this step.`,
    { parse_mode: 'Markdown' }
  )
}

async function handleShiftRolesStep(bot, msg, session, text) {
  if (/^skip$/i.test(text) || /^(done|finish)$/i.test(text)) {
    await moveToStaffStep(bot, msg, session)
    return
  }

  const shifts = await getShiftsForGroup(session.group_id)
  const shiftNames = shifts.map(s => s.name)
  const reqs = await parseShiftRequirements(text, shiftNames)

  if (reqs.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      `I couldn't parse that. Try: _Saturday Lunch: 2 servers, 1 cook_\n\nOr send *skip* to continue.`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  // Match requirement shift names to actual shift IDs
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
  await bot.sendMessage(
    msg.chat.id,
    `✅ Saved ${saved} requirement${saved !== 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to continue to staff.`,
    { parse_mode: 'Markdown' }
  )
}

async function moveToStaffStep(bot, msg, session) {
  await updateSetupSession(session.group_id, { step: 'add_staff' })
  await bot.sendMessage(
    msg.chat.id,
    `Great! Now let's add your staff.\n\nTell me who works there and their roles:\n\n` +
    `• _John and Sarah are servers, Mike is a cook_\n` +
    `• _Emma - manager, Tom - bartender, Lisa - host_\n\n` +
    `Send them all at once or one at a time. Send *done* when finished, or *skip* to skip.`,
    { parse_mode: 'Markdown' }
  )
}

async function handleAddStaffStep(bot, msg, session, text) {
  if (/^(done|finish|finished|that'?s? it|thats it)$/i.test(text)) {
    const [shifts, staff] = await Promise.all([
      getShiftsForGroup(session.group_id),
      getStaffForGroup(session.group_id),
    ])
    await completeSetup(bot, msg, session, shifts, staff)
    return
  }

  if (/^skip$/i.test(text)) {
    const shifts = await getShiftsForGroup(session.group_id)
    await completeSetup(bot, msg, session, shifts, [])
    return
  }

  const parsed = await parseStaff(text, msg.from?.first_name)
  if (!parsed || parsed.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      `I couldn't parse that. Try something like:\n\n_"Mahin and Sapna are cooks, Alex is a server"_\n\nOr send *done* to finish, or *reset* to clear and start over.`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  const results = await Promise.all(parsed.map(s => saveStaff(session.group_id, s.name, s.role)))
  const saved = results.filter(Boolean)

  if (saved.length === 0) {
    await bot.sendMessage(msg.chat.id, `Something went wrong — try again?`)
    return
  }

  const list = parsed.map(s => `• *${s.name}* — ${s.role}`).join('\n')
  await bot.sendMessage(
    msg.chat.id,
    `✅ Added ${saved.length} staff member${saved.length > 1 ? 's' : ''}:\n${list}\n\nAdd more, or send *done* to finish.`,
    { parse_mode: 'Markdown' }
  )
}

async function completeSetup(bot, msg, session, shifts, staff) {
  await updateSetupSession(session.group_id, {
    step: 'complete',
    setup_complete: true,
  })

  const shiftList = shifts.length > 0
    ? shifts.map(s => `• *${s.name}* — ${s.day_of_week}, ${s.start_time}–${s.end_time}`).join('\n')
    : '_None added_'

  const staffList = staff && staff.length > 0
    ? staff.map(s => `• *${s.name}* — ${s.role}`).join('\n')
    : '_None added_'

  await bot.sendMessage(
    msg.chat.id,
    `✅ *Setup complete!*\n\n*Shifts:*\n${shiftList}\n\n*Staff:*\n${staffList}\n\nRelay is now active in your group.`,
    { parse_mode: 'Markdown' }
  )

  // Notify the group
  try {
    const managerName = msg.from?.first_name || 'The manager'
    await bot.sendMessage(
      session.group_id,
      `✅ *Relay Setup Complete*\n\n${managerName} has finished configuring Relay for this group.\nI'm now ready to handle shift coverage automatically.`,
      { parse_mode: 'Markdown' }
    )
  } catch (err) {
    // Bot might have been removed from group — non-fatal
    logger.error(`Could not send setup-complete message to group ${session.group_id}: ${err.message}`)
  }

  logger.success(`Setup complete for group ${session.group_id}`)
}
