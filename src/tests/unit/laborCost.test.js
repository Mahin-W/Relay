import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot } from '../helpers/mocks.js'
import {
  parseRevenueInput,
  calculateLaborCostPercent,
  formatLaborCostReport,
  formatRevenueHistory,
  handleRevenueInput,
  getRevenueHistory,
} from '../../analytics/laborCost.js'

// ── parseRevenueInput ────────────────────────────────────────────────────────

describe('parseRevenueInput', { concurrency: true }, () => {
  it('"revenue was $14,500" → 14500', () => {
    assert.equal(parseRevenueInput('revenue was $14,500'), 14500)
  })

  it('"revenue was 14500" → 14500', () => {
    assert.equal(parseRevenueInput('revenue was 14500'), 14500)
  })

  it('"sales were $8,750.50" → 8750.50', () => {
    assert.equal(parseRevenueInput('sales were $8,750.50'), 8750.50)
  })

  it('"we did 12k" → 12000', () => {
    assert.equal(parseRevenueInput('we did 12k'), 12000)
  })

  it('"12,500 in sales" → 12500', () => {
    assert.equal(parseRevenueInput('12,500 in sales'), 12500)
  })

  it('"revenue: 9800" → 9800', () => {
    assert.equal(parseRevenueInput('revenue: 9800'), 9800)
  })

  it('"$0" → 0', () => {
    assert.equal(parseRevenueInput('$0'), 0)
  })

  it('"abc" → null', () => {
    assert.equal(parseRevenueInput('abc'), null)
  })

  it('"" → null', () => {
    assert.equal(parseRevenueInput(''), null)
  })

  it('"revenue was great" → null (no number)', () => {
    assert.equal(parseRevenueInput('revenue was great'), null)
  })
})

// ── calculateLaborCostPercent ────────────────────────────────────────────────

describe('calculateLaborCostPercent', { concurrency: true }, () => {
  it('3500/14000 = 25.0% → good', () => {
    const result = calculateLaborCostPercent(3500, 14000)
    assert.equal(result.percent, 25.0)
    assert.equal(result.status, 'good')
  })

  it('2800/12000 = 23.3% → excellent', () => {
    const result = calculateLaborCostPercent(2800, 12000)
    assert.equal(result.percent, 23.3)
    assert.equal(result.status, 'excellent')
  })

  it('4200/12000 = 35.0% → high', () => {
    const result = calculateLaborCostPercent(4200, 12000)
    assert.equal(result.percent, 35.0)
    assert.equal(result.status, 'high')
  })

  it('5000/12000 = 41.7% → critical', () => {
    const result = calculateLaborCostPercent(5000, 12000)
    assert.equal(result.percent, 41.7)
    assert.equal(result.status, 'critical')
  })

  it('revenue 0 → handles gracefully', () => {
    const result = calculateLaborCostPercent(3500, 0)
    assert.ok(result, 'should return an object')
    assert.ok(typeof result.percent === 'number' || result.percent === null)
  })

  it('returns correct emoji for each status', () => {
    const excellent = calculateLaborCostPercent(2000, 10000) // 20%
    assert.match(excellent.label, /🟢/)

    const good = calculateLaborCostPercent(2700, 10000) // 27%
    assert.match(good.label, /🟢/)

    const watch = calculateLaborCostPercent(3200, 10000) // 32%
    assert.match(watch.label, /🟡/)

    const high = calculateLaborCostPercent(3700, 10000) // 37%
    assert.match(high.label, /🔴/)

    const critical = calculateLaborCostPercent(4500, 10000) // 45%
    assert.match(critical.label, /🔴/)
  })
})

// ── formatLaborCostReport ────────────────────────────────────────────────────

describe('formatLaborCostReport', { concurrency: true }, () => {
  const roleBreakdown = [
    { role: 'Server', hours: 40, cost: 600, percent: 17.1 },
    { role: 'Cook', hours: 32, cost: 480, percent: 13.7 },
  ]

  it('contains revenue amount with $', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 1080, 14000, 7.7, 'excellent', roleBreakdown)
    assert.ok(report.includes('$14000') || report.includes('$14,000'))
  })

  it('contains labor cost amount', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 1080, 14000, 7.7, 'excellent', roleBreakdown)
    assert.ok(report.includes('$1080') || report.includes('$1,080'))
  })

  it('contains percent with emoji', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 1080, 14000, 7.7, 'excellent', roleBreakdown)
    assert.ok(report.includes('7.7%'))
  })

  it('contains role breakdown lines', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 1080, 14000, 7.7, 'excellent', roleBreakdown)
    assert.ok(report.includes('Server'))
    assert.ok(report.includes('Cook'))
    assert.ok(report.includes('40hrs'))
    assert.ok(report.includes('32hrs'))
  })

  it('over 35%: contains warning message', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 5500, 14000, 39.3, 'high', roleBreakdown)
    assert.ok(report.includes('⚠️'))
  })

  it('under 35%: no warning message', () => {
    const report = formatLaborCostReport('2026-04-06', 72, 1080, 14000, 7.7, 'excellent', roleBreakdown)
    assert.ok(!report.includes('⚠️'))
  })
})

// ── formatRevenueHistory ─────────────────────────────────────────────────────

describe('formatRevenueHistory', { concurrency: true }, () => {
  it('contains week dates and percentages', () => {
    const history = [
      { weekStart: '2026-04-06', revenue: 14000, totalLaborCost: 3500, laborPercent: 25.0 },
      { weekStart: '2026-03-30', revenue: 12000, totalLaborCost: 3600, laborPercent: 30.0 },
    ]
    const output = formatRevenueHistory(history)
    assert.ok(output.includes('2026-04-06'))
    assert.ok(output.includes('2026-03-30'))
    assert.ok(output.includes('25'))
    assert.ok(output.includes('30'))
  })

  it('shows average, best, worst at bottom', () => {
    const history = [
      { weekStart: '2026-04-06', revenue: 14000, totalLaborCost: 3500, laborPercent: 25.0 },
      { weekStart: '2026-03-30', revenue: 12000, totalLaborCost: 3600, laborPercent: 30.0 },
    ]
    const output = formatRevenueHistory(history)
    assert.ok(output.includes('Average'))
    assert.ok(output.includes('Best'))
    assert.ok(output.includes('Worst'))
  })

  it('empty history → graceful message', () => {
    const output = formatRevenueHistory([])
    assert.ok(output.length > 0, 'should return some message')
    assert.ok(!output.includes('undefined'))
    assert.ok(!output.includes('NaN'))
  })
})

// ── handleRevenueInput ───────────────────────────────────────────────────────

describe('handleRevenueInput', { concurrency: true }, () => {
  it('sends report to manager DM when payroll exists', async () => {
    const bot = new MockBot()
    const msg = {
      chat: { id: '-100999', type: 'group' },
      from: { id: 123, first_name: 'Manager' },
    }
    const mockDb = {
      getPayrollForWeek: async () => [
        {
          staff_name: 'Alice',
          total_hours: 30,
          total_gross_pay: 450,
          shift_breakdown: [{ role: 'Server', hours: 30, gross_pay: 450 }],
        },
        {
          staff_name: 'Bob',
          total_hours: 25,
          total_gross_pay: 375,
          shift_breakdown: [{ role: 'Cook', hours: 25, gross_pay: 375 }],
        },
      ],
      saveWeeklyRevenue: async () => ({}),
      getSetupSession: async () => ({ dm_chat_id: '999', manager_id: 123 }),
    }
    await handleRevenueInput(bot, msg, 14000, mockDb)
    const dmMessages = bot.messagesTo('999')
    assert.ok(dmMessages.length > 0, 'should send DM to manager')
    assert.ok(dmMessages[0].text.includes('Labor Cost Report'))
  })

  it('sends "no payroll yet" when no records', async () => {
    const bot = new MockBot()
    const msg = {
      chat: { id: '-100999', type: 'group' },
      from: { id: 123, first_name: 'Manager' },
    }
    const mockDb = {
      getPayrollForWeek: async () => [],
      getSetupSession: async () => ({ dm_chat_id: '999', manager_id: 123 }),
    }
    await handleRevenueInput(bot, msg, 14000, mockDb)
    const sent = bot.sentMessages
    assert.ok(sent.some(m => m.text.toLowerCase().includes('no payroll')))
  })

  it('saves to DB via saveWeeklyRevenue', async () => {
    const bot = new MockBot()
    const msg = {
      chat: { id: '-100999', type: 'group' },
      from: { id: 123, first_name: 'Manager' },
    }
    let savedData = null
    const mockDb = {
      getPayrollForWeek: async () => [
        {
          staff_name: 'Alice',
          total_hours: 30,
          total_gross_pay: 450,
          shift_breakdown: [{ role: 'Server', hours: 30, gross_pay: 450 }],
        },
      ],
      saveWeeklyRevenue: async (groupId, weekStart, revenue, totalLaborCost, laborPercent) => {
        savedData = { groupId, weekStart, revenue, totalLaborCost, laborPercent }
      },
      getSetupSession: async () => ({ dm_chat_id: '999', manager_id: 123 }),
    }
    await handleRevenueInput(bot, msg, 14000, mockDb)
    assert.ok(savedData, 'saveWeeklyRevenue should have been called')
    assert.equal(savedData.revenue, 14000)
    assert.equal(savedData.groupId, '-100999')
  })
})

// ── getRevenueHistory ────────────────────────────────────────────────────────

describe('getRevenueHistory', () => {
  it('returns correct ordered array from mock', async () => {
    const mockDb = {
      getRevenueHistory: async (groupId, weeksBack) => [
        { weekStart: '2026-04-06', revenue: 14000, totalLaborCost: 3500, laborPercent: 25.0 },
        { weekStart: '2026-03-30', revenue: 12000, totalLaborCost: 3600, laborPercent: 30.0 },
      ],
    }
    const history = await getRevenueHistory('-100999', 8, mockDb)
    assert.equal(history.length, 2)
    assert.equal(history[0].weekStart, '2026-04-06')
    assert.equal(history[1].weekStart, '2026-03-30')
  })
})
