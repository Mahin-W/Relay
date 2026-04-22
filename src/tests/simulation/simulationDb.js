// SimulationDb — in-memory Supabase facade for the month-long stress test.
// Extends MockDB with arrays for every table handlers touch.
// Falls back to safe no-op/empty returns for any method not explicitly defined
// (via Proxy) so unknown injection sites don't crash.

import { MockDB } from '../helpers/mocks.js'

export class SimulationDb extends MockDB {
  constructor() {
    super()
    // Additional in-memory tables
    this.moraleEvents = []
    this.recognitionEvents = []
    this.businessRules = []
    this.timeEntries = []
    this.payrollRecords = []
    this.tipRecords = []
    this.demandSignals = []
    this.qualityScores = []
    this.managerLog = []
    this.availability = []
    this.partialCoverages = []
    this.timeOffRequests = []
    this.onboardingPending = []
    this.generatedSchedules = []
    this.learnedPreferences = []
    this.scheduleEditEvents = []
    this.reliabilityEvents = []
    this.weeklyRevenue = []
    this.noshowWarnings = []
    this.crossTraining = []
    this.shiftRequirements = []
    this.recurringConstraints = []
    this.laborBudgets = []
    this.tipSettings = []
    this.overtimeSettings = []
    this.roleRates = []
    this.setupSessions = []
    this.scheduleReceipts = []
    this.onCall = []
    this.coverageOutreach = []
    this.passiveAvailability = []
    this.discoveredPatterns = []
    this.dismissedPatterns = []
    this.platformContacts = []

    this._now = null // optional frozen clock

    this._bindAll()

    // Proxy swallows unknown db.* methods → async no-op returning null or []
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop]
        // Unknown method: return a benign async function
        if (typeof prop === 'string' && !prop.startsWith('_')) {
          return async (..._args) => {
            if (process.env.SIM_VERBOSE) console.log(`[SimDb] stub ${String(prop)}`)
            // Heuristic defaults by method name prefix
            if (prop.startsWith('get') || prop.startsWith('analyze') || prop.startsWith('fetch')) return []
            if (prop.startsWith('save') || prop.startsWith('insert') || prop.startsWith('update')) return { id: target._nextId() }
            return null
          }
        }
        return undefined
      },
    })
  }

  setNow(d) { this._now = d instanceof Date ? d : new Date(d) }
  _ts() { return (this._now ?? new Date()).toISOString() }

  _bindAll() {
    for (const key of Object.getOwnPropertyNames(SimulationDb.prototype)) {
      if (key === 'constructor') continue
      if (typeof this[key] === 'function') this[key] = this[key].bind(this)
    }
  }

  // ── Staff / Shifts helpers (override + extend MockDB) ────────────────────
  async getActiveStaff(groupId) {
    return this.staff.filter(s => s.group_id === String(groupId) && s.active !== false)
  }
  async getActiveStaffIds(groupId) {
    return (await this.getActiveStaff(groupId)).map(s => s.id)
  }
  async getAllStaffForGroup(groupId) {
    return this.staff.filter(s => s.group_id === String(groupId))
  }
  async getStaffForGroup(groupId) { return this.getAllStaffForGroup(groupId) }
  async getStaffByName(groupId, name) {
    const n = String(name).toLowerCase().trim()
    return this.staff.find(s => s.group_id === String(groupId) && s.name.toLowerCase().includes(n)) ?? null
  }
  async getStaffMember(staffId) { return this.staff.find(s => s.id === staffId) ?? null }
  async getStaffByUserId(userId, groupId) {
    return this.staff.find(s => s.user_id === userId && (groupId == null || s.group_id === String(groupId))) ?? null
  }
  async getStaffByDmChatId(dmChatId) {
    return this.staff.find(s => String(s.dm_chat_id) === String(dmChatId)) ?? null
  }
  async getShiftsForGroup(groupId) {
    return this.shifts.filter(s => s.group_id === String(groupId))
  }
  async getShiftsByGroup(groupId) { return this.getShiftsForGroup(groupId) }
  async getShiftById(shiftId) { return this.shifts.find(s => s.id === shiftId) ?? null }
  async getShiftRequirements(shiftId) {
    return this.shiftRequirements.filter(r => r.shift_id === shiftId)
  }
  async getRolesForGroup(groupId) {
    const roles = new Set()
    this.staff.filter(s => s.group_id === String(groupId)).forEach(s => roles.add(s.role))
    return [...roles]
  }
  async getUniqueRolesForGroup(groupId) { return this.getRolesForGroup(groupId) }

  // ── Schedule assignments ─────────────────────────────────────────────────
  async getScheduleAssignments(groupId, weekStart) {
    return this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) && (!weekStart || a.week_start === weekStart))
  }
  async getAssignments(groupId, weekStart) { return this.getScheduleAssignments(groupId, weekStart) }
  async getAssignmentsForStaffWeek(staffId, weekStart) {
    return this.scheduleAssignments.filter(a => a.staff_id === staffId && a.week_start === weekStart)
  }
  async getPublishedAssignments(groupId, weekStart) {
    return this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) && a.week_start === weekStart && a.status === 'scheduled')
  }
  async getPublishedSchedule(groupId, weekStart = null) {
    const rows = this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) && (!weekStart || a.week_start === weekStart))
    return rows
  }
  async getPreviousWeekSchedule(groupId, weekStart) {
    const prev = prevWeekStart(weekStart)
    return this.getPublishedSchedule(groupId, prev)
  }
  async getTodaysAssignments(groupId, dayOfWeek, weekStart) {
    return this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) &&
      a.week_start === weekStart &&
      a.day_of_week === dayOfWeek)
  }
  async getGroupShiftHistory(groupId, weeksBack = 8) {
    const cutoff = weeksBack * 7 * 86400000
    const nowMs = (this._now ?? new Date()).getTime()
    return this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) &&
      nowMs - new Date(a.week_start + 'T00:00:00Z').getTime() <= cutoff)
  }
  async getScheduleHistory(groupId, weeksBack = 8) { return this.getGroupShiftHistory(groupId, weeksBack) }
  async saveGeneratedSchedule(groupId, weekStart, assignments, gaps) {
    const row = {
      id: this._nextId(),
      group_id: String(groupId),
      week_start: weekStart,
      status: 'draft',
      assignments,
      gaps,
      created_at: this._ts(),
    }
    this.generatedSchedules.push(row)
    return row
  }
  async saveEditEvent(groupId, weekStart, edit) {
    const row = { id: this._nextId(), group_id: String(groupId), week_start: weekStart, ...edit, created_at: this._ts() }
    this.scheduleEditEvents.push(row)
    return row
  }
  async getEditHistory(groupId, weeksBack = 8) {
    return this.scheduleEditEvents.filter(e => e.group_id === String(groupId))
  }

  // ── Availability ─────────────────────────────────────────────────────────
  async saveAvailability(userId, groupId, weekStart, data) {
    const idx = this.availability.findIndex(a =>
      a.user_id === userId && a.group_id === String(groupId) && a.week_start === weekStart)
    const row = { id: idx >= 0 ? this.availability[idx].id : this._nextId(),
      user_id: userId, group_id: String(groupId), week_start: weekStart,
      available_shift_ids: data.available_shift_ids ?? [],
      available_all: data.available_all ?? false,
      unavailable: data.unavailable ?? false,
      raw_response: data.raw_response ?? null,
      collected_at: this._ts() }
    if (idx >= 0) this.availability[idx] = row; else this.availability.push(row)
    // G.03: flag late submissions — availability saved after schedule already published
    const hasPublished = this.scheduleAssignments.some(a =>
      a.group_id === String(groupId) && a.week_start === weekStart)
    if (hasPublished) row.late_submission = true
    return row
  }
  async getAvailability(groupId, weekStart) {
    return this.availability.filter(a => a.group_id === String(groupId) && a.week_start === weekStart)
  }
  async getAvailabilityForGroup(groupId, weekStart) { return this.getAvailability(groupId, weekStart) }

  // ── Coverage (extending MockDB) ──────────────────────────────────────────

  // Atomic markCovered override: uses a synchronous in-progress Set so that
  // even 500 concurrent JS promises (BH.05 / BH.20) can only flip one caller.
  async markCovered(id, coveredBy) {
    try {
      if (!this._markCoveredLocks) this._markCoveredLocks = new Set()
      const r = this.coverageRequests.find(r => r.id === id)
      // Only the first caller whose request is still 'open' wins.
      if (!r || r.status !== 'open' || this._markCoveredLocks.has(id)) return null
      this._markCoveredLocks.add(id)
      r.status = 'covered'
      r.covered_by = coveredBy
      r.covered_at = this._ts()
      return r
    } catch (err) {
      return null
    }
  }

  async getCoverageRequestsForGroup(groupId, weeksBack = 4) {
    const nowT = (this._now ?? new Date()).getTime()
    const cutoff = nowT - weeksBack * 7 * 86400000
    return this.coverageRequests.filter(r =>
      r.group_id === String(groupId) && new Date(r.created_at).getTime() >= cutoff)
  }
  async getCoverageStatsForWeek(groupId, weekStart) {
    const rows = this.coverageRequests.filter(r => r.group_id === String(groupId) && r.week_start === weekStart)
    return { total: rows.length, covered: rows.filter(r => r.status === 'covered').length,
             avgFillMinutes: rows.length ? 10 : 0 }
  }
  async getCoveredRequests(groupId, weeksBack = 8) {
    return this.coverageRequests.filter(r => r.group_id === String(groupId) && r.status === 'covered')
  }
  async getOpenCoverageRequests(groupId) {
    return this.coverageRequests.filter(r => r.group_id === String(groupId) && r.status === 'open')
  }
  async saveCoverageRequest(...args) { return this.saveRequest(...args) }
  async savePartialCoverage(data) {
    const row = { id: this._nextId(), ...data, created_at: this._ts() }
    this.partialCoverages.push(row); return row
  }
  async getPartialCoverages(coverageRequestId) {
    return this.partialCoverages.filter(p => p.coverage_request_id === coverageRequestId)
  }

  // ── Clock / time entries ─────────────────────────────────────────────────
  async clockIn(data) {
    // BH.32: idempotency — reject if an open entry already exists for this user/staff
    const existingOpen = this.timeEntries.find(e =>
      e.user_id === data.user_id &&
      e.group_id === String(data.group_id) &&
      !e.clock_out
    )
    if (existingOpen) return null
    const row = { id: this._nextId(), ...data, clock_in: data.clock_in ?? this._ts(), clock_out: null, created_at: this._ts() }
    this.timeEntries.push(row); return row
  }
  async clockOut(entryId, clockOutTime = null) {
    const e = this.timeEntries.find(x => x.id === entryId)
    if (!e) return null
    // D.02: idempotency — never overwrite an existing clock_out
    if (e.clock_out != null) return null
    e.clock_out = clockOutTime ?? this._ts()
    return e
  }
  async manualClockIn(data) { return this.clockIn(data) }
  async manualClockOut(staffId, clockOutTime) {
    const open = this.timeEntries.find(e => e.staff_id === staffId && !e.clock_out)
    if (open) open.clock_out = clockOutTime ?? this._ts()
    return open ?? null
  }
  async getOpenEntry(userId, groupId) {
    return this.timeEntries.find(e => e.user_id === userId && e.group_id === String(groupId) && !e.clock_out) ?? null
  }
  async getOpenClockEntry(userId, groupId) { return this.getOpenEntry(userId, groupId) }
  async getClockedInNow(groupId) {
    return this.timeEntries.filter(e => e.group_id === String(groupId) && !e.clock_out)
  }
  async getTimeEntriesForWeek(groupId, weekStart) {
    const start = new Date(weekStart + 'T00:00:00Z').getTime()
    const end = start + 7 * 86400000
    return this.timeEntries.filter(e => {
      const t = new Date(e.clock_in).getTime()
      return e.group_id === String(groupId) && t >= start && t < end
    })
  }
  async getMostRecentEntry(userId, groupId) {
    return this.timeEntries
      .filter(e => e.user_id === userId && e.group_id === String(groupId))
      .sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in))[0] ?? null
  }
  async getRecentEntries(groupId, limit = 20) {
    return this.timeEntries
      .filter(e => e.group_id === String(groupId))
      .sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in))
      .slice(0, limit)
  }
  async getMissedClockOuts(groupId, now = new Date()) {
    const nowT = now.getTime()
    return this.timeEntries.filter(e =>
      e.group_id === String(groupId) && !e.clock_out && !e.alerted_at &&
      nowT - new Date(e.clock_in).getTime() > 6 * 3600000)
  }
  async markAlerted(entryId) {
    const e = this.timeEntries.find(x => x.id === entryId)
    if (e) e.alerted_at = this._ts()
    return e
  }

  // ── Payroll ──────────────────────────────────────────────────────────────
  async savePeriodPayroll(row) {
    const key = r => r.group_id === row.group_id && r.staff_id === row.staff_id && r.week_start === row.week_start
    const idx = this.payrollRecords.findIndex(key)
    const withId = { id: idx >= 0 ? this.payrollRecords[idx].id : this._nextId(), ...row }
    if (idx >= 0) this.payrollRecords[idx] = withId; else this.payrollRecords.push(withId)
    return withId
  }
  async getPayrollForWeek(groupId, weekStart) {
    return this.payrollRecords.filter(r => r.group_id === String(groupId) && r.week_start === weekStart)
  }
  async getPayrollHistory(groupId, staffId, weeksBack = 8) {
    return this.payrollRecords.filter(r => r.group_id === String(groupId) && (staffId == null || r.staff_id === staffId))
  }
  async getPayrollTotal(groupId, weekStart) {
    const rows = await this.getPayrollForWeek(groupId, weekStart)
    return rows.reduce((s, r) => s + (Number(r.total_gross_pay) || 0), 0)
  }
  async getRatesForGroup(groupId) {
    return this.roleRates.filter(r => r.group_id === String(groupId))
  }
  async getRoleRate(groupId, role) {
    return this.roleRates.find(r => r.group_id === String(groupId) && r.role.toLowerCase() === role.toLowerCase()) ?? null
  }
  async updateRoleRate(groupId, role, rate) {
    const idx = this.roleRates.findIndex(r => r.group_id === String(groupId) && r.role.toLowerCase() === role.toLowerCase())
    if (idx >= 0) this.roleRates[idx].rate = rate
    else this.roleRates.push({ id: this._nextId(), group_id: String(groupId), role, rate })
    return this.roleRates[idx >= 0 ? idx : this.roleRates.length - 1]
  }
  async getOvertimeSettings(groupId) {
    return this.overtimeSettings.find(s => s.group_id === String(groupId)) ?? {
      weekly_threshold: 40, weekly_multiplier: 1.5, daily_threshold: 0, daily_multiplier: 1.5, daily_overtime_enabled: false,
    }
  }
  async saveOvertimeSettings(groupId, settings) {
    const idx = this.overtimeSettings.findIndex(s => s.group_id === String(groupId))
    const row = { id: idx >= 0 ? this.overtimeSettings[idx].id : this._nextId(), group_id: String(groupId), ...settings }
    if (idx >= 0) this.overtimeSettings[idx] = row; else this.overtimeSettings.push(row)
    return row
  }
  async getBudget(groupId) {
    return this.laborBudgets.find(b => b.group_id === String(groupId)) ?? null
  }
  async saveBudget(groupId, weeklyBudget) {
    const idx = this.laborBudgets.findIndex(b => b.group_id === String(groupId))
    const row = { id: idx >= 0 ? this.laborBudgets[idx].id : this._nextId(), group_id: String(groupId), weekly_budget: weeklyBudget }
    if (idx >= 0) this.laborBudgets[idx] = row; else this.laborBudgets.push(row)
    return row
  }
  async getLaborPercent(groupId, weekStart) {
    const payroll = await this.getPayrollTotal(groupId, weekStart)
    const rev = this.weeklyRevenue.find(r => r.group_id === String(groupId) && r.week_start === weekStart)
    if (!rev?.revenue) return null
    return Math.round((payroll / rev.revenue) * 1000) / 10
  }
  async saveWeeklyRevenue(groupId, weekStart, revenue) {
    const idx = this.weeklyRevenue.findIndex(r => r.group_id === String(groupId) && r.week_start === weekStart)
    const row = { id: idx >= 0 ? this.weeklyRevenue[idx].id : this._nextId(), group_id: String(groupId), week_start: weekStart, revenue }
    if (idx >= 0) this.weeklyRevenue[idx] = row; else this.weeklyRevenue.push(row)
    return row
  }
  async getRevenueHistory(groupId, weeksBack = 8) {
    return this.weeklyRevenue.filter(r => r.group_id === String(groupId))
  }

  // ── Tips ────────────────────────────────────────────────────────────────
  async saveTipRecord(row) {
    try {
      // E.03: upsert by (group_id, shift_date) — replace existing record for same date
      const idx = this.tipRecords.findIndex(r =>
        r.group_id === row.group_id && r.shift_date === row.shift_date)
      const withId = { id: idx >= 0 ? this.tipRecords[idx].id : this._nextId(), ...row, created_at: this._ts() }
      if (idx >= 0) this.tipRecords[idx] = withId; else this.tipRecords.push(withId)
      return withId
    } catch (err) {
      return null
    }
  }
  async getTipHistory(groupId, weeksBack = 4) {
    return this.tipRecords.filter(r => r.group_id === String(groupId))
  }
  async getTipSettings(groupId) {
    return this.tipSettings.find(s => s.group_id === String(groupId)) ??
      { group_id: String(groupId), mode: 'pool', split_method: 'hours', boh_included: false }
  }
  async saveTipSettings(groupId, settings) {
    const idx = this.tipSettings.findIndex(s => s.group_id === String(groupId))
    const row = { id: idx >= 0 ? this.tipSettings[idx].id : this._nextId(), group_id: String(groupId), ...settings }
    if (idx >= 0) this.tipSettings[idx] = row; else this.tipSettings.push(row)
    return row
  }
  async getTipEligibleStaff(groupId, shiftDate, shiftId) {
    // Return staff assigned to that shift who are FOH (per tipSettings)
    const settings = await this.getTipSettings(groupId)
    const BOH = /cook|chef|prep|dishwasher|dish|line|kitchen|expo/i
    const assignments = this.scheduleAssignments.filter(a =>
      a.group_id === String(groupId) && (shiftId == null || a.shift_id === shiftId))
    return assignments
      .map(a => this.staff.find(s => s.id === a.staff_id))
      .filter(Boolean)
      .filter(s => settings.boh_included || !BOH.test(s.role))
  }

  // ── Morale / Recognition / Reliability ───────────────────────────────────
  async saveMoraleEvent(groupId, staffId, event) {
    const row = { id: this._nextId(), group_id: String(groupId), staff_id: staffId,
      type: event.type, sentiment: event.sentiment ?? null,
      response_minutes: event.response_minutes ?? null,
      week_start: event.week_start ?? null, created_at: this._ts() }
    this.moraleEvents.push(row); return row
  }
  async getMoraleEvents(groupId, staffId = null, weeksBack = 4) {
    const nowT = (this._now ?? new Date()).getTime()
    const cutoff = nowT - weeksBack * 7 * 86400000
    return this.moraleEvents.filter(e =>
      e.group_id === String(groupId) &&
      (staffId == null || e.staff_id === staffId) &&
      new Date(e.created_at).getTime() >= cutoff)
  }
  async getMoraleSnapshot(groupId) {
    const bs = {}
    for (const e of this.moraleEvents) {
      if (e.group_id !== String(groupId)) continue
      bs[e.staff_id] ??= []
      bs[e.staff_id].push(e)
    }
    return bs
  }
  async saveRecognitionEvent(groupId, managerId, recognition) {
    const row = { id: this._nextId(), group_id: String(groupId), recipient_id: recognition.recipientStaffId ?? null,
      recipient_name: recognition.recipientName ?? null, message: recognition.reason ?? recognition.originalText ?? null,
      created_at: this._ts() }
    this.recognitionEvents.push(row); return row
  }
  async getRecognitionHistory(groupId, staffId = null, weeksBack = 8) {
    return this.recognitionEvents.filter(r => r.group_id === String(groupId) && (staffId == null || r.recipient_id === staffId))
  }
  async getRecognitionEvents(groupId, staffId, weeksBack = 8) { return this.getRecognitionHistory(groupId, staffId, weeksBack) }
  async getRecognitionEventsForGroup(groupId, weeksBack = 8) { return this.getRecognitionHistory(groupId, null, weeksBack) }
  async getRecognitionLeaderboard(groupId, weeksBack = 4) {
    const counts = {}
    for (const r of this.recognitionEvents) {
      if (r.group_id !== String(groupId)) continue
      const key = r.recipient_id ?? r.recipient_name
      counts[key] = (counts[key] ?? 0) + 1
    }
    return Object.entries(counts).map(([k, v]) => ({ id: k, count: v })).sort((a, b) => b.count - a.count)
  }
  async recordEvent(groupId, staffId, eventData) {
    const row = { id: this._nextId(), group_id: String(groupId), staff_id: staffId,
      ...eventData, created_at: this._ts() }
    this.reliabilityEvents.push(row); return row
  }
  async getReliabilityEvents(groupId, staffId, weeksBack = 8) {
    return this.reliabilityEvents.filter(e => e.group_id === String(groupId) && (staffId == null || e.staff_id === staffId))
  }
  async getReliabilityEventsForGroup(groupId, weeksBack = 8) { return this.getReliabilityEvents(groupId, null, weeksBack) }
  async getReliabilityEventsForDate(groupId, date) {
    return this.reliabilityEvents.filter(e => e.group_id === String(groupId) && (e.date ?? e.created_at?.slice(0,10)) === date)
  }
  async getReliabilityScores(groupId) { return [] }

  // ── Business rules ───────────────────────────────────────────────────────
  async saveRule(groupId, rule) {
    const row = { id: this._nextId(), group_id: String(groupId), active: true,
      ...rule, created_at: this._ts() }
    this.businessRules.push(row); return row
  }
  async getRules(groupId) {
    return this.businessRules.filter(r => r.group_id === String(groupId) && r.active !== false)
  }
  async getRulesForStaff(groupId, staffId) {
    return this.businessRules.filter(r => r.group_id === String(groupId) &&
      (r.subject_staff_id === staffId || r.object_staff_id === staffId))
  }
  async deactivateRule(ruleId) {
    const r = this.businessRules.find(x => x.id === ruleId)
    if (r) r.active = false
    return r
  }

  // ── Demand signals ───────────────────────────────────────────────────────
  async saveDemandSignal(groupId, weekStart, signal, sourceMessage, sourceUserId) {
    const row = { id: this._nextId(), group_id: String(groupId), week_start: weekStart,
      signal_type: signal.type, day_of_week: signal.dayOfWeek ?? null,
      is_week_level: signal.isWeekLevel ?? false, raw_mention: signal.rawMention ?? sourceMessage,
      source_user_id: sourceUserId ?? null, created_at: this._ts() }
    this.demandSignals.push(row); return row
  }
  async getDemandSignals(groupId, weekStart) {
    return this.demandSignals.filter(s => s.group_id === String(groupId) && (!weekStart || s.week_start === weekStart))
  }

  // ── Quality scores ───────────────────────────────────────────────────────
  async saveQualityScore(groupId, weekStart, scoreData) {
    const idx = this.qualityScores.findIndex(q => q.group_id === String(groupId) && q.week_start === weekStart)
    const row = { id: idx >= 0 ? this.qualityScores[idx].id : this._nextId(),
      group_id: String(groupId), week_start: weekStart, ...scoreData, created_at: this._ts() }
    if (idx >= 0) this.qualityScores[idx] = row; else this.qualityScores.push(row)
    return row
  }
  async getQualityHistory(groupId, weeksBack = 12) {
    return this.qualityScores
      .filter(q => q.group_id === String(groupId))
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
  }

  // ── Manager log ──────────────────────────────────────────────────────────
  async saveLogEntry(groupId, managerId, entryText, shiftContext) {
    const row = { id: this._nextId(), group_id: String(groupId), manager_id: managerId,
      entry_text: entryText, shift_name: shiftContext?.shift_name ?? null,
      day_of_week: shiftContext?.day_of_week ?? null, week_start: shiftContext?.week_start ?? null,
      created_at: this._ts() }
    this.managerLog.push(row); return row
  }
  async getLogEntries(groupId, weeksBack = 4) {
    return this.managerLog.filter(e => e.group_id === String(groupId))
  }
  async getLogEntryForShiftDate(groupId, dayOfWeek, weekStart) {
    return this.managerLog.find(e => e.group_id === String(groupId) && e.day_of_week === dayOfWeek && e.week_start === weekStart) ?? null
  }
  async searchLogEntries(groupId, query) {
    const q = String(query).toLowerCase()
    return this.managerLog.filter(e => e.group_id === String(groupId) && e.entry_text.toLowerCase().includes(q))
  }

  // ── Time off ─────────────────────────────────────────────────────────────
  async saveTimeOffRequest(row) {
    const withId = { id: this._nextId(), status: 'pending', ...row, requested_at: this._ts() }
    this.timeOffRequests.push(withId); return withId
  }
  async getPendingTimeOff(groupId) {
    return this.timeOffRequests.filter(r => r.group_id === String(groupId) && r.status === 'pending')
  }
  async getPendingTimeOffByName(groupId, staffName) {
    return this.timeOffRequests.find(r =>
      r.group_id === String(groupId) && r.status === 'pending' &&
      r.staff_name.toLowerCase() === String(staffName).toLowerCase()) ?? null
  }
  async updateTimeOffStatus(id, status) {
    const r = this.timeOffRequests.find(x => x.id === id)
    if (r) r.status = status
    return r
  }

  // ── Onboarding ───────────────────────────────────────────────────────────
  async saveOnboardingRecord(row) {
    const withId = { id: this._nextId(), status: 'pending', announced_at: this._ts(), ...row }
    this.onboardingPending.push(withId); return withId
  }
  async getPendingOnboarding(groupId) {
    return this.onboardingPending.filter(o => o.group_id === String(groupId) && o.status === 'pending')
  }
  async completeOnboarding(id) {
    const o = this.onboardingPending.find(x => x.id === id)
    if (o) { o.status = 'complete'; o.completed_at = this._ts() }
    return o
  }

  // ── Cross-training / recurring constraints ───────────────────────────────
  async saveCrossTraining(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.crossTraining.push(withId); return withId
  }
  async getCrossTrainingForStaff(staffId) {
    return this.crossTraining.filter(c => c.staff_id === staffId)
  }
  async getCrossTrainedForRole(groupId, role) {
    return this.crossTraining.filter(c => c.group_id === String(groupId) &&
      c.role.toLowerCase() === String(role).toLowerCase() && c.proficiency !== 'training')
  }
  async getAllCrossTraining(groupId) {
    return this.crossTraining.filter(c => c.group_id === String(groupId))
  }
  async removeCrossTraining(staffId, role) {
    this.crossTraining = this.crossTraining.filter(c => !(c.staff_id === staffId && c.role === role))
  }
  async saveRecurringConstraint(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.recurringConstraints.push(withId); return withId
  }
  async getRecurringConstraints(staffId) {
    return this.recurringConstraints.filter(c => c.staff_id === staffId)
  }
  async getGroupRecurringConstraints(groupId) {
    return this.recurringConstraints.filter(c => c.group_id === String(groupId))
  }
  async deactivateConstraint(id) {
    const c = this.recurringConstraints.find(x => x.id === id)
    if (c) c.active = false
    return c
  }

  // ── Preferences / learning ───────────────────────────────────────────────
  async savePreference(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.learnedPreferences.push(withId); return withId
  }
  async getPreferences(groupId) {
    return this.learnedPreferences.filter(p => p.group_id === String(groupId))
  }
  async saveDiscoveredPattern(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.discoveredPatterns.push(withId); return withId
  }
  async getDiscoveredPatternsThisWeek(groupId, weekStart) {
    return this.discoveredPatterns.filter(p => p.group_id === String(groupId) && p.week_start === weekStart)
  }
  async getDismissedPatterns(groupId) {
    return this.dismissedPatterns.filter(p => p.group_id === String(groupId))
  }
  async dismissPattern(groupId, pattern) {
    this.dismissedPatterns.push({ id: this._nextId(), group_id: String(groupId), ...pattern, dismissed_at: this._ts() })
  }

  // ── Receipts / on-call / no-show ─────────────────────────────────────────
  async saveReceipt(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.scheduleReceipts.push(withId); return withId
  }
  async getPendingReceipt(groupId, weekStart) {
    return this.scheduleReceipts.filter(r => r.group_id === String(groupId) && r.week_start === weekStart && r.status !== 'confirmed')
  }
  async updateReceiptStatus(id, status) {
    const r = this.scheduleReceipts.find(x => x.id === id)
    if (r) r.status = status
    return r
  }
  async getUnconfirmedSchedule(groupId, weekStart) {
    return this.getPendingReceipt(groupId, weekStart)
  }
  async getUnconfirmedSchedules(groupId, weekStart) { return this.getUnconfirmedSchedule(groupId, weekStart) }
  async saveOnCall(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.onCall.push(withId); return withId
  }
  async getOnCallStaff(groupId, weekStart) {
    return this.onCall.filter(o => o.group_id === String(groupId) && o.week_start === weekStart)
  }
  async clearWeekOnCall(groupId, weekStart) {
    this.onCall = this.onCall.filter(o => !(o.group_id === String(groupId) && o.week_start === weekStart))
  }
  async markWarned(assignmentId, groupId) {
    this.noshowWarnings.push({ id: this._nextId(), assignment_id: assignmentId, group_id: String(groupId), created_at: this._ts() })
  }
  async wasWarned(assignmentId) {
    return this.noshowWarnings.some(w => w.assignment_id === assignmentId)
  }

  // ── Setup session / groups ───────────────────────────────────────────────
  async getSetupSession(groupId) {
    return this.setupSessions.find(s => s.group_id === String(groupId)) ?? null
  }
  async updateSetupSession(groupId, data) {
    const idx = this.setupSessions.findIndex(s => s.group_id === String(groupId))
    if (idx >= 0) Object.assign(this.setupSessions[idx], data)
    else this.setupSessions.push({ id: this._nextId(), group_id: String(groupId), ...data })
    return this.setupSessions[idx >= 0 ? idx : this.setupSessions.length - 1]
  }
  async getConfiguredGroups() {
    return this.setupSessions.map(s => s.group_id)
  }
  async getManagerGroup(managerId) {
    return this.setupSessions.find(s => s.manager_id === managerId) ?? null
  }
  async getManagerDmChatId(groupId) {
    const s = this.setupSessions.find(x => x.group_id === String(groupId))
    return s?.dm_chat_id ?? null
  }
  async getGroupForUser(userId) {
    const staff = this.staff.find(s => s.user_id === userId || s.dm_chat_id == userId)
    if (staff) return { group_id: staff.group_id }
    return this.setupSessions.find(s => s.manager_id === userId) ?? null
  }
  async logManagerAction(groupId, managerId, action) {
    // no-op — just capture
    if (!this._managerActions) this._managerActions = []
    this._managerActions.push({ group_id: String(groupId), manager_id: managerId, action, at: this._ts() })
  }

  // ── Shift CRUD (for dashboard routes) ────────────────────────────────────
  async createShift(row) {
    const withId = { id: this._nextId(), ...row, created_at: this._ts() }
    this.shifts.push(withId); return withId
  }
  async updateShift(id, data) {
    const s = this.shifts.find(x => x.id === id)
    if (s) Object.assign(s, data)
    return s
  }
  async deactivateShift(id) {
    this.shifts = this.shifts.filter(s => s.id !== id)
  }
  async deactivateShiftFn(id) { return this.deactivateShift(id) }
  async deactivateStaff(id) {
    const s = this.staff.find(x => x.id === id)
    if (s) s.active = false
    return s
  }
}

function prevWeekStart(ws) {
  const d = new Date(ws + 'T00:00:00Z')
  d.setDate(d.getDate() - 7)
  return d.toISOString().slice(0, 10)
}

export function formatDate(d) { return d.toISOString().slice(0, 10) }
