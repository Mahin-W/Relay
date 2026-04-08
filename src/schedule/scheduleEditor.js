import { getShiftsForGroup, getShiftRequirements, getStaffForGroup } from '../setup/setupDb.js'
import { saveGeneratedSchedule } from '../availability/availabilityDb.js'
import { formatScheduleMessage } from './generateSchedule.js'
import { getGroupMembersWithDm } from '../db.js'
import { logger } from '../logger.js'

const REVIEW_PROMPT = `Reply *approve* to publish, *regenerate* for a new arrangement, or describe an edit:
• _remove Mahin from Monday Morning Prep_
• _add Sapna to Tuesday Lunch_`

export async function recomputeGaps(groupId, assignments) {
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
          shiftName: req.shift.name, dayOfWeek: req.shift.day_of_week,
          startTime: req.shift.start_time, endTime: req.shift.end_time,
          roleName: req.role, needed: req.count, found: filled, shortfall,
        })
      }
    }
  }
  return gaps
}

export async function applyEdit(bot, msg, schedule, PROMPT, edit) {
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
    if (before === assignments.length) {
      await bot.sendMessage(msg.chat.id, `Couldn't find *${edit.person}* on that shift. Check the spelling and try again.`, { parse_mode: 'Markdown' })
      return
    }
    message = `✅ Removed *${edit.person}* from the schedule.`
  }

  if (edit.action === 'add') {
    const allStaff = await getStaffForGroup(schedule.group_id)
    const person = allStaff.find(s => s.name?.toLowerCase().includes(edit.person?.toLowerCase()))
    if (!person) {
      await bot.sendMessage(msg.chat.id, `Couldn't find *${edit.person}* in your staff list.`, { parse_mode: 'Markdown' }); return
    }
    const shifts = await getShiftsForGroup(schedule.group_id)
    const shift = shifts.find(s => {
      const nameMatch = edit.shift && s.name?.toLowerCase().includes(edit.shift?.toLowerCase())
      const dayMatch = edit.day && s.day_of_week?.toLowerCase().includes(edit.day?.toLowerCase())
      if (edit.shift && edit.day) return nameMatch && dayMatch
      return nameMatch || dayMatch
    })
    if (!shift) {
      await bot.sendMessage(msg.chat.id, `Couldn't find that shift. Try being more specific.`, { parse_mode: 'Markdown' }); return
    }
    if (assignments.some(a => a.staffId === person.id && a.shiftId === shift.id)) {
      await bot.sendMessage(msg.chat.id, `*${person.name}* is already on that shift.`, { parse_mode: 'Markdown' }); return
    }
    const dmPool = await getGroupMembersWithDm(schedule.group_id)
    const member = dmPool.find(m => m.firstName?.toLowerCase() === person.name?.toLowerCase())
    assignments.push({
      shiftId: shift.id, shiftName: shift.name, dayOfWeek: shift.day_of_week,
      startTime: shift.start_time, endTime: shift.end_time,
      staffId: person.id, staffName: person.name, roleName: person.role,
      userId: member?.userId ?? null, dmChatId: member?.dmChatId ?? null,
    })
    message = `✅ Added *${person.name}* to ${shift.name} (${shift.day_of_week}).`
  }

  const gaps = await recomputeGaps(schedule.group_id, assignments)
  await saveGeneratedSchedule(schedule.group_id, schedule.week_start, assignments, gaps)
  const formatted = formatScheduleMessage(assignments, gaps, schedule.week_start)
  await bot.sendMessage(msg.chat.id,
    `${message}\n\n📋 *Updated Schedule*\n\n${formatted}\n\n${PROMPT}`,
    { parse_mode: 'Markdown' })
}
