import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'
import {
  createWorktree,
  formatWorktreeBranch,
  getManagedWorktreeDirectory,
  mergeWorktree,
  removeMergedWorktree,
  removeWorktree,
  runGit,
} from '../src/worktrees.js'

test('real Codex starts and forks sessions in a git worktree cwd', { skip: !process.env.CORDEX_WORKTREE_TEST }, async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'cordex-live-repo-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-live-worktrees-'))
  const codex = new CodexAppServer()
  const completedTurnIds = new Set<string>()
  const completedTurnStatuses = new Map<string, string>()
  const waiters = new Map<string, () => void>()
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn !== 'object' || turn === null || !('id' in turn) || typeof turn.id !== 'string') return
    completedTurnIds.add(turn.id)
    if ('status' in turn && typeof turn.status === 'string') completedTurnStatuses.set(turn.id, turn.status)
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
  let stalePathPreserved = false
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
    const branch = formatWorktreeBranch('live-codex')
    const staleDirectory = getManagedWorktreeDirectory({
      dataRoot,
      projectDirectory: repo,
      branch,
    })
    await mkdir(staleDirectory, { recursive: true })
    const sentinel = path.join(staleDirectory, 'preserve-me.txt')
    await writeFile(sentinel, 'stale worktree data must survive\n')
    await assert.rejects(
      createWorktree({ projectDirectory: repo, dataRoot, name: 'live-codex' }),
      /Refusing to overwrite existing managed worktree path/,
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'stale worktree data must survive\n')
    stalePathPreserved = true
    await rm(staleDirectory, { recursive: true, force: true })
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
    assert.equal(forked.effort, source.effort)
    const worktreeDirectory = created.directory
    const worktreeTurn = await codex.startTurn({
      threadId: forkedThread,
      cwd: worktreeDirectory,
      model: forked.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Use the shell tool to run exactly pwd. Report the result and do not edit files.',
        text_elements: [],
      }],
    })
    await waitForTurn(worktreeTurn, 'worktree cwd')
    assert.equal(completedTurnStatuses.get(worktreeTurn), 'completed')
    const worktreeTurnItems = (await codex.listThreadTurns(forkedThread, 5))
      .find((turn) => turn.id === worktreeTurn)?.items || []
    const worktreeCommand = worktreeTurnItems.find((item) => item.type === 'commandExecution' &&
      typeof item.command === 'string' && item.command.includes('pwd'))
    assert.equal(worktreeCommand?.cwd, worktreeDirectory)

    await codex.archiveThread(automaticThread)
    automaticThread = ''
    const merged = await mergeWorktree({
      projectDirectory: repo,
      worktreeDirectory,
      branch: created.branch,
    })
    assert.equal(merged.status, 'nothing-to-merge')
    const removed = await removeMergedWorktree({
      projectDirectory: repo,
      worktreeDirectory,
      branch: created.branch,
    })
    assert.equal(removed.status, 'removed')
    assert.equal(existsSync(worktreeDirectory), false)
    created = undefined

    const reboundTurn = await codex.startTurn({
      threadId: forkedThread,
      cwd: repo,
      model: forked.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Use the shell tool to run exactly pwd from this turn default directory, without setting an explicit workdir. Report the result and do not edit files.',
        text_elements: [],
      }],
    })
    await waitForTurn(reboundTurn, 'rebound cwd')
    assert.equal(completedTurnStatuses.get(reboundTurn), 'completed')
    const reboundTurnItems = (await codex.listThreadTurns(forkedThread, 5))
      .find((turn) => turn.id === reboundTurn)?.items || []
    const reboundCommand = reboundTurnItems.find((item) => item.type === 'commandExecution' &&
      typeof item.command === 'string' && item.command.includes('pwd'))
    assert.equal(reboundCommand?.cwd, repo)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-rebind-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, `${JSON.stringify({
      scenario: 'real Codex worktree turn continues in main checkout after safe worktree removal',
      command: 'CORDEX_WORKTREE_TEST=1 node --import tsx --test test/live-codex-worktree.test.ts',
      stalePathPreserved,
      sourceThread,
      sourceEffectiveEffort: source.effort ?? null,
      forkedThread,
      forkEffectiveEffort: forked.effort ?? null,
      worktreeTurn,
      worktreeDirectory,
      worktreeCommandCwd: worktreeCommand?.cwd,
      mergeStatus: merged.status,
      removalStatus: removed.status,
      removedDirectoryAbsent: true,
      reboundTurn,
      reboundCommandCwd: reboundCommand?.cwd,
      reboundStatus: completedTurnStatuses.get(reboundTurn),
      completed: true,
    }, null, 2)}\n`, { mode: 0o600 })
    console.log(`E2E artifact: ${artifactPath}`)
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
