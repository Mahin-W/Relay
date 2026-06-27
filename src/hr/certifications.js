// Certifications + expiry (Epic 5 / WP-5.4).
//
// Tracks staff certs and warns before they lapse; a pure scheduling guard blocks
// assigning someone to a role whose required cert is missing/expired. File
// storage (the actual cert image/PDF) is blocked-on-human (Supabase Storage);
// here we manage metadata + expiry logic, which is fully testable.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

const DAY_MS = 86400000
const dayStart = (d) => new Date(`${d}T00:00:00Z`).getTime()

// ── pure helpers ──────────────────────────────────────────────────────────────
export function isExpired(cert, asOf = new Date()) {
  if (!cert?.expires_date) return false
  const exp = dayStart(cert.expires_date)
  if (isNaN(exp)) return false
  return exp < new Date(asOf).getTime()
}

export function daysUntilExpiry(cert, asOf = new Date()) {
  if (!cert?.expires_date) return null
  const exp = dayStart(cert.expires_date)
  if (isNaN(exp)) return null
  return Math.ceil((exp - new Date(asOf).getTime()) / DAY_MS)
}

/** Certs expiring within `days` (in the future, not already expired). */
export function expiringWithin(certs, days, asOf = new Date()) {
  const now = new Date(asOf).getTime()
  const limit = now + days * DAY_MS
  return (certs ?? []).filter(c => {
    if (!c?.expires_date) return false
    const exp = dayStart(c.expires_date)
    return !isNaN(exp) && exp >= now && exp <= limit
  })
}

/** Scheduling guard: may this staff member work a role requiring `requiredType`? */
export function blockIfExpiredCert(certs, requiredType, asOf = new Date()) {
  if (!requiredType) return { blocked: false }
  const match = (certs ?? []).find(c => c.cert_type === requiredType)
  if (!match) return { blocked: true, reason: 'missing' }
  if (isExpired(match, asOf)) return { blocked: true, reason: 'expired' }
  return { blocked: false }
}

// ── wired ops ─────────────────────────────────────────────────────────────────
export async function addCertification(groupId, staffId, cert, actorId = null, db = null) {
  const row = {
    group_id: String(groupId), staff_id: staffId, cert_type: cert.certType,
    issued_date: cert.issuedDate ?? null, expires_date: cert.expiresDate ?? null, doc_ref: cert.docRef ?? null,
  }
  let saved
  if (db?.insertCertification) saved = await db.insertCertification(row)
  else {
    try {
      const { data, error } = await getDb().from('certifications').insert([row]).select().single()
      if (error) { logger.error(`addCertification failed: ${error.message}`); return null }
      saved = data
    } catch (err) { logger.error(`addCertification error: ${err.message}`); return null }
  }
  await logEvent({ groupId, actorId, actorType: actorId ? 'staff' : 'system', action: 'cert.add', target: staffId, meta: { certType: cert.certType, expiresDate: cert.expiresDate ?? null } }, db)
  return saved
}

export async function listCertifications(groupId, staffId, db = null) {
  if (db?.listCertifications) return db.listCertifications(groupId, staffId)
  try {
    const { data, error } = await getDb().from('certifications').select('*').eq('group_id', String(groupId)).eq('staff_id', staffId)
    if (error) { logger.error(`listCertifications failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) { logger.error(`listCertifications error: ${err.message}`); return [] }
}

export async function getGroupCertifications(groupId, db = null) {
  if (db?.getGroupCertifications) return db.getGroupCertifications(groupId)
  try {
    const { data, error } = await getDb().from('certifications').select('*').eq('group_id', String(groupId))
    if (error) { logger.error(`getGroupCertifications failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) { logger.error(`getGroupCertifications error: ${err.message}`); return [] }
}

/** Reminder runner: DM each staffer whose cert expires within `days`. */
export async function remindExpiringCerts(groupId, days = 14, deps = {}) {
  const getCerts = deps.getGroupCertifications ?? ((g) => getGroupCertifications(g, deps.db ?? null))
  const notifyFn = deps.notify
  const asOf = deps.asOf ?? new Date()
  const due = expiringWithin(await getCerts(groupId), days, asOf)
  for (const c of due) {
    const left = daysUntilExpiry(c, asOf)
    if (notifyFn) await notifyFn(c.staff_id, `📋 Your ${c.cert_type} certification expires in ${left} day${left === 1 ? '' : 's'} (${c.expires_date}). Please renew it.`, {})
  }
  return { reminded: due.length, certs: due }
}
