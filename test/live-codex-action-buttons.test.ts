import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { DynamicToolSpec, ServerNotification, ServerRequest } from '../src/types.js'

const dynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'cordex_action',
    description: 'Select the requested Cordex action.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'approve' },
        label: { type: 'string', const: 'Ship it' },
      },
      required: ['action', 'label'],
      additionalProperties: false,
    },
  },
]

test('real Codex calls and receives a dynamic action tool', {
  skip: !process.env.CORDEX_ACTION_BUTTONS_TEST,
  timeout: 120_000,
}, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-action-buttons-live-'))
  const codex = new CodexAppServer()
  let threadId = ''
  let agentText = ''
  const calls: ServerRequest[] = []
  let resolveCall: ((request: ServerRequest) => void) | undefined
  let resolveCompleted: (() => void) | undefined
  const called = new Promise<ServerRequest>((resolve) => {
    resolveCall = resolve
  })
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })

  codex.on('serverRequest', (request: ServerRequest) => {
    if (request.method !== 'item/tool/call' || request.params.threadId !== threadId) return
    calls.push(request)
    codex.respond(request.id, {
      contentItems: [{ type: 'inputText', text: 'action-button-live-result-ok' }],
      success: true,
    })
    resolveCall?.(request)
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (
      notification.method === 'item/agentMessage/delta' &&
      notification.params.threadId === threadId &&
      typeof notification.params.delta === 'string'
    ) {
      agentText += notification.params.delta
    }
    if (
      notification.method === 'turn/completed' &&
      notification.params.threadId === threadId
    ) {
      resolveCompleted?.()
    }
  })

  try {
    const thread = await codex.startThread({
      cwd: workspace,
      dynamicTools,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    threadId = thread.threadId
    await codex.startTurn({
      threadId,
      model: thread.model,
      effort: 'high',
      input: [{
        type: 'text',
        text: 'Call cordex_action exactly once with action "approve" and label "Ship it". Do not call other tools. After its result, reply exactly: action-button-live-ok',
        text_elements: [],
      }],
    })

    let timer: NodeJS.Timeout | undefined
    let request: ServerRequest
    try {
      request = await Promise.race([
        Promise.all([called, completed]).then(([toolCall]) => toolCall),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Dynamic action tool live test timed out')), 90_000)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    assert.equal(calls.length, 1)
    assert.equal(request.params.namespace, null)
    assert.equal(request.params.tool, 'cordex_action')
    assert.equal(typeof request.params.callId, 'string')
    assert.deepEqual(request.params.arguments, { action: 'approve', label: 'Ship it' })
    assert.match(agentText, /action-button-live-ok/)
  } finally {
    if (threadId) await codex.request('thread/delete', { threadId }).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
