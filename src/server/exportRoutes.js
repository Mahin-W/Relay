import express from 'express'
import ExcelJS from 'exceljs'
import { getDb } from '../db.js'
import { requireAuth } from './middleware.js'

const router = express.Router()
router.use(requireAuth)

// Tables we expose to the manager. Each entry: { sheet, query }
// query receives the supabase client + groupId and returns rows. Anything that
// throws (table missing, column drift) is caught per-table so one missing table
// doesn't break the whole export.
const EXPORTS = [
  {
    sheet: 'Staff',
    fn: (db, groupId) => db.from('staff')
      .select('*').eq('group_id', groupId).order('created_at', { ascending: true }),
  },
  {
    sheet: 'Shifts',
    fn: (db, groupId) => db.from('shifts')
      .select('*').eq('group_id', groupId).order('day_of_week', { ascending: true }),
  },
  {
    sheet: 'Schedule Assignments',
    fn: (db, groupId) => db.from('schedule_assignments')
      .select('*').eq('group_id', groupId).order('week_start', { ascending: false }).limit(2000),
  },
  {
    sheet: 'Payroll Records',
    fn: (db, groupId) => db.from('payroll_records')
      .select('*').eq('group_id', groupId).order('week_start', { ascending: false }),
  },
  {
    sheet: 'Time Entries',
    fn: (db, groupId) => db.from('time_entries')
      .select('*').eq('group_id', groupId).order('clock_in', { ascending: false }).limit(5000),
  },
  {
    sheet: 'Daily Revenue',
    fn: (db, groupId) => db.from('daily_revenue')
      .select('*').eq('group_id', groupId).order('entry_date', { ascending: false }),
  },
  {
    sheet: 'Tip Records',
    fn: (db, groupId) => db.from('tip_records')
      .select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(2000),
  },
  {
    sheet: 'Coverage Requests',
    fn: (db, groupId) => db.from('coverage_requests')
      .select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(2000),
  },
  {
    sheet: 'Manager Log',
    fn: (db, groupId) => db.from('manager_log_entries')
      .select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(2000),
  },
]

function addRowsToSheet(ws, rows) {
  if (!rows || rows.length === 0) {
    ws.addRow(['(no rows)'])
    return
  }
  // Stable column order: union of keys across rows, in first-row insertion order.
  const cols = []
  const seen = new Set()
  for (const r of rows) {
    for (const k of Object.keys(r ?? {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k) }
    }
  }
  const headerRow = ws.addRow(cols)
  headerRow.font = { bold: true }
  for (const r of rows) {
    ws.addRow(cols.map(c => {
      const v = r?.[c]
      if (v == null) return ''
      // ExcelJS handles primitives fine; serialize objects/arrays as JSON.
      if (typeof v === 'object') return JSON.stringify(v)
      return v
    }))
  }
}

// GET /api/export — returns an XLSX file with one sheet per table.
// All sheets are filtered to req.manager.groupId so a manager can only ever
// download their own restaurant's data.
router.get('/export', async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const db = getDb()
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Relay'
    wb.created = new Date()

    // Cover sheet so the file is self-explanatory when the customer opens it.
    const cover = wb.addWorksheet('README')
    cover.addRow(['Relay Data Export'])
    cover.addRow([`Restaurant: ${req.manager.restaurantName ?? '(unknown)'}`])
    cover.addRow([`Generated:  ${new Date().toISOString()}`])
    cover.addRow([])
    cover.addRow(['Each sheet below is a Postgres table filtered to your group.'])
    cover.addRow(['Questions: mahinwaghray@gmail.com'])
    cover.getRow(1).font = { bold: true, size: 14 }

    for (const spec of EXPORTS) {
      const ws = wb.addWorksheet(spec.sheet)
      try {
        const { data, error } = await spec.fn(db, groupId)
        if (error) {
          ws.addRow([`Error loading ${spec.sheet}: ${error.message}`])
          continue
        }
        addRowsToSheet(ws, data)
      } catch (err) {
        ws.addRow([`Error loading ${spec.sheet}: ${err.message}`])
      }
    }

    const buf = await wb.xlsx.writeBuffer()
    const date = new Date().toISOString().split('T')[0]
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="relay-export-${date}.xlsx"`)
    res.send(Buffer.from(buf))
  } catch (err) {
    console.error('[export] error:', err.message)
    res.status(500).json({ error: 'Export failed — try again or email support' })
  }
})

export default router
