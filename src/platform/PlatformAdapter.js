// Base class for all platform adapters.
// Every adapter (Telegram, SMS, WhatsApp) must implement these methods.

export class PlatformAdapter {
  constructor(platform) {
    this.platform = platform
  }

  async sendMessage(chatId, text, options = {}) {
    throw new Error(`${this.platform}: sendMessage not implemented`)
  }

  async sendDocument(chatId, document, options = {}) {
    throw new Error(`${this.platform}: sendDocument not implemented`)
  }

  async getChatMember(chatId, userId) {
    throw new Error(`${this.platform}: getChatMember not implemented`)
  }

  async getMe() {
    throw new Error(`${this.platform}: getMe not implemented`)
  }

  async getChat(chatId) {
    throw new Error(`${this.platform}: getChat not implemented`)
  }

  async editMessageText(text, options = {}) {
    throw new Error(`${this.platform}: editMessageText not implemented`)
  }

  normalizeMessage(rawPayload) {
    throw new Error(`${this.platform}: normalizeMessage not implemented`)
  }

  getPlatform() {
    return this.platform
  }
}
