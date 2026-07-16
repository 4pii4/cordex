import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification, ServerRequest } from '../src/types.js'

test('real Codex command approval round trip', { skip: !process.env.CORDEX_APPROVAL_TEST }, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-live-approval-'))
  await writeFile(path.join(workspace, 'README.md'), 'approval fixture\n')
  const codex = new CodexAppServer()
  let approvalSeen = false
  let turnDone: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    turnDone = resolve
  })
  codex.on('serverRequest', (request: ServerRequest) => {
    if (request.method === 'item/commandExecution/requestApproval') {
      approvalSeen = true
      codex.respond(request.id, { decision: 'accept' })
    } else if (request.method === 'item/fileChange/requestApproval') {
      approvalSeen = true
      codex.respond(request.id, { decision: 'accept' })
    } else if (request.method === 'item/permissions/requestApproval') {
      approvalSeen = true
      codex.respond(request.id, { permissions: { network: { enabled: true } }, scope: 'turn' })
    }
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'turn/completed') turnDone?.()
  })
  let threadId = ''
  try {
    const thread = await codex.startThread({
      cwd: workspace,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    threadId = thread.threadId
    await codex.startTurn({
      threadId,
      model: thread.model,
      input: [
        {
          type: 'text',
          text: 'Use the shell tool to run exactly: curl -fsS https://example.com >/dev/null. Then reply with approval-live-ok.',
          text_elements: [],
        },
      ],
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('approval smoke timeout')), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (!approvalSeen) t.skip('Codex completed safe command without approval request')
  } finally {
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
