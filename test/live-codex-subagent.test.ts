import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex discovers and forks a spawned subagent', {
  skip: !process.env.CORDEX_SUBAGENT_TEST,
  timeout: 150_000,
}, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-subagent-live-'))
  const codex = new CodexAppServer()
  let parentThreadId = ''
  let forkThreadId = ''
  try {
    const completed = new Promise<void>((resolve) => {
      codex.on('notification', (notification: ServerNotification) => {
        if (notification.method === 'turn/completed' && notification.params.threadId === parentThreadId) {
          resolve()
        }
      })
    })
    const parent = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    parentThreadId = parent.threadId
    await codex.startTurn({
      threadId: parentThreadId,
      effort: 'ultra',
      input: [{
        type: 'text',
        text: 'You must use collaboration.spawn_agent exactly once. Ask the subagent to calculate 17 * 19, wait for it, then reply exactly: parent-finished',
        text_elements: [],
      }],
    })
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Subagent live test timed out')), 120_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    const subagents = await codex.listSubagentThreads(parentThreadId)
    assert.ok(subagents.length > 0)
    const child = subagents[0]
    assert.ok(child)
    const forked = await codex.forkThread({
      threadId: child.threadId,
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    forkThreadId = forked.threadId
    assert.notEqual(forkThreadId, child.threadId)
    assert.ok((await codex.listThreadTurns(forkThreadId, 10)).length > 0)
  } finally {
    if (forkThreadId) await codex.request('thread/delete', { threadId: forkThreadId }).catch(() => undefined)
    if (parentThreadId) await codex.request('thread/delete', { threadId: parentThreadId }).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
