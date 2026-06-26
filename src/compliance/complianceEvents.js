// Compliance audit log + reports (Epic 4 / WP-4.6).
//
// Append-only record of labor-law compliance events (minor violations, required
// breaks, predictive-scheduling changes, predictability pay, manager overrides)
// plus an exportable audit report. group_id-scoped; db-mock as the last param.

import { getDb } from '../db.js'
import { logger } from '../logger.js'

export const EVENT_TYPES = new Set([
  'minor_violation', 'break_required', 'schedule_change', 'predictability_pay', 'override',
])
const VALID_SEVERITY = new Set(['info', 'warn', 'block'])

/**
 * Append one compliance event.
 * @returns saved row, or null on failure / invalid input.
 */
export async function recordEvent(event = {}, db = null) {
  const { groupId, eventType } = event
  if (!groupId || !eventType) { logger.error('recordEvent: groupId and eventType required'); return null }
  const severity = VALID_SEVERITY.has(event.severity) ? event.severity : 'info'
  const row = {
    group_id: String(groupId),
    staff_id: event.staffId != null ? event.staffId : null,
    event_type: String(eventType),
    code: event.code != null ? String(event.code) : null,
    severity,
    week_start: event.weekStart ?? null,
    meta: event.meta ?? {},
    created_by: event.actorId != null ? String(event.actorId) : null,
  }

  if (db?.insertComplianceEvent) return db.insertComplianceEvent(row)
  try {
    const { data, error } = await getDb()
      .from('compliance_events')
      .insert([row])
      .select()
      .single()
    if (error) { logger.error(`recordEvent failed: ${error.message}`); return null }
    return data
  } catch (err) {
    logger.error(`recordEvent error: ${err.message}`)
    return null
  }
}

/**
 * Persist every violation from an evaluateScheduleCompliance() result as
 * `minor_violation` events. Returns the saved rows.
 */
export async function recordScheduleViolations(evalResult, ctx = {}, db = null) {
  const issues = evalResult?.issues ?? []
  const saved = []
  for (const i of issues) {
    const row = await recordEvent({
      groupId: ctx.groupId,
      staffId: i.staffId ?? null,
      eventType: 'minor_violation',
      code: i.code,
      severity: i.severity ?? 'block',
      weekStart: ctx.weekStart ?? null,
      actorId: ctx.actorId ?? null,
      meta: { day: i.day, age: i.age, message: i.message, shiftName: i.shiftName ?? null },
    }, db)
    if (row) saved.push(row)
  }
  return saved
}

/**
 * Read compliance events for a tenant.
 * @param {object} [opts] - { eventType, since (ISO), limit=100 }
 */
export async function getEvents(groupId, opts = {}, db = null) {
  const { eventType = null, since = null, limit = 100 } = opts
  if (!groupId) { logger.error('getEvents: groupId required'); return [] }
  if (db?.getComplianceEvents) return db.getComplianceEvents(String(groupId), { eventType, since, limit })
  try {
    let q = getDb().from('compliance_events').select('*').eq('group_id', String(groupId))
    if (eventType) q = q.eq('event_type', eventType)
    if (since) q = q.gte('created_at', since)
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit)
    if (error) { logger.error(`getEvents failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) {
    logger.error(`getEvents error: ${err.message}`)
    return []
  }
}

/** Build a structured audit report from a list of events (pure). */
export function buildComplianceAuditReport(events = []) {
  const byType = {}
  const byCode = {}
  const bySeverity = {}
  let periodStart = null
  let periodEnd = null
  for (const e of events) {
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
    if (e.code) byCode[e.code] = (byCode[e.code] ?? 0) + 1
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1
    const t = e.created_at ? new Date(e.created_at).getTime() : null
    if (t != null) {
      if (periodStart == null || t < periodStart) periodStart = t
      if (periodEnd == null || t > periodEnd) periodEnd = t
    }
  }
  return {
    totalEvents: events.length,
    byType, byCode, bySeverity,
    blocks: bySeverity.block ?? 0,
    periodStart: periodStart != null ? new Date(periodStart).toISOString() : null,
    periodEnd: periodEnd != null ? new Date(periodEnd).toISOString() : null,
  }
}

/** Render the audit report as Telegram/markdown text (pure). */
export function formatComplianceAuditReport(report, events = []) {
  if (!report || report.totalEvents === 0) return '🛡️ *Compliance audit*\n\n✅ No compliance events on record.'
  const lines = ['🛡️ *Compliance audit report*']
  lines.push(`\n${report.totalEvents} event${report.totalEvents === 1 ? '' : 's'}` +
    (report.blocks ? ` — ⚠️ ${report.blocks} blocking violation${report.blocks === 1 ? '' : 's'}` : ''))
  lines.push('\n*By type:*')
  for (const [type, n] of Object.entries(report.byType)) lines.push(`• ${type}: ${n}`)
  if (Object.keys(report.byCode).length > 0) {
    lines.push('\n*By rule:*')
    for (const [code, n] of Object.entries(report.byCode)) lines.push(`• ${code}: ${n}`)
  }
  const recent = (events || []).slice(0, 10)
  if (recent.length > 0) {
    lines.push('\n*Recent:*')
    for (const e of recent) {
      const when = e.created_at ? String(e.created_at).slice(0, 10) : ''
      lines.push(`• ${when} ${e.event_type}${e.code ? ` (${e.code})` : ''}${e.meta?.message ? ` — ${e.meta.message}` : ''}`)
    }
  }
  return lines.join('\n')
}
