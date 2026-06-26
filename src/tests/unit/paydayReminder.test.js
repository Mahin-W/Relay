import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRemindPayday, runPaydayReminder } from '../../payroll/paydayReminder.js'

describe('shouldRemindPayday', () => {
  it('reminds on payday', () => {
    assert.equal(shouldRemindPayday('2026-06-26', '2026-06-26'), true)
  })
  it('does not remind on a non-payday', () => {
    assert.equal(shouldRemindPayday('2026-06-25', '2026-06-26'), false)
  })
  it('does not remind if already sent', () => {
    assert.equal(shouldRemindPayday('2026-06-26', '2026-06-26', { alreadySent: true }), false)
  })
  it('supports leadDays (remind the day before)', () => {
    assert.equal(shouldRemindPayday('2026-06-25', '2026-06-26', { leadDays: 1 }), true)
    assert.equal(shouldRemindPayday('2026-06-26', '2026-06-26', { leadDays: 1 }), false)
  })
  it('returns false on missing/invalid dates', () => {
    assert.equal(shouldRemindPayday(null, '2026-06-26'), false)
    assert.equal(shouldRemindPayday('not-a-date', '2026-06-26'), false)
  })
})

describe('runPaydayReminder', () => {
  it('notifies the owner on payday', async () => {
    const sent = []
    const r = await runPaydayReminder(
      { ownerDm: '12345', today: '2026-06-26', payday: '2026-06-26' },
      { send: async (to, msg) => sent.push({ to, msg }) },
    )
    assert.equal(r.reminded, true)
    assert.equal(sent[0].to, '12345')
    assert.match(sent[0].msg, /Payday is 2026-06-26/)
    assert.match(sent[0].msg, /\/paypeople/)
  })

  it('does nothing on a non-payday', async () => {
    const sent = []
    const r = await runPaydayReminder(
      { ownerDm: '12345', today: '2026-06-20', payday: '2026-06-26' },
      { send: async (...a) => sent.push(a) },
    )
    assert.equal(r.reminded, false)
    assert.equal(sent.length, 0)
  })
})
