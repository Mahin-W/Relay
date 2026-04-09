import { groq, groqWithRetry } from '../parsers/groq.js'
import { getSetupSession, getStaffForGroup, addScheduleAssignment, getShiftsForGroup, getShiftRequirements, getRatesForGroup } from '../setup/setupDb.js'
import { updateScheduleStatus } from '../availability/availabilityDb.js'
import { generateWeeklySchedule, formatScheduleMessage, formatWeekLabel } from './generateSchedule.js'
import { getGroupMembersWithDm } from '../db.js'
import { logger } from '../logger.js'
import { applyEdit } from './scheduleEditor.js'
import { sendPersonalSchedule } from './readReceipts.js'
import { calculateWeeklyPay } from '../payroll/payCalculator.js'
import { savePeriodPayroll, getLateEventsForWeek } from '../payroll/payDb.js'
import { sendPayReport } from '../payroll/payReport.js'

const REVIEW_PROMPT = `Reply *approve* to publish, *regenerate* for a new arrangement, or describe an edit:
• _remove Mahin from Monday Morning Prep_
• _add Sapna to Tuesday Lunch_`

export async function handleManagerReview(bot, msg, schedule, managerGroup) {
  const text = msg.text?.trim() ?? ''
  const lower = text.toLowerCase()

  if (lower === 'approve' || lower === 'approve anyway') {
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
  if (edit && edit.action !== 'unclear') {
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

    const completion = await groqWithRetry(() => groq.chat.completions.create({
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
    }))
    const result = JSON.parse(completion.choices[0]?.message?.content ?? '{}')
    logger.parse(`Edit intent: ${JSON.stringify(result)}`)
    return result.action ? result : { action: 'unclear' }
  } catch (err) {
    logger.error(`parseEditIntent failed: ${err.message}`)
    return null
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
      const staffMember = { id: staff.id, name: staff.name, dmChatId: member.dmChatId }
      try {
        await sendPersonalSchedule(bot, schedule.group_id, staffMember, assignments, schedule.week_start)
      } catch (err) { logger.error(`Could not DM ${staff.name} their schedule: ${err.message}`) }
    }

    // Calculate payroll after publishing
    try {
      const shifts = await getShiftsForGroup(schedule.group_id)
      const rates = await getRatesForGroup(schedule.group_id)
      const lateEvents = await getLateEventsForWeek(schedule.group_id, schedule.week_start)
      const payroll = calculateWeeklyPay(assignments, shifts, rates, lateEvents)
      await savePeriodPayroll(schedule.group_id, schedule.week_start, payroll)
      logger.info(`Payroll calculated for week ${schedule.week_start}`)
      await sendPayReport(bot, schedule.group_id, schedule.week_start)
    } catch (payErr) {
      logger.error(`Payroll calculation failed (non-fatal): ${payErr.message}`)
    }

    logger.success(`Schedule published for group ${schedule.group_id} (week ${schedule.week_start})`)
  } catch (err) {
    logger.error(`publishSchedule failed: ${err.message}`)
    try { await bot.sendMessage(managerGroup.dm_chat_id, `Something went wrong publishing — try again.`) } catch (_) {}
  }
}
