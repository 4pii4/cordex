import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex supports session list, fork, rename, compact', { skip: !process.env.CORDEX_LIVE_TEST }, async () => {
  const codex = new CodexAppServer()
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-review-smoke-'))
  await writeFile(path.join(workspace, 'README.md'), 'small review fixture\n')
  await mkdir(path.join(workspace, 'src'))
  await writeFile(path.join(workspace, 'src', 'index.ts'), 'export {}\n')
  let completed: (() => void) | undefined
  let waitingForTurnId = ''
  let waitingForThreadId = ''
  const completedTurnIds = new Set<string>()
  const turnEvents: string[] = []
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'turn/started' || notification.method === 'turn/completed' || notification.method === 'error') {
      const turn = notification.params.turn
      const turnId = typeof turn === 'object' && turn !== null && 'id' in turn && typeof turn.id === 'string' ? turn.id : ''
      turnEvents.push(`${notification.method}:${turnId}`)
    }
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn !== 'object' || turn === null || !('id' in turn) || typeof turn.id !== 'string') return
    completedTurnIds.add(turn.id)
    const notificationThreadId = typeof notification.params.threadId === 'string' ? notification.params.threadId : ''
    if (turn.id === waitingForTurnId || notificationThreadId === waitingForThreadId) completed?.()
  })
  const waitForTurn = async (turnId: string) => {
    if (completedTurnIds.has(turnId)) {
      completedTurnIds.delete(turnId)
      return
    }
    waitingForTurnId = turnId
    waitingForThreadId = threadId
    const done = new Promise<void>((resolve) => {
      completed = resolve
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Feature smoke timeout (${turnEvents.join(',')})`)), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      waitingForThreadId = ''
    }
  }
  let threadId = ''
  let forkedId = ''
  try {
    const thread = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    threadId = thread.threadId
    const goal = await codex.setThreadGoal(threadId, 'Complete live feature smoke', 10_000, 'paused')
    assert.equal(goal.objective, 'Complete live feature smoke')
    assert.equal(goal.status, 'paused')
    assert.equal((await codex.getThreadGoal(threadId))?.tokenBudget, 10_000)
    assert.equal(await codex.clearThreadGoal(threadId), true)
    assert.equal(await codex.getThreadGoal(threadId), null)
    const permissionProfiles = await codex.listPermissionProfiles(workspace)
    assert.ok(permissionProfiles.some((profile) => profile.id === ':read-only' && profile.allowed !== false))
    const fileMatches = await codex.fuzzyFileSearch([workspace], 'README')
    assert.ok(fileMatches.some((match) => match.path === 'README.md'))
    const sourceMatches = await codex.fuzzyFileSearch([workspace], 'src')
    for (const match of sourceMatches) {
      assert.equal((await stat(path.join(match.root, match.path))).isFile(), true)
    }
    await codex.updateThreadSettings({ threadId, model: null, effort: 'low', permissions: ':read-only' })
    assert.ok(Array.isArray(await codex.listSkills(workspace)))
    assert.ok(Array.isArray(await codex.listMcpServers(threadId)))
    const firstTurnId = await codex.startTurn({
      threadId,
      input: [{ type: 'text', text: 'Reply exactly: feature-smoke-ok', text_elements: [] }],
    })
    await waitForTurn(firstTurnId)
    const turns = await codex.listThreadTurns(threadId, 10)
    assert.ok(turns.some((turn) => turn.items.some((item) => item.type === 'userMessage')))
    assert.ok(turns.some((turn) => turn.items.some((item) => item.type === 'agentMessage')))
    const listed = await codex.listThreads({ cwd: workspace, limit: 50 })
    assert.ok(listed.some((item) => item.id === threadId))
    const resumed = await codex.resumeThread({
      threadId,
      includeTurns: true,
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    assert.ok(resumed.turns.length > 0)
    await codex.setThreadName(threadId, 'Cordex feature smoke')
    const forked = await codex.forkThread({
      threadId,
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    forkedId = forked.threadId
    assert.notEqual(forkedId, threadId)
    await codex.compactThread(threadId)
  } finally {
    if (forkedId) await codex.archiveThread(forkedId).catch(() => undefined)
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
