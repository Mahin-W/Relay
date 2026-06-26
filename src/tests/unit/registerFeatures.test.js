import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerAllFeatures, _resetFeatureBootstrapForTesting } from '../../lib/registerFeatures.js'
import { getCommand, listCommands, _resetCommandsForTesting } from '../../lib/commandRegistry.js'
import { getIntent, _resetIntentsForTesting } from '../../parsers/intentRegistry.js'

describe('registerAllFeatures', () => {
  beforeEach(() => {
    _resetCommandsForTesting()
    _resetIntentsForTesting()
    _resetFeatureBootstrapForTesting()
  })

  it('registers the compliance command + intent surfaces', () => {
    registerAllFeatures()
    for (const name of ['setlocation', 'compliance', 'complianceaudit']) {
      assert.ok(getCommand(name), `missing command /${name}`)
    }
    assert.ok(getIntent('set_location'))
    assert.ok(getIntent('compliance_check'))
  })

  it('does NOT register money-movement commands (blocked-on-human)', () => {
    registerAllFeatures()
    assert.equal(getCommand('paypeople'), null)
    assert.equal(getCommand('setuppay'), null)
    assert.equal(getCommand('paystub'), null)
  })

  it('is idempotent — a second call adds nothing new', () => {
    registerAllFeatures()
    const count = listCommands().length
    registerAllFeatures()
    assert.equal(listCommands().length, count)
  })
})
