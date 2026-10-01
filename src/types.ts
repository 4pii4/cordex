export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'
export type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export type VerbosityLevel = 'tools_and_text' | 'text_and_essential_tools' | 'text_only'

export type ProjectConfig = {
  directory: string
  name?: string
  kind?: 'root' | 'project'
}

export type CordexConfig = {
  token: string
  applicationId: string
  guildId: string
  defaultModel?: string
  defaultEffort?: ReasoningEffort
  sandbox: SandboxMode
  approvalPolicy: ApprovalPolicy
  approvalTimeoutMinutes?: number
  allowAllUsers: boolean
  allowShellCommands: boolean
  allowedUserIds?: string[]
  allowedRoleIds?: string[]
  runtimeRestartUserIds?: string[]
  categoryId?: string
  projectsDirectory?: string
  projects: Record<string, ProjectConfig>
}

export type SessionLifecycleIntent =
  | {
      kind: 'archive' | 'resume' | 'remove-worktree'
      requestedAt: string
    }
  | {
      kind: 'delete-thread'
      requestedAt: string
      remoteAction: 'archive' | 'delete'
    }

export type SessionAbortIntent = {
  requestedAt: string
  turnId?: string
}

export type SessionState = {
  discordThreadId: string
  parentChannelId: string
  directory: string
  codexThreadId: string
  model?: string
  effort?: ReasoningEffort
  fastMode?: boolean
  yoloMode?: boolean
  mode?: 'default' | 'plan'
  workspaceRoots?: string[]
  permissions?: string
  approvalsReviewer?: ApprovalsReviewer
  worktree?: {
    projectDirectory: string
    directory: string
    branch: string
    merged?: boolean
  }
  archived?: boolean
  lifecycleIntent?: SessionLifecycleIntent
  abortIntent?: SessionAbortIntent
  activeTurnId?: string
  activeAttachmentPaths?: string[]
  contextTokens?: number
  contextWindow?: number
  updatedAt: string
}

export type QueuedPrompt = {
  id: string
  authorId: string
  authorName: string
  input: UserInput[]
  displayText: string
  createdAt: string
  sourceMessageId?: string
  deliveryKind?: 'direct' | 'queued' | 'deferred'
  /** The prompt crossed the durable handoff boundary before a Codex turn RPC. */
  deliveryStarted?: boolean
  /** Delivery cannot be ruled out; hold until accepted input is found or the user resolves it. */
  reviewRequired?: boolean
}

export type PendingInitialSession = {
  parentChannelId: string
  directory: string
  createdAt: string
  abortIntent?: {
    requestedAt: string
    codexThreadId?: string
    reconciledAt?: string
  }
  model?: string
  effort?: ReasoningEffort
  fastMode?: boolean
  yoloMode?: boolean
  workspaceRoots?: string[]
  worktree?: {
    projectDirectory: string
    directory: string
    branch: string
  }
}

export type ScheduledTask = {
  id: string
  threadId: string
  prompt: string
  runAt: string
  repeatMs?: number
  createdBy: string
  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled'
  lastError?: string
}

export type DiscordOutboxEntry = {
  key: string
  discordThreadId: string
  codexThreadId: string
  turnId: string
  itemKey: string
  chunkIndex: number
  content: string
  attachment?: {
    sha256: string
    format: 'png' | 'jpg' | 'webp'
    size: number
  }
  fileAttachments?: Array<{
    sha256: string
    size: number
    name: string
  }>
  suppressNotifications: boolean
  nonce: string
  createdAt: string
}

export type RootChannelTombstone = {
  channelId: string
  projectDirectory: string
  deletedAt: string
}

export type CordexState = {
  channelModels: Record<string, string>
  channelEfforts: Record<string, ReasoningEffort>
  channelFastMode: Record<string, boolean>
  channelYoloMode: Record<string, boolean>
  channelAutoWorktrees: Record<string, boolean>
  channelVerbosity: Record<string, VerbosityLevel>
  sessions: Record<string, SessionState>
  pendingInitialSessions?: Record<string, PendingInitialSession>
  queues: Record<string, QueuedPrompt[]>
  tasks: Record<string, ScheduledTask>
  rootChannelTombstones?: Record<string, RootChannelTombstone>
  discordOutbox?: DiscordOutboxEntry[]
  discordOutboxDeliveredKeys?: string[]
}

export type ImageDetail = 'auto' | 'low' | 'high' | 'original'

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string; detail?: ImageDetail }
  | { type: 'localImage'; path: string; detail?: ImageDetail }
  | {
      type: 'localFile'
      path: string
      name: string
      mimeType: string
      size: number
      sha256: string
    }
  | { type: 'skill'; name: string; path: string }

export type CodexReasoningEffortOption = {
  reasoningEffort: ReasoningEffort
  description: string
}

export type CodexModelServiceTier = {
  id: string
  name: string
  description: string
}

export type CodexInputModality = 'text' | 'image'

export type CodexModel = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: ReasoningEffort
  supportedReasoningEfforts?: CodexReasoningEffortOption[]
  serviceTiers?: CodexModelServiceTier[]
  defaultServiceTier?: string | null
  inputModalities?: CodexInputModality[]
}

export type CodexThreadSummary = {
  id: string
  preview: string
  name?: string
  cwd: string
  updatedAt: number
}

export type JsonObject = Record<string, unknown>

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type DynamicToolFunctionSpec = {
  type: 'function'
  name: string
  description: string
  inputSchema: JsonValue
  deferLoading?: boolean
}

export type DynamicToolSpec =
  | DynamicToolFunctionSpec
  | {
      type: 'namespace'
      name: string
      description: string
      tools: DynamicToolFunctionSpec[]
    }

export type ServerRequest = {
  id: string | number
  method: string
  params: JsonObject
}

export type ServerNotification = {
  method: string
  params: JsonObject
}
