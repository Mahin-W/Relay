import ExcelJS from 'exceljs'
import { execSync } from 'child_process'
import { unlink } from 'fs/promises'
import { randomBytes } from 'crypto'
import { getOvertimeSettings } from '../setup/setupDb.js'
import { getPayrollForWeek, getLateEventsForWeek } from './payDb.js'
import { getSetupSession } from '../setup/setupDb.js'
import { getScheduleAssignments, getShiftsForGroup } from '../setup/setupDb.js'
import { logger } from '../logger.js'

// ── Colour palette ────────────────────────────────────────────────────
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } }
const TOTALS_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }
const ALT_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBF5FB' } }
const WHITE_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
const WKND_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }

const WHITE_FONT  = { color: { argb: 'FFFFFFFF' }, name: 'Arial' }
const GREEN_FONT  = { bold: true, color: { argb: 'FF27AE60' }, name: 'Arial' }
const ORANGE_FONT = { color: { argb: 'FFE67E22' }, name: 'Arial' }
const RED_FONT    = { color: { argb: 'FFE74C3C' }, name: 'Arial' }
const BLUE_FONT   = { color: { argb: 'FF2980B9' }, name: 'Arial' }

function thin() {
  return { style: 'thin', color: { argb: 'FFBDC3C7' } }
}

function allBorders() {
  const b = thin()
  return { top: b, bottom: b, left: b, right: b }
}

function rowFill(i) {
  return i % 2 === 0 ? WHITE_FILL : ALT_FILL
}

function applyHeaderRow(row, colCount, height = 25) {
  row.height = height
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c)
    cell.font      = { bold: true, size: 11, ...WHITE_FONT }
    cell.fill      = HEADER_FILL
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border    = allBorders()
  }
}

// ── Sheet 1: Schedule ─────────────────────────────────────────────────
function buildScheduleSheet(wb, summaries, scheduleData, weekStart, restaurantName) {
  const ws = wb.addWorksheet('Schedule')
  ws.columns = [
    { width: 20 }, // Staff
    { width: 15 }, // Role
    { width: 18 }, // Mon
    { width: 18 }, // Tue
    { width: 18 }, // Wed
    { width: 18 }, // Thu
    { width: 18 }, // Fri
    { width: 18 }, // Sat
    { width: 18 }, // Sun
    { width: 12 }, // Total Hours
  ]

  // Title row
  ws.addRow([`${restaurantName} — Week of ${weekStart}`])
  ws.mergeCells('A1:J1')
  const titleCell    = ws.getCell('A1')
  titleCell.font     = { bold: true, size: 14, ...WHITE_FONT }
  titleCell.fill     = HEADER_FILL
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 35

  // Header row
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const hdr  = ws.addRow(['Staff', 'Role', ...DAYS, 'Total Hours'])
  applyHeaderRow(hdr, 10)

  // Build day→shift lookup
  const { assignments = [], shifts = [] } = scheduleData ?? {}
  const shiftMap    = Object.fromEntries(shifts.map(s => [String(s.id), s]))
  const staffDayMap = {}
  for (const a of assignments) {
    const sid = String(a.staffId ?? a.staff_id)
    const shf = shiftMap[String(a.shiftId ?? a.shift_id)] ?? {}
    const day = (a.dayOfWeek ?? shf.day_of_week ?? '').toLowerCase().slice(0, 3)
    if (!staffDayMap[sid]) staffDayMap[sid] = {}
    staffDayMap[sid][day] = `${shf.name ?? 'Shift'}\n${shf.start_time ?? ''}–${shf.end_time ?? ''}`
  }

  summaries.forEach((s, i) => {
    const cells = [
      s.staffName,
      s.roleName ?? '',
      ...DAYS.map(d => staffDayMap[String(s.staffId)]?.[d.toLowerCase()] ?? ''),
      s.totalEffectiveHours ?? s.totalHours ?? 0,
    ]
    const row = ws.addRow(cells)
    row.height = 40

    row.getCell(1).font      = { bold: true, name: 'Arial' }
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' }
    row.getCell(10).font      = { bold: true, name: 'Arial' }
    row.getCell(10).alignment = { horizontal: 'right', vertical: 'middle' }
    row.getCell(10).numFmt    = '0.00'

    for (let c = 1; c <= 10; c++) {
      const isSat = c === 8, isSun = c === 9
      row.getCell(c).fill   = (isSat || isSun) ? WKND_FILL : rowFill(i)
      row.getCell(c).border = allBorders()
      if (c >= 3 && c <= 9) {
        row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      }
    }
  })

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }]
}

// ── Sheet 2: Payroll ──────────────────────────────────────────────────
function buildPayrollSheet(wb, summaries, weekStart, overtimeSettings) {
  const ws = wb.addWorksheet('Payroll')
  ws.columns = [
    { width: 20 }, // Staff
    { width: 15 }, // Role
    { width: 12 }, // Rate
    { width: 10 }, // Reg Hrs
    { width: 14 }, // Reg Pay
    { width: 12 }, // Daily OT Hrs
    { width: 14 }, // Daily OT Pay
    { width: 13 }, // Weekly OT Hrs
    { width: 15 }, // Weekly OT Pay
    { width: 10 }, // Late (min)
    { width: 13 }, // Late Ded
    { width: 10 }, // Total Hrs
    { width: 14 }, // GROSS PAY
  ]

  // Title
  ws.addRow([`Payroll — Week of ${weekStart}`])
  ws.mergeCells('A1:M1')
  const titleCell     = ws.getCell('A1')
  titleCell.font      = { bold: true, size: 14, ...WHITE_FONT }
  titleCell.fill      = HEADER_FILL
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 35

  ws.addRow([]) // spacer row 2

  // Headers row 3
  const hdr = ws.addRow([
    'Staff', 'Role', 'Rate ($/hr)',
    'Reg Hrs', 'Reg Pay ($)',
    'Daily OT Hrs', 'Daily OT Pay ($)',
    'Weekly OT Hrs', 'Weekly OT Pay ($)',
    'Late (min)', 'Late Ded. ($)',
    'Total Hrs', 'GROSS PAY ($)',
  ])
  applyHeaderRow(hdr, 13)

  const DATA_START = 4
  const DATA_END   = DATA_START + summaries.length - 1

  summaries.forEach((s, i) => {
    const rowNum = DATA_START + i
    const row = ws.addRow([
      s.staffName,
      s.roleName ?? '',
      s.hourlyRate ?? 0,
      s.totalRegularHours  ?? 0,
      null, // E — formula
      s.totalDailyOTHours  ?? 0,
      null, // G — formula
      s.totalWeeklyOTHours ?? 0,
      null, // I — formula
      s.totalLateMinutes   ?? 0,
      s.totalLateDeduction ?? 0,
      s.totalEffectiveHours ?? s.totalHours ?? 0,
      null, // M — formula
    ])
    row.height = 22

    // Formulas — multipliers hardcoded per OT settings (static for this week)
    const dm = overtimeSettings.daily_multiplier  ?? 1.5
    const wm = overtimeSettings.weekly_multiplier ?? 1.5
    row.getCell(5).value  = { formula: `C${rowNum}*D${rowNum}` }
    row.getCell(7).value  = { formula: `C${rowNum}*F${rowNum}*${dm}` }
    row.getCell(9).value  = { formula: `C${rowNum}*H${rowNum}*${wm}` }
    row.getCell(13).value = { formula: `E${rowNum}+G${rowNum}+I${rowNum}-K${rowNum}` }

    // Number formats
    row.getCell(3).numFmt = '$#,##0.00'
    row.getCell(3).font   = { ...BLUE_FONT }
    for (const c of [4, 6, 8, 10, 12]) row.getCell(c).numFmt = '0.00'
    for (const c of [5, 7, 9, 11])     row.getCell(c).numFmt = '$#,##0.00'
    row.getCell(13).numFmt = '$#,##0.00'
    row.getCell(13).font   = { ...GREEN_FONT }

    if ((s.totalLateDeduction ?? 0) > 0) row.getCell(11).font = { ...RED_FONT }
    if ((s.totalDailyOTHours  ?? 0) > 0) row.getCell(7).font  = { ...ORANGE_FONT }
    if ((s.totalWeeklyOTHours ?? 0) > 0) row.getCell(9).font  = { ...ORANGE_FONT }

    const fill = rowFill(i)
    for (let c = 1; c <= 13; c++) {
      if (!row.getCell(c).fill?.fgColor?.argb || row.getCell(c).fill === WHITE_FILL) {
        row.getCell(c).fill = fill
      }
      row.getCell(c).border = allBorders()
    }
  })

  // Totals row
  const totRow = ws.addRow([
    'TOTALS', '', '',
    { formula: `SUM(D${DATA_START}:D${DATA_END})` },
    { formula: `SUM(E${DATA_START}:E${DATA_END})` },
    { formula: `SUM(F${DATA_START}:F${DATA_END})` },
    { formula: `SUM(G${DATA_START}:G${DATA_END})` },
    { formula: `SUM(H${DATA_START}:H${DATA_END})` },
    { formula: `SUM(I${DATA_START}:I${DATA_END})` },
    { formula: `SUM(J${DATA_START}:J${DATA_END})` },
    { formula: `SUM(K${DATA_START}:K${DATA_END})` },
    { formula: `SUM(L${DATA_START}:L${DATA_END})` },
    { formula: `SUM(M${DATA_START}:M${DATA_END})` },
  ])
  totRow.height = 22
  for (let c = 1; c <= 13; c++) {
    totRow.getCell(c).font   = { bold: true, name: 'Arial' }
    totRow.getCell(c).fill   = TOTALS_FILL
    totRow.getCell(c).border = allBorders()
  }
  for (const c of [4, 6, 8, 10, 12]) totRow.getCell(c).numFmt = '0.00'
  for (const c of [5, 7, 9, 11, 13]) totRow.getCell(c).numFmt = '$#,##0.00'

  // Settings rows
  ws.addRow([])
  ws.addRow(['Weekly OT threshold:', `${overtimeSettings.weekly_threshold ?? 40} hrs`])
  ws.addRow(['Weekly OT rate:', `${overtimeSettings.weekly_multiplier ?? 1.5}x`])
  ws.addRow([
    'Daily OT threshold:',
    overtimeSettings.daily_overtime_enabled
      ? `${overtimeSettings.daily_threshold ?? 8} hrs`
      : 'N/A',
  ])
  ws.addRow([
    'Daily OT rate:',
    overtimeSettings.daily_overtime_enabled
      ? `${overtimeSettings.daily_multiplier ?? 1.5}x`
      : 'N/A',
  ])

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }]
}

// ── Sheet 3: Late Arrivals ─────────────────────────────────────────────
function buildLateSheet(wb, lateEvents, weekStart) {
  if (!lateEvents || lateEvents.length === 0) return

  const ws = wb.addWorksheet('Late Arrivals Log')
  ws.columns = [
    { width: 20 }, // Staff
    { width: 20 }, // Shift
    { width: 12 }, // Day
    { width: 14 }, // Minutes Late
    { width: 16 }, // Pay Deducted
    { width: 25 }, // Notes
  ]

  ws.addRow([`Late Arrivals — Week of ${weekStart}`])
  ws.mergeCells('A1:F1')
  const titleCell     = ws.getCell('A1')
  titleCell.font      = { bold: true, size: 13, ...WHITE_FONT }
  titleCell.fill      = HEADER_FILL
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 30

  const hdr = ws.addRow(['Staff', 'Shift', 'Day', 'Minutes Late', 'Pay Deducted ($)', 'Notes'])
  applyHeaderRow(hdr, 6)

  const DATA_START = 3
  lateEvents.forEach((ev, i) => {
    const row = ws.addRow([
      ev.staffName   ?? '',
      ev.shiftName   ?? '',
      ev.dayOfWeek   ?? '',
      ev.minutesLate ?? 0,
      ev.payDeducted ?? 0,
      ev.notes       ?? '',
    ])
    row.getCell(4).numFmt = '0'
    row.getCell(5).numFmt = '$#,##0.00'
    row.getCell(5).font   = { ...RED_FONT }

    const mins = ev.minutesLate ?? 0
    if (mins > 15)     row.getCell(4).font = { ...RED_FONT }
    else if (mins >= 5) row.getCell(4).font = { ...ORANGE_FONT }

    const fill = rowFill(i)
    for (let c = 1; c <= 6; c++) {
      row.getCell(c).fill   = fill
      row.getCell(c).border = allBorders()
    }
  })

  const DATA_END = DATA_START + lateEvents.length - 1
  const foot = ws.addRow([
    'Total deductions:', '', '', '',
    { formula: `SUM(E${DATA_START}:E${DATA_END})` },
    '',
  ])
  foot.getCell(1).font   = { bold: true, name: 'Arial' }
  foot.getCell(5).numFmt = '$#,##0.00'
  foot.getCell(5).font   = { bold: true, ...RED_FONT }
  for (let c = 1; c <= 6; c++) {
    foot.getCell(c).fill   = TOTALS_FILL
    foot.getCell(c).border = allBorders()
  }
}

// ── Main generator ────────────────────────────────────────────────────
export async function generatePayrollSpreadsheet(
  groupId, weekStart, payrollSummaries, scheduleData,
  lateEvents, overtimeSettings, restaurantName,
) {
  const wb      = new ExcelJS.Workbook()
  wb.creator    = 'Relay Bot'
  wb.created    = new Date()

  buildScheduleSheet(wb, payrollSummaries, scheduleData, weekStart, restaurantName)
  buildPayrollSheet(wb, payrollSummaries, weekStart, overtimeSettings)
  buildLateSheet(wb, lateEvents, weekStart)

  const rand     = randomBytes(4).toString('hex')
  const filepath = `/tmp/relay-payroll-${groupId}-${weekStart}-${rand}.xlsx`
  await wb.xlsx.writeFile(filepath)

  try {
    const raw    = execSync(`python3 scripts/recalc.py "${filepath}" 30`, { encoding: 'utf8', cwd: process.cwd() })
    const parsed = JSON.parse(raw)
    if (parsed.status === 'errors_found') {
      logger.error('Formula errors in spreadsheet:', JSON.stringify(parsed.error_summary))
    }
  } catch (err) {
    logger.info('recalc.py unavailable — formulas written as ExcelJS objects:', err.message)
  }

  return filepath
}

function getCurrentWeekStart() {
  const now  = new Date()
  const day  = now.getDay()
  const diff = now.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(now.setDate(diff)).toISOString().split('T')[0]
}

export async function sendPayrollSpreadsheet(bot, groupId, weekStart = null, db = null) {
  const _getSession  = db?.getSetupSession      ? g => db.getSetupSession(g)         : g => getSetupSession(g)
  const _getPayroll  = db?.getPayrollForWeek    ? (g, w) => db.getPayrollForWeek(g, w)    : (g, w) => getPayrollForWeek(g, w)
  const _getLate     = db?.getLateEventsForWeek ? (g, w) => db.getLateEventsForWeek(g, w) : (g, w) => getLateEventsForWeek(g, w)
  const _getSettings = db?.getOvertimeSettings  ? g => db.getOvertimeSettings(g)      : g => getOvertimeSettings(g)
  const _getAssign   = db?.getScheduleAssignments ? (g, w) => db.getScheduleAssignments(g, w) : (g, w) => getScheduleAssignments(g, w)
  const _getShifts   = db?.getShiftsForGroup    ? g => db.getShiftsForGroup(g)        : g => getShiftsForGroup(g)

  const session = await _getSession(groupId)
  if (!session?.dm_chat_id) {
    logger.info('No manager DM for spreadsheet')
    return { sent: false }
  }

  const week    = weekStart ?? getCurrentWeekStart()
  const payroll = await _getPayroll(groupId, week)
  if (!payroll || payroll.length === 0) {
    logger.info('No payroll data for spreadsheet')
    return { sent: false }
  }

  const [assignments, shifts, lateEvents, settings] = await Promise.all([
    _getAssign(groupId, week),
    _getShifts(groupId),
    _getLate(groupId, week),
    _getSettings(groupId),
  ])

  const restaurantName = session.setup_data?.restaurant_name ?? 'Restaurant'
  const filepath = await generatePayrollSpreadsheet(
    groupId, week, payroll,
    { assignments: assignments ?? [], shifts: shifts ?? [] },
    lateEvents ?? [], settings ?? {},
    restaurantName,
  )

  let sent = false
  try {
    await bot.sendDocument(session.dm_chat_id, filepath, {
      caption: `📊 Payroll spreadsheet — week of ${week}`,
    })
    sent = true
  } finally {
    await unlink(filepath).catch(() => {})
  }
  return { sent }
}
