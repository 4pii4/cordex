import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex reads from an added runtime workspace root', { skip: !process.env.CORDEX_LIVE_TEST }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-root-workspace-'))
  const extra = await mkdtemp(path.join(tmpdir(), 'cordex-root-extra-'))
  const file = path.join(extra, 'root-proof.txt')
  await writeFile(file, 'extra-root-live-ok\n')
  const codex = new CodexAppServer()
  let answer = ''
  let completed: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    completed = resolve
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'item/agentMessage/delta' && typeof notification.params.delta === 'string') {
      answer += notification.params.delta
    }
    if (notification.method === 'item/completed') {
      const item = notification.params.item
      if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'agentMessage') {
        const value = 'text' in item ? item.text : undefined
        if (typeof value === 'string') answer = value
      }
    }
    if (notification.method === 'turn/completed') completed?.()
  })
  let threadId = ''
  try {
    const roots = [workspace, extra]
    const thread = await codex.startThread({
      cwd: workspace,
      runtimeWorkspaceRoots: roots,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    threadId = thread.threadId
    await codex.startTurn({
      threadId,
      model: thread.model,
      runtimeWorkspaceRoots: roots,
      input: [{ type: 'text', text: `Read ${file} and reply exactly with its contents.`, text_elements: [] }],
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Runtime workspace root timeout')), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    assert.match(answer, /extra-root-live-ok/i)
  } finally {
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(extra, { recursive: true, force: true })
  }
})
