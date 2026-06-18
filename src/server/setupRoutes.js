import express from 'express'
import { requireAuth } from './middleware.js'
import { requireAccount } from './accountRoutes.js'
import { getAccountByAuthId, updateAccount, isProvisionalGroup } from './db/accounts.js'
import { updateSetupSession } from '../setup/setupDb.js'
import { getStaffForGroup } from '../setup/db/staff.js'
import { getShiftsForGroup, getShiftRequirements } from '../setup/db/shifts.js'
import { getRatesForGroup, updateRoleRate, deleteRole } from '../setup/db/roles.js'

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

export default router
