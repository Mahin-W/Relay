// UnifiedBot — drop-in replacement for the TelegramBot instance.
// Routes every call to the correct platform adapter.
// Phase 1: always routes to Telegram. Phase 2+: resolves per chatId.

export class UnifiedBot {
  constructor() {
    this._adapters = new Map()
    this._defaultPlatform = 'telegram'
  }

  registerAdapter(platform, adapter) {
    this._adapters.set(platform, adapter)
  }

  // Phase 1: always returns the default (telegram) adapter.
  // Phase 2+: will look up platform_contacts table + cache.
  _getAdapter(platform) {
    return this._adapters.get(platform || this._defaultPlatform)
  }

  _getDefault() {
    return this._adapters.get(this._defaultPlatform)
  }

  // ── Methods handlers call ──────────────────────────────────
  // Signatures match TelegramBot exactly so handlers don't change.

  async sendMessage(chatId, text, options = {}) {
    return this._getDefault().sendMessage(chatId, text, options)
  }

  async sendDocument(chatId, document, options = {}) {
    return this._getDefault().sendDocument(chatId, document, options)
  }

  async getChatMember(chatId, userId) {
    return this._getDefault().getChatMember(chatId, userId)
  }

  async getMe() {
    return this._getDefault().getMe()
  }

  async getChat(chatId) {
    return this._getDefault().getChat(chatId)
  }

  async createChatInviteLink(chatId, options = {}) {
    return this._getDefault().createChatInviteLink(chatId, options)
  }

  async exportChatInviteLink(chatId) {
    return this._getDefault().exportChatInviteLink(chatId)
  }

  async editMessageText(text, options = {}) {
    return this._getDefault().editMessageText(text, options)
  }

  // ── Telegram-only pass-throughs ────────────────────────────
  // Only called from index.js. Other platforms use webhooks.

  onText(regexp, fn) {
    const adapter = this._getDefault()
    if (adapter?.onText) return adapter.onText(regexp, fn)
  }

  on(event, fn) {
    const adapter = this._getDefault()
    if (adapter?.on) return adapter.on(event, fn)
  }

  once(event, fn) {
    const adapter = this._getDefault()
    if (adapter?.once) return adapter.once(event, fn)
  }

  removeListener(event, fn) {
    const adapter = this._getDefault()
    if (adapter?.removeListener) return adapter.removeListener(event, fn)
  }

  deleteWebHook(options) {
    const adapter = this._getDefault()
    if (adapter?.deleteWebHook) return adapter.deleteWebHook(options)
    return Promise.resolve()
  }

  startPolling(options) {
    const adapter = this._getDefault()
    if (adapter?.startPolling) return adapter.startPolling(options)
  }

  stopPolling() {
    const adapter = this._getDefault()
    if (adapter?.stopPolling) return adapter.stopPolling()
  }
}
