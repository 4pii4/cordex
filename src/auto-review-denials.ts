import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { JsonObject } from './types.js'

export type AutoReviewDenial = {
  id: string
  event: JsonObject
  summary: string
  unavailable?: string
}

function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported native review data')
  return value as JsonObject
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid native review string')
  return value
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid native review array')
  return value.map(string)
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value)
}

function selected(value: unknown, options: string[]): string {
  const result = string(value)
  if (!options.includes(result)) throw new Error('Unsupported native review enum')
  return result
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native review timestamp')
  return value
}

function pathUri(value: unknown): string {
  const result = string(value)
  if (path.isAbsolute(result)) return pathToFileURL(result).href
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(result)) return result
  throw new Error('Unsupported native permission path')
}

function absolutePath(value: unknown): string {
  const result = string(value)
  if (path.isAbsolute(result)) return result
  if (result.startsWith('file:')) {
    const localized = fileURLToPath(result)
    if (path.isAbsolute(localized)) return localized
  }
  throw new Error('Native review path cannot be localized on this host')
}

function fileSystemEntry(value: unknown): JsonObject {
  const entry = record(value)
  const item = record(entry.path)
  const access = selected(entry.access, ['read', 'write', 'deny'])
  let nativePath: JsonObject
  if (item.type === 'path') nativePath = { type: 'path', path: pathUri(item.path) }
  else if (item.type === 'glob_pattern') nativePath = { type: 'glob_pattern', pattern: string(item.pattern) }
  else if (item.type === 'special') {
    const special = record(item.value)
    const kind = selected(special.kind, ['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp'])
    nativePath = { type: 'special', value: {
      kind,
      ...(kind === 'project_roots' ? { subpath: optionalString(special.subpath) } : {}),
    } }
  } else throw new Error('Unsupported native filesystem permission entry')
  return { path: nativePath, access }
}

function permissionProfile(value: unknown): JsonObject {
  const profile = record(value)
  if (Object.keys(profile).some(key => !['network', 'fileSystem'].includes(key))) throw new Error('Unsupported native permission profile field')
  let network: JsonObject | null = null
  if (profile.network !== undefined && profile.network !== null) {
    const item = record(profile.network)
    if (Object.keys(item).some(key => key !== 'enabled') ||
      (item.enabled !== undefined && item.enabled !== null && typeof item.enabled !== 'boolean')) throw new Error('Unsupported native network permissions')
    network = { enabled: item.enabled ?? null }
  }
  let fileSystem: JsonObject | null = null
  if (profile.fileSystem !== undefined && profile.fileSystem !== null) {
    const item = record(profile.fileSystem)
    if (Object.keys(item).some(key => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) throw new Error('Unsupported native filesystem permission field')
    let entries: JsonObject[]
    if (item.entries !== undefined && item.entries !== null) {
      if (!Array.isArray(item.entries)) throw new Error('Invalid native filesystem entries')
      entries = item.entries.map(fileSystemEntry)
    } else {
      entries = []
      for (const [key, access] of [['read', 'read'], ['write', 'write']] as const) {
        if (item[key] !== undefined && item[key] !== null) {
          entries.push(...strings(item[key]).map(itemPath => ({ path: { type: 'path', path: pathUri(itemPath) }, access })))
        }
      }
    }
    const depth = item.globScanMaxDepth
    if (depth !== undefined && depth !== null &&
      (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 1)) throw new Error('Invalid native permission glob depth')
    fileSystem = { entries, ...(depth !== undefined && depth !== null ? { glob_scan_max_depth: depth } : {}) }
  }
  return { network, file_system: fileSystem }
}

function nativeAction(value: unknown): JsonObject {
  const action = record(value)
  const source = () => selected(action.source, ['shell', 'unifiedExec']) === 'unifiedExec' ? 'unified_exec' : 'shell'
  switch (action.type) {
    case 'command': return { type: 'command', source: source(), command: string(action.command), cwd: string(action.cwd) }
    case 'execve': return { type: 'execve', source: source(), program: string(action.program), argv: strings(action.argv), cwd: absolutePath(action.cwd) }
    case 'writeStdin': return { type: 'write_stdin', approval_id: string(action.approvalId), process_id: string(action.processId), stdin: string(action.stdin), cwd: pathUri(action.cwd) }
    case 'applyPatch': return { type: 'apply_patch', cwd: string(action.cwd), files: strings(action.files) }
    case 'networkAccess': {
      const port = timestamp(action.port)
      if (port > 65_535) throw new Error('Invalid native network port')
      const protocol = selected(action.protocol, ['http', 'https', 'tcp', 'udp', 'socks5Tcp', 'socks5Udp'])
      return { type: 'network_access', target: string(action.target), host: string(action.host), port,
        protocol: protocol === 'socks5Tcp' ? 'socks5_tcp' : protocol === 'socks5Udp' ? 'socks5_udp' : protocol }
    }
    case 'mcpToolCall': return { type: 'mcp_tool_call', server: string(action.server), tool_name: string(action.toolName), connector_id: optionalString(action.connectorId), connector_name: optionalString(action.connectorName), tool_title: optionalString(action.toolTitle) }
    case 'requestPermissions': return { type: 'request_permissions', reason: optionalString(action.reason), permissions: permissionProfile(action.permissions) }
    default: throw new Error('Unsupported native automatic-review action')
  }
}

// Match 0.159.2's TUI on_guardian_review_notification conversion and serde
// representation, including intentionally absent native-only attribution.
export function nativeDeniedReviewEvent(params: JsonObject): JsonObject {
  const review = record(params.review)
  if (review.status !== 'denied') throw new Error('Only a native denied result can be approved for retry')
  const id = string(params.reviewId)
  const turnId = string(params.turnId)
  if (!id || !turnId) throw new Error('Native denial is missing its identity')
  const startedAt = timestamp(params.startedAtMs)
  const completedAt = timestamp(params.completedAtMs)
  if (completedAt < startedAt) throw new Error('Invalid native denial lifecycle')
  if (params.decisionSource !== 'agent') throw new Error('Unsupported native denial decision source')
  const event: JsonObject = {
    id, turn_id: turnId, started_at_ms: startedAt, completed_at_ms: completedAt,
    status: 'denied', decision_source: 'agent', action: nativeAction(params.action),
  }
  if (review.riskLevel !== undefined && review.riskLevel !== null) event.risk_level = selected(review.riskLevel, ['low', 'medium', 'high', 'critical'])
  if (review.userAuthorization !== undefined && review.userAuthorization !== null) event.user_authorization = selected(review.userAuthorization, ['unknown', 'low', 'medium', 'high'])
  if (review.rationale !== undefined && review.rationale !== null) event.rationale = string(review.rationale)
  return event
}

export function denialSummary(params: JsonObject): string {
  const action = record(params.action)
  const kind = string(action.type)
  const labels: Record<string, string> = {
    command: 'Command', execve: 'Child process', writeStdin: 'Terminal input',
    applyPatch: 'File changes', networkAccess: 'Network access', mcpToolCall: 'Tool call', requestPermissions: 'Permission request',
  }
  // Keep raw command/stdin/rationale out of Discord choices. The stable full
  // review ID and action kind bind this picker to the preceding native notice.
  return `${labels[kind] || 'Unsupported action'} · ${string(params.reviewId)}`
}

export class RecentAutoReviewDenials {
  private readonly records = new Map<string, AutoReviewDenial[]>()
  private readonly attempted = new Map<string, Set<string>>()

  record(threadId: string, params: JsonObject): void {
    if (record(params.review).status !== 'denied') return
    const id = string(params.reviewId)
    if (!id || this.attempted.get(threadId)?.has(id)) return
    let event: JsonObject = {}
    let unavailable: string | undefined
    try { event = nativeDeniedReviewEvent(params) }
    catch (error) { unavailable = error instanceof Error ? error.message : 'Unsupported native denial' }
    const entries = (this.records.get(threadId) || []).filter(entry => entry.id !== id)
    let summary = `Unsupported action · ${id}`
    try { summary = denialSummary(params) } catch { /* Keep unsupported denials visible. */ }
    entries.unshift({ id, event, summary, ...(unavailable ? { unavailable } : {}) })
    this.records.set(threadId, entries.slice(0, 10))
  }

  list(threadId: string): readonly AutoReviewDenial[] {
    return this.records.get(threadId) || []
  }

  take(threadId: string, id: string): AutoReviewDenial | undefined {
    const entries = this.records.get(threadId)
    const index = entries?.findIndex(entry => entry.id === id) ?? -1
    if (!entries || index < 0) return undefined
    const entry = entries[index]
    if (!entry || entry.unavailable) return undefined
    entries.splice(index, 1)
    const attempted = this.attempted.get(threadId) || new Set<string>()
    attempted.add(id)
    if (attempted.size > 2_048) attempted.delete(attempted.values().next().value!)
    this.attempted.set(threadId, attempted)
    return entry
  }

  delete(threadId: string): void {
    this.records.delete(threadId)
    this.attempted.delete(threadId)
  }

  clear(): void {
    this.records.clear()
    this.attempted.clear()
  }
}
