import type { CodexThreadTurn } from './codex-app-server.js'
import {
  formatCompletedToolItem,
  rewriteLocalFileLinks,
  splitMarkdownForDiscord,
} from './discord-output.js'
import type { JsonObject, VerbosityLevel } from './types.js'

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function userMessageText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return ''
  return item.content.flatMap((content) => {
    if (!isRecord(content)) return []
    if (content.type === 'text' && typeof content.text === 'string') return [content.text]
    if (content.type === 'skill' && typeof content.name === 'string') {
      return [`[${content.name} skill]`]
    }
    if (content.type === 'image') return ['[image attachment]']
    if (content.type === 'localImage') return ['[local image attachment]']
    return []
  }).join('\n')
}

function historySection(item: JsonObject, verbosity: VerbosityLevel): string | undefined {
  if (item.type === 'userMessage') {
    const body = userMessageText(item).trim()
    return body ? `**You**\n${body}` : undefined
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
    return rewriteLocalFileLinks(item.text.trim())
  }
  if (item.type === 'plan' && typeof item.text === 'string' && item.text.trim()) {
    return rewriteLocalFileLinks(item.text.trim())
  }
  if (item.type === 'reasoning') return undefined
  return formatCompletedToolItem(item, verbosity)
}

function splitLong(value: string, limit: number): string[] {
  return splitMarkdownForDiscord(value, limit)
}

/** Turns must be newest-first, matching thread/turns/list sortDirection=desc. */
export function formatThreadHistory(
  turns: CodexThreadTurn[],
  options: { messageLimit?: number; totalLimit?: number; verbosity?: VerbosityLevel } = {},
): string[] {
  const messageLimit = options.messageLimit ?? 1_900
  const totalLimit = options.totalLimit ?? 24_000
  const verbosity = options.verbosity ?? 'tools_and_text'
  const sections = turns
    .slice()
    .reverse()
    .flatMap((turn) => turn.items.flatMap((item) => historySection(item, verbosity) ?? []))

  let total = sections.reduce((sum, section) => sum + section.length + 2, 0)
  let omitted = false
  while (sections.length > 1 && total > totalLimit) {
    const removed = sections.shift()
    total -= (removed?.length ?? 0) + 2
    omitted = true
  }
  if (sections.length === 1 && total > totalLimit) {
    const notice = '*Earlier content omitted.*\n'
    const keep = Math.max(0, totalLimit - notice.length)
    const tail = keep > 0 ? sections[0]?.slice(-keep) : ''
    sections[0] = `${notice}${tail}`
    omitted = false
  }
  if (omitted) sections.unshift('*Older history omitted.*')
  if (sections.length === 0) return []

  const chunks: string[] = []
  let current = '**Recent Codex history**'
  for (const section of sections) {
    for (const piece of splitLong(section, messageLimit)) {
      if (current.length + piece.length + 2 <= messageLimit) {
        current += `\n\n${piece}`
      } else {
        chunks.push(current)
        current = piece
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}
