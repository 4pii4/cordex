export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
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
  allowAllUsers: boolean
  allowShellCommands: boolean
  allowedUserIds?: string[]
  allowedRoleIds?: string[]
  categoryId?: string
  projectsDirectory?: string
  projects: Record<string, ProjectConfig>
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
  worktree?: {
    projectDirectory: string
    directory: string
    branch: string
    merged?: boolean
  }
  activeTurnId?: string
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

export type CordexState = {
  channelModels: Record<string, string>
  channelEfforts: Record<string, ReasoningEffort>
  channelFastMode: Record<string, boolean>
  channelYoloMode: Record<string, boolean>
  channelAutoWorktrees: Record<string, boolean>
  channelVerbosity: Record<string, VerbosityLevel>
  sessions: Record<string, SessionState>
  queues: Record<string, QueuedPrompt[]>
  tasks: Record<string, ScheduledTask>
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }

export type CodexModel = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: ReasoningEffort
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
