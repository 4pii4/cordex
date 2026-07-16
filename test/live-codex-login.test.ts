import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'

test('real Codex login challenge can be started and cancelled', { skip: !process.env.CORDEX_LOGIN_TEST }, async (t) => {
  const codex = new CodexAppServer()
  try {
    let login
    try {
      login = await codex.startAccountLogin('chatgptDeviceCode')
    } catch (error) {
      t.skip(`Codex login challenge unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    assert.equal(login.type, 'chatgptDeviceCode')
    assert.ok(login.loginId)
    assert.ok(login.verificationUrl)
    assert.ok(login.userCode)
    await codex.cancelAccountLogin(login.loginId)
  } finally {
    await codex.close()
  }
})
