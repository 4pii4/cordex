import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer, type CodexAppServerReadyEvent } from '../src/codex-app-server.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('real Codex crash restarts, while intentional close emits no child failure', {
  skip: !process.env.CORDEX_LIFECYCLE_TEST,
  timeout: 60_000,
}, async () => {
  const codex = new CodexAppServer({
    restart: { initialDelayMs: 50, maxDelayMs: 500, maxAttempts: 2 },
  })
  let clean: CodexAppServer | undefined
  const readyEvents: CodexAppServerReadyEvent[] = []
  const failures: string[] = []
  let restartCount = 0
  let closeCount = 0
  codex.on('ready', (event: CodexAppServerReadyEvent) => readyEvents.push(event))
  codex.on('childFailure', (error: Error) => failures.push(error.message))
  codex.on('restarting', () => { restartCount++ })
  codex.on('close', () => { closeCount++ })
  try {
    await codex.getAuthStatus()
    await waitFor(() => readyEvents.length === 1, 'initial app-server readiness')
    const firstPid = readyEvents[0]?.pid
    assert.ok(typeof firstPid === 'number' && firstPid > 0)
    process.kill(firstPid, 0)
    process.kill(firstPid, 'SIGTERM')
    await waitFor(() => failures.length === 1 && restartCount === 1, 'genuine child failure')
    await waitFor(() => readyEvents.length === 2, 'app-server restart')
    const recoveredPid = readyEvents[1]?.pid
    assert.ok(typeof recoveredPid === 'number' && recoveredPid > 0)
    assert.notEqual(recoveredPid, firstPid)
    await codex.getAuthStatus()
    await codex.close()
    assert.equal(failures.length, 1)
    assert.equal(restartCount, 1)
    assert.equal(closeCount, 1)

    clean = new CodexAppServer()
    let cleanFailureCount = 0
    let cleanRestartCount = 0
    let cleanCloseCount = 0
    clean.on('childFailure', () => { cleanFailureCount++ })
    clean.on('restarting', () => { cleanRestartCount++ })
    clean.on('close', () => { cleanCloseCount++ })
    await clean.getAuthStatus()
    await clean.close()
    assert.equal(cleanFailureCount, 0)
    assert.equal(cleanRestartCount, 0)
    assert.equal(cleanCloseCount, 1)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-lifecycle-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex SIGTERM restart followed by RPC recovery and clean shutdown, plus a separate clean shutdown',
      command: 'npm run test:live-lifecycle',
      firstPid,
      recoveredPid,
      genuineFailureCount: failures.length,
      restartCount,
      closeCount,
      cleanFailureCount,
      cleanRestartCount,
      cleanCloseCount,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    await clean?.close().catch(() => undefined)
    await codex.close().catch(() => undefined)
  }
})
