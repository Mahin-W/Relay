import { describe, it, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  parseTipMessage,
  calculateTipSplit,
  getTipEligibleStaff,
  formatTipSplit,
  handleTipMessage,
  handleTipModeCommand,
  handleTipHistory,
} from '../../operations/tipPool.js'

// ── Shared mock data ──────────────────────────────────────────────────────────

const mockStaff = [
  { staffId: 1, staffName: 'Marcus', roleName: 'Server', hoursWorked: 6 },
  { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursWorked: 4 },
  { staffId: 3, staffName: 'Jake', roleName: 'Busser', hoursWorked: 5 },
  { staffId: 4, staffName: 'Carlos', roleName: 'Cook', hoursWorked: 6 },
]

function makeTipDb(overrides = {}) {
  return {
    getTipSettings: async (groupId) => ({
      mode: 'pool', splitMethod: 'hours', bohIncluded: false,
    }),
    saveTipSettings: async (groupId, settings) => ({ group_id: groupId, ...settings }),
    saveTipRecord: async () => ({ id: 1 }),
    getTipHistory: async () => [],
    getTipEligibleStaff: async (groupId, shiftId, shiftDate, bohIncluded) => {
      if (bohIncluded) return mockStaff
      return mockStaff.filter(s => s.roleName.toLowerCase() !== 'cook')
    },
    getManagerGroup: async (userId) => ({ group_id: '-100', group_name: 'Test Restaurant' }),
    ...overrides,
  }
}

function makeMsg(text, chatId = '999', userId = 12345) {
  return {
    text,
    chat: { id: chatId, type: 'private' },
    from: { id: userId, first_name: 'Mike' },
  }
}

// ── parseTipMessage ───────────────────────────────────────────────────────────

describe('parseTipMessage', { concurrency: true }, () => {
  it('"tips were $840 tonight" -> totalTips:840', () => {
    const result = parseTipMessage('tips were $840 tonight')
    assert.equal(result.totalTips, 840)
  })

  it('"split $1,200 from Friday dinner" -> totalTips:1200 + shiftReference', () => {
    const result = parseTipMessage('split $1,200 from Friday dinner')
    assert.equal(result.totalTips, 1200)
    assert.ok(result.shiftReference.toLowerCase().includes('friday dinner'))
  })

  it('"840 tips" -> totalTips:840', () => {
    const result = parseTipMessage('840 tips')
    assert.equal(result.totalTips, 840)
  })

  it('"$1.2k tips" -> totalTips:1200', () => {
    const result = parseTipMessage('$1.2k tips')
    assert.equal(result.totalTips, 1200)
  })

  it('"tips: 650" -> totalTips:650', () => {
    const result = parseTipMessage('tips: 650')
    assert.equal(result.totalTips, 650)
  })

  it('"$2.5k" -> totalTips:2500', () => {
    const result = parseTipMessage('$2.5k')
    assert.equal(result.totalTips, 2500)
  })

  it('"can anyone cover" -> null', () => {
    assert.equal(parseTipMessage('can anyone cover'), null)
  })

  it('"tips were great" -> null (no number)', () => {
    assert.equal(parseTipMessage('tips were great'), null)
  })

  it('empty string -> null', () => {
    assert.equal(parseTipMessage(''), null)
  })
})

// ── calculateTipSplit hours ───────────────────────────────────────────────────

describe('calculateTipSplit hours', { concurrency: true }, () => {
  it('$1500 / 3 staff weighted by hours', () => {
    const staff = mockStaff.filter(s => s.roleName !== 'Cook')
    const splits = calculateTipSplit(1500, staff, 'hours')
    const marcus = splits.find(s => s.staffName === 'Marcus')
    const sarah = splits.find(s => s.staffName === 'Sarah')
    const jake = splits.find(s => s.staffName === 'Jake')
    assert.equal(marcus.amount, 600)
    assert.equal(sarah.amount, 400)
    assert.equal(jake.amount, 500)
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 1500)
  })

  it('$100 / 3 people: rounding works, sum=$100 exactly', () => {
    const staff = [
      { staffId: 1, staffName: 'A', roleName: 'Server', hoursWorked: 5 },
      { staffId: 2, staffName: 'B', roleName: 'Server', hoursWorked: 5 },
      { staffId: 3, staffName: 'C', roleName: 'Server', hoursWorked: 5 },
    ]
    const splits = calculateTipSplit(100, staff, 'hours')
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 100)
  })

  it('single staff gets full amount', () => {
    const staff = [{ staffId: 1, staffName: 'Solo', roleName: 'Server', hoursWorked: 8 }]
    const splits = calculateTipSplit(500, staff, 'hours')
    assert.equal(splits[0].amount, 500)
  })

  it('zero hours -> $0', () => {
    const staff = [
      { staffId: 1, staffName: 'A', roleName: 'Server', hoursWorked: 0 },
      { staffId: 2, staffName: 'B', roleName: 'Server', hoursWorked: 8 },
    ]
    const splits = calculateTipSplit(200, staff, 'hours')
    const a = splits.find(s => s.staffName === 'A')
    assert.equal(a.amount, 0)
  })
})

// ── calculateTipSplit equal ───────────────────────────────────────────────────

describe('calculateTipSplit equal', { concurrency: true }, () => {
  it('$300 / 3 = $100 each', () => {
    const staff = mockStaff.slice(0, 3)
    const splits = calculateTipSplit(300, staff, 'equal')
    for (const s of splits) assert.equal(s.amount, 100)
  })

  it('$100 / 3 -> sum=$100 exactly', () => {
    const staff = mockStaff.slice(0, 3)
    const splits = calculateTipSplit(100, staff, 'equal')
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 100)
  })
})

// ── calculateTipSplit points ──────────────────────────────────────────────────

describe('calculateTipSplit points', { concurrency: true }, () => {
  it('points-based split for Marcus(server,6h), Sarah(server,4h), Jake(busser,5h)', () => {
    const staff = mockStaff.filter(s => s.roleName !== 'Cook')
    const splits = calculateTipSplit(1000, staff, 'points')
    // server=3, busser=1.5
    // Marcus: 3*6=18, Sarah: 3*4=12, Jake: 1.5*5=7.5 => total=37.5
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 1000)
  })

  it('sum always equals totalTips exactly', () => {
    const splits = calculateTipSplit(777.77, mockStaff, 'points')
    const sum = splits.reduce((s, x) => s + x.amount, 0)
    assert.equal(sum, 777.77)
  })
})

// ── getTipEligibleStaff ───────────────────────────────────────────────────────

describe('getTipEligibleStaff', { concurrency: true }, () => {
  it('bohIncluded:false excludes Carlos (cook)', async () => {
    const allStaff = [
      { id: 1, name: 'Marcus', role: 'Server' },
      { id: 2, name: 'Sarah', role: 'Server' },
      { id: 3, name: 'Jake', role: 'Busser' },
      { id: 4, name: 'Carlos', role: 'Cook' },
    ]
    const db = {
      getShiftRosterWithHours: async () =>
        allStaff.map(s => ({
          staffId: s.id, staffName: s.name, roleName: s.role, hoursWorked: 6,
        })),
    }
    const result = await getTipEligibleStaff('-100', 1, '2026-04-12', false, db)
    assert.ok(!result.some(s => s.staffName === 'Carlos'))
    assert.equal(result.length, 3)
  })

  it('bohIncluded:true includes Carlos', async () => {
    const allStaff = [
      { id: 1, name: 'Marcus', role: 'Server' },
      { id: 4, name: 'Carlos', role: 'Cook' },
    ]
    const db = {
      getShiftRosterWithHours: async () =>
        allStaff.map(s => ({
          staffId: s.id, staffName: s.name, roleName: s.role, hoursWorked: 6,
        })),
    }
    const result = await getTipEligibleStaff('-100', 1, '2026-04-12', true, db)
    assert.ok(result.some(s => s.staffName === 'Carlos'))
  })

  it('unknown role is included always', async () => {
    const db = {
      getShiftRosterWithHours: async () => [
        { staffId: 1, staffName: 'Pat', roleName: 'Floater', hoursWorked: 5 },
      ],
    }
    const result = await getTipEligibleStaff('-100', 1, '2026-04-12', false, db)
    assert.equal(result.length, 1)
    assert.equal(result[0].staffName, 'Pat')
  })
})

// ── formatTipSplit ────────────────────────────────────────────────────────────

describe('formatTipSplit', { concurrency: true }, () => {
  it('pool mode: contains names, amounts, sum', () => {
    const splits = [
      { staffId: 1, staffName: 'Marcus', roleName: 'Server', hoursWorked: 6, amount: 600 },
      { staffId: 2, staffName: 'Sarah', roleName: 'Server', hoursWorked: 4, amount: 400 },
    ]
    const text = formatTipSplit(1000, splits, { mode: 'pool', splitMethod: 'hours', bohIncluded: false })
    assert.ok(text.includes('Marcus'))
    assert.ok(text.includes('Sarah'))
    assert.ok(text.includes('600'))
    assert.ok(text.includes('400'))
    assert.ok(text.includes('1000') || text.includes('1,000'))
  })

  it('cash mode: contains "logged"', () => {
    const text = formatTipSplit(500, [], { mode: 'cash', splitMethod: 'hours', bohIncluded: false })
    assert.ok(text.toLowerCase().includes('logged'))
  })
})

// ── handleTipMessage ──────────────────────────────────────────────────────────

describe('handleTipMessage', { concurrency: true }, () => {
  it('individual mode: returns true, does NOT split', async () => {
    const bot = new MockBot()
    const db = makeTipDb({
      getTipSettings: async () => ({ mode: 'individual', splitMethod: 'hours', bohIncluded: false }),
    })
    const msg = makeMsg('tips were $500 tonight')
    const result = await handleTipMessage(bot, msg, db)
    assert.equal(result, true)
    const text = bot.lastMessage().text
    assert.ok(!text.includes('Marcus'))
  })

  it('cash mode: returns true, saves record, sends log message', async () => {
    const bot = new MockBot()
    let savedRecord = null
    const db = makeTipDb({
      getTipSettings: async () => ({ mode: 'cash', splitMethod: 'hours', bohIncluded: false }),
      saveTipRecord: async (groupId, shiftId, shiftDate, total, splits, method, mode) => {
        savedRecord = { groupId, total, mode }
        return { id: 1 }
      },
    })
    const msg = makeMsg('tips were $500 tonight')
    const result = await handleTipMessage(bot, msg, db)
    assert.equal(result, true)
    assert.ok(savedRecord)
    assert.equal(savedRecord.mode, 'cash')
    assert.ok(bot.lastMessage().text.toLowerCase().includes('logged'))
  })

  it('pool mode: returns true, calculates split, saves', async () => {
    const bot = new MockBot()
    let savedRecord = null
    const db = makeTipDb({
      saveTipRecord: async (groupId, shiftId, shiftDate, total, splits, method, mode) => {
        savedRecord = { total, splits, mode }
        return { id: 1 }
      },
    })
    const msg = makeMsg('tips were $840 tonight')
    const result = await handleTipMessage(bot, msg, db)
    assert.equal(result, true)
    assert.ok(savedRecord)
    assert.equal(savedRecord.mode, 'pool')
    assert.ok(savedRecord.splits.length > 0)
    const text = bot.lastMessage().text
    assert.ok(text.includes('Marcus'))
  })

  it('non-tip message returns false', async () => {
    const bot = new MockBot()
    const db = makeTipDb()
    const msg = makeMsg('can anyone cover Friday')
    const result = await handleTipMessage(bot, msg, db)
    assert.equal(result, false)
  })
})

// ── handleTipModeCommand ──────────────────────────────────────────────────────

describe('handleTipModeCommand', { concurrency: true }, () => {
  it("'/tipmode pool' updates mode", async () => {
    const bot = new MockBot()
    let saved = null
    const db = makeTipDb({
      saveTipSettings: async (gid, s) => { saved = s; return s },
    })
    const msg = makeMsg('/tipmode pool')
    await handleTipModeCommand(bot, msg, ['pool'], db)
    assert.ok(saved)
    assert.equal(saved.mode, 'pool')
  })

  it("'/tipmode hours' updates splitMethod", async () => {
    const bot = new MockBot()
    let saved = null
    const db = makeTipDb({
      saveTipSettings: async (gid, s) => { saved = s; return s },
    })
    const msg = makeMsg('/tipmode hours')
    await handleTipModeCommand(bot, msg, ['hours'], db)
    assert.ok(saved)
    assert.equal(saved.splitMethod, 'hours')
  })

  it("'/tipmode boh on' -> bohIncluded:true", async () => {
    const bot = new MockBot()
    let saved = null
    const db = makeTipDb({
      saveTipSettings: async (gid, s) => { saved = s; return s },
    })
    const msg = makeMsg('/tipmode boh on')
    await handleTipModeCommand(bot, msg, ['boh', 'on'], db)
    assert.ok(saved)
    assert.equal(saved.bohIncluded, true)
  })

  it('empty args -> shows current settings', async () => {
    const bot = new MockBot()
    const db = makeTipDb()
    const msg = makeMsg('/tipmode')
    await handleTipModeCommand(bot, msg, [], db)
    const text = bot.lastMessage().text
    assert.ok(text.toLowerCase().includes('pool') || text.toLowerCase().includes('mode'))
  })

  it('invalid args -> shows usage', async () => {
    const bot = new MockBot()
    const db = makeTipDb()
    const msg = makeMsg('/tipmode bananas')
    await handleTipModeCommand(bot, msg, ['bananas'], db)
    const text = bot.lastMessage().text
    assert.ok(text.toLowerCase().includes('usage') || text.toLowerCase().includes('options'))
  })
})

// ── handleTipHistory ──────────────────────────────────────────────────────────

describe('handleTipHistory', { concurrency: true }, () => {
  it('shows history when records exist', async () => {
    const bot = new MockBot()
    const db = makeTipDb({
      getTipHistory: async () => [
        { shift_date: '2026-04-10', total_tips: 840, split_method: 'hours', splits: [] },
      ],
    })
    const msg = makeMsg('/tips')
    await handleTipHistory(bot, msg, db)
    assert.ok(bot.lastMessage().text.includes('840'))
  })

  it('shows "no records" when empty', async () => {
    const bot = new MockBot()
    const db = makeTipDb({ getTipHistory: async () => [] })
    const msg = makeMsg('/tips')
    await handleTipHistory(bot, msg, db)
    const text = bot.lastMessage().text.toLowerCase()
    assert.ok(text.includes('no') && (text.includes('record') || text.includes('history') || text.includes('tip')))
  })
})
