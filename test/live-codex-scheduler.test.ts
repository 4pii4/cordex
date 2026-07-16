import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import { TaskScheduler } from '../src/scheduler.js'
import type { ScheduledTask, ServerNotification } from '../src/types.js'

test('real Codex executes a scheduled prompt', { skip: !process.env.CORDEX_SCHEDULER_TEST }, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-live-scheduler-'))
  await writeFile(path.join(workspace, 'README.md'), 'scheduler fixture\n')
  const codex = new CodexAppServer()
  const thread = await codex.startThread({ cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' })
  const task: ScheduledTask = {
    id: 'live-task',
    threadId: thread.threadId,
    prompt: 'Reply exactly: scheduled-live-ok',
    runAt: new Date(Date.now() + 10).toISOString(),
    createdBy: 'live-test',
    status: 'scheduled',
  }
  let completed = ''
  let runs = 0
  let resolveTurn: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    resolveTurn = resolve
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn === 'object' && turn !== null && 'id' in turn && typeof turn.id === 'string') {
      completed = turn.id
      resolveTurn?.()
    }
  })
  const scheduler = new TaskScheduler(
    { [task.id]: task },
    async () => {
      runs += 1
      await codex.startTurn({
        threadId: thread.threadId,
        model: thread.model,
        input: [{ type: 'text', text: task.prompt, text_elements: [] }],
      })
    },
    async () => undefined,
  )
  try {
    scheduler.start()
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('scheduled Codex timeout')), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    assert.equal(runs, 1)
    assert.equal(task.status, 'completed')
    assert.ok(completed)
  } finally {
    scheduler.stop()
    await codex.archiveThread(thread.threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
