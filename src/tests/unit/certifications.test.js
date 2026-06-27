import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExpired, daysUntilExpiry, expiringWithin, blockIfExpiredCert,
  addCertification, listCertifications, remindExpiringCerts,
} from '../../hr/certifications.js'
import { registerCertificationsFeature, parseCertType, formatCertList } from '../../hr/certificationsFeature.js'
import { matchIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'
import { getCommand, _resetCommandsForTesting } from '../../lib/commandRegistry.js'

const ASOF = new Date('2026-06-26T00:00:00Z')

describe('pure expiry helpers', () => {
  it('isExpired', () => {
    assert.equal(isExpired({ expires_date: '2026-06-01' }, ASOF), true)
    assert.equal(isExpired({ expires_date: '2026-12-01' }, ASOF), false)
    assert.equal(isExpired({ expires_date: null }, ASOF), false)
  })
  it('daysUntilExpiry', () => {
    assert.equal(daysUntilExpiry({ expires_date: '2026-07-06' }, ASOF), 10)
  })
  it('expiringWithin excludes already-expired and far-future', () => {
    const certs = [
      { cert_type: 'A', expires_date: '2026-06-01' }, // expired
      { cert_type: 'B', expires_date: '2026-07-05' }, // in 9d
      { cert_type: 'C', expires_date: '2026-09-01' }, // far
    ]
    const due = expiringWithin(certs, 14, ASOF)
    assert.deepEqual(due.map(c => c.cert_type), ['B'])
  })
})

describe('blockIfExpiredCert', () => {
  const certs = [{ cert_type: 'Food Handler', expires_date: '2026-12-01' }, { cert_type: 'CPR', expires_date: '2026-06-01' }]
  it('not blocked when valid cert present', () => {
    assert.deepEqual(blockIfExpiredCert(certs, 'Food Handler', ASOF), { blocked: false })
  })
  it('blocked when missing', () => {
    assert.deepEqual(blockIfExpiredCert(certs, 'ServSafe', ASOF), { blocked: true, reason: 'missing' })
  })
  it('blocked when expired', () => {
    assert.deepEqual(blockIfExpiredCert(certs, 'CPR', ASOF), { blocked: true, reason: 'expired' })
  })
  it('no requirement → not blocked', () => {
    assert.deepEqual(blockIfExpiredCert(certs, null, ASOF), { blocked: false })
  })
})

describe('addCertification', () => {
  it('inserts metadata + audits', async () => {
    const state = { rows: [], audits: [] }
    const db = {
      insertCertification: async (row) => { state.rows.push(row); return { id: 1, ...row } },
      insertAuditEvent: async (row) => { state.audits.push(row) },
    }
    const saved = await addCertification('g1', 5, { certType: 'Food Handler', expiresDate: '2027-01-01' }, 5, db)
    assert.equal(saved.cert_type, 'Food Handler')
    assert.ok(state.audits.some(a => a.action === 'cert.add'))
  })
})

describe('remindExpiringCerts', () => {
  it('notifies staff whose certs lapse within the window', async () => {
    const sent = []
    const certs = [
      { staff_id: 1, cert_type: 'Food Handler', expires_date: '2026-07-02' }, // 6d
      { staff_id: 2, cert_type: 'CPR', expires_date: '2026-09-01' }, // far
    ]
    const r = await remindExpiringCerts('g1', 14, {
      getGroupCertifications: async () => certs,
      notify: async (staffId, msg) => sent.push({ staffId, msg }),
      asOf: ASOF,
    })
    assert.equal(r.reminded, 1)
    assert.equal(sent[0].staffId, 1)
    assert.match(sent[0].msg, /Food Handler/)
  })
})

describe('parseCertType', () => {
  it('recognizes common cert types', () => {
    assert.equal(parseCertType('upload my food handler cert'), 'Food Handler')
    assert.equal(parseCertType('add my servsafe certification'), 'ServSafe')
    assert.equal(parseCertType('my alcohol service card'), 'Alcohol Service')
    assert.equal(parseCertType('random text'), null)
  })
})

describe('formatCertList', () => {
  it('shows status per cert', () => {
    const out = formatCertList([
      { cert_type: 'Food Handler', expires_date: '2026-12-01' },
      { cert_type: 'CPR', expires_date: '2026-06-01' },
      { cert_type: 'ServSafe', expires_date: '2026-07-05' },
    ], ASOF)
    assert.match(out, /Food Handler — ✅ valid/)
    assert.match(out, /CPR — ❌ expired/)
    assert.match(out, /ServSafe — ⚠️ expires in 9d/)
  })
  it('handles empty', () => assert.match(formatCertList([]), /no certifications/))
})

describe('registerCertificationsFeature', () => {
  beforeEach(() => { _resetIntentsForTesting(); _resetCommandsForTesting() })

  it('registers /certs + cert_upload intent', () => {
    registerCertificationsFeature()
    assert.ok(getCommand('certs'))
    assert.equal(matchIntent('upload my food handler cert')?.name, 'cert_upload')
  })

  it('/certs lists the caller certs', async () => {
    let replied = null
    registerCertificationsFeature({ listCertifications: async () => [{ cert_type: 'Food Handler', expires_date: '2026-12-01' }] })
    await getCommand('certs').handler({ groupId: 'g1', userId: 5, reply: async (t) => { replied = t } })
    assert.match(replied, /Food Handler/)
  })

  it('cert_upload logs the parsed type', async () => {
    let added = null, replied = null
    registerCertificationsFeature({ addCertification: async (g, s, cert) => { added = cert } })
    const intent = matchIntent('upload my servsafe cert')
    // simulate dispatch with the message text
    await (await import('../../parsers/intentRegistry.js')).getIntent('cert_upload').handler({ groupId: 'g1', userId: 5, text: 'upload my servsafe cert', reply: async (t) => { replied = t } })
    assert.equal(added.certType, 'ServSafe')
    assert.match(replied, /ServSafe/)
  })
})
