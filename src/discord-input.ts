import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Attachment, Message as DiscordMessage, User } from 'discord.js'
import { getCordexHome } from './config.js'
import { isUnknownDiscordMessageError } from './discord-errors.js'
import type { UserInput } from './types.js'

export const defaultDiscordInputLimits = {
  replyTextCharacters: 1_000,
  richContextCharacters: 12_000,
  messageTextCharacters: 120_000,
  textAttachmentBytes: 1_000_000,
  imageAttachmentBytes: 20_000_000,
  messageAttachmentBytes: 40_000_000,
  downloadTimeoutMs: 30_000,
} as const

export const defaultDiscordAttachmentCachePolicy = {
  maxAgeMs: 7 * 24 * 60 * 60_000,
  maxBytes: 512 * 1_024 * 1_024,
} as const

export type DiscordInputLimits = {
  replyTextCharacters: number
  richContextCharacters: number
  messageTextCharacters: number
  textAttachmentBytes: number
  imageAttachmentBytes: number
  messageAttachmentBytes: number
  downloadTimeoutMs: number
}

export type DiscordInputFeedbackCode =
  | 'attachment-download-failed'
  | 'attachment-total-too-large'
  | 'attachment-too-large'
  | 'attachment-unsupported'
  | 'image-storage-failed'
  | 'reply-unavailable'

export type DiscordInputFeedback = {
  code: DiscordInputFeedbackCode
  message: string
  attachmentName?: string
  retryable?: boolean
}

export type DiscordInputResult = {
  input: UserInput[]
  feedback: DiscordInputFeedback[]
}

export type DiscordAttachmentCachePruneResult = {
  removedFiles: number
  removedBytes: number
  retainedBytes: number
}

export type DiscordInputMessage = Pick<
  DiscordMessage,
  'id' | 'content' | 'author' | 'attachments' | 'reference' | 'fetchReference'
> & Partial<Pick<
  DiscordMessage,
  'embeds' | 'poll' | 'messageSnapshots' | 'mentions' | 'guild'
>>

export type BuildDiscordInputOptions = {
  message: DiscordInputMessage
  botUserId?: string
  contentOverride?: string
  attachmentDirectory?: string
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  limits?: Partial<DiscordInputLimits>
}

const exactTextMimeTypes = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-toml',
  'application/x-typescript',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
])

const imageMimeExtensions = new Map([
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
])

const managedImageName = /^[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/

function normalizeMimeType(value: string | null | undefined): string {
  return (value || '').split(';', 1)[0]?.trim().toLowerCase() || ''
}

export function isSupportedTextMimeType(value: string | null | undefined): boolean {
  const mime = normalizeMimeType(value)
  return mime.startsWith('text/') ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    exactTextMimeTypes.has(mime)
}

export function isSupportedImageMimeType(value: string | null | undefined): boolean {
  return imageMimeExtensions.has(normalizeMimeType(value))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function resolveMentionNames(
  content: string,
  mentions: DiscordInputMessage['mentions'],
  guild: DiscordInputMessage['guild'],
): string {
  let resolved = content
  for (const [userId, user] of mentions?.users?.entries?.() || []) {
    const displayName = nonEmptyString(guild?.members?.cache?.get?.(userId)?.displayName) ||
      nonEmptyString(user?.displayName) ||
      nonEmptyString(user?.username)
    if (!displayName) continue
    resolved = resolved
      .replaceAll(`<@${userId}>`, `@${displayName}`)
      .replaceAll(`<@!${userId}>`, `@${displayName}`)
  }
  for (const [roleId, role] of mentions?.roles?.entries?.() || []) {
    const name = nonEmptyString(role?.name)
    if (name) resolved = resolved.replaceAll(`<@&${roleId}>`, `@${name}`)
  }
  for (const [channelId, channel] of mentions?.channels?.entries?.() || []) {
    const name = nonEmptyString(
      typeof channel === 'object' && channel !== null && 'name' in channel
        ? channel.name
        : undefined,
    )
    if (name) resolved = resolved.replaceAll(`<#${channelId}>`, `#${name}`)
  }
  return resolved
}

function serializeEmbeds(embeds: DiscordInputMessage['embeds']): string {
  const parts: string[] = []
  for (const embed of embeds || []) {
    if (!embed) continue
    const lines: string[] = []
    const author = nonEmptyString(embed.author?.name)
    const title = nonEmptyString(embed.title)
    const url = nonEmptyString(embed.url)
    const description = nonEmptyString(embed.description)
    const footer = nonEmptyString(embed.footer?.text)
    if (author) lines.push(`Author: ${author}`)
    if (title) lines.push(`Title: ${title}`)
    if (url) lines.push(`URL: ${url}`)
    if (description) lines.push(description)
    for (const field of embed.fields || []) {
      const name = nonEmptyString(field?.name)
      const value = nonEmptyString(field?.value)
      if (name && value) lines.push(`${name}: ${value}`)
      else if (name) lines.push(name)
      else if (value) lines.push(value)
    }
    if (footer) lines.push(`Footer: ${footer}`)
    if (lines.length > 0) parts.push(`<embed>\n${lines.join('\n')}\n</embed>`)
  }
  return parts.join('\n\n')
}

function serializePoll(poll: DiscordInputMessage['poll']): string {
  if (!poll) return ''
  const lines: string[] = []
  const question = nonEmptyString(poll.question?.text)
  if (question) lines.push(`Question: ${question}`)
  for (const answer of poll.answers?.values?.() || []) {
    const text = nonEmptyString(answer?.text)
    if (text) lines.push(`- ${text}`)
  }
  return lines.length > 0 ? `<poll>\n${lines.join('\n')}\n</poll>` : ''
}

function serializeMessageSnapshots(
  snapshots: DiscordInputMessage['messageSnapshots'],
): string {
  const parts: string[] = []
  for (const snapshot of snapshots?.values?.() || []) {
    if (!snapshot) continue
    const lines: string[] = []
    const content = resolveMentionNames(
      typeof snapshot.content === 'string' ? snapshot.content.trim() : '',
      snapshot.mentions,
      undefined,
    )
    if (content) lines.push(content)
    const embeds = serializeEmbeds(snapshot.embeds)
    if (embeds) lines.push(embeds)
    if (lines.length > 0) {
      parts.push(`<forwarded-message>\n${lines.join('\n\n')}\n</forwarded-message>`)
    }
  }
  return parts.join('\n\n')
}

function truncateRichContext(value: string, limit: number): string {
  if (value.length <= limit) return value
  const marker = '\n[Discord context truncated]'
  if (limit <= marker.length) return value.slice(0, limit)
  return `${value.slice(0, limit - marker.length).trimEnd()}${marker}`
}

function joinBoundedTextSections(sections: string[], limit: number): string {
  const marker = '\n[Discord input truncated]'
  let text = ''
  for (const section of sections) {
    const separator = text ? '\n\n' : ''
    if (text.length + separator.length + section.length <= limit) {
      text += `${separator}${section}`
      continue
    }
    const overflowing = `${text}${separator}${section}`
    if (limit <= marker.length) return overflowing.slice(0, limit)
    return `${overflowing.slice(0, limit - marker.length).trimEnd()}${marker}`
  }
  return text
}

function messageContent(
  message: DiscordInputMessage,
  override: string | undefined,
  botUserId: string | undefined,
  richContextLimit: number,
): string {
  let content = override ?? message.content
  if (botUserId) content = content.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g'), '')
  content = resolveMentionNames(content, message.mentions, message.guild).trim()
  const richContext = truncateRichContext([
    serializeEmbeds(message.embeds),
    serializePoll(message.poll),
    serializeMessageSnapshots(message.messageSnapshots),
  ].filter(Boolean).join('\n\n'), richContextLimit)
  return [content, richContext].filter(Boolean).join('\n\n')
}

function formatAuthor(author: Pick<User, 'id' | 'username' | 'displayName'>): string {
  const displayName = author.displayName.trim()
  const username = author.username.trim()
  const label = displayName && displayName !== username
    ? `${displayName} (@${username})`
    : `@${username || displayName || 'unknown'}`
  return `${label} (Discord id ${author.id})`
}

function truncateReplyText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const marker = '\n[reply truncated]'
  if (limit <= marker.length) return value.slice(0, limit)
  return `${value.slice(0, limit - marker.length).trimEnd()}${marker}`
}

function quoteReply(value: string): string {
  return value.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
}

async function replyContext(
  message: DiscordInputMessage,
  limit: number,
  timeoutMs: number,
): Promise<{ text?: string; feedback?: DiscordInputFeedback }> {
  if (!message.reference?.messageId) return {}
  let referenced: DiscordMessage
  let timer: NodeJS.Timeout | undefined
  try {
    referenced = await Promise.race([
      message.fetchReference(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Reply fetch timed out')), timeoutMs)
        timer.unref()
      }),
    ])
  } catch (error) {
    return {
      feedback: {
        code: 'reply-unavailable',
        message: 'Could not load the Discord message being replied to; continuing without quoted context.',
        retryable: !isUnknownDiscordMessageError(error),
      },
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
  const content = (referenced.cleanContent || referenced.content).trim()
  if (!content) return {}
  const bounded = truncateReplyText(content, limit)
  return {
    text: `Reply context from ${formatAuthor(referenced.author)}:\n${quoteReply(bounded)}`,
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}

function attachmentName(attachment: Attachment, index: number): string {
  return attachment.name?.trim() || `attachment-${index + 1}`
}

function tooLargeFeedback(name: string, actual: number, limit: number): DiscordInputFeedback {
  return {
    code: 'attachment-too-large',
    attachmentName: name,
    message: `Attachment ${JSON.stringify(name)} is too large (${formatBytes(actual)}; limit ${formatBytes(limit)}).`,
  }
}

type DownloadResult =
  | { bytes: Buffer; responseMime: string }
  | { feedback: DiscordInputFeedback }

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

async function readResponseBytes(response: Response, limit: number): Promise<Buffer | undefined> {
  const length = responseContentLength(response)
  if (length !== undefined && length > limit) return undefined
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length <= limit ? bytes : undefined
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return undefined
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function downloadAttachment(
  attachment: Attachment,
  name: string,
  limit: number,
  timeoutMs: number,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<DownloadResult> {
  if (attachment.size > limit) return { feedback: tooLargeFeedback(name, attachment.size, limit) }
  const controller = new AbortController()
  let timedOut = false
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('Attachment download timed out'))
    }, timeoutMs)
    timer.unref()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
  let response: Response
  try {
    response = await Promise.race([
      fetchImpl(attachment.url, { signal: controller.signal }),
      timeout,
    ])
  } catch {
    controller.abort()
    return {
      feedback: {
        code: 'attachment-download-failed',
        attachmentName: name,
        message: timedOut
          ? `Downloading attachment ${JSON.stringify(name)} from Discord timed out.`
          : `Could not download attachment ${JSON.stringify(name)} from Discord.`,
      },
    }
  }
  if (!response.ok) {
    controller.abort()
    return {
      feedback: {
        code: 'attachment-download-failed',
        attachmentName: name,
        message: `Could not download attachment ${JSON.stringify(name)} from Discord (HTTP ${response.status}).`,
      },
    }
  }
  let bytes: Buffer | undefined
  try {
    bytes = await Promise.race([readResponseBytes(response, limit), timeout])
  } catch {
    controller.abort()
    return {
      feedback: {
        code: 'attachment-download-failed',
        attachmentName: name,
        message: timedOut
          ? `Downloading attachment ${JSON.stringify(name)} from Discord timed out.`
          : `Could not finish downloading attachment ${JSON.stringify(name)} from Discord.`,
      },
    }
  }
  controller.abort()
  if (!bytes) {
    return { feedback: tooLargeFeedback(name, responseContentLength(response) ?? limit + 1, limit) }
  }
  return {
    bytes,
    responseMime: normalizeMimeType(response.headers.get('content-type')),
  }
}

async function persistImage(directory: string, mime: string, bytes: Buffer): Promise<string> {
  const extension = imageMimeExtensions.get(mime)
  if (!extension) throw new Error(`Unsupported image MIME type: ${mime}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const target = path.resolve(directory, `${digest}${extension}`)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = path.join(
    path.dirname(target),
    `.${digest}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return target
}

export async function pruneDiscordAttachmentCache(options: {
  directory?: string
  protectedPaths?: Iterable<string>
  maxAgeMs?: number
  maxBytes?: number
  now?: number
} = {}): Promise<DiscordAttachmentCachePruneResult> {
  const directory = path.resolve(options.directory || path.join(getCordexHome(), 'attachments'))
  const protectedPaths = new Set(
    Array.from(options.protectedPaths || [], (value) => path.resolve(value)),
  )
  const maxAgeMs = options.maxAgeMs ?? defaultDiscordAttachmentCachePolicy.maxAgeMs
  const maxBytes = options.maxBytes ?? defaultDiscordAttachmentCachePolicy.maxBytes
  const now = options.now ?? Date.now()
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('Discord attachment cache limits must be non-negative finite numbers')
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { removedFiles: 0, removedBytes: 0, retainedBytes: 0 }
    }
    throw error
  }
  const files = (await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || !managedImageName.test(entry.name)) return []
    const filePath = path.resolve(directory, entry.name)
    return [stat(filePath).then((metadata) => ({
      path: filePath,
      size: metadata.size,
      modifiedAt: metadata.mtimeMs,
    })).catch(() => undefined)]
  }))).filter((file): file is { path: string; size: number; modifiedAt: number } => file !== undefined)

  let retainedBytes = files.reduce((total, file) => total + file.size, 0)
  let removedBytes = 0
  let removedFiles = 0
  for (const file of files.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    if (protectedPaths.has(file.path)) continue
    const expired = now - file.modifiedAt >= maxAgeMs
    if (!expired && retainedBytes <= maxBytes) continue
    try {
      await unlink(file.path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    retainedBytes -= file.size
    removedBytes += file.size
    removedFiles += 1
  }
  return { removedFiles, removedBytes, retainedBytes }
}

type AttachmentResult = {
  text?: string
  image?: UserInput
  feedback?: DiscordInputFeedback
  consumedBytes?: number
}

function aggregateTooLargeFeedback(name: string, limit: number): DiscordInputFeedback {
  return {
    code: 'attachment-total-too-large',
    attachmentName: name,
    message: `Attachment ${JSON.stringify(name)} exceeds the remaining per-message attachment budget (${formatBytes(limit)}).`,
  }
}

async function processAttachment(
  attachment: Attachment,
  index: number,
  options: {
    directory: string
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
    limits: DiscordInputLimits
    remainingBytes: number
  },
): Promise<AttachmentResult> {
  const name = attachmentName(attachment, index)
  const declaredMime = normalizeMimeType(attachment.contentType)
  const textAttachment = isSupportedTextMimeType(declaredMime)
  const imageAttachment = isSupportedImageMimeType(declaredMime)
  if (!textAttachment && !imageAttachment) {
    return {
      feedback: {
        code: 'attachment-unsupported',
        attachmentName: name,
        message: [
          `Attachment ${JSON.stringify(name)} has unsupported type`,
          `${JSON.stringify(declaredMime || 'unknown')}; supported inputs are text files`,
          'and PNG, JPEG, GIF, or WebP images.',
        ].join(' '),
      },
    }
  }

  const perFileLimit = textAttachment
    ? options.limits.textAttachmentBytes
    : options.limits.imageAttachmentBytes
  if (attachment.size > options.remainingBytes) {
    return { feedback: aggregateTooLargeFeedback(name, options.remainingBytes) }
  }
  const limit = Math.min(perFileLimit, options.remainingBytes)
  const downloaded = await downloadAttachment(
    attachment,
    name,
    limit,
    options.limits.downloadTimeoutMs,
    options.fetchImpl,
  )
  if ('feedback' in downloaded) {
    return {
      feedback: limit < perFileLimit && downloaded.feedback.code === 'attachment-too-large'
        ? aggregateTooLargeFeedback(name, options.remainingBytes)
        : downloaded.feedback,
    }
  }
  const consumedBytes = downloaded.bytes.length

  if (textAttachment) {
    if (
      downloaded.responseMime &&
      downloaded.responseMime !== 'application/octet-stream' &&
      !isSupportedTextMimeType(downloaded.responseMime)
    ) {
      return {
        consumedBytes,
        feedback: {
          code: 'attachment-unsupported',
          attachmentName: name,
          message: `Attachment ${JSON.stringify(name)} was served as unsupported type ${JSON.stringify(downloaded.responseMime)}.`,
        },
      }
    }
    const decoded = new TextDecoder().decode(downloaded.bytes).replaceAll('\u0000', '\ufffd')
    return {
      consumedBytes,
      text: [
        `Discord attachment ${JSON.stringify(name)} (${declaredMime}, ${formatBytes(downloaded.bytes.length)}):`,
        decoded || '[empty file]',
      ].join('\n'),
    }
  }

  const responseMime = downloaded.responseMime && downloaded.responseMime !== 'application/octet-stream'
    ? downloaded.responseMime
    : declaredMime
  if (!isSupportedImageMimeType(responseMime)) {
    return {
      consumedBytes,
      feedback: {
        code: 'attachment-unsupported',
        attachmentName: name,
        message: `Attachment ${JSON.stringify(name)} was served as unsupported image type ${JSON.stringify(responseMime || 'unknown')}.`,
      },
    }
  }
  try {
    const localPath = await persistImage(options.directory, responseMime, downloaded.bytes)
    return { image: { type: 'localImage', path: localPath }, consumedBytes }
  } catch {
    return {
      consumedBytes,
      feedback: {
        code: 'image-storage-failed',
        attachmentName: name,
        message: `Could not store image attachment ${JSON.stringify(name)} for Codex.`,
      },
    }
  }
}

export async function buildDiscordInput(options: BuildDiscordInputOptions): Promise<DiscordInputResult> {
  const limits: DiscordInputLimits = { ...defaultDiscordInputLimits, ...options.limits }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Discord input limit ${name} must be a positive integer`)
    }
  }
  const directory = options.attachmentDirectory || path.join(getCordexHome(), 'attachments')
  const fetchImpl = options.fetchImpl || ((url: string, init?: RequestInit) => fetch(url, init))
  const replyPromise = replyContext(
    options.message,
    limits.replyTextCharacters,
    limits.downloadTimeoutMs,
  )
  const attachmentResults: AttachmentResult[] = []
  let remainingBytes = limits.messageAttachmentBytes
  let index = 0
  for (const attachment of options.message.attachments.values()) {
    const result = await processAttachment(attachment, index, {
      directory,
      fetchImpl,
      limits,
      remainingBytes,
    })
    attachmentResults.push(result)
    remainingBytes = Math.max(0, remainingBytes - (result.consumedBytes || 0))
    index += 1
  }
  const reply = await replyPromise

  const feedback = [
    ...(reply.feedback ? [reply.feedback] : []),
    ...attachmentResults.flatMap((result) => result.feedback ? [result.feedback] : []),
  ]
  const content = messageContent(
    options.message,
    options.contentOverride,
    options.botUserId,
    limits.richContextCharacters,
  )
  const textSections = [
    reply.text,
    reply.text && content ? `Current Discord message:\n${content}` : content,
    ...attachmentResults.flatMap((result) => result.text ? [result.text] : []),
  ].filter((value): value is string => Boolean(value))
  const boundedText = joinBoundedTextSections(textSections, limits.messageTextCharacters)
  const input: UserInput[] = [
    ...(boundedText
      ? [{ type: 'text' as const, text: boundedText, text_elements: [] as [] }]
      : []),
    ...attachmentResults.flatMap((result) => result.image ? [result.image] : []),
  ]
  return { input, feedback }
}
