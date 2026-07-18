import type { QueuedPrompt, UserInput } from './types.js'

const suffix = /\.\s*queue\s*$/i

export function parseQueueMessage(content: string): { queued: boolean; text: string } {
  if (!suffix.test(content)) return { queued: false, text: content.trim() }
  return { queued: true, text: content.replace(suffix, '').trim() }
}

export function editQueuedPrompt(queued: QueuedPrompt, content: string): QueuedPrompt | undefined {
  const parsed = parseQueueMessage(content)
  if (!parsed.queued || !parsed.text) return undefined
  let replacedText = false
  const input: UserInput[] = []
  for (const item of queued.input) {
    if (item.type !== 'text') {
      input.push(item)
      continue
    }
    if (replacedText) continue
    replacedText = true
    input.push({ type: 'text', text: parsed.text, text_elements: [] })
  }
  if (!replacedText) input.push({ type: 'text', text: parsed.text, text_elements: [] })
  return {
    ...queued,
    displayText: parsed.text,
    input,
  }
}
