import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpRateLimiter } from '../../server/ipRateLimit.js'

await Promise.all([
  test('allows first N requests within limit', () => {
    const limiter = createIpRateLimiter({ maxRequests: 3, windowMs: 60_000 })
    assert.equal(limiter.isAllowed('1.2.3.4'), true)
    assert.equal(limiter.isAllowed('1.2.3.4'), true)
    assert.equal(limiter.isAllowed('1.2.3.4'), true)
  }),

  test('blocks request exceeding limit (11th of 10 allowed)', () => {
    const limiter = createIpRateLimiter({ maxRequests: 10, windowMs: 60_000 })
    for (let i = 0; i < 10; i++) limiter.isAllowed('10.0.0.1')
    assert.equal(limiter.isAllowed('10.0.0.1'), false, 'request 11 should be blocked')
  }),

  test('different IPs have independent counts', () => {
    const limiter = createIpRateLimiter({ maxRequests: 2, windowMs: 60_000 })
    limiter.isAllowed('1.1.1.1')
    limiter.isAllowed('1.1.1.1')
    // 1.1.1.1 now exhausted; 2.2.2.2 should still be allowed
    assert.equal(limiter.isAllowed('2.2.2.2'), true)
    // 1.1.1.1 blocked
    assert.equal(limiter.isAllowed('1.1.1.1'), false)
  }),

  test('window expiry resets the count', async () => {
    const limiter = createIpRateLimiter({ maxRequests: 1, windowMs: 50 })
    limiter.isAllowed('9.9.9.9') // 1st request — ok
    assert.equal(limiter.isAllowed('9.9.9.9'), false, 'should be blocked before window expires')
    await new Promise(r => setTimeout(r, 60)) // wait past windowMs
    assert.equal(limiter.isAllowed('9.9.9.9'), true, 'should be allowed after window expires')
  }),

  test('isAllowed returns true below limit', () => {
    const limiter = createIpRateLimiter({ maxRequests: 5, windowMs: 60_000 })
    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.isAllowed('5.5.5.5'), true)
    }
  }),

  test('exact boundary: maxRequests-th call is allowed, next is not', () => {
    const limiter = createIpRateLimiter({ maxRequests: 3, windowMs: 60_000 })
    assert.equal(limiter.isAllowed('7.7.7.7'), true)
    assert.equal(limiter.isAllowed('7.7.7.7'), true)
    assert.equal(limiter.isAllowed('7.7.7.7'), true)  // 3rd — exactly at limit, still ok
    assert.equal(limiter.isAllowed('7.7.7.7'), false) // 4th — blocked
  }),
])
