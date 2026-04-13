import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UnifiedBot } from '../../platform/UnifiedBot.js'
import { TelegramAdapter } from '../../platform/TelegramAdapter.js'
import { PlatformAdapter } from '../../platform/PlatformAdapter.js'
import { stripMarkdown, formatForPlatform, truncateForSms } from '../../platform/formatters.js'

// Mock TelegramBot that records calls
class SpyBot {
  constructor() { this.calls = [] }
  sendMessage(chatId, text, opts) { this.calls.push({ method: 'sendMessage', chatId, text, opts }); return Promise.resolve({ message_id: 1 }) }
  sendDocument(chatId, doc, opts) { this.calls.push({ method: 'sendDocument', chatId, doc, opts }); return Promise.resolve({ message_id: 2 }) }
  getChatMember(chatId, userId) { this.calls.push({ method: 'getChatMember', chatId, userId }); return Promise.resolve({ status: 'administrator' }) }
  getMe() { this.calls.push({ method: 'getMe' }); return Promise.resolve({ id: 123, username: 'relay_bot', first_name: 'Relay' }) }
  getChat(chatId) { this.calls.push({ method: 'getChat', chatId }); return Promise.resolve({ id: chatId, title: 'Group', type: 'supergroup' }) }
  editMessageText(text, opts) { this.calls.push({ method: 'editMessageText', text, opts }); return Promise.resolve({}) }
  onText(re, fn) { this.calls.push({ method: 'onText', re }) }
  on(event, fn) { this.calls.push({ method: 'on', event }) }
  deleteWebHook(opts) { this.calls.push({ method: 'deleteWebHook' }); return Promise.resolve() }
  startPolling() { this.calls.push({ method: 'startPolling' }) }
  stopPolling() { this.calls.push({ method: 'stopPolling' }) }
}

describe('TelegramAdapter', { concurrency: true }, () => {
  it('sendMessage delegates to underlying bot', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    await adapter.sendMessage('123', 'hello', { parse_mode: 'Markdown' })
    assert.equal(spy.calls[0].method, 'sendMessage')
    assert.equal(spy.calls[0].chatId, '123')
    assert.equal(spy.calls[0].text, 'hello')
  })

  it('sendDocument delegates', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    await adapter.sendDocument('123', '/path/file.xlsx', { caption: 'Report' })
    assert.equal(spy.calls[0].method, 'sendDocument')
  })

  it('getChatMember delegates', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    const result = await adapter.getChatMember('g1', 'u1')
    assert.equal(result.status, 'administrator')
  })

  it('getMe delegates', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    const me = await adapter.getMe()
    assert.equal(me.username, 'relay_bot')
  })

  it('getChat delegates', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    const chat = await adapter.getChat('g1')
    assert.equal(chat.type, 'supergroup')
  })

  it('editMessageText delegates', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    await adapter.editMessageText('updated', { chat_id: '123' })
    assert.equal(spy.calls[0].method, 'editMessageText')
  })

  it('onText delegates', () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    adapter.onText(/^\/test/, () => {})
    assert.equal(spy.calls[0].method, 'onText')
  })

  it('on delegates', () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    adapter.on('message', () => {})
    assert.equal(spy.calls[0].method, 'on')
    assert.equal(spy.calls[0].event, 'message')
  })

  it('platform is telegram', () => {
    const adapter = new TelegramAdapter(new SpyBot())
    assert.equal(adapter.getPlatform(), 'telegram')
  })

  it('normalizeMessage returns msg unchanged', () => {
    const adapter = new TelegramAdapter(new SpyBot())
    const msg = { text: 'hello', chat: { id: 1 } }
    assert.deepStrictEqual(adapter.normalizeMessage(msg), msg)
  })

  it('deleteWebHook/startPolling/stopPolling delegate', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    await adapter.deleteWebHook({ drop_pending_updates: true })
    adapter.startPolling()
    adapter.stopPolling()
    const methods = spy.calls.map(c => c.method)
    assert.ok(methods.includes('deleteWebHook'))
    assert.ok(methods.includes('startPolling'))
    assert.ok(methods.includes('stopPolling'))
  })
})

describe('UnifiedBot', { concurrency: true }, () => {
  it('registerAdapter stores and sendMessage routes to it', async () => {
    const spy = new SpyBot()
    const adapter = new TelegramAdapter(spy)
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', adapter)
    await bot.sendMessage('123', 'hello', { parse_mode: 'Markdown' })
    assert.equal(spy.calls[0].method, 'sendMessage')
    assert.equal(spy.calls[0].text, 'hello')
  })

  it('sendDocument routes to adapter', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    await bot.sendDocument('123', '/file.xlsx', {})
    assert.equal(spy.calls[0].method, 'sendDocument')
  })

  it('getChatMember routes to adapter', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    const result = await bot.getChatMember('g1', 'u1')
    assert.equal(result.status, 'administrator')
  })

  it('getMe routes to adapter', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    const me = await bot.getMe()
    assert.equal(me.username, 'relay_bot')
  })

  it('getChat routes to adapter', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    const chat = await bot.getChat('g1')
    assert.equal(chat.type, 'supergroup')
  })

  it('editMessageText routes to adapter', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    await bot.editMessageText('updated', {})
    assert.equal(spy.calls[0].method, 'editMessageText')
  })

  it('onText passes through to telegram adapter', () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    bot.onText(/^\/test/, () => {})
    assert.equal(spy.calls[0].method, 'onText')
  })

  it('on passes through to telegram adapter', () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    bot.on('message', () => {})
    assert.equal(spy.calls[0].method, 'on')
  })

  it('deleteWebHook passes through', async () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    await bot.deleteWebHook({ drop_pending_updates: true })
    assert.equal(spy.calls[0].method, 'deleteWebHook')
  })

  it('stopPolling passes through', () => {
    const spy = new SpyBot()
    const bot = new UnifiedBot()
    bot.registerAdapter('telegram', new TelegramAdapter(spy))
    bot.stopPolling()
    assert.equal(spy.calls[0].method, 'stopPolling')
  })
})

describe('PlatformAdapter base', { concurrency: true }, () => {
  it('methods throw not implemented', async () => {
    const base = new PlatformAdapter('test')
    await assert.rejects(() => base.sendMessage('1', 'hi'), /not implemented/)
    await assert.rejects(() => base.sendDocument('1', 'f'), /not implemented/)
    await assert.rejects(() => base.getChatMember('1', '2'), /not implemented/)
    await assert.rejects(() => base.getMe(), /not implemented/)
    await assert.rejects(() => base.getChat('1'), /not implemented/)
    await assert.rejects(() => base.editMessageText('x'), /not implemented/)
    assert.throws(() => base.normalizeMessage({}), /not implemented/)
  })

  it('getPlatform returns constructor value', () => {
    assert.equal(new PlatformAdapter('sms').getPlatform(), 'sms')
    assert.equal(new PlatformAdapter('whatsapp').getPlatform(), 'whatsapp')
  })
})

describe('formatters', { concurrency: true }, () => {
  it('stripMarkdown removes *bold*', () => {
    assert.equal(stripMarkdown('*hello*'), 'hello')
    assert.equal(stripMarkdown('**hello**'), 'hello')
  })

  it('stripMarkdown removes _italic_', () => {
    assert.equal(stripMarkdown('_hello_'), 'hello')
  })

  it('stripMarkdown removes `code`', () => {
    assert.equal(stripMarkdown('`hello`'), 'hello')
  })

  it('stripMarkdown removes [text](url)', () => {
    assert.equal(stripMarkdown('[Click here](https://example.com)'), 'Click here')
  })

  it('stripMarkdown preserves plain text', () => {
    assert.equal(stripMarkdown('just plain text'), 'just plain text')
  })

  it('stripMarkdown handles null/undefined', () => {
    assert.equal(stripMarkdown(null), '')
    assert.equal(stripMarkdown(undefined), '')
    assert.equal(stripMarkdown(''), '')
  })

  it('stripMarkdown handles mixed formatting', () => {
    assert.equal(stripMarkdown('*bold* and _italic_ and `code`'), 'bold and italic and code')
  })

  it('formatForPlatform telegram passes through', () => {
    assert.equal(formatForPlatform('*bold*', 'telegram'), '*bold*')
  })

  it('formatForPlatform sms strips markdown', () => {
    assert.equal(formatForPlatform('*bold*', 'sms'), 'bold')
  })

  it('formatForPlatform whatsapp preserves bold', () => {
    assert.equal(formatForPlatform('*bold*', 'whatsapp'), '*bold*')
  })

  it('formatForPlatform unknown strips markdown', () => {
    assert.equal(formatForPlatform('*bold*', 'carrier_pigeon'), 'bold')
  })

  it('truncateForSms under limit unchanged', () => {
    assert.equal(truncateForSms('short message'), 'short message')
  })

  it('truncateForSms over limit truncated', () => {
    const long = 'a'.repeat(1700)
    const result = truncateForSms(long)
    assert.ok(result.length <= 1600)
    assert.ok(result.endsWith('[Message truncated]'))
  })

  it('truncateForSms handles null', () => {
    assert.equal(truncateForSms(null), '')
    assert.equal(truncateForSms(''), '')
  })
})
