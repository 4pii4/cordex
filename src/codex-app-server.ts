import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
  ApprovalPolicy,
  CodexModel,
  CodexThreadSummary,
  DynamicToolSpec,
  JsonObject,
  ReasoningEffort,
  SandboxMode,
  ServerNotification,
  ServerRequest,
  UserInput,
} from './types.js'
import { packageVersion } from './version.js'

type PendingRequest = { resolve(value: unknown): void; reject(error: Error): void }

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`Invalid ${label} response from Codex`)
  return value
}

function sandboxPolicy(mode: SandboxMode): JsonObject {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

export type StartThreadOptions = {
  cwd: string
  model?: string
  serviceTier?: string | null
  dynamicTools?: DynamicToolSpec[]
  runtimeWorkspaceRoots?: string[]
  sandbox?: SandboxMode
  permissions?: string
  approvalPolicy: ApprovalPolicy
}

export type StartTurnOptions = {
  threadId: string
  input: UserInput[]
  model?: string
  effort?: ReasoningEffort
  serviceTier?: string | null
  sandbox?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  mode?: 'default' | 'plan'
  runtimeWorkspaceRoots?: string[]
  permissions?: string
  clientUserMessageId?: string
}

export type ForkThreadOptions = StartThreadOptions & {
  threadId: string
  lastTurnId?: string
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'custom'; instructions: string }

export type CodexAuthStatus = {
  authMethod?: string
  hasToken: boolean
  requiresOpenaiAuth: boolean
}

export type AccountLoginResult =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }

export type CodexThreadGoal = {
  threadId: string
  objective: string
  status: string
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
}

export type CodexSubagentThread = {
  threadId: string
  agentPath?: string
  prompt?: string
  status?: string
  activity?: string
}

export type CodexThreadTurn = {
  id: string
  items: JsonObject[]
}

export type CodexMcpServerConfig = {
  name: string
  enabled: boolean
  scope: 'global' | 'profile' | 'project' | 'managed' | 'unknown'
  globalConfigurable: boolean
  filePath?: string
}

export type CodexMcpToggleResult = {
  status: 'ok' | 'okOverridden'
  filePath: string
  effectiveEnabled: boolean
}

export type CodexFileSearchResult = {
  root: string
  path: string
  fileName: string
  score: number
}

function parseThreadTurns(value: unknown): CodexThreadTurn[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((turnValue) => {
    if (!isRecord(turnValue) || typeof turnValue.id !== 'string' || !Array.isArray(turnValue.items)) {
      return []
    }
    return [{
      id: turnValue.id,
      items: turnValue.items.flatMap((item) => (isRecord(item) ? [item] : [])),
    }]
  })
}

function parseThreadGoal(value: unknown): CodexThreadGoal {
  const goal = asRecord(value, 'thread goal')
  if (
    typeof goal.threadId !== 'string' ||
    typeof goal.objective !== 'string' ||
    typeof goal.status !== 'string' ||
    typeof goal.tokensUsed !== 'number' ||
    typeof goal.timeUsedSeconds !== 'number'
  ) {
    throw new Error('Codex thread goal omitted required fields')
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    ...(typeof goal.tokenBudget === 'number' ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
  }
}

export class CodexAppServer extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new Map<string | number, PendingRequest>()
  private readonly ready: Promise<void>
  private readonly verbose: boolean

  constructor(options: { command?: string; args?: string[]; verbose?: boolean } = {}) {
    super()
    this.verbose = options.verbose === true
    this.child = spawn(
      options.command || process.env.CORDEX_CODEX_BIN || 'codex',
      options.args || ['app-server', '--stdio'],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== 'CORDEX_DISCORD_TOKEN'),
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => this.emit('stderr', chunk))
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    this.child.once('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`)
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
      this.emit('close', error)
    })
    this.ready = this.initialize()
  }

  private send(message: unknown): void {
    if (!this.child.stdin.writable) throw new Error('Codex app-server stdin is closed')
    const line = JSON.stringify(message)
    if (this.verbose) console.error(`[codex ->] ${line}`)
    this.child.stdin.write(`${line}\n`)
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'cordex', title: 'Cordex', version: await packageVersion() },
      capabilities: { experimentalApi: true },
    })
    this.send({ method: 'initialized' })
  }

  private handleLine(line: string): void {
    if (this.verbose) console.error(`[codex <-] ${line}`)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.emit('protocolError', new Error(`Invalid JSON from Codex: ${line.slice(0, 200)}`))
      return
    }
    if (!isRecord(value)) return
    const object: JsonObject = value
    const responseId =
      typeof object.id === 'string' || typeof object.id === 'number' ? object.id : undefined
    if (responseId !== undefined && typeof object.method !== 'string') {
      const pending = this.pending.get(responseId)
      if (!pending) return
      this.pending.delete(responseId)
      if (isRecord(object.error)) {
        pending.reject(
          new Error(
            `Codex RPC ${String(object.error.code ?? 'error')}: ${String(object.error.message ?? 'Unknown error')}`,
          ),
        )
      }
      else pending.resolve(object.result)
      return
    }
    const method = typeof object.method === 'string' ? object.method : undefined
    const params = isRecord(object.params) ? object.params : undefined
    if (!method || !params) return
    if (responseId !== undefined) {
      this.emit('serverRequest', { id: responseId, method, params } satisfies ServerRequest)
      return
    }
    this.emit('notification', { method, params } satisfies ServerNotification)
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send({ id, method, params })
    return promise
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result })
  }

  async startThread(options: StartThreadOptions): Promise<{ threadId: string; model: string }> {
    await this.ready
    const response = asRecord(
      await this.request('thread/start', {
        cwd: options.cwd,
        model: options.model ?? null,
        ...('serviceTier' in options ? { serviceTier: options.serviceTier ?? null } : {}),
        dynamicTools: options.dynamicTools ?? null,
        runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
        sandbox: options.permissions ? null : options.sandbox ?? null,
        permissions: options.permissions ?? null,
        approvalPolicy: options.approvalPolicy,
      }),
      'thread/start',
    )
    const thread = asRecord(response.thread, 'thread/start thread')
    if (typeof thread.id !== 'string' || typeof response.model !== 'string') {
      throw new Error('Codex thread/start omitted thread id or model')
    }
    return { threadId: thread.id, model: response.model }
  }

  async resumeThread(options: StartThreadOptions & {
    threadId: string
    includeTurns?: boolean
  }): Promise<{
    model?: string
    name?: string
    preview?: string
    turns: CodexThreadTurn[]
  }> {
    await this.ready
    const response = asRecord(
      await this.request('thread/resume', {
        threadId: options.threadId,
        cwd: options.cwd,
        model: options.model ?? null,
        ...('serviceTier' in options ? { serviceTier: options.serviceTier ?? null } : {}),
        runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
        sandbox: options.permissions ? null : options.sandbox ?? null,
        permissions: options.permissions ?? null,
        approvalPolicy: options.approvalPolicy,
        ...(options.includeTurns
          ? {
              initialTurnsPage: {
                limit: 30,
                sortDirection: 'desc',
                itemsView: 'full',
              },
            }
          : { excludeTurns: true }),
      }),
      'thread/resume',
    )
    const thread = isRecord(response.thread) ? response.thread : undefined
    const initialTurnsPage = isRecord(response.initialTurnsPage) ? response.initialTurnsPage : undefined
    return {
      ...(typeof response.model === 'string' ? { model: response.model } : {}),
      ...(thread && typeof thread.name === 'string' ? { name: thread.name } : {}),
      ...(thread && typeof thread.preview === 'string' ? { preview: thread.preview } : {}),
      turns: parseThreadTurns(initialTurnsPage?.data),
    }
  }

  async forkThread(options: ForkThreadOptions): Promise<{ threadId: string; model: string }> {
    await this.ready
    const response = asRecord(
      await this.request('thread/fork', {
        threadId: options.threadId,
        lastTurnId: options.lastTurnId ?? null,
        cwd: options.cwd,
        model: options.model ?? null,
        ...('serviceTier' in options ? { serviceTier: options.serviceTier ?? null } : {}),
        runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
        sandbox: options.permissions ? null : options.sandbox ?? null,
        permissions: options.permissions ?? null,
        approvalPolicy: options.approvalPolicy,
      }),
      'thread/fork',
    )
    const thread = asRecord(response.thread, 'thread/fork thread')
    if (typeof thread.id !== 'string' || typeof response.model !== 'string') {
      throw new Error('Codex thread/fork omitted thread id or model')
    }
    return { threadId: thread.id, model: response.model }
  }

  async compactThread(threadId: string): Promise<void> {
    await this.ready
    await this.request('thread/compact/start', { threadId })
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.ready
    await this.request('thread/archive', { threadId })
  }

  async startReview(options: {
    threadId: string
    target: ReviewTarget
    delivery?: 'inline' | 'detached'
  }): Promise<{ turnId: string; reviewThreadId: string }> {
    await this.ready
    const response = asRecord(
      await this.request('review/start', {
        threadId: options.threadId,
        target: options.target,
        delivery: options.delivery ?? 'inline',
      }),
      'review/start',
    )
    const turn = asRecord(response.turn, 'review/start turn')
    if (typeof turn.id !== 'string' || typeof response.reviewThreadId !== 'string') {
      throw new Error('Codex review/start omitted turn or review thread id')
    }
    return { turnId: turn.id, reviewThreadId: response.reviewThreadId }
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<void> {
    await this.ready
    if (!Number.isInteger(numTurns) || numTurns < 1) throw new Error('Rollback turns must be >= 1')
    await this.request('thread/rollback', { threadId, numTurns })
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.ready
    await this.request('thread/name/set', { threadId, name })
  }

  async setThreadGoal(
    threadId: string,
    objective: string,
    tokenBudget?: number,
    status: 'active' | 'paused' | 'blocked' | 'complete' = 'active',
  ): Promise<CodexThreadGoal> {
    await this.ready
    const response = asRecord(
      await this.request('thread/goal/set', {
        threadId,
        objective,
        status,
        tokenBudget: tokenBudget ?? null,
      }),
      'thread/goal/set',
    )
    return parseThreadGoal(response.goal)
  }

  async getThreadGoal(threadId: string): Promise<CodexThreadGoal | null> {
    await this.ready
    const response = asRecord(await this.request('thread/goal/get', { threadId }), 'thread/goal/get')
    return response.goal === null || response.goal === undefined ? null : parseThreadGoal(response.goal)
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    await this.ready
    const response = asRecord(await this.request('thread/goal/clear', { threadId }), 'thread/goal/clear')
    return response.cleared === true
  }

  async updateThreadSettings(options: {
    threadId: string
    model?: string | null
    effort?: ReasoningEffort | null
    permissions?: string | null
    serviceTier?: string | null
    sandbox?: SandboxMode
    approvalPolicy?: ApprovalPolicy
  }): Promise<void> {
    await this.ready
    const params: JsonObject = { threadId: options.threadId }
    if ('model' in options) params.model = options.model ?? null
    if ('effort' in options) params.effort = options.effort ?? null
    if ('permissions' in options) params.permissions = options.permissions ?? null
    if ('serviceTier' in options) params.serviceTier = options.serviceTier ?? null
    if (options.sandbox) params.sandboxPolicy = sandboxPolicy(options.sandbox)
    if (options.approvalPolicy) params.approvalPolicy = options.approvalPolicy
    await this.request('thread/settings/update', params)
  }

  async listThreads(options: { cwd?: string; searchTerm?: string; limit?: number } = {}): Promise<CodexThreadSummary[]> {
    await this.ready
    const response = asRecord(
      await this.request('thread/list', {
        limit: options.limit ?? 25,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: options.cwd ?? null,
        searchTerm: options.searchTerm ?? null,
        archived: false,
      }),
      'thread/list',
    )
    if (!Array.isArray(response.data)) throw new Error('Codex thread/list omitted data')
    return response.data.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.cwd !== 'string') return []
      return [
        {
          id: item.id,
          preview: typeof item.preview === 'string' ? item.preview : '',
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          cwd: item.cwd,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
        },
      ]
    })
  }

  async listSubagentThreads(threadId: string): Promise<CodexSubagentThread[]> {
    await this.ready
    const response = asRecord(
      await this.request('thread/read', { threadId, includeTurns: true }),
      'thread/read',
    )
    const thread = asRecord(response.thread, 'thread/read thread')
    if (!Array.isArray(thread.turns)) return []

    const subagents = new Map<string, CodexSubagentThread>()
    const upsert = (childThreadId: string, update: Omit<CodexSubagentThread, 'threadId'>) => {
      const current = subagents.get(childThreadId)
      subagents.delete(childThreadId)
      subagents.set(childThreadId, { threadId: childThreadId, ...current, ...update })
    }

    for (const turnValue of thread.turns) {
      if (!isRecord(turnValue) || !Array.isArray(turnValue.items)) continue
      for (const itemValue of turnValue.items) {
        if (!isRecord(itemValue)) continue
        if (
          itemValue.type === 'subAgentActivity' &&
          typeof itemValue.agentThreadId === 'string'
        ) {
          upsert(itemValue.agentThreadId, {
            ...(typeof itemValue.agentPath === 'string' ? { agentPath: itemValue.agentPath } : {}),
            ...(typeof itemValue.kind === 'string' ? { activity: itemValue.kind } : {}),
          })
          continue
        }
        if (itemValue.type !== 'collabAgentToolCall' || !Array.isArray(itemValue.receiverThreadIds)) {
          continue
        }
        const agentStates = isRecord(itemValue.agentsStates) ? itemValue.agentsStates : undefined
        for (const receiverThreadId of itemValue.receiverThreadIds) {
          if (typeof receiverThreadId !== 'string') continue
          if (itemValue.tool !== 'spawnAgent' && !subagents.has(receiverThreadId)) continue
          const agentState = agentStates && isRecord(agentStates[receiverThreadId])
            ? agentStates[receiverThreadId]
            : undefined
          upsert(receiverThreadId, {
            ...(typeof itemValue.prompt === 'string' ? { prompt: itemValue.prompt } : {}),
            ...(agentState && typeof agentState.status === 'string'
              ? { status: agentState.status }
              : {}),
          })
        }
      }
    }
    return Array.from(subagents.values()).reverse()
  }

  async listThreadTurns(threadId: string, limit = 30): Promise<CodexThreadTurn[]> {
    await this.ready
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Thread turn limit must be between 1 and 100')
    }
    const response = asRecord(
      await this.request('thread/turns/list', {
        threadId,
        cursor: null,
        limit,
        sortDirection: 'desc',
        itemsView: 'full',
      }),
      'thread/turns/list',
    )
    return parseThreadTurns(response.data)
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    await this.ready
    const response = asRecord(
      await this.request('turn/start', {
        threadId: options.threadId,
        input: options.input,
        model: options.model ?? null,
        effort: options.effort ?? null,
        ...('serviceTier' in options ? { serviceTier: options.serviceTier ?? null } : {}),
        ...(options.sandbox ? { sandboxPolicy: sandboxPolicy(options.sandbox) } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? null,
        ...(options.permissions ? { permissions: options.permissions } : {}),
        collaborationMode: options.mode
          ? {
              mode: options.mode,
              settings: {
                model: options.model ?? '',
                reasoning_effort: options.effort ?? null,
                developer_instructions: null,
              },
            }
          : null,
        clientUserMessageId: options.clientUserMessageId ?? null,
      }),
      'turn/start',
    )
    const turn = asRecord(response.turn, 'turn/start turn')
    if (typeof turn.id !== 'string') throw new Error('Codex turn/start omitted turn id')
    return turn.id
  }

  async steerTurn(options: StartTurnOptions & { expectedTurnId: string }): Promise<void> {
    await this.ready
    await this.request('turn/steer', {
      threadId: options.threadId,
      expectedTurnId: options.expectedTurnId,
      input: options.input,
      clientUserMessageId: options.clientUserMessageId ?? null,
    })
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.ready
    await this.request('turn/interrupt', { threadId, turnId })
  }

  async listModels(): Promise<CodexModel[]> {
    await this.ready
    const models: CodexModel[] = []
    let cursor: string | null = null
    do {
      const response = asRecord(await this.request('model/list', { cursor, limit: 100 }), 'model/list')
      if (!Array.isArray(response.data)) throw new Error('Codex model/list omitted data')
      for (const item of response.data) {
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.model !== 'string') continue
        models.push({
          id: item.id,
          model: item.model,
          displayName: typeof item.displayName === 'string' ? item.displayName : item.model,
          description: typeof item.description === 'string' ? item.description : '',
          hidden: item.hidden === true,
          isDefault: item.isDefault === true,
          defaultReasoningEffort:
            typeof item.defaultReasoningEffort === 'string'
              ? (item.defaultReasoningEffort as ReasoningEffort)
              : 'medium',
        })
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
    } while (cursor)
    return models
  }

  async fuzzyFileSearch(roots: string[], query: string): Promise<CodexFileSearchResult[]> {
    await this.ready
    if (roots.length === 0) return []
    const response = asRecord(
      await this.request('fuzzyFileSearch', {
        query,
        roots,
        cancellationToken: null,
      }),
      'fuzzyFileSearch',
    )
    if (!Array.isArray(response.files)) return []
    return response.files.flatMap((file) => {
      if (
        !isRecord(file) ||
        file.match_type !== 'file' ||
        typeof file.root !== 'string' ||
        typeof file.path !== 'string' ||
        typeof file.file_name !== 'string' ||
        typeof file.score !== 'number'
      ) {
        return []
      }
      return [{ root: file.root, path: file.path, fileName: file.file_name, score: file.score }]
    })
  }

  async listSkills(cwd?: string): Promise<JsonObject[]> {
    await this.ready
    const response = asRecord(
      await this.request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: false }),
      'skills/list',
    )
    if (!Array.isArray(response.data)) return []
    return response.data.flatMap((entry) => (isRecord(entry) ? [entry] : []))
  }

  async listMcpServers(threadId?: string): Promise<JsonObject[]> {
    await this.ready
    const servers: JsonObject[] = []
    let cursor: string | null = null
    do {
      const response = asRecord(
        await this.request('mcpServerStatus/list', {
          cursor,
          limit: 100,
          detail: 'toolsAndAuthOnly',
          threadId: threadId ?? null,
        }),
        'mcpServerStatus/list',
      )
      if (Array.isArray(response.data)) {
        for (const item of response.data) if (isRecord(item)) servers.push(item)
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
    } while (cursor)
    return servers
  }

  async listConfiguredMcpServers(cwd?: string): Promise<CodexMcpServerConfig[]> {
    await this.ready
    const response = asRecord(
      await this.request('config/read', { includeLayers: true, cwd: cwd ?? null }),
      'config/read',
    )
    const config = asRecord(response.config, 'config/read config')
    if (!isRecord(config.mcp_servers)) return []
    const sources = new Map<string, Omit<CodexMcpServerConfig, 'name' | 'enabled'>>()
    if (Array.isArray(response.layers)) {
      for (const layerValue of response.layers) {
        if (!isRecord(layerValue) || !isRecord(layerValue.name) || !isRecord(layerValue.config)) continue
        if (!isRecord(layerValue.config.mcp_servers)) continue
        for (const name of Object.keys(layerValue.config.mcp_servers)) {
          const sourceType = layerValue.name.type
          if (sourceType === 'user' && layerValue.name.profile === null && typeof layerValue.name.file === 'string') {
            sources.set(name, {
              scope: 'global',
              globalConfigurable: true,
              filePath: layerValue.name.file,
            })
            continue
          }
          if (sources.get(name)?.globalConfigurable) continue
          if (sourceType === 'user') {
            sources.set(name, { scope: 'profile', globalConfigurable: false })
          } else if (sourceType === 'project') {
            sources.set(name, { scope: 'project', globalConfigurable: false })
          } else if (
            sourceType === 'system' ||
            sourceType === 'mdm' ||
            sourceType === 'enterpriseManaged' ||
            sourceType === 'legacyManagedConfigTomlFromFile' ||
            sourceType === 'legacyManagedConfigTomlFromMdm'
          ) {
            sources.set(name, { scope: 'managed', globalConfigurable: false })
          } else if (!sources.has(name)) {
            sources.set(name, { scope: 'unknown', globalConfigurable: false })
          }
        }
      }
    }
    return Object.entries(config.mcp_servers).flatMap(([name, value]) => {
      if (!isRecord(value)) return []
      const source = sources.get(name) || { scope: 'unknown' as const, globalConfigurable: false }
      return [{ name, enabled: value.enabled !== false, ...source }]
    }).sort((left, right) => left.name.localeCompare(right.name))
  }

  async setMcpServerEnabled(name: string, enabled: boolean, cwd?: string): Promise<CodexMcpToggleResult> {
    await this.ready
    const normalized = name.trim()
    if (!normalized) throw new Error('MCP server name is required')
    const configured = await this.listConfiguredMcpServers(cwd)
    const selected = configured.find((server) => server.name === normalized)
    if (!selected) {
      throw new Error(`Unknown configured MCP server: ${normalized}`)
    }
    if (!selected.globalConfigurable || !selected.filePath) {
      throw new Error(
        `MCP server ${normalized} is ${selected.scope}-scoped; global toggles require a definition in the base user config`,
      )
    }
    const response = asRecord(
      await this.request('config/value/write', {
        keyPath: `mcp_servers.${JSON.stringify(normalized)}.enabled`,
        value: enabled,
        mergeStrategy: 'upsert',
        filePath: selected.filePath,
      }),
      'config/value/write',
    )
    if (
      (response.status !== 'ok' && response.status !== 'okOverridden') ||
      typeof response.filePath !== 'string'
    ) {
      throw new Error('Codex config/value/write returned an invalid MCP toggle result')
    }
    await this.request('config/mcpServer/reload', undefined)
    const effective = (await this.listConfiguredMcpServers(cwd)).find(
      (server) => server.name === normalized,
    )
    return {
      status: response.status,
      filePath: response.filePath,
      effectiveEnabled: effective?.enabled ?? enabled,
    }
  }

  async listPermissionProfiles(cwd?: string): Promise<JsonObject[]> {
    await this.ready
    const profiles: JsonObject[] = []
    let cursor: string | null = null
    do {
      const response = asRecord(
        await this.request('permissionProfile/list', { cursor, limit: 100, cwd: cwd ?? null }),
        'permissionProfile/list',
      )
      if (Array.isArray(response.data)) {
        for (const item of response.data) if (isRecord(item)) profiles.push(item)
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
    } while (cursor)
    return profiles
  }

  async loginMcpServer(name: string, threadId?: string): Promise<string> {
    await this.ready
    const response = asRecord(
      await this.request('mcpServer/oauth/login', {
        name,
        threadId: threadId ?? null,
        scopes: null,
        timeoutSecs: 120,
      }),
      'mcpServer/oauth/login',
    )
    if (typeof response.authorizationUrl !== 'string' || !response.authorizationUrl) {
      throw new Error('Codex MCP login omitted authorization URL')
    }
    return response.authorizationUrl
  }

  async getAuthStatus(): Promise<CodexAuthStatus> {
    await this.ready
    const response = asRecord(
      // Request the token only so we can report presence; never return or log it.
      await this.request('getAuthStatus', { includeToken: true, refreshToken: false }),
      'getAuthStatus',
    )
    return {
      ...(typeof response.authMethod === 'string' ? { authMethod: response.authMethod } : {}),
      hasToken: typeof response.authToken === 'string' && response.authToken.length > 0,
      requiresOpenaiAuth: response.requiresOpenaiAuth === true,
    }
  }

  async getAccount(): Promise<JsonObject | null> {
    await this.ready
    const response = asRecord(
      await this.request('account/read', { refreshToken: false }),
      'account/read',
    )
    return isRecord(response.account) ? response.account : null
  }

  async getAccountRateLimits(): Promise<JsonObject> {
    await this.ready
    return asRecord(await this.request('account/rateLimits/read', {}), 'account/rateLimits/read')
  }

  async getAccountUsage(): Promise<JsonObject> {
    await this.ready
    return asRecord(await this.request('account/usage/read', {}), 'account/usage/read')
  }

  async startAccountLogin(method: 'chatgpt' | 'chatgptDeviceCode' = 'chatgpt'): Promise<AccountLoginResult> {
    await this.ready
    const response = asRecord(
      await this.request('account/login/start',
        method === 'chatgpt' ? { type: 'chatgpt' } : { type: 'chatgptDeviceCode' },
      ),
      'account/login/start',
    )
    if (
      response.type === 'chatgpt' &&
      typeof response.loginId === 'string' &&
      typeof response.authUrl === 'string'
    ) {
      return { type: 'chatgpt', loginId: response.loginId, authUrl: response.authUrl }
    }
    if (
      response.type === 'chatgptDeviceCode' &&
      typeof response.loginId === 'string' &&
      typeof response.verificationUrl === 'string' &&
      typeof response.userCode === 'string'
    ) {
      return {
        type: 'chatgptDeviceCode',
        loginId: response.loginId,
        verificationUrl: response.verificationUrl,
        userCode: response.userCode,
      }
    }
    throw new Error('Codex account/login/start returned an invalid response')
  }

  async cancelAccountLogin(loginId: string): Promise<void> {
    await this.ready
    await this.request('account/login/cancel', { loginId })
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    if (this.child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM')
        resolve()
      }, 2_000)
      timer.unref()
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
