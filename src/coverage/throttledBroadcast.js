// throttledBroadcast.js — P1-13
//
// Shared helper for broadcasting DMs to many staff without hitting
// Telegram's ~30 msg/sec rate limit.
//
// Usage:
//   import { broadcastDMs } from './throttledBroadcast.js'
//
//   await broadcastDMs(
//     (chatId, text, opts) => bot.sendMessage(chatId, text, opts),
//     recipients,                  // [{ dmChatId, firstName, ... }]
//     (recipient) => 'message',    // builder — called per recipient
//     { delayMs: 100 }             // optional options
//   )

import { logger } from '../logger.js'

const DEFAULT_DELAY_MS = 100

/**
 * Sends a DM to each recipient sequentially with a small delay between sends.
 * Per-recipient errors are swallowed (logged + continued) so one bad send
 * never stops the rest of the broadcast.
 *
 * @param {Function} sendFn        - async (chatId, text, opts?) => void
 * @param {Array}    recipients    - array of objects, each must have `.dmChatId`
 * @param {Function} buildMessage  - (recipient) => string | { text, opts }
 * @param {Object}   [options]
 * @param {number}   [options.delayMs=100]  - ms to sleep between sends
 * @param {Function} [options._sleep]       - injectable sleep for testing
 * @param {Function} [options.onError]      - (err, recipient) => void callback for errors
 */
export async function broadcastDMs(sendFn, recipients, buildMessage, {
  delayMs = DEFAULT_DELAY_MS,
  _sleep = null,
  onError = null,
} = {}) {
  const sleep = _sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i]
    if (!recipient.dmChatId) continue

    try {
      const built = buildMessage(recipient)
      if (typeof built === 'string') {
        await sendFn(recipient.dmChatId, built)
      } else {
        // built = { text, opts }
        await sendFn(recipient.dmChatId, built.text, built.opts ?? {})
      }
    } catch (err) {
      logger.error(`broadcastDMs: send to ${recipient.dmChatId} (${recipient.firstName ?? '?'}) failed: ${err.message}`)
      if (onError) {
        try { onError(err, recipient) } catch (_) {}
      }
    }

    // Sleep after every send except the last one
    if (i < recipients.length - 1 && delayMs > 0) {
      await sleep(delayMs)
    }
  }
}
