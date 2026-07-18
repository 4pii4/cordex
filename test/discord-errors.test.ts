import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isUnknownDiscordChannelError,
  isUnknownDiscordMessageError,
} from '../src/discord-errors.js'

test('only Discord unknown-channel errors permit stale mapping cleanup', () => {
  assert.equal(isUnknownDiscordChannelError({ code: 10_003 }), true)
  assert.equal(isUnknownDiscordChannelError({ rawError: { code: 10_003 } }), true)
  assert.equal(isUnknownDiscordChannelError({ status: 404 }), true)
  assert.equal(isUnknownDiscordChannelError({ status: 500 }), false)
  assert.equal(isUnknownDiscordChannelError({ code: 'ECONNRESET' }), false)
  assert.equal(isUnknownDiscordChannelError(new Error('network failure')), false)
})

test('only Discord unknown-message errors permit queued source removal', () => {
  assert.equal(isUnknownDiscordMessageError({ code: 10_008 }), true)
  assert.equal(isUnknownDiscordMessageError({ rawError: { code: '10008' } }), true)
  assert.equal(isUnknownDiscordMessageError({ status: 404 }), true)
  assert.equal(isUnknownDiscordMessageError({ status: 500 }), false)
  assert.equal(isUnknownDiscordMessageError({ code: 'ECONNRESET' }), false)
})
