import Groq from 'groq-sdk'
import { getSetupSession, getStaffForGroup, addScheduleAssignment, getShiftsForGroup, getShiftRequirements } from '../setup/setupDb.js'
import { updateScheduleStatus, saveGeneratedSchedule } from '../availability/availabilityDb.js'
import { generateWeeklySchedule, formatScheduleMessage, formatWeekLabel } from './generateSchedule.js'
import { getGroupMembersWithDm } from '../db.js'
import { logger } from '../logger.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const REVIEW_PROMPT = `Reply *approve* to publish, *regenerate* for a new arrangement, or describe an edit:
• _remove Mahin from Monday Morning Prep_
• _add Sapna to Tuesday Lunch_`

// Called when the manager sends a DM and there's a pending draft schedule
export async function handleManagerReview(bot, msg, schedule, managerGroup) {
  const text = msg.text?.trim() ?? ''
  const lower = text.toLowerCase()

  if (lower === 'approve') {
    await publishSchedule(bot, schedule, managerGroup)
    return
  }

  if (lower.startsWith('regen')) {
    await bot.sendMessage(msg.chat.id, `⏳ Regenerating schedule...`)
    try {
      const newSchedule = await generateWeeklySchedule(schedule.group_id, schedule.week_start)
      const formatted = formatScheduleMessage(newSchedule.assignments, newSchedule.gaps, newSchedule.week_start)
      await bot.sendMessage(
        msg.chat.id,
        `📋 *New Draft Schedule*\n\n${formatted}\n\n${REVIEW_PROMPT}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      logger.error(`Regeneration failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return
  }

  // Try to parse as an edit instruction
  const edit = await parseEditIntent(text, schedule)
  if (edit.action !== 'unclear') {
    await applyEdit(bot, msg, schedule, managerGroup, edit)
    return
  }

  await bot.sendMessage(msg.chat.id, REVIEW_PROMPT, { parse_mode: 'Markdown' })
}

// ── Edit parsing ──────────────────────────────────────────────────────────────

async function parseEditIntent(text, schedule) {
  try {
    // Include both filled shifts (assignments) and unfilled shifts (gaps)
    const filledShifts = (schedule.assignments ?? []).map(a => `${a.dayOfWeek} - ${a.shiftName}`)
    const gapShifts = (schedule.gaps ?? []).map(g => `${g.dayOfWeek} - ${g.shiftName}`)
    const shiftNames = [...new Set([...filledShifts, ...gapShifts])]
    const staffNames = [...new Set((schedule.assignments ?? []).map(a => a.staffName))]

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You parse schedule edit commands from a restaurant manager. Return valid JSON only.

Current schedule staff: ${staffNames.join(', ')}
Current shifts: ${shiftNames.join(', ')}

Return ONE of these JSON objects:
{"action":"remove","person":"exact name","day":"day name","shift":"shift name"}
{"action":"add","person":"name to add","day":"day name","shift":"shift name"}
{"action":"unclear"}

Rules:
- "remove X from Y" or "take X off Y" → remove action
- "add X to Y" or "put X on Y" or "move X to Y" → add action
- Match names and shifts loosely to the lists above
- If unclear, return the unclear JSON object`,
        },
        { role: 'user', content: text },
      ],
    })
    const result = JSON.parse(completion.choices[0]?.message?.content ?? '{}')
    logger.parse(`Edit intent: ${JSON.stringify(result)}`)
    return result.action ? result : { action: 'unclear' }
  } catch (err) {
    logger.error(`parseEditIntent failed: ${err.message}`)
    return { action: 'unclear' }
  }
}

// ── Recompute gaps from current assignments vs requirements ───────────────────

async function recomputeGaps(groupId, assignments) {
  const shifts = await getShiftsForGroup(groupId)
  const reqArrays = await Promise.all(
    shifts.map(s => getShiftRequirements(s.id).then(reqs => reqs.map(r => ({ ...r, shift: s }))))
  )
  const gaps = []
  for (const reqs of reqArrays) {
    for (const req of reqs) {
      const filled = assignments.filter(
        a => a.shiftId === req.shift.id && (a.roleName || '').toLowerCase() === (req.role || '').toLowerCase()
      ).length
      const shortfall = req.count - filled
      if (shortfall > 0) {
        gaps.push({
          shiftName: req.shift.name,
          dayOfWeek: req.shift.day_of_week,
          startTime: req.shift.start_time,
          endTime: req.shift.end_time,
          roleName: req.role,
          needed: req.count,
          found: filled,
          shortfall,
        })
      }
    }
  }
  return gaps
}

// ── Apply edit to schedule JSONB ──────────────────────────────────────────────

async function applyEdit(bot, msg, schedule, managerGroup, edit) {
  let assignments = [...(schedule.assignments ?? [])]
  let message = ''

  if (edit.action === 'remove') {
    const before = assignments.length
    assignments = assignments.filter(a => {
      const nameMatch = a.staffName?.toLowerCase().includes(edit.person?.toLowerCase())
      const dayMatch = !edit.day || a.dayOfWeek?.toLowerCase().includes(edit.day?.toLowerCase())
      const shiftMatch = !edit.shift || a.shiftName?.toLowerCase().includes(edit.shift?.toLowerCase())
      return !(nameMatch && dayMatch && shiftMatch)
    })
    const removed = before - assignments.length
    if (removed === 0) {
      await bot.sendMessage(msg.chat.id, `Couldn't find *${edit.person}* on that shift. Check the spelling and try again.`, { parse_mode: 'Markdown' })
      return
    }
    message = `✅ Removed *${edit.person}* from the schedule.`
  }

  if (edit.action === 'add') {
    const allStaff = await getStaffForGroup(schedule.group_id)
    const person = allStaff.find(s => s.name?.toLowerCase().includes(edit.person?.toLowerCase()))
    if (!person) {
      await bot.sendMessage(msg.chat.id, `Couldn't find *${edit.person}* in your staff list.`, { parse_mode: 'Markdown' })
      return
    }

    const shifts = await getShiftsForGroup(schedule.group_id)
    const shift = shifts.find(s => {
      const nameMatch = edit.shift && s.name?.toLowerCase().includes(edit.shift?.toLowerCase())
      const dayMatch = edit.day && s.day_of_week?.toLowerCase().includes(edit.day?.toLowerCase())
      if (edit.shift && edit.day) return nameMatch && dayMatch
      return nameMatch || dayMatch
    })
    if (!shift) {
      await bot.sendMessage(msg.chat.id, `Couldn't find that shift. Try being more specific.`, { parse_mode: 'Markdown' })
      return
    }

    // Check not already assigned
    const alreadyOn = assignments.some(a => a.staffId === person.id && a.shiftId === shift.id)
    if (alreadyOn) {
      await bot.sendMessage(msg.chat.id, `*${person.name}* is already on that shift.`, { parse_mode: 'Markdown' })
      return
    }

    const dmPool = await getGroupMembersWithDm(schedule.group_id)
    const member = dmPool.find(m => m.firstName?.toLowerCase() === person.name?.toLowerCase())

    assignments.push({
      shiftId: shift.id,
      shiftName: shift.name,
      dayOfWeek: shift.day_of_week,
      startTime: shift.start_time,
      endTime: shift.end_time,
      staffId: person.id,
      staffName: person.name,
      roleName: person.role,
      userId: member?.userId ?? null,
      dmChatId: member?.dmChatId ?? null,
    })
    message = `✅ Added *${person.name}* to ${shift.name} (${shift.day_of_week}).`
  }

  // Recompute gaps from scratch based on current assignments vs requirements
  const gaps = await recomputeGaps(schedule.group_id, assignments)

  // Save updated assignments back to DB
  await saveGeneratedSchedule(schedule.group_id, schedule.week_start, assignments, gaps)

  const formatted = formatScheduleMessage(assignments, gaps, schedule.week_start)
  await bot.sendMessage(
    msg.chat.id,
    `${message}\n\n📋 *Updated Schedule*\n\n${formatted}\n\n${REVIEW_PROMPT}`,
    { parse_mode: 'Markdown' }
  )
}

// ── Publish ───────────────────────────────────────────────────────────────────

export async function publishSchedule(bot, schedule, managerGroup) {
  try {
    await updateScheduleStatus(schedule.id, 'published')

    const assignments = schedule.assignments ?? []
    for (const a of assignments) {
      await addScheduleAssignment(schedule.group_id, a.shiftId, a.staffId, schedule.week_start)
    }

    const weekLabel = formatWeekLabel(schedule.week_start)
    const setupSession = await getSetupSession(schedule.group_id)
    const restaurantName = setupSession?.setup_data?.restaurant_name || managerGroup?.group_name || 'The manager'

    const formatted = formatScheduleMessage(assignments, schedule.gaps ?? [], schedule.week_start)
    await bot.sendMessage(
      schedule.group_id,
      `${formatted}\nQuestions or changes? Contact ${restaurantName}.`,
      { parse_mode: 'Markdown' }
    )

    await bot.sendMessage(managerGroup.dm_chat_id, `✅ Schedule published to the group!`)

    // DM each staff member their personal schedule
    const allStaff = await getStaffForGroup(schedule.group_id)
    const dmPool = await getGroupMembersWithDm(schedule.group_id)

    for (const staff of allStaff) {
      const nameLower = (staff.name || '').toLowerCase().trim()
      const member = dmPool.find(m => {
        const mLower = (m.firstName || '').toLowerCase().trim()
        return mLower === nameLower || nameLower.startsWith(mLower) || mLower.startsWith(nameLower)
      })
      if (!member?.dmChatId) continue

      const myShifts = assignments.filter(a => a.staffId === staff.id)
      try {
        if (myShifts.length === 0) {
          await bot.sendMessage(member.dmChatId, `👋 Hi ${staff.name}! You don't have any shifts next week (${weekLabel}). Enjoy your time off! 😊`)
        } else {
          const shiftLines = myShifts.map(s => `• ${s.dayOfWeek} — ${s.shiftName}, ${s.startTime}–${s.endTime}`).join('\n')
          await bot.sendMessage(
            member.dmChatId,
            `👋 Hi ${staff.name}! Here's your schedule for next week:\n\n📅 *Your shifts (${weekLabel}):*\n${shiftLines}\n\nQuestions? Contact ${restaurantName}.`,
            { parse_mode: 'Markdown' }
          )
        }
      } catch (err) {
        logger.error(`Could not DM ${staff.name} their schedule: ${err.message}`)
      }
    }

    logger.success(`Schedule published for group ${schedule.group_id} (week ${schedule.week_start})`)
  } catch (err) {
    logger.error(`publishSchedule failed: ${err.message}`)
    try { await bot.sendMessage(managerGroup.dm_chat_id, `Something went wrong publishing — try again.`) } catch (_) {}
  }
}
