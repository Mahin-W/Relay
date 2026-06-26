// Provider webhook router scaffold (Epic 0 / WP-0.6).
//
// A small, transport-agnostic dispatcher: verify the signature, parse the
// event, route it to a registered handler by type. The Express endpoint that
// feeds raw body + signature into ingest() is wired in WP-1.5 / WP-2.x; the
// routing core lives here so it's unit-testable without a server.
//
//   const router = createWebhookRouter()
//   router.on('payment.paid', async (evt) => { ... })
//   await router.ingest(rawBody, signature, (body, sig) => provider.verifyWebhook(body, sig))

import { logger } from '../../logger.js'

export function createWebhookRouter() {
  const handlers = new Map()

  return {
    /** Register a handler for an event type. */
    on(eventType, handler) {
      if (!eventType || typeof handler !== 'function') {
        throw new Error('webhookRouter.on: eventType and handler required')
      }
      handlers.set(eventType, handler)
      return this
    },

    /** Route an already-verified event object to its handler. */
    async dispatch(event) {
      const type = event?.type
      const handler = type && handlers.get(type)
      if (!handler) {
        logger.bot(`[webhook] no handler for event type '${type}' — ignored`)
        return { handled: false, type }
      }
      try {
        await handler(event)
        return { handled: true, type }
      } catch (err) {
        logger.error(`[webhook] handler for '${type}' threw: ${err.message}`)
        return { handled: false, type, error: err.message }
      }
    },

    /**
     * Verify + parse a raw payload, then dispatch.
     * @param {string|Buffer} rawBody
     * @param {string} signature
     * @param {(rawBody, signature)=>object} verify - throws on bad signature, returns the event
     */
    async ingest(rawBody, signature, verify) {
      let event
      try {
        event = verify(rawBody, signature)
      } catch (err) {
        logger.error(`[webhook] signature verification failed: ${err.message}`)
        return { handled: false, verified: false, error: err.message }
      }
      const result = await this.dispatch(event)
      return { ...result, verified: true }
    },

    listTypes() { return [...handlers.keys()] },
  }
}
