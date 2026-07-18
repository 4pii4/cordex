import { createHash } from 'node:crypto'
import type { CordexState, DiscordOutboxEntry } from './types.js'

export const maxDiscordOutboxDeliveredKeys = 2_048

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

export function discordOutboxNonce(key: string): string {
  return `cx${createHash('sha256').update(key).digest('hex').slice(0, 30)}`
}

export function createDiscordOutboxEntries(options: {
  discordThreadId: string
  codexThreadId: string
  turnId: string
  itemKey: string
  chunks: string[]
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
      typeof raw.nonce !== 'string' ||
      raw.nonce.length === 0 ||
      raw.nonce.length > 32 ||
      typeof raw.createdAt !== 'string'
    ) return []
    const entry = raw as unknown as DiscordOutboxEntry
    const expectedKey = discordOutboxKey(entry)
    const outputKey = discordOutboxOutputKey(entry)
    if (
      entry.key !== expectedKey ||
      entry.nonce !== discordOutboxNonce(expectedKey) ||
      delivered.has(entry.key) ||
      delivered.has(outputKey) ||
      pending.has(entry.key)
    ) return []
    pending.add(entry.key)
    return [{ ...entry }]
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
