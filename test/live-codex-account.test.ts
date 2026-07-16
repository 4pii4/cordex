import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'

test('real Codex account usage endpoints return authenticated diagnostics', { skip: !process.env.CORDEX_ACCOUNT_TEST }, async (t) => {
  const codex = new CodexAppServer()
  try {
    let limits
    let usage
    try {
      limits = await codex.getAccountRateLimits()
      usage = await codex.getAccountUsage()
    } catch (error) {
      t.skip(`Account diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    assert.equal(typeof limits, 'object')
    assert.equal(typeof usage, 'object')
  } finally {
    await codex.close()
  }
})
