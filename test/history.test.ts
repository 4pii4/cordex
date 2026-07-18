import assert from 'node:assert/strict'
import test from 'node:test'
import { formatThreadHistory } from '../src/history.js'
import type { CodexThreadTurn } from '../src/codex-app-server.js'

test('history replay is chronological and omits reasoning', () => {
  const turns: CodexThreadTurn[] = [
    {
      id: 'new',
      items: [
        { type: 'reasoning', id: 'reasoning', summary: ['private'], content: ['hidden'] },
        { type: 'agentMessage', id: 'answer', text: 'new answer', phase: 'final', memoryCitation: null },
      ],
    },
    {
      id: 'old',
      items: [
        {
          type: 'userMessage',
          id: 'question',
          clientId: null,
          content: [{ type: 'text', text: 'old question', text_elements: [] }],
        },
        { type: 'commandExecution', id: 'tool', command: 'npm test', status: 'completed' },
      ],
    },
  ]
  const rendered = formatThreadHistory(turns).join('\n')
  assert.ok(rendered.indexOf('old question') < rendered.indexOf('new answer'))
  assert.match(rendered, /npm test/)
  assert.doesNotMatch(rendered, /private|hidden/)
})

test('history replay renders skill-only user messages', () => {
  const rendered = formatThreadHistory([{
    id: 'skill-turn',
    items: [{
      type: 'userMessage',
      id: 'skill-message',
      clientId: 'interaction-1',
      content: [{ type: 'skill', name: 'caveman-help', path: '/skills/caveman-help/SKILL.md' }],
    }],
  }]).join('\n')

  assert.match(rendered, /\[caveman-help skill\]/)
})

test('history replay respects Discord and total size limits', () => {
  const turns: CodexThreadTurn[] = Array.from({ length: 8 }, (_, index) => ({
    id: `turn-${index}`,
    items: [
      {
        type: 'agentMessage',
        id: `message-${index}`,
        text: `${index}:${'x'.repeat(500)}`,
        phase: 'final',
        memoryCitation: null,
      },
    ],
  }))
  const rendered = formatThreadHistory(turns, { messageLimit: 300, totalLimit: 1_000 })
  assert.ok(rendered.every((chunk) => chunk.length <= 300))
  assert.match(rendered.join('\n'), /Older history omitted/)
  assert.match(rendered.join('\n'), /0:/)
  assert.doesNotMatch(rendered.join('\n'), /7:/)
})

test('history replay truncates one oversized newest item', () => {
  const rendered = formatThreadHistory([
    {
      id: 'turn',
      items: [{ type: 'agentMessage', id: 'message', text: 'x'.repeat(5_000) }],
    },
  ], { messageLimit: 300, totalLimit: 900 })
  assert.ok(rendered.every((chunk) => chunk.length <= 300))
  assert.ok(rendered.join('\n').length < 1_000)
  assert.match(rendered.join('\n'), /Earlier content omitted/)
})
