// Compliance reporting dual-surface (Epic 4 / WP-4.5 + WP-4.6).
//
//   • /compliance       — check the current published schedule for labor-law
//                         violations + required breaks (owner/manager).
//   • /complianceaudit  — exportable audit report from the compliance_events log.
// Thin adapter: all logic lives in scheduleCompliance.js / complianceEvents.js.
// External data access is injectable so the feature is unit-testable without a DB;
// live wiring passes the real loaders (one-liner in the router, later).

import { registerCommand } from '../lib/commandRegistry.js'
import { registerIntent } from '../parsers/intentRegistry.js'
import { getRuleset as defaultGetRuleset, getProfile as defaultGetProfile } from './complianceProfiles.js'
import { evaluateScheduleCompliance, formatComplianceReport } from './scheduleCompliance.js'
import {
  getEvents as defaultGetEvents, recordScheduleViolations as defaultRecordViolations,
  buildComplianceAuditReport, formatComplianceAuditReport,
} from './complianceEvents.js'
import { getPublishedSchedule } from '../availability/db/schedules.js'
import { getStaffForGroup } from '../setup/db/staff.js'

export function registerComplianceReportFeature(deps = {}) {
  const getRuleset = deps.getRuleset ?? defaultGetRuleset
  const getProfile = deps.getProfile ?? defaultGetProfile
  const loadSchedule = deps.loadSchedule ?? ((g) => getPublishedSchedule(g))
  const getStaff = deps.getStaff ?? ((g) => getStaffForGroup(g))
  const getEvents = deps.getEvents ?? defaultGetEvents
  const recordViolations = deps.recordViolations === false ? null : (deps.recordViolations ?? defaultRecordViolations)

  // ── /compliance — check the live schedule ──────────────────────────────────
  const reportHandler = async (ctx = {}) => {
    const reply = ctx.reply ?? deps.reply
    try {
      const sched = await loadSchedule(ctx.groupId)
      const assignments = sched?.assignments ?? []
      if (assignments.length === 0) {
        if (reply) await reply('No published schedule to check yet — generate and publish a schedule first.')
        return { ok: false, reason: 'no_schedule' }
      }
      const [ruleset, staff, profile] = await Promise.all([
        getRuleset(ctx.groupId, deps.db),
        getStaff(ctx.groupId),
        getProfile(ctx.groupId, deps.db),
      ])
      const location = [profile?.city, profile?.state].filter(Boolean).join(', ') || null
      const result = evaluateScheduleCompliance(assignments, staff, ruleset, { weekStart: sched?.week_start })

      if (recordViolations && result.issues.length > 0) {
        await recordViolations(result, { groupId: ctx.groupId, weekStart: sched?.week_start, actorId: ctx.actorId ?? ctx.userId ?? null }, deps.db)
      }
      if (reply) await reply(formatComplianceReport(result, { location }))
      return { ok: true, result }
    } catch (err) {
      if (reply) await reply('Couldn’t run the compliance check — please try again.')
      return { ok: false, reason: 'error', error: err.message }
    }
  }

  // ── /complianceaudit — exportable audit report ─────────────────────────────
  const auditHandler = async (ctx = {}) => {
    const reply = ctx.reply ?? deps.reply
    try {
      const events = await getEvents(ctx.groupId, { limit: 200 }, deps.db)
      const report = buildComplianceAuditReport(events)
      if (reply) await reply(formatComplianceAuditReport(report, events))
      return { ok: true, report, events }
    } catch (err) {
      if (reply) await reply('Couldn’t build the compliance audit — please try again.')
      return { ok: false, reason: 'error', error: err.message }
    }
  }

  registerCommand({ name: 'compliance', role: 'owner', help: 'Check the schedule for labor-law issues', handler: reportHandler })
  registerCommand({ name: 'complianceaudit', role: 'owner', help: 'Export the compliance audit log', handler: auditHandler })

  registerIntent({
    name: 'compliance_check',
    triggers: [/compliance check/i, /is (the|my|our) schedule legal/i, /labou?r law/i],
    promptHint: 'owner wants to check the schedule for labor-law compliance',
    handler: reportHandler,
  })

  return { reportHandler, auditHandler }
}
