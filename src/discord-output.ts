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

type MarkdownFence = {
  marker: string
  info: string
}

type MarkdownLine = {
  text: string
  fenceBefore: MarkdownFence | null
  fenceAfter: MarkdownFence | null
  openingFence: boolean
  closingFence: boolean
}

const DISCORD_MESSAGE_LIMIT = 1_900
const DISCORD_SEMANTIC_TARGET = 1_300

function renderOpeningFence(fence: MarkdownFence): string {
  return `${fence.marker}${fence.info}\n`
}

function renderClosingFence(fence: MarkdownFence): string {
  return `${fence.marker}\n`
}

function unnestListCodeFences(content: string): string {
  const rawLines = content.match(/[^\n]*\n|[^\n]+$/g) || []
  const output: string[] = []
  let listIndent: string | null = null
  let fenceIndent: string | null = null
  let fenceMarker: string | null = null

  for (const rawLine of rawLines) {
    if (fenceIndent !== null) {
      const line = rawLine.startsWith(fenceIndent) ? rawLine.slice(fenceIndent.length) : rawLine
      output.push(line)
      const closing = line.trim().match(/^(`{3,})$/)
      if (closing && fenceMarker && closing[1]!.length >= fenceMarker.length) {
        fenceIndent = null
        fenceMarker = null
      }
      continue
    }

    const listItem = rawLine.match(/^([ \t]*)(?:[-+*]|\d+[.)])\s+/)
    if (listItem) {
      listIndent = listItem[1] || ''
      output.push(rawLine)
      continue
    }

    const nestedFence = rawLine.match(/^([ \t]+)(`{3,})([^`\r\n]*)(?:\r?\n)?$/)
    const nestedIndent = nestedFence?.[1]
    if (nestedIndent !== undefined && listIndent !== null && nestedIndent.length > listIndent.length) {
      if (output.length > 0 && output[output.length - 1]?.trim()) output.push('\n')
      fenceIndent = nestedIndent
      fenceMarker = nestedFence?.[2] || null
      output.push(rawLine.slice(nestedIndent.length))
      continue
    }

    if (rawLine.trim()) {
      const indentation = rawLine.match(/^[ \t]*/)?.[0] || ''
      if (listIndent === null || indentation.length <= listIndent.length) listIndent = null
    }
    output.push(rawLine)
  }

  return output.join('')
}

function markdownLines(content: string): MarkdownLine[] {
  const rawLines = content.match(/[^\n]*\n|[^\n]+$/g) || []
  const lines: MarkdownLine[] = []
  let activeFence: MarkdownFence | null = null
  for (const rawLine of rawLines) {
    const opening = rawLine.trimStart().match(/^(`{3,})([^`\r\n]*)(?:\r?\n)?$/)
    const closing = rawLine.trim().match(/^(`{3,})$/)
    const fenceBefore = activeFence
    if (opening && activeFence === null) {
      activeFence = { marker: opening[1]!, info: opening[2] || '' }
      lines.push({
        text: rawLine,
        fenceBefore,
        fenceAfter: activeFence,
        openingFence: true,
        closingFence: false,
      })
    } else if (activeFence !== null && closing && closing[1]!.length >= activeFence.marker.length) {
      activeFence = null
      lines.push({
        text: rawLine,
        fenceBefore,
        fenceAfter: activeFence,
        openingFence: false,
        closingFence: true,
      })
    } else {
      const normalizedText = activeFence === null
        ? rawLine.replace(/^(\s{0,3})#{4,6}(\s+)/, '$1###$2')
        : rawLine
      lines.push({
        text: normalizedText,
        fenceBefore,
        fenceAfter: activeFence,
        openingFence: false,
        closingFence: false,
      })
    }
  }
  return lines
}

function splitAtCodePointBoundary(value: string, index: number): number {
  if (index <= 0 || index >= value.length) return index
  const previous = value.charCodeAt(index - 1)
  const next = value.charCodeAt(index)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? index - 1
    : index
}

function splitLine(value: string, limit: number, preferWhitespace: boolean): string[] {
  const pieces: string[] = []
  let remaining = value
  while (remaining.length > limit) {
    let splitAt = limit
    if (preferWhitespace) {
      const space = remaining.lastIndexOf(' ', limit - 1)
      if (space > limit / 2) splitAt = space + 1
    }
    splitAt = splitAtCodePointBoundary(remaining, splitAt)
    if (splitAt === 0) {
      throw new RangeError(`maxLength ${limit} cannot contain one Unicode character`)
    }
    pieces.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  if (remaining) pieces.push(remaining)
  return pieces
}

function plainTextFallback(content: string, hardLimit: number, semanticTarget: number): string[] {
  const plain = content.replaceAll('`', 'ˋ')
  const chunks = splitLine(plain, Math.min(hardLimit, semanticTarget), true)
    .filter((chunk) => chunk.trim())
  return chunks.length > 0 ? chunks : ['…']
}

function fencedLinesFit(lines: MarkdownLine[], hardLimit: number): boolean {
  return lines.every((line) => {
    const prefix = line.fenceBefore === null ? 0 : renderOpeningFence(line.fenceBefore).length
    const suffix = line.fenceAfter === null ? 0 : renderClosingFence(line.fenceAfter).length
    const available = hardLimit - prefix - suffix
    if (line.openingFence || line.closingFence) return line.text.length <= available
    if (available < 1) return false
    return available > 1 || !/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(line.text)
  })
}

function splitOversizedMarkdownLines(
  lines: MarkdownLine[],
  hardLimit: number,
  semanticTarget: number,
): MarkdownLine[] {
  return lines.flatMap((line) => {
    if (line.openingFence || line.closingFence) return [line]
    const overhead = (line.fenceBefore === null ? 0 : renderOpeningFence(line.fenceBefore).length) +
      (line.fenceAfter === null ? 0 : renderClosingFence(line.fenceAfter).length)
    const available = Math.max(1, Math.min(hardLimit - overhead, semanticTarget - overhead))
    if (line.text.length <= available) return [line]
    return splitLine(line.text, available, line.fenceBefore === null).map((text) => ({
      ...line,
      text,
    }))
  })
}

type BreakKind = 'heading' | 'paragraph' | 'list' | 'table' | 'tableRow' | 'code' | 'line'

function isHeading(line: MarkdownLine): boolean {
  return line.fenceBefore === null && /^\s{0,3}#{1,6}(?:\s+|$)/.test(line.text)
}

function isTableRow(line: MarkdownLine): boolean {
  return line.fenceBefore === null && /^\s*\|.*\|\s*$/.test(line.text.trimEnd())
}

function breakKind(lines: MarkdownLine[], end: number): BreakKind | null {
  const previous = lines[end - 1]
  const next = lines[end]
  if (!previous || !next || previous.openingFence || next.closingFence) return null
  if (previous.fenceAfter !== null && next.fenceBefore !== null) return 'code'
  if (isHeading(next)) return 'heading'
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(next.text)) return 'list'
  if (!previous.text.trim()) return 'paragraph'
  if (isTableRow(next)) return isTableRow(previous) ? 'tableRow' : 'table'
  return 'line'
}

function wouldOrphanHeading(lines: MarkdownLine[], start: number, end: number): boolean {
  for (let index = end - 1; index >= start; index--) {
    const line = lines[index]
    if (!line || !line.text.trim()) continue
    return isHeading(line)
  }
  return false
}

function breakPriority(kind: BreakKind): number {
  if (kind === 'heading') return 3
  if (kind === 'paragraph' || kind === 'list') return 2
  if (kind === 'table') return 1
  return 0
}

export function splitMarkdownForDiscord(content: string, maxLength = DISCORD_MESSAGE_LIMIT): string[] {
  if (!content.trim()) return ['…']
  const hardLimit = Math.max(1, Math.min(Math.floor(maxLength), DISCORD_MESSAGE_LIMIT))
  const semanticTarget = Math.min(hardLimit, DISCORD_SEMANTIC_TARGET)
  const normalized = unnestListCodeFences(content)
  const parsedLines = markdownLines(normalized)
  if (!fencedLinesFit(parsedLines, hardLimit)) {
    return plainTextFallback(normalized, hardLimit, semanticTarget)
  }
  const lines = splitOversizedMarkdownLines(parsedLines, hardLimit, semanticTarget)
  if (lines.length === 0) return ['…']

  const textLengths = [0]
  for (const line of lines) textLengths.push((textLengths[textLengths.length - 1] || 0) + line.text.length)

  const rangeLength = (start: number, end: number): number => {
    const first = lines[start]
    const last = lines[end - 1]
    if (!first || !last) return 0
    const prefix = first.fenceBefore === null ? 0 : renderOpeningFence(first.fenceBefore).length
    const suffix = last.fenceAfter === null ? 0 : renderClosingFence(last.fenceAfter).length
    return prefix + (textLengths[end] || 0) - (textLengths[start] || 0) + suffix
  }

  const renderRange = (start: number, end: number): string => {
    const first = lines[start]
    const last = lines[end - 1]
    if (!first || !last) return ''
    const prefix = first.fenceBefore === null ? '' : renderOpeningFence(first.fenceBefore)
    const suffix = last.fenceAfter === null ? '' : renderClosingFence(last.fenceAfter)
    return prefix + lines.slice(start, end).map((line) => line.text).join('') + suffix
  }

  const chunks: string[] = []
  const pushChunk = (chunk: string): void => {
    if (chunk.trim()) chunks.push(chunk)
  }
  let start = 0
  while (start < lines.length) {
    const remainingLength = rangeLength(start, lines.length)
    if (remainingLength <= semanticTarget) {
      pushChunk(renderRange(start, lines.length))
      break
    }

    const candidates: Array<{ end: number; kind: BreakKind; length: number }> = []
    let farthestEnd = start
    for (let end = start + 1; end <= lines.length; end++) {
      const length = rangeLength(start, end)
      if (length > hardLimit) break
      farthestEnd = end
      if (end === lines.length || wouldOrphanHeading(lines, start, end)) continue
      const kind = breakKind(lines, end)
      if (kind) candidates.push({ end, kind, length })
    }

    const targetCandidates = remainingLength <= hardLimit
      ? candidates.filter((candidate) => candidate.kind !== 'tableRow')
      : candidates
    const minimumPreferredLength = Math.floor(semanticTarget / 2)
    const beforeTarget = targetCandidates.filter((candidate) =>
      candidate.length >= minimumPreferredLength && candidate.length <= semanticTarget)
    const preferredBeforeTarget = beforeTarget.filter((candidate) => breakPriority(candidate.kind) > 0)
    const beforePool = preferredBeforeTarget.length > 0 ? preferredBeforeTarget : beforeTarget
    beforePool.sort((left, right) =>
      breakPriority(right.kind) - breakPriority(left.kind) || right.length - left.length)

    let selected = beforePool[0]
    if (!selected) {
      const afterTarget = targetCandidates.filter((candidate) => candidate.length > semanticTarget)
      const preferredAfterTarget = afterTarget.filter((candidate) => breakPriority(candidate.kind) > 0)
      const afterPool = preferredAfterTarget.length > 0 ? preferredAfterTarget : afterTarget
      afterPool.sort((left, right) =>
        breakPriority(right.kind) - breakPriority(left.kind) || left.length - right.length)
      selected = afterPool[0]
    }

    if (!selected && remainingLength <= hardLimit) {
      pushChunk(renderRange(start, lines.length))
      break
    }

    const end = selected?.end ?? farthestEnd
    if (end <= start) {
      const raw = renderRange(start, lines.length)
      for (const chunk of plainTextFallback(raw, hardLimit, semanticTarget)) pushChunk(chunk)
      break
    }
    pushChunk(renderRange(start, end))
    start = end
  }
  return chunks.length > 0 ? chunks : ['…']
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
    const icon = statusFailed(item) ? '⨯' : '┣'
    if (tool === 'spawnAgent') {
      return `${icon} agent${prompt ? ` **${escapeInlineMarkdown(truncate(normalizeWhitespace(prompt), 100))}**` : ''}`
    }
    return `${icon} ${tool}${prompt ? ` _${escapeInlineMarkdown(truncate(normalizeWhitespace(prompt), 100))}_` : ''}`
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
    return `${statusFailed(item) ? '⨯' : '┣'} imageGeneration${filePath ? ` ${emphasis(path.basename(filePath) || filePath)}` : ''}`
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
