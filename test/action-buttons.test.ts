import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actionButtonsTool,
  actionButtonsToolName,
  actionButtonToolResult,
  parseActionButtons,
} from '../src/action-buttons.js'

test('action button tool advertises constrained Discord choices', () => {
  assert.equal(actionButtonsTool.type, 'function')
  assert.equal(actionButtonsTool.name, actionButtonsToolName)
  assert.deepEqual(parseActionButtons({
    buttons: [
      { label: ' Continue ', color: 'green' },
      { label: 'Cancel' },
    ],
  }), [
    { label: 'Continue', color: 'green' },
    { label: 'Cancel', color: 'white' },
  ])
})

test('action button arguments reject unusable choices', () => {
  assert.throws(() => parseActionButtons({ buttons: [] }), /between 1 and 3/)
  assert.throws(
    () => parseActionButtons({ buttons: [{ label: 'x'.repeat(81) }] }),
    /1-80 characters/,
  )
  assert.throws(
    () => parseActionButtons({ buttons: [{ label: 'Continue', color: 'purple' }] }),
    /Unsupported action button color/,
  )
})

test('action button result uses Codex dynamic-tool response shape', () => {
  assert.deepEqual(actionButtonToolResult('User clicked: Continue', true), {
    contentItems: [{ type: 'inputText', text: 'User clicked: Continue' }],
    success: true,
  })
})
