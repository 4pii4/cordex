import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex app-server streams a response', { skip: !process.env.CORDEX_LIVE_TEST }, async () => {
  const codex = new CodexAppServer()
  let answer = ''
  let sawTokenUsage = false
  let resolveCompleted: (() => void) | undefined
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'item/agentMessage/delta') {
      const delta = notification.params.delta
      if (typeof delta === 'string') answer += delta
    }
    if (notification.method === 'thread/tokenUsage/updated') sawTokenUsage = true
    if (notification.method === 'item/completed') {
      const item = notification.params.item
      if (typeof item === 'object' && item !== null && 'type' in item && item.type === 'agentMessage') {
        const itemText = 'text' in item ? item.text : undefined
        if (typeof itemText === 'string') answer = itemText
      }
    }
    if (notification.method === 'turn/completed') resolveCompleted?.()
  })
  try {
    const thread = await codex.startThread({
      cwd: process.cwd(),
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    await codex.startTurn({
      threadId: thread.threadId,
      input: [{ type: 'text', text: 'Reply exactly: cordex-live-ok', text_elements: [] }],
    })
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Live Codex timeout')), 60_000)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    assert.match(answer, /cordex-live-ok/i)
    assert.equal(sawTokenUsage, true)
  } finally {
    await codex.close()
  }
})
