import { getRotationScores as liveGetRotationScores, getGroupShiftHistory as liveGetGroupShiftHistory } from './rotationDb.js'

function parseHour(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, '')
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return parseInt(h24[1], 10) + parseInt(h24[2], 10) / 60
  const h12full = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/)
  if (h12full) {
    let h = parseInt(h12full[1], 10)
    const min = parseInt(h12full[2], 10) / 60
    if (h12full[3] === 'pm' && h !== 12) h += 12
    if (h12full[3] === 'am' && h === 12) h = 0
    return h + min
  }
  const h12 = s.match(/^(\d{1,2})(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1], 10)
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return h
  }
  return 0
}

export function isDesirableShift(shift) {
  const day = shift.day_of_week ?? shift.dayOfWeek ?? ''
  const name = (shift.name ?? '').toLowerCase()
  const endTime = shift.end_time ?? shift.endTime ?? ''
  if (day === 'Friday' || day === 'Saturday') return true
  if (name.includes('dinner') || name.includes('evening') || name.includes('night')) return true
  if (parseHour(endTime) >= 21) return true
  return false
}

export async function buildRotationPriorityMap(groupId, shifts, staff, db = null) {
  const _getRotationScores = db?.getRotationScores ?? liveGetRotationScores
  const map = new Map()
  await Promise.all(shifts.map(async (shift) => {
    const scores = await _getRotationScores(groupId, shift.id)
    const scoreMap = new Map(scores.map(s => [s.staffId, s.recentCount]))
    const sorted = [...staff]
      .sort((a, b) => (scoreMap.get(a.staffId) ?? 0) - (scoreMap.get(b.staffId) ?? 0))
      .map(s => s.staffId)
    map.set(shift.id, sorted)
  }))
  return map
}

export function applyRotationToAssignments(assignments, priorityMap, shifts) {
  if (!assignments.length) return []
  const shiftMap = new Map(shifts.map(s => [String(s.id), s]))
  const result = assignments.map(a => ({ ...a }))

  for (const [shiftId, priorityOrder] of priorityMap) {
    const shift = shiftMap.get(String(shiftId))
    if (!shift || !isDesirableShift(shift)) continue

    const desirableAssignments = result.filter(a => String(a.shiftId) === String(shiftId))

    for (const desA of desirableAssignments) {
      const currentIdx = priorityOrder.indexOf(desA.staffId)
      if (currentIdx <= 0) continue

      for (const candidateId of priorityOrder.slice(0, currentIdx)) {
        const candidateA = result.find(a =>
          a.staffId === candidateId &&
          String(a.shiftId) !== String(shiftId) &&
          a.roleName === desA.roleName
        )
        if (!candidateA) continue

        // No double booking: candidate must not already be on the same day
        const candidateAlreadyOnDay = result.some(a =>
          a.staffId === candidateId &&
          a.dayOfWeek === desA.dayOfWeek &&
          String(a.shiftId) !== String(shiftId)
        )
        if (candidateAlreadyOnDay) continue

        // No double booking: current person must not already be on candidate's day
        const currentAlreadyOnCandidateDay = result.some(a =>
          a.staffId === desA.staffId &&
          a.dayOfWeek === candidateA.dayOfWeek &&
          a !== desA
        )
        if (currentAlreadyOnCandidateDay) continue

        const [tmpId, tmpName] = [desA.staffId, desA.staffName]
        desA.staffId = candidateA.staffId
        desA.staffName = candidateA.staffName
        candidateA.staffId = tmpId
        candidateA.staffName = tmpName
        break
      }
    }
  }
  return result
}

export async function getRotationReport(groupId, weeksBack = 4, db = null) {
  const _getGroupShiftHistory = db?.getGroupShiftHistory ?? liveGetGroupShiftHistory
  const history = await _getGroupShiftHistory(groupId, weeksBack)
  if (!history.length) return []

  const statsMap = {}
  for (const row of history) {
    if (!statsMap[row.staffId]) {
      statsMap[row.staffId] = {
        staffId: row.staffId,
        staffName: row.staffName,
        desirableShiftsWorked: 0,
        totalShiftsWorked: 0,
        lastDesirableShiftDate: null,
        lastDesirableShiftName: null,
      }
    }
    const s = statsMap[row.staffId]
    s.totalShiftsWorked++
    if (isDesirableShift({ day_of_week: row.dayOfWeek, name: row.shiftName, end_time: row.endTime })) {
      s.desirableShiftsWorked++
      if (!s.lastDesirableShiftDate || row.weekStart > s.lastDesirableShiftDate) {
        s.lastDesirableShiftDate = row.weekStart
        s.lastDesirableShiftName = row.shiftName
      }
    }
  }
  return Object.values(statsMap).sort((a, b) => b.desirableShiftsWorked - a.desirableShiftsWorked)
}

export async function handleRotationCommand(bot, msg, db = null) {
  const groupId = String(msg.chat.id)
  const userId = msg.from?.id
  try {
    const member = await bot.getChatMember(groupId, userId)
    if (!['creator', 'administrator'].includes(member?.status)) return
  } catch { return }

  const report = await getRotationReport(groupId, 4, db)
  if (!report.length) {
    await bot.sendMessage(groupId, 'No shift history yet — publish a schedule first.')
    return
  }

  const lines = report.map(r =>
    `• ${r.staffName}: ${r.desirableShiftsWorked} desirable / ${r.totalShiftsWorked} total` +
    (r.lastDesirableShiftName ? ` (last: ${r.lastDesirableShiftName})` : '')
  )
  await bot.sendMessage(groupId,
    `🔄 *Shift rotation — last 4 weeks*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' })
}
