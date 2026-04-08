import Groq from 'groq-sdk'
import { getSetupSession, getStaffForGroup, addScheduleAssignment, getShiftsForGroup, getShiftRequirements } from '../setup/setupDb.js'
import { updateScheduleStatus } from '../availability/availabilityDb.js'
import { generateWeeklySchedule, formatScheduleMessage, formatWeekLabel } from './generateSchedule.js'
import { getGroupMembersWithDm } from '../db.js'
import { logger } from '../logger.js'
import { applyEdit } from './scheduleEditor.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const REVIEW_PROMPT = `Reply *approve* to publish, *regenerate* for a new arrangement, or describe an edit:
• _remove Mahin from Monday Morning Prep_
• _add Sapna to Tuesday Lunch_`

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
      await bot.sendMessage(msg.chat.id, `📋 *New Draft Schedule*\n\n${formatted}\n\n${REVIEW_PROMPT}`, { parse_mode: 'Markdown' })
    } catch (err) {
      logger.error(`Regeneration failed: ${err.message}`)
      await bot.sendMessage(msg.chat.id, `Something went wrong — try again.`)
    }
    return
  }

  const edit = await parseEditIntent(text, schedule)
  if (edit.action !== 'unclear') {
    await applyEdit(bot, msg, schedule, REVIEW_PROMPT, edit)
    return
  }

  await bot.sendMessage(msg.chat.id, REVIEW_PROMPT, { parse_mode: 'Markdown' })
}

async function parseEditIntent(text, schedule) {
  try {
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
    await bot.sendMessage(schedule.group_id,
      `${formatted}\nQuestions or changes? Contact ${restaurantName}.`,
      { parse_mode: 'Markdown' })
    await bot.sendMessage(managerGroup.dm_chat_id, `✅ Schedule published to the group!`)

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
          await bot.sendMessage(member.dmChatId,
            `👋 Hi ${staff.name}! Here's your schedule for next week:\n\n📅 *Your shifts (${weekLabel}):*\n${shiftLines}\n\nQuestions? Contact ${restaurantName}.`,
            { parse_mode: 'Markdown' })
        }
      } catch (err) { logger.error(`Could not DM ${staff.name} their schedule: ${err.message}`) }
    }

    logger.success(`Schedule published for group ${schedule.group_id} (week ${schedule.week_start})`)
  } catch (err) {
    logger.error(`publishSchedule failed: ${err.message}`)
    try { await bot.sendMessage(managerGroup.dm_chat_id, `Something went wrong publishing — try again.`) } catch (_) {}
  }
}
