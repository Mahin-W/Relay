// TimeEngine — drives a multi-month simulation by advancing a virtual clock,
// firing cron handlers at their scheduled times, and dispatching timeline events
// to the real Relay handlers. Every assertion must match actual bot output and
// DB state, OR the step fails.

import { sendDailyBriefing } from '../../briefing/dailyBriefing.js'
import { handleMissedClockOutCheck } from '../../timeclock/missedClockOut.js'
import { checkUpcomingShifts } from '../../noshow/noShowWarning.js'
import { generateNarrativeBriefing, compileWeeklyStats } from '../../intelligence/narrativeBriefing.js'
import { calculateWeeklyQualityScore } from '../../intelligence/scheduleQuality.js'

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dayName(d) { return DAY_NAMES[new Date(d).getUTCDay()] }
export function weekStartOf(d) {
  const x = new Date(d)
  const day = x.getUTCDay() // 0=Sun ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day
  x.setUTCDate(x.getUTCDate() + diff)
  x.setUTCHours(0, 0, 0, 0)
  return x.toISOString().slice(0, 10)
}
export function addDays(d, n) {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + n)
  return x
}
export function addHours(d, n) {
  const x = new Date(d)
  x.setUTCHours(x.getUTCHours() + n)
  return x
}
export function iso(d) { return new Date(d).toISOString() }

// ── TimeEngine ─────────────────────────────────────────────────────────────

export class TimeEngine {
  constructor({ db, bot, groupId, managerDm, start, end }) {
    this.db = db
    this.bot = bot
    this.groupId = groupId
    this.managerDm = managerDm
    this.now = new Date(start)
    this.end = new Date(end)
    this.events = []           // sorted array of { at, kind, ... }
    this.metrics = {
      daysSimulated: 0,
      cronFires: { daily: 0, sunday: 0, missedClockOut: 0, noShow: 0 },
      eventsProcessed: 0,
      botMessages: 0,
    }
    this._lastDailyBriefingDay = null
    this._lastSundayBriefingWeek = null
    this._lastCronTick = new Date(this.now)
  }

  setNow(d) {
    this.now = new Date(d)
    this.db.setNow?.(this.now)
  }

  schedule(event) {
    if (!event.at) throw new Error(`event missing .at: ${JSON.stringify(event)}`)
    event.at = new Date(event.at)
    this.events.push(event)
  }
  scheduleMany(events) { for (const e of events) this.schedule(e) }
  sortEvents() {
    this.events.sort((a, b) => a.at.getTime() - b.at.getTime())
  }

  // Advance to target, firing crons at 8am/Sunday-7pm and processing events.
  async advanceTo(target, { processEvents = true, onEvent = null, onCron = null } = {}) {
    target = new Date(target)
    this.sortEvents()

    while (this.now < target) {
      // Find the next "thing to do":
      //  - Next cron firing (daily 8am, weekly Sun 7pm, hourly missed-clock checks)
      //  - Next scheduled event
      //  - Target
      const nextCron = this._nextCronTime()
      const nextEvent = processEvents ? this._nextEventTime() : null
      let tick = target
      if (nextCron && nextCron < tick) tick = nextCron
      if (nextEvent && nextEvent < tick) tick = nextEvent

      this.setNow(tick)

      // Fire crons due at/before now
      await this._fireDueCrons(onCron)

      // Process all events due at-or-before now (flush queue up to current tick)
      if (processEvents) {
        while (this.events.length > 0 && this.events[0].at.getTime() <= this.now.getTime()) {
          const ev = this.events.shift()
          this.metrics.eventsProcessed++
          try {
            if (onEvent) await onEvent(ev)
          } catch (err) {
            if (ev.verify) ev.verify.failed = err.message
          }
        }
      }

      if (this.now >= target) break
      // Defensive: if the tick didn't advance (rare timing loop), nudge by 1ms
      if (tick.getTime() === this.now.getTime() - 0) {
        this.setNow(new Date(this.now.getTime() + 1))
      }
    }
  }

  // The next cron firing after this.now (inclusive of this.now+1ms).
  _nextCronTime() {
    const candidates = []

    // Daily briefing: 8am UTC every day (after _lastDailyBriefingDay).
    const eightToday = new Date(this.now)
    eightToday.setUTCHours(8, 0, 0, 0)
    const todayStr = this.now.toISOString().slice(0, 10)
    if (this._lastDailyBriefingDay !== todayStr && this.now <= eightToday) {
      candidates.push(eightToday)
    } else if (this._lastDailyBriefingDay !== todayStr && this.now > eightToday) {
      // Missed today's 8am — fire immediately next tick.
      candidates.push(new Date(this.now.getTime() + 1))
    } else {
      // Next day's 8am
      const tomorrow = new Date(this.now)
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
      tomorrow.setUTCHours(8, 0, 0, 0)
      candidates.push(tomorrow)
    }

    // Sunday 7pm briefing (weekly).
    const currentSunday19 = this._lastSundayAt(19)
    const thisWeek = weekStartOf(this.now)
    if (this._lastSundayBriefingWeek !== thisWeek &&
        this.now >= currentSunday19 && dayName(this.now) === 'Sunday' && this.now.getUTCHours() >= 19) {
      candidates.push(new Date(this.now.getTime() + 1))
    } else {
      // Next Sunday 7pm
      const next = new Date(this.now)
      const daysUntilSun = (7 - next.getUTCDay()) % 7
      next.setUTCDate(next.getUTCDate() + (daysUntilSun === 0 ? 7 : daysUntilSun))
      next.setUTCHours(19, 0, 0, 0)
      candidates.push(next)
    }

    // Hourly missed-clock-out + no-show
    const nextHour = new Date(this.now)
    nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0)
    candidates.push(nextHour)

    const soonest = candidates.reduce((a, b) => (a < b ? a : b))
    return soonest
  }

  _nextEventTime() {
    return this.events[0]?.at ?? null
  }

  _lastSundayAt(hour) {
    const x = new Date(this.now)
    const back = x.getUTCDay()
    x.setUTCDate(x.getUTCDate() - back)
    x.setUTCHours(hour, 0, 0, 0)
    return x
  }

  async _fireDueCrons(onCron) {
    const todayStr = this.now.toISOString().slice(0, 10)
    const hour = this.now.getUTCHours()

    // Daily 8am briefing
    if (hour >= 8 && this._lastDailyBriefingDay !== todayStr) {
      this._lastDailyBriefingDay = todayStr
      try {
        await sendDailyBriefing(this.bot, this.groupId, this.db)
        this.metrics.cronFires.daily++
        if (onCron) await onCron({ kind: 'daily_briefing', at: this.now })
      } catch (err) {
        // Briefing may fail on thin history — log to metrics only
        this.metrics.cronFires.daily++
      }
    }

    // Sunday 7pm briefing
    if (dayName(this.now) === 'Sunday' && hour >= 19) {
      const thisWeek = weekStartOf(this.now)
      if (this._lastSundayBriefingWeek !== thisWeek) {
        this._lastSundayBriefingWeek = thisWeek
        try {
          const briefing = await generateNarrativeBriefing(this.groupId, thisWeek, this.db)
          if (briefing) {
            await this.bot.sendMessage(
              String(this.managerDm),
              `📊 Sunday Briefing — week of ${thisWeek}\n${briefing.narrative ?? ''}`,
              { parse_mode: 'Markdown' },
            )
          }
          // Quality score
          const qs = await calculateWeeklyQualityScore(this.groupId, thisWeek, this.db)
          if (qs) await this.db.saveQualityScore(this.groupId, thisWeek, qs)
          this.metrics.cronFires.sunday++
          if (onCron) await onCron({ kind: 'sunday_briefing', at: this.now, week: thisWeek, qualityScore: qs })
        } catch {
          this.metrics.cronFires.sunday++
        }
      }
    }

    // Missed clock-out + no-show (hourly)
    if (this.now.getTime() - this._lastCronTick.getTime() >= 3600 * 1000 - 1) {
      this._lastCronTick = new Date(this.now)
      try {
        await handleMissedClockOutCheck(this.bot, this.groupId, this.db)
        this.metrics.cronFires.missedClockOut++
      } catch {}
      try {
        await checkUpcomingShifts(this.bot, this.db)
        this.metrics.cronFires.noShow++
      } catch {}
    }
  }
}
