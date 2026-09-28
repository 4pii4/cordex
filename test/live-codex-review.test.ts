import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex review and rollback', { skip: !process.env.CORDEX_REVIEW_TEST }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-live-review-'))
  await writeFile(path.join(workspace, 'README.md'), 'review fixture\n')
  const codex = new CodexAppServer()
  const completed = new Set<string>()
  const waiters = new Map<string, () => void>()
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn !== 'object' || turn === null || !('id' in turn) || typeof turn.id !== 'string') return
    completed.add(turn.id)
    waiters.get(turn.id)?.()
  })
  const waitForTurn = async (turnId: string, timeoutMs: number) => {
    if (completed.has(turnId)) {
      completed.delete(turnId)
      return
    }
    const done = new Promise<void>((resolve) => {
      waiters.set(turnId, resolve)
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Review timeout for ${turnId}`)), timeoutMs)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      waiters.delete(turnId)
    }
  }
  let threadId = ''
  let rolledBackThreadId = ''
  let emptyThreadId = ''
  let reviewResetThreadId = ''
  try {
    const thread = await codex.startThread({ cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' })
    threadId = thread.threadId
    const firstTurn = await codex.startTurn({
      threadId,
      model: thread.model,
      input: [{ type: 'text', text: 'Reply exactly: review-source-ok', text_elements: [] }],
    })
    await waitForTurn(firstTurn, 60_000)
    const review = await codex.startReview({
      threadId,
      target: { type: 'custom', instructions: 'Review README.md briefly. Return one concise finding or say no findings.' },
    })
    assert.equal(review.reviewThreadId, threadId)
    await waitForTurn(review.turnId, 120_000)
    const before = await codex.listThreadTurns(threadId, 10)
    assert.ok(before.some((turn) => turn.id === firstTurn))
    assert.ok(before.some((turn) => turn.id === review.turnId))
    const rolledBack = await codex.rollbackThread(threadId, 1)
    rolledBackThreadId = rolledBack.threadId
    assert.notEqual(rolledBackThreadId, threadId)
    const after = await codex.listThreadTurns(rolledBackThreadId, 10)
    assert.ok(after.some((turn) => turn.id === firstTurn))
    assert.ok(!after.some((turn) => turn.id === review.turnId))
    const reviewReset = await codex.rollbackThread(threadId, 2)
    reviewResetThreadId = reviewReset.threadId
    assert.deepEqual(await codex.listThreadTurns(reviewResetThreadId, 10), [])
    const continuedTurn = await codex.startTurn({
      threadId: rolledBackThreadId,
      model: rolledBack.model,
      input: [{ type: 'text', text: 'Reply exactly: rollback-continuation-ok', text_elements: [] }],
    })
    await waitForTurn(continuedTurn, 60_000)
    assert.ok((await codex.listThreadTurns(rolledBackThreadId, 10))
      .some((turn) => turn.id === continuedTurn))
    const emptied = await codex.rollbackThread(rolledBackThreadId, 2)
    emptyThreadId = emptied.threadId
    assert.notEqual(emptyThreadId, rolledBackThreadId)
    assert.deepEqual(await codex.listThreadTurns(emptyThreadId, 10), [])
  } finally {
    if (reviewResetThreadId) await codex.archiveThread(reviewResetThreadId).catch(() => undefined)
    if (emptyThreadId) await codex.archiveThread(emptyThreadId).catch(() => undefined)
    if (rolledBackThreadId) await codex.archiveThread(rolledBackThreadId).catch(() => undefined)
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
