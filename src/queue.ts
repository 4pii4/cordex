import type { QueuedPrompt } from './types.js'

const suffix = /\.\s*queue\s*$/i

export function parseQueueMessage(content: string): { queued: boolean; text: string } {
  if (!suffix.test(content)) return { queued: false, text: content.trim() }
  return { queued: true, text: content.replace(suffix, '').trim() }
}

export function editQueuedPrompt(queued: QueuedPrompt, content: string): QueuedPrompt | undefined {
  const parsed = parseQueueMessage(content)
  if (!parsed.queued || !parsed.text) return undefined
  return {
    ...queued,
    displayText: parsed.text,
    input: [
      { type: 'text', text: parsed.text, text_elements: [] },
      ...queued.input.filter((item) => item.type === 'image'),
    ],
  }
}
