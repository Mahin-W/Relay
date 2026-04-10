import { getPayrollForWeek, getPayrollHistory as _getPayrollHistoryReal } from './payDb.js'
import { formatStaffPayHistory } from './payReport.js'
import { logger } from '../logger.js'

const PAY_QUERY_PATTERNS = [
  /\bmy\s+pay\b/i,
  /\bmy\s+paycheck\b/i,
  /\bwhat\s+do\s+i\s+make\b/i,
  /\bhow\s+much\s+do\s+i\s+get\s+paid\b/i,
  /\bmy\s+earnings\b/i,
  /\bhow\s+much\s+am\s+i\s+owed\b/i,
  /\bmy\s+hours\s+and\s+pay\b/i,
  /\bwhat\s+am\s+i\s+getting\s+paid\b/i,
]

const HISTORY_QUERY_PATTERNS = [
  /\bmy\s+pay\s+history\b/i,
  /\blast\s+few\s+weeks\s+pay\b/i,
  /\bpay\s+history\b/i,
]

export function isPayQuery(text) {
  // History query takes precedence — don't trigger on "my pay history" as a pay query
  if (isHistoryQuery(text)) return false
  return PAY_QUERY_PATTERNS.some(p => p.test(text))
}

export function isHistoryQuery(text) {
  return HISTORY_QUERY_PATTERNS.some(p => p.test(text))
}

function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1)
  const monday = new Date(now.setDate(diff))
  return monday.toISOString().split('T')[0]
}

async function lookupStaff(chatId, db) {
  return db.getStaffByDmChatId(chatId)
}

async function lookupPayroll(groupId, week, db) {
  if (db?.getPayrollForWeek) return db.getPayrollForWeek(groupId, week)
  return getPayrollForWeek(groupId, week)
}

async function lookupHistory(staffId, groupId, db) {
  if (db?.getPayrollHistory) return db.getPayrollHistory(staffId, groupId)
  return _getPayrollHistoryReal(staffId, groupId, 4)
}

export async function handleStaffPayQuery(bot, msg, db = null) {
  const chatId = String(msg.chat.id)
  const staff = await lookupStaff(chatId, db)

  if (!staff) {
    await bot.sendMessage(chatId,
      `You're not registered yet. Ask your manager to run /register in the group.`)
    return
  }

  const week = getCurrentWeekStart()
  const allPayroll = await lookupPayroll(staff.groupId, week, db)

  if (!allPayroll) {
    await bot.sendMessage(chatId,
      `No pay calculated yet this week. Check back after the schedule is published.`)
    return
  }

  // SECURITY: only show this staff member's own record
  const myRecord = allPayroll.find(r => String(r.staffId) === String(staff.id))

  if (!myRecord) {
    await bot.sendMessage(chatId,
      `No pay calculated yet this week. Check back after the schedule is published.`)
    return
  }

  const weekLabel = week
  const displayName = staff.name ?? staff.firstName ?? 'You'
  let text = `💵 *${displayName}'s pay — week of ${weekLabel}*\n\n`

  for (const s of myRecord.shifts ?? []) {
    text += `${s.shiftName} (${s.dayOfWeek}, ${s.startTime ?? ''}–${s.endTime ?? ''})\n`
    text += `${(s.hoursWorked ?? 0).toFixed(1)}hrs @ $${s.hourlyRate}/hr = $${(s.grossPay ?? 0).toFixed(2)}\n`
    if ((s.lateMinutes ?? 0) > 0) {
      text += `⚠️ ${s.lateMinutes}min late (-$${(s.lateDeduction ?? 0).toFixed(2)})\n`
    }
    text += '\n'
  }

  text += `━━━━━━━━━━━━━━━━━━\n`
  text += `Total hours: ${(myRecord.totalHours ?? 0).toFixed(1)}hrs\n`
  if ((myRecord.totalLateMinutes ?? 0) > 0) {
    text += `Late deductions: -$${(myRecord.totalLateDeduction ?? 0).toFixed(2)}\n`
  }
  text += `*Total: $${(myRecord.totalGrossPay ?? 0).toFixed(2)}*`

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
}

export async function handleStaffHistoryQuery(bot, msg, db = null) {
  const chatId = String(msg.chat.id)
  const staff = await lookupStaff(chatId, db)

  if (!staff) {
    await bot.sendMessage(chatId,
      `You're not registered yet. Ask your manager to run /register in the group.`)
    return
  }

  const history = await lookupHistory(staff.id, staff.groupId, db)
  const report = formatStaffPayHistory(staff.name ?? staff.firstName ?? 'You', history)
  await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' })
}

/**
 * Format a personal pay stub for a single staff member.
 * @param {object} staffRecord - pay summary (staffId, staffName, shifts[], totalGrossPay, etc.)
 * @param {string} weekStart   - ISO date string e.g. '2025-01-06'
 * @param {boolean} showRate   - whether to show hourly rate (default true)
 */
export function formatPersonalPayStub(staffRecord, weekStart, showRate = true) {
  let text = `💵 *Your pay — week of ${weekStart}*\n\n`

  const shifts = staffRecord.shifts ?? (staffRecord.shift_breakdown
    ? (typeof staffRecord.shift_breakdown === 'string'
        ? JSON.parse(staffRecord.shift_breakdown)
        : staffRecord.shift_breakdown)
    : [])

  for (const s of shifts) {
    const day   = s.dayOfWeek ?? s.day_of_week ?? ''
    const start = s.startTime ?? s.start_time ?? ''
    const end   = s.endTime   ?? s.end_time   ?? ''
    const hrs   = (s.hoursWorked ?? s.effectiveHours ?? 0).toFixed(1)
    const rate  = s.hourlyRate ?? staffRecord.hourlyRate ?? 0
    const gross = (s.grossPay ?? 0).toFixed(2)

    text += `${s.shiftName ?? 'Shift'} (${day}, ${start}–${end})\n`
    if (showRate) {
      text += `${hrs}hrs @ $${rate}/hr`
    } else {
      text += `${hrs}hrs worked`
    }
    if ((s.dailyOTHours ?? 0) > 0) {
      text += `\n+ ${(s.dailyOTHours).toFixed(1)}hrs daily OT @ ${staffRecord.daily_multiplier ?? 1.5}x`
    }
    if ((s.weeklyOTHours ?? 0) > 0) {
      text += `\n+ ${(s.weeklyOTHours).toFixed(1)}hrs weekly OT @ ${staffRecord.weekly_multiplier ?? 1.5}x`
    }
    if ((s.lateMinutes ?? 0) > 0) {
      text += `\n⚠️ ${s.lateMinutes}min late (-$${(s.lateDeduction ?? 0).toFixed(2)})`
    }
    text += `\nShift: $${gross}\n\n`
  }

  text += `━━━━━━━━━━━━━━━━━━\n`
  const total    = (staffRecord.totalGrossPay ?? staffRecord.total_gross_pay ?? 0).toFixed(2)
  const totalHrs = (staffRecord.totalEffectiveHours ?? staffRecord.totalHours ?? staffRecord.total_hours ?? 0).toFixed(1)
  if (showRate) {
    text += `${totalHrs}hrs → *$${total}*`
  } else {
    text += `*Total: $${total}*`
  }
  return text
}
