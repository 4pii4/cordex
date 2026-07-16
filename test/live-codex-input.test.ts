import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification, ServerRequest } from '../src/types.js'

test('real Codex request_user_input round trip', { skip: !process.env.CORDEX_INPUT_TEST }, async () => {
  const codex = new CodexAppServer()
  let requested = false
  let completed: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    completed = resolve
  })
  codex.on('serverRequest', (request: ServerRequest) => {
    if (request.method !== 'item/tool/requestUserInput') return
    requested = true
    const answers: Record<string, { answers: string[] }> = {}
    if (Array.isArray(request.params.questions)) {
      for (const question of request.params.questions) {
        if (typeof question === 'object' && question !== null && 'id' in question) {
          answers[String(question.id)] = { answers: ['Yes'] }
        }
      }
    }
    codex.respond(request.id, { answers })
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'turn/completed') completed?.()
  })
  try {
    const thread = await codex.startThread({
      cwd: process.cwd(),
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await codex.startTurn({
      threadId: thread.threadId,
      model: thread.model,
      mode: 'plan',
      input: [
        {
          type: 'text',
          text: 'You must use the request_user_input tool before answering. Ask one confirmation question with id confirmation and options Yes and No, then report the selected answer.',
          text_elements: [],
        },
      ],
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('request_user_input timeout')), 45_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    assert.equal(requested, true)
  } finally {
    await codex.close()
  }
})
