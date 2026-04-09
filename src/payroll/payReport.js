import { getSetupSession } from '../setup/setupDb.js'
import { getPayrollForWeek } from './payDb.js'
import { logger } from '../logger.js'

function getCurrentWeekStart() {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon
  const diff = now.getDate() - day + (day === 0 ? -6 : 1) // adjust to Monday
  const monday = new Date(now.setDate(diff))
  return monday.toISOString().split('T')[0]
}

export function formatWeeklyPayReport(summaries, weekStart) {
  const header = `💵 *Pay Summary — Week of ${weekStart}*\n`

  if (!summaries || summaries.length === 0) {
    return `${header}\nNo staff scheduled this week.`
  }

  const totalPayroll = summaries.reduce((sum, s) => sum + (s.totalGrossPay ?? 0), 0)
  const totalHours = summaries.reduce((sum, s) => sum + (s.totalHours ?? 0), 0)
  const totalLateDeduction = summaries.reduce((sum, s) => sum + (s.totalLateDeduction ?? 0), 0)

  let body = ''
  for (const s of summaries) {
    body += `\n*${s.staffName}*${s.role ? ` (${s.role})` : ''}\n`
    body += `• Shifts: ${s.shifts?.length ?? 0}\n`
    body += `• Hours: ${(s.totalHours ?? 0).toFixed(1)}hrs\n`
    if ((s.totalLateMinutes ?? 0) > 0) {
      body += `• Late deductions: ${s.totalLateMinutes}min (-$${(s.totalLateDeduction ?? 0).toFixed(2)})\n`
    }
    body += `• Gross: *$${(s.totalGrossPay ?? 0).toFixed(2)}*\n`
  }

  let footer = `\n━━━━━━━━━━━━━━━━━━━━\n`
  footer += `*Total payroll: $${totalPayroll.toFixed(2)}*\n`
  footer += `Staff paid: ${summaries.length}\n`
  footer += `Total hours: ${totalHours.toFixed(1)}hrs`
  if (totalLateDeduction > 0) {
    footer += `\nTotal late deductions: $${totalLateDeduction.toFixed(2)}`
  }

  return header + body + footer
}

export async function sendPayReport(bot, groupId, weekStart = null, db = null) {
  const _getSession = db?.getSetupSession
    ? (gid) => db.getSetupSession(gid)
    : (gid) => getSetupSession(gid)
  const _getPayroll = db?.getPayrollForWeek
    ? (gid, week) => db.getPayrollForWeek(gid, week)
    : (gid, week) => getPayrollForWeek(gid, week)

  const session = await _getSession(groupId)
  if (!session?.dm_chat_id) return { sent: false }

  const week = weekStart ?? getCurrentWeekStart()
  const payroll = await _getPayroll(groupId, week)

  if (!payroll) {
    await bot.sendMessage(session.dm_chat_id,
      `No payroll calculated yet for this week.\nPublish the schedule first to calculate pay.`)
    return { sent: false }
  }

  const report = formatWeeklyPayReport(payroll, week)
  await bot.sendMessage(session.dm_chat_id, report, { parse_mode: 'Markdown' })
  logger.bot(`Pay report sent to manager for group ${groupId}, week ${week}`)
  return { sent: true }
}

export function formatStaffPayHistory(staffName, records) {
  if (!records || records.length === 0) {
    return `💵 *Pay history — ${staffName}*\n\nNo pay records found.`
  }
  let text = `💵 *Pay history — ${staffName} (last ${records.length} weeks)*\n\n`
  for (const r of records) {
    text += `Week of ${r.week_start}: ${(r.total_hours ?? 0).toFixed(1)}hrs → $${(r.total_gross_pay ?? 0).toFixed(2)}\n`
  }
  const avgPay = records.reduce((s, r) => s + (r.total_gross_pay ?? 0), 0) / records.length
  const avgHours = records.reduce((s, r) => s + (r.total_hours ?? 0), 0) / records.length
  text += `\nAverage weekly pay: $${avgPay.toFixed(2)}`
  text += `\nAverage hours/week: ${avgHours.toFixed(1)}hrs`
  return text
}
