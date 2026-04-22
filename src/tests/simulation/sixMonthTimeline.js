// 26-week timeline for Mesa Verde Kitchen — Feb 3 to Aug 3, 2025.
// Combines routine events (auto-generated from patterns) with drama events
// (hand-coded lifecycle + seasonal moments).

import { STAFF, SHIFTS, WEEK_STARTS, GROUP_ID, GROUP_CHAT_ID, MANAGER_ID, MANAGER_DM } from './mesaVerdeSeed.js'
import { dayName, addDays, addHours, weekStartOf } from './sixMonthEngine.js'

// All 26 week-starts (Mondays) from 2025-02-03 to 2025-07-28.
export function allWeekStarts() {
  const out = []
  let d = new Date('2025-02-03T00:00:00Z')
  for (let i = 0; i < 26; i++) {
    out.push(d.toISOString().slice(0, 10))
    d = addDays(d, 7)
  }
  return out
}

// ── Routine: each week follows a pattern ──────────────────────────────────
// Sunday 8pm: /availability dispatch
// Mon 9am-6pm: staff reply
// Tue 9am: /makeschedule
// Tue 10am: approve
// Tue-Sun: daily shifts + clock-ins/outs
// Sunday 11pm: tips entered

export function routineWeekEvents(weekStart, roster, opts = {}) {
  const events = []
  const sunBefore = addDays(new Date(weekStart), -1)
  sunBefore.setUTCHours(20, 0, 0, 0)

  // Availability dispatch (Sunday 8pm)
  events.push({ at: sunBefore, kind: 'availability_dispatch', weekStart })

  // Staff respond Monday 9am-6pm — stagger across hours
  const mon = new Date(weekStart)
  mon.setUTCHours(9, 0, 0, 0)
  roster.forEach((s, i) => {
    if (!s.dm_chat_id) return   // Carlos has no DM — skip
    const at = addHours(mon, i % 9)
    events.push({
      at,
      kind: 'availability_reply',
      staffId: s.id,
      text: defaultAvailText(s),
      weekStart,
    })
  })

  // Tuesday 9am: /makeschedule
  const tue = addDays(new Date(weekStart), 1)
  tue.setUTCHours(9, 0, 0, 0)
  events.push({ at: tue, kind: 'makeschedule', weekStart })

  // Tuesday 10am: approve + publish
  events.push({ at: addHours(tue, 1), kind: 'publish_schedule', weekStart })

  // Daily shifts Mon-Sun — clock-ins/outs at shift boundaries for each scheduled assignment
  for (let d = 0; d < 7; d++) {
    const day = addDays(new Date(weekStart), d)
    events.push({ at: addHoursT(day, 9), kind: 'daily_shifts_start', date: day, weekStart })
    events.push({ at: addHoursT(day, 23, 30), kind: 'daily_shifts_end', date: day, weekStart })
  }

  // Sunday 11:30pm: tips + revenue for the week
  const sun = addDays(new Date(weekStart), 6)
  sun.setUTCHours(23, 30, 0, 0)
  events.push({ at: sun, kind: 'weekly_tips_revenue', weekStart })

  return events
}

function addHoursT(date, h, m = 0) {
  const x = new Date(date)
  x.setUTCHours(h, m, 0, 0)
  return x
}

function defaultAvailText(staff) {
  // Most staff say "all" — deviations create scheduling friction for the sim.
  if (staff.name === 'Jake') return '4 5 6'
  if (staff.name === 'Carmen') return '1 2 3 4 5'
  if (staff.name === 'Rosa') return '3 6'
  if (staff.name === 'Tiffany') return 'tue wed thu dinner'
  return 'all'
}

// ── Drama events — spread across 6 months ─────────────────────────────────

export function dramaEvents() {
  const ev = []
  // Month 1 (Feb): baseline
  ev.push({ at: d('2025-02-05T16:15:00Z'), kind: 'callout', staffName: 'Devon', reason: 'car trouble', shiftDay: 'Wednesday', shiftName: 'Mon-Fri Dinner' })
  ev.push({ at: d('2025-02-05T17:10:00Z'), kind: 'coverage_accept', staffName: 'Sam' })
  ev.push({ at: d('2025-02-06T12:00:00Z'), kind: 'recognition', from: 'Aaliyah', text: 'shoutout to Sam, he killed it last night!' })
  ev.push({ at: d('2025-02-06T14:00:00Z'), kind: 'time_off_request', staffName: 'Emma', date: '2025-02-08', reason: 'family thing' })
  ev.push({ at: d('2025-02-06T16:00:00Z'), kind: 'time_off_decision', staffName: 'Emma', decision: 'approve' })
  ev.push({ at: d('2025-02-08T20:30:00Z'), kind: 'demand_signal_group', from: 'Priya', text: 'we\'re gonna be packed tonight' })

  // Month 2 (Mar): cross-training + turnover risk
  ev.push({ at: d('2025-03-03T10:00:00Z'), kind: 'cross_training_add', staffName: 'Mike', role: 'Cook', proficiency: 'training' })
  ev.push({ at: d('2025-03-05T16:00:00Z'), kind: 'callout', staffName: 'Devon', reason: 'sick', shiftDay: 'Wednesday', shiftName: 'Mon-Fri Dinner' })
  ev.push({ at: d('2025-03-07T09:00:00Z'), kind: 'rate_change', staffName: 'Sam', newRate: 21 }) // Fix Sam's rate
  ev.push({ at: d('2025-03-12T16:00:00Z'), kind: 'callout', staffName: 'Devon', reason: 'hangover ("sick")', shiftDay: 'Wednesday', shiftName: 'Mon-Fri Dinner' })
  ev.push({ at: d('2025-03-14T19:00:00Z'), kind: 'group_msg', from: 'Jake', text: 'valentine vibes wearing off lol' })
  ev.push({ at: d('2025-03-17T18:00:00Z'), kind: 'demand_signal_group', from: 'Marcus', text: 'St Patrick\'s crowd tonight — packed' })
  ev.push({ at: d('2025-03-23T10:00:00Z'), kind: 'business_rule_add', rule: { type: 'day_off', subjectName: 'Devon', dayOfWeek: 'Wednesday', text: 'Devon no Wednesdays' } })

  // Month 3 (Apr): Emma actually quits
  ev.push({ at: d('2025-04-02T14:00:00Z'), kind: 'dm_from_staff', staffName: 'Emma', text: 'I think I need to put in my two weeks', expectedEffect: 'resignation_flagged' })
  ev.push({ at: d('2025-04-02T15:00:00Z'), kind: 'manager_dm', text: 'tell Emma I\'ll call her today' })
  ev.push({ at: d('2025-04-16T10:00:00Z'), kind: 'remove_staff', staffName: 'Emma', reason: 'resigned' })
  ev.push({ at: d('2025-04-16T11:00:00Z'), kind: 'hire_staff', newStaff: { id: 3001, name: 'Morgan', role: 'Server', hourlyRate: 14, dm_chat_id: 3001, user_id: 3001 } })
  ev.push({ at: d('2025-04-20T14:00:00Z'), kind: 'recognition', from: 'Manager', text: 'shoutout to the whole kitchen crew for handling the Easter rush!' })

  // Month 4 (May): Carmen pregnancy leave, seasonal uptick
  ev.push({ at: d('2025-05-02T09:00:00Z'), kind: 'dm_from_staff', staffName: 'Carmen', text: 'hey I\'ll need about 6 weeks off starting May 19 for maternity' })
  ev.push({ at: d('2025-05-05T10:00:00Z'), kind: 'manager_dm', text: 'approve Carmen maternity leave May 19 to June 30' })
  ev.push({ at: d('2025-05-11T19:00:00Z'), kind: 'demand_signal_group', from: 'Priya', text: 'Mother\'s Day brunch was our biggest ever' })
  ev.push({ at: d('2025-05-19T09:00:00Z'), kind: 'absence_window_start', staffName: 'Carmen', until: '2025-06-30' })
  ev.push({ at: d('2025-05-20T10:00:00Z'), kind: 'hire_staff', newStaff: { id: 3002, name: 'Olivia', role: 'Server', hourlyRate: 14, dm_chat_id: 3002, user_id: 3002 } })
  ev.push({ at: d('2025-05-26T19:00:00Z'), kind: 'demand_signal_group', from: 'Manager', text: 'Memorial Day — expect patio to be slammed' })

  // Month 5 (Jun): Jaylen turns 18, wants more hours
  ev.push({ at: d('2025-06-01T09:00:00Z'), kind: 'age_update', staffName: 'Jaylen', newAge: 18 })
  ev.push({ at: d('2025-06-01T09:30:00Z'), kind: 'dm_from_staff', staffName: 'Jaylen', text: 'hey I\'m 18 now, can I pick up more late shifts' })
  ev.push({ at: d('2025-06-02T10:00:00Z'), kind: 'constraint_remove', staffName: 'Jaylen', type: 'time_constraint', reason: 'turned 18' })
  ev.push({ at: d('2025-06-07T11:00:00Z'), kind: 'trade_request', from: 'Tiffany', text: 'I\'ll take someone\'s Monday lunch if they take my Thursday dinner' })
  ev.push({ at: d('2025-06-07T14:00:00Z'), kind: 'trade_offer', from: 'Carmen', text: 'I\'ll do Thursday dinner if Tiffany takes my Monday', expectedOutcome: 'rejected_recurring_constraint' })
  ev.push({ at: d('2025-06-15T20:30:00Z'), kind: 'demand_signal_group', from: 'Priya', text: 'Father\'s Day — full house all night' })
  ev.push({ at: d('2025-06-20T16:00:00Z'), kind: 'callout', staffName: 'Sam', reason: 'flu', shiftDay: 'Friday', shiftName: 'Mon-Fri Dinner' })
  ev.push({ at: d('2025-06-30T09:00:00Z'), kind: 'absence_window_end', staffName: 'Carmen' }) // back from leave

  // Month 6 (Jul): summer peak + Sam leaves + new hire
  ev.push({ at: d('2025-07-03T18:00:00Z'), kind: 'demand_signal_group', from: 'Marcus', text: 'July 4 pre-game busy' })
  ev.push({ at: d('2025-07-04T20:00:00Z'), kind: 'demand_signal_group', from: 'Aaliyah', text: '4th of July absolutely slammed tonight' })
  ev.push({ at: d('2025-07-07T10:00:00Z'), kind: 'dm_from_staff', staffName: 'Sam', text: 'Tony, I got an offer at another spot. Putting in my two weeks' })
  ev.push({ at: d('2025-07-07T11:00:00Z'), kind: 'hire_staff', newStaff: { id: 3003, name: 'Aisha', role: 'Chef', hourlyRate: 22, dm_chat_id: 3003, user_id: 3003 } })
  ev.push({ at: d('2025-07-14T15:00:00Z'), kind: 'recognition', from: 'Tony', text: 'Aisha killed it in the kitchen tonight — smooth transition' })
  ev.push({ at: d('2025-07-21T10:00:00Z'), kind: 'remove_staff', staffName: 'Sam', reason: 'resigned (two weeks up)' })
  ev.push({ at: d('2025-07-28T19:00:00Z'), kind: 'group_msg', from: 'Aaliyah', text: 'best summer crew ever' })

  // Scattered background callouts + realistic friction every couple of weeks
  const backgroundCallouts = [
    ['2025-02-25T15:00:00Z', 'Sarah', 'Tuesday', 'Mon-Fri Dinner'],
    ['2025-03-18T15:30:00Z', 'Mike', 'Tuesday', 'Mon-Fri Lunch'],
    ['2025-04-08T16:00:00Z', 'Jordan', 'Tuesday', 'Mon-Fri Dinner'],
    ['2025-04-30T15:00:00Z', 'Sarah', 'Wednesday', 'Mon-Fri Dinner'],
    ['2025-05-13T16:00:00Z', 'Priya', 'Tuesday', 'Mon-Fri Dinner'],
    ['2025-06-10T16:00:00Z', 'Rosa', 'Tuesday', 'Mon-Fri Lunch'],
    ['2025-07-15T16:00:00Z', 'Jaylen', 'Tuesday', 'Mon-Fri Dinner'],
  ]
  for (const [ts, name, day, shift] of backgroundCallouts) {
    ev.push({ at: d(ts), kind: 'callout', staffName: name, reason: 'background', shiftDay: day, shiftName: shift })
  }

  // Monthly manager log entries
  for (const [ts, note] of [
    ['2025-02-15T23:00:00Z', 'Busy Sat — crew handled it well'],
    ['2025-03-15T23:00:00Z', 'Devon unreliable. New rule helping.'],
    ['2025-04-16T23:00:00Z', 'Emma out, Morgan trained in. Team morale recovering.'],
    ['2025-05-11T23:00:00Z', 'Record Mother\'s Day revenue.'],
    ['2025-06-20T23:00:00Z', 'Sam out, Aisha stepping up.'],
    ['2025-07-28T23:00:00Z', 'Best summer in 3 years.'],
  ]) {
    ev.push({ at: d(ts), kind: 'manager_log', text: note })
  }

  return ev
}

function d(s) { return new Date(s) }

// Build the complete 6-month timeline.
export function buildFullTimeline({ db }) {
  const events = []
  const weekStarts = allWeekStarts()

  // Seed initial roster (active staff with dm_chat_id)
  for (const ws of weekStarts) {
    // Roster at time of this week is dynamic — we'll pick roster at event-dispatch
    // time from db.staff, but for routine scheduling we use the initial STAFF.
    const roster = STAFF.filter(s => s.active !== false)
    events.push(...routineWeekEvents(ws, roster))
  }

  events.push(...dramaEvents())
  events.sort((a, b) => a.at.getTime() - b.at.getTime())
  return events
}

// Stagger helper for makeschedule etc.
export function stagger(events, seedHour = 9) {
  // nothing — caller can use this as a hook
  return events
}
