// Telegram adapter — pure pass-through to node-telegram-bot-api.
// Zero behavior change from the raw TelegramBot instance.

import { PlatformAdapter } from './PlatformAdapter.js'

export class TelegramAdapter extends PlatformAdapter {
  constructor(telegramBot) {
    super('telegram')
    this._bot = telegramBot
  }

  // ── Handler methods (used by all handlers) ─────────────────

  async sendMessage(chatId, text, options = {}) {
    return this._bot.sendMessage(chatId, text, options)
  }

  async sendDocument(chatId, document, options = {}) {
    return this._bot.sendDocument(chatId, document, options)
  }

  async getChatMember(chatId, userId) {
    return this._bot.getChatMember(chatId, userId)
  }

  async getMe() {
    return this._bot.getMe()
  }

  async getChat(chatId) {
    return this._bot.getChat(chatId)
  }

  async editMessageText(text, options = {}) {
    return this._bot.editMessageText(text, options)
  }

  normalizeMessage(msg) {
    // Telegram messages are already in the standard shape
    return msg
  }

  // ── Telegram-only methods (used by index.js only) ──────────
  // Other adapters don't need these — routing comes from webhooks.

  onText(regexp, fn) {
    return this._bot.onText(regexp, fn)
  }

  on(event, fn) {
    return this._bot.on(event, fn)
  }

  deleteWebHook(options) {
    return this._bot.deleteWebHook(options)
  }

  startPolling(options) {
    return this._bot.startPolling(options)
  }

  stopPolling() {
    return this._bot.stopPolling()
  }
}
