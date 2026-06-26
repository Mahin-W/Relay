// Payment provider selection + scaffolds (Epic 0 / WP-0.6).
//
// getPaymentProvider() returns the configured rail. Default is NullProvider,
// which is safe to import everywhere and only throws if a money operation is
// actually attempted without configuration — so nothing breaks before Epic 1/2
// wire the real Check integration.
//
//   PAYROLL_PROVIDER=check   -> CheckProvider (primary rail, W-2 + 1099)
//   PAYROLL_PROVIDER=stripe  -> StripeProvider (1099/contractor pay only)
//   (unset / none)           -> NullProvider

import { PaymentProvider, ProviderNotImplementedError } from './PaymentProvider.js'
import { logger } from '../../logger.js'

let _cached = null
let _cachedKey = null

/**
 * @param {object} [env] - defaults to process.env (injectable for tests)
 * @returns {PaymentProvider}
 */
export function getPaymentProvider(env = process.env) {
  const key = env.PAYROLL_PROVIDER || 'none'
  if (_cached && _cachedKey === key) return _cached
  _cachedKey = key
  switch (key) {
    case 'check':  _cached = new CheckProvider({ apiKey: env.CHECK_API_KEY, webhookSecret: env.CHECK_WEBHOOK_SECRET }); break
    case 'stripe': _cached = new StripeProvider({ apiKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }); break
    default:       _cached = new NullProvider()
  }
  logger.bot(`[money] payment provider = ${_cached.name}${_cached.isConfigured() ? '' : ' (not configured)'}`)
  return _cached
}

export function _resetProviderForTesting() { _cached = null; _cachedKey = null }

/** Safe default — present so imports never fail; loud only if actually used. */
export class NullProvider extends PaymentProvider {
  constructor() { super('null') }
  isConfigured() { return false }
  async ensurePayee() { throw notConfigured() }
  async getOnboardingLink() { throw notConfigured() }
  async payEmployee() { throw notConfigured() }
  async runStatus() { throw notConfigured() }
  verifyWebhook() { throw notConfigured() }
}

/**
 * Check embedded payroll (W-2 + 1099 + tax filing + owner→employee deposit).
 * SCAFFOLD: the real API calls land in WP-1.1 (payEmployee/onboarding) and
 * WP-2.2 (tax enrollment). Methods throw a clear "not implemented yet" so the
 * wiring point is unambiguous.
 */
export class CheckProvider extends PaymentProvider {
  constructor({ apiKey, webhookSecret } = {}) {
    super('check')
    this._apiKey = apiKey || null
    this._webhookSecret = webhookSecret || null
  }
  isConfigured() { return !!this._apiKey }
  async ensurePayee() { throw todo('check', 'ensurePayee', 'WP-1.1') }
  async getOnboardingLink() { throw todo('check', 'getOnboardingLink', 'WP-1.2') }
  async payEmployee() { throw todo('check', 'payEmployee', 'WP-1.4') }
  async runStatus() { throw todo('check', 'runStatus', 'WP-1.5') }
  verifyWebhook() { throw todo('check', 'verifyWebhook', 'WP-1.5') }
}

/** Stripe — 1099/contractor pay only (optional lane). SCAFFOLD. */
export class StripeProvider extends PaymentProvider {
  constructor({ apiKey, webhookSecret } = {}) {
    super('stripe')
    this._apiKey = apiKey || null
    this._webhookSecret = webhookSecret || null
  }
  isConfigured() { return !!this._apiKey }
  async ensurePayee() { throw todo('stripe', 'ensurePayee', 'WP-1.1 (stripe lane)') }
  async getOnboardingLink() { throw todo('stripe', 'getOnboardingLink', 'WP-1.2 (stripe lane)') }
  async payEmployee() { throw todo('stripe', 'payEmployee', 'WP-1.4 (stripe lane)') }
  async runStatus() { throw todo('stripe', 'runStatus', 'WP-1.5 (stripe lane)') }
  verifyWebhook() { throw todo('stripe', 'verifyWebhook', 'WP-1.5 (stripe lane)') }
}

function notConfigured() {
  const e = new Error('No payment provider configured — set PAYROLL_PROVIDER=check and CHECK_API_KEY')
  e.code = 'PROVIDER_NOT_CONFIGURED'
  return e
}
function todo(provider, method, wp) { return new ProviderNotImplementedError(provider, `${method} (implement in ${wp})`) }
