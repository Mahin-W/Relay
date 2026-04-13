// Phase 2: SMS via Twilio
// Extends PlatformAdapter. Strips markdown, broadcasts for virtual groups,
// handles 1600-char SMS limit.

import { PlatformAdapter } from './PlatformAdapter.js'

export class TwilioSmsAdapter extends PlatformAdapter {
  constructor(twilioClient, fromNumber) {
    super('sms')
    this._client = twilioClient
    this._fromNumber = fromNumber
  }

  async sendMessage(chatId, text, options = {}) {
    throw new Error('Phase 2: SMS sendMessage not implemented')
  }

  async sendDocument(chatId, document, options = {}) {
    throw new Error('Phase 2: SMS sendDocument not implemented')
  }

  async getChatMember(chatId, userId) {
    // SMS: admin status comes from DB only
    throw new Error('Phase 2: SMS getChatMember not implemented')
  }

  async getMe() {
    return { id: 'sms-bot', username: 'relay-sms', first_name: 'Relay' }
  }

  async getChat(chatId) {
    throw new Error('Phase 2: SMS getChat not implemented')
  }

  normalizeMessage(twilioPayload) {
    // Twilio POST body → standard msg shape
    // { From: '+1...', Body: '...', MessageSid: '...' }
    throw new Error('Phase 2: SMS normalizeMessage not implemented')
  }
}
