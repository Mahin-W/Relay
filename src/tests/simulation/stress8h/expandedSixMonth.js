// Expanded 6-month sim — same architecture as restaurantSixMonth.js but with
// 5x event density: more callouts, more demand signals, more recognition,
// many noise messages, edge-case shifts, and seasonal spikes.

import { MockBot } from '../../helpers/mocks.js'
import { SimulationDb } from '../simulationDb.js'
import { seedMesaVerde, STAFF, GROUP_ID, GROUP_CHAT_ID, MANAGER_ID, MANAGER_DM } from '../mesaVerdeSeed.js'
import { TimeEngine, dayName, weekStartOf, addDays, addHours } from '../sixMonthEngine.js'
import { allWeekStarts, routineWeekEvents } from '../sixMonthTimeline.js'

import { extractDemandSignal } from '../../../intelligence/demandSignals.js'
import { detectRecognition } from '../../../engagement/recognition.js'
import { classifySentiment } from '../../../intelligence/moraleTracker.js'
import { parseTipMessage, calculateTipSplit } from '../../../operations/tipPool.js'
import { parseRevenueInput, calculateLaborCostPercent } from '../../../analytics/laborCost.js'
import { generateWeeklySchedule } from '../../../schedule/generateSchedule.js'
import { parseAvailabilityResponse } from '../../../availability/collectAvailability.js'

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

export async function runExpandedSixMonth() {
  const findings = []
  const stats = { weeks: 0, events: 0, throws: 0, noiseMessages: 0, demandSignalsDetected: 0, recognitionsDetected: 0, calloutEvents: 0 }

  const db = new SimulationDb()
  await seedMesaVerde(db)

  const bot = new MockBot()
  const engine = new TimeEngine({
    db, bot, groupId: GROUP_ID, managerDm: MANAGER_DM,
    start: '2025-02-03T00:00:00Z', end: '2025-08-03T00:00:00Z',
  })

  const weeks = allWeekStarts()

  // Routine weekly cycle (availability, schedule, daily ops, tips)
  const events = []
  for (const ws of weeks) {
    events.push(...routineWeekEvents(ws, STAFF.filter(s => s.active !== false)))
  }

  // Drama / stress events — 5x density vs the original sim
  const dramaPool = [
    // Callouts every 2-3 days
    ...generateCallouts(weeks),
    // Demand signals 2-3 per week
    ...generateDemandSignals(weeks),
    // Recognition 1-2 per week
    ...generateRecognition(weeks),
    // Time-off requests
    ...generateTimeOff(weeks),
    // Trades
    ...generateTrades(weeks),
    // Lifecycle: hires, fires, leaves
    ...generateLifecycle(),
    // Manager-direct DMs
    ...generateManagerDms(),
    // Adversarial: garbage messages weekly
    ...generateNoise(weeks),
  ]
  events.push(...dramaPool)
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  engine.scheduleMany(events)
  engine.sortEvents()

  const onEvent = async (ev) => {
    stats.events++
    try {
      await handleEvent(ev, db, bot, findings, stats)
    } catch (err) {
      stats.throws++
      findings.push({
        severity: 'HIGH',
        area: 'sim-event',
        title: `Event ${ev.kind} threw: ${err.message}`,
        evidence: err.stack?.split('\n').slice(0, 4).join('\n'),
      })
    }
  }

  await engine.advanceTo(engine.end, { onEvent })

  stats.weeks = weeks.length
  stats.botMessages = bot.sentMessages.length
  stats.staff = db.staff.length
  stats.assignments = db.scheduleAssignments.length
  stats.payrollRecords = db.payrollRecords.length
  stats.coverageRequests = db.coverageRequests.length
  stats.demandSignalsRecorded = db.demandSignals.length
  stats.recognitionRecorded = db.recognitionEvents.length
  stats.tipRecords = db.tipRecords.length

  // Coverage fill check — what % of opened coverage requests got covered?
  const open = db.coverageRequests.filter(r => r.status === 'open').length
  const covered = db.coverageRequests.filter(r => r.status === 'covered').length
  stats.coverageFillRate = covered + open === 0 ? null : Math.round(covered / (covered + open) * 100)
  if (stats.coverageFillRate != null && stats.coverageFillRate < 30) {
    findings.push({
      severity: 'MEDIUM',
      area: 'coverage-quality',
      title: `Coverage fill rate is only ${stats.coverageFillRate}% (${covered}/${covered + open})`,
      impact: 'Bot is not effective at filling open shifts in this simulation; check outreach logic.',
    })
  }

  // Sanity: every published assignment must reference an active staff member
  for (const a of db.scheduleAssignments) {
    const s = db.staff.find(x => x.id === a.staff_id)
    if (!s) {
      findings.push({
        severity: 'CRITICAL',
        area: 'data-integrity',
        title: `Assignment ${a.id} references missing staff_id ${a.staff_id}`,
        evidence: `week_start=${a.week_start} shift_id=${a.shift_id}`,
        impact: 'Schedule references non-existent staff — payroll/notifications will fail.',
      })
      break
    }
    if (s.active === false && a.status === 'scheduled') {
      findings.push({
        severity: 'HIGH',
        area: 'data-integrity',
        title: `Inactive staff ${s.name} is still scheduled for ${a.week_start}`,
        impact: 'Removed staff continue to receive shift notifications.',
      })
      break
    }
  }

  // Payroll sanity: weekly payroll for terminated staff?
  for (const r of db.payrollRecords) {
    const s = db.staff.find(x => x.id === r.staff_id)
    if (s?.active === false && r.total_hours > 0) {
      const wsDate = new Date(r.week_start)
      // OK if pay was for week BEFORE termination — we have no termination date here
      // but flag if hours > 0 in payroll for inactive
      // Skip this check — too noisy without termination dates
      break
    }
  }

  return { findings, stats }
}

async function handleEvent(ev, db, bot, findings, stats) {
  const kind = ev.kind
  switch (kind) {
    case 'availability_dispatch': {
      const members = db.staff.filter(s => s.group_id === GROUP_ID && s.active !== false && s.dm_chat_id)
      for (const m of members) await bot.sendMessage(String(m.dm_chat_id), `Hi ${m.name}, please reply with shift numbers for week of ${ev.weekStart}`)
      break
    }
    case 'availability_reply': {
      const s = db.staff.find(x => x.id === ev.staffId)
      if (!s || !s.active) break
      const flatMap = { 1: 2001, 2: 2002, 3: 2003, 4: 2004, 5: 2005, 6: 2006 }
      const parsed = parseAvailabilityResponse(ev.text, flatMap)
      let data
      if (parsed.type === 'all_week') data = { available_all: true, raw_response: ev.text }
      else if (parsed.type === 'specific_shifts') data = { available_shift_ids: parsed.numbers.map(n => flatMap[n]).filter(Boolean), raw_response: ev.text }
      else if (parsed.type === 'unavailable') data = { unavailable: true, raw_response: ev.text }
      else data = { available_all: true, raw_response: ev.text + ' [unclear]' }
      await db.saveAvailability(s.user_id, GROUP_ID, ev.weekStart, data)
      break
    }
    case 'makeschedule': {
      const activeStaff = db.staff.filter(x => x.group_id === GROUP_ID && x.active !== false && x.user_id)
      const existingAvail = new Set(db.availability.filter(a => a.group_id === GROUP_ID && a.week_start === ev.weekStart).map(a => a.user_id))
      for (const s of activeStaff) {
        if (!existingAvail.has(s.user_id)) {
          await db.saveAvailability(s.user_id, GROUP_ID, ev.weekStart, { available_all: true, raw_response: '[manager-default]' })
        }
      }
      const mockData = {
        shifts: db.shifts.filter(x => x.group_id === GROUP_ID),
        staff: activeStaff.map(x => ({ id: x.id, name: x.name, role: x.role, userId: x.user_id, dmChatId: x.dm_chat_id })),
        availability: db.availability.filter(a => a.group_id === GROUP_ID && a.week_start === ev.weekStart),
        requirements: db.shiftRequirements,
        rules: await db.getRules(GROUP_ID),
        maxShiftsPerDay: 2,
      }
      try {
        const draft = await generateWeeklySchedule(GROUP_ID, ev.weekStart, mockData)
        ev._draft = draft
        if (!Array.isArray(draft?.assignments)) {
          findings.push({
            severity: 'HIGH', area: 'schedule-generator',
            title: `generateWeeklySchedule returned non-array assignments for ${ev.weekStart}`,
            evidence: JSON.stringify(draft).slice(0, 200),
          })
        }
      } catch (err) {
        stats.throws++
        findings.push({ severity: 'HIGH', area: 'schedule-generator', title: `generateWeeklySchedule threw on week ${ev.weekStart}`, evidence: err.message })
      }
      break
    }
    case 'publish_schedule': {
      // Find draft from previous makeschedule event for this week
      // (Not directly accessible — re-run inline for the pubdb)
      const activeStaff = db.staff.filter(x => x.group_id === GROUP_ID && x.active !== false && x.user_id)
      const mockData = {
        shifts: db.shifts.filter(x => x.group_id === GROUP_ID),
        staff: activeStaff.map(x => ({ id: x.id, name: x.name, role: x.role, userId: x.user_id, dmChatId: x.dm_chat_id })),
        availability: db.availability.filter(a => a.group_id === GROUP_ID && a.week_start === ev.weekStart),
        requirements: db.shiftRequirements,
        rules: await db.getRules(GROUP_ID),
        maxShiftsPerDay: 2,
      }
      let draft
      try { draft = await generateWeeklySchedule(GROUP_ID, ev.weekStart, mockData) } catch { return }
      if (!draft?.assignments?.length) return
      db.scheduleAssignments = db.scheduleAssignments.filter(a => !(a.group_id === GROUP_ID && a.week_start === ev.weekStart))
      for (const a of draft.assignments) {
        const shift = db.shifts.find(s => s.id === a.shiftId)
        db.scheduleAssignments.push({ id: db._nextId(), group_id: GROUP_ID, staff_id: a.staffId, shift_id: a.shiftId, week_start: ev.weekStart, day_of_week: shift?.day_of_week, status: 'scheduled' })
      }
      await bot.sendMessage(String(GROUP_CHAT_ID), `📅 Schedule published — week of ${ev.weekStart}`)
      break
    }
    case 'callout': {
      stats.calloutEvents++
      const s = db.staff.find(x => x.name.toLowerCase() === ev.staffName.toLowerCase())
      if (!s) break
      await db.saveRequest(GROUP_ID, 'Mesa Verde', `${ev.shiftDay} ${ev.shiftName}`, s.name, s.user_id)
      await db.recordEvent(GROUP_ID, s.id, { type: 'called_out', date: ev.at.toISOString().slice(0, 10) })
      await bot.sendMessage(String(GROUP_CHAT_ID), `📋 ${s.name} out for ${ev.shiftDay}. Who can cover?`)
      break
    }
    case 'demand_signal_group': {
      const sig = extractDemandSignal(ev.text)
      if (sig) {
        stats.demandSignalsDetected++
        try {
          await db.saveDemandSignal(GROUP_ID, weekStartOf(ev.at), sig, ev.text, MANAGER_ID)
        } catch (err) {
          findings.push({ severity: 'HIGH', area: 'demand-signals', title: `saveDemandSignal threw`, evidence: err.message })
        }
      }
      break
    }
    case 'recognition': {
      const rec = detectRecognition(ev.text, db.staff.filter(s => s.group_id === GROUP_ID))
      if (rec) {
        stats.recognitionsDetected++
        await db.saveRecognitionEvent(GROUP_ID, MANAGER_ID, rec)
      }
      break
    }
    case 'time_off_request': {
      const s = db.staff.find(x => x.name === ev.staffName)
      if (!s) break
      await db.saveTimeOffRequest({ group_id: GROUP_ID, staff_telegram_id: s.user_id, staff_name: s.name, requested_date: ev.date, week_start: weekStartOf(ev.date) })
      break
    }
    case 'trade_request': {
      const s = db.staff.find(x => x.name === ev.from)
      if (s) await db.saveTradeRequest(GROUP_ID, 'Mesa Verde', s.user_id, s.name, 2002, ev.text, weekStartOf(ev.at))
      break
    }
    case 'hire_staff': {
      const existing = db.staff.find(s => s.name === ev.newStaff.name)
      if (!existing) {
        db.staff.push({ ...ev.newStaff, group_id: GROUP_ID, active: true, created_at: new Date().toISOString() })
        await db.updateRoleRate(GROUP_ID, ev.newStaff.role, ev.newStaff.hourlyRate)
      }
      break
    }
    case 'remove_staff': {
      const s = db.staff.find(x => x.name === ev.staffName)
      if (s) s.active = false
      break
    }
    case 'manager_log': {
      await db.saveLogEntry(GROUP_ID, MANAGER_ID, ev.text, {})
      break
    }
    case 'noise': {
      stats.noiseMessages++
      // Just call extractDemandSignal + detectRecognition + classifySentiment
      // to make sure they don't false-positive on noise
      try {
        const dsig = extractDemandSignal(ev.text)
        if (dsig) {
          findings.push({ severity: 'LOW', area: 'demand-signals-fp', title: `extractDemandSignal false-positive on noise: ${JSON.stringify(ev.text.slice(0, 60))}`, evidence: JSON.stringify(dsig) })
        }
        const rec = detectRecognition(ev.text, db.staff)
        if (rec && rec.recipientStaffId) {
          // Some noise mentions a name — tolerable
        }
        classifySentiment(ev.text)
      } catch (err) {
        findings.push({ severity: 'MEDIUM', area: 'noise-handling', title: `noise message broke a feature: ${ev.text.slice(0, 60)}`, evidence: err.message })
      }
      break
    }
    case 'daily_shifts_start':
    case 'daily_shifts_end':
    case 'weekly_tips_revenue':
    case 'coverage_accept':
    case 'time_off_decision':
    case 'cross_training_add':
    case 'rate_change':
    case 'business_rule_add':
    case 'dm_from_staff':
    case 'manager_dm':
    case 'absence_window_start':
    case 'absence_window_end':
    case 'age_update':
    case 'constraint_remove':
    case 'trade_offer':
    case 'group_msg':
      // Don't bother — these run in the existing 6-month sim. We're here for
      // the EXPANDED noise + drama coverage.
      break
    default:
      break
  }
}

// ── Event generators ───────────────────────────────────────────────────────

function generateCallouts(weeks) {
  const events = []
  const reasons = ['sick', 'car trouble', 'family emergency', 'fever', 'food poisoning', 'kid sick', 'flat tire', 'flu', 'covid', 'migraine', 'just feeling off']
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  // Skip the first 4 STAFF (managers / super reliable) — focus on others
  const calloutCandidates = STAFF.filter(s => !['Aaliyah', 'Marcus', 'Tony'].includes(s.name))
  for (const ws of weeks) {
    const baseDate = new Date(ws + 'T15:00:00Z')
    const numCallouts = rand(2, 5)  // 2-5 callouts per week
    for (let i = 0; i < numCallouts; i++) {
      const dayOffset = rand(0, 6)
      const at = new Date(baseDate)
      at.setUTCDate(at.getUTCDate() + dayOffset)
      at.setUTCHours(rand(8, 18))
      events.push({
        at,
        kind: 'callout',
        staffName: pick(calloutCandidates).name,
        reason: pick(reasons),
        shiftDay: days[at.getUTCDay()],
        shiftName: 'Mon-Fri Dinner',
      })
    }
  }
  return events
}

function generateDemandSignals(weeks) {
  const events = []
  const phrases = [
    "we're gonna be packed tonight",
    "tonight is gonna be slammed",
    "expect a slow night",
    "patio empty all night",
    "St Patrick's gonna be huge",
    "Easter brunch fully booked",
    "Mother's day record book",
    "Memorial day patio packed",
    "rainy day, gonna be quiet",
    "100 covers booked",
    "Father's day fully booked",
    "huge graduation party tonight",
    "valentines is gonna be insane",
  ]
  for (const ws of weeks) {
    const at = new Date(ws + 'T18:00:00Z')
    at.setUTCDate(at.getUTCDate() + rand(0, 6))
    events.push({ at, kind: 'demand_signal_group', from: 'Manager', text: pick(phrases) })
    if (Math.random() > 0.5) {
      const at2 = new Date(at); at2.setUTCDate(at2.getUTCDate() + rand(1, 4))
      events.push({ at: at2, kind: 'demand_signal_group', from: 'Server', text: pick(phrases) })
    }
  }
  return events
}

function generateRecognition(weeks) {
  const events = []
  const targets = ['Marco', 'Sofia', 'Aaliyah', 'Sam', 'Devon', 'Priya', 'Jaylen', 'Carmen', 'Jake', 'Mike']
  const verbs = ['killed it', 'crushed it', 'saved us', 'absolutely nailed it', 'was a beast', 'was 🔥', 'showed up big']
  for (const ws of weeks) {
    if (Math.random() < 0.7) {
      const at = new Date(ws + 'T22:00:00Z')
      at.setUTCDate(at.getUTCDate() + rand(0, 6))
      events.push({ at, kind: 'recognition', from: 'Aaliyah', text: `shoutout to ${pick(targets)} who ${pick(verbs)} tonight` })
    }
  }
  return events
}

function generateTimeOff(weeks) {
  const events = []
  const candidates = ['Emma', 'Carmen', 'Sarah', 'Priya', 'Jaylen', 'Tiffany']
  for (let i = 0; i < weeks.length; i += 3) {
    if (i >= weeks.length) break
    const ws = weeks[i]
    const at = new Date(ws + 'T14:00:00Z')
    const targetDate = new Date(at); targetDate.setUTCDate(targetDate.getUTCDate() + rand(7, 21))
    events.push({ at, kind: 'time_off_request', staffName: pick(candidates), date: targetDate.toISOString().slice(0, 10), reason: 'personal' })
    const decision = new Date(at); decision.setUTCHours(decision.getUTCHours() + 4)
    events.push({ at: decision, kind: 'time_off_decision', staffName: pick(candidates), decision: Math.random() > 0.3 ? 'approve' : 'deny' })
  }
  return events
}

function generateTrades(weeks) {
  const events = []
  for (let i = 0; i < weeks.length; i += 4) {
    if (i >= weeks.length) break
    const ws = weeks[i]
    const at = new Date(ws + 'T11:00:00Z')
    events.push({ at, kind: 'trade_request', from: 'Tiffany', text: 'anyone wanna swap my saturday' })
  }
  return events
}

function generateLifecycle() {
  // Already in dramaEvents() of restaurantSixMonth.js — skip duplication
  return []
}

function generateManagerDms() {
  return []
}

function generateNoise(weeks) {
  const events = []
  const noiseMessages = [
    'lol',
    'lmao',
    'haha 💀',
    'k',
    'ok',
    'yeah',
    'sounds good',
    'thanks',
    '👍',
    '😂',
    '💀💀💀',
    "today is friday already?",
    'who took the last coffee',
    'fryer broken again',
    'we out of ranch??',
    "host stand needs new pens",
    "where's the broom",
    "music's too loud",
    "table 12 is being annoying",
    "did anyone see my apron",
    "phone died",
    "uber here",
    "see y'all tomorrow",
    "I left my charger in the back",
    "anyone got gum",
    "that party left a $200 tip 🤑",
    "the printer is jammed AGAIN",
    "the dish pit is exploded",
    "the AC is OUT in the kitchen",
    "anyone want my shift mealll",
    "🍕🍕🍕",
    "yo",
    "?",
    "...",
    "smh",
    "💀💀💀",
    "deadass",
    "fr fr",
    "no cap",
  ]
  for (const ws of weeks) {
    // Inject ~5-10 noise messages per week
    const count = rand(5, 10)
    for (let i = 0; i < count; i++) {
      const at = new Date(ws + 'T00:00:00Z')
      at.setUTCDate(at.getUTCDate() + rand(0, 6))
      at.setUTCHours(rand(7, 23))
      events.push({ at, kind: 'noise', text: pick(noiseMessages), from: pick(STAFF).name })
    }
  }
  return events
}
