import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerIntent, matchIntent, dispatchIntent, getIntent, listIntents,
  buildIntentPromptSection, _resetIntentsForTesting,
} from '../../parsers/intentRegistry.js'
import {
  registerCommand, dispatchCommand, getCommand, formatCommandHelp,
  _resetCommandsForTesting,
} from '../../lib/commandRegistry.js'

describe('intentRegistry', () => {
  beforeEach(() => _resetIntentsForTesting())

  it('matches a keyword (substring) trigger', () => {
    registerIntent({ name: 'pay_run_request', triggers: ['pay everyone', 'send out paychecks'] })
    assert.equal(matchIntent('can you pay everyone for this week')?.name, 'pay_run_request')
    assert.equal(matchIntent('SEND OUT PAYCHECKS now')?.name, 'pay_run_request')
  })

  it('matches a regex trigger and extracts fields', () => {
    registerIntent({
      name: 'payroll_setting_change',
      triggers: [/set (\w+) to (1099|w-?2)/i],
      extract: (t) => { const m = t.match(/set (\w+) to (1099|w-?2)/i); return { name: m?.[1], type: m?.[2] } },
    })
    const r = matchIntent('set Maria to 1099')
    assert.equal(r.name, 'payroll_setting_change')
    assert.deepEqual(r.fields, { name: 'Maria', type: '1099' })
  })

  it('returns null when nothing matches or text is empty', () => {
    registerIntent({ name: 'x', triggers: ['zzz'] })
    assert.equal(matchIntent('hello there'), null)
    assert.equal(matchIntent(''), null)
    assert.equal(matchIntent(null), null)
  })

  it('respects registration order (first match wins)', () => {
    registerIntent({ name: 'a', triggers: ['pay'] })
    registerIntent({ name: 'b', triggers: ['pay'] })
    assert.equal(matchIntent('pay')?.name, 'a')
  })

  it('matches consistently when a trigger uses the global flag', () => {
    registerIntent({ name: 'pay', triggers: [/pay/g] })
    assert.equal(matchIntent('pay now')?.name, 'pay')
    assert.equal(matchIntent('pay later')?.name, 'pay') // would be null if lastIndex weren't reset
    assert.equal(matchIntent('pay again')?.name, 'pay')
  })

  it('dispatchIntent runs the handler', async () => {
    let called = null
    registerIntent({ name: 'x', triggers: ['x'], handler: async (ctx) => { called = ctx } })
    const r = await dispatchIntent('x', { foo: 1 })
    assert.equal(r.handled, true)
    assert.deepEqual(called, { foo: 1 })
  })

  it('dispatchIntent returns handled:false for unknown/handler-less intents', async () => {
    registerIntent({ name: 'nohandler', triggers: ['x'] })
    assert.equal((await dispatchIntent('nohandler')).handled, false)
    assert.equal((await dispatchIntent('missing')).handled, false)
  })

  it('buildIntentPromptSection is empty without hints, lists hinted intents', () => {
    assert.equal(buildIntentPromptSection(), '')
    registerIntent({ name: 'x', triggers: ['x'], promptHint: 'user wants X' })
    assert.match(buildIntentPromptSection(), /ADDITIONAL INTENTS/)
    assert.match(buildIntentPromptSection(), /user wants X/)
  })

  it('validates registration', () => {
    assert.throws(() => registerIntent({ name: 'x' }), /triggers/)
    assert.throws(() => registerIntent({ triggers: ['x'] }), /name/)
  })

  it('getIntent / listIntents work', () => {
    registerIntent({ name: 'x', triggers: ['x'] })
    assert.ok(getIntent('x'))
    assert.equal(listIntents().length, 1)
  })
})

describe('commandRegistry', () => {
  beforeEach(() => _resetCommandsForTesting())

  it('dispatches a registered command', async () => {
    let ran = null
    registerCommand({ name: 'paypeople', handler: async (ctx) => { ran = ctx } })
    const r = await dispatchCommand('paypeople', { groupId: 'g1' })
    assert.equal(r.handled, true)
    assert.deepEqual(ran, { groupId: 'g1' })
  })

  it('resolves aliases', async () => {
    let ran = false
    registerCommand({ name: 'paypeople', aliases: ['payroll', 'pay'], handler: async () => { ran = true } })
    assert.ok(getCommand('payroll'))
    await dispatchCommand('pay')
    assert.equal(ran, true)
  })

  it('returns handled:false for an unknown command', async () => {
    const r = await dispatchCommand('nope')
    assert.equal(r.handled, false)
  })

  it('denies when role check fails and does not run handler', async () => {
    let ran = false
    let replied = null
    registerCommand({ name: 'paypeople', role: 'owner', handler: async () => { ran = true } })
    const r = await dispatchCommand('paypeople', {}, {
      isAuthorized: async () => false,
      reply: async (t) => { replied = t },
    })
    assert.equal(r.handled, true)
    assert.equal(r.denied, true)
    assert.equal(ran, false)
    assert.match(replied, /permission/)
  })

  it('fails CLOSED when a role is required but no isAuthorized is provided', async () => {
    let ran = false
    let replied = null
    registerCommand({ name: 'paypeople', role: 'owner', handler: async () => { ran = true } })
    const r = await dispatchCommand('paypeople', {}, { reply: async (t) => { replied = t } })
    assert.equal(r.denied, true)
    assert.equal(ran, false)
    assert.match(replied, /permission/)
  })

  it('runs when authorized', async () => {
    let ran = false
    registerCommand({ name: 'paypeople', role: 'owner', handler: async () => { ran = true } })
    const r = await dispatchCommand('paypeople', {}, { isAuthorized: async () => true })
    assert.equal(ran, true)
    assert.equal(r.denied, undefined)
  })

  it("role 'any' runs without an auth check", async () => {
    let ran = false
    registerCommand({ name: 'open', role: 'any', handler: async () => { ran = true } })
    await dispatchCommand('open')
    assert.equal(ran, true)
  })

  it('formatCommandHelp lists commands with help text', () => {
    registerCommand({ name: 'paypeople', handler: async () => {}, help: 'Pay the team' })
    registerCommand({ name: 'secret', handler: async () => {} }) // no help → excluded
    const help = formatCommandHelp()
    assert.match(help, /\/paypeople — Pay the team/)
    assert.doesNotMatch(help, /secret/)
  })

  it('validates registration', () => {
    assert.throws(() => registerCommand({ name: 'x' }), /handler/)
    assert.throws(() => registerCommand({ handler: async () => {} }), /name/)
  })
})
