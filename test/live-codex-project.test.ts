import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import { createProject } from '../src/projects.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex starts in a newly created Cordex project', { skip: !process.env.CORDEX_LIVE_TEST }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-live-project-root-'))
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
    const project = await createProject({ rootDirectory: root, name: 'Live Project' })
    const thread = await codex.startThread({ cwd: project.directory, sandbox: 'read-only', approvalPolicy: 'never' })
    threadId = thread.threadId
    await codex.startTurn({
      threadId,
      model: thread.model,
      input: [{ type: 'text', text: 'Reply exactly: new-project-live-ok', text_elements: [] }],
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('new project Codex timeout')), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    assert.match(answer, /new-project-live-ok/i)
  } finally {
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(root, { recursive: true, force: true })
  }
})
