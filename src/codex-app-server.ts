import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type {
  ApprovalPolicy,
  CodexModel,
  CodexThreadSummary,
  DynamicToolSpec,
  JsonObject,
  JsonValue,
  ReasoningEffort,
  SandboxMode,
  ServerNotification,
  ServerRequest,
  UserInput,
} from './types.js'
import { packageVersion } from './version.js'

type PendingRequest = {
  child: ChildProcessWithoutNullStreams
  method: string
  timer?: NodeJS.Timeout
  resolve(value: unknown): void
  reject(error: Error): void
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  // Readiness is sometimes replaced before a caller observes a terminal failure.
  // Keep that expected lifecycle transition from becoming an unhandled rejection.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

const FAILED_CHILD_TERM_GRACE_MS = 250
const FAILED_CHILD_KILL_WAIT_MS = 500
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`Invalid ${label} response from Codex`)
  return value
}

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  ) {
    return value
  }
  return undefined
}

function parseSupportedReasoningEfforts(
  value: unknown,
): CodexModel['supportedReasoningEfforts'] {
  if (!Array.isArray(value)) return undefined
  const parsed = value.flatMap((option) => {
    if (!isRecord(option) || typeof option.description !== 'string') return []
    const reasoningEffort = parseReasoningEffort(option.reasoningEffort)
    return reasoningEffort ? [{ reasoningEffort, description: option.description }] : []
  })
  return value.length === 0 || parsed.length > 0 ? parsed : undefined
}

function parseModelServiceTiers(value: unknown): CodexModel['serviceTiers'] {
  if (!Array.isArray(value)) return undefined
  const parsed = value.flatMap((tier) => {
    if (
      !isRecord(tier) ||
      typeof tier.id !== 'string' ||
      typeof tier.name !== 'string' ||
      typeof tier.description !== 'string'
    ) {
      return []
    }
    return [{ id: tier.id, name: tier.name, description: tier.description }]
  })
  return value.length === 0 || parsed.length > 0 ? parsed : undefined
}

function parseInputModalities(value: unknown): CodexModel['inputModalities'] {
  if (!Array.isArray(value)) return undefined
  const parsed = value.flatMap((modality) =>
    modality === 'text' || modality === 'image' ? [modality] : [],
  )
  return value.length === 0 || parsed.length > 0 ? parsed : undefined
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

export type SetThreadGoalOptions = {
  objective?: string
  status?: 'active' | 'paused' | 'blocked' | 'complete'
  tokenBudget?: number | null
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

export type CodexThreadRuntimeState = {
  status: 'active' | 'idle' | 'notLoaded' | 'systemError'
  activeTurnId?: string
  activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput'>
  userMessageClientIds?: string[]
}

export type CodexAppServerRestartOptions = {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  resetAfterMs?: number
}

export type CodexAppServerOptions = {
  command?: string
  args?: string[]
  verbose?: boolean
  /** Startup handshake deadline. Defaults to 60 seconds. */
  initializeTimeoutMs?: number
  /** Per-RPC response deadline after initialization. Defaults to 5 minutes. */
  requestTimeoutMs?: number
  restart?: CodexAppServerRestartOptions
}

export type CodexAppServerRestartEvent = {
  /** Monotonic lifecycle revision; queued handlers should ignore older revisions. */
  generation: number
  attempt: number
  delayMs: number
  error: Error
}

export type CodexAppServerReadyEvent = {
  /** Monotonic lifecycle revision; a later failure receives a different revision. */
  generation: number
  pid?: number
  restartAttempt: number
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

export type CodexSkillScope = 'user' | 'repo' | 'system' | 'admin'

export type CodexSkillToolDependency = {
  type: string
  value: string
  description?: string
  transport?: string
  command?: string
  url?: string
}

export type CodexSkillDependencies = {
  tools: CodexSkillToolDependency[]
}

export type CodexSkillInterface = {
  displayName?: string
  shortDescription?: string
  iconSmall?: string
  iconLarge?: string
  brandColor?: string
  defaultPrompt?: string
}

export type CodexSkillMetadata = {
  name: string
  description: string
  shortDescription?: string
  interface?: CodexSkillInterface
  dependencies?: CodexSkillDependencies
  path: string
  scope: CodexSkillScope
  enabled: boolean
}

export type CodexSkillErrorInfo = {
  path: string
  message: string
}

export type CodexSkillsListEntry = {
  cwd: string
  skills: CodexSkillMetadata[]
  errors: CodexSkillErrorInfo[]
}

export type CodexSkillsListParams = {
  /** When empty, Codex defaults to the app-server session working directory. */
  cwds?: string[]
  /** Bypass the Codex skills cache and scan the configured roots again. */
  forceReload?: boolean
}

export type CodexSkillsListResponse = {
  data: CodexSkillsListEntry[]
}

export type CodexSkillConfigWriteOptions =
  | { path: string; name?: never; enabled: boolean }
  | { name: string; path?: never; enabled: boolean }

export type CodexSkillConfigWriteResult = {
  effectiveEnabled: boolean
}

export type CodexHookEventName =
  | 'preToolUse'
  | 'permissionRequest'
  | 'postToolUse'
  | 'preCompact'
  | 'postCompact'
  | 'sessionStart'
  | 'userPromptSubmit'
  | 'subagentStart'
  | 'subagentStop'
  | 'stop'

export type CodexHookHandlerType = 'command' | 'prompt' | 'agent'

export type CodexHookSource =
  | 'system'
  | 'user'
  | 'project'
  | 'mdm'
  | 'sessionFlags'
  | 'plugin'
  | 'cloudRequirements'
  | 'cloudManagedConfig'
  | 'legacyManagedConfigFile'
  | 'legacyManagedConfigMdm'
  | 'unknown'

export type CodexHookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

export type CodexHookMetadata = {
  key: string
  eventName: CodexHookEventName
  handlerType: CodexHookHandlerType
  matcher: string | null
  command: string | null
  timeoutSec: bigint
  statusMessage: string | null
  sourcePath: string
  source: CodexHookSource
  pluginId: string | null
  displayOrder: bigint
  enabled: boolean
  isManaged: boolean
  currentHash: string
  trustStatus: CodexHookTrustStatus
}

export type CodexHooksListEntry = {
  cwd: string
  hooks: CodexHookMetadata[]
  warnings: string[]
  errors: CodexSkillErrorInfo[]
}

export type CodexHooksListParams = {
  cwds?: string[]
}

export type CodexPluginMarketplaceKind =
  | 'local'
  | 'vertical'
  | 'workspace-directory'
  | 'shared-with-me'
  | 'created-by-me-remote'

export type CodexPluginSource =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; path: string | null; refName: string | null; sha: string | null }
  | { type: 'npm'; package: string; version: string | null; registry: string | null }
  | { type: 'remote' }

export type CodexPluginAvailability = 'AVAILABLE' | 'DISABLED_BY_ADMIN'
export type CodexPluginInstallPolicy = 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
export type CodexPluginInstallPolicySource = 'WORKSPACE_SETTING' | 'IMPLICIT_CANONICAL_APP'
export type CodexPluginAuthPolicy = 'ON_INSTALL' | 'ON_USE'
export type CodexPluginShareDiscoverability = 'LISTED' | 'UNLISTED' | 'PRIVATE'
export type CodexPluginSharePrincipalType = 'user' | 'group' | 'workspace'
export type CodexPluginSharePrincipalRole = 'reader' | 'editor' | 'owner'

export type CodexPluginSharePrincipal = {
  principalType: CodexPluginSharePrincipalType
  principalId: string
  role: CodexPluginSharePrincipalRole
  name: string
}

export type CodexPluginShareContext = {
  remotePluginId: string
  remoteVersion: string | null
  discoverability: CodexPluginShareDiscoverability | null
  shareUrl: string | null
  creatorAccountUserId: string | null
  creatorName: string | null
  sharePrincipals: CodexPluginSharePrincipal[] | null
}

export type CodexPluginInterface = {
  displayName: string | null
  shortDescription: string | null
  longDescription: string | null
  developerName: string | null
  category: string | null
  capabilities: string[]
  websiteUrl: string | null
  privacyPolicyUrl: string | null
  termsOfServiceUrl: string | null
  defaultPrompt: string[] | null
  brandColor: string | null
  composerIcon: string | null
  composerIconUrl: string | null
  logo: string | null
  logoDark: string | null
  logoUrl: string | null
  logoUrlDark: string | null
  screenshots: string[]
  screenshotUrls: string[]
}

export type CodexPluginSummary = {
  id: string
  remotePluginId: string | null
  version: string | null
  localVersion: string | null
  name: string
  shareContext: CodexPluginShareContext | null
  source: CodexPluginSource
  installed: boolean
  enabled: boolean
  installPolicy: CodexPluginInstallPolicy
  installPolicySource: CodexPluginInstallPolicySource | null
  authPolicy: CodexPluginAuthPolicy
  availability: CodexPluginAvailability
  interface: CodexPluginInterface | null
  keywords: string[]
}

export type CodexPluginMarketplaceEntry = {
  name: string
  path: string | null
  interface: { displayName: string | null } | null
  plugins: CodexPluginSummary[]
}

export type CodexMarketplaceLoadError = {
  marketplacePath: string
  message: string
}

export type CodexPluginListOptions = {
  cwds?: string[] | null
  marketplaceKinds?: CodexPluginMarketplaceKind[] | null
}

export type CodexPluginListResult = {
  marketplaces: CodexPluginMarketplaceEntry[]
  marketplaceLoadErrors: CodexMarketplaceLoadError[]
  featuredPluginIds: string[]
}

export type CodexPluginInstalledOptions = {
  cwds?: string[] | null
  installSuggestionPluginNames?: string[] | null
}

export type CodexPluginInstalledResult = Omit<CodexPluginListResult, 'featuredPluginIds'>

export type CodexPluginLocator =
  | { marketplacePath: string; remoteMarketplaceName?: never; pluginName: string }
  | { remoteMarketplaceName: string; marketplacePath?: never; pluginName: string }

export type CodexPluginSkillLocator = {
  remoteMarketplaceName: string
  remotePluginId: string
  skillName: string
}

export type CodexAppSummary = {
  id: string
  name: string
  description: string | null
  installUrl: string | null
  category: string | null
}

export type CodexAppTemplateSummary = {
  templateId: string
  name: string
  description: string | null
  category: string | null
  canonicalConnectorId: string | null
  logoUrl: string | null
  logoUrlDark: string | null
  materializedAppIds: string[]
  reason: 'NOT_CONFIGURED_FOR_WORKSPACE' | 'NO_ACTIVE_WORKSPACE' | null
}

export type CodexPluginSkillSummary = {
  name: string
  description: string
  shortDescription: string | null
  interface: CodexSkillInterface | null
  path: string | null
  enabled: boolean
}

export type CodexPluginDetail = {
  marketplaceName: string
  marketplacePath: string | null
  summary: CodexPluginSummary
  shareUrl: string | null
  description: string | null
  skills: CodexPluginSkillSummary[]
  hooks: Array<{ key: string; eventName: CodexHookEventName }>
  apps: CodexAppSummary[]
  appTemplates: CodexAppTemplateSummary[]
  mcpServers: string[]
}

export type CodexPluginInstallResult = {
  authPolicy: CodexPluginAuthPolicy
  appsNeedingAuth: CodexAppSummary[]
}

export type CodexMarketplaceAddOptions = {
  source: string
  refName?: string | null
  sparsePaths?: string[] | null
}

export type CodexMarketplaceAddResult = {
  marketplaceName: string
  installedRoot: string
  alreadyAdded: boolean
}

export type CodexMarketplaceRemoveResult = {
  marketplaceName: string
  installedRoot: string | null
}

export type CodexMarketplaceUpgradeResult = {
  selectedMarketplaces: string[]
  upgradedRoots: string[]
  errors: Array<{ marketplaceName: string; message: string }>
}

export type CodexWorkspaceMessage = {
  messageId: string
  messageType: 'headline' | 'announcement' | 'unknown'
  messageBody: string
  createdAt: number | null
  archivedAt: number | null
}

export type CodexWorkspaceMessagesResult = {
  featureEnabled: boolean
  messages: CodexWorkspaceMessage[]
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

function optionalString(record: JsonObject, key: string, label: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`Codex ${label} returned an invalid ${key}`)
  return value
}

function parseSkillToolDependency(value: unknown): CodexSkillToolDependency {
  const dependency = asRecord(value, 'skills/list tool dependency')
  if (typeof dependency.type !== 'string' || typeof dependency.value !== 'string') {
    throw new Error('Codex skills/list returned an invalid tool dependency')
  }
  const description = optionalString(dependency, 'description', 'skills/list tool dependency')
  const transport = optionalString(dependency, 'transport', 'skills/list tool dependency')
  const command = optionalString(dependency, 'command', 'skills/list tool dependency')
  const url = optionalString(dependency, 'url', 'skills/list tool dependency')
  return {
    type: dependency.type,
    value: dependency.value,
    ...(description !== undefined ? { description } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(url !== undefined ? { url } : {}),
  }
}

function parseSkillInterface(value: unknown): CodexSkillInterface {
  const skillInterface = asRecord(value, 'skills/list interface')
  const displayName = optionalString(skillInterface, 'displayName', 'skills/list interface')
  const shortDescription = optionalString(
    skillInterface,
    'shortDescription',
    'skills/list interface',
  )
  const iconSmall = optionalString(skillInterface, 'iconSmall', 'skills/list interface')
  const iconLarge = optionalString(skillInterface, 'iconLarge', 'skills/list interface')
  const brandColor = optionalString(skillInterface, 'brandColor', 'skills/list interface')
  const defaultPrompt = optionalString(skillInterface, 'defaultPrompt', 'skills/list interface')
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(iconSmall !== undefined ? { iconSmall } : {}),
    ...(iconLarge !== undefined ? { iconLarge } : {}),
    ...(brandColor !== undefined ? { brandColor } : {}),
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
  }
}

function parseSkillMetadata(value: unknown): CodexSkillMetadata {
  const skill = asRecord(value, 'skills/list skill')
  if (
    typeof skill.name !== 'string' ||
    typeof skill.description !== 'string' ||
    typeof skill.path !== 'string' ||
    (skill.scope !== 'user' &&
      skill.scope !== 'repo' &&
      skill.scope !== 'system' &&
      skill.scope !== 'admin') ||
    typeof skill.enabled !== 'boolean'
  ) {
    throw new Error('Codex skills/list returned invalid skill metadata')
  }
  const shortDescription = optionalString(skill, 'shortDescription', 'skills/list skill')
  let dependencies: CodexSkillDependencies | undefined
  if (skill.dependencies !== undefined && skill.dependencies !== null) {
    const rawDependencies = asRecord(skill.dependencies, 'skills/list dependencies')
    if (!Array.isArray(rawDependencies.tools)) {
      throw new Error('Codex skills/list returned invalid skill dependencies')
    }
    dependencies = { tools: rawDependencies.tools.map(parseSkillToolDependency) }
  }
  return {
    name: skill.name,
    description: skill.description,
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(skill.interface !== undefined && skill.interface !== null
      ? { interface: parseSkillInterface(skill.interface) }
      : {}),
    ...(dependencies ? { dependencies } : {}),
    path: skill.path,
    scope: skill.scope,
    enabled: skill.enabled,
  }
}

function parseSkillsListResponse(value: unknown): CodexSkillsListResponse {
  const response = asRecord(value, 'skills/list')
  if (!Array.isArray(response.data)) throw new Error('Codex skills/list omitted data')
  return {
    data: response.data.map((value) => {
      const entry = asRecord(value, 'skills/list entry')
      if (
        typeof entry.cwd !== 'string' ||
        !Array.isArray(entry.skills) ||
        !Array.isArray(entry.errors)
      ) {
        throw new Error('Codex skills/list returned an invalid entry')
      }
      return {
        cwd: entry.cwd,
        skills: entry.skills.map(parseSkillMetadata),
        errors: entry.errors.map((value) => {
          const error = asRecord(value, 'skills/list error')
          if (typeof error.path !== 'string' || typeof error.message !== 'string') {
            throw new Error('Codex skills/list returned invalid error metadata')
          }
          return { path: error.path, message: error.message }
        }),
      }
    }),
  }
}

function requiredString(record: JsonObject, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`Codex ${label} returned an invalid ${key}`)
  return value
}

function nullableString(record: JsonObject, key: string, label: string): string | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`Codex ${label} returned an invalid ${key}`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Codex ${label} returned an invalid string array`)
  }
  return value
}

function enumString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Codex ${label} returned an invalid enum value`)
  }
  return value as T
}

function protocolBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Codex ${label} returned an invalid integer`)
  }
  return BigInt(value)
}

function protocolUnsignedBigInt(value: unknown, label: string): bigint {
  const parsed = protocolBigInt(value, label)
  if (parsed < 0n) throw new Error(`Codex ${label} returned an invalid unsigned integer`)
  return parsed
}

function nullableTimestamp(value: unknown, label: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Codex ${label} returned an invalid timestamp`)
  }
  return value
}

const hookEventNames = [
  'preToolUse',
  'permissionRequest',
  'postToolUse',
  'preCompact',
  'postCompact',
  'sessionStart',
  'userPromptSubmit',
  'subagentStart',
  'subagentStop',
  'stop',
] as const satisfies readonly CodexHookEventName[]

const hookSources = [
  'system',
  'user',
  'project',
  'mdm',
  'sessionFlags',
  'plugin',
  'cloudRequirements',
  'cloudManagedConfig',
  'legacyManagedConfigFile',
  'legacyManagedConfigMdm',
  'unknown',
] as const satisfies readonly CodexHookSource[]

function parseHookMetadata(value: unknown): CodexHookMetadata {
  const hook = asRecord(value, 'hooks/list hook')
  if (typeof hook.enabled !== 'boolean' || typeof hook.isManaged !== 'boolean') {
    throw new Error('Codex hooks/list returned invalid hook flags')
  }
  return {
    key: requiredString(hook, 'key', 'hooks/list hook'),
    eventName: enumString(hook.eventName, hookEventNames, 'hooks/list hook eventName'),
    handlerType: enumString(
      hook.handlerType,
      ['command', 'prompt', 'agent'] as const,
      'hooks/list hook handlerType',
    ),
    matcher: nullableString(hook, 'matcher', 'hooks/list hook'),
    command: nullableString(hook, 'command', 'hooks/list hook'),
    timeoutSec: protocolUnsignedBigInt(hook.timeoutSec, 'hooks/list hook timeoutSec'),
    statusMessage: nullableString(hook, 'statusMessage', 'hooks/list hook'),
    sourcePath: requiredString(hook, 'sourcePath', 'hooks/list hook'),
    source: enumString(hook.source, hookSources, 'hooks/list hook source'),
    pluginId: nullableString(hook, 'pluginId', 'hooks/list hook'),
    displayOrder: protocolBigInt(hook.displayOrder, 'hooks/list hook displayOrder'),
    enabled: hook.enabled,
    isManaged: hook.isManaged,
    currentHash: requiredString(hook, 'currentHash', 'hooks/list hook'),
    trustStatus: enumString(
      hook.trustStatus,
      ['managed', 'untrusted', 'trusted', 'modified'] as const,
      'hooks/list hook trustStatus',
    ),
  }
}

function parseHooksListResponse(value: unknown): CodexHooksListEntry[] {
  const response = asRecord(value, 'hooks/list')
  if (!Array.isArray(response.data)) throw new Error('Codex hooks/list omitted data')
  return response.data.map((entryValue) => {
    const entry = asRecord(entryValue, 'hooks/list entry')
    if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors)) {
      throw new Error('Codex hooks/list returned an invalid entry')
    }
    return {
      cwd: requiredString(entry, 'cwd', 'hooks/list entry'),
      hooks: entry.hooks.map(parseHookMetadata),
      warnings: stringArray(entry.warnings, 'hooks/list warnings'),
      errors: entry.errors.map((errorValue) => {
        const error = asRecord(errorValue, 'hooks/list error')
        return {
          path: requiredString(error, 'path', 'hooks/list error'),
          message: requiredString(error, 'message', 'hooks/list error'),
        }
      }),
    }
  })
}

function parsePluginSource(value: unknown): CodexPluginSource {
  const source = asRecord(value, 'plugin source')
  if (source.type === 'local') {
    return { type: 'local', path: requiredString(source, 'path', 'plugin source') }
  }
  if (source.type === 'git') {
    return {
      type: 'git',
      url: requiredString(source, 'url', 'plugin source'),
      path: nullableString(source, 'path', 'plugin source'),
      refName: nullableString(source, 'refName', 'plugin source'),
      sha: nullableString(source, 'sha', 'plugin source'),
    }
  }
  if (source.type === 'npm') {
    return {
      type: 'npm',
      package: requiredString(source, 'package', 'plugin source'),
      version: nullableString(source, 'version', 'plugin source'),
      registry: nullableString(source, 'registry', 'plugin source'),
    }
  }
  if (source.type === 'remote') return { type: 'remote' }
  throw new Error('Codex plugin source returned an invalid type')
}

function parsePluginSharePrincipal(value: unknown): CodexPluginSharePrincipal {
  const principal = asRecord(value, 'plugin share principal')
  return {
    principalType: enumString(
      principal.principalType,
      ['user', 'group', 'workspace'] as const,
      'plugin share principal type',
    ),
    principalId: requiredString(principal, 'principalId', 'plugin share principal'),
    role: enumString(
      principal.role,
      ['reader', 'editor', 'owner'] as const,
      'plugin share principal role',
    ),
    name: requiredString(principal, 'name', 'plugin share principal'),
  }
}

function parsePluginShareContext(value: unknown): CodexPluginShareContext {
  const context = asRecord(value, 'plugin share context')
  let sharePrincipals: CodexPluginSharePrincipal[] | null
  if (context.sharePrincipals === null) sharePrincipals = null
  else if (Array.isArray(context.sharePrincipals)) {
    sharePrincipals = context.sharePrincipals.map(parsePluginSharePrincipal)
  } else {
    throw new Error('Codex plugin share context returned invalid sharePrincipals')
  }
  return {
    remotePluginId: requiredString(context, 'remotePluginId', 'plugin share context'),
    remoteVersion: nullableString(context, 'remoteVersion', 'plugin share context'),
    discoverability: context.discoverability === null
      ? null
      : enumString(
          context.discoverability,
          ['LISTED', 'UNLISTED', 'PRIVATE'] as const,
          'plugin share discoverability',
        ),
    shareUrl: nullableString(context, 'shareUrl', 'plugin share context'),
    creatorAccountUserId: nullableString(
      context,
      'creatorAccountUserId',
      'plugin share context',
    ),
    creatorName: nullableString(context, 'creatorName', 'plugin share context'),
    sharePrincipals,
  }
}

function parsePluginInterface(value: unknown): CodexPluginInterface {
  const pluginInterface = asRecord(value, 'plugin interface')
  let defaultPrompt: string[] | null
  if (pluginInterface.defaultPrompt === null) defaultPrompt = null
  else defaultPrompt = stringArray(pluginInterface.defaultPrompt, 'plugin interface defaultPrompt')
  return {
    displayName: nullableString(pluginInterface, 'displayName', 'plugin interface'),
    shortDescription: nullableString(pluginInterface, 'shortDescription', 'plugin interface'),
    longDescription: nullableString(pluginInterface, 'longDescription', 'plugin interface'),
    developerName: nullableString(pluginInterface, 'developerName', 'plugin interface'),
    category: nullableString(pluginInterface, 'category', 'plugin interface'),
    capabilities: stringArray(pluginInterface.capabilities, 'plugin interface capabilities'),
    websiteUrl: nullableString(pluginInterface, 'websiteUrl', 'plugin interface'),
    privacyPolicyUrl: nullableString(pluginInterface, 'privacyPolicyUrl', 'plugin interface'),
    termsOfServiceUrl: nullableString(
      pluginInterface,
      'termsOfServiceUrl',
      'plugin interface',
    ),
    defaultPrompt,
    brandColor: nullableString(pluginInterface, 'brandColor', 'plugin interface'),
    composerIcon: nullableString(pluginInterface, 'composerIcon', 'plugin interface'),
    composerIconUrl: nullableString(pluginInterface, 'composerIconUrl', 'plugin interface'),
    logo: nullableString(pluginInterface, 'logo', 'plugin interface'),
    logoDark: nullableString(pluginInterface, 'logoDark', 'plugin interface'),
    logoUrl: nullableString(pluginInterface, 'logoUrl', 'plugin interface'),
    logoUrlDark: nullableString(pluginInterface, 'logoUrlDark', 'plugin interface'),
    screenshots: stringArray(pluginInterface.screenshots, 'plugin interface screenshots'),
    screenshotUrls: stringArray(pluginInterface.screenshotUrls, 'plugin interface screenshotUrls'),
  }
}

function parsePluginSummary(value: unknown): CodexPluginSummary {
  const plugin = asRecord(value, 'plugin summary')
  if (typeof plugin.installed !== 'boolean' || typeof plugin.enabled !== 'boolean') {
    throw new Error('Codex plugin summary returned invalid state flags')
  }
  return {
    id: requiredString(plugin, 'id', 'plugin summary'),
    remotePluginId: nullableString(plugin, 'remotePluginId', 'plugin summary'),
    version: nullableString(plugin, 'version', 'plugin summary'),
    localVersion: nullableString(plugin, 'localVersion', 'plugin summary'),
    name: requiredString(plugin, 'name', 'plugin summary'),
    shareContext: plugin.shareContext === null
      ? null
      : parsePluginShareContext(plugin.shareContext),
    source: parsePluginSource(plugin.source),
    installed: plugin.installed,
    enabled: plugin.enabled,
    installPolicy: enumString(
      plugin.installPolicy,
      ['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'] as const,
      'plugin installPolicy',
    ),
    installPolicySource: plugin.installPolicySource === null
      ? null
      : enumString(
          plugin.installPolicySource,
          ['WORKSPACE_SETTING', 'IMPLICIT_CANONICAL_APP'] as const,
          'plugin installPolicySource',
        ),
    authPolicy: enumString(
      plugin.authPolicy,
      ['ON_INSTALL', 'ON_USE'] as const,
      'plugin authPolicy',
    ),
    availability: enumString(
      plugin.availability,
      ['AVAILABLE', 'DISABLED_BY_ADMIN'] as const,
      'plugin availability',
    ),
    interface: plugin.interface === null ? null : parsePluginInterface(plugin.interface),
    keywords: stringArray(plugin.keywords, 'plugin keywords'),
  }
}

function parseMarketplaceLoadError(value: unknown): CodexMarketplaceLoadError {
  const error = asRecord(value, 'marketplace load error')
  return {
    marketplacePath: requiredString(error, 'marketplacePath', 'marketplace load error'),
    message: requiredString(error, 'message', 'marketplace load error'),
  }
}

function parsePluginMarketplace(value: unknown): CodexPluginMarketplaceEntry {
  const marketplace = asRecord(value, 'plugin marketplace')
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error('Codex plugin marketplace returned invalid plugins')
  }
  let marketplaceInterface: CodexPluginMarketplaceEntry['interface']
  if (marketplace.interface === null) marketplaceInterface = null
  else {
    const rawInterface = asRecord(marketplace.interface, 'plugin marketplace interface')
    marketplaceInterface = {
      displayName: nullableString(rawInterface, 'displayName', 'plugin marketplace interface'),
    }
  }
  return {
    name: requiredString(marketplace, 'name', 'plugin marketplace'),
    path: nullableString(marketplace, 'path', 'plugin marketplace'),
    interface: marketplaceInterface,
    plugins: marketplace.plugins.map(parsePluginSummary),
  }
}

function parsePluginListResult(value: unknown): CodexPluginListResult {
  const response = asRecord(value, 'plugin/list')
  if (!Array.isArray(response.marketplaces) || !Array.isArray(response.marketplaceLoadErrors)) {
    throw new Error('Codex plugin/list returned an invalid catalog')
  }
  return {
    marketplaces: response.marketplaces.map(parsePluginMarketplace),
    marketplaceLoadErrors: response.marketplaceLoadErrors.map(parseMarketplaceLoadError),
    featuredPluginIds: stringArray(response.featuredPluginIds, 'plugin/list featuredPluginIds'),
  }
}

function parsePluginInstalledResult(value: unknown): CodexPluginInstalledResult {
  const response = asRecord(value, 'plugin/installed')
  if (!Array.isArray(response.marketplaces) || !Array.isArray(response.marketplaceLoadErrors)) {
    throw new Error('Codex plugin/installed returned an invalid catalog')
  }
  return {
    marketplaces: response.marketplaces.map(parsePluginMarketplace),
    marketplaceLoadErrors: response.marketplaceLoadErrors.map(parseMarketplaceLoadError),
  }
}

function parseAppSummary(value: unknown): CodexAppSummary {
  const app = asRecord(value, 'plugin app summary')
  return {
    id: requiredString(app, 'id', 'plugin app summary'),
    name: requiredString(app, 'name', 'plugin app summary'),
    description: nullableString(app, 'description', 'plugin app summary'),
    installUrl: nullableString(app, 'installUrl', 'plugin app summary'),
    category: nullableString(app, 'category', 'plugin app summary'),
  }
}

function parsePluginSkillSummary(value: unknown): CodexPluginSkillSummary {
  const skill = asRecord(value, 'plugin skill summary')
  if (typeof skill.enabled !== 'boolean') {
    throw new Error('Codex plugin skill summary returned invalid enabled state')
  }
  return {
    name: requiredString(skill, 'name', 'plugin skill summary'),
    description: requiredString(skill, 'description', 'plugin skill summary'),
    shortDescription: nullableString(skill, 'shortDescription', 'plugin skill summary'),
    interface: skill.interface === null ? null : parseSkillInterface(skill.interface),
    path: nullableString(skill, 'path', 'plugin skill summary'),
    enabled: skill.enabled,
  }
}

function parseAppTemplateSummary(value: unknown): CodexAppTemplateSummary {
  const template = asRecord(value, 'plugin app template summary')
  return {
    templateId: requiredString(template, 'templateId', 'plugin app template summary'),
    name: requiredString(template, 'name', 'plugin app template summary'),
    description: nullableString(template, 'description', 'plugin app template summary'),
    category: nullableString(template, 'category', 'plugin app template summary'),
    canonicalConnectorId: nullableString(
      template,
      'canonicalConnectorId',
      'plugin app template summary',
    ),
    logoUrl: nullableString(template, 'logoUrl', 'plugin app template summary'),
    logoUrlDark: nullableString(template, 'logoUrlDark', 'plugin app template summary'),
    materializedAppIds: stringArray(
      template.materializedAppIds,
      'plugin app template materializedAppIds',
    ),
    reason: template.reason === null
      ? null
      : enumString(
          template.reason,
          ['NOT_CONFIGURED_FOR_WORKSPACE', 'NO_ACTIVE_WORKSPACE'] as const,
          'plugin app template reason',
        ),
  }
}

function parsePluginDetail(value: unknown): CodexPluginDetail {
  const response = asRecord(value, 'plugin/read')
  const plugin = asRecord(response.plugin, 'plugin/read plugin')
  if (
    !Array.isArray(plugin.skills) ||
    !Array.isArray(plugin.hooks) ||
    !Array.isArray(plugin.apps) ||
    !Array.isArray(plugin.appTemplates)
  ) {
    throw new Error('Codex plugin/read returned invalid plugin collections')
  }
  return {
    marketplaceName: requiredString(plugin, 'marketplaceName', 'plugin/read plugin'),
    marketplacePath: nullableString(plugin, 'marketplacePath', 'plugin/read plugin'),
    summary: parsePluginSummary(plugin.summary),
    shareUrl: nullableString(plugin, 'shareUrl', 'plugin/read plugin'),
    description: nullableString(plugin, 'description', 'plugin/read plugin'),
    skills: plugin.skills.map(parsePluginSkillSummary),
    hooks: plugin.hooks.map((hookValue) => {
      const hook = asRecord(hookValue, 'plugin hook summary')
      return {
        key: requiredString(hook, 'key', 'plugin hook summary'),
        eventName: enumString(hook.eventName, hookEventNames, 'plugin hook eventName'),
      }
    }),
    apps: plugin.apps.map(parseAppSummary),
    appTemplates: plugin.appTemplates.map(parseAppTemplateSummary),
    mcpServers: stringArray(plugin.mcpServers, 'plugin/read mcpServers'),
  }
}

function parsePluginInstallResult(value: unknown): CodexPluginInstallResult {
  const response = asRecord(value, 'plugin/install')
  if (!Array.isArray(response.appsNeedingAuth)) {
    throw new Error('Codex plugin/install returned invalid appsNeedingAuth')
  }
  return {
    authPolicy: enumString(
      response.authPolicy,
      ['ON_INSTALL', 'ON_USE'] as const,
      'plugin/install authPolicy',
    ),
    appsNeedingAuth: response.appsNeedingAuth.map(parseAppSummary),
  }
}

function parseMarketplaceAddResult(value: unknown): CodexMarketplaceAddResult {
  const response = asRecord(value, 'marketplace/add')
  if (typeof response.alreadyAdded !== 'boolean') {
    throw new Error('Codex marketplace/add returned invalid alreadyAdded')
  }
  return {
    marketplaceName: requiredString(response, 'marketplaceName', 'marketplace/add'),
    installedRoot: requiredString(response, 'installedRoot', 'marketplace/add'),
    alreadyAdded: response.alreadyAdded,
  }
}

function parseMarketplaceRemoveResult(value: unknown): CodexMarketplaceRemoveResult {
  const response = asRecord(value, 'marketplace/remove')
  return {
    marketplaceName: requiredString(response, 'marketplaceName', 'marketplace/remove'),
    installedRoot: nullableString(response, 'installedRoot', 'marketplace/remove'),
  }
}

function parseMarketplaceUpgradeResult(value: unknown): CodexMarketplaceUpgradeResult {
  const response = asRecord(value, 'marketplace/upgrade')
  if (!Array.isArray(response.errors)) {
    throw new Error('Codex marketplace/upgrade returned invalid errors')
  }
  return {
    selectedMarketplaces: stringArray(
      response.selectedMarketplaces,
      'marketplace/upgrade selectedMarketplaces',
    ),
    upgradedRoots: stringArray(response.upgradedRoots, 'marketplace/upgrade upgradedRoots'),
    errors: response.errors.map((errorValue) => {
      const error = asRecord(errorValue, 'marketplace/upgrade error')
      return {
        marketplaceName: requiredString(
          error,
          'marketplaceName',
          'marketplace/upgrade error',
        ),
        message: requiredString(error, 'message', 'marketplace/upgrade error'),
      }
    }),
  }
}

function parseWorkspaceMessages(value: unknown): CodexWorkspaceMessagesResult {
  const response = asRecord(value, 'account/workspaceMessages/read')
  if (typeof response.featureEnabled !== 'boolean' || !Array.isArray(response.messages)) {
    throw new Error('Codex account/workspaceMessages/read returned an invalid response')
  }
  return {
    featureEnabled: response.featureEnabled,
    messages: response.messages.map((messageValue) => {
      const message = asRecord(messageValue, 'account workspace message')
      return {
        messageId: requiredString(message, 'messageId', 'account workspace message'),
        messageType: enumString(
          message.messageType,
          ['headline', 'announcement', 'unknown'] as const,
          'account workspace message type',
        ),
        messageBody: requiredString(message, 'messageBody', 'account workspace message'),
        createdAt: nullableTimestamp(message.createdAt, 'account workspace message createdAt'),
        archivedAt: nullableTimestamp(message.archivedAt, 'account workspace message archivedAt'),
      }
    }),
  }
}

function skillConfigWriteParams(options: CodexSkillConfigWriteOptions): JsonObject {
  const pathSelector = (options as { path?: unknown }).path
  const nameSelector = (options as { name?: unknown }).name
  const hasPath = typeof pathSelector === 'string'
  const hasName = typeof nameSelector === 'string'
  if (hasPath === hasName) {
    throw new Error('Skill config write requires exactly one of path or name')
  }
  if (typeof options.enabled !== 'boolean') {
    throw new Error('Skill config write requires a boolean enabled value')
  }
  return {
    ...(hasPath ? { path: pathSelector } : { name: nameSelector }),
    enabled: options.enabled,
  }
}

function pluginLocatorParams(locator: CodexPluginLocator): JsonObject {
  const marketplacePath = (locator as { marketplacePath?: unknown }).marketplacePath
  const remoteMarketplaceName = (locator as { remoteMarketplaceName?: unknown })
    .remoteMarketplaceName
  const hasLocalMarketplace = typeof marketplacePath === 'string'
  const hasRemoteMarketplace = typeof remoteMarketplaceName === 'string'
  if (hasLocalMarketplace === hasRemoteMarketplace) {
    throw new Error(
      'Plugin selection requires exactly one of marketplacePath or remoteMarketplaceName',
    )
  }
  if (typeof locator.pluginName !== 'string') {
    throw new Error('Plugin selection requires a pluginName')
  }
  return {
    ...(hasLocalMarketplace ? { marketplacePath } : { remoteMarketplaceName }),
    pluginName: locator.pluginName,
  }
}

function parseThreadSummary(value: unknown): CodexThreadSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.cwd !== 'string') {
    return undefined
  }
  return {
    id: value.id,
    preview: typeof value.preview === 'string' ? value.preview : '',
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    cwd: value.cwd,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
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

function parseThreadRuntimeState(value: unknown): CodexThreadRuntimeState {
  const thread = asRecord(value, 'thread/read thread')
  const status = asRecord(thread.status, 'thread/read status')
  if (
    status.type !== 'active' &&
    status.type !== 'idle' &&
    status.type !== 'notLoaded' &&
    status.type !== 'systemError'
  ) {
    throw new Error('Codex thread/read returned an invalid runtime status')
  }

  const activeTurn = status.type === 'active' && Array.isArray(thread.turns)
    ? [...thread.turns].reverse().find(
      (turn) => isRecord(turn) && turn.status === 'inProgress' && typeof turn.id === 'string',
    )
    : undefined
  const activeFlags = status.type === 'active' && Array.isArray(status.activeFlags)
    ? status.activeFlags.flatMap((flag) => (
      flag === 'waitingOnApproval' || flag === 'waitingOnUserInput' ? [flag] : []
    ))
    : undefined
  const userMessageClientIds = Array.isArray(thread.turns)
    ? thread.turns.flatMap((turn) => {
        if (!isRecord(turn) || !Array.isArray(turn.items)) return []
        return turn.items.flatMap((item) => (
          isRecord(item) && item.type === 'userMessage' && typeof item.clientId === 'string'
            ? [item.clientId]
            : []
        ))
      })
    : []

  return {
    status: status.type,
    ...(activeTurn && typeof activeTurn.id === 'string' ? { activeTurnId: activeTurn.id } : {}),
    ...(activeFlags ? { activeFlags } : {}),
    ...(userMessageClientIds.length > 0 ? { userMessageClientIds } : {}),
  }
}

export class CodexAppServer extends EventEmitter {
  private childProcess: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<string | number, PendingRequest>()
  private readonly childFailureHandlers = new WeakMap<
    ChildProcessWithoutNullStreams,
    (error: Error) => void
  >()
  private readonly serverRequestOwners = new WeakMap<ServerRequest, ChildProcessWithoutNullStreams>()
  private readonly terminatingChildren = new Set<Promise<boolean>>()
  private readiness = deferred<void>()
  private state: 'starting' | 'ready' | 'restarting' | 'failed' | 'closing' | 'closed' = 'starting'
  private readonly verbose: boolean
  private readonly command: string
  private readonly args: string[]
  private readonly initializeTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly maxRestartAttempts: number
  private readonly initialRestartDelayMs: number
  private readonly maxRestartDelayMs: number
  private readonly restartResetAfterMs: number
  private restartAttempt = 0
  private restartTimer: NodeJS.Timeout | undefined
  private restartResetTimer: NodeJS.Timeout | undefined
  private closePromise: Promise<void> | undefined
  private closeEmitted = false
  private processGeneration = 0
  private lifecycleGeneration = 0

  constructor(options: CodexAppServerOptions = {}) {
    super()
    this.verbose = options.verbose === true
    this.command = options.command || process.env.CORDEX_CODEX_BIN || 'codex'
    this.args = [...(options.args || ['app-server', '--stdio'])]
    this.initializeTimeoutMs = this.timeoutOption(
      'initializeTimeoutMs',
      options.initializeTimeoutMs,
      DEFAULT_INITIALIZE_TIMEOUT_MS,
    )
    this.requestTimeoutMs = this.timeoutOption(
      'requestTimeoutMs',
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    )
    this.maxRestartAttempts = this.restartOption('maxAttempts', options.restart?.maxAttempts, 5, 0)
    this.initialRestartDelayMs = this.restartOption(
      'initialDelayMs',
      options.restart?.initialDelayMs,
      500,
      0,
    )
    this.maxRestartDelayMs = this.restartOption(
      'maxDelayMs',
      options.restart?.maxDelayMs,
      Math.max(30_000, this.initialRestartDelayMs),
      this.initialRestartDelayMs,
    )
    this.restartResetAfterMs = this.restartOption(
      'resetAfterMs',
      options.restart?.resetAfterMs,
      60_000,
      1,
    )
    this.spawnChild()
  }

  get child(): ChildProcessWithoutNullStreams {
    if (!this.childProcess) throw this.unavailableError()
    return this.childProcess
  }

  get generation(): number {
    return this.lifecycleGeneration
  }

  private get ready(): Promise<void> {
    return this.waitUntilReady()
  }

  private restartOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
    const selected = value ?? fallback
    if (!Number.isSafeInteger(selected) || selected < minimum) {
      throw new Error(`Codex app-server restart.${name} must be an integer >= ${minimum}`)
    }
    return selected
  }

  private timeoutOption(name: string, value: number | undefined, fallback: number): number {
    const selected = value ?? fallback
    if (!Number.isSafeInteger(selected) || selected < 1) {
      throw new Error(`Codex app-server ${name} must be an integer >= 1`)
    }
    return selected
  }

  private unavailableError(): Error {
    if (this.state === 'closed' || this.state === 'closing') {
      return new Error('Codex app-server is closed')
    }
    if (this.state === 'failed') return new Error('Codex app-server restart attempts exhausted')
    return new Error('Codex app-server is restarting')
  }

  private async waitUntilReady(): Promise<void> {
    while (this.state !== 'ready') {
      if (this.state === 'failed' || this.state === 'closing' || this.state === 'closed') {
        throw this.unavailableError()
      }
      const readiness = this.readiness
      await readiness.promise
    }
  }

  private spawnChild(): void {
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'failed') return
    const generation = ++this.processGeneration
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.command, this.args, {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== 'CORDEX_DISCORD_TOKEN'),
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      this.handleChildFailure(
        null,
        generation,
        new Error('Failed to spawn Codex app-server', { cause }),
      )
      return
    }

    this.childProcess = child
    let failed = false
    const stdout = createInterface({ input: child.stdout })
    const fail = (error: Error) => {
      if (failed) return
      failed = true
      this.childFailureHandlers.delete(child)
      stdout.close()
      this.handleChildFailure(child, generation, error)
    }
    this.childFailureHandlers.set(child, fail)

    child.stderr.setEncoding('utf8')
    stdout.on('error', (cause) => {
      fail(new Error(`Codex app-server readline error: ${cause.message}`, { cause }))
    })
    child.stdin.on('error', (cause) => {
      fail(new Error(`Codex app-server stdin error: ${cause.message}`, { cause }))
    })
    child.stdout.on('error', (cause) => {
      fail(new Error(`Codex app-server stdout error: ${cause.message}`, { cause }))
    })
    child.stderr.on('error', (cause) => {
      fail(new Error(`Codex app-server stderr error: ${cause.message}`, { cause }))
    })
    child.stderr.on('data', (chunk: string) => {
      if (this.childProcess === child) this.emit('stderr', chunk)
    })
    stdout.on('line', (line) => {
      if (!failed && this.childProcess === child) this.handleLine(child, line)
    })
    child.once('error', (cause) => {
      fail(new Error(`Codex app-server process error: ${cause.message}`, { cause }))
    })
    child.once('exit', (code, signal) => {
      fail(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`))
    })

    void this.initialize(child).then(
      () => {
        if (failed || this.childProcess !== child) return
        if (generation !== this.processGeneration) return
        if (this.state === 'closing' || this.state === 'closed') return
        this.state = 'ready'
        this.readiness.resolve()
        this.armRestartReset()
        this.emit('ready', {
          generation: ++this.lifecycleGeneration,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          restartAttempt: this.restartAttempt,
        } satisfies CodexAppServerReadyEvent)
      },
      (cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        fail(new Error(`Failed to initialize Codex app-server: ${error.message}`, { cause: error }))
      },
    )
  }

  private armRestartReset(): void {
    if (this.restartResetTimer) clearTimeout(this.restartResetTimer)
    if (this.restartAttempt === 0) return
    this.restartResetTimer = setTimeout(() => {
      this.restartResetTimer = undefined
      if (this.state === 'ready') this.restartAttempt = 0
    }, this.restartResetAfterMs)
    this.restartResetTimer.unref()
  }

  private handleChildFailure(
    child: ChildProcessWithoutNullStreams | null,
    generation: number,
    error: Error,
  ): void {
    if (child && this.childProcess !== child) return
    if (generation !== this.processGeneration) return
    if (this.restartResetTimer) {
      clearTimeout(this.restartResetTimer)
      this.restartResetTimer = undefined
    }
    if (child) {
      this.rejectPending(error, child)
      this.childProcess = null
    }
    const lifecycleGeneration = ++this.lifecycleGeneration
    this.emit('childFailure', error)

    if (this.state === 'closing' || this.state === 'closed') return
    const termination = child ? this.terminateFailedChild(child) : Promise.resolve(true)
    if (this.state === 'ready') this.readiness = deferred<void>()
    if (this.restartAttempt >= this.maxRestartAttempts) {
      const terminalError = new Error(
        `Codex app-server restart attempts exhausted after ${this.restartAttempt} attempt${this.restartAttempt === 1 ? '' : 's'}`,
        { cause: error },
      )
      this.failPermanently(terminalError)
      return
    }

    this.restartAttempt += 1
    const delayMs = Math.min(
      this.initialRestartDelayMs * 2 ** (this.restartAttempt - 1),
      this.maxRestartDelayMs,
    )
    this.state = 'restarting'
    const event: CodexAppServerRestartEvent = {
      generation: lifecycleGeneration,
      attempt: this.restartAttempt,
      delayMs,
      error,
    }
    this.emit('restarting', event)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void termination.then((terminated) => {
        if (this.state !== 'restarting' || this.processGeneration !== generation) return
        if (!terminated) {
          this.failPermanently(new Error(
            `Codex app-server child ${child?.pid ?? 'unknown'} did not exit after SIGKILL`,
            { cause: error },
          ))
          return
        }
        this.spawnChild()
      })
    }, delayMs)
  }

  private failPermanently(error: Error): void {
    this.state = 'failed'
    this.readiness.reject(error)
    this.rejectPending(error)
    this.emit('failed', error)
    this.emitClose(error)
  }

  private terminateFailedChild(child: ChildProcessWithoutNullStreams): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return Promise.resolve(true)
    }

    const termination = new Promise<boolean>((resolve) => {
      let settled = false
      let onExit!: () => void
      let onClose!: () => void
      const finish = (terminated: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        clearTimeout(giveUpTimer)
        child.off('exit', onExit)
        child.off('close', onClose)
        resolve(terminated)
      }
      onExit = () => finish(true)
      onClose = () => finish(true)
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          child.kill('SIGKILL')
        } catch {
          finish(child.exitCode !== null || child.signalCode !== null)
        }
      }, FAILED_CHILD_TERM_GRACE_MS)
      const giveUpTimer = setTimeout(
        () => finish(child.exitCode !== null || child.signalCode !== null),
        FAILED_CHILD_TERM_GRACE_MS + FAILED_CHILD_KILL_WAIT_MS,
      )
      child.once('exit', onExit)
      child.once('close', onClose)
      try {
        child.kill('SIGTERM')
      } catch {
        finish(child.exitCode !== null || child.signalCode !== null)
      }
    })
    this.terminatingChildren.add(termination)
    void termination.then(() => this.terminatingChildren.delete(termination))
    return termination
  }

  private rejectPending(error: Error, child?: ChildProcessWithoutNullStreams): void {
    for (const [id, request] of this.pending) {
      if (child && request.child !== child) continue
      this.pending.delete(id)
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
  }

  private emitClose(error?: Error): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.emit('close', error)
  }

  private sendToChild(child: ChildProcessWithoutNullStreams, message: unknown): void {
    if (this.childProcess !== child || !child.stdin.writable || child.stdin.destroyed) {
      throw this.unavailableError()
    }
    const line = JSON.stringify(message)
    if (this.verbose) console.error(`[codex ->] ${line}`)
    child.stdin.write(`${line}\n`)
  }

  private async initialize(child: ChildProcessWithoutNullStreams): Promise<void> {
    await this.requestOnChild(
      child,
      'initialize',
      {
        clientInfo: { name: 'cordex', title: 'Cordex', version: await packageVersion() },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      },
      this.initializeTimeoutMs,
    )
    this.sendToChild(child, { method: 'initialized' })
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
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
      if (!pending || pending.child !== child) return
      this.pending.delete(responseId)
      if (pending.timer) clearTimeout(pending.timer)
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
      const request = { id: responseId, method, params } satisfies ServerRequest
      this.serverRequestOwners.set(request, child)
      this.emit('serverRequest', request)
      return
    }
    this.emit('notification', { method, params } satisfies ServerNotification)
  }

  private requestOnChild(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const id = this.nextId++
    let pending!: PendingRequest
    const promise = new Promise<unknown>((resolve, reject) => {
      pending = { child, method, resolve, reject }
      this.pending.set(id, pending)
    })
    pending.timer = setTimeout(() => this.handleRequestTimeout(id, pending, timeoutMs), timeoutMs)
    try {
      this.sendToChild(child, { id, method, params })
    } catch (error) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      delete pending.timer
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      return promise
    }
    return promise
  }

  private handleRequestTimeout(
    id: string | number,
    pending: PendingRequest,
    timeoutMs: number,
  ): void {
    if (this.pending.get(id) !== pending) return
    this.pending.delete(id)
    delete pending.timer
    const error = new Error(`Codex RPC ${pending.method} timed out after ${timeoutMs}ms`)
    pending.reject(error)
    this.childFailureHandlers.get(pending.child)?.(error)
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.waitUntilReady()
    const child = this.childProcess
    if (!child) throw this.unavailableError()
    return this.requestOnChild(child, method, params)
  }

  respond(id: string | number, result: unknown): void {
    const child = this.childProcess
    if (this.state !== 'ready' || !child) throw this.unavailableError()
    this.sendToChild(child, { id, result })
  }

  respondTo(request: ServerRequest, result: unknown): void {
    const child = this.serverRequestOwners.get(request)
    if (!child) throw new Error('Unknown or already answered Codex server request')
    if (this.state !== 'ready' || this.childProcess !== child) {
      this.serverRequestOwners.delete(request)
      throw new Error('Codex server request belongs to a previous app-server generation')
    }
    this.sendToChild(child, { id: request.id, result })
    this.serverRequestOwners.delete(request)
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
    effort?: ReasoningEffort
    serviceTier?: string | null
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
    const effort = parseReasoningEffort(response.reasoningEffort)
    const serviceTier = response.serviceTier === null || typeof response.serviceTier === 'string'
      ? response.serviceTier
      : undefined
    return {
      ...(typeof response.model === 'string' ? { model: response.model } : {}),
      ...(effort ? { effort } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
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

  async injectThreadItems(threadId: string, items: JsonValue[]): Promise<void> {
    await this.ready
    await this.request('thread/inject_items', { threadId, items })
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.ready
    await this.request('thread/archive', { threadId })
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    await this.ready
    const response = asRecord(
      await this.request('thread/unarchive', { threadId }),
      'thread/unarchive',
    )
    const thread = parseThreadSummary(response.thread)
    if (!thread) throw new Error('Codex thread/unarchive omitted a valid thread')
    return thread
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ready
    await this.request('thread/delete', { threadId })
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
    update: SetThreadGoalOptions,
  ): Promise<CodexThreadGoal> {
    await this.ready
    if (
      update.objective === undefined &&
      update.status === undefined &&
      update.tokenBudget === undefined
    ) {
      throw new Error('Thread goal update requires at least one field')
    }
    const response = asRecord(
      await this.request('thread/goal/set', {
        threadId,
        ...(update.objective !== undefined ? { objective: update.objective } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.tokenBudget !== undefined ? { tokenBudget: update.tokenBudget } : {}),
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

  private async listThreadsPage(options: {
    cwd?: string
    searchTerm?: string
    limit?: number
    archived?: boolean
    cursor?: string
  } = {}): Promise<{ data: CodexThreadSummary[]; nextCursor?: string }> {
    await this.ready
    const response = asRecord(
      await this.request('thread/list', {
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit ?? 25,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        cwd: options.cwd ?? null,
        searchTerm: options.searchTerm ?? null,
        archived: options.archived ?? false,
      }),
      'thread/list',
    )
    if (!Array.isArray(response.data)) throw new Error('Codex thread/list omitted data')
    if (
      response.nextCursor !== undefined &&
      response.nextCursor !== null &&
      typeof response.nextCursor !== 'string'
    ) throw new Error('Codex thread/list returned an invalid pagination cursor')
    return {
      data: response.data.flatMap((item) => {
        const thread = parseThreadSummary(item)
        return thread ? [thread] : []
      }),
      ...(typeof response.nextCursor === 'string' && response.nextCursor
        ? { nextCursor: response.nextCursor }
        : {}),
    }
  }

  async listThreads(options: {
    cwd?: string
    searchTerm?: string
    limit?: number
    archived?: boolean
  } = {}): Promise<CodexThreadSummary[]> {
    return (await this.listThreadsPage(options)).data
  }

  async listAllThreads(options: {
    cwd?: string
    searchTerm?: string
    archived?: boolean
  } = {}): Promise<CodexThreadSummary[]> {
    const threads: CodexThreadSummary[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.listThreadsPage({
        ...options,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      threads.push(...page.data)
      cursor = page.nextCursor
      if (!cursor) break
      if (seenCursors.has(cursor)) throw new Error('Codex thread/list repeated its pagination cursor')
      seenCursors.add(cursor)
    } while (true)
    return threads
  }

  async getThreadRuntimeState(threadId: string): Promise<CodexThreadRuntimeState> {
    await this.ready
    const response = asRecord(
      await this.request('thread/read', { threadId, includeTurns: true }),
      'thread/read',
    )
    return parseThreadRuntimeState(response.thread)
  }

  async getThreadSummary(threadId: string): Promise<CodexThreadSummary> {
    await this.ready
    const response = asRecord(
      await this.request('thread/read', { threadId, includeTurns: false }),
      'thread/read',
    )
    const thread = parseThreadSummary(response.thread)
    if (!thread) throw new Error('Codex thread/read omitted a valid thread')
    return thread
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
        const supportedReasoningEfforts = parseSupportedReasoningEfforts(
          item.supportedReasoningEfforts,
        )
        const serviceTiers = parseModelServiceTiers(item.serviceTiers)
        const inputModalities = parseInputModalities(item.inputModalities)
        const defaultServiceTier =
          item.defaultServiceTier === null || typeof item.defaultServiceTier === 'string'
            ? item.defaultServiceTier
            : undefined
        models.push({
          id: item.id,
          model: item.model,
          displayName: typeof item.displayName === 'string' ? item.displayName : item.model,
          description: typeof item.description === 'string' ? item.description : '',
          hidden: item.hidden === true,
          isDefault: item.isDefault === true,
          defaultReasoningEffort: parseReasoningEffort(item.defaultReasoningEffort) ?? 'medium',
          ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
          ...(serviceTiers !== undefined ? { serviceTiers } : {}),
          ...(defaultServiceTier !== undefined ? { defaultServiceTier } : {}),
          ...(inputModalities !== undefined ? { inputModalities } : {}),
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

  async listSkills(cwd?: string): Promise<CodexSkillsListEntry[]>
  async listSkills(params?: CodexSkillsListParams): Promise<CodexSkillsListEntry[]>
  async listSkills(
    cwdOrParams?: string | CodexSkillsListParams,
  ): Promise<CodexSkillsListEntry[]> {
    await this.ready
    const params: CodexSkillsListParams =
      typeof cwdOrParams === 'string' || cwdOrParams === undefined
        ? { cwds: cwdOrParams ? [cwdOrParams] : [], forceReload: false }
        : cwdOrParams
    return parseSkillsListResponse(await this.request('skills/list', params)).data
  }

  async writeSkillConfig(
    options: CodexSkillConfigWriteOptions,
  ): Promise<CodexSkillConfigWriteResult> {
    await this.ready
    const response = asRecord(
      await this.request('skills/config/write', skillConfigWriteParams(options)),
      'skills/config/write',
    )
    if (typeof response.effectiveEnabled !== 'boolean') {
      throw new Error('Codex skills/config/write omitted effectiveEnabled')
    }
    return { effectiveEnabled: response.effectiveEnabled }
  }

  async setSkillsExtraRoots(extraRoots: string[]): Promise<void> {
    await this.ready
    await this.request('skills/extraRoots/set', { extraRoots })
  }

  async listHooks(params: CodexHooksListParams = {}): Promise<CodexHooksListEntry[]> {
    await this.ready
    return parseHooksListResponse(await this.request('hooks/list', params))
  }

  async listPlugins(options: CodexPluginListOptions = {}): Promise<CodexPluginListResult> {
    await this.ready
    return parsePluginListResult(await this.request('plugin/list', {
      ...('cwds' in options ? { cwds: options.cwds ?? null } : {}),
      ...('marketplaceKinds' in options
        ? { marketplaceKinds: options.marketplaceKinds ?? null }
        : {}),
    }))
  }

  async listInstalledPlugins(
    options: CodexPluginInstalledOptions = {},
  ): Promise<CodexPluginInstalledResult> {
    await this.ready
    return parsePluginInstalledResult(await this.request('plugin/installed', {
      ...('cwds' in options ? { cwds: options.cwds ?? null } : {}),
      ...('installSuggestionPluginNames' in options
        ? { installSuggestionPluginNames: options.installSuggestionPluginNames ?? null }
        : {}),
    }))
  }

  async readPlugin(locator: CodexPluginLocator): Promise<CodexPluginDetail> {
    await this.ready
    return parsePluginDetail(
      await this.request('plugin/read', pluginLocatorParams(locator)),
    )
  }

  async readPluginSkill(locator: CodexPluginSkillLocator): Promise<string | null> {
    await this.ready
    const response = asRecord(
      await this.request('plugin/skill/read', locator),
      'plugin/skill/read',
    )
    if (response.contents !== null && typeof response.contents !== 'string') {
      throw new Error('Codex plugin/skill/read returned invalid contents')
    }
    return response.contents
  }

  async installPlugin(locator: CodexPluginLocator): Promise<CodexPluginInstallResult> {
    await this.ready
    return parsePluginInstallResult(
      await this.request('plugin/install', pluginLocatorParams(locator)),
    )
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.ready
    await this.request('plugin/uninstall', { pluginId })
  }

  async addMarketplace(
    options: CodexMarketplaceAddOptions,
  ): Promise<CodexMarketplaceAddResult> {
    await this.ready
    return parseMarketplaceAddResult(await this.request('marketplace/add', {
      source: options.source,
      ...('refName' in options ? { refName: options.refName ?? null } : {}),
      ...('sparsePaths' in options ? { sparsePaths: options.sparsePaths ?? null } : {}),
    }))
  }

  async removeMarketplace(marketplaceName: string): Promise<CodexMarketplaceRemoveResult> {
    await this.ready
    return parseMarketplaceRemoveResult(
      await this.request('marketplace/remove', { marketplaceName }),
    )
  }

  async upgradeMarketplaces(
    marketplaceName?: string | null,
  ): Promise<CodexMarketplaceUpgradeResult> {
    await this.ready
    return parseMarketplaceUpgradeResult(await this.request('marketplace/upgrade', {
      marketplaceName: marketplaceName ?? null,
    }))
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

  async logoutAccount(): Promise<void> {
    await this.ready
    await this.request('account/logout', undefined)
  }

  async getAccountWorkspaceMessages(): Promise<CodexWorkspaceMessagesResult> {
    await this.ready
    return parseWorkspaceMessages(
      await this.request('account/workspaceMessages/read', undefined),
    )
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeInternal()
    await this.closePromise
  }

  private async closeInternal(): Promise<void> {
    if (this.state === 'closed') return
    const child = this.childProcess
    this.state = 'closing'
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    if (this.restartResetTimer) {
      clearTimeout(this.restartResetTimer)
      this.restartResetTimer = undefined
    }
    const error = new Error('Codex app-server is closed')
    this.readiness.reject(error)
    this.rejectPending(error)

    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(terminateTimer)
          clearTimeout(killTimer)
          resolve()
        }
        const terminateTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        }, 2_000)
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          finish()
        }, 3_000)
        child.once('exit', finish)
        child.once('error', finish)
        try {
          child.stdin.end()
        } catch {
          child.kill('SIGTERM')
        }
      })
    }
    await Promise.all([...this.terminatingChildren])

    if (this.childProcess === child) this.childProcess = null
    this.state = 'closed'
    this.emitClose()
  }
}
