import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateProjectedLaborCost, formatBudgetAlert, getBudget, saveBudget } from '../../analytics/budgetAlert.js'

const mockAssignments = [
  { staffId: 1, staffName: 'Marcus', shiftId: 1, roleId: 1, roleName: 'Chef', dayOfWeek: 'Monday' },
  { staffId: 2, staffName: 'Sarah', shiftId: 2, roleId: 2, roleName: 'Server', dayOfWeek: 'Wednesday' },
]
const mockShifts = [
  { id: 1, name: 'Mon Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '5pm' },
  { id: 2, name: 'Wed Dinner', day_of_week: 'Wednesday', start_time: '5pm', end_time: '11pm' },
]
const mockRoles = [
  { id: 1, roleName: 'Chef', hourlyRate: 16 },
  { id: 2, roleName: 'Server', hourlyRate: 14 },
]
const mockOT = { overtime_enabled: true, weekly_threshold: 40, weekly_multiplier: 1.5, daily_overtime_enabled: false }

describe('calculateProjectedLaborCost', () => {
  it('calculates Marcus Chef 6hr shift at $16 → $96', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    const chefRole = result.byRole.find(r => r.roleName === 'Chef')
    assert.equal(chefRole.hours, 6)
    assert.equal(chefRole.cost, 96)
  })

  it('calculates Sarah Server 6hr shift at $14 → $84', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    const serverRole = result.byRole.find(r => r.roleName === 'Server')
    assert.equal(serverRole.hours, 6)
    assert.equal(serverRole.cost, 84)
  })

  it('total projected → $180', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    assert.equal(result.totalProjectedCost, 180)
  })

  it('byDay: Monday $96, Wednesday $84', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    const monday = result.byDay.find(d => d.day === 'Monday')
    const wednesday = result.byDay.find(d => d.day === 'Wednesday')
    assert.equal(monday.cost, 96)
    assert.equal(monday.hours, 6)
    assert.equal(wednesday.cost, 84)
    assert.equal(wednesday.hours, 6)
  })

  it('staffCount is 2', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    assert.equal(result.staffCount, 2)
  })

  it('totalHours is 12', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    assert.equal(result.totalHours, 12)
  })

  it('regularCost and overtimeCost split correctly (no OT triggered)', () => {
    const result = calculateProjectedLaborCost(mockAssignments, mockShifts, mockRoles, mockOT)
    assert.equal(result.regularCost, 180)
    assert.equal(result.overtimeCost, 0)
  })

  it('empty assignments → $0, 0 hours, no crash', () => {
    const result = calculateProjectedLaborCost([], mockShifts, mockRoles, mockOT)
    assert.equal(result.totalProjectedCost, 0)
    assert.equal(result.totalHours, 0)
    assert.equal(result.staffCount, 0)
    assert.deepEqual(result.byRole, [])
    assert.deepEqual(result.byDay, [])
  })

  it('handles overnight shifts correctly', () => {
    const nightShifts = [
      { id: 10, name: 'Night', day_of_week: 'Friday', start_time: '10pm', end_time: '6am' },
    ]
    const nightAssignments = [
      { staffId: 1, staffName: 'Marcus', shiftId: 10, roleId: 1, roleName: 'Chef', dayOfWeek: 'Friday' },
    ]
    const result = calculateProjectedLaborCost(nightAssignments, nightShifts, mockRoles, mockOT)
    assert.equal(result.totalHours, 8)
    assert.equal(result.totalProjectedCost, 128) // 8hrs * $16
  })

  it('applies weekly overtime when hours exceed threshold', () => {
    const heavyShifts = [
      { id: 1, name: 'Mon', day_of_week: 'Monday', start_time: '6am', end_time: '6pm' },
      { id: 2, name: 'Tue', day_of_week: 'Tuesday', start_time: '6am', end_time: '6pm' },
      { id: 3, name: 'Wed', day_of_week: 'Wednesday', start_time: '6am', end_time: '6pm' },
      { id: 4, name: 'Thu', day_of_week: 'Thursday', start_time: '6am', end_time: '6pm' },
    ]
    const heavyAssignments = [
      { staffId: 1, staffName: 'Marcus', shiftId: 1, roleId: 1, roleName: 'Chef', dayOfWeek: 'Monday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 2, roleId: 1, roleName: 'Chef', dayOfWeek: 'Tuesday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 3, roleId: 1, roleName: 'Chef', dayOfWeek: 'Wednesday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 4, roleId: 1, roleName: 'Chef', dayOfWeek: 'Thursday' },
    ]
    const result = calculateProjectedLaborCost(heavyAssignments, heavyShifts, mockRoles, mockOT)
    // 40 regular hours * $16 = $640, 8 OT hours * $16 * 1.5 = $192
    assert.equal(result.totalHours, 48)
    assert.equal(result.regularCost, 640)
    assert.equal(result.overtimeCost, 192)
    assert.equal(result.totalProjectedCost, 832)
  })

  it('no overtime when overtime_enabled is false', () => {
    const noOT = { overtime_enabled: false }
    const heavyShifts = [
      { id: 1, name: 'Mon', day_of_week: 'Monday', start_time: '6am', end_time: '6pm' },
      { id: 2, name: 'Tue', day_of_week: 'Tuesday', start_time: '6am', end_time: '6pm' },
      { id: 3, name: 'Wed', day_of_week: 'Wednesday', start_time: '6am', end_time: '6pm' },
      { id: 4, name: 'Thu', day_of_week: 'Thursday', start_time: '6am', end_time: '6pm' },
    ]
    const heavyAssignments = [
      { staffId: 1, staffName: 'Marcus', shiftId: 1, roleId: 1, roleName: 'Chef', dayOfWeek: 'Monday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 2, roleId: 1, roleName: 'Chef', dayOfWeek: 'Tuesday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 3, roleId: 1, roleName: 'Chef', dayOfWeek: 'Wednesday' },
      { staffId: 1, staffName: 'Marcus', shiftId: 4, roleId: 1, roleName: 'Chef', dayOfWeek: 'Thursday' },
    ]
    const result = calculateProjectedLaborCost(heavyAssignments, heavyShifts, mockRoles, noOT)
    assert.equal(result.totalHours, 48)
    assert.equal(result.regularCost, 768) // 48 * 16
    assert.equal(result.overtimeCost, 0)
    assert.equal(result.totalProjectedCost, 768)
  })
})

describe('formatBudgetAlert', () => {
  const baseProjected = {
    totalProjectedCost: 180,
    totalHours: 12,
    regularCost: 180,
    overtimeCost: 0,
    byRole: [
      { roleId: 1, roleName: 'Chef', hours: 6, cost: 96 },
      { roleId: 2, roleName: 'Server', hours: 6, cost: 84 },
    ],
    byDay: [
      { day: 'Monday', hours: 6, cost: 96 },
      { day: 'Wednesday', hours: 6, cost: 84 },
    ],
    staffCount: 2,
  }

  it('under budget: contains checkmark and "Under by"', () => {
    const text = formatBudgetAlert(baseProjected, 200, '2026-04-06')
    assert.ok(text.includes('✅'))
    assert.ok(text.includes('Under by'))
    assert.ok(text.includes('$180'))
    assert.ok(text.includes('$200'))
  })

  it('under budget: shows percentage of budget', () => {
    const text = formatBudgetAlert(baseProjected, 200, '2026-04-06')
    // $20 under out of $200 = 10%
    assert.ok(text.includes('10'))
  })

  it('under budget: shows role breakdown', () => {
    const text = formatBudgetAlert(baseProjected, 200, '2026-04-06')
    assert.ok(text.includes('Chef'))
    assert.ok(text.includes('Server'))
    assert.ok(text.includes('$96'))
    assert.ok(text.includes('$84'))
  })

  it('under budget: shows day breakdown', () => {
    const text = formatBudgetAlert(baseProjected, 200, '2026-04-06')
    assert.ok(text.includes('Monday'))
    assert.ok(text.includes('Wednesday'))
  })

  it('over budget: contains warning and "OVER by"', () => {
    const text = formatBudgetAlert({ ...baseProjected, totalProjectedCost: 250 }, 200, '2026-04-06')
    assert.ok(text.includes('⚠️'))
    assert.ok(text.includes('OVER by'))
    assert.ok(text.includes('$250'))
    assert.ok(text.includes('$200'))
  })

  it('over budget: shows percentage over', () => {
    const text = formatBudgetAlert({ ...baseProjected, totalProjectedCost: 250 }, 200, '2026-04-06')
    // $50 over out of $200 = 25%
    assert.ok(text.includes('25'))
  })

  it('over budget: shows most expensive day', () => {
    const text = formatBudgetAlert({ ...baseProjected, totalProjectedCost: 250 }, 200, '2026-04-06')
    assert.ok(text.includes('Most expensive day'))
    assert.ok(text.includes('Monday'))
  })

  it('over budget: shows approve and regenerate options', () => {
    const text = formatBudgetAlert({ ...baseProjected, totalProjectedCost: 250 }, 200, '2026-04-06')
    assert.ok(text.includes('approve'))
    assert.ok(text.includes('regenerate'))
  })

  it('no budget: contains info icon and /setbudget tip', () => {
    const text = formatBudgetAlert(baseProjected, null, '2026-04-06')
    assert.ok(text.includes('📊'))
    assert.ok(text.includes('/setbudget'))
    assert.ok(text.includes('$180'))
  })

  it('no budget: shows role and day breakdown', () => {
    const text = formatBudgetAlert(baseProjected, null, '2026-04-06')
    assert.ok(text.includes('Chef'))
    assert.ok(text.includes('Monday'))
  })
})

describe('getBudget / saveBudget (mock DB)', () => {
  it('saveBudget saves correctly via mock', async () => {
    let saved = null
    const db = {
      saveBudget: async (groupId, amount) => { saved = { groupId, amount } },
      getBudget: async () => null,
    }
    await saveBudget('group-123', 3200, db)
    assert.deepEqual(saved, { groupId: 'group-123', amount: 3200 })
  })

  it('getBudget returns saved value via mock', async () => {
    const db = {
      getBudget: async (groupId) => ({ weeklyBudget: 3200, currency: 'USD' }),
    }
    const result = await getBudget('group-123', db)
    assert.equal(result.weeklyBudget, 3200)
    assert.equal(result.currency, 'USD')
  })

  it('getBudget returns null when not set', async () => {
    const db = {
      getBudget: async () => null,
    }
    const result = await getBudget('group-123', db)
    assert.equal(result, null)
  })

  it('saveBudget upserts (second call updates)', async () => {
    let stored = {}
    const db = {
      saveBudget: async (groupId, amount) => { stored[groupId] = amount },
      getBudget: async (groupId) => stored[groupId] ? { weeklyBudget: stored[groupId], currency: 'USD' } : null,
    }
    await saveBudget('g1', 1000, db)
    await saveBudget('g1', 2000, db)
    const result = await getBudget('g1', db)
    assert.equal(result.weeklyBudget, 2000)
  })
})
