import { createHash } from 'node:crypto'
import type { CordexState, DiscordOutboxEntry } from './types.js'
import { validGeneratedImageAttachment } from './discord-generated-media.js'
import { validOutgoingFileAttachments } from './discord-outgoing-files.js'

export const maxDiscordOutboxDeliveredKeys = 2_048
const maxDiscordOutboxNonceLength = 25
const legacyDiscordOutboxNonceLength = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encoded(label: string, value: string): string {
  return `${label}:${encodeURIComponent(value)}`
}

export function discordOutboxKey(options: {
  discordThreadId: string
  codexThreadId: string
  turnId: string
  itemKey: string
  chunkIndex: number
}): string {
  return `${discordOutboxOutputKey(options)}|chunk:${options.chunkIndex}`
}

export function discordOutboxOutputKey(options: {
  discordThreadId: string
  codexThreadId: string
  turnId: string
  itemKey: string
}): string {
  return [
    encoded('discord', options.discordThreadId),
    encoded('codex', options.codexThreadId),
    encoded('turn', options.turnId),
    encoded('output', options.itemKey),
  ].join('|')
}

function discordOutboxNonceForLength(key: string, length: number): string {
  return `cx${createHash('sha256').update(key).digest('hex').slice(0, length - 2)}`
}

export function discordOutboxNonce(key: string): string {
  return discordOutboxNonceForLength(key, maxDiscordOutboxNonceLength)
}

export function createDiscordOutboxEntries(options: {
  discordThreadId: string
  codexThreadId: string
  turnId: string
  itemKey: string
  chunks: string[]
  attachment?: DiscordOutboxEntry['attachment']
  fileAttachments?: DiscordOutboxEntry['fileAttachments']
  suppressNotifications: boolean
  createdAt?: string
}): DiscordOutboxEntry[] {
  const createdAt = options.createdAt || new Date().toISOString()
  return options.chunks.map((content, chunkIndex) => {
    const identity = {
      discordThreadId: options.discordThreadId,
      codexThreadId: options.codexThreadId,
      turnId: options.turnId,
      itemKey: options.itemKey,
      chunkIndex,
    }
    const key = discordOutboxKey(identity)
    return {
      key,
      ...identity,
      content,
      ...(chunkIndex === 0 && options.attachment ? { attachment: options.attachment } : {}),
      ...(chunkIndex === 0 && options.fileAttachments ? { fileAttachments: options.fileAttachments } : {}),
      suppressNotifications: options.suppressNotifications,
      nonce: discordOutboxNonce(key),
      createdAt,
    }
  })
}

export function parseDiscordOutboxDeliveredKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = [...new Set(value.filter((entry): entry is string =>
    typeof entry === 'string' && entry.length > 0))]
  return unique.slice(-maxDiscordOutboxDeliveredKeys)
}

export function parseDiscordOutbox(
  value: unknown,
  deliveredKeys: Iterable<string> = [],
): DiscordOutboxEntry[] {
  if (!Array.isArray(value)) return []
  const delivered = new Set(deliveredKeys)
  const pending = new Set<string>()
  return value.flatMap((raw) => {
    if (
      !isRecord(raw) ||
      typeof raw.key !== 'string' ||
      typeof raw.discordThreadId !== 'string' ||
      typeof raw.codexThreadId !== 'string' ||
      typeof raw.turnId !== 'string' ||
      typeof raw.itemKey !== 'string' ||
      !Number.isSafeInteger(raw.chunkIndex) ||
      Number(raw.chunkIndex) < 0 ||
      typeof raw.content !== 'string' ||
      (raw.attachment !== undefined && (!validGeneratedImageAttachment(raw.attachment) || raw.chunkIndex !== 0)) ||
      (raw.fileAttachments !== undefined && (!validOutgoingFileAttachments(raw.fileAttachments) || raw.chunkIndex !== 0)) ||
      (raw.attachment !== undefined && raw.fileAttachments !== undefined) ||
      (raw.suppressNotifications !== undefined && typeof raw.suppressNotifications !== 'boolean') ||
      typeof raw.nonce !== 'string' ||
      raw.nonce.length === 0 ||
      raw.nonce.length > legacyDiscordOutboxNonceLength ||
      typeof raw.createdAt !== 'string'
    ) return []
    const entry = raw as unknown as DiscordOutboxEntry
    const expectedKey = discordOutboxKey(entry)
    const outputKey = discordOutboxOutputKey(entry)
    const expectedNonce = discordOutboxNonce(expectedKey)
    if (
      entry.key !== expectedKey ||
      (
        entry.nonce !== expectedNonce &&
        entry.nonce !== discordOutboxNonceForLength(expectedKey, legacyDiscordOutboxNonceLength)
      ) ||
      delivered.has(entry.key) ||
      delivered.has(outputKey) ||
      pending.has(entry.key)
    ) return []
    pending.add(entry.key)
    return [{
      ...entry,
      ...(raw.attachment !== undefined
        ? { attachment: raw.attachment as NonNullable<DiscordOutboxEntry['attachment']> }
        : {}),
      ...(raw.fileAttachments !== undefined
        ? { fileAttachments: raw.fileAttachments as NonNullable<DiscordOutboxEntry['fileAttachments']> }
        : {}),
      suppressNotifications: raw.suppressNotifications === true,
      nonce: expectedNonce,
    }]
  })
}

export function ensureDiscordOutboxState(state: CordexState): {
  outbox: DiscordOutboxEntry[]
  deliveredKeys: string[]
} {
  state.discordOutbox ??= []
  state.discordOutboxDeliveredKeys ??= []
  if (state.discordOutboxDeliveredKeys.length > maxDiscordOutboxDeliveredKeys) {
    state.discordOutboxDeliveredKeys.splice(
      0,
      state.discordOutboxDeliveredKeys.length - maxDiscordOutboxDeliveredKeys,
    )
  }
  return {
    outbox: state.discordOutbox,
    deliveredKeys: state.discordOutboxDeliveredKeys,
  }
}

export function rememberDiscordOutboxDeliveredKey(deliveredKeys: string[], key: string): void {
  const existing = deliveredKeys.indexOf(key)
  if (existing >= 0) deliveredKeys.splice(existing, 1)
  deliveredKeys.push(key)
  if (deliveredKeys.length > maxDiscordOutboxDeliveredKeys) {
    deliveredKeys.splice(0, deliveredKeys.length - maxDiscordOutboxDeliveredKeys)
  }
}
