import express from 'express'
import { requireAuth } from './middleware.js'
import { requireAccount } from './accountRoutes.js'
import { getAccountByAuthId, updateAccount, isProvisionalGroup } from './db/accounts.js'
import { updateSetupSession } from '../setup/setupDb.js'
import { getStaffForGroup, saveStaff, updateStaffById, deleteStaffById } from '../setup/db/staff.js'
import { getShiftsForGroup, getShiftRequirements, saveShift, saveShiftRequirement, deleteShiftById } from '../setup/db/shifts.js'
import { normalizeShiftTime } from '../utils/time.js'
import { getRatesForGroup, updateRoleRate, deleteRole } from '../setup/db/roles.js'
import { parseShift, parseStaff, parseShiftRequirements } from '../parseMessage.js'
import { hasAnyLLM } from '../parsers/llm.js'

const router = express.Router()
const gate = [requireAuth, requireAccount]

// GET /api/account/setup — everything the wizard needs to resume.
router.get('/', ...gate, async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const [staff, shiftsRaw, rates, account] = await Promise.all([
      getStaffForGroup(groupId),
      getShiftsForGroup(groupId),
      getRatesForGroup(groupId),
      getAccountByAuthId(req.manager.accountId),
    ])
    const shifts = []
    for (const s of shiftsRaw) {
      const reqs = await getShiftRequirements(s.id)
      shifts.push({
        id: s.id, name: s.name, day_of_week: s.day_of_week,
        start_time: s.start_time, end_time: s.end_time,
        requirements: (reqs || []).map(r => ({ role: r.role, count: r.count })),
      })
    }
    res.json({
      businessName: account?.business_name || '',
      roles: (rates || []).map(r => ({ name: r.roleName, rate: Number(r.hourlyRate) || 0 })),
      staff: (staff || []).map(s => ({ id: s.id, name: s.name, role: s.role })),
      shifts,
      connected: !isProvisionalGroup(groupId),
    })
  } catch (err) {
    console.error('GET /setup error:', err.message)
    res.status(500).json({ error: 'Could not load your setup' })
  }
})

// POST /api/account/setup/role — create a role (idempotent, never clobbers a rate).
router.post('/role', ...gate, async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim()
    if (!role) return res.status(400).json({ error: 'Role name required' })
    const existing = await getRatesForGroup(req.manager.groupId)
    if (!existing.some(r => r.roleName.toLowerCase() === role.toLowerCase())) {
      await updateRoleRate(req.manager.groupId, role, 0)
    }
    res.status(201).json({ role })
  } catch (err) {
    console.error('POST /setup/role error:', err.message)
    res.status(500).json({ error: 'Could not add role' })
  }
})

// DELETE /api/account/setup/role/:role
router.delete('/role/:role', ...gate, async (req, res) => {
  try {
    await deleteRole(req.manager.groupId, decodeURIComponent(req.params.role))
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/role error:', err.message)
    res.status(500).json({ error: 'Could not remove role' })
  }
})

// PATCH /api/account/setup/rate — set hourly rate for a role.
router.patch('/rate', ...gate, async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim()
    if (!role) return res.status(400).json({ error: 'Role required' })
    await updateRoleRate(req.manager.groupId, role, Number(req.body?.hourly_rate) || 0)
    res.json({ role, hourly_rate: Number(req.body?.hourly_rate) || 0 })
  } catch (err) {
    console.error('PATCH /setup/rate error:', err.message)
    res.status(500).json({ error: 'Could not save rate' })
  }
})

// POST /api/account/setup/business-name
router.post('/business-name', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name required' })
    await updateAccount(req.manager.accountId, { business_name: name })
    await updateSetupSession(req.manager.groupId, { group_name: name })
    res.json({ businessName: name })
  } catch (err) {
    console.error('POST /setup/business-name error:', err.message)
    res.status(500).json({ error: 'Could not save name' })
  }
})

// ── Staff ──
router.post('/staff', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name required' })
    const role = String(req.body?.role || 'Staff').trim() || 'Staff'
    const row = await saveStaff(req.manager.groupId, name, role)
    res.status(201).json({ id: row?.id, name, role })
  } catch (err) {
    console.error('POST /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not add team member' })
  }
})

router.patch('/staff/:id', ...gate, async (req, res) => {
  try {
    const changes = {}
    if (req.body?.name !== undefined) changes.name = String(req.body.name).trim()
    if (req.body?.role !== undefined) changes.role = String(req.body.role).trim()
    const row = await updateStaffById(req.params.id, req.manager.groupId, changes)
    res.json(row || {})
  } catch (err) {
    console.error('PATCH /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not update team member' })
  }
})

router.delete('/staff/:id', ...gate, async (req, res) => {
  try {
    await deleteStaffById(req.params.id, req.manager.groupId)
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not remove team member' })
  }
})

// ── Shifts ──
router.post('/shift', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    const day = String(req.body?.day_of_week || '').trim()
    if (!name || !day) return res.status(400).json({ error: 'Shift name and day are required' })
    const start = normalizeShiftTime(String(req.body?.start_time || '').trim())
    const end = normalizeShiftTime(String(req.body?.end_time || '').trim())
    const shift = await saveShift(req.manager.groupId, name, day, start || null, end || null)
    if (shift?.id && Array.isArray(req.body?.requirements)) {
      for (const r of req.body.requirements) {
        if (r?.role) await saveShiftRequirement(shift.id, r.role, Number(r.count) || 1)
      }
    }
    res.status(201).json({ id: shift?.id, name, day_of_week: day, start_time: start, end_time: end })
  } catch (err) {
    console.error('POST /setup/shift error:', err.message)
    res.status(500).json({ error: 'Could not add shift' })
  }
})

router.delete('/shift/:id', ...gate, async (req, res) => {
  try {
    await deleteShiftById(req.params.id, req.manager.groupId)
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/shift error:', err.message)
    res.status(500).json({ error: 'Could not remove shift' })
  }
})

const MAX_PARSE = 2000
function parseGuard(req, res) {
  if (!hasAnyLLM()) { res.status(503).json({ error: 'AI parsing is not available', reason: 'no_llm' }); return null }
  const text = String(req.body?.text || '')
  if (text.length > MAX_PARSE) { res.status(400).json({ error: 'That description is too long' }); return null }
  return text
}

router.post('/parse-shifts', ...gate, async (req, res) => {
  const text = parseGuard(req, res); if (text === null) return
  try {
    const shifts = await parseShift(text)
    const names = [...new Set(shifts.map(s => s.name))]
    const reqs = names.length ? await parseShiftRequirements(text, names) : []
    const byName = {}
    for (const r of reqs) (byName[r.shift_name] ||= []).push({ role: r.role, count: r.count })
    res.json({ shifts: shifts.map(s => ({ ...s, requirements: byName[s.name] || [] })) })
  } catch (err) {
    console.error('POST /setup/parse-shifts error:', err.message)
    res.json({ shifts: [] })
  }
})

router.post('/parse-staff', ...gate, async (req, res) => {
  const text = parseGuard(req, res); if (text === null) return
  try {
    res.json({ staff: await parseStaff(text, null) })
  } catch (err) {
    console.error('POST /setup/parse-staff error:', err.message)
    res.json({ staff: [] })
  }
})

export default router
