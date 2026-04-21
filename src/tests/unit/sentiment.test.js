import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySentiment,
  detectRemovalIntent,
  detectDistressSignal,
  detectResignationIntent,
} from '../../intelligence/moraleTracker.js'

await Promise.all([
  // BUG D1: intensifier + negative adjective → negative
  test('D1: "absolutely awful tonight" → negative', () => {
    assert.equal(classifySentiment('absolutely awful tonight'), 'negative')
  }),

  // confounder: intensifier NOT followed by negative adjective → positive
  test('D1 confounder: "absolutely amazing" → positive', () => {
    assert.equal(classifySentiment('absolutely amazing'), 'positive')
  }),

  // BUG D2: ridiculous → negative
  test('D2: "this is ridiculous devon keeps doing this i want to fire him right now" → negative', () => {
    assert.equal(
      classifySentiment('this is ridiculous devon keeps doing this i want to fire him right now'),
      'negative'
    )
  }),

  // BUG D2: detectRemovalIntent
  test('D2: detectRemovalIntent("please fire devon") → { intent: fire, targetName: devon }', () => {
    const result = detectRemovalIntent('please fire devon')
    assert.deepEqual(result, { intent: 'fire', targetName: 'devon' })
  }),

  test('D2: detectRemovalIntent("let go marcus") → { intent: remove, targetName: marcus }', () => {
    const result = detectRemovalIntent('let go marcus')
    assert.deepEqual(result, { intent: 'remove', targetName: 'marcus' })
  }),

  test('D2: detectRemovalIntent("nothing relevant") → null', () => {
    assert.equal(detectRemovalIntent('nothing relevant'), null)
  }),

  // BUG D3: distress signal → negative
  test('D3: distress phrase → negative', () => {
    assert.equal(
      classifySentiment("I've been having a really hard time lately and I'm not sure I can keep doing this"),
      'negative'
    )
  }),

  test('D3: detectDistressSignal("hard time") → true', () => {
    assert.equal(detectDistressSignal('hard time'), true)
  }),

  test('D3: detectDistressSignal("burned out") → true', () => {
    assert.equal(detectDistressSignal('burned out'), true)
  }),

  test('D3: detectDistressSignal("everything is great") → false', () => {
    assert.equal(detectDistressSignal('everything is great'), false)
  }),

  // BUG D4: resignation intent → negative
  test('D4: "hey I think I need to put in my two weeks" → negative', () => {
    assert.equal(
      classifySentiment('hey I think I need to put in my two weeks'),
      'negative'
    )
  }),

  test('D4: detectResignationIntent("two weeks") → true', () => {
    assert.equal(detectResignationIntent('two weeks'), true)
  }),

  test('D4: detectResignationIntent("putting in my notice") → true', () => {
    assert.equal(detectResignationIntent('putting in my notice'), true)
  }),

  test('D4: detectResignationIntent("handing in my notice") → true', () => {
    assert.equal(detectResignationIntent('handing in my notice'), true)
  }),

  test('D4: detectResignationIntent("see you tomorrow") → false', () => {
    assert.equal(detectResignationIntent('see you tomorrow'), false)
  }),
])
