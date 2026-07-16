import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'

test('real Codex reports auth and account status without exposing tokens', { skip: !process.env.CORDEX_LIVE_TEST }, async () => {
  const codex = new CodexAppServer()
  try {
    const auth = await codex.getAuthStatus()
    assert.equal(typeof auth.hasToken, 'boolean')
    assert.equal(typeof auth.requiresOpenaiAuth, 'boolean')
    if (auth.authMethod !== undefined) assert.equal(typeof auth.authMethod, 'string')
    const account = await codex.getAccount()
    if (account) assert.equal(typeof account.type, 'string')
  } finally {
    await codex.close()
  }
})
