import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  notify, notifyGroup, registerChannel, hasChannel, _resetChannelsForTesting,
} from '../../lib/notify.js'

function dbWith(contacts) {
  return { getContactsForStaff: async () => contacts }
}

beforeEach(() => _resetChannelsForTesting())

describe('registerChannel / hasChannel', () => {
  it('registers a channel', () => {
    registerChannel('telegram', async () => {})
    assert.equal(hasChannel('telegram'), true)
    assert.equal(hasChannel('sms'), false)
  })

  it('rejects a bad registration', () => {
    assert.throws(() => registerChannel('telegram', null), /required/)
  })
})

describe('notify', () => {
  it('delivers via telegram when contact + channel exist', async () => {
    const sent = []
    registerChannel('telegram', async (chatId, text, opts) => sent.push({ chatId, text, opts }))
    const res = await notify('s1', 'hi', { parse_mode: 'Markdown' }, dbWith([
      { platform: 'telegram', chatId: '999' },
    ]))
    assert.deepEqual(res, { delivered: true, platform: 'telegram' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, '999')
    assert.equal(sent[0].text, 'hi')
    assert.deepEqual(sent[0].opts, { parse_mode: 'Markdown' })
  })

  it('prefers telegram over sms when both are available', async () => {
    const hits = []
    registerChannel('telegram', async () => hits.push('telegram'))
    registerChannel('sms', async () => hits.push('sms'))
    const res = await notify('s1', 'hi', {}, dbWith([
      { platform: 'sms', chatId: '+15551234567' },
      { platform: 'telegram', chatId: '999' },
    ]))
    assert.equal(res.platform, 'telegram')
    assert.deepEqual(hits, ['telegram']) // only one delivery
  })

  it('falls back to sms when only an sms contact exists', async () => {
    const hits = []
    registerChannel('telegram', async () => hits.push('telegram'))
    registerChannel('sms', async () => hits.push('sms'))
    const res = await notify('s1', 'hi', {}, dbWith([
      { platform: 'sms', chatId: '+15551234567' },
    ]))
    assert.equal(res.platform, 'sms')
    assert.deepEqual(hits, ['sms'])
  })

  it('returns not-delivered when staff has no contacts', async () => {
    registerChannel('telegram', async () => {})
    const res = await notify('s1', 'hi', {}, dbWith([]))
    assert.equal(res.delivered, false)
  })

  it('returns not-delivered when no channel is registered for the contact', async () => {
    const res = await notify('s1', 'hi', {}, dbWith([{ platform: 'telegram', chatId: '999' }]))
    assert.equal(res.delivered, false)
  })

  it('surfaces a channel send failure', async () => {
    registerChannel('telegram', async () => { throw new Error('telegram 403') })
    const res = await notify('s1', 'hi', {}, dbWith([{ platform: 'telegram', chatId: '999' }]))
    assert.equal(res.delivered, false)
    assert.equal(res.platform, 'telegram')
    assert.match(res.error, /403/)
  })

  it('validates args', async () => {
    assert.equal((await notify(null, 'hi', {}, dbWith([]))).delivered, false)
    assert.equal((await notify('s1', '', {}, dbWith([]))).delivered, false)
  })
})

describe('notifyGroup', () => {
  it('delivers to the group via telegram', async () => {
    const sent = []
    registerChannel('telegram', async (chatId, text) => sent.push({ chatId, text }))
    const res = await notifyGroup('-100777', 'team update')
    assert.deepEqual(res, { delivered: true, platform: 'telegram' })
    assert.equal(sent[0].chatId, '-100777')
  })

  it('returns not-delivered when telegram is not registered', async () => {
    const res = await notifyGroup('-100777', 'team update')
    assert.equal(res.delivered, false)
  })
})
