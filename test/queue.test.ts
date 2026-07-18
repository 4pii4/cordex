import assert from 'node:assert/strict'
import test from 'node:test'
import { editQueuedPrompt, parseQueueMessage } from '../src/queue.js'
import type { QueuedPrompt } from '../src/types.js'

test('queue suffix parsing matches Kimaki message form', () => {
  assert.deepEqual(parseQueueMessage('review this. queue'), { queued: true, text: 'review this' })
  assert.deepEqual(parseQueueMessage('review this. QUEUE  '), { queued: true, text: 'review this' })
  assert.deepEqual(parseQueueMessage('queue this normally'), {
    queued: false,
    text: 'queue this normally',
  })
})

const queued: QueuedPrompt = {
  id: 'queued-1',
  authorId: 'user-1',
  authorName: 'Kimaki',
  input: [
    { type: 'skill', name: 'reviewer', path: '/skills/reviewer/SKILL.md' },
    { type: 'text', text: 'review this', text_elements: [] },
    { type: 'image', url: 'https://example.com/one.png' },
    { type: 'localImage', path: '/tmp/two.png' },
  ],
  displayText: 'review this',
  createdAt: '2026-07-16T00:00:00.000Z',
  sourceMessageId: 'message-1',
}

test('queued message edits require queue suffix and nonblank text', () => {
  assert.equal(editQueuedPrompt(queued, 'send this now'), undefined)
  assert.equal(editQueuedPrompt(queued, '. queue'), undefined)
  assert.equal(editQueuedPrompt(queued, '   . QUEUE   '), undefined)
})

test('queued message edits replace text while preserving images and metadata', () => {
  const edited = editQueuedPrompt(queued, 'review both screenshots. queue')
  assert.deepEqual(edited, {
    ...queued,
    input: [
      { type: 'skill', name: 'reviewer', path: '/skills/reviewer/SKILL.md' },
      { type: 'text', text: 'review both screenshots', text_elements: [] },
      { type: 'image', url: 'https://example.com/one.png' },
      { type: 'localImage', path: '/tmp/two.png' },
    ],
    displayText: 'review both screenshots',
  })
  assert.equal(queued.displayText, 'review this')
  assert.equal(queued.input[1]?.type, 'text')
  assert.equal(queued.input[1]?.type === 'text' ? queued.input[1].text : undefined, 'review this')
})
