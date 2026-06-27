import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerSmsChannel } from '../../lib/channels/smsChannel.js'
import { registerWhatsAppChannel } from '../../lib/channels/whatsappChannel.js'
import { notify, hasChannel, _resetChannelsForTesting } from '../../lib/notify.js'

const smsContact = { getContactsForStaff: async () => [{ platform: 'sms', chatId: '+15551234567' }] }
const waContact = { getContactsForStaff: async () => [{ platform: 'whatsapp', chatId: 'wa:123' }] }

beforeEach(() => _resetChannelsForTesting())

describe('smsChannel shell', () => {
  it('registers an sms channel', () => {
    registerSmsChannel()
    assert.equal(hasChannel('sms'), true)
  })

  it('reports not-delivered (not configured) without creds', async () => {
    registerSmsChannel()
    const r = await notify('s1', 'hi', {}, smsContact)
    assert.equal(r.delivered, false)
    assert.equal(r.platform, 'sms')
    assert.match(r.error, /not configured/)
  })

  it('delivers when a real sender is provided', async () => {
    const sent = []
    registerSmsChannel({ send: async (to, msg) => sent.push({ to, msg }) })
    const r = await notify('s1', 'hi', {}, smsContact)
    assert.equal(r.delivered, true)
    assert.equal(r.platform, 'sms')
    assert.equal(sent[0].to, '+15551234567')
  })
})

describe('whatsappChannel shell', () => {
  it('registers + not-configured by default', async () => {
    registerWhatsAppChannel()
    assert.equal(hasChannel('whatsapp'), true)
    const r = await notify('s1', 'hi', {}, waContact)
    assert.equal(r.delivered, false)
    assert.match(r.error, /not configured/)
  })

  it('delivers with a provided sender', async () => {
    const sent = []
    registerWhatsAppChannel({ send: async (to, msg) => sent.push({ to, msg }) })
    const r = await notify('s1', 'hi', {}, waContact)
    assert.equal(r.delivered, true)
    assert.equal(sent[0].to, 'wa:123')
  })
})
