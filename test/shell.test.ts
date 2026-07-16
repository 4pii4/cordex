import assert from 'node:assert/strict'
import test from 'node:test'
import { runShellCommand } from '../src/shell.js'

test('shell command runs in requested directory and captures output', async () => {
  const result = await runShellCommand({
    command: process.platform === 'win32' ? 'echo cordex-shell' : 'printf cordex-shell',
    cwd: process.cwd(),
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.output, 'cordex-shell')
})

test('shell command timeout terminates process', async () => {
  if (process.platform === 'win32') return
  const result = await runShellCommand({ command: 'sleep 2', cwd: process.cwd(), timeoutMs: 20 })
  assert.equal(result.timedOut, true)
})
