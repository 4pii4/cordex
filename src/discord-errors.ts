import type { JsonObject } from './types.js'

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isUnknownDiscordChannelError(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.status === 404) return true
  if (error.code === 10_003 || error.code === '10003') return true
  return isRecord(error.rawError) && (
    error.rawError.code === 10_003 ||
    error.rawError.code === '10003' ||
    error.rawError.status === 404
  )
}
