import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'
import { createWorktree, removeWorktree, runGit } from '../src/worktrees.js'

test('real Codex starts and forks sessions in a git worktree cwd', { skip: !process.env.CORDEX_WORKTREE_TEST }, async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'cordex-live-repo-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-live-worktrees-'))
  const codex = new CodexAppServer()
  const completedTurnIds = new Set<string>()
  const waiters = new Map<string, () => void>()
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn !== 'object' || turn === null || !('id' in turn) || typeof turn.id !== 'string') return
    completedTurnIds.add(turn.id)
    waiters.get(turn.id)?.()
  })
  const waitForTurn = async (turnId: string, label: string) => {
    if (completedTurnIds.has(turnId)) return
    const done = new Promise<void>((resolve) => {
      waiters.set(turnId, resolve)
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label} timeout`)), 45_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      waiters.delete(turnId)
    }
  }
  let sourceThread = ''
  let forkedThread = ''
  let automaticThread = ''
  let created: Awaited<ReturnType<typeof createWorktree>> | undefined
  try {
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.email', 'cordex@test.invalid'],
      ['config', 'user.name', 'Cordex Test'],
    ]) {
      const result = await runGit(repo, args)
      assert.equal(result.exitCode, 0, result.stderr)
    }
    await writeFile(path.join(repo, 'README.md'), 'live\n')
    for (const args of [['add', 'README.md'], ['commit', '-m', 'base']]) {
      const result = await runGit(repo, args)
      assert.equal(result.exitCode, 0, result.stderr)
    }
    created = await createWorktree({ projectDirectory: repo, dataRoot, name: 'live-codex' })
    const automatic = await codex.startThread({
      cwd: created.directory,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    automaticThread = automatic.threadId
    const automaticTurn = await codex.startTurn({
      threadId: automaticThread,
      model: automatic.model,
      input: [{ type: 'text', text: 'Reply exactly: automatic-worktree-ok', text_elements: [] }],
    })
    await waitForTurn(automaticTurn, 'automatic worktree')
    const worktreeThreads = await codex.listThreads({ cwd: created.directory, limit: 25 })
    assert.ok(worktreeThreads.some((thread) => thread.id === automaticThread && thread.cwd === created?.directory))
    const source = await codex.startThread({ cwd: repo, sandbox: 'read-only', approvalPolicy: 'never' })
    sourceThread = source.threadId
    const sourceTurn = await codex.startTurn({
      threadId: sourceThread,
      model: source.model,
      input: [{ type: 'text', text: 'Reply exactly: worktree-source-ok', text_elements: [] }],
    })
    await waitForTurn(sourceTurn, 'worktree source')
    const forked = await codex.forkThread({
      threadId: sourceThread,
      cwd: created.directory,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    forkedThread = forked.threadId
    assert.notEqual(forkedThread, sourceThread)
  } finally {
    if (forkedThread) await codex.archiveThread(forkedThread).catch(() => undefined)
    if (automaticThread) await codex.archiveThread(automaticThread).catch(() => undefined)
    if (sourceThread) await codex.archiveThread(sourceThread).catch(() => undefined)
    await codex.close()
    if (created) await removeWorktree(created).catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})
