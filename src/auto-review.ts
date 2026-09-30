import { createHash } from 'node:crypto'
import type { JsonObject, VerbosityLevel } from './types.js'

const outcomes: Record<string, string> = {
  inProgress: 'is reviewing',
  approved: 'approved',
  denied: 'denied',
  timedOut: 'timed out while reviewing',
  aborted: 'aborted its review of',
}

const actions: Record<string, string> = {
  command: 'a command',
  execve: 'a child process',
  writeStdin: 'input to a running command',
  applyPatch: 'file changes',
  networkAccess: 'network access',
  mcpToolCall: 'a tool call',
  requestPermissions: 'additional permissions',
}

export function autoReviewSignature(params: JsonObject): string | undefined {
  const review = params.review && typeof params.review === 'object' && !Array.isArray(params.review)
    ? params.review as JsonObject
    : undefined
  if (!review || !['approved', 'denied', 'timedOut', 'aborted'].includes(String(review.status))) return undefined
  const rationale = typeof review.rationale === 'string'
    ? review.rationale.replace(/\s+/g, ' ').trim()
    : ''
  return createHash('sha256').update(`${review.status}|${rationale}`).digest('hex')
}

export function parseLegacyAutoReviewWarning(message: string): JsonObject | undefined {
  const match = message.match(/^Automatic approval review (approved|denied|timed out|timedOut|aborted)(?: \(risk: ([^,)]*), authorization: ([^)]*)\))?:\s*([\s\S]*)$/)
  if (!match) return undefined
  return {
    review: {
      status: match[1] === 'timed out' ? 'timedOut' : match[1]!,
      rationale: match[4] || '',
      ...(match[2] ? { riskLevel: match[2] } : {}),
      ...(match[3] ? { userAuthorization: match[3] } : {}),
    },
  }
}

export function formatAutoReviewNotice(params: JsonObject, level: VerbosityLevel): string {
  const review = params.review && typeof params.review === 'object' && !Array.isArray(params.review)
    ? params.review as JsonObject
    : {}
  const action = params.action && typeof params.action === 'object' && !Array.isArray(params.action)
    ? params.action as JsonObject
    : {}
  const status = typeof review.status === 'string' ? review.status : ''
  const operation = typeof action.type === 'string' ? actions[action.type] || 'an action' : 'an action'
  const verb = outcomes[status]
  const icon = status === 'approved' ? '✓' : status === 'inProgress' ? '◷' : '⚠'
  const lines = [verb
    ? `${icon} Codex automatic review ${verb} ${operation}.`
    : '⚠ Codex reported an unrecognized automatic-review result. No client approval was granted.']
  if (status === 'approved') lines.push('This approves the action; it does not confirm execution succeeded.')
  if (status === 'timedOut' || status === 'aborted') lines.push('The action was not approved by this review.')
  if (level !== 'text_only') {
    if (['low', 'medium', 'high', 'critical'].includes(String(review.riskLevel))) {
      lines.push(`Risk assessed by reviewer: ${review.riskLevel}.`)
    }
    if (['unknown', 'low', 'medium', 'high'].includes(String(review.userAuthorization))) {
      lines.push(`User authorization assessed by reviewer: ${review.userAuthorization}.`)
    }
    if (typeof review.rationale === 'string' && review.rationale.trim()) {
      const rationale = review.rationale.replace(/[\r\n]+/g, ' ').replaceAll('`', 'ˋ').trim()
      lines.push(`Reason: \`${rationale.length > 600 ? `${rationale.slice(0, 599)}…` : rationale}\``)
    }
  }
  return lines.join('\n')
}
