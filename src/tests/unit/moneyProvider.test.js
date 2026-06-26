import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PaymentProvider, ProviderNotImplementedError } from '../../lib/money/PaymentProvider.js'
import {
  getPaymentProvider, _resetProviderForTesting,
  NullProvider, CheckProvider, StripeProvider,
} from '../../lib/money/providers.js'
import { createWebhookRouter } from '../../lib/money/webhookRouter.js'

beforeEach(() => _resetProviderForTesting())

describe('PaymentProvider (base interface)', () => {
  it('throws ProviderNotImplementedError for every method', async () => {
    const p = new PaymentProvider('base')
    await assert.rejects(p.ensurePayee(), (e) => e instanceof ProviderNotImplementedError)
    await assert.rejects(p.payEmployee({}), (e) => e instanceof ProviderNotImplementedError)
    assert.throws(() => p.verifyWebhook('', ''), (e) => e instanceof ProviderNotImplementedError)
    assert.equal(p.isConfigured(), false)
  })
})

describe('getPaymentProvider', () => {
  it('defaults to NullProvider', () => {
    const p = getPaymentProvider({})
    assert.ok(p instanceof NullProvider)
    assert.equal(p.isConfigured(), false)
  })

  it('returns CheckProvider when PAYROLL_PROVIDER=check', () => {
    const p = getPaymentProvider({ PAYROLL_PROVIDER: 'check', CHECK_API_KEY: 'sk_test' })
    assert.ok(p instanceof CheckProvider)
    assert.equal(p.isConfigured(), true)
  })

  it('CheckProvider is unconfigured without an api key', () => {
    const p = getPaymentProvider({ PAYROLL_PROVIDER: 'check' })
    assert.ok(p instanceof CheckProvider)
    assert.equal(p.isConfigured(), false)
  })

  it('returns StripeProvider when PAYROLL_PROVIDER=stripe', () => {
    const p = getPaymentProvider({ PAYROLL_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk' })
    assert.ok(p instanceof StripeProvider)
    assert.equal(p.isConfigured(), true)
  })

  it('caches by provider key', () => {
    const a = getPaymentProvider({ PAYROLL_PROVIDER: 'check', CHECK_API_KEY: 'x' })
    const b = getPaymentProvider({ PAYROLL_PROVIDER: 'check', CHECK_API_KEY: 'x' })
    assert.equal(a, b)
  })
})

describe('NullProvider', () => {
  it('throws PROVIDER_NOT_CONFIGURED when used', async () => {
    const p = new NullProvider()
    await assert.rejects(p.payEmployee({}), (e) => e.code === 'PROVIDER_NOT_CONFIGURED')
  })
})

describe('CheckProvider scaffold', () => {
  it('throws a clear not-implemented-yet error pointing at the WP', async () => {
    const p = new CheckProvider({ apiKey: 'sk' })
    await assert.rejects(p.payEmployee({}), (e) => e instanceof ProviderNotImplementedError && e.provider === 'check' && /WP-1\.4/.test(e.message))
  })
})

describe('StripeProvider scaffold', () => {
  it('labels its errors stripe, not check', async () => {
    const p = new StripeProvider({ apiKey: 'sk' })
    await assert.rejects(p.payEmployee({}), (e) => e instanceof ProviderNotImplementedError && e.provider === 'stripe')
  })
})

describe('webhookRouter', () => {
  it('dispatches an event to its handler', async () => {
    const router = createWebhookRouter()
    let got = null
    router.on('payment.paid', async (evt) => { got = evt })
    const r = await router.dispatch({ type: 'payment.paid', id: 'e1' })
    assert.equal(r.handled, true)
    assert.equal(got.id, 'e1')
  })

  it('ignores unknown event types', async () => {
    const router = createWebhookRouter()
    const r = await router.dispatch({ type: 'something.else' })
    assert.equal(r.handled, false)
  })

  it('captures handler errors without throwing', async () => {
    const router = createWebhookRouter()
    router.on('x', async () => { throw new Error('boom') })
    const r = await router.dispatch({ type: 'x' })
    assert.equal(r.handled, false)
    assert.match(r.error, /boom/)
  })

  it('ingest verifies then dispatches', async () => {
    const router = createWebhookRouter()
    let got = null
    router.on('payment.paid', async (evt) => { got = evt })
    const verify = (body) => JSON.parse(body) // pretend-valid
    const r = await router.ingest(JSON.stringify({ type: 'payment.paid', id: 'e9' }), 'sig', verify)
    assert.equal(r.verified, true)
    assert.equal(r.handled, true)
    assert.equal(got.id, 'e9')
  })

  it('ingest rejects a bad signature without dispatching', async () => {
    const router = createWebhookRouter()
    let called = false
    router.on('payment.paid', async () => { called = true })
    const verify = () => { throw new Error('bad signature') }
    const r = await router.ingest('{}', 'sig', verify)
    assert.equal(r.verified, false)
    assert.equal(called, false)
    assert.match(r.error, /bad signature/)
  })

  it('validates on()', () => {
    const router = createWebhookRouter()
    assert.throws(() => router.on('', async () => {}), /required/)
  })
})
