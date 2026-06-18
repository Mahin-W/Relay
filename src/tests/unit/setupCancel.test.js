import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCancel } from '../../setup/setupFlow.js'

await Promise.all([
  test('isCancel: "cancel" → true', () => {
    assert.equal(isCancel('cancel'), true)
  }),
  test('isCancel: "CANCEL" → true (case-insensitive)', () => {
    assert.equal(isCancel('CANCEL'), true)
  }),
  test('isCancel: "abort" → true', () => {
    assert.equal(isCancel('abort'), true)
  }),
  test('isCancel: "exit" → true', () => {
    assert.equal(isCancel('exit'), true)
  }),
  test('isCancel: "nevermind" → true', () => {
    assert.equal(isCancel('nevermind'), true)
  }),
  test('isCancel: "never mind" → true', () => {
    assert.equal(isCancel('never mind'), true)
  }),
  test('isCancel: "stop" → true', () => {
    assert.equal(isCancel('stop'), true)
  }),
  test('isCancel: "  cancel  " (with whitespace) → true', () => {
    assert.equal(isCancel('  cancel  '), true)
  }),
  test('isCancel: "yes" → false', () => {
    assert.equal(isCancel('yes'), false)
  }),
  test('isCancel: "my business name" → false', () => {
    assert.equal(isCancel('my business name'), false)
  }),
  test('isCancel: "please cancel this" → false (must be whole phrase)', () => {
    assert.equal(isCancel('please cancel this'), false)
  }),
  test('isCancel: empty string → false', () => {
    assert.equal(isCancel(''), false)
  }),
  test('isCancel: "Abort" (mixed case) → true', () => {
    assert.equal(isCancel('Abort'), true)
  }),
  test('isCancel: "STOP" → true', () => {
    assert.equal(isCancel('STOP'), true)
  }),
])
