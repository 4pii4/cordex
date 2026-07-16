import path from 'node:path'
import type { JsonObject, VerbosityLevel } from './types.js'

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function escapeInlineMarkdown(value: string): string {
  return value.replace(/([*_~|`\\])/g, '\\$1')
}

function inlineCode(value: string): string {
  return '`' + value.replaceAll('`', 'ˋ') + '`'
}

function emphasis(value: string): string {
  return `*${escapeInlineMarkdown(value)}*`
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function rewriteLocalFileLinks(value: string): string {
  const render = (_match: string, label: string, target: string) =>
    `${inlineCode(label)} — ${inlineCode(target.trim())}`
  return value
    .replace(/\[([^\]\n]+)\]\(<(\/[^>\n]+)>\)/g, render)
    .replace(/\[([^\]\n]+)\]\((\/[^)\n]+)\)/g, render)
}

export function formatAssistantText(value: string): string {
  return rewriteLocalFileLinks(value || '…')
}

type MarkdownLine = {
  text: string
  inCodeBlock: boolean
  language: string
  openingFence: boolean
  closingFence: boolean
}

function markdownLines(content: string): MarkdownLine[] {
  const rawLines = content.match(/[^\n]*\n|[^\n]+$/g) || []
  const lines: MarkdownLine[] = []
  let inCodeBlock = false
  let language = ''
  for (const rawLine of rawLines) {
    const fence = rawLine.trimStart().match(/^```([^\s`]*)/)
    if (fence && !inCodeBlock) {
      language = fence[1] || ''
      lines.push({ text: rawLine, inCodeBlock: false, language, openingFence: true, closingFence: false })
      inCodeBlock = true
    } else if (fence && inCodeBlock) {
      lines.push({ text: rawLine, inCodeBlock: false, language, openingFence: false, closingFence: true })
      inCodeBlock = false
      language = ''
    } else {
      lines.push({ text: rawLine, inCodeBlock, language, openingFence: false, closingFence: false })
    }
  }
  return lines
}

export function splitMarkdownForDiscord(content: string, maxLength = 2_000): string[] {
  if (!content) return ['…']
  if (content.length <= maxLength) return [content]
  const lines = markdownLines(content)
  const chunks: string[] = []
  const closingFence = '```\n'
  let current = ''
  let activeLanguage: string | null = null

  const splitLongLine = (value: string, available: number, inCode: boolean): string[] => {
    const pieces: string[] = []
    let remaining = value
    while (remaining.length > available) {
      let splitAt = available
      if (!inCode) {
        const space = remaining.lastIndexOf(' ', available)
        if (space > available / 2) splitAt = space + 1
      }
      pieces.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }
    if (remaining) pieces.push(remaining)
    return pieces
  }

  for (const line of lines) {
    const openingSize = current.length === 0 && (line.inCodeBlock || line.openingFence)
      ? (`\`\`\`${line.language}\n`).length
      : 0
    const lineLength = line.openingFence && current.length === 0 ? 0 : line.text.length
    const closingSize = activeLanguage !== null || openingSize > 0 ? closingFence.length : 0
    const exceeds = current.length + openingSize + lineLength + closingSize > maxLength

    if (!exceeds) {
      current += line.text
      if (line.inCodeBlock || line.openingFence) activeLanguage = line.language
      else if (line.closingFence) activeLanguage = null
      continue
    }

    if (line.text.length > maxLength) {
      if (current) {
        if (activeLanguage !== null) current += closingFence
        chunks.push(current)
        current = ''
      }
      const overhead = line.inCodeBlock
        ? (`\`\`\`${line.language}\n`).length + closingFence.length
        : 0
      const available = Math.max(10, maxLength - overhead - 10)
      for (const piece of splitLongLine(line.text, available, line.inCodeBlock)) {
        chunks.push(line.inCodeBlock
          ? `\`\`\`${line.language}\n${piece}${closingFence}`
          : piece)
      }
      activeLanguage = null
      continue
    }

    if (current) {
      if (activeLanguage !== null) current += closingFence
      chunks.push(current)
    }
    if (line.closingFence && activeLanguage !== null) {
      current = ''
      activeLanguage = null
    } else if (line.inCodeBlock || line.openingFence) {
      current = `\`\`\`${line.language}\n${line.openingFence ? '' : line.text}`
      activeLanguage = line.language
    } else {
      current = line.text
      activeLanguage = null
    }
  }

  if (current) {
    if (activeLanguage !== null) current += closingFence
    chunks.push(current)
  }
  return chunks
}

function summarizeFields(value: unknown): string {
  if (!isRecord(value)) return ''
  const fields = Object.entries(value).flatMap(([key, field]) => {
    if (field === undefined || field === null) return []
    const serialized = typeof field === 'string' ? field : JSON.stringify(field)
    return [`${key}: ${truncate(normalizeWhitespace(serialized), 50)}`]
  })
  return fields.length ? `(${fields.join(', ')})` : ''
}

function formatBashTitle(command: string): string {
  if (!command) return ''
  const singleLine = !command.includes('\n')
  const firstLine = command.split('\n').find((line) => line.trim())?.trimStart() || ''
  if (singleLine && command.length <= 100) return ` _${escapeInlineMarkdown(command)}_`
  const shortened = truncate(firstLine, 100)
  return shortened ? ` _${escapeInlineMarkdown(shortened)}${shortened.endsWith('…') ? '' : '…'}_` : ''
}

function commandIsReadOnly(item: JsonObject): boolean {
  if (!Array.isArray(item.commandActions) || item.commandActions.length === 0) return false
  return item.commandActions.every((action) => {
    if (!isRecord(action)) return false
    return ['read', 'listFiles', 'search'].includes(text(action.type) || '')
  })
}

function toolNameIsReadOnly(name: string): boolean {
  return ['read', 'glob', 'grep', 'describe-media', 'todoread'].some(
    (candidate) => name === candidate || name.endsWith(`_${candidate}`),
  )
}

function statusFailed(item: JsonObject): boolean {
  const status = text(item.status)?.toLowerCase()
  return status === 'failed' || status === 'error' || status === 'declined' ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

function fileChangeSummary(change: JsonObject): string {
  const filePath = text(change.path) || 'file'
  const name = path.basename(filePath) || filePath
  const { additions, deletions } = diffCounts(text(change.diff) || '')
  return `${emphasis(name)} (+${additions}-${deletions})`
}

function compactModelLabel(model: string, effort: string): string {
  const cleanModel = normalizeWhitespace(model)
  const cleanEffort = normalizeWhitespace(effort)
  return cleanEffort ? `${cleanModel} (${cleanEffort})` : cleanModel
}

export function formatModelLabel(model: string, effort: string): string {
  return compactModelLabel(model, effort)
}

export function formatModelBanner(model: string, effort: string): string {
  return `*using ${escapeInlineMarkdown(compactModelLabel(model, effort))}*`
}

export function formatShellCommandResult(options: {
  command: string
  output: string
  exitCode: number | null
  timedOut?: boolean
  language?: string
  maxLength?: number
}): string {
  const maxLength = options.maxLength ?? 1_900
  const command = truncate(normalizeWhitespace(options.command), 500)
  const result = options.exitCode ?? 'signal'
  const header = `${inlineCode(command)} exited with ${result}${options.timedOut ? ' (timed out)' : ''}`
  const cleanOutput = options.output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .trim()
  if (!cleanOutput) return header
  const language = options.language || ''
  const overhead = header.length + language.length + 10
  const available = Math.max(20, maxLength - overhead)
  const output = cleanOutput.length > available
    ? `${cleanOutput.slice(0, Math.max(0, available - 14))}\n... truncated`
    : cleanOutput
  return `${header}\n\`\`\`${language}\n${output}\n\`\`\``
}

export function formatRunFooter(options: {
  project: string
  branch?: string
  duration: string
  contextPercent?: number
  model: string
  effort: string
}): string {
  const contextPercent = Number.isSafeInteger(options.contextPercent) && (options.contextPercent ?? -1) >= 0
    ? `${options.contextPercent}%`
    : ''
  const parts = [
    truncate(normalizeWhitespace(options.project), 30),
    options.branch ? truncate(normalizeWhitespace(options.branch), 30) : '',
    options.duration,
    contextPercent,
    compactModelLabel(options.model, options.effort),
  ].filter(Boolean).map(escapeInlineMarkdown)
  return `*${parts.join(' ⋅ ')}*`
}

export function formatCompletedToolItem(
  item: JsonObject,
  level: VerbosityLevel,
): string | undefined {
  const type = text(item.type)
  if (!type || level === 'text_only' || ['userMessage', 'agentMessage', 'plan'].includes(type)) {
    return undefined
  }

  if (type === 'reasoning') {
    return level === 'tools_and_text' ? '┣ thinking' : undefined
  }

  if (type === 'commandExecution') {
    if (level === 'text_and_essential_tools' && commandIsReadOnly(item)) return undefined
    const command = text(item.command) || ''
    const exit = typeof item.exitCode === 'number' && item.exitCode !== 0
      ? ` (exit ${item.exitCode})`
      : ''
    return `${statusFailed(item) ? '⨯' : '┣'} bash${formatBashTitle(command)}${exit}`
  }

  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
    const summary = changes.map(fileChangeSummary).join(', ')
    return `${statusFailed(item) ? '⨯' : '◼︎'} apply_patch${summary ? ` ${summary}` : ''}`
  }

  if (type === 'mcpToolCall') {
    const name = [text(item.server), text(item.tool)].filter(Boolean).join('_') || 'mcp'
    if (level === 'text_and_essential_tools' && toolNameIsReadOnly(name)) return undefined
    const error = isRecord(item.error) ? text(item.error.message) : undefined
    return `${statusFailed(item) ? '⨯' : '┣'} ${name}${error ? ` _${escapeInlineMarkdown(truncate(error, 100))}_` : ` ${summarizeFields(item.arguments)}`.trimEnd()}`
  }

  if (type === 'dynamicToolCall') {
    const name = [text(item.namespace), text(item.tool)].filter(Boolean).join('_') || 'tool'
    if (name.endsWith('cordex_action_buttons')) return undefined
    if (level === 'text_and_essential_tools' && toolNameIsReadOnly(name)) return undefined
    return `${statusFailed(item) ? '⨯' : '┣'} ${name} ${summarizeFields(item.arguments)}`.trimEnd()
  }

  if (type === 'collabAgentToolCall') {
    const tool = text(item.tool) || 'agent'
    const prompt = text(item.prompt)
    if (tool === 'spawnAgent') {
      return `┣ agent${prompt ? ` **${escapeInlineMarkdown(truncate(normalizeWhitespace(prompt), 100))}**` : ''}`
    }
    return `┣ ${tool}${prompt ? ` _${escapeInlineMarkdown(truncate(normalizeWhitespace(prompt), 100))}_` : ''}`
  }

  if (type === 'subAgentActivity') {
    const agent = text(item.agentPath) || text(item.agentThreadId) || 'agent'
    return `┣ agent ${emphasis(path.basename(agent) || agent)}${text(item.kind) ? ` (${text(item.kind)})` : ''}`
  }

  if (type === 'webSearch') {
    if (level === 'text_and_essential_tools') return undefined
    return `┣ websearch${text(item.query) ? ` ${emphasis(truncate(normalizeWhitespace(text(item.query) || ''), 100))}` : ''}`
  }

  if (type === 'imageView') {
    if (level === 'text_and_essential_tools') return undefined
    const filePath = text(item.path) || 'image'
    return `┣ read ${emphasis(path.basename(filePath) || filePath)}`
  }

  if (type === 'imageGeneration') {
    const filePath = text(item.savedPath)
    return `┣ imageGeneration${filePath ? ` ${emphasis(path.basename(filePath) || filePath)}` : ''}`
  }

  if (type === 'sleep') {
    return `┣ sleep${typeof item.durationMs === 'number' ? ` (durationMs: ${item.durationMs})` : ''}`
  }
  if (type === 'contextCompaction') return '┣ compact'
  if (type === 'enteredReviewMode') return '┣ review _entered_'
  if (type === 'exitedReviewMode') return '┣ review _exited_'

  const generic = Object.fromEntries(
    Object.entries(item).filter(([key]) => !['id', 'type'].includes(key)),
  )
  return `┣ ${type} ${summarizeFields(generic)}`.trimEnd()
}
