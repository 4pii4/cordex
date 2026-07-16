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
  let waitingThreadId = ''
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn !== 'object' || turn === null || !('id' in turn) || typeof turn.id !== 'string') return
    completed.add(turn.id)
    waiters.get(turn.id)?.()
    if (waitingThreadId && notification.params.threadId === waitingThreadId) waiters.get(waitingThreadId)?.()
  })
  const waitForTurn = async (turnId: string, timeoutMs: number) => {
    if (completed.has(turnId)) {
      completed.delete(turnId)
      return
    }
    waitingThreadId = threadId
    const done = new Promise<void>((resolve) => {
      waiters.set(turnId, resolve)
      waiters.set(threadId, resolve)
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
      waiters.delete(threadId)
      waitingThreadId = ''
    }
  }
  let threadId = ''
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
    await codex.rollbackThread(threadId, 1)
  } finally {
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
