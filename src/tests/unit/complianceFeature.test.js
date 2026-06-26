import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerComplianceFeature, parseLocation } from '../../compliance/complianceFeature.js'
import { resolveRuleset } from '../../compliance/complianceProfiles.js'
import {
  getCommand, dispatchCommand, _resetCommandsForTesting,
} from '../../lib/commandRegistry.js'
import {
  matchIntent, getIntent, _resetIntentsForTesting,
} from '../../parsers/intentRegistry.js'

// A setProfile stand-in that records calls and echoes a realistic saved row.
function makeSave() {
  const calls = []
  const fn = async (groupId, loc, actorId) => {
    calls.push({ groupId, loc, actorId })
    return {
      group_id: String(groupId), state: loc.state, city: loc.city,
      ruleset: resolveRuleset(loc.state, loc.city), updated_by: String(actorId),
    }
  }
  return { fn, calls }
}

describe('parseLocation', () => {
  const cases = [
    ['CA', { state: 'CA', city: null }],
    ['California', { state: 'CA', city: null }],
    ['San Francisco, CA', { state: 'CA', city: 'San Francisco' }],
    ['San Francisco California', { state: 'CA', city: 'San Francisco' }],
    ['set location to NY', { state: 'NY', city: null }],
    ["we're in Chicago, IL", { state: 'IL', city: 'Chicago' }],
    ['', { state: null, city: null }],
  ]
  for (const [input, expected] of cases) {
    it(`parses "${input}"`, () => assert.deepEqual(parseLocation(input), expected))
  }
})

describe('registerComplianceFeature wiring', () => {
  beforeEach(() => { _resetCommandsForTesting(); _resetIntentsForTesting() })

  it('registers the /setlocation command (owner-gated) and set_location intent', () => {
    registerComplianceFeature()
    const cmd = getCommand('setlocation')
    assert.ok(cmd)
    assert.equal(cmd.role, 'owner')
    assert.ok(getIntent('set_location'))
  })

  it('owner sets location via command → saves and confirms', async () => {
    const save = makeSave()
    const replies = []
    registerComplianceFeature({ setProfile: save.fn })
    const res = await dispatchCommand(
      'setlocation',
      { groupId: 'g1', userId: 7, text: 'San Francisco, CA', reply: (m) => replies.push(m) },
      { isAuthorized: async () => true },
    )
    assert.equal(res.handled, true)
    assert.equal(save.calls.length, 1)
    assert.deepEqual(save.calls[0].loc, { state: 'CA', city: 'San Francisco' })
    assert.match(replies[0], /Location set to San Francisco, CA/)
    assert.match(replies[0], /Fair Workweek/) // SF overlay
  })

  it('non-owner is denied and the handler never runs', async () => {
    const save = makeSave()
    registerComplianceFeature({ setProfile: save.fn })
    const res = await dispatchCommand(
      'setlocation',
      { groupId: 'g1', userId: 7, text: 'CA' },
      { isAuthorized: async () => false },
    )
    assert.equal(res.denied, true)
    assert.equal(save.calls.length, 0)
  })

  it('unparseable input asks for clarification without saving', async () => {
    const save = makeSave()
    const replies = []
    registerComplianceFeature({ setProfile: save.fn })
    const res = await dispatchCommand(
      'setlocation',
      { groupId: 'g1', userId: 7, text: '', reply: (m) => replies.push(m) },
      { isAuthorized: async () => true },
    )
    assert.equal(res.handled, true)
    assert.equal(save.calls.length, 0)
    assert.match(replies[0], /Tell me your location/)
  })

  it('chat intent path resolves and dispatches with extracted fields', async () => {
    const save = makeSave()
    const replies = []
    registerComplianceFeature({ setProfile: save.fn })
    const match = matchIntent("we're in Chicago, IL")
    assert.equal(match.name, 'set_location')
    assert.deepEqual(match.fields, { state: 'IL', city: 'Chicago' })
    const intent = getIntent('set_location')
    await intent.handler({ groupId: 'g1', userId: 9, fields: match.fields, reply: (m) => replies.push(m) })
    assert.equal(save.calls.length, 1)
    assert.deepEqual(save.calls[0].loc, { state: 'IL', city: 'Chicago' })
    assert.match(replies[0], /Chicago, IL/)
  })
})
