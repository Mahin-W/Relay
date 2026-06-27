import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { weekdayOf, forecastDay, forecastWeek, staffingHint, forecastWithStaffing } from '../../forecast/forecaster.js'

describe('weekdayOf', () => {
  it('computes weekday names consistently (7 days apart = same weekday)', () => {
    const a = weekdayOf('2026-06-26')
    assert.equal(weekdayOf('2026-06-19'), a)
    assert.equal(weekdayOf('2026-07-03'), a)
    assert.notEqual(weekdayOf('2026-06-25'), a)
  })
  it('returns null for invalid dates', () => {
    assert.equal(weekdayOf('nope'), null)
  })
})

describe('forecastDay', () => {
  // same weekday as target (7-day spacing), plus other-weekday noise
  const history = [
    { date: '2026-06-19', netSalesCents: 100000 },
    { date: '2026-06-12', netSalesCents: 120000 },
    { date: '2026-06-05', netSalesCents: 80000 },
    { date: '2026-05-29', netSalesCents: 60000 },
    { date: '2026-05-22', netSalesCents: 999999 }, // 5th-oldest, excluded at weeks=4
    { date: '2026-06-25', netSalesCents: 500000 }, // different weekday, excluded
    { date: '2026-07-03', netSalesCents: 700000 }, // future, excluded
  ]

  it('averages the most recent N same-weekday entries before the target', () => {
    // weeks=4 → (100000+120000+80000+60000)/4 = 90000
    assert.equal(forecastDay(history, '2026-06-26', { weeks: 4 }), 90000)
  })
  it('honors a smaller weeks window', () => {
    // weeks=2 → (100000+120000)/2 = 110000
    assert.equal(forecastDay(history, '2026-06-26', { weeks: 2 }), 110000)
  })
  it('excludes other weekdays and future dates', () => {
    // 06-25 is the most-recent date overall but a different weekday; 07-03 is
    // future. If either leaked in, the weeks=4 average would change from 90000.
    assert.equal(forecastDay(history, '2026-06-26', { weeks: 4 }), 90000)
  })
  it('returns null when there is no matching history', () => {
    assert.equal(forecastDay([], '2026-06-26'), null)
    assert.equal(forecastDay(history, 'bad-date'), null)
  })
})

describe('forecastWeek', () => {
  it('returns 7 sequential dated entries', () => {
    const week = forecastWeek([], '2026-06-22')
    assert.equal(week.length, 7)
    assert.equal(week[0].date, '2026-06-22')
    assert.equal(week[6].date, '2026-06-28')
    assert.ok(week.every(d => d.dayOfWeek && 'forecastCents' in d))
  })
  it('returns [] for an invalid week start', () => {
    assert.deepEqual(forecastWeek([], 'nope'), [])
  })
})

describe('staffingHint', () => {
  it('divides forecast by sales-per-labor-hour', () => {
    // $1000 forecast (100000c) / $50/hr (5000c) = 20 hrs
    assert.equal(staffingHint(100000, { salesPerLaborHourCents: 5000 }), 20)
  })
  it('returns null without a forecast or ratio', () => {
    assert.equal(staffingHint(0, { salesPerLaborHourCents: 5000 }), null)
    assert.equal(staffingHint(100000, {}), null)
  })
})

describe('forecastWithStaffing', () => {
  it('attaches suggested labor hours per day', () => {
    const history = [
      { date: '2026-06-15', netSalesCents: 100000 }, // Monday-ish anchor
      { date: '2026-06-08', netSalesCents: 100000 },
    ]
    const out = forecastWithStaffing(history, '2026-06-22', { weeks: 4, salesPerLaborHourCents: 5000 })
    assert.equal(out.length, 7)
    const monday = out.find(d => d.date === '2026-06-22')
    assert.equal(monday.forecastCents, 100000)
    assert.equal(monday.suggestedLaborHours, 20)
    // a day with no history forecasts null → null staffing
    const noData = out.find(d => d.forecastCents === null)
    if (noData) assert.equal(noData.suggestedLaborHours, null)
  })
})
