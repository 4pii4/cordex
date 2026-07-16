import type { JsonObject, SessionState } from './types.js'

/**
 * The app-server reports int64 token counts as JSON numbers.  Only values that
 * can be represented exactly in JavaScript are safe to use for context math.
 */
export function isContextTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isContextWindowSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

function validBreakdown(value: unknown): value is TokenUsageBreakdown {
  if (!isRecord(value)) return false
  return (
    isContextTokenCount(value.totalTokens) &&
    isContextTokenCount(value.inputTokens) &&
    isContextTokenCount(value.cachedInputTokens) &&
    isContextTokenCount(value.outputTokens) &&
    isContextTokenCount(value.reasoningOutputTokens)
  )
}

export type ContextUsageUpdate = {
  threadId: string
  turnId: string
  contextTokens: number
  /** null means the server explicitly says that the limit is unknown. */
  contextWindow: number | null
}

/**
 * Parse the current Codex app-server token-usage notification.
 *
 * The parser intentionally accepts only the current protocol shape.  In
 * particular, `last.totalTokens` is the active context count; `total` is a
 * cumulative lifetime count and must never be used for the context window.
 * An absent modelContextWindow is treated as malformed, while an explicit
 * null is a valid authoritative "unknown" value.
 */
export function parseContextUsage(params: JsonObject): ContextUsageUpdate | undefined {
  if (!nonEmptyString(params.threadId) || typeof params.turnId !== 'string') return undefined
  if (params.turnId !== '' && !nonEmptyString(params.turnId)) return undefined
  if (!isRecord(params.tokenUsage)) return undefined
  if (!validBreakdown(params.tokenUsage.total) || !validBreakdown(params.tokenUsage.last)) {
    return undefined
  }
  if (!Object.hasOwn(params.tokenUsage, 'modelContextWindow')) return undefined

  const rawWindow = params.tokenUsage.modelContextWindow
  let contextWindow: number | null
  if (rawWindow === null) contextWindow = null
  else if (isContextWindowSize(rawWindow)) contextWindow = rawWindow
  else return undefined

  return {
    threadId: params.threadId,
    turnId: params.turnId,
    contextTokens: params.tokenUsage.last.totalTokens,
    contextWindow,
  }
}

/**
 * Return the rounded used percentage.  The value is deliberately not capped:
 * an over-window report is important diagnostic information and the raw token
 * count remains visible to the user.
 */
export function contextUsagePercent(
  contextTokens: number,
  contextWindow: number | null | undefined,
): number | undefined {
  if (!isContextTokenCount(contextTokens) || !isContextWindowSize(contextWindow)) return undefined
  const percent = Math.round((contextTokens / contextWindow) * 100)
  return Number.isSafeInteger(percent) && percent >= 0 ? percent : undefined
}

export function formatContextUsage(options: {
  contextTokens: number
  contextWindow?: number
}): string | undefined {
  if (!isContextTokenCount(options.contextTokens)) return undefined
  const tokens = options.contextTokens.toLocaleString('en-US')
  if (!isContextWindowSize(options.contextWindow)) {
    return `${tokens} tokens (context limit unavailable)`
  }
  const percent = contextUsagePercent(options.contextTokens, options.contextWindow)
  if (percent === undefined) return undefined
  return `${percent}%, ${tokens} / ${options.contextWindow.toLocaleString('en-US')} tokens`
}

/** Apply a validated snapshot to persisted session state without clamping it. */
export function applyContextUsage(
  session: Pick<SessionState, 'contextTokens' | 'contextWindow'>,
  update: Pick<ContextUsageUpdate, 'contextTokens' | 'contextWindow'>,
): void {
  session.contextTokens = update.contextTokens
  if (update.contextWindow === null) delete session.contextWindow
  else session.contextWindow = update.contextWindow
}
