// Employee direct-deposit onboarding (Epic 1 / WP-1.2).
//
// Drives the provider's HOSTED bank/KYC onboarding and tracks status. Relay
// stores only the provider reference + KYC status — never raw bank data.
//
// The live hosted link requires a configured payment provider (Check/Stripe
// key). Without one, startOnboarding returns { reason: 'not_configured' } so the
// surface can tell the user gracefully instead of throwing.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { logEvent } from '../lib/audit.js'
import { getPaymentProvider } from '../lib/money/providers.js'

// A provider that isn't set up yet throws one of these — treat as "not ready".
const NOT_READY_CODES = new Set(['PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_IMPLEMENTED'])

/** Current KYC status for an employee ('none' if never started). */
export async function getOnboardingStatus(groupId, staffId, db = null) {
  if (db?.getBankAccount) {
    const row = await db.getBankAccount(groupId, staffId)
    return row?.kyc_status ?? 'none'
  }
  try {
    const { data, error } = await getDb()
      .from('employee_bank_accounts')
      .select('kyc_status')
      .eq('group_id', String(groupId))
      .eq('staff_id', staffId)
      .maybeSingle()
    if (error) { logger.error(`getOnboardingStatus failed: ${error.message}`); return 'unknown' }
    return data?.kyc_status ?? 'none'
  } catch (err) {
    logger.error(`getOnboardingStatus error: ${err.message}`)
    return 'unknown'
  }
}

/**
 * Begin (or resume) hosted onboarding for an employee.
 * @returns {Promise<{ok:boolean, link?:string, reason?:string, error?:string}>}
 */
export async function startOnboarding({ groupId, staffId }, deps = {}) {
  const provider = deps.provider ?? getPaymentProvider()
  let payeeRef = null
  let link = null
  try {
    const payee = await provider.ensurePayee(groupId, staffId)
    payeeRef = payee?.payeeRef ?? null
    link = await provider.getOnboardingLink(groupId, staffId)
  } catch (err) {
    if (NOT_READY_CODES.has(err.code)) {
      logger.bot(`bank onboarding not available yet: ${err.message}`)
      return { ok: false, reason: 'not_configured' }
    }
    logger.error(`startOnboarding failed: ${err.message}`)
    return { ok: false, reason: 'error', error: err.message }
  }

  await upsertBankAccount({ groupId, staffId, provider: provider.name, providerRef: payeeRef, kycStatus: 'pending' }, deps.db ?? null)
  await logEvent({ groupId, actorId: staffId, actorType: 'staff', action: 'payout.onboarding.start', target: staffId, meta: { provider: provider.name } }, deps.db ?? null)
  return { ok: true, link }
}

async function upsertBankAccount({ groupId, staffId, provider, providerRef, kycStatus }, db = null) {
  const row = {
    group_id: String(groupId), staff_id: staffId, provider,
    provider_ref: providerRef, kyc_status: kycStatus, updated_at: new Date().toISOString(),
  }
  if (db?.upsertBankAccount) return db.upsertBankAccount(row)
  try {
    const { error } = await getDb().from('employee_bank_accounts').upsert(row, { onConflict: 'group_id,staff_id' })
    if (error) logger.error(`upsertBankAccount failed: ${error.message}`)
  } catch (err) {
    logger.error(`upsertBankAccount error: ${err.message}`)
  }
}
