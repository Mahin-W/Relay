import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkMinorShift, ageFromDob, bandForAge } from '../../compliance/minorLabor.js'
import { resolveRuleset } from '../../compliance/complianceProfiles.js'

const CA = resolveRuleset('CA')
const FED = resolveRuleset(null)
const codes = (r) => r.violations.map(v => v.code)

describe('ageFromDob / bandForAge', () => {
  it('computes whole-year age', () => {
    assert.equal(ageFromDob('2008-06-26', new Date('2026-06-26')), 18)
    assert.equal(ageFromDob('2009-01-01', new Date('2026-06-26')), 17)
  })
  it('has not had this year\'s birthday yet', () => {
    assert.equal(ageFromDob('2009-12-31', new Date('2026-06-26')), 16)
  })
  it('maps ages to bands', () => {
    assert.equal(bandForAge(15), '14')
    assert.equal(bandForAge(16), '16')
    assert.equal(bandForAge(17), '16')
    assert.equal(bandForAge(18), null)
    assert.equal(bandForAge(13), null)
  })
})

describe('checkMinorShift — adults & under-age', () => {
  it('adults are unrestricted', () => {
    const r = checkMinorShift({ age: 20, start: '00:00', end: '08:00', day: 'monday' }, CA)
    assert.equal(r.allowed, true)
    assert.equal(r.isMinor, false)
    assert.equal(r.violations.length, 0)
  })
  it('under 14 cannot be scheduled at all', () => {
    const r = checkMinorShift({ age: 13, start: '10:00', end: '13:00', day: 'saturday' }, CA)
    assert.equal(r.allowed, false)
    assert.deepEqual(codes(r), ['under_minimum_age'])
  })
  it('unknown age is treated as adult (no DOB on file)', () => {
    const r = checkMinorShift({ start: '20:00', end: '23:00', day: 'monday' }, CA)
    assert.equal(r.allowed, true)
    assert.equal(r.isMinor, false)
  })
})

describe('checkMinorShift — 16/17 on a school night (CA)', () => {
  it('flags too-late end and over-daily-max on a Monday', () => {
    const r = checkMinorShift({ age: 17, start: '16:00', end: '23:00', day: 'monday' }, CA)
    assert.equal(r.allowed, false)
    assert.equal(r.hours, 7)
    assert.ok(codes(r).includes('after_latest'))
    assert.ok(codes(r).includes('over_daily_max'))
    assert.match(r.violations.find(v => v.code === 'after_latest').message, /school night/)
  })

  it('a Saturday non-school shift within limits is allowed', () => {
    const r = checkMinorShift({ age: 17, start: '10:00', end: '18:00', day: 'saturday' }, CA)
    assert.equal(r.allowed, true)
    assert.equal(r.violations.length, 0)
  })

  it('summer (school not in session) relaxes the late-night limit', () => {
    const r = checkMinorShift({ age: 17, start: '16:00', end: '23:30', day: 'monday', schoolInSession: false }, CA)
    assert.equal(r.allowed, true) // latestNonSchool 00:30 + maxDailyNonSchool 8h
  })
})

describe('checkMinorShift — 14/15 federal', () => {
  it('blocks a 5h Wednesday shift ending at 8pm in the school year', () => {
    const r = checkMinorShift({ age: 15, start: '15:00', end: '20:00', day: 'wednesday' }, FED)
    assert.equal(r.allowed, false)
    assert.ok(codes(r).includes('after_latest'))   // latest 19:00 on school night
    assert.ok(codes(r).includes('over_daily_max'))  // max 3h on a school day
  })
})

describe('checkMinorShift — weekly cap', () => {
  it('flags exceeding the school-week maximum', () => {
    // Sunday: school night but not a school day, so the 6h passes the daily cap;
    // 45 + 6 = 51 > 48 weekly school max.
    const r = checkMinorShift(
      { age: 16, start: '10:00', end: '16:00', day: 'sunday', weeklyHoursSoFar: 45 },
      CA,
    )
    assert.deepEqual(codes(r), ['over_weekly_max'])
    assert.equal(r.allowed, false)
  })
})

describe('checkMinorShift — overnight handling', () => {
  it('treats an end <= start as crossing midnight', () => {
    const r = checkMinorShift({ age: 17, start: '20:00', end: '02:00', day: 'friday' }, CA)
    assert.equal(r.hours, 6)
  })
})
