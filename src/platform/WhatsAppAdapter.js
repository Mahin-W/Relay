// Phase 3: WhatsApp via Meta Cloud API
// Supports groups (Oct 2025 API), 24hr messaging window,
// template fallback, and interactive buttons.

import { PlatformAdapter } from './PlatformAdapter.js'

export class WhatsAppAdapter extends PlatformAdapter {
  constructor(accessToken, phoneNumberId) {
    super('whatsapp')
    this._accessToken = accessToken
    this._phoneNumberId = phoneNumberId
  }

  async sendMessage(chatId, text, options = {}) {
    throw new Error('Phase 3: WhatsApp sendMessage not implemented')
  }

  async sendDocument(chatId, document, options = {}) {
    throw new Error('Phase 3: WhatsApp sendDocument not implemented')
  }

  async getChatMember(chatId, userId) {
    throw new Error('Phase 3: WhatsApp getChatMember not implemented')
  }

  async getMe() {
    return { id: 'wa-bot', username: 'relay-wa', first_name: 'Relay' }
  }

  async getChat(chatId) {
    throw new Error('Phase 3: WhatsApp getChat not implemented')
  }

  normalizeMessage(metaPayload) {
    // Meta Cloud API webhook → standard msg shape
    throw new Error('Phase 3: WhatsApp normalizeMessage not implemented')
  }

  // Phase 3: send pre-approved template when outside 24hr window
  async sendTemplate(chatId, templateName, params = {}) {
    throw new Error('Phase 3: WhatsApp sendTemplate not implemented')
  }
}
