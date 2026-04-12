import { describe, it, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, MockDB, makeDMMsg } from '../helpers/mocks.js'
import {
  isEarnedWageQuery,
  calculateEarnedWages,
  formatEarnedWageResponse,
  handleEarnedWageQuery,
} from '../../engagement/earnedWage.js'

// ── Shared test data ─────────────────────────────────────────────────────────

const tuesday2pm = new Date('2025-01-07T14:00:00')
const weekStart = '2025-01-06' // Monday

// Helper: build a MockDB with earned-wage query support
function makeWageDb({ assignments = [], staffRecord = null, staffDm = null, roleRate = null } = {}) {
  const db = new MockDB()

  // getAssignmentsForStaffWeek(staffId, weekStart) → assignments with shift data
  db.getAssignmentsForStaffWeek = async (staffId, ws) => {
    return assignments
  }

  // getStaffWithRole(staffId) → { id, name, role, group_id }
  db.getStaffWithRole = async (staffId) => {
    if (!staffRecord) return null
    return { id: staffRecord.id, name: staffRecord.name, role: staffRecord.role ?? 'Server', group_id: staffRecord.groupId }
  }

  // getRoleRate(groupId, roleName) → hourly rate number
  db.getRoleRate = async (groupId, roleName) => {
    return roleRate ?? staffRecord?.hourlyRate ?? 0
  }

  // getStaffByDmChatId(dmChatId) → staff record with group info
  db.getStaffByDmChatId = async (dmChatId) => {
    if (!staffDm) return null
    return staffDm
  }

  return db
}

// ── isEarnedWageQuery ────────────────────────────────────────────────────────

describe('isEarnedWageQuery', { concurrency: true }, () => {
  it('"how much have I made" -> true', () => {
    assert.equal(isEarnedWageQuery('how much have I made'), true)
  })

  it('"my earnings this week" -> true', () => {
    assert.equal(isEarnedWageQuery('my earnings this week'), true)
  })

  it('"earned so far" -> true', () => {
    assert.equal(isEarnedWageQuery('earned so far'), true)
  })

  it('"how much am I making" -> true', () => {
    assert.equal(isEarnedWageQuery('how much am I making'), true)
  })

  it('"my pay so far" -> true', () => {
    assert.equal(isEarnedWageQuery('my pay so far'), true)
  })

  it('"my wages" -> true', () => {
    assert.equal(isEarnedWageQuery('my wages'), true)
  })

  it('"what have i earned" -> true', () => {
    assert.equal(isEarnedWageQuery('what have i earned'), true)
  })

  it('"how much will i get paid" -> true', () => {
    assert.equal(isEarnedWageQuery('how much will i get paid'), true)
  })

  it('"how much did i make" -> true', () => {
    assert.equal(isEarnedWageQuery('how much did i make'), true)
  })

  it('"made so far" -> true', () => {
    assert.equal(isEarnedWageQuery('made so far'), true)
  })

  it('"earnings this week" -> true', () => {
    assert.equal(isEarnedWageQuery('earnings this week'), true)
  })

  it('"my income this week" -> true', () => {
    assert.equal(isEarnedWageQuery('my income this week'), true)
  })

  it('"what am i making" -> true', () => {
    assert.equal(isEarnedWageQuery('what am i making'), true)
  })

  it('"how much so far" -> true', () => {
    assert.equal(isEarnedWageQuery('how much so far'), true)
  })

  it('"HOW MUCH HAVE I MADE" case insensitive -> true', () => {
    assert.equal(isEarnedWageQuery('HOW MUCH HAVE I MADE'), true)
  })

  it('"can I swap shifts" -> false', () => {
    assert.equal(isEarnedWageQuery('can I swap shifts'), false)
  })

  it('"my schedule" -> false', () => {
    assert.equal(isEarnedWageQuery('my schedule'), false)
  })

  it('empty string -> false', () => {
    assert.equal(isEarnedWageQuery(''), false)
  })

  it('null/undefined -> false', () => {
    assert.equal(isEarnedWageQuery(null), false)
    assert.equal(isEarnedWageQuery(undefined), false)
  })
})

// ── calculateEarnedWages ─────────────────────────────────────────────────────

describe('calculateEarnedWages', { concurrency: true }, () => {
  it('calculates correctly at tuesday 2pm with mixed shift statuses', async () => {
    const assignments = [
      // Monday 11am-4pm: completed by tuesday 2pm → 5hrs
      { shift_id: 1, day_of_week: 'Monday', start_time: '11am', end_time: '4pm', shift_name: 'Monday Lunch' },
      // Tuesday 12pm-8pm: in progress at 2pm → 2hrs elapsed
      { shift_id: 2, day_of_week: 'Tuesday', start_time: '12pm', end_time: '8pm', shift_name: 'Tuesday Dinner' },
      // Friday 5pm-11pm: upcoming → 0hrs
      { shift_id: 3, day_of_week: 'Friday', start_time: '5pm', end_time: '11pm', shift_name: 'Friday Night' },
    ]

    const db = makeWageDb({
      assignments,
      staffRecord: { id: 1, name: 'Marcus', hourlyRate: 15, groupId: 'g1', role: 'Server' },
      roleRate: 15,
    })

    const result = await calculateEarnedWages(1, 'g1', weekStart, tuesday2pm, db)

    assert.equal(result.staffName, 'Marcus')
    assert.equal(result.weekStart, weekStart)
    assert.equal(result.hourlyRate, 15)
    assert.equal(result.shiftsCompleted, 1)
    assert.equal(result.shiftsInProgress, 1)
    assert.equal(result.shiftsUpcoming, 1)
    assert.equal(result.hoursWorked, 7) // 5 completed + 2 in-progress
    assert.equal(result.earnedSoFar, 75) // 5hrs * $15 (completed only)
    assert.equal(result.currentShiftEarnings, 30) // 2hrs * $15
    assert.equal(result.projectedWeekTotal, 285) // (5+8+6) * $15
    assert.equal(result.noShiftsThisWeek, false)
    // hoursScheduledTotal = 5 + 8 + 6 = 19
    assert.equal(result.hoursScheduledTotal, 19)
  })

  it('returns noShiftsThisWeek when no assignments', async () => {
    const db = makeWageDb({
      assignments: [],
      staffRecord: { id: 1, name: 'Marcus', hourlyRate: 15, groupId: 'g1', role: 'Server' },
      roleRate: 15,
    })

    const result = await calculateEarnedWages(1, 'g1', weekStart, tuesday2pm, db)

    assert.equal(result.noShiftsThisWeek, true)
    assert.equal(result.earnedSoFar, 0)
    assert.equal(result.shiftsCompleted, 0)
    assert.equal(result.shiftsInProgress, 0)
    assert.equal(result.shiftsUpcoming, 0)
  })

  it('handles all-completed shifts (end of week)', async () => {
    const saturday10am = new Date('2025-01-11T10:00:00')
    const assignments = [
      { shift_id: 1, day_of_week: 'Monday', start_time: '9am', end_time: '5pm', shift_name: 'Mon' },
      { shift_id: 2, day_of_week: 'Wednesday', start_time: '9am', end_time: '5pm', shift_name: 'Wed' },
    ]

    const db = makeWageDb({
      assignments,
      staffRecord: { id: 1, name: 'Marcus', hourlyRate: 20, groupId: 'g1', role: 'Cook' },
      roleRate: 20,
    })

    const result = await calculateEarnedWages(1, 'g1', weekStart, saturday10am, db)

    assert.equal(result.shiftsCompleted, 2)
    assert.equal(result.shiftsInProgress, 0)
    assert.equal(result.shiftsUpcoming, 0)
    assert.equal(result.hoursWorked, 16) // 8 + 8
    assert.equal(result.earnedSoFar, 320) // 16 * 20
    assert.equal(result.currentShiftEarnings, null)
    assert.equal(result.projectedWeekTotal, 320) // same as earned, no upcoming
  })

  it('handles all-upcoming shifts (start of week)', async () => {
    const mondayEarly = new Date('2025-01-06T06:00:00') // Monday 6am, before any shifts
    const assignments = [
      { shift_id: 1, day_of_week: 'Monday', start_time: '9am', end_time: '5pm', shift_name: 'Mon' },
      { shift_id: 2, day_of_week: 'Friday', start_time: '12pm', end_time: '8pm', shift_name: 'Fri' },
    ]

    const db = makeWageDb({
      assignments,
      staffRecord: { id: 1, name: 'Marcus', hourlyRate: 15, groupId: 'g1', role: 'Server' },
      roleRate: 15,
    })

    const result = await calculateEarnedWages(1, 'g1', weekStart, mondayEarly, db)

    assert.equal(result.shiftsCompleted, 0)
    assert.equal(result.shiftsInProgress, 0)
    assert.equal(result.shiftsUpcoming, 2)
    assert.equal(result.hoursWorked, 0)
    assert.equal(result.earnedSoFar, 0)
    assert.equal(result.currentShiftEarnings, null)
    assert.equal(result.projectedWeekTotal, 240) // (8+8) * 15
  })
})

// ── formatEarnedWageResponse ─────────────────────────────────────────────────

describe('formatEarnedWageResponse', { concurrency: true }, () => {
  const midShiftResult = {
    staffName: 'Marcus',
    weekStart,
    hourlyRate: 15,
    shiftsCompleted: 1,
    shiftsInProgress: 1,
    shiftsUpcoming: 1,
    hoursWorked: 7,
    hoursScheduledTotal: 19,
    earnedSoFar: 75,
    currentShiftEarnings: 30,
    projectedWeekTotal: 285,
    noShiftsThisWeek: false,
  }

  it('shows earnedSoFar prominently', () => {
    const text = formatEarnedWageResponse(midShiftResult)
    assert.ok(text.includes('$75'), 'should show $75 earned so far')
    assert.ok(text.includes('Earned so far'), 'should label earned so far')
  })

  it('shows currentShiftEarnings when mid-shift', () => {
    const text = formatEarnedWageResponse(midShiftResult)
    assert.ok(text.includes('$30'), 'should show $30 current shift earnings')
    assert.ok(text.toLowerCase().includes('right now'), 'should say "right now"')
  })

  it('shows projected total when upcoming shifts exist', () => {
    const text = formatEarnedWageResponse(midShiftResult)
    assert.ok(text.includes('$285'), 'should show projected total')
    assert.ok(text.toLowerCase().includes('projected'), 'should say projected')
  })

  it('shows hourly rate by default', () => {
    const text = formatEarnedWageResponse(midShiftResult)
    assert.ok(text.includes('$15/hr'), 'should show hourly rate')
  })

  it('hides hourly rate when showRate=false', () => {
    const text = formatEarnedWageResponse(midShiftResult, false)
    assert.ok(!text.includes('$15/hr'), 'should not show hourly rate')
  })

  it('shows "No shifts scheduled" when noShiftsThisWeek', () => {
    const noShifts = {
      staffName: 'Marcus',
      weekStart,
      hourlyRate: 15,
      shiftsCompleted: 0,
      shiftsInProgress: 0,
      shiftsUpcoming: 0,
      hoursWorked: 0,
      hoursScheduledTotal: 0,
      earnedSoFar: 0,
      currentShiftEarnings: null,
      projectedWeekTotal: 0,
      noShiftsThisWeek: true,
    }
    const text = formatEarnedWageResponse(noShifts)
    assert.ok(text.toLowerCase().includes('no shifts scheduled'), 'should indicate no shifts')
  })

  it('does not show current shift earnings when not mid-shift', () => {
    const noMidShift = {
      ...midShiftResult,
      shiftsInProgress: 0,
      currentShiftEarnings: null,
    }
    const text = formatEarnedWageResponse(noMidShift)
    assert.ok(!text.toLowerCase().includes('right now'), 'should not say right now when not mid-shift')
  })

  it('does not show upcoming section when no upcoming shifts', () => {
    const noUpcoming = {
      ...midShiftResult,
      shiftsUpcoming: 0,
      projectedWeekTotal: 105, // just completed + in-progress
    }
    const text = formatEarnedWageResponse(noUpcoming)
    assert.ok(!text.includes('remaining'), 'should not say remaining when no upcoming shifts')
  })

  it('shows completed shift count and hours', () => {
    const text = formatEarnedWageResponse(midShiftResult)
    assert.ok(text.includes('1'), 'should show completed shift count')
    // Should show hours worked for completed shifts
    assert.ok(text.includes('shift'), 'should mention shifts')
  })
})

// ── handleEarnedWageQuery ────────────────────────────────────────────────────

describe('handleEarnedWageQuery', { concurrency: true }, () => {
  it('sends registration message for unregistered user', async () => {
    const bot = new MockBot()
    const db = makeWageDb({ staffDm: null })
    const msg = makeDMMsg({ text: 'how much have I made' })

    await handleEarnedWageQuery(bot, msg, db)

    const sent = bot.lastMessage('12345')
    assert.ok(sent, 'should send a message')
    assert.ok(
      sent.text.toLowerCase().includes('register') || sent.text.toLowerCase().includes('/start'),
      'should tell user to register'
    )
  })

  it('sends formatted earnings for registered user', async () => {
    const bot = new MockBot()
    const assignments = [
      { shift_id: 1, day_of_week: 'Monday', start_time: '11am', end_time: '4pm', shift_name: 'Monday Lunch' },
    ]
    const db = makeWageDb({
      assignments,
      staffRecord: { id: 1, name: 'Marcus', hourlyRate: 15, groupId: 'g1', role: 'Server' },
      staffDm: { staff_id: 1, group_id: 'g1', name: 'Marcus', role: 'Server' },
      roleRate: 15,
    })
    const msg = makeDMMsg({ text: 'how much have I made' })

    await handleEarnedWageQuery(bot, msg, db)

    const sent = bot.lastMessage('12345')
    assert.ok(sent, 'should send a message')
    assert.ok(sent.text.includes('earnings') || sent.text.includes('Earned'), 'should contain earnings info')
  })

  it('only works in DM (private chat)', async () => {
    const bot = new MockBot()
    const db = makeWageDb()
    // Group message, not DM
    const msg = {
      chat: { id: '-100999', type: 'group', title: 'Kitchen Staff' },
      from: { id: 12345, first_name: 'Mike' },
      text: 'how much have I made',
    }

    await handleEarnedWageQuery(bot, msg, db)

    const sent = bot.lastMessage('-100999')
    // Should either not respond or tell them to DM
    if (sent) {
      assert.ok(
        sent.text.toLowerCase().includes('dm') || sent.text.toLowerCase().includes('private'),
        'should tell user to DM the bot'
      )
    }
    // No crash is also acceptable
  })
})
