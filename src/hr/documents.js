// HR document metadata (Epic 5 / WP-5.2).
//
// Tracks which HR docs exist for a staff member and whether they're signed.
// Stores only doc_type + provider doc_ref + signed_at — the actual file bytes
// and e-signature are with the storage/e-sign vendor (blocked-on-human).

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'

export async function addDocument(groupId, staffId, doc, actorId = null, db = null) {
  const row = {
    group_id: String(groupId), staff_id: staffId, doc_type: doc.docType,
    doc_ref: doc.docRef ?? null, signed_at: doc.signedAt ?? null,
  }
  let saved
  if (db?.insertDocument) saved = await db.insertDocument(row)
  else {
    try {
      const { data, error } = await getDb().from('documents').insert([row]).select().single()
      if (error) { logger.error(`addDocument failed: ${error.message}`); return null }
      saved = data
    } catch (err) { logger.error(`addDocument error: ${err.message}`); return null }
  }
  await logEvent({ groupId, actorId, actorType: actorId ? 'staff' : 'system', action: 'document.add', target: staffId, meta: { docType: doc.docType, signed: !!doc.signedAt } }, db)
  return saved
}

export async function listDocuments(groupId, staffId, db = null) {
  if (db?.listDocuments) return db.listDocuments(groupId, staffId)
  try {
    const { data, error } = await getDb().from('documents').select('*').eq('group_id', String(groupId)).eq('staff_id', staffId)
    if (error) { logger.error(`listDocuments failed: ${error.message}`); return [] }
    return data ?? []
  } catch (err) { logger.error(`listDocuments error: ${err.message}`); return [] }
}

/** Which of a required doc-type set is still missing/unsigned for a staffer. */
export function missingDocuments(docs, requiredTypes = [], { requireSigned = true } = {}) {
  return requiredTypes.filter(type => {
    const d = (docs ?? []).find(x => x.doc_type === type)
    if (!d) return true
    return requireSigned ? !d.signed_at : false
  })
}
