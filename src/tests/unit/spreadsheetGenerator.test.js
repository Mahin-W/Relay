import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { unlink } from 'fs/promises'
import ExcelJS from 'exceljs'
import { generatePayrollSpreadsheet, sendPayrollSpreadsheet } from '../../payroll/spreadsheetGenerator.js'
import { MockBot } from '../helpers/mocks.js'

const mockPayroll = [
  {
    staffId: 1, staffName: 'Marcus', roleName: 'Chef', hourlyRate: 15,
    totalHours: 16, totalEffectiveHours: 16,
    totalRegularHours: 16, totalDailyOTHours: 0, totalWeeklyOTHours: 0,
    totalLateMinutes: 0, totalLateDeduction: 0,
    totalRegularPay: 240, totalDailyOTPay: 0, totalWeeklyOTPay: 0, totalGrossPay: 240,
    shifts: [
      { shiftName:'Monday Lunch', dayOfWeek:'Monday', startTime:'11am', endTime:'5pm',
        hoursWorked:6, regularHours:6, dailyOTHours:0, weeklyOTHours:0,
        regularPay:90, dailyOTPay:0, weeklyOTPay:0, lateMinutes:0, lateDeduction:0, grossPay:90 },
    ],
  },
  {
    staffId: 2, staffName: 'Sarah', roleName: 'Server', hourlyRate: 13,
    totalHours: 42, totalEffectiveHours: 41.67,
    totalRegularHours: 40, totalDailyOTHours: 0, totalWeeklyOTHours: 2,
    totalLateMinutes: 20, totalLateDeduction: 4.33,
    totalRegularPay: 520, totalDailyOTPay: 0, totalWeeklyOTPay: 39, totalGrossPay: 554.67,
    shifts: [],
  },
]

const mockSchedule = { assignments: [], shifts: [] }
const mockLateEvents = [
  { staffId:2, staffName:'Sarah', shiftName:'Friday Dinner',
    dayOfWeek:'Friday', minutesLate:20, payDeducted:4.33 },
]
const mockSettings = {
  overtime_enabled: true, weekly_threshold: 40, weekly_multiplier: 1.5,
  daily_overtime_enabled: false, daily_threshold: 8, daily_multiplier: 1.5,
}
const weekStart      = '2025-01-06'
const restaurantName = 'Test Kitchen'

async function generate(lateEvents = []) {
  return generatePayrollSpreadsheet(
    '-100', weekStart, mockPayroll, mockSchedule,
    lateEvents, mockSettings, restaurantName,
  )
}

async function loadWb(lateEvents = []) {
  const fp = await generate(lateEvents)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  return { wb, fp }
}

function allText(ws) {
  const texts = []
  ws.eachRow(row => row.eachCell(c => {
    const v = c.value
    if (v && typeof v === 'object' && v.formula) texts.push(`=${v.formula}`)
    else if (v != null) texts.push(String(v))
  }))
  return texts
}

// ── File generation ────────────────────────────────────────────────────
test('returns a filepath string', async () => {
  const fp = await generate()
  assert.ok(typeof fp === 'string')
  await unlink(fp).catch(() => {})
})

test('file has .xlsx extension', async () => {
  const fp = await generate()
  assert.ok(fp.endsWith('.xlsx'))
  await unlink(fp).catch(() => {})
})

test('file exists at returned path', async () => {
  const fp = await generate()
  assert.ok(existsSync(fp))
  await unlink(fp).catch(() => {})
})

test('file is valid xlsx (ExcelJS can open it)', async () => {
  const { wb, fp } = await loadWb()
  assert.ok(wb.worksheets.length > 0)
  await unlink(fp).catch(() => {})
})

// ── Sheet existence ────────────────────────────────────────────────────
test('workbook has "Schedule" sheet', async () => {
  const { wb, fp } = await loadWb()
  assert.ok(wb.getWorksheet('Schedule'))
  await unlink(fp).catch(() => {})
})

test('workbook has "Payroll" sheet', async () => {
  const { wb, fp } = await loadWb()
  assert.ok(wb.getWorksheet('Payroll'))
  await unlink(fp).catch(() => {})
})

test('"Late Arrivals Log" exists when lateEvents present', async () => {
  const { wb, fp } = await loadWb(mockLateEvents)
  assert.ok(wb.getWorksheet('Late Arrivals Log'))
  await unlink(fp).catch(() => {})
})

test('"Late Arrivals Log" NOT created when lateEvents empty', async () => {
  const { wb, fp } = await loadWb([])
  assert.ok(!wb.getWorksheet('Late Arrivals Log'))
  await unlink(fp).catch(() => {})
})

// ── Schedule sheet ─────────────────────────────────────────────────────
test('Schedule: title row contains restaurant name', async () => {
  const { wb, fp } = await loadWb()
  const title = String(wb.getWorksheet('Schedule').getRow(1).getCell(1).value ?? '')
  assert.ok(title.includes('Test Kitchen'))
  await unlink(fp).catch(() => {})
})

test('Schedule: title row contains weekStart date', async () => {
  const { wb, fp } = await loadWb()
  const title = String(wb.getWorksheet('Schedule').getRow(1).getCell(1).value ?? '')
  assert.ok(title.includes('2025-01-06'))
  await unlink(fp).catch(() => {})
})

test('Schedule: header row has Mon column', async () => {
  const { wb, fp } = await loadWb()
  const hdr = wb.getWorksheet('Schedule').getRow(2).values
  assert.ok(hdr.some(v => String(v ?? '').includes('Mon')))
  await unlink(fp).catch(() => {})
})

test('Schedule: Marcus appears in data rows', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Schedule'))
  assert.ok(texts.some(t => t.includes('Marcus')))
  await unlink(fp).catch(() => {})
})

test('Schedule: Sarah appears in data rows', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Schedule'))
  assert.ok(texts.some(t => t.includes('Sarah')))
  await unlink(fp).catch(() => {})
})

// ── Payroll sheet ──────────────────────────────────────────────────────
test('Payroll: Marcus name present', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Payroll'))
  assert.ok(texts.some(t => t.includes('Marcus')))
  await unlink(fp).catch(() => {})
})

test('Payroll: Sarah name present', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Payroll'))
  assert.ok(texts.some(t => t.includes('Sarah')))
  await unlink(fp).catch(() => {})
})

test('Payroll: Marcus hourlyRate = 15 in rate column', async () => {
  const { wb, fp } = await loadWb()
  const ws = wb.getWorksheet('Payroll')
  let found = false
  ws.eachRow(row => {
    if (String(row.getCell(1).value ?? '').includes('Marcus') && row.getCell(3).value === 15) found = true
  })
  assert.ok(found)
  await unlink(fp).catch(() => {})
})

test('Payroll: Sarah hourlyRate = 13 in rate column', async () => {
  const { wb, fp } = await loadWb()
  const ws = wb.getWorksheet('Payroll')
  let found = false
  ws.eachRow(row => {
    if (String(row.getCell(1).value ?? '').includes('Sarah') && row.getCell(3).value === 13) found = true
  })
  assert.ok(found)
  await unlink(fp).catch(() => {})
})

test('Payroll: Marcus regular hours = 16', async () => {
  const { wb, fp } = await loadWb()
  const ws = wb.getWorksheet('Payroll')
  let found = false
  ws.eachRow(row => {
    if (String(row.getCell(1).value ?? '').includes('Marcus') && row.getCell(4).value === 16) found = true
  })
  assert.ok(found)
  await unlink(fp).catch(() => {})
})

test('Payroll: Sarah weekly OT hours = 2', async () => {
  const { wb, fp } = await loadWb()
  const ws = wb.getWorksheet('Payroll')
  let found = false
  ws.eachRow(row => {
    if (String(row.getCell(1).value ?? '').includes('Sarah') && row.getCell(8).value === 2) found = true
  })
  assert.ok(found)
  await unlink(fp).catch(() => {})
})

test('Payroll: TOTALS row exists', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Payroll'))
  assert.ok(texts.some(t => t.toLowerCase().includes('total')))
  await unlink(fp).catch(() => {})
})

test('Payroll: totals row uses SUM formulas', async () => {
  const { wb, fp } = await loadWb()
  const ws = wb.getWorksheet('Payroll')
  let hasFormula = false
  ws.eachRow(row => {
    row.eachCell(c => {
      if (c.value && typeof c.value === 'object' && c.value.formula?.startsWith('SUM')) hasFormula = true
    })
  })
  assert.ok(hasFormula)
  await unlink(fp).catch(() => {})
})

test('Payroll: settings rows show OT threshold value', async () => {
  const { wb, fp } = await loadWb()
  const texts = allText(wb.getWorksheet('Payroll'))
  assert.ok(texts.some(t => t.includes('40')))
  await unlink(fp).catch(() => {})
})

// ── Late arrivals sheet ────────────────────────────────────────────────
test('Late Arrivals: Sarah appears', async () => {
  const { wb, fp } = await loadWb(mockLateEvents)
  const texts = allText(wb.getWorksheet('Late Arrivals Log'))
  assert.ok(texts.some(t => t.includes('Sarah')))
  await unlink(fp).catch(() => {})
})

test('Late Arrivals: footer has SUM formula', async () => {
  const { wb, fp } = await loadWb(mockLateEvents)
  const ws = wb.getWorksheet('Late Arrivals Log')
  let hasFormula = false
  ws.eachRow(row => row.eachCell(c => {
    if (c.value && typeof c.value === 'object' && c.value.formula?.startsWith('SUM')) hasFormula = true
  }))
  assert.ok(hasFormula)
  await unlink(fp).catch(() => {})
})

// ── sendPayrollSpreadsheet ─────────────────────────────────────────────
test('sendPayrollSpreadsheet: { sent:false } when no manager DM', async () => {
  const bot = new MockBot()
  const db  = {
    getSetupSession:      async () => ({ dm_chat_id: null }),
    getPayrollForWeek:    async () => [],
    getLateEventsForWeek: async () => [],
    getOvertimeSettings:  async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup:    async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, false)
})

test('sendPayrollSpreadsheet: { sent:false } when no payroll data', async () => {
  const bot = new MockBot()
  const db  = {
    getSetupSession:      async () => ({ dm_chat_id: '999', setup_data: { restaurant_name: 'T' } }),
    getPayrollForWeek:    async () => [],
    getLateEventsForWeek: async () => [],
    getOvertimeSettings:  async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup:    async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, false)
})

test('sendPayrollSpreadsheet: { sent:true } and file cleaned up after send', async () => {
  const bot = new MockBot()
  let sentPath = null
  bot.sendDocument = async (chatId, fp) => { sentPath = fp; return {} }

  const db = {
    getSetupSession:      async () => ({ dm_chat_id: '999', setup_data: { restaurant_name: 'T' } }),
    getPayrollForWeek:    async () => mockPayroll,
    getLateEventsForWeek: async () => [],
    getOvertimeSettings:  async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup:    async () => [],
  }
  const result = await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  assert.equal(result.sent, true)
  // File should be cleaned up
  if (sentPath) assert.ok(!existsSync(sentPath))
})

test('sendPayrollSpreadsheet: file deleted even when sendDocument throws', async () => {
  const bot = new MockBot()
  let sentPath = null
  bot.sendDocument = async (chatId, fp) => { sentPath = fp; throw new Error('send failed') }

  const db = {
    getSetupSession:      async () => ({ dm_chat_id: '999', setup_data: { restaurant_name: 'T' } }),
    getPayrollForWeek:    async () => mockPayroll,
    getLateEventsForWeek: async () => [],
    getOvertimeSettings:  async () => mockSettings,
    getScheduleAssignments: async () => [],
    getShiftsForGroup:    async () => [],
  }
  try {
    await sendPayrollSpreadsheet(bot, '-100', weekStart, db)
  } catch (e) {
    // expected — send threw
  }
  if (sentPath) assert.ok(!existsSync(sentPath))
})
