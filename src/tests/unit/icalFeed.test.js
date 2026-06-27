import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildIcsFeed } from '../../integrations/calendar/icalFeed.js'

describe('buildIcsFeed', () => {
  const shifts = [
    { date: '2026-06-22', start: '09:00', end: '17:00', name: 'Monday Lunch' },
    { date: '2026-06-23', start: '17:00', end: '23:00', name: 'Tuesday Dinner' },
  ]

  it('wraps events in a VCALENDAR', () => {
    const ics = buildIcsFeed('Maria', shifts)
    assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
    assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'))
    assert.match(ics, /VERSION:2\.0/)
  })

  it('emits one VEVENT per shift with DTSTART/DTEND/SUMMARY', () => {
    const ics = buildIcsFeed('Maria', shifts)
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2)
    assert.equal((ics.match(/END:VEVENT/g) || []).length, 2)
    assert.match(ics, /DTSTART:20260622T090000Z/)
    assert.match(ics, /DTEND:20260622T170000Z/)
    assert.match(ics, /SUMMARY:Monday Lunch/)
  })

  it('uses CRLF line endings', () => {
    assert.ok(buildIcsFeed('M', shifts).includes('\r\n'))
  })

  it('escapes commas/semicolons in text', () => {
    const ics = buildIcsFeed('M', [{ date: '2026-06-22', start: '09:00', end: '10:00', name: 'Prep, clean; open' }])
    assert.match(ics, /SUMMARY:Prep\\, clean\\; open/)
  })

  it('skips shifts with an invalid date but stays valid', () => {
    const ics = buildIcsFeed('M', [{ date: 'bad', name: 'x' }, shifts[0]])
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1)
    assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
  })

  it('handles an empty schedule', () => {
    const ics = buildIcsFeed('M', [])
    assert.ok(ics.includes('BEGIN:VCALENDAR'))
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0)
  })
})
