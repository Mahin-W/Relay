// PaymentProvider interface (Epic 0 / WP-0.6, frozen contract for Epic 1/2).
//
// Owner-initiated paycheck model (per locked decisions): the owner triggers a
// pay run; money moves owner's bank → employee's bank; non-cash tips ride the
// paycheck; no instant payout, no EWA, no platform float.
//
// CHECK is the single rail (W-2 + 1099 + tax filing + direct deposit). This
// interface stays provider-agnostic so a different rail (or Stripe for 1099
// contractors only) can be swapped without touching call sites.

export class PaymentProvider {
  constructor(name) { this.name = name }

  /** Ensure an employee is enrolled as a payee. @returns {Promise<{payeeRef:string}>} */
  async ensurePayee(groupId, staffId) { throw notImpl(this.name, 'ensurePayee') }

  /** Hosted bank/KYC onboarding URL (Relay never stores raw bank data). @returns {Promise<string>} */
  async getOnboardingLink(groupId, staffId) { throw notImpl(this.name, 'getOnboardingLink') }

  /**
   * Pay one employee for a pay run.
   * @param {object} p
   * @param {string|number} p.groupId
   * @param {string|number} p.staffId
   * @param {number} p.grossCents      - wages before tax
   * @param {number} [p.tipCents]      - non-cash tips paid on this check
   * @param {'w2'|'1099'} p.taxType    - withholding vs. contractor pay
   * @param {string} p.idemKey         - idempotency key
   * @returns {Promise<{paymentRef:string, status:string}>}
   */
  async payEmployee(p) { throw notImpl(this.name, 'payEmployee') }

  /** Status of a previously initiated payment. @returns {Promise<{status:string}>} */
  async runStatus(paymentRef) { throw notImpl(this.name, 'runStatus') }

  /** Verify + parse a provider webhook payload. @returns {object} event */
  verifyWebhook(rawBody, signature) { throw notImpl(this.name, 'verifyWebhook') }

  isConfigured() { return false }
}

export class ProviderNotImplementedError extends Error {
  constructor(provider, method) {
    super(`${provider}: ${method} not implemented`)
    this.name = 'ProviderNotImplementedError'
    this.code = 'PROVIDER_NOT_IMPLEMENTED'
    this.provider = provider
    this.method = method
  }
}

function notImpl(provider, method) { return new ProviderNotImplementedError(provider, method) }
