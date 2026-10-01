import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  Partials,
  ThreadAutoArchiveDuration,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message as DiscordMessage,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type PartialMessage,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import {
  assertDirectory,
  bindStatePath,
  getCordexHome,
  getProjectsDirectory,
  loadConfig,
  saveManagedConfig,
  saveState,
  withManagementLock,
} from './config.js'
import {
  createProjectChannel,
  ensureRootChannel,
  rootProjectDirectory,
} from './channel-management.js'
import {
  CodexAppServer,
  type CodexAppServerReadyEvent,
  type CodexAppServerRestartEvent,
  type CodexSkillMetadata,
  type CodexSkillsListEntry,
  type CodexThreadRuntimeState,
  type CodexSubagentThread,
  type ReviewTarget,
} from './codex-app-server.js'
import {
  actionButtonsToolName,
  actionButtonToolResult,
  cordexDynamicTools,
  parseActionButtons,
  type ActionButtonColor,
  type ActionButtonOption,
} from './action-buttons.js'
import { parseBtwMessage } from './btw.js'
import { fileUploadToolName, parseFileUploadPaths } from './file-upload-tool.js'
import { buildSlashCommands } from './discord-commands.js'
import {
  installCodexCliPlugin,
  listCodexCliPlugins,
  removeCodexCliPlugin,
  type CodexCliPlugin,
} from './codex-plugin-cli.js'
import {
  formatCompletedToolItem,
  formatAssistantText,
  formatModelBanner,
  formatModelLabel,
  formatRunFooter,
  formatShellCommandResult,
  splitMarkdownForDiscord,
} from './discord-output.js'
import { isUnknownDiscordChannelError, isUnknownDiscordMessageError } from './discord-errors.js'
import {
  createDiscordOutboxEntries,
  discordOutboxNonce,
  discordOutboxOutputKey,
  ensureDiscordOutboxState,
  rememberDiscordOutboxDeliveredKey,
} from './discord-outbox.js'
import {
  cacheGeneratedImage,
  decodeGeneratedImage,
  generatedImageFileName,
  pruneGeneratedImageCache,
  readCachedGeneratedImage,
  type GeneratedImageAttachment,
} from './discord-generated-media.js'
import {
  cacheOutgoingFile,
  pruneOutgoingFileCache,
  readCachedOutgoingFile,
  readOutgoingFiles,
  type OutgoingFileAttachment,
} from './discord-outgoing-files.js'
import {
  buildDiscordInput,
  pruneDiscordAttachmentCache,
  type DiscordInputResult,
} from './discord-input.js'
import { formatThreadHistory } from './history.js'
import { autoReviewSignature, formatAutoReviewNotice, parseLegacyAutoReviewWarning } from './auto-review.js'
import { RecentAutoReviewDenials } from './auto-review-denials.js'
import { readGitDiff, resolveGitCommit } from './git-diff.js'
import { parseQueueMessage } from './queue.js'
import { assertRepositoryInitTarget, repositoryInitOverrideNotice, repositoryInitPrompt } from './repository-init.js'
import {
  buildFileAutocompleteChoices,
  parseFileAutocomplete,
  resolveProjectFiles,
} from './files.js'
import {
  createProject,
  findProjectMapping,
  findProjectMappingForPath,
  projectMappings,
  projectRemapBlocker,
  projectRemovalBlocker,
  removeProjectChannelData,
  resolveProjectRoot,
} from './projects.js'
import { runShellCommand } from './shell.js'
import { KeyedSerialQueue } from './serial.js'
import {
  isMcpToolApproval,
  mcpElicitationPersistModes,
  mcpToolApprovalDisplayParams,
  parseMcpElicitationForm,
  parseMcpElicitationNumberInput,
  validateMcpElicitationContent,
  validateMcpElicitationFieldValue,
  validateMcpElicitationUrl,
  type McpElicitationField,
  type McpElicitationForm,
} from './mcp-elicitation.js'
import { normalizeThreadTitle } from './thread-title.js'
import { createLogger, type StructuredLogger } from './logger.js'
import { filterScheduledTasks, scheduledTaskDeliveryId, TaskScheduler } from './scheduler.js'
import {
  activeWorktreeSessions,
  createWorktree,
  inspectMergedWorktreeRemoval,
  listWorktreeInventory,
  mergeWorktree,
  removeMergedWorktree,
  removeWorktree,
  runGit,
  type CreatedWorktree,
} from './worktrees.js'
import {
  defaultVerbosity,
  showStatusFooter,
} from './verbosity.js'
import {
  applyContextUsage,
  contextUsagePercent,
  formatContextUsage,
  parseContextUsage,
  type ContextUsageUpdate,
} from './context-usage.js'
import { userHasAccess } from './access.js'
import type {
  CodexModel,
  CodexThreadSummary,
  CordexConfig,
  CordexState,
  ApprovalsReviewer,
  JsonObject,
  JsonValue,
  PendingInitialSession,
  QueuedPrompt,
  ReasoningEffort,
  ServerNotification,
  ServerRequest,
  SessionState,
  ScheduledTask,
  UserInput,
  VerbosityLevel,
} from './types.js'

type ResumeThreadChoice = CodexThreadSummary & { archived?: boolean }

const actionButtonTtlMs = 24 * 60 * 60_000
const defaultMcpElicitationTimeoutMinutes = 10
const maxMcpToolApprovalDisclosureChunks = 8
const pendingContextUsageTtlMs = 5 * 60_000
const maxPendingContextUsage = 100
const queuedSourceRetryMaxDelayMs = 60_000
const discordDiffPartBytes = 8 * 1_024 * 1_024
const maxDiscordDiffParts = 5

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
    ? value
    : undefined
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function discordUploadRejection(error: unknown): 'too-large' | 'invalid' | undefined {
  if (!isRecord(error)) return undefined
  if (error.status === 413 || error.code === 40005 || error.code === 50045) return 'too-large'
  if (
    error.status === 400 || error.status === 415 ||
    [30015, 50035, 50046, 50110, 50123].includes(Number(error.code))
  ) return 'invalid'
  return undefined
}

function errorObject(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function pathIsWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function escapeInlineMarkdown(value: string): string {
  return value.replace(/([*_~|`\\])/g, '\\$1')
}

function clearedQueueReply(prompts: QueuedPrompt[]): string {
  const count = prompts.length
  const heading = `Cleared ${count} queued message${count === 1 ? '' : 's'}:`
  const lines = prompts.map((prompt, index) => {
    const label = prompt.displayText.replace(/\s+/g, ' ').trim() || '(attachment)'
    return `${index + 1}. ${escapeInlineMarkdown(label)}`
  })
  return truncate(`${heading}\n${lines.join('\n')}`, 1_900)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function discordInlineCode(value: string): string {
  return `\`${value.replaceAll('`', 'ˋ').replace(/[\r\n]+/g, ' ')}\``
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return 'done'
  if (milliseconds < 1_000) return `${milliseconds}ms`
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function actionButtonStyle(color: ActionButtonColor): ButtonStyle {
  if (color === 'blue') return ButtonStyle.Primary
  if (color === 'green') return ButtonStyle.Success
  if (color === 'red') return ButtonStyle.Danger
  return ButtonStyle.Secondary
}

type ActiveRun = {
  session: SessionState
  channel: ThreadChannel
  model: string
  requestedModel?: string
  effort: string
  turnId?: string
  startedAt: number
  agentText: Map<string, string>
  activeItems: Map<string, string>
  autoReviews?: Map<string, 'started' | 'completed'>
  autoReviewSummaries?: Set<string>
  approvalsReviewer?: ApprovalsReviewer
  typingTimer: NodeJS.Timeout
  visibleOutput: boolean
  lastVisibleOutputAt?: number
  lastProgressAt: number
  progressSequence: number
  progressPromise?: Promise<void>
  contextPercent?: number
  lastError?: string
}

type PendingStartupProgress = {
  channel: ThreadChannel
  startedAt: number
  lastSentAt?: number
  sequence: number
  references: number
  timer: NodeJS.Timeout
  sending?: Promise<void>
}

type InitialSessionLocation = {
  directory: string
  worktree?: CreatedWorktree
  workspaceRoots?: string[]
}

const ephemeralChatCommands = new Set([
  'account-usage',
  'approve',
  'apps',
  'auth-status',
  'debug-config',
  'delete',
  'hooks',
  'last-sessions',
  'login',
  'mcp',
  'mcp-login',
  'mcp-status',
  'pending-prompts',
  'ps',
  'plugin',
  'plugins',
  'rate-limits',
  'resolve-pending',
  'session-id',
  'status',
  'stop',
  'subagents',
])

type PendingApproval = {
  request: ServerRequest
  channel: ThreadChannel
  message: DiscordMessage
  choices: ApprovalChoice[]
  timeout: NodeJS.Timeout
  userId?: string
}

type ApprovalChoice = {
  label: string
  style: ButtonStyle
  result: JsonObject
  confirmation: string
}

type PendingActionButtons = {
  request: ServerRequest
  threadId: string
  channel: ThreadChannel
  buttons: ActionButtonOption[]
  message: DiscordMessage
  timeout: NodeJS.Timeout
}

type UserInputQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

type PendingUserInput = {
  request: ServerRequest
  channel: ThreadChannel
  questions: UserInputQuestion[]
  answers: Record<string, string[]>
  messages: DiscordMessage[]
  timeout?: NodeJS.Timeout
}

type PendingMcpElicitation = {
  request: ServerRequest
  channel: ThreadChannel
  mode: 'form' | 'url'
  form?: McpElicitationForm
  url?: string
  content: Record<string, JsonValue>
  fieldMessages: DiscordMessage[]
  actionMessage: DiscordMessage
  timeout: NodeJS.Timeout
  toolApproval: boolean
}

type PendingRequestControl = {
  kind: 'approval' | 'userInput' | 'actionButtons' | 'mcpElicitation'
  key: string
  threadId?: string
}

type AbortReconciliation = {
  cleared: boolean
  goalPaused: boolean
  interrupted: boolean
  pendingStart: boolean
  errors: string[]
}

class CordexStoppingError extends Error {
  constructor() {
    super('Cordex is stopping')
  }
}

export class CordexDiscordBot {
  private readonly runtimeInstanceId = randomUUID()
  readonly client: Client
  private readonly logger: StructuredLogger
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  private readonly runs = new Map<string, ActiveRun>()
  private readonly pendingStartupProgress = new Map<string, PendingStartupProgress>()
  private readonly contextUsageVersions = new Map<string, number>()
  private readonly contextReplayBlocked = new Set<string>()
  private readonly pendingContextUsage = new Map<string, {
    update: ContextUsageUpdate
    expiresAt: number
  }>()
  private readonly goalStatusAnnouncements = new Map<string, string>()
  private readonly loadedThreads = new Set<string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly pendingActionButtons = new Map<string, PendingActionButtons>()
  private readonly pendingUserInputs = new Map<string, PendingUserInput>()
  private readonly pendingMcpElicitations = new Map<string, PendingMcpElicitation>()
  private readonly pendingRequestControls = new Map<string, PendingRequestControl>()
  private readonly pendingTurnStarts = new Set<string>()
  private readonly codexEventQueue = new KeyedSerialQueue()
  private readonly codexLifecycleQueue = new KeyedSerialQueue()
  private readonly discordIngressQueue = new KeyedSerialQueue()
  private readonly discordMessagesSeen = new Set<string>()
  private readonly lastDiscordMessages = new Map<string, string>()
  private readonly discordReconnectFloors = new Map<string, { afterId?: string; since: number }>()
  private readonly discordReconnectJobs = new Set<string>()
  private discordReconnectRetryTimer?: NodeJS.Timeout
  private readonly promptQueue = new KeyedSerialQueue()
  private readonly attachmentCacheQueue = new KeyedSerialQueue()
  private readonly outgoingMediaQueue = new KeyedSerialQueue()
  private readonly outgoingMediaDirectory: string
  private readonly outgoingFileDirectory: string
  private readonly discordOutboxStateQueue = new KeyedSerialQueue()
  private readonly discordOutboxDeliveryQueue = new KeyedSerialQueue()
  private readonly pluginMutationQueue = new KeyedSerialQueue()
  private readonly reportedBackgroundTerminals = new Map<string, Set<string>>()
  private readonly threadApprovalsReviewers = new Map<string, ApprovalsReviewer>()
  private readonly autoReviewDenials = new RecentAutoReviewDenials()
  private discordOutboxRetryTimer?: NodeJS.Timeout
  private discordOutboxRetryInFlight = false
  private discordOutboxRetryDelayMs = 5_000
  private readonly resumeQueue = new KeyedSerialQueue()
  private readonly titleQueue = new KeyedSerialQueue()
  private readonly expectedDiscordTitles = new Map<string, string>()
  private readonly expectedCodexTitles = new Map<string, string>()
  private readonly recentDiscordTitleEchoes = new Map<string, Map<string, number>>()
  private readonly recentCodexTitleEchoes = new Map<string, Map<string, number>>()
  private readonly pendingCodexTitles = new Map<string, string>()
  private readonly pendingDiscordTitles = new Map<string, string>()
  private readonly pendingCodexTitleVerifications = new Map<string, string>()
  private readonly pendingDiscordTitleVerifications = new Map<string, string>()
  private readonly titleVerificationRetryTimers = new Map<string, NodeJS.Timeout>()
  private readonly titleVerificationRetryAttempts = new Map<string, number>()
  private readonly pendingTitleVerificationSources = new Map<string, 'codex' | 'discord'>()
  private readonly preserveArchivedUntilResume = new Set<string>()
  private readonly expectedArchiveNotifications = new Map<
    string,
    { kind: 'archived' | 'unarchived'; expiresAt: number }
  >()
  private readonly mcpConfigQueue = new KeyedSerialQueue()
  private readonly projectMutationQueue = new KeyedSerialQueue()
  // Reserve inherited worktree directories while a child session is being created.
  // The reservation closes the gap between selecting a source session and persisting
  // the new session, so merge cannot detach the checkout in between.
  private readonly pendingSessionDirectoryReservations = new Map<string, number>()
  private readonly removingProjects = new Set<string>()
  private readonly blockedQueuedSourceThreads = new Set<string>()
  private readonly queuedSourceRetryTimers = new Map<string, NodeJS.Timeout>()
  private readonly queuedSourceRetryAttempts = new Map<string, number>()
  private readonly deletedDiscordThreads = new Set<string>()
  private readonly unlinkedCodexSessionChannels = new Set<string>()
  private readonly pendingDiscordIngress = new Set<Promise<void>>()
  private readonly pendingCodexNotifications = new Set<Promise<void>>()
  private readonly pendingCodexServerRequests = new Set<Promise<void>>()
  private readonly pendingCodexLifecycle = new Set<Promise<void>>()
  private readonly pendingCodexDeletionCleanups = new Set<Promise<void>>()
  private readonly pendingBackgroundWork = new Set<Promise<void>>()
  private readonly archivingDiscordThreads = new Set<string>()
  private readonly deletedThreadInterruptedTurns = new Map<string, Set<string>>()
  private readonly restartAffectedChannels = new Set<string>()
  private readonly projectCandidates = new Map<string, { directory: string; expiresAt: number }>()
  private readonly scheduler: TaskScheduler
  private codexGeneration = 0
  private codexRecoveryGeneration = 0
  private codexRecoveryPromise: Promise<void> | undefined
  private resolveCodexRecovery: (() => void) | undefined
  private codexUnavailableError: Error | undefined
  private latestCodexReset: Promise<void> = Promise.resolve()
  private latestCodexResetGeneration = -1
  private ingressReady: Promise<void> = Promise.resolve()
  private releaseIngressReady: (() => void) | undefined
  private resolveShutdownRequested: () => void = () => undefined
  private readonly shutdownRequested = new Promise<void>((resolve) => {
    this.resolveShutdownRequested = resolve
  })
  private stopping = false
  private runtimeRestartRequested = false
  private stopPromise: Promise<void> | undefined
  private modelCache: { expiresAt: number; models: CodexModel[] } | undefined
  private skillCacheGeneration = 0
  private readonly skillCache = new Map<
    string,
    { expiresAt: number; entries: CodexSkillsListEntry[] }
  >()

  constructor(
    private readonly config: CordexConfig,
    private readonly state: CordexState,
    private readonly codex: CodexAppServer,
    private readonly options: {
      verbose?: boolean
      pluginCliEnv?: NodeJS.ProcessEnv
      interruptedOnStartup?: Array<{
        discordThreadId: string
        codexThreadId: string
        turnId: string
      }>
      requestRuntimeRestart?: () => void
    } = {},
  ) {
    bindStatePath(this.state)
    ensureDiscordOutboxState(this.state)
    this.outgoingMediaDirectory = path.join(getCordexHome(), 'outgoing-media')
    this.outgoingFileDirectory = path.join(getCordexHome(), 'outgoing-files')
    this.logger = createLogger('discord-bot', { verbose: this.options.verbose === true })
    this.scheduler = new TaskScheduler(
      this.state.tasks,
      (task, recoverRunning) => this.runScheduledTask(task, recoverRunning),
      () => saveState(this.state),
    )
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    })
    this.client.on(Events.ClientReady, (client) => {
      this.logger.info('discord_ready', {
        userId: client.user.id,
        guildCount: client.guilds.cache.size,
      })
    })
    this.client.on(Events.Error, (error) => {
      this.logger.error('discord_error', error)
    })
    this.client.on(Events.Warn, (message) => {
      this.logger.warn('discord_warning', { message })
    })
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.captureDiscordReconnectFloors()
      this.logger.warn('shard_disconnected', {
        shardId,
        code: event.code,
        reason: event.reason,
        clean: event.wasClean,
      })
    })
    this.client.on(Events.ShardError, (error, shardId) => {
      this.logger.error('shard_error', error, { shardId })
    })
    this.client.on(Events.ShardReconnecting, (shardId) => {
      this.captureDiscordReconnectFloors()
      this.logger.info('shard_reconnecting', { shardId })
    })
    this.client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
      this.logger.info('shard_ready', {
        shardId,
        unavailableGuildCount: unavailableGuilds?.size || 0,
      })
      this.scheduleDiscordOutboxRetry(true)
      this.recoverDiscordReconnectMessages()
    })
    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.logger.info('shard_resumed', { shardId, replayedEvents })
      this.scheduleDiscordOutboxRetry(true)
      this.recoverDiscordReconnectMessages()
    })
    this.client.on(Events.Invalidated, () => {
      this.logger.error('discord_invalidated', new Error('Discord session was invalidated'))
    })
    this.client.on(Events.MessageCreate, (message) => {
      if (!this.rememberDiscordMessage(message)) return
      this.acceptDiscordIngress('Discord message', () =>
        this.discordIngressQueue.run(message.channel.id, async () => {
          await this.waitForIngressReady()
          try {
            await this.handleMessage(message)
          } catch (error) {
            this.discordMessagesSeen.delete(message.id)
            throw error
          }
        }))
    })
    this.client.on(Events.MessageUpdate, (_oldMessage, message) => {
      this.acceptDiscordIngress('Discord message update', () =>
        this.discordIngressQueue.run(
          message.channel.id,
          async () => {
            await this.waitForIngressReady()
            let resolved: DiscordMessage
            if (message.partial) {
              try {
                resolved = await (message as unknown as PartialMessage).fetch()
              } catch (error) {
                if (isUnknownDiscordMessageError(error)) {
                  await this.handleQueuedMessageDelete(message.id)
                  return
                }
                throw error
              }
            } else {
              resolved = message
            }
            if (resolved.editedTimestamp === null) return
            await this.handleQueuedMessageUpdate(resolved)
          },
        ))
    })
    this.client.on(Events.MessageDelete, (message) => {
      this.acceptDiscordIngress('Discord message deletion', () =>
        this.discordIngressQueue.run(
          message.channel.id,
          async () => {
            await this.waitForIngressReady()
            await this.handleQueuedMessageDelete(message.id)
          },
        ))
    })
    this.client.on(Events.ChannelDelete, (channel) => {
      this.stopPendingStartupProgress(channel.id)
      this.acceptDiscordIngress('Discord channel deletion', () =>
        this.discordIngressQueue.run(channel.id, () => this.handleChannelDelete(channel.id)))
    })
    this.client.on(Events.ThreadDelete, (thread) => {
      this.stopPendingStartupProgress(thread.id)
      this.acceptDiscordIngress('Discord thread deletion', async () => {
        this.clearQueuedSourceBlock(thread.id)
        this.unlinkedCodexSessionChannels.delete(thread.id)
        this.expectedDiscordTitles.delete(thread.id)
        this.recentDiscordTitleEchoes.delete(thread.id)
        this.pendingDiscordTitles.delete(thread.id)
        this.pendingDiscordTitleVerifications.delete(thread.id)
        const session = this.state.sessions[thread.id]
        if (session) {
          this.clearTitleVerificationState(session.codexThreadId, [thread.id])
          this.expectedCodexTitles.delete(session.codexThreadId)
          this.pendingCodexTitles.delete(session.codexThreadId)
          this.recentCodexTitleEchoes.delete(session.codexThreadId)
        }
        const firstDeletion = !this.deletedDiscordThreads.has(thread.id)
        this.deletedDiscordThreads.add(thread.id)
        if (firstDeletion && session) {
          await this.persistDeletedThreadIntent(session, 'archive')
        }
        const interruption = firstDeletion
          ? this.interruptDeletedThreadTurn(thread.id).then(
              () => undefined,
              (error: unknown) => error,
            )
          : Promise.resolve(undefined)
        await this.discordIngressQueue.run(
          thread.id,
          () => this.handleThreadDelete(thread.id, interruption),
        )
      })
    })
    this.client.on(Events.ThreadUpdate, (oldThread, newThread) => {
      if (oldThread.name === newThread.name) return
      this.acceptDiscordIngress('Discord thread title synchronization', () =>
        this.discordIngressQueue.run(
          newThread.id,
          () => this.handleDiscordThreadTitleUpdate(newThread, oldThread.name),
        ))
    })
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        this.acceptDiscordIngress('Discord autocomplete', () => this.handleAutocomplete(interaction))
      }
      else if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'abort') {
          this.acceptDiscordIngress(
            'Discord abort command',
            () => this.handlePriorityCommand(interaction),
          )
        }
        else {
          this.acceptDiscordIngress('Discord command', () => this.handleQueuedCommand(interaction))
        }
      }
      else if (interaction.isButton()) {
        this.acceptDiscordIngress('Discord button', () => this.handleButton(interaction))
      }
      else if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('fork-subagent:')) {
          this.acceptDiscordIngress(
            'Discord selection',
            () => this.handleForkSubagentSelect(interaction),
          )
        } else if (interaction.customId.startsWith('mcp-elicit-select:')) {
          this.acceptDiscordIngress(
            'MCP elicitation selection',
            () => this.handleMcpElicitationSelect(interaction),
          )
        } else {
          this.acceptDiscordIngress('Discord selection', () => this.handleUserInputSelect(interaction))
        }
      }
      else if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('mcp-elicit-modal:')) {
          this.acceptDiscordIngress(
            'MCP elicitation modal',
            () => this.handleMcpElicitationModal(interaction),
          )
        } else {
          this.acceptDiscordIngress('Discord modal', () => this.handleUserInputModal(interaction))
        }
      }
    })
    this.codex.on('notification', (notification: ServerNotification) => {
      this.logVerbose('notification', notification)
      const generation = this.codexGeneration
      this.trackPendingWork(
        this.pendingCodexNotifications,
        this.enqueueNotification(notification, generation),
        'Codex notification',
      )
    })
    this.codex.on('serverRequest', (request: ServerRequest) => {
      this.logVerbose('server request', request)
      const generation = this.codexGeneration
      this.trackPendingWork(
        this.pendingCodexServerRequests,
        this.enqueueServerRequest(request, generation),
        'Codex server request',
      )
    })
    this.codex.on('protocolError', (error: Error) => this.logger.error('codex_protocol_error', error))
    this.codex.on('childFailure', (error: Error) => {
      if (this.stopping) return
      this.logger.warn('codex_child_failed', {
        generation: this.codexLifecycleGeneration(),
        error,
      })
      this.codexGeneration += 1
      this.threadApprovalsReviewers.clear()
      this.autoReviewDenials.clear()
      this.beginCodexRecovery(this.codexLifecycleGeneration())
    })
    this.codex.on('restarting', (event: CodexAppServerRestartEvent) => {
      if (this.stopping) return
      this.logger.warn('codex_restarting', {
        generation: event.generation,
        attempt: event.attempt,
        delayMs: event.delayMs,
        error: event.error,
      })
      const generation = event.generation ?? this.codexLifecycleGeneration()
      this.beginCodexRecovery(generation)
      const reset = this.onCodexRestarting(event, generation)
      this.latestCodexReset = reset
      this.latestCodexResetGeneration = generation
      this.trackPendingWork(
        this.pendingCodexLifecycle,
        reset,
        'Cordex state reset after app-server exit',
      )
    })
    this.codex.on('ready', (event: CodexAppServerReadyEvent) => {
      if (!event.restartAttempt) return
      this.logger.info('codex_recovered', event)
      const generation = event.generation ?? this.codexLifecycleGeneration()
      if (this.stopping) {
        this.finishCodexRecovery(generation)
        return
      }
      this.beginCodexRecovery(generation)
      const reset = this.latestCodexReset
      const recovery = this.codexLifecycleQueue.run('app-server', async () => {
        try {
          await reset
          if (generation !== this.codexLifecycleGeneration()) return
          await this.onCodexRecovered(generation)
          if (generation === this.codexLifecycleGeneration()) {
            this.codexUnavailableError = undefined
          }
        } catch (error) {
          if (generation === this.codexLifecycleGeneration()) {
            const failure = this.markCodexUnavailable(
              'Codex runtime recovery failed',
              error,
            )
            await this.onCodexRecoveryFailed(failure)
          }
          throw error
        }
      }).finally(() => this.finishCodexRecovery(generation))
      this.trackPendingWork(
        this.pendingCodexLifecycle,
        recovery,
        'Cordex session recovery after app-server restart',
      )
    })
    this.codex.on('failed', (error: Error) => {
      this.logger.error('codex_terminal_failure', error, {
        generation: this.codexLifecycleGeneration(),
      })
      const generation = this.codexLifecycleGeneration()
      if (this.stopping) {
        this.finishCodexRecovery(generation)
        return
      }
      this.beginCodexRecovery(generation)
      const reset = this.latestCodexResetGeneration === generation
        ? this.latestCodexReset
        : this.onCodexRestarting({
            generation,
            attempt: 0,
            delayMs: 0,
            error,
          }, generation, false)
      this.latestCodexReset = reset
      this.latestCodexResetGeneration = generation
      const failure = this.codexLifecycleQueue.run('app-server', async () => {
        let terminalError = error
        try {
          await reset
        } catch (resetError) {
          terminalError = new Error(
            `Codex runtime reset failed after terminal app-server failure: ${errorText(resetError)}`,
            { cause: resetError },
          )
        }
        if (generation !== this.codexLifecycleGeneration()) return
        const unavailable = this.markCodexUnavailable(
          'Codex app-server reached a terminal failure',
          terminalError,
        )
        await this.onCodexRecoveryFailed(unavailable)
      }).finally(() => this.finishCodexRecovery(generation))
      this.trackPendingWork(
        this.pendingCodexLifecycle,
        failure,
        'terminal app-server failure report',
      )
    })
    this.codex.on('stderr', (chunk: string) => {
      const hasFailureSignal = /\b(error|panic|fatal)\b/i.test(chunk)
      const metadata = {
        bytes: Buffer.byteLength(chunk, 'utf8'),
        lineCount: chunk.length === 0 ? 0 : chunk.split(/\r?\n/).length,
        hasFailureSignal,
      }
      if (hasFailureSignal) this.logger.warn('codex_stderr', metadata)
      else this.logger.info('codex_stderr', metadata)
    })
  }

  private trackPendingWork(
    pending: Set<Promise<void>>,
    work: Promise<void>,
    label: string,
  ): void {
    const handling = work.catch((error: unknown) => {
      if (error instanceof CordexStoppingError) return
      this.logger.error('async_work_failed', error, { label })
    })
    pending.add(handling)
    void handling.finally(() => pending.delete(handling)).catch(() => undefined)
  }

  private trackBackgroundWork(work: Promise<void>, label: string): void {
    this.trackPendingWork(this.pendingBackgroundWork, work, label)
  }

  private acceptDiscordIngress(label: string, task: () => Promise<void>): void {
    if (this.stopping) return
    let work: Promise<void>
    try {
      work = task()
    } catch (error) {
      work = Promise.reject(error)
    }
    this.trackPendingWork(this.pendingDiscordIngress, work, label)
  }

  private rememberDiscordMessage(message: DiscordMessage): boolean {
    if (message.guildId !== this.config.guildId || message.author.bot) return true
    const parentId = message.channel.isThread() ? message.channel.parentId : message.channel.id
    if (!parentId || !this.config.projects[parentId] || !/^\d+$/.test(message.id)) return true
    if (this.discordMessagesSeen.has(message.id)) return false
    this.discordMessagesSeen.add(message.id)
    // Retain every ID during catch-up, including gateway events queued behind
    // the REST scan, so a successful gateway resume cannot deliver it twice.
    if (this.discordReconnectFloors.size === 0 && this.discordMessagesSeen.size > 10_000) {
      this.discordMessagesSeen.delete(this.discordMessagesSeen.values().next().value!)
    }
    const previous = this.lastDiscordMessages.get(message.channel.id)
    if (!previous || BigInt(message.id) > BigInt(previous)) {
      this.lastDiscordMessages.set(message.channel.id, message.id)
    }
    return true
  }

  private captureDiscordReconnectFloors(): void {
    if (this.stopping) return
    const channelIds = new Set([
      ...Object.keys(this.config.projects),
      ...Object.keys(this.state.sessions),
      ...Object.keys(this.state.pendingInitialSessions || {}),
    ])
    const since = Date.now() - 2_000
    for (const channelId of channelIds) {
      const pending = this.discordReconnectFloors.get(channelId)
      if (pending) {
        // A new disconnect during a scan must survive that scan's completion.
        if (this.discordReconnectJobs.has(channelId)) {
          this.discordReconnectFloors.set(channelId, { ...pending })
        }
        continue
      }
      const afterId = this.lastDiscordMessages.get(channelId)
      this.discordReconnectFloors.set(channelId, { ...(afterId ? { afterId } : {}), since })
    }
  }

  private recoverDiscordReconnectMessages(): void {
    if (this.stopping || this.discordReconnectFloors.size === 0) return
    if (this.discordReconnectRetryTimer) clearTimeout(this.discordReconnectRetryTimer)
    delete this.discordReconnectRetryTimer
    for (const [channelId, floor] of this.discordReconnectFloors) {
      if (this.discordReconnectJobs.has(channelId)) continue
      this.discordReconnectJobs.add(channelId)
      this.acceptDiscordIngress('Discord reconnect message recovery', async () => {
        try {
          await this.discordIngressQueue.run(channelId, async () => {
            await this.waitForIngressReady()
            this.assertNotStopping()
            let channel
            try {
              channel = await this.client.channels.fetch(channelId)
            } catch (error) {
              if (!isUnknownDiscordChannelError(error)) throw error
              this.discordReconnectFloors.delete(channelId)
              return
            }
            if (!channel) throw new Error('Discord message recovery channel is unavailable')
            if ((!channel.isThread() && channel.type !== ChannelType.GuildText) ||
              channel.guildId !== this.config.guildId) {
              this.discordReconnectFloors.delete(channelId)
              return
            }
            const parentId = channel.isThread() ? channel.parentId : channel.id
            if (!parentId || !this.config.projects[parentId] || this.removingProjects.has(parentId) ||
              this.deletedDiscordThreads.has(channelId) || this.state.sessions[channelId]?.archived ||
              (channel.isThread() && channel.archived)) {
              this.discordReconnectFloors.delete(channelId)
              return
            }

            const recovered: DiscordMessage[] = []
            const pageCursors = new Set<string>()
            let before: string | undefined
            let complete = false
            // Fetch backward to the fixed disconnect anchor, then replay
            // chronologically. New gateway messages wait behind this scan.
            for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
              this.assertNotStopping()
              const page = await channel.messages.fetch({
                limit: 100, cache: false, ...(before ? { before } : {}),
              })
              const messages = [...page.values()].sort((a, b) =>
                BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
              if (messages.length === 0) {
                complete = true
                break
              }
              const afterFloor = (message: DiscordMessage): boolean => floor.afterId
                ? BigInt(message.id) > BigInt(floor.afterId)
                : message.createdTimestamp >= floor.since
              recovered.push(...messages.filter(afterFloor))
              const oldest = messages[0]!
              if (!afterFloor(oldest) || messages.length < 100) {
                complete = true
                break
              }
              if (pageCursors.has(oldest.id)) throw new Error('Discord message recovery repeated a page')
              pageCursors.add(oldest.id)
              before = oldest.id
            }
            if (!complete) throw new Error('Discord message recovery exceeded its history limit')
            recovered.sort((a, b) =>
              BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
            for (const message of recovered) {
              this.assertNotStopping()
              if (message.author.bot || !this.rememberDiscordMessage(message)) continue
              try {
                await this.handleMessage(message)
              } catch (error) {
                this.discordMessagesSeen.delete(message.id)
                throw error
              }
            }
            if (this.discordReconnectFloors.get(channelId) === floor) {
              this.discordReconnectFloors.delete(channelId)
            }
          })
        } catch (error) {
          if (!(error instanceof CordexStoppingError)) {
            this.logger.warn('discord_message_recovery_deferred', { channelId, error: errorText(error) })
          }
        } finally {
          this.discordReconnectJobs.delete(channelId)
          if (!this.stopping && this.discordReconnectFloors.size > 0 && !this.discordReconnectRetryTimer) {
            this.discordReconnectRetryTimer = setTimeout(() => {
              delete this.discordReconnectRetryTimer
              this.recoverDiscordReconnectMessages()
            }, 5_000)
            this.discordReconnectRetryTimer.unref()
          }
        }
      })
    }
  }

  private assertNotStopping(): void {
    if (this.stopping) throw new CordexStoppingError()
  }

  private async drainPendingWork(pending: Set<Promise<void>>): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending])
  }

  private async drainKeyedQueues(): Promise<void> {
    await Promise.all([
      this.codexEventQueue.drain(),
      this.codexLifecycleQueue.drain(),
      this.discordIngressQueue.drain(),
      this.promptQueue.drain(),
      this.attachmentCacheQueue.drain(),
      this.outgoingMediaQueue.drain(),
      this.discordOutboxStateQueue.drain(),
      this.discordOutboxDeliveryQueue.drain(),
      this.resumeQueue.drain(),
      this.titleQueue.drain(),
      this.mcpConfigQueue.drain(),
      this.projectMutationQueue.drain(),
    ])
  }

  private pendingShutdownWork(): number {
    return this.pendingDiscordIngress.size +
      this.pendingCodexNotifications.size +
      this.pendingCodexServerRequests.size +
      this.pendingCodexLifecycle.size +
      this.pendingCodexDeletionCleanups.size +
      this.pendingBackgroundWork.size
  }

  private async drainShutdownWork(): Promise<void> {
    do {
      await this.drainPendingWork(this.pendingDiscordIngress)
      await this.drainKeyedQueues()
      await Promise.all([
        this.drainPendingWork(this.pendingCodexNotifications),
        this.drainPendingWork(this.pendingCodexServerRequests),
        this.drainPendingWork(this.pendingCodexLifecycle),
        this.drainPendingWork(this.pendingCodexDeletionCleanups),
        this.drainPendingWork(this.pendingBackgroundWork),
      ])
      // Codex handlers can append persistence and delivery work after the first
      // queue pass, and queue work can synchronously emit another tracked event.
      await this.drainKeyedQueues()
      await Promise.resolve()
    } while (this.pendingShutdownWork() > 0)
  }

  private logVerbose(label: string, value: unknown): void {
    this.logger.info(label, { details: value })
  }

  private respondToCodex(request: ServerRequest, result: unknown): boolean {
    try {
      const respondTo = (this.codex as CodexAppServer & {
        respondTo?: (request: ServerRequest, result: unknown) => void
      }).respondTo
      if (respondTo) respondTo.call(this.codex, request, result)
      else this.codex.respond(request.id, result)
      return true
    } catch (error) {
      this.logVerbose('stale server response ignored', {
        requestId: request.id,
        method: request.method,
        error: errorText(error),
      })
      return false
    }
  }

  private beginCodexRecovery(generation: number): void {
    this.codexRecoveryGeneration = generation
    this.codexUnavailableError = undefined
    if (this.codexRecoveryPromise) return
    this.codexRecoveryPromise = new Promise<void>((resolve) => {
      this.resolveCodexRecovery = resolve
    })
  }

  private codexLifecycleGeneration(): number {
    const generation = (this.codex as CodexAppServer & { generation?: number }).generation
    return typeof generation === 'number' ? generation : this.codexGeneration
  }

  private finishCodexRecovery(generation: number): void {
    if (generation !== this.codexRecoveryGeneration) return
    this.resolveCodexRecovery?.()
    this.resolveCodexRecovery = undefined
    this.codexRecoveryPromise = undefined
  }

  private async waitForCodexRecovery(): Promise<void> {
    while (this.codexRecoveryPromise) {
      const recovery = this.codexRecoveryPromise
      await Promise.race([
        recovery,
        this.shutdownRequested.then(() => {
          throw new CordexStoppingError()
        }),
      ])
    }
    if (this.codexUnavailableError) throw this.codexUnavailableError
  }

  private markCodexUnavailable(context: string, error: unknown): Error {
    const cause = errorObject(error)
    const unavailable = new Error(`${context}: ${cause.message}`, { cause })
    this.codexUnavailableError = unavailable
    this.logger.error('codex_unavailable', unavailable, { context })
    return unavailable
  }

  private beginIngressBarrier(): void {
    if (this.releaseIngressReady) return
    this.ingressReady = new Promise<void>((resolve) => {
      this.releaseIngressReady = resolve
    })
  }

  private finishIngressBarrier(): void {
    this.releaseIngressReady?.()
    this.releaseIngressReady = undefined
    this.ingressReady = Promise.resolve()
  }

  private async waitForIngressReady(): Promise<void> {
    await this.ingressReady
  }

  // State mutations wait for both startup and Codex restart recovery.
  private async waitForMutationIngressReady(): Promise<void> {
    await this.waitForIngressReady()
    await this.waitForCodexRecovery()
  }

  private async pruneAttachmentCache(): Promise<void> {
    await this.attachmentCacheQueue.run('attachments', async () => {
      const protectedPaths = Object.values(this.state.queues).flatMap((queue) =>
        queue.flatMap((prompt) => prompt.input.flatMap((item) =>
          item.type === 'localImage' || item.type === 'localFile' ? [item.path] : [])))
      await pruneDiscordAttachmentCache({ protectedPaths })
    })
  }

  private async pruneOutgoingMediaCache(): Promise<void> {
    await this.outgoingMediaQueue.run('cache', async () => {
      const referenced = (this.state.discordOutbox || []).flatMap((entry) =>
        entry.attachment ? [entry.attachment] : [])
      const fileReferences = (this.state.discordOutbox || []).flatMap((entry) =>
        entry.fileAttachments || [])
      const removed = await pruneGeneratedImageCache(this.outgoingMediaDirectory, referenced) +
        await pruneOutgoingFileCache(this.outgoingFileDirectory, fileReferences)
      if (removed > 0) this.logVerbose('pruned delivered generated-image cache', { removed })
    })
  }

  private preserveDiscordTitleEchoesAcrossRestart(): void {
    for (const [discordThreadId, title] of this.expectedDiscordTitles) {
      this.rememberTitleEcho(this.recentDiscordTitleEchoes, discordThreadId, title)
    }
    this.expectedDiscordTitles.clear()
  }

  private async onCodexRestarting(
    event: CodexAppServerRestartEvent,
    generation = this.codexLifecycleGeneration(),
    announceRestart = true,
  ): Promise<void> {
    this.logVerbose('app-server restarting', {
      attempt: event.attempt,
      delayMs: event.delayMs,
      error: event.error.message,
    })
    this.loadedThreads.clear()
    this.preserveDiscordTitleEchoesAcrossRestart()
    this.expectedCodexTitles.clear()
    this.recentCodexTitleEchoes.clear()
    this.invalidateSkillCache()
    for (const timer of this.titleVerificationRetryTimers.values()) clearTimeout(timer)
    this.titleVerificationRetryTimers.clear()
    this.expectedArchiveNotifications.clear()
    this.pendingTurnStarts.clear()
    const sessionsByThread = new Map<string, SessionState[]>()
    for (const session of Object.values(this.state.sessions)) {
      const sessions = sessionsByThread.get(session.codexThreadId) || []
      sessions.push(session)
      sessionsByThread.set(session.codexThreadId, sessions)
    }
    const threadIds = new Set([...sessionsByThread.keys(), ...this.runs.keys()])
    const interruptedRuns: ActiveRun[] = []
    await Promise.all(Array.from(threadIds, (threadId) => this.codexEventQueue.run(threadId, async () => {
      const run = this.runs.get(threadId)
      if (run) {
        clearInterval(run.typingTimer)
        this.runs.delete(threadId)
        interruptedRuns.push(run)
        this.restartAffectedChannels.add(run.channel.id)
      }
      const sessions = sessionsByThread.get(threadId) || []
      for (const session of sessions) {
        if (session.activeTurnId) this.restartAffectedChannels.add(session.discordThreadId)
        delete session.activeTurnId
        session.updatedAt = new Date().toISOString()
        await this.dismissPendingControlsForChannel(
          session.discordThreadId,
          '_Codex runtime restarted._',
        )
      }
    })))
    await saveState(this.state)
    if (announceRestart) {
      await Promise.all([...this.restartAffectedChannels].map(async (channelId) => {
        const run = interruptedRuns.find((candidate) => candidate.channel.id === channelId)
        const codexThreadId = run?.session.codexThreadId ||
          this.state.sessions[channelId]?.codexThreadId || 'runtime'
        await this.queueRuntimeNotice({
          discordThreadId: channelId,
          codexThreadId,
          turnId: `runtime-restart:${this.runtimeInstanceId}:${generation}`,
          itemKey: `attempt:${event.attempt}`,
          value: `⚠ Codex runtime stopped unexpectedly and is restarting (attempt ${event.attempt}). The interrupted turn was ended.`,
        }).catch((error: unknown) => {
          this.logger.error('runtime_notice_failed', error, { channelId, phase: 'restarting' })
        })
      }))
    }
  }

  private async onCodexRecovered(generation = this.codexLifecycleGeneration()): Promise<void> {
    await this.reconcileDeletedThreadIntents()
    if (generation !== this.codexLifecycleGeneration()) return
    await this.reconcileSessionLifecycleIntents()
    if (generation !== this.codexLifecycleGeneration()) return
    await this.reconcileAbortIntents(generation)
    if (generation !== this.codexLifecycleGeneration()) return
    await this.reconcileWorktreeRemovalIntents()
    if (generation !== this.codexLifecycleGeneration()) return
    await this.recoverDiscordOutbox()
    this.scheduleDiscordOutboxRetry()
    if (generation !== this.codexLifecycleGeneration()) return
    await this.reconcileSessionTitles(generation)
    if (generation !== this.codexLifecycleGeneration()) return
    for (const session of Object.values(this.state.sessions)) {
      if (generation !== this.codexLifecycleGeneration()) return
      if (session.archived) continue
      if ((this.state.queues[session.discordThreadId]?.length || 0) === 0) continue
      const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
      if (generation !== this.codexLifecycleGeneration()) return
      if (channel?.isThread()) {
        await this.recoverPersistedPrompts(session, channel, false).catch((error: unknown) => {
          this.logVerbose('persisted prompt recovery after app-server restart failed', {
            threadId: session.codexThreadId,
            error: errorText(error),
          })
        })
      }
    }
    if (generation !== this.codexLifecycleGeneration()) return
    const affectedChannels = [...this.restartAffectedChannels]
    this.restartAffectedChannels.clear()
    await Promise.all(affectedChannels.map(async (channelId) => {
      await this.queueRuntimeNotice({
        discordThreadId: channelId,
        codexThreadId: this.state.sessions[channelId]?.codexThreadId || 'runtime',
        turnId: `runtime-recovery:${this.runtimeInstanceId}:${generation}`,
        itemKey: 'recovered',
        value: '✓ Codex runtime recovered.',
      }).catch((error: unknown) => {
        this.logger.error('runtime_notice_failed', error, { channelId, phase: 'recovered' })
      })
    }))
  }

  private async onCodexRecoveryFailed(error: Error): Promise<void> {
    const affectedChannels = [...this.restartAffectedChannels]
    this.restartAffectedChannels.clear()
    await Promise.all(affectedChannels.map(async (channelId) => {
      await this.queueRuntimeNotice({
        discordThreadId: channelId,
        codexThreadId: this.state.sessions[channelId]?.codexThreadId || 'runtime',
        turnId: `runtime-recovery:${this.runtimeInstanceId}:${this.codexLifecycleGeneration()}`,
        itemKey: 'failed',
        value: `⨯ Codex runtime recovery failed: ${truncate(error.message, 1_750)}`,
      }).catch((noticeError: unknown) => {
        this.logger.error('runtime_notice_failed', noticeError, { channelId, phase: 'failed' })
      })
    }))
  }

  private async persistAbortIntent(
    session: SessionState,
    turnId?: string,
  ): Promise<void> {
    const existing = session.abortIntent
    const targetTurnId = turnId || existing?.turnId
    if (existing && existing.turnId === targetTurnId) return
    const previous = structuredClone(session)
    const now = new Date().toISOString()
    session.abortIntent = {
      requestedAt: existing?.requestedAt || now,
      ...(targetTurnId ? { turnId: targetTurnId } : {}),
    }
    session.updatedAt = now
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
  }

  private async clearAbortIntent(session: SessionState): Promise<void> {
    if (!session.abortIntent) return
    const previous = structuredClone(session)
    delete session.abortIntent
    delete session.activeTurnId
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
    const run = this.runs.get(session.codexThreadId)
    if (run) clearInterval(run.typingTimer)
    this.runs.delete(session.codexThreadId)
    await this.dismissPendingControlsForChannel(session.discordThreadId, '_Turn aborted._')
  }

  private async pauseActiveGoal(
    session: SessionState,
  ): Promise<{ safe: boolean; paused: boolean; error?: string }> {
    const codex = this.codex as unknown as {
      getThreadGoal?: (threadId: string) => Promise<{ status?: string } | null>
      setThreadGoal?: (
        threadId: string,
        update: { status: 'paused' },
      ) => Promise<{ status?: string }>
    }
    if (typeof codex.getThreadGoal !== 'function') return { safe: true, paused: false }
    try {
      const goal = await codex.getThreadGoal.call(this.codex, session.codexThreadId)
      if (goal?.status !== 'active') return { safe: true, paused: false }
      if (typeof codex.setThreadGoal !== 'function') {
        return { safe: false, paused: false, error: 'Codex goal pause is unavailable' }
      }
      const paused = await codex.setThreadGoal.call(
        this.codex,
        session.codexThreadId,
        { status: 'paused' },
      )
      if (paused.status === 'active') {
        return { safe: false, paused: false, error: 'Codex goal remained active' }
      }
      return { safe: true, paused: true }
    } catch (error) {
      return {
        safe: false,
        paused: false,
        error: `goal pause failed: ${errorText(error)}`,
      }
    }
  }

  private async reconcileAbortIntent(
    session: SessionState,
    preferredTurnId?: string,
  ): Promise<AbortReconciliation> {
    const result: AbortReconciliation = {
      cleared: !session.abortIntent,
      goalPaused: false,
      interrupted: false,
      pendingStart: false,
      errors: [],
    }
    if (!session.abortIntent) return result

    const goal = await this.pauseActiveGoal(session)
    result.goalPaused = goal.paused
    if (!goal.safe && goal.error) result.errors.push(goal.error)

    const attemptedTurns = new Set<string>()
    const interrupt = async (turnId: string): Promise<void> => {
      if (attemptedTurns.has(turnId)) return
      attemptedTurns.add(turnId)
      try {
        await this.persistAbortIntent(session, turnId)
      } catch (error) {
        result.errors.push(`abort intent update failed: ${errorText(error)}`)
        return
      }
      try {
        await this.codex.interruptTurn(session.codexThreadId, turnId)
        result.interrupted = true
      } catch (error) {
        result.errors.push(`turn interruption failed: ${errorText(error)}`)
      }
    }

    if (preferredTurnId) await interrupt(preferredTurnId)

    let runtime: CodexThreadRuntimeState | undefined
    const readRuntime = async (): Promise<void> => {
      const getRuntime = (this.codex as unknown as {
        getThreadRuntimeState?: (threadId: string) => Promise<CodexThreadRuntimeState>
      }).getThreadRuntimeState
      if (typeof getRuntime !== 'function') {
        result.errors.push('runtime query failed: Codex runtime query is unavailable')
        return
      }
      try {
        runtime = await getRuntime.call(this.codex, session.codexThreadId)
      } catch (error) {
        result.errors.push(`runtime query failed: ${errorText(error)}`)
      }
    }

    await readRuntime()
    if (runtime?.status === 'active' && runtime.activeTurnId) {
      const runtimeTurnId = runtime.activeTurnId
      await interrupt(runtimeTurnId)
      if (!attemptedTurns.has(runtimeTurnId) || result.interrupted) {
        runtime = undefined
        await readRuntime()
      }
    }
    if (runtime?.status === 'systemError') {
      result.errors.push('runtime query failed: Codex thread is unavailable')
    }

    result.pendingStart = this.pendingTurnStarts.has(session.codexThreadId)
    if (
      result.errors.length === 0 &&
      goal.safe &&
      !result.pendingStart &&
      (runtime?.status === 'idle' || runtime?.status === 'notLoaded')
    ) {
      try {
        await this.clearAbortIntent(session)
        result.cleared = true
      } catch (error) {
        result.errors.push(`abort confirmation save failed: ${errorText(error)}`)
      }
    }
    return result
  }

  private async reconcileAbortIntents(expectedGeneration?: number): Promise<void> {
    const checked = new Set<string>()
    for (const session of Object.values(this.state.sessions)) {
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== this.codexLifecycleGeneration()
      ) return
      if (!session.abortIntent || checked.has(session.codexThreadId)) continue
      checked.add(session.codexThreadId)
      const result = await this.reconcileAbortIntent(session).catch((error: unknown) => ({
        cleared: false,
        goalPaused: false,
        interrupted: false,
        pendingStart: false,
        errors: [errorText(error)],
      }))
      if (result.errors.length > 0) {
        this.logVerbose('abort reconciliation pending', {
          threadId: session.codexThreadId,
          errors: result.errors,
        })
      }
    }
  }

  private async persistSessionLifecycleIntent(
    session: SessionState,
    kind: 'archive' | 'resume',
  ): Promise<void> {
    const existing = session.lifecycleIntent
    if (existing && existing.kind !== kind) {
      throw new Error(`Session ${existing.kind} operation is still pending`)
    }
    if (existing) return
    const previous = structuredClone(session)
    const now = new Date().toISOString()
    if (!existing) session.lifecycleIntent = { kind, requestedAt: now }
    session.archived = true
    session.updatedAt = now
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
  }

  private async persistDeletedThreadIntent(
    session: SessionState,
    remoteAction: 'archive' | 'delete',
  ): Promise<void> {
    if (session.lifecycleIntent?.kind === 'remove-worktree') {
      await this.completePendingWorktreeRemovalBeforeSessionDrop(session)
    }
    const previous = structuredClone(session)
    const now = new Date().toISOString()
    const turnId = this.runs.get(session.codexThreadId)?.turnId || session.activeTurnId
    const existingDeleteIntent = session.lifecycleIntent?.kind === 'delete-thread'
      ? session.lifecycleIntent
      : undefined
    session.lifecycleIntent = {
      kind: 'delete-thread',
      requestedAt: existingDeleteIntent?.requestedAt || now,
      remoteAction: existingDeleteIntent?.remoteAction || remoteAction,
    }
    session.abortIntent = {
      requestedAt: session.abortIntent?.requestedAt || now,
      ...(turnId ? { turnId } : session.abortIntent?.turnId
        ? { turnId: session.abortIntent.turnId }
        : {}),
    }
    session.archived = true
    session.updatedAt = now
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
  }

  private async finalizeDeletedDiscordThread(session: SessionState): Promise<void> {
    await this.promptQueue.run(session.discordThreadId, () =>
      this.finalizeDeletedDiscordThreadWithinPrompt(session))
  }

  private async finalizeDeletedDiscordThreadWithinPrompt(
    session: SessionState,
  ): Promise<void> {
    const current = this.state.sessions[session.discordThreadId]
    if (
      current !== session ||
      current.lifecycleIntent?.kind !== 'delete-thread'
    ) return
    await this.completePendingWorktreeRemovalBeforeSessionDrop(session)
    await this.discordOutboxStateQueue.run('state', () =>
      this.finalizeDeletedDiscordThreadLocked(session))
  }

  private async finalizeDeletedDiscordThreadLocked(session: SessionState): Promise<void> {
    const discordThreadId = session.discordThreadId
    const current = this.state.sessions[discordThreadId]
    if (
      current !== session ||
      current.lifecycleIntent?.kind !== 'delete-thread'
    ) return
    const hadQueue = Object.hasOwn(this.state.queues, discordThreadId)
    const previousQueue = this.state.queues[discordThreadId]
    const removedTasks = Object.entries(this.state.tasks)
      .filter(([, task]) => task.threadId === discordThreadId)
    const previousOutbox = this.state.discordOutbox ? [...this.state.discordOutbox] : undefined
    delete this.state.sessions[discordThreadId]
    delete this.state.queues[discordThreadId]
    for (const [taskId] of removedTasks) delete this.state.tasks[taskId]
    if (this.state.discordOutbox) {
      this.state.discordOutbox = this.state.discordOutbox.filter(
        (entry) => entry.discordThreadId !== discordThreadId,
      )
    }
    try {
      await saveState(this.state)
    } catch (error) {
      this.state.sessions[discordThreadId] = session
      if (hadQueue) this.state.queues[discordThreadId] = previousQueue || []
      for (const [taskId, task] of removedTasks) this.state.tasks[taskId] = task
      if (previousOutbox) this.state.discordOutbox = previousOutbox
      throw error
    }

    for (const [taskId] of removedTasks) this.scheduler.cancel(taskId)
    this.loadedThreads.delete(session.codexThreadId)
    const run = this.runs.get(session.codexThreadId)
    if (run) clearInterval(run.typingTimer)
    this.runs.delete(session.codexThreadId)
    this.deletedThreadInterruptedTurns.delete(discordThreadId)
    this.clearQueuedSourceBlock(discordThreadId)
    this.unlinkedCodexSessionChannels.delete(discordThreadId)
    this.clearTitleVerificationState(session.codexThreadId, [discordThreadId])
    this.expectedDiscordTitles.delete(discordThreadId)
    this.recentDiscordTitleEchoes.delete(discordThreadId)
    this.pendingDiscordTitles.delete(discordThreadId)
    this.expectedCodexTitles.delete(session.codexThreadId)
    this.recentCodexTitleEchoes.delete(session.codexThreadId)
    this.pendingCodexTitles.delete(session.codexThreadId)
    this.pendingContextUsage.delete(session.codexThreadId)
    this.contextReplayBlocked.delete(session.codexThreadId)
    this.goalStatusAnnouncements.delete(session.codexThreadId)
  }

  private async reconcileDeletedThreadIntents(
    discordThreadIds?: ReadonlySet<string>,
  ): Promise<void> {
    const pending = Object.values(this.state.sessions).filter(
      (session) =>
        session.lifecycleIntent?.kind === 'delete-thread' &&
        (!discordThreadIds || discordThreadIds.has(session.discordThreadId)),
    )
    if (pending.length === 0) return

    let [activeThreads, archivedThreads] = await Promise.all([
      this.codex.listAllThreads(),
      this.codex.listAllThreads({ archived: true }),
    ])
    const activeIds = new Set(activeThreads.map((thread) => thread.id))
    const archivedIds = new Set(archivedThreads.map((thread) => thread.id))

    for (const pendingSession of pending) {
      await this.codexEventQueue.run(pendingSession.codexThreadId, () =>
        this.promptQueue.run(pendingSession.discordThreadId, async () => {
          const session = this.state.sessions[pendingSession.discordThreadId]
          if (
            !session ||
            session.codexThreadId !== pendingSession.codexThreadId ||
            session.lifecycleIntent?.kind !== 'delete-thread'
          ) return
          let active = activeIds.has(session.codexThreadId)
          let archived = archivedIds.has(session.codexThreadId)
          if (!active && !archived) {
            ;[activeThreads, archivedThreads] = await Promise.all([
              this.codex.listAllThreads(),
              this.codex.listAllThreads({ archived: true }),
            ])
            activeIds.clear()
            archivedIds.clear()
            for (const thread of activeThreads) activeIds.add(thread.id)
            for (const thread of archivedThreads) archivedIds.add(thread.id)
            active = activeIds.has(session.codexThreadId)
            archived = archivedIds.has(session.codexThreadId)
          }

          if (session.lifecycleIntent.remoteAction === 'delete') {
            if (active) {
              if (!session.abortIntent) {
                await this.persistAbortIntent(session, session.activeTurnId)
              }
              const reconciliation = await this.reconcileAbortIntent(session)
              if (!reconciliation.cleared) {
                throw new Error(
                  `Deleted thread abort confirmation pending: ${reconciliation.errors.join('; ') || 'Codex still reports it active'}`,
                )
              }
            }
            if (active || archived) await this.codex.deleteThread(session.codexThreadId)
            activeIds.delete(session.codexThreadId)
            archivedIds.delete(session.codexThreadId)
            await this.finalizeDeletedDiscordThreadWithinPrompt(session)
            return
          }

          if (active) {
            if (!session.abortIntent) {
              await this.persistAbortIntent(session, session.activeTurnId)
            }
            const reconciliation = await this.reconcileAbortIntent(session)
            if (!reconciliation.cleared) {
              throw new Error(
                `Deleted thread abort confirmation pending: ${reconciliation.errors.join('; ') || 'Codex still reports it active'}`,
              )
            }
            await this.codex.archiveThread(session.codexThreadId)
            activeIds.delete(session.codexThreadId)
            archivedIds.add(session.codexThreadId)
          }
          await this.finalizeDeletedDiscordThreadWithinPrompt(session)
        }))
    }
  }

  private async clearSessionLifecycleIntent(
    session: SessionState,
    kind: 'archive' | 'resume',
  ): Promise<void> {
    if (session.lifecycleIntent?.kind !== kind) return
    const previous = structuredClone(session)
    delete session.lifecycleIntent
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
  }

  private async convergeDiscordLifecycleState(
    session: SessionState,
    kind: 'archive' | 'resume',
    archived: boolean,
    reason: string,
    knownChannel?: ThreadChannel,
  ): Promise<boolean> {
    let channel = knownChannel
    if (!channel) {
      try {
        const fetched = await this.client.channels.fetch(session.discordThreadId, { force: true })
        if (fetched?.isThread()) channel = fetched
        else {
          await this.clearSessionLifecycleIntent(session, kind)
          return false
        }
      } catch (error) {
        if (!isUnknownDiscordChannelError(error)) throw error
        await this.clearSessionLifecycleIntent(session, kind)
        return false
      }
    }
    if (channel.archived !== archived) {
      try {
        await channel.setArchived(archived, reason)
      } catch (error) {
        if (!isUnknownDiscordChannelError(error)) throw error
        await this.clearSessionLifecycleIntent(session, kind)
        return false
      }
    }
    await this.clearSessionLifecycleIntent(session, kind)
    return true
  }

  private async finalizeArchivedSession(session: SessionState): Promise<void> {
    const previous = structuredClone(session)
    session.archived = true
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
    this.loadedThreads.delete(session.codexThreadId)
    this.preserveArchivedUntilResume.delete(session.codexThreadId)
    this.clearTitleVerificationState(session.codexThreadId, [session.discordThreadId])
  }

  private async persistedResumeConfiguration(session: SessionState): Promise<{
    model?: string
    effort?: ReasoningEffort
    fastMode?: boolean
    yoloMode: boolean
    options: Parameters<CodexAppServer['resumeThread']>[0]
  }> {
    const model = session.model ||
      this.state.channelModels[session.parentChannelId] ||
      this.config.defaultModel
    const effort = session.effort ||
      this.state.channelEfforts[session.parentChannelId] ||
      this.config.defaultEffort
    const fastMode = session.fastMode ?? this.state.channelFastMode[session.parentChannelId]
    const yoloMode = session.yoloMode ??
      this.state.channelYoloMode[session.parentChannelId] ??
      false
    const serviceTier = await this.serviceTierForFastMode(model, fastMode)
    const runtimeRoots = this.runtimeWorkspaceRoots(session)
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      yoloMode,
      options: {
        threadId: session.codexThreadId,
        includeTurns: true,
        cwd: session.directory,
        ...(model ? { model } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
        ...(!yoloMode && session.permissions
          ? { permissions: session.permissions }
          : { sandbox: yoloMode ? 'danger-full-access' : this.config.sandbox }),
        approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
        ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
      },
    }
  }

  private async finalizeResumedSession(
    session: SessionState,
    resumed: Awaited<ReturnType<CodexAppServer['resumeThread']>>,
    desired: {
      model?: string
      effort?: ReasoningEffort
      fastMode?: boolean
      yoloMode: boolean
    },
  ): Promise<void> {
    if (desired.effort && resumed.effort !== desired.effort) {
      await this.codex.updateThreadSettings({
        threadId: session.codexThreadId,
        effort: desired.effort,
      })
    }
    const previous = structuredClone(session)
    const replayWasBlocked = this.contextReplayBlocked.has(session.codexThreadId)
    const pendingUsage = this.pendingContextUsage.get(session.codexThreadId)
    const resumedModel = resumed.model || desired.model
    const modelTransition = resumedModel !== undefined &&
      session.model !== undefined &&
      resumedModel !== session.model
    const resumedFastMode = resumed.serviceTier !== undefined
      ? await this.fastModeForServiceTier(resumedModel, resumed.serviceTier)
      : desired.fastMode
    if (modelTransition) {
      this.contextReplayBlocked.add(session.codexThreadId)
      this.pendingContextUsage.delete(session.codexThreadId)
    } else {
      this.contextReplayBlocked.delete(session.codexThreadId)
    }
    if (resumedModel) session.model = resumedModel
    const resumedEffort = desired.effort || resumed.effort
    if (resumedEffort) session.effort = resumedEffort
    if (resumedFastMode !== undefined) session.fastMode = resumedFastMode
    session.yoloMode = desired.yoloMode
    delete session.archived
    session.updatedAt = new Date().toISOString()
    if (modelTransition) {
      delete session.contextTokens
      delete session.contextWindow
    } else {
      this.hydratePendingContextUsage(session)
    }
    this.loadedThreads.add(session.codexThreadId)
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      this.loadedThreads.delete(session.codexThreadId)
      if (replayWasBlocked) this.contextReplayBlocked.add(session.codexThreadId)
      else this.contextReplayBlocked.delete(session.codexThreadId)
      if (pendingUsage) this.pendingContextUsage.set(session.codexThreadId, pendingUsage)
      else this.pendingContextUsage.delete(session.codexThreadId)
      throw error
    }
    this.preserveArchivedUntilResume.delete(session.codexThreadId)
  }

  private async reconcileSessionLifecycleIntents(): Promise<void> {
    const pending = Object.values(this.state.sessions).filter(
      (session) => session.lifecycleIntent?.kind === 'archive' ||
        session.lifecycleIntent?.kind === 'resume',
    )
    if (pending.length === 0) return

    const intentKinds = new Map<string, 'archive' | 'resume'>()
    for (const session of pending) {
      const kind = session.lifecycleIntent?.kind
      if (kind !== 'archive' && kind !== 'resume') continue
      const existing = intentKinds.get(session.codexThreadId)
      if (existing && existing !== kind) {
        throw new Error(`Conflicting lifecycle intents for Codex thread ${session.codexThreadId}`)
      }
      intentKinds.set(session.codexThreadId, kind)
    }

    const [activeThreads, archivedThreads] = await Promise.all([
      this.codex.listAllThreads(),
      this.codex.listAllThreads({ archived: true }),
    ])
    const activeIds = new Set(activeThreads.map((thread) => thread.id))
    const archivedIds = new Set(archivedThreads.map((thread) => thread.id))

    for (const pendingSession of pending) {
      let deletedEntries: Array<[string, SessionState]> | undefined
      await this.resumeQueue.run(pendingSession.codexThreadId, async () => {
        await this.codexEventQueue.run(pendingSession.codexThreadId, async () => {
          const session = this.state.sessions[pendingSession.discordThreadId]
          if (!session || session.codexThreadId !== pendingSession.codexThreadId) return
          const kind = session.lifecycleIntent?.kind
          if (kind !== 'archive' && kind !== 'resume') return
          let active = activeIds.has(session.codexThreadId)
          let archived = archivedIds.has(session.codexThreadId)
          if (!active && !archived) {
            const [refreshedActive, refreshedArchived] = await Promise.all([
              this.codex.listAllThreads(),
              this.codex.listAllThreads({ archived: true }),
            ])
            activeIds.clear()
            archivedIds.clear()
            for (const thread of refreshedActive) activeIds.add(thread.id)
            for (const thread of refreshedArchived) archivedIds.add(thread.id)
            active = activeIds.has(session.codexThreadId)
            archived = archivedIds.has(session.codexThreadId)
          }
          if (!active && !archived) {
            const entries = Object.entries(this.state.sessions).filter(
              ([, candidate]) => candidate.codexThreadId === session.codexThreadId,
            )
            for (const [discordThreadId] of entries) {
              this.unlinkedCodexSessionChannels.add(discordThreadId)
            }
            deletedEntries = entries
            return
          }
          // The two listings are not one atomic snapshot. If a delayed RPC
          // completes between them, prefer the state requested by the durable intent.
          if (active && archived) {
            if (kind === 'archive') active = false
            else archived = false
          }

          if (kind === 'archive') {
            if (active) {
              await this.codex.archiveThread(session.codexThreadId)
              this.expectArchiveNotification(session.codexThreadId, 'archived')
              activeIds.delete(session.codexThreadId)
              archivedIds.add(session.codexThreadId)
            }
            await this.finalizeArchivedSession(session)
            await this.convergeDiscordLifecycleState(
              session,
              'archive',
              true,
              'Recovered pending Cordex archive',
            )
            return
          }

          this.preserveArchivedUntilResume.add(session.codexThreadId)
          if (archived) {
            await this.codex.unarchiveThread(session.codexThreadId)
            this.expectArchiveNotification(session.codexThreadId, 'unarchived')
            archivedIds.delete(session.codexThreadId)
            activeIds.add(session.codexThreadId)
          }
          const configuration = await this.persistedResumeConfiguration(session)
          const resumed = await this.codex.resumeThread(configuration.options)
          await this.finalizeResumedSession(session, resumed, configuration)
          await this.convergeDiscordLifecycleState(
            session,
            'resume',
            false,
            'Recovered pending Cordex resume',
          )
        })
      })
      if (deletedEntries) {
        await this.cleanupDeletedCodexThread(
          pendingSession.codexThreadId,
          deletedEntries,
        )
      }
    }
  }

  private async finalizeWorktreeRemoval(
    session: SessionState,
    worktree: NonNullable<SessionState['worktree']>,
  ): Promise<void> {
    const previous = structuredClone(session)
    const removedDirectory = path.resolve(worktree.directory)
    session.directory = path.resolve(worktree.projectDirectory)
    if (session.workspaceRoots) {
      session.workspaceRoots = session.workspaceRoots.filter(
        (root) => !pathIsWithinOrEqual(removedDirectory, root),
      )
      if (session.workspaceRoots.length === 0) delete session.workspaceRoots
    }
    delete session.worktree
    if (session.lifecycleIntent?.kind === 'remove-worktree') delete session.lifecycleIntent
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      throw error
    }
    this.loadedThreads.delete(session.codexThreadId)
  }

  private async reconcileWorktreeRemovalIntents(): Promise<void> {
    const pending = Object.values(this.state.sessions).filter(
      (session) => session.lifecycleIntent?.kind === 'remove-worktree',
    )
    for (const pendingSession of pending) {
      await this.projectMutationQueue.run(
        `channel:${pendingSession.parentChannelId}`,
        async () => {
          const session = this.state.sessions[pendingSession.discordThreadId]
          if (
            !session ||
            session.codexThreadId !== pendingSession.codexThreadId ||
            session.lifecycleIntent?.kind !== 'remove-worktree'
          ) return
          const worktree = session.worktree
          if (!worktree) {
            throw new Error(
              `Cannot reconcile worktree removal for ${session.codexThreadId}: metadata is missing`,
            )
          }
          await removeMergedWorktree({
            projectDirectory: worktree.projectDirectory,
            worktreeDirectory: worktree.directory,
            branch: worktree.branch,
          })
          await this.finalizeWorktreeRemoval(session, worktree)
        },
      )
    }
  }

  private async completePendingWorktreeRemovalBeforeSessionDrop(
    session: SessionState,
  ): Promise<void> {
    if (session.lifecycleIntent?.kind !== 'remove-worktree') return
    const worktree = session.worktree
    if (!worktree) {
      throw new Error(
        `Cannot finish worktree removal for ${session.codexThreadId}: metadata is missing`,
      )
    }
    await removeMergedWorktree({
      projectDirectory: worktree.projectDirectory,
      worktreeDirectory: worktree.directory,
      branch: worktree.branch,
    })
  }

  async start(): Promise<void> {
    this.assertNotStopping()
    if (this.stopPromise) throw new CordexStoppingError()
    this.eventLoopDelay.enable()
    this.logger.info('startup_start', {
      guildId: this.config.guildId,
      projectCount: Object.keys(this.config.projects).length,
      sessionCount: Object.keys(this.state.sessions).length,
      queuedPromptCount: Object.values(this.state.queues).reduce(
        (count, queue) => count + queue.length,
        0,
      ),
    })
    this.beginIngressBarrier()
    let started = false
    try {
      await this.pruneAttachmentCache().catch((error: unknown) => {
        console.error(`Failed to prune Discord attachment cache: ${errorText(error)}`)
      })
      await this.pruneOutgoingMediaCache().catch((error: unknown) => {
        this.logVerbose('generated-image cache startup prune failed', { error: errorText(error) })
      })
      this.assertNotStopping()
      await this.registerCommands()
      this.assertNotStopping()
      await this.client.login(this.config.token)
      this.assertNotStopping()
      await this.reconcileDeletedThreadIntents()
      this.assertNotStopping()
      await this.reconcileSessionLifecycleIntents()
      this.assertNotStopping()
      await this.reconcileAbortIntents()
      this.assertNotStopping()
      await this.reconcileWorktreeRemovalIntents()
      this.assertNotStopping()
      try {
        await withManagementLock(async () => {
          this.assertNotStopping()
          await this.refreshProjectsFromDisk()
          this.assertNotStopping()
          await this.pruneDeletedProjectMappings()
          this.assertNotStopping()
          await this.pruneOrphanedState()
          this.assertNotStopping()
          const guild = await this.client.guilds.fetch(this.config.guildId)
          this.assertNotStopping()
          const root = await ensureRootChannel({
            guild,
            config: this.config,
            ...(this.state.rootChannelTombstones?.[guild.id]
              ? { tombstone: this.state.rootChannelTombstones[guild.id] }
              : {}),
            ...(this.client.user?.username ? { botName: this.client.user.username } : {}),
          })
          this.assertNotStopping()
          try {
            await saveManagedConfig(this.config)
            this.assertNotStopping()
          } catch (error) {
            if (root?.created) {
              delete this.config.projects[root.textChannel.id]
              await root.textChannel.delete('Cordex root mapping could not be saved').catch(() => undefined)
            }
            throw error
          }
          if (root?.created) {
            await this.sendRootWelcome(root.textChannel).catch((error: unknown) => {
              console.error(`Failed to send Cordex root welcome: ${errorText(error)}`)
            })
          }
        })
      } catch (error) {
        if (error instanceof CordexStoppingError) throw error
        throw new Error(`Cordex channel setup failed: ${errorText(error)}`, { cause: error })
      }
      this.assertNotStopping()
      await this.recoverDiscordOutbox()
      this.scheduleDiscordOutboxRetry()
      await this.announceInterruptedStartupSessions()
      this.assertNotStopping()
      await this.reconcilePersistedQueuedSources()
      this.assertNotStopping()
      await this.reconcileSessionTitles()
      this.assertNotStopping()
      await this.recoverPendingInitialSessions()
      this.assertNotStopping()
      await this.recoverPersistedPromptQueues()
      this.assertNotStopping()
      this.scheduler.start()
      started = true
      this.logger.info('startup_complete', {
        projectCount: Object.keys(this.config.projects).length,
        sessionCount: Object.keys(this.state.sessions).length,
      })
    } catch (error) {
      this.logger.error('startup_failed', error)
      throw error
    } finally {
      if (!started) {
        this.eventLoopDelay.disable()
        this.stopping = true
        this.clearAllQueuedSourceRetries()
      }
      this.finishIngressBarrier()
    }
  }

  private async recoverPersistedPromptQueues(): Promise<void> {
    for (const session of Object.values(this.state.sessions)) {
      if (session.archived || (this.state.queues[session.discordThreadId]?.length || 0) === 0) {
        continue
      }
      const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) continue
      await this.recoverPersistedPrompts(session, channel).catch((error: unknown) => {
        this.logVerbose('persisted prompt startup recovery failed', {
          threadId: session.codexThreadId,
          error: errorText(error),
        })
      })
    }
  }

  private async recoverPendingInitialSessions(): Promise<void> {
    for (const [threadId, pending] of Object.entries(this.state.pendingInitialSessions || {})) {
      if (this.state.sessions[threadId]) continue
      if (!this.queueFor(threadId).length) continue
      if (pending.abortIntent) {
        await this.reconcilePendingInitialAbort(threadId, pending).catch((error: unknown) => {
          this.logVerbose('pending initial-session abort recovery failed', {
            discordThreadId: threadId,
            error: errorText(error),
          })
        })
      }
      const channel = await this.client.channels.fetch(threadId).catch(() => undefined)
      if (!channel?.isThread() || channel.guildId !== this.config.guildId ||
        channel.parentId !== pending.parentChannelId) continue
      await this.holdPendingInitialPrompt(channel, pending)
    }
  }

  private async updateDiscordOutbox(
    update: (
      outbox: NonNullable<CordexState['discordOutbox']>,
      deliveredKeys: NonNullable<CordexState['discordOutboxDeliveredKeys']>,
    ) => boolean,
  ): Promise<boolean> {
    return this.discordOutboxStateQueue.run('state', async () => {
      const { outbox, deliveredKeys } = ensureDiscordOutboxState(this.state)
      const previousOutbox = [...outbox]
      const previousDeliveredKeys = [...deliveredKeys]
      if (!update(outbox, deliveredKeys)) return false
      try {
        await saveState(this.state)
      } catch (error) {
        outbox.splice(0, outbox.length, ...previousOutbox)
        deliveredKeys.splice(0, deliveredKeys.length, ...previousDeliveredKeys)
        throw error
      }
      return true
    })
  }

  private async persistDiscordOutput(entries: ReturnType<typeof createDiscordOutboxEntries>): Promise<void> {
    const firstEntry = entries[0]
    const outputKey = firstEntry ? discordOutboxOutputKey(firstEntry) : undefined
    if (!firstEntry || !outputKey) return
    await this.updateDiscordOutbox((outbox, deliveredKeys) => {
      const session = this.state.sessions[firstEntry.discordThreadId]
      const pendingInitial = this.state.pendingInitialSessions?.[firstEntry.discordThreadId]
      const pendingNotice = pendingInitial &&
        firstEntry.codexThreadId === `pending-session:${firstEntry.discordThreadId}`
      if (!pendingNotice && (
        !session ||
        session.codexThreadId !== firstEntry.codexThreadId ||
        session.lifecycleIntent?.kind === 'delete-thread'
      )) return false
      const pending = new Set(outbox.map((entry) => entry.key))
      const delivered = new Set(deliveredKeys)
      if (
        delivered.has(outputKey) ||
        outbox.some((entry) => discordOutboxOutputKey(entry) === outputKey)
      ) return false
      let changed = false
      // On reconnect, only the latest pending progress is useful. Real output
      // supersedes every undelivered progress notice for this turn.
      for (let index = outbox.length - 1; index >= 0; index--) {
        const entry = outbox[index]
        if (
          entry?.discordThreadId === firstEntry.discordThreadId &&
          entry.codexThreadId === firstEntry.codexThreadId &&
          entry.turnId === firstEntry.turnId &&
          entry.itemKey.startsWith('progress:')
        ) {
          outbox.splice(index, 1)
          changed = true
        }
      }
      for (const entry of entries) {
        if (pending.has(entry.key) || delivered.has(entry.key)) continue
        outbox.push(entry)
        pending.add(entry.key)
        changed = true
      }
      return changed
    })
  }

  private async acknowledgeDiscordOutput(key: string): Promise<void> {
    await this.updateDiscordOutbox((outbox, deliveredKeys) => {
      const index = outbox.findIndex((entry) => entry.key === key)
      if (index < 0) return false
      const entry = outbox[index]
      if (!entry) return false
      const outputKey = discordOutboxOutputKey(entry)
      outbox.splice(index, 1)
      rememberDiscordOutboxDeliveredKey(deliveredKeys, key)
      if (!outbox.some((candidate) => discordOutboxOutputKey(candidate) === outputKey)) {
        rememberDiscordOutboxDeliveredKey(deliveredKeys, outputKey)
      }
      return true
    })
  }

  private recordVisibleDiscordOutput(
    identity: {
      discordThreadId: string
      codexThreadId: string
      turnId: string
    },
    message: { createdTimestamp?: number },
  ): void {
    const run = this.runs.get(identity.codexThreadId)
    if (!run || run.channel.id !== identity.discordThreadId ||
      this.durableTurnId(run, {}) !== identity.turnId) return
    const now = Date.now()
    // A nonce retry can return an already-created message. Its original date
    // must not make old output look freshly visible. Count the send even when
    // the following durable acknowledgment fails.
    const createdAt = typeof message.createdTimestamp === 'number' &&
      Number.isFinite(message.createdTimestamp) && message.createdTimestamp > 0
      ? Math.min(message.createdTimestamp, now)
      : now
    run.lastVisibleOutputAt = Math.max(run.lastVisibleOutputAt ?? 0, createdAt)
  }

  private async drainDiscordOutbox(channel: ThreadChannel): Promise<void> {
    try {
      await this.discordOutboxDeliveryQueue.run(channel.id, async () => {
        while (true) {
          const entry = this.state.discordOutbox?.find(
            (candidate) => candidate.discordThreadId === channel.id,
          )
          if (!entry) return
          let files: Array<{ attachment: Buffer; name: string }> | undefined
          let attachmentUnavailable = false
          if (entry.attachment) {
            try {
              files = [{
                attachment: await readCachedGeneratedImage(this.outgoingMediaDirectory, entry.attachment),
                name: generatedImageFileName(entry.attachment),
              }]
            } catch (error) {
              attachmentUnavailable = true
              this.logVerbose('generated-image cache unavailable for Discord delivery', {
                threadId: entry.codexThreadId,
                error: errorText(error),
              })
            }
          } else if (entry.fileAttachments) {
            try {
              files = await Promise.all(entry.fileAttachments.map(async (attachment) => ({
                attachment: await readCachedOutgoingFile(this.outgoingFileDirectory, attachment),
                name: attachment.name,
              })))
            } catch (error) {
              attachmentUnavailable = true
              this.logVerbose('outgoing-file cache unavailable for Discord delivery', {
                threadId: entry.codexThreadId,
                error: errorText(error),
              })
            }
          }
          const unavailableNotice = entry.fileAttachments
            ? '\n⚠ Files could not be attached; rerun the explicit upload command.'
            : '\n⚠ Generated image could not be attached; ask Codex for its saved project path.'
          const sendOptions: MessageCreateOptions = {
            content: attachmentUnavailable ? `${entry.content}${unavailableNotice}` : entry.content,
            allowedMentions: { parse: [] },
            ...(entry.suppressNotifications
              ? { flags: MessageFlags.SuppressNotifications }
              : {}),
            nonce: entry.nonce,
            enforceNonce: true,
            ...(files && !attachmentUnavailable ? { files } : {}),
          }
          let deliveredMessage: DiscordMessage
          try {
            deliveredMessage = await channel.send(sendOptions)
          } catch (error) {
            const rejection = files?.length ? discordUploadRejection(error) : undefined
            if (!rejection) throw error
            const notice = rejection === 'too-large'
              ? entry.fileAttachments
                ? 'Files exceed this Discord channel\'s upload limit; rerun with smaller files.'
                : 'Generated image exceeds this Discord channel\'s upload limit; ask Codex for its saved project path.'
              : entry.fileAttachments
                ? 'Discord rejected one or more file attachments; check file types and names, then rerun the upload.'
                : 'Discord rejected the generated image attachment; ask Codex for its saved project path.'
            deliveredMessage = await channel.send({
              ...sendOptions,
              content: `${entry.content}\n⚠ ${notice}`,
              files: [],
            })
          }
          this.recordVisibleDiscordOutput(entry, deliveredMessage)
          await this.acknowledgeDiscordOutput(entry.key)
          await this.pruneOutgoingMediaCache().catch((error: unknown) => {
            this.logVerbose('generated-image cache cleanup deferred', { error: errorText(error) })
          })
        }
      })
    } catch (error) {
      this.scheduleDiscordOutboxRetry()
      throw error
    }
    if (!this.state.discordOutbox?.length) {
      this.discordOutboxRetryDelayMs = 5_000
      if (this.discordOutboxRetryTimer) clearTimeout(this.discordOutboxRetryTimer)
      delete this.discordOutboxRetryTimer
    }
  }

  private scheduleDiscordOutboxRetry(immediate = false): void {
    if (this.stopping || !this.state.discordOutbox?.length) return
    if (immediate && this.discordOutboxRetryTimer) {
      clearTimeout(this.discordOutboxRetryTimer)
      delete this.discordOutboxRetryTimer
    }
    if (this.discordOutboxRetryTimer) return
    this.discordOutboxRetryTimer = setTimeout(() => {
      delete this.discordOutboxRetryTimer
      this.trackBackgroundWork(this.retryDiscordOutbox(), 'Discord outbox retry')
    }, immediate ? 0 : this.discordOutboxRetryDelayMs)
    this.discordOutboxRetryTimer.unref()
  }

  private async retryDiscordOutbox(): Promise<void> {
    if (this.stopping || this.discordOutboxRetryInFlight) return
    this.discordOutboxRetryInFlight = true
    try {
      await this.recoverDiscordOutbox()
    } finally {
      this.discordOutboxRetryInFlight = false
      if (this.state.discordOutbox?.length) {
        this.discordOutboxRetryDelayMs = Math.min(this.discordOutboxRetryDelayMs * 2, 120_000)
        this.scheduleDiscordOutboxRetry()
      } else this.discordOutboxRetryDelayMs = 5_000
    }
  }

  private async stageDurableDiscordOutput(options: {
    channel: { id: string }
    codexThreadId: string
    turnId: string
    itemKey: string
    value: string
    suppressNotifications: boolean
    format?: boolean
    attachment?: GeneratedImageAttachment
    fileAttachments?: OutgoingFileAttachment[]
  }): Promise<void> {
    const rendered = options.format === false ? options.value : formatAssistantText(options.value)
    const chunks = splitMarkdownForDiscord(rendered, 1_900)
    await this.persistDiscordOutput(createDiscordOutboxEntries({
      discordThreadId: options.channel.id,
      codexThreadId: options.codexThreadId,
      turnId: options.turnId,
      itemKey: options.itemKey,
      chunks,
      suppressNotifications: options.suppressNotifications,
      ...(options.attachment ? { attachment: options.attachment } : {}),
      ...(options.fileAttachments ? { fileAttachments: options.fileAttachments } : {}),
    }))
  }

  private async queueRuntimeNotice(options: {
    discordThreadId: string
    codexThreadId: string
    turnId: string
    itemKey: string
    value: string
  }): Promise<void> {
    await this.stageDurableDiscordOutput({
      channel: { id: options.discordThreadId },
      codexThreadId: options.codexThreadId,
      turnId: options.turnId,
      itemKey: options.itemKey,
      value: options.value,
      suppressNotifications: false,
      format: false,
    })
    this.scheduleDiscordOutboxRetry(true)
  }

  private async sendDurableDiscordOutput(options: {
    channel: ThreadChannel
    codexThreadId: string
    turnId: string
    itemKey: string
    value: string
    suppressNotifications: boolean
    format?: boolean
  }): Promise<void> {
    await this.stageDurableDiscordOutput(options)
    await this.drainDiscordOutbox(options.channel)
  }

  private async recoverDiscordOutbox(): Promise<void> {
    const threadIds = [...new Set(
      (this.state.discordOutbox || []).map((entry) => entry.discordThreadId),
    )]
    for (const discordThreadId of threadIds) {
      const channel = await this.client.channels.fetch(discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) continue
      await this.drainDiscordOutbox(channel).catch((error: unknown) => {
        this.logVerbose('Discord outbox recovery failed', {
          discordThreadId,
          error: errorText(error),
        })
      })
    }
  }

  private async announceInterruptedStartupSessions(): Promise<void> {
    for (const interrupted of this.options.interruptedOnStartup || []) {
      const session = this.state.sessions[interrupted.discordThreadId]
      if (
        !session ||
        session.codexThreadId !== interrupted.codexThreadId ||
        session.archived
      ) continue
      const savedPromptCount = this.state.queues[interrupted.discordThreadId]?.length || 0
      const uncertainPrompt = this.state.queues[interrupted.discordThreadId]?.some(
        (prompt) => prompt.reviewRequired,
      ) || false
      const goal = await this.pauseActiveGoal(session)
      const prefix = '⚠ Cordex restarted while this Codex turn was recorded as active.'
      let value = uncertainPrompt
        ? `${prefix} A saved prompt needs delivery review; Cordex will not retry it automatically. Use /pending-prompts to inspect it.`
        : savedPromptCount > 0
        ? `${prefix} ${savedPromptCount} saved prompt${savedPromptCount === 1 ? '' : 's'} ${savedPromptCount === 1 ? 'is' : 'are'} being reconciled; any not already accepted may run automatically. Watch this thread and check /status before sending more work.`
        : `${prefix} Check the latest output, then send a new message to continue.`
      if (goal.paused) {
        value = uncertainPrompt || savedPromptCount > 0
          ? `${value} The active persistent goal was also paused; resolve saved prompts before resuming it with /goal status:active.`
          : `${prefix} The active persistent goal was paused after the interruption. Check the latest output, then use /goal status:active to resume it.`
      } else if (!goal.safe) {
        value = `${value} Cordex could not verify whether an active persistent goal was paused. Use /goal to inspect it before continuing.`
      }
      await this.queueRuntimeNotice({
        discordThreadId: interrupted.discordThreadId,
        codexThreadId: interrupted.codexThreadId,
        turnId: interrupted.turnId,
        itemKey: 'startup-interrupted',
        value,
      }).catch((error: unknown) => {
        this.logger.error('runtime_notice_failed', error, {
          channelId: interrupted.discordThreadId,
          phase: 'startup',
        })
      })
    }
  }

  private clearQueuedSourceBlock(threadId: string): void {
    this.blockedQueuedSourceThreads.delete(threadId)
    this.queuedSourceRetryAttempts.delete(threadId)
    const timer = this.queuedSourceRetryTimers.get(threadId)
    if (timer) clearTimeout(timer)
    this.queuedSourceRetryTimers.delete(threadId)
  }

  private clearAllQueuedSourceRetries(): void {
    for (const timer of this.queuedSourceRetryTimers.values()) clearTimeout(timer)
    this.queuedSourceRetryTimers.clear()
    this.queuedSourceRetryAttempts.clear()
    this.blockedQueuedSourceThreads.clear()
  }

  private markQueuedSourceBlocked(threadId: string): void {
    this.blockedQueuedSourceThreads.add(threadId)
    this.scheduleQueuedSourceRetry(threadId)
  }

  private scheduleQueuedSourceRetry(threadId: string): void {
    const session = this.state.sessions[threadId]
    if (
      this.stopping ||
      this.queuedSourceRetryTimers.has(threadId) ||
      !this.blockedQueuedSourceThreads.has(threadId) ||
      !session ||
      session.archived ||
      this.deletedDiscordThreads.has(threadId)
    ) return
    const attempt = this.queuedSourceRetryAttempts.get(threadId) || 0
    const delayMs = Math.min(queuedSourceRetryMaxDelayMs, 1_000 * 2 ** Math.min(attempt, 6))
    this.queuedSourceRetryAttempts.set(threadId, attempt + 1)
    const timer = setTimeout(() => {
      this.queuedSourceRetryTimers.delete(threadId)
      if (this.stopping) return
      this.trackBackgroundWork(
        this.retryBlockedQueuedSourceThread(threadId).catch((error: unknown) => {
          this.logVerbose('queued source retry failed', {
            discordThreadId: threadId,
            error: errorText(error),
          })
        }).finally(() => {
          if (this.blockedQueuedSourceThreads.has(threadId)) {
            this.scheduleQueuedSourceRetry(threadId)
          }
        }),
        'queued Discord source retry',
      )
    }, delayMs)
    timer.unref()
    this.queuedSourceRetryTimers.set(threadId, timer)
  }

  private async retryBlockedQueuedSourceThread(threadId: string): Promise<void> {
    if (this.stopping || !this.blockedQueuedSourceThreads.has(threadId)) return
    const session = this.state.sessions[threadId]
    if (!session || this.deletedDiscordThreads.has(threadId)) {
      this.clearQueuedSourceBlock(threadId)
      return
    }
    if (session.archived) return
    let channel: ThreadChannel | undefined
    try {
      const fetched = await this.client.channels.fetch(threadId, { force: true })
      if (fetched?.isThread()) channel = fetched
    } catch (error) {
      if (isUnknownDiscordChannelError(error)) {
        this.clearQueuedSourceBlock(threadId)
        return
      }
      this.markQueuedSourceBlocked(threadId)
      this.logVerbose('queued source channel retry failed', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
      return
    }
    if (!channel) {
      this.markQueuedSourceBlocked(threadId)
      this.logVerbose('queued source channel retry returned no thread', {
        threadId: session.codexThreadId,
      })
      return
    }
    await this.promptQueue.run(threadId, () =>
      this.reconcilePersistedQueuedSourcesUnlocked(session, channel))
    if (this.blockedQueuedSourceThreads.has(threadId)) return
    await this.recoverPersistedPrompts(session, channel)
  }

  private async reconcilePersistedQueuedSourcesUnlocked(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    const current = this.state.sessions[channel.id]
    if (current?.codexThreadId !== session.codexThreadId) {
      this.clearQueuedSourceBlock(channel.id)
      return
    }
    const queue = this.queueFor(channel.id)
    const originalQueue = [...queue]
    let changed = false
    let blocked = false
    for (const prompt of [...queue]) {
      if (
        this.promptDeliveryKind(prompt) !== 'queued' ||
        !prompt.sourceMessageId
      ) continue
      let message: DiscordMessage
      try {
        message = await channel.messages.fetch(prompt.sourceMessageId)
      } catch (error) {
        if (isUnknownDiscordMessageError(error)) {
          const index = queue.indexOf(prompt)
          if (index >= 0) queue.splice(index, 1)
          changed = true
        } else {
          blocked = true
          this.logVerbose('queued source message reconciliation failed', {
            threadId: session.codexThreadId,
            messageId: prompt.sourceMessageId,
            error: errorText(error),
          })
        }
        continue
      }
      const parsed = parseQueueMessage(message.content)
      if (!parsed.queued) {
        const index = queue.indexOf(prompt)
        if (index >= 0) queue.splice(index, 1)
        changed = true
        continue
      }
      let input: UserInput[]
      try {
        const built = await this.buildInput(message, parsed.text)
        const retryableFeedback = built.feedback.filter((item) =>
          item.retryable === true ||
          item.code === 'attachment-download-failed' ||
          item.code === 'attachment-storage-failed' ||
          item.code === 'image-storage-failed')
        if (retryableFeedback.length > 0) {
          throw new Error(
            retryableFeedback.map((item) => item.message).join(' '),
          )
        }
        if (built.input.length === 0) {
          const index = queue.indexOf(prompt)
          if (index >= 0) queue.splice(index, 1)
          changed = true
          continue
        }
        input = built.input
      } catch (error) {
        blocked = true
        this.logVerbose('queued source input rebuild failed', {
          threadId: session.codexThreadId,
          messageId: prompt.sourceMessageId,
          error: errorText(error),
        })
        continue
      }
      const index = queue.indexOf(prompt)
      if (index < 0) continue
      queue[index] = {
        ...prompt,
        input: [
          ...prompt.input.filter((item) => item.type === 'skill'),
          ...input,
        ],
        displayText: parsed.text || '(attachment)',
        deliveryKind: 'queued',
      }
      changed = true
    }
    if (changed) {
      try {
        await saveState(this.state)
      } catch (error) {
        queue.splice(0, queue.length, ...originalQueue)
        this.markQueuedSourceBlocked(channel.id)
        await this.pruneAttachmentCache().catch(() => undefined)
        throw error
      }
    }
    if (blocked) this.markQueuedSourceBlocked(channel.id)
    else this.clearQueuedSourceBlock(channel.id)
  }

  private async reconcilePersistedQueuedSources(): Promise<void> {
    for (const session of Object.values(this.state.sessions)) {
      const queue = this.state.queues[session.discordThreadId]
      if (!queue?.some((prompt) =>
        this.promptDeliveryKind(prompt) === 'queued' && prompt.sourceMessageId)) continue
      let channel: ThreadChannel | undefined
      try {
        const fetched = await this.client.channels.fetch(session.discordThreadId, { force: true })
        if (fetched?.isThread()) channel = fetched
      } catch (error) {
        if (isUnknownDiscordChannelError(error)) continue
        this.markQueuedSourceBlocked(session.discordThreadId)
        this.logVerbose('queued source channel reconciliation failed', {
          threadId: session.codexThreadId,
          error: errorText(error),
        })
        continue
      }
      if (!channel) {
        this.markQueuedSourceBlocked(session.discordThreadId)
        this.logVerbose('queued source channel is unavailable during reconciliation', {
          threadId: session.codexThreadId,
        })
        continue
      }
      await this.promptQueue.run(channel.id, () =>
        this.reconcilePersistedQueuedSourcesUnlocked(session, channel))
    }
    await this.pruneAttachmentCache().catch((error: unknown) => {
      this.logVerbose('attachment cache prune after queued source reconciliation failed', {
        error: errorText(error),
      })
    })
  }

  private async reconcileSessionTitles(expectedGeneration?: number): Promise<void> {
    for (const session of Object.values(this.state.sessions)) {
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== this.codexLifecycleGeneration()
      ) return
      if (session.archived) continue
      await this.retryPendingSessionTitle(session)
      if (
        this.pendingDiscordTitleVerifications.has(session.discordThreadId) ||
        this.pendingCodexTitleVerifications.has(session.codexThreadId)
      ) continue
      const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) continue
      const title = this.pendingDiscordTitles.get(session.discordThreadId) ||
        this.pendingCodexTitles.get(session.codexThreadId) ||
        channel.name
      await this.synchronizeThreadTitle(session, channel, title)
        .catch((error: unknown) => {
          this.logVerbose('session title reconciliation failed', {
            threadId: session.codexThreadId,
            error: errorText(error),
          })
        })
    }
  }

  private clearTitleVerificationRetry(threadId: string, resetAttempts = true): void {
    const timer = this.titleVerificationRetryTimers.get(threadId)
    if (timer) clearTimeout(timer)
    this.titleVerificationRetryTimers.delete(threadId)
    if (resetAttempts) this.titleVerificationRetryAttempts.delete(threadId)
  }

  private clearTitleVerificationState(
    threadId: string,
    discordThreadIds: Iterable<string> = [],
  ): void {
    this.clearTitleVerificationRetry(threadId)
    this.pendingCodexTitleVerifications.delete(threadId)
    this.pendingTitleVerificationSources.delete(threadId)
    for (const discordThreadId of discordThreadIds) {
      this.pendingDiscordTitleVerifications.delete(discordThreadId)
    }
  }

  private deferDiscordTitleVerification(session: SessionState, title: string): void {
    const previous = this.pendingDiscordTitleVerifications.get(session.discordThreadId)
    this.pendingDiscordTitleVerifications.set(session.discordThreadId, title)
    if (previous !== title || !this.pendingTitleVerificationSources.has(session.codexThreadId)) {
      this.pendingTitleVerificationSources.set(session.codexThreadId, 'discord')
    }
    this.rememberTitleEcho(
      this.recentDiscordTitleEchoes,
      session.discordThreadId,
      title,
    )
    this.scheduleTitleVerificationRetry(session)
  }

  private deferCodexTitleVerification(session: SessionState, title: string): void {
    const previous = this.pendingCodexTitleVerifications.get(session.codexThreadId)
    this.pendingCodexTitleVerifications.set(session.codexThreadId, title)
    if (previous !== title || !this.pendingTitleVerificationSources.has(session.codexThreadId)) {
      this.pendingTitleVerificationSources.set(session.codexThreadId, 'codex')
    }
    this.rememberTitleEcho(
      this.recentCodexTitleEchoes,
      session.codexThreadId,
      title,
    )
    this.scheduleTitleVerificationRetry(session)
  }

  private scheduleTitleVerificationRetry(session: SessionState): void {
    const threadId = session.codexThreadId
    if (this.stopping) return
    if (this.titleVerificationRetryTimers.has(threadId)) return
    const attempt = this.titleVerificationRetryAttempts.get(threadId) || 0
    const delayMs = Math.min(500 * (2 ** Math.min(attempt, 6)), 30_000)
    this.titleVerificationRetryAttempts.set(threadId, Math.min(attempt + 1, 6))
    const timer = setTimeout(() => {
      this.titleVerificationRetryTimers.delete(threadId)
      if (this.stopping) return
      const current = this.state.sessions[session.discordThreadId]
      if (
        current?.codexThreadId !== threadId ||
        (current.archived && !this.archivingDiscordThreads.has(session.discordThreadId)) ||
        this.deletedDiscordThreads.has(session.discordThreadId)
      ) {
        this.clearTitleVerificationState(threadId, [session.discordThreadId])
        return
      }
      if (this.archivingDiscordThreads.has(session.discordThreadId)) {
        this.scheduleTitleVerificationRetry(current)
        return
      }
      this.trackBackgroundWork(
        this.retryPendingSessionTitle(current).catch((error: unknown) => {
          this.logVerbose('deferred title verification failed', {
            threadId,
            error: errorText(error),
          })
        }),
        'deferred title verification',
      )
    }, delayMs)
    timer.unref()
    this.titleVerificationRetryTimers.set(threadId, timer)
  }

  private finishTitleVerificationAttempt(session: SessionState): void {
    if (this.stopping) return
    if (
      this.pendingDiscordTitleVerifications.has(session.discordThreadId) ||
      this.pendingCodexTitleVerifications.has(session.codexThreadId)
    ) {
      this.scheduleTitleVerificationRetry(session)
      return
    }
    this.clearTitleVerificationRetry(session.codexThreadId)
  }

  private async retryPendingSessionTitle(session: SessionState): Promise<void> {
    if (this.stopping) return
    this.clearTitleVerificationRetry(session.codexThreadId, false)
    await this.titleQueue.run(session.codexThreadId, async () => {
      let current = this.state.sessions[session.discordThreadId]
      if (
        current?.codexThreadId !== session.codexThreadId ||
        current.archived ||
        this.archivingDiscordThreads.has(session.discordThreadId) ||
        this.deletedDiscordThreads.has(session.discordThreadId)
      ) {
        if (this.archivingDiscordThreads.has(session.discordThreadId)) return
        this.clearTitleVerificationState(session.codexThreadId, [session.discordThreadId])
        return
      }

      const fetchThreadChannel = async (): Promise<ThreadChannel | undefined> => {
        const fetched = await this.client.channels.fetch(session.discordThreadId)
          .catch(() => undefined)
        return fetched?.isThread() ? fetched : undefined
      }
      const discordCandidate = this.pendingDiscordTitleVerifications.get(current.discordThreadId)
      const codexCandidate = this.pendingCodexTitleVerifications.get(current.codexThreadId)
      const recordedSource = this.pendingTitleVerificationSources.get(current.codexThreadId)
      const preferredSource = discordCandidate !== undefined && codexCandidate !== undefined
        ? recordedSource || 'codex'
        : discordCandidate !== undefined
          ? 'discord'
          : codexCandidate !== undefined
            ? 'codex'
            : undefined
      let authoritativeDiscord: ThreadChannel | undefined
      let authoritativeCodex: Awaited<ReturnType<CodexAppServer['getThreadSummary']>> | undefined

      if (preferredSource === 'discord' && discordCandidate !== undefined) {
        const fetched = await this.client.channels.fetch(session.discordThreadId, { force: true })
          .catch(() => undefined)
        authoritativeDiscord = fetched?.isThread() ? fetched : undefined
        if (!authoritativeDiscord?.isThread()) {
          this.rememberTitleEcho(
            this.recentDiscordTitleEchoes,
            current.discordThreadId,
            discordCandidate,
          )
          return
        }
      }

      if (preferredSource === 'codex' && codexCandidate !== undefined) {
        authoritativeCodex = await this.codex.getThreadSummary(current.codexThreadId)
          .catch(() => undefined)
        if (authoritativeCodex?.name === undefined) {
          this.rememberTitleEcho(
            this.recentCodexTitleEchoes,
            current.codexThreadId,
            codexCandidate,
          )
          return
        }
      }

      current = this.state.sessions[session.discordThreadId]
      if (
        !current ||
        current.codexThreadId !== session.codexThreadId ||
        current.archived ||
        this.archivingDiscordThreads.has(session.discordThreadId) ||
        this.deletedDiscordThreads.has(session.discordThreadId)
      ) return
      if (
        (discordCandidate !== undefined &&
          this.pendingDiscordTitleVerifications.get(current.discordThreadId) !== discordCandidate) ||
        (codexCandidate !== undefined &&
          this.pendingCodexTitleVerifications.get(current.codexThreadId) !== codexCandidate)
      ) return

      let channel = authoritativeDiscord
      if (!channel && (preferredSource === 'codex' || this.pendingDiscordTitles.has(current.discordThreadId) || this.pendingCodexTitles.has(current.codexThreadId))) {
        channel = await fetchThreadChannel()
      }

      const title = preferredSource === 'discord' && authoritativeDiscord
        ? normalizeThreadTitle(authoritativeDiscord.name)
        : preferredSource === 'codex' && authoritativeCodex?.name !== undefined
          ? normalizeThreadTitle(authoritativeCodex.name)
          : undefined

      if (title !== undefined && (discordCandidate !== undefined || codexCandidate !== undefined)) {
        if (!channel) return
        const latest = this.state.sessions[session.discordThreadId]
        if (
          latest?.codexThreadId !== session.codexThreadId ||
          latest.archived ||
          this.archivingDiscordThreads.has(session.discordThreadId) ||
          this.deletedDiscordThreads.has(session.discordThreadId) ||
          (discordCandidate !== undefined &&
            this.pendingDiscordTitleVerifications.get(latest.discordThreadId) !== discordCandidate) ||
          (codexCandidate !== undefined &&
            this.pendingCodexTitleVerifications.get(latest.codexThreadId) !== codexCandidate)
        ) return
        current = latest
        const codexWrite = preferredSource !== 'codex' || authoritativeCodex?.name !== title
        const discordWrite = channel.name !== title
        await this.synchronizeThreadTitleUnlocked(current, channel, title, {
          codex: codexWrite,
          discord: discordWrite,
          rollbackCodexOnDiscordFailure: false,
        })
        if (discordCandidate !== undefined) {
          if (title === discordCandidate) {
            this.discardExpectedTitle(
              this.expectedDiscordTitles,
              this.recentDiscordTitleEchoes,
              current.discordThreadId,
            )
          } else {
            this.rememberTitleEcho(
              this.recentDiscordTitleEchoes,
              current.discordThreadId,
              discordCandidate,
            )
          }
          if (this.pendingDiscordTitleVerifications.get(current.discordThreadId) === discordCandidate) {
            this.pendingDiscordTitleVerifications.delete(current.discordThreadId)
          }
        }
        if (codexCandidate !== undefined) {
          if (title === codexCandidate) {
            this.discardExpectedTitle(
              this.expectedCodexTitles,
              this.recentCodexTitleEchoes,
              current.codexThreadId,
            )
          } else {
            this.rememberTitleEcho(
              this.recentCodexTitleEchoes,
              current.codexThreadId,
              codexCandidate,
            )
          }
          if (this.pendingCodexTitleVerifications.get(current.codexThreadId) === codexCandidate) {
            this.pendingCodexTitleVerifications.delete(current.codexThreadId)
          }
        }
        if (
          !this.pendingDiscordTitleVerifications.has(current.discordThreadId) &&
          !this.pendingCodexTitleVerifications.has(current.codexThreadId)
        ) this.pendingTitleVerificationSources.delete(current.codexThreadId)
      }

      const pendingTitle = this.pendingDiscordTitles.get(current.discordThreadId) ||
        this.pendingCodexTitles.get(current.codexThreadId)
      if (!pendingTitle) return
      channel ||= await fetchThreadChannel()
      if (!channel) return
      const latest = this.state.sessions[session.discordThreadId]
      if (
        latest?.codexThreadId !== session.codexThreadId ||
        latest.archived ||
        this.archivingDiscordThreads.has(session.discordThreadId) ||
        this.deletedDiscordThreads.has(session.discordThreadId)
      ) return
      current = latest
      await this.synchronizeThreadTitleUnlocked(current, channel, pendingTitle)
    }).catch((error: unknown) => {
      this.logVerbose('pending title retry failed', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
    })
    this.finishTitleVerificationAttempt(session)
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true
      this.resolveShutdownRequested()
      this.finishIngressBarrier()
      this.stopPromise = this.stopInternal()
      this.stopPromise.catch(() => undefined)
    }
    await this.stopPromise
  }

  private clearShutdownTimers(): void {
    this.eventLoopDelay.disable()
    if (this.discordOutboxRetryTimer) clearTimeout(this.discordOutboxRetryTimer)
    delete this.discordOutboxRetryTimer
    if (this.discordReconnectRetryTimer) clearTimeout(this.discordReconnectRetryTimer)
    delete this.discordReconnectRetryTimer
    for (const timer of this.titleVerificationRetryTimers.values()) clearTimeout(timer)
    this.titleVerificationRetryTimers.clear()
    this.titleVerificationRetryAttempts.clear()
    this.pendingCodexTitleVerifications.clear()
    this.pendingDiscordTitleVerifications.clear()
    this.pendingTitleVerificationSources.clear()
    this.clearAllQueuedSourceRetries()
    this.invalidateSkillCache()
    for (const run of this.runs.values()) clearInterval(run.typingTimer)
    for (const progress of this.pendingStartupProgress.values()) clearInterval(progress.timer)
    this.pendingStartupProgress.clear()
  }

  private async dismissPendingControlsForShutdown(): Promise<void> {
    const channelIds = new Set([
      ...Array.from(this.approvals.values(), (pending) => pending.channel.id),
      ...Array.from(this.pendingUserInputs.values(), (pending) => pending.channel.id),
      ...Array.from(this.pendingActionButtons.values(), (pending) => pending.channel.id),
      ...Array.from(this.pendingMcpElicitations.values(), (pending) => pending.channel.id),
    ])
    await Promise.all(Array.from(channelIds, (channelId) =>
      this.dismissPendingControlsForChannel(channelId, '_Cordex is shutting down._')))
  }

  private async stopInternal(): Promise<void> {
    this.logger.info('shutdown_start', {
      activeRuns: this.runs.size,
      pendingWork: this.pendingShutdownWork(),
    })
    const errors: Error[] = []
    const attempt = async (label: string, action: () => void | Promise<void>): Promise<void> => {
      try {
        await action()
      } catch (error) {
        errors.push(new Error(`${label}: ${errorText(error)}`, { cause: error }))
      }
    }

    await attempt('Scheduler shutdown failed', () => this.scheduler.stopAndDrain())
    this.clearShutdownTimers()
    await attempt('Initial shutdown drain failed', () => this.drainShutdownWork())
    await attempt('Pending control dismissal failed', () => this.dismissPendingControlsForShutdown())
    await attempt('Pre-Codex shutdown drain failed', () => this.drainShutdownWork())
    this.finishCodexRecovery(this.codexRecoveryGeneration)
    await attempt('Codex close failed', () => this.codex.close())
    await attempt('Post-Codex shutdown drain failed', () => this.drainShutdownWork())
    await attempt('Final pending control dismissal failed', () => this.dismissPendingControlsForShutdown())
    await attempt('Final shutdown drain failed', () => this.drainShutdownWork())

    this.clearShutdownTimers()
    this.finishCodexRecovery(this.codexRecoveryGeneration)
    this.unlinkedCodexSessionChannels.clear()
    await attempt('Discord client destroy failed', () => this.client.destroy())

    if (errors.length === 1) {
      this.logger.error('shutdown_failed', errors[0])
      throw errors[0]
    }
    if (errors.length > 1) {
      const aggregate = new AggregateError(errors, 'Cordex shutdown encountered multiple failures')
      this.logger.error('shutdown_failed', aggregate, { failureCount: errors.length })
      throw aggregate
    }
    this.logger.info('shutdown_complete')
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.config.token)
    await rest.put(Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId), {
      body: buildSlashCommands(),
    })
  }

  private async refreshProjectsFromDisk(): Promise<void> {
    const latest = await loadConfig()
    this.config.projects = latest.projects
    if (latest.projectsDirectory !== undefined) this.config.projectsDirectory = latest.projectsDirectory
    else delete this.config.projectsDirectory
    if (latest.categoryId !== undefined) this.config.categoryId = latest.categoryId
    else delete this.config.categoryId
    let stateChanged = false
    const mappedChannels = new Set(Object.keys(this.config.projects))
    for (const settings of [
      this.state.channelModels,
      this.state.channelEfforts,
      this.state.channelFastMode,
      this.state.channelYoloMode,
      this.state.channelAutoWorktrees,
      this.state.channelVerbosity,
    ]) {
      for (const channelId of Object.keys(settings)) {
        if (mappedChannels.has(channelId)) continue
        delete settings[channelId]
        stateChanged = true
      }
    }
    if (stateChanged) await saveState(this.state)
  }

  private async refreshProjectsSafely(): Promise<void> {
    await withManagementLock(() => this.refreshProjectsFromDisk(), { timeoutMs: 500 })
  }

  private async sendRootWelcome(channel: TextChannel): Promise<void> {
    const welcome = await channel.send({
      content: [
        '**Cordex is ready.**',
        'Use this channel for general tasks, or run `/add-project` to create a dedicated channel for an existing repository.',
        'Each channel message starts a new Codex session thread.',
      ].join('\n'),
      allowedMentions: { parse: [] },
    })
    const tutorial = await welcome.startThread({
      name: 'Getting started with Cordex',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Cordex root channel tutorial',
    })
    await tutorial.send(
      'Try sending a task in the parent channel, or use `/create-new-project` to create a git project and its Discord channel.',
    )
  }

  private async pruneDeletedProjectMappings(): Promise<void> {
    for (const { channelId } of projectMappings(this.config)) {
      try {
        const channel = await this.channelMetadataForPrune(channelId)
        if (!channel) continue
        if (channel.guild_id !== this.config.guildId) {
          await this.cleanupProjectMapping(channelId, true)
        }
      } catch (error) {
        if (isUnknownDiscordChannelError(error)) {
          await this.cleanupProjectMapping(channelId, true)
        } else {
          console.error(`Could not verify project channel ${channelId}: ${errorText(error)}`)
        }
      }
    }
  }

  private async channelMetadataForPrune(channelId: string): Promise<JsonObject | undefined> {
    const channel = await this.client.rest.get(Routes.channel(channelId))
    if (
      !isRecord(channel) ||
      channel.id !== channelId ||
      typeof channel.guild_id !== 'string' ||
      typeof channel.type !== 'number'
    ) {
      console.error(`Could not verify channel ${channelId}: incomplete Discord channel metadata`)
      return undefined
    }
    return channel
  }

  private async pruneOrphanedState(): Promise<void> {
    const mappedChannels = new Set(Object.keys(this.config.projects))
    let changed = false
    for (const settings of [
      this.state.channelModels,
      this.state.channelEfforts,
      this.state.channelFastMode,
      this.state.channelYoloMode,
      this.state.channelAutoWorktrees,
      this.state.channelVerbosity,
    ]) {
      for (const channelId of Object.keys(settings)) {
        if (!mappedChannels.has(channelId)) {
          delete settings[channelId]
          changed = true
        }
      }
    }
    for (const [threadId, session] of Object.entries(this.state.sessions)) {
      let validThread = mappedChannels.has(session.parentChannelId)
      if (validThread) {
        try {
          const channel = await this.channelMetadataForPrune(threadId)
          if (!channel || typeof channel.parent_id !== 'string') {
            if (channel) {
              console.error(`Could not verify session thread ${threadId}: missing Discord parent ID`)
            }
            continue
          }
          validThread = (
            channel.guild_id === this.config.guildId &&
            channel.parent_id === session.parentChannelId &&
            (channel.type === ChannelType.AnnouncementThread ||
              channel.type === ChannelType.PublicThread ||
              channel.type === ChannelType.PrivateThread)
          )
        } catch (error) {
          if (isUnknownDiscordChannelError(error)) validThread = false
          else {
            console.error(`Could not verify session thread ${threadId}: ${errorText(error)}`)
            continue
          }
        }
      }
      if (validThread) continue
      this.deletedDiscordThreads.add(threadId)
      await this.persistDeletedThreadIntent(session, 'archive')
      await this.reconcileDeletedThreadIntents()
      changed = true
    }
    for (const [threadId, queue] of Object.entries(this.state.queues)) {
      if (queue.length > 0 || this.state.sessions[threadId] ||
        this.state.pendingInitialSessions?.[threadId]) continue
      delete this.state.queues[threadId]
      changed = true
    }
    if (changed) await saveState(this.state)
  }

  private async memberAllowed(userId: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.config.guildId)
    const member = await guild.members.fetch(userId).catch(() => undefined)
    if (!member) return false
    return userHasAccess(this.config, member.id, guild.id, guild.ownerId, member.roles.cache.keys())
  }

  private interactionMemberAllowed(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | StringSelectMenuInteraction
      | ModalSubmitInteraction,
  ): boolean | undefined {
    if (this.config.allowAllUsers || this.config.allowedUserIds?.includes(interaction.user.id)) {
      return true
    }
    const guild = interaction.guild
    const member = interaction.member
    if (!guild || !member) return undefined
    const roleIds = Array.isArray(member.roles) ? member.roles : member.roles.cache.keys()
    return userHasAccess(this.config, interaction.user.id, guild.id, guild.ownerId, roleIds)
  }

  private async requireAccess(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | StringSelectMenuInteraction
      | ModalSubmitInteraction,
  ): Promise<boolean> {
    if (interaction.guildId !== this.config.guildId) {
      await interaction.reply({
        content: 'Cordex is not configured for this Discord server.',
        ephemeral: true,
      }).catch(() => undefined)
      return false
    }
    const cachedAccess = this.interactionMemberAllowed(interaction)
    if (cachedAccess ?? await this.memberAllowed(interaction.user.id)) return true
    await interaction.reply({ content: 'Missing Cordex permission.', ephemeral: true }).catch(() => undefined)
    return false
  }

  private parentChannelId(channel: ChatInputCommandInteraction['channel']): string | undefined {
    if (!channel) return undefined
    return channel.isThread() ? channel.parentId ?? undefined : channel.id
  }

  private projectCandidateValue(directory: string): string {
    for (const [value, candidate] of this.projectCandidates) {
      if (candidate.expiresAt <= Date.now()) this.projectCandidates.delete(value)
    }
    const id = createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16)
    const value = `recent:${id}`
    this.projectCandidates.set(value, {
      directory: path.resolve(directory),
      expiresAt: Date.now() + 10 * 60_000,
    })
    return value
  }

  private resolveProjectCandidate(value: string): string {
    if (!value.startsWith('recent:')) return value
    const candidate = this.projectCandidates.get(value)
    if (!candidate || candidate.expiresAt <= Date.now()) {
      this.projectCandidates.delete(value)
      throw new Error('Recent project selection expired; run /add-project again')
    }
    return candidate.directory
  }

  private async recentProjectDirectories(query: string): Promise<string[]> {
    const managedWorktrees = path.resolve(getCordexHome(), 'worktrees')
    const threads = await this.codex.listThreads({ limit: 100 })
    const directories = new Set<string>()
    for (const cwd of new Set(threads.map((thread) => path.resolve(thread.cwd)))) {
      const directory = await resolveProjectRoot(cwd).catch(() => undefined)
      if (!directory || findProjectMappingForPath(this.config, directory)) continue
      const isManagedWorktree = (() => {
        const relative = path.relative(managedWorktrees, directory)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      })()
      if (!isManagedWorktree) directories.add(directory)
    }
    return [...directories]
      .filter((directory) => `${path.basename(directory)} ${directory}`.toLowerCase().includes(query))
      .slice(0, 25)
  }

  private async gitBranchAutocompleteChoices(
    directory: string,
    query: string,
  ): Promise<Array<{ name: string; value: string }>> {
    const result = await runGit(directory, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/',
      'refs/remotes/',
    ])
    if (result.exitCode !== 0) return []
    const refs = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      const ref = line.trim()
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/remotes\//, '')
      if (!ref || ref.endsWith('/HEAD') || ref.length > 100) continue
      refs.add(ref)
    }
    return [...refs]
      .filter((ref) => ref.toLowerCase().includes(query))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 25)
      .map((ref) => ({ name: ref, value: ref }))
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (
      interaction.guildId !== this.config.guildId ||
      !(await this.memberAllowed(interaction.user.id).catch(() => false))
    ) {
      await interaction.respond([]).catch(() => undefined)
      return
    }
    await this.refreshProjectsSafely().catch(() => undefined)
    const focused = interaction.options.getFocused(true)
    const focusedValue = typeof focused.value === 'string' ? focused.value : String(focused.value)
    const query = focusedValue.toLowerCase()
    if (interaction.commandName === 'approve' && focused.name === 'review') {
      const session = this.state.sessions[interaction.channelId]
      if (!session || session.archived || session.lifecycleIntent) {
        await interaction.respond([])
        return
      }
      await interaction.respond(this.autoReviewDenials.list(session.codexThreadId)
        .filter(entry => !entry.unavailable && entry.id.length <= 100 &&
          `${entry.id} ${entry.summary}`.toLowerCase().includes(query))
        .map(entry => ({ name: truncate(entry.summary, 100), value: entry.id })))
      return
    }
    if (
      (interaction.commandName === 'new-worktree' && focused.name === 'base-branch') ||
      (interaction.commandName === 'merge-worktree' && focused.name === 'target-branch')
    ) {
      if (!interaction.channel?.isThread()) {
        await interaction.respond([])
        return
      }
      const session = this.state.sessions[interaction.channel.id]
      if (!session) {
        await interaction.respond([])
        return
      }
      const project = this.config.projects[session.parentChannelId]
      const directory = interaction.commandName === 'merge-worktree'
        ? session.worktree?.projectDirectory || project?.directory || session.directory
        : project?.directory || session.directory
      const choices = await this.gitBranchAutocompleteChoices(directory, query).catch(() => [])
      await interaction.respond(choices)
      return
    }
    if (interaction.commandName === 'add-project' && focused.name === 'project') {
      const directories = await this.recentProjectDirectories(query).catch(() => [])
      await interaction.respond(
        directories.map((directory) => ({
          name: truncate(`${path.basename(directory)} (${directory})`, 100),
          value: this.projectCandidateValue(directory),
        })),
      )
      return
    }
    if (interaction.commandName === 'remove-project' && focused.name === 'project') {
      const choices = projectMappings(this.config)
        .filter(({ channelId, project }) => {
          const channelName = interaction.guild?.channels.cache.get(channelId)?.name || ''
          return `${channelName} ${project.name || ''} ${project.directory}`
            .toLowerCase()
            .includes(query)
        })
        .slice(0, 25)
        .map(({ channelId, project }) => {
          const channelName = interaction.guild?.channels.cache.get(channelId)?.name
          return {
            name: truncate(
              `${channelName ? `#${channelName}` : project.name || channelId} (${project.directory})`,
              100,
            ),
            value: channelId,
          }
        })
      await interaction.respond(choices)
      return
    }
    if (interaction.commandName === 'new-session' && focused.name === 'files') {
      const parentId = this.parentChannelId(interaction.channel)
      const project = parentId ? this.config.projects[parentId] : undefined
      if (!project) {
        await interaction.respond([])
        return
      }
      const { currentQuery } = parseFileAutocomplete(focusedValue)
      const matches = await this.codex
        .fuzzyFileSearch([project.directory], currentQuery)
        .catch(() => [])
      await interaction.respond(
        buildFileAutocompleteChoices(focusedValue, matches.map((match) => match.path)),
      )
      return
    }
    if (
      (interaction.commandName === 'skill' || interaction.commandName === 'skill-toggle') &&
      focused.name === 'skill'
    ) {
      if (!interaction.channel?.isThread()) {
        await interaction.respond([])
        return
      }
      const session = this.state.sessions[interaction.channel.id]
      if (!session || session.archived) {
        await interaction.respond([])
        return
      }
      const { skills } = await this.directorySkills(session.directory).catch(() => ({ skills: [] }))
      const byName = new Map<string, CodexSkillMetadata[]>()
      for (const skill of skills) {
        const matches = byName.get(skill.name) || []
        matches.push(skill)
        byName.set(skill.name, matches)
      }
      const choices = [...byName.values()]
        .flatMap((matches) =>
          matches.length === 1 &&
            (interaction.commandName === 'skill-toggle' || matches[0]?.enabled)
            ? [matches[0]!]
            : [])
        .filter((skill) => skill.name.length <= 100)
        .filter((skill) => [
          skill.name,
          this.skillDisplayName(skill),
          skill.shortDescription || '',
          skill.interface?.shortDescription || '',
          skill.description,
        ].join(' ').toLowerCase().includes(query))
        .sort((left, right) => this.skillDisplayName(left).localeCompare(this.skillDisplayName(right)))
        .slice(0, 25)
        .map((skill) => ({
          name: truncate(`${this.skillDisplayName(skill)} (${skill.scope})`, 100),
          value: skill.name,
        }))
      await interaction.respond(choices)
      return
    }
    if (interaction.commandName === 'resume') {
      const parentId = this.parentChannelId(interaction.channel)
      const project = parentId ? this.config.projects[parentId] : undefined
      const threads = parentId && project
        ? await this.listProjectThreads(parentId, project.directory, query, 25).catch(() => [])
        : []
      await interaction.respond(
        threads.slice(0, 25).map((thread) => ({
          name: truncate(
            `${thread.name || thread.preview || thread.id}${thread.archived ? ' (Archived)' : ''}`,
            100,
          ),
          value: thread.id,
        })),
      )
      return
    }
    if (interaction.commandName === 'mcp' || interaction.commandName === 'mcp-login') {
      const { cwd, threadId } = this.mcpContext(interaction.channel)
      const [configured, active] = await Promise.all([
        this.codex.listConfiguredMcpServers(cwd).catch(() => []),
        this.codex.listMcpServers(threadId).catch(() => []),
      ])
      const names = new Set([
        ...configured.map((server) => server.name),
        ...active.flatMap((server) => typeof server.name === 'string' ? [server.name] : []),
      ])
      await interaction.respond(
        Array.from(names)
          .filter((name) => name.toLowerCase().includes(query))
          .sort((left, right) => left.localeCompare(right))
          .slice(0, 25)
          .map((name) => ({ name: truncate(name, 100), value: name })),
      )
      return
    }
    if (interaction.commandName !== 'model') return
    const models = await this.getModels().catch(() => [])
    await interaction.respond(
      models
        .filter((model) => !model.hidden)
        .filter((model) => `${model.displayName} ${model.model}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((model) => ({
          name: truncate(`${model.displayName}${model.isDefault ? ' (default)' : ''}`, 100),
          value: model.model,
        })),
    )
  }

  private async getModels(): Promise<CodexModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models
    const models = await this.codex.listModels()
    this.modelCache = { models, expiresAt: Date.now() + 5 * 60_000 }
    return models
  }

  private invalidateSkillCache(): void {
    this.skillCacheGeneration += 1
    this.skillCache.clear()
  }

  private async listDirectorySkillEntries(
    directory: string,
    options: { refresh?: boolean; forceReload?: boolean } = {},
  ): Promise<CodexSkillsListEntry[]> {
    const cwd = path.resolve(directory)
    const cached = this.skillCache.get(cwd)
    if (!options.refresh && cached && cached.expiresAt > Date.now()) return cached.entries
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.skillCacheGeneration
      const entries = await this.codex.listSkills({
        cwds: [cwd],
        forceReload: options.forceReload === true,
      })
      if (generation !== this.skillCacheGeneration) continue
      this.skillCache.set(cwd, { entries, expiresAt: Date.now() + 60_000 })
      return entries
    }
    throw new Error('Codex skill metadata changed during refresh; try again')
  }

  private skillsForDirectory(
    directory: string,
    entries: CodexSkillsListEntry[],
  ): { skills: CodexSkillMetadata[]; errors: CodexSkillsListEntry['errors'] } {
    const cwd = path.resolve(directory)
    const matching = entries.filter((entry) => path.resolve(entry.cwd) === cwd)
    const effective = matching
    const skills = new Map<string, CodexSkillMetadata>()
    for (const skill of effective.flatMap((entry) => entry.skills)) {
      const key = `${skill.name}\0${path.resolve(cwd, skill.path)}`
      if (!skills.has(key)) skills.set(key, skill)
    }
    return {
      skills: [...skills.values()],
      errors: effective.flatMap((entry) => entry.errors),
    }
  }

  private async directorySkills(
    directory: string,
    options: { refresh?: boolean; forceReload?: boolean } = {},
  ): Promise<{ skills: CodexSkillMetadata[]; errors: CodexSkillsListEntry['errors'] }> {
    return this.skillsForDirectory(
      directory,
      await this.listDirectorySkillEntries(directory, options),
    )
  }

  private skillDisplayName(skill: CodexSkillMetadata): string {
    return skill.interface?.displayName || skill.name
  }

  private async listProjectThreads(
    parentChannelId: string,
    projectDirectory: string,
    searchTerm?: string,
    limit = 20,
  ): Promise<ResumeThreadChoice[]> {
    const directories = new Set([
      path.resolve(projectDirectory),
      ...Object.values(this.state.sessions)
        .filter((session) => session.parentChannelId === parentChannelId)
        .map((session) => path.resolve(session.directory)),
    ])
    const listOptions = {
      ...(searchTerm ? { searchTerm } : {}),
      cwd: [...directories],
    }
    const [activeThreads, archivedThreads] = await Promise.all([
      this.codex.listAllThreads(listOptions),
      this.codex.listAllThreads({ ...listOptions, archived: true }),
    ])
    const linked = new Map(
      Object.values(this.state.sessions).map((session) => [session.codexThreadId, session]),
    )
    const choices = new Map<string, ResumeThreadChoice>()
    for (const thread of activeThreads) {
      if (!directories.has(path.resolve(thread.cwd)) || linked.has(thread.id)) continue
      choices.set(thread.id, thread)
    }
    for (const thread of archivedThreads) {
      if (!directories.has(path.resolve(thread.cwd))) continue
      choices.set(thread.id, { ...thread, archived: true })
    }
    for (const session of linked.values()) {
      if (
        !session.archived ||
        session.parentChannelId !== parentChannelId ||
        !directories.has(path.resolve(session.directory)) ||
        choices.has(session.codexThreadId)
      ) continue
      const channel = this.client.channels.cache.get(session.discordThreadId)
      const name = channel?.isThread() ? channel.name : undefined
      const searchable = `${name || ''} ${session.codexThreadId} ${session.directory}`.toLowerCase()
      if (searchTerm && !searchable.includes(searchTerm.toLowerCase())) continue
      choices.set(session.codexThreadId, {
        id: session.codexThreadId,
        preview: '',
        ...(name ? { name } : {}),
        cwd: session.directory,
        updatedAt: Date.parse(session.updatedAt) / 1_000 || 0,
        archived: true,
      })
    }
    return [...choices.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  private async listAllProjectThreads(
    limit = 20,
    options: { searchTerm?: string; includeArchived?: boolean } = {},
  ) {
    const directories = new Set([
      ...Object.values(this.config.projects).map((project) => path.resolve(project.directory)),
      ...Object.values(this.state.sessions).map((session) => path.resolve(session.directory)),
    ])
    if (directories.size === 0) return []
    const listOptions = {
      cwd: [...directories],
      ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    }
    const [active, archived] = await Promise.all([
      this.codex.listAllThreads(listOptions),
      options.includeArchived
        ? this.codex.listAllThreads({ ...listOptions, archived: true })
        : Promise.resolve([]),
    ])
    return [
      ...active.map((thread) => ({ ...thread, archived: false })),
      ...archived.map((thread) => ({ ...thread, archived: true })),
    ]
      .filter((thread) => directories.has(path.resolve(thread.cwd)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  private deferredCommandInteraction(
    interaction: ChatInputCommandInteraction,
  ): ChatInputCommandInteraction {
    return new Proxy(interaction, {
      get: (target, property) => {
        if (property === 'deferReply') return async () => undefined
        if (property === 'reply') {
          return async (payload: unknown) => {
            if (target.replied) return target.followUp(payload as never)
            if (typeof payload === 'string') return target.editReply(payload)
            if (!isRecord(payload)) return target.editReply(payload as never)
            const {
              ephemeral: _ephemeral,
              fetchReply: _fetchReply,
              withResponse: _withResponse,
              ...editable
            } = payload
            return target.editReply(editable)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private async handleQueuedCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const privateReply = ephemeralChatCommands.has(interaction.commandName)
    const ackStartedAt = Date.now()
    const ageAtIngressMs = Math.max(0, ackStartedAt - interaction.createdTimestamp)
    let callbackCompletedAt: number | undefined
    const initialAcknowledgment = privateReply
      ? (async () => {
        // Private commands can acknowledge before a slow guild/member lookup.
        // Access checks still gate dispatch, and denials edit this private reply.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        callbackCompletedAt = Date.now()
        return this.requireAccess(this.deferredCommandInteraction(interaction))
      })()
      : this.requireAccess(interaction).then(async (allowed) => {
        if (!allowed) {
          callbackCompletedAt = Date.now()
          return false
        }
        await interaction.deferReply()
        callbackCompletedAt = Date.now()
        return true
      })
    const acknowledgment = initialAcknowledgment.then(
      (allowed) => {
        const eventLoopDelayMaxMs = Math.round(this.eventLoopDelay.max / 1_000_000)
        this.eventLoopDelay.reset()
        const callbackLatencyMs = (callbackCompletedAt ?? Date.now()) - ackStartedAt
        const metadata = {
          privateReply,
          allowed,
          ageAtIngressMs,
          callbackLatencyMs,
          afterAckMs: callbackCompletedAt ? Date.now() - callbackCompletedAt : 0,
          totalAgeMs: Math.max(0, Date.now() - interaction.createdTimestamp),
          gatewayPingMs: this.client.ws.ping,
          eventLoopDelayMaxMs,
        }
        if (ageAtIngressMs >= 1_500 || callbackLatencyMs >= 1_500 || eventLoopDelayMaxMs >= 500) {
          this.logger.warn('discord_interaction_ack_slow', metadata)
        } else this.logger.info('discord_interaction_ack', metadata)
        return allowed
      },
      (error: unknown) => {
        const eventLoopDelayMaxMs = Math.round(this.eventLoopDelay.max / 1_000_000)
        this.eventLoopDelay.reset()
        this.logger.warn('discord_interaction_ack_failed', {
          privateReply,
          ageAtIngressMs,
          callbackLatencyMs: (callbackCompletedAt ?? Date.now()) - ackStartedAt,
          acknowledged: callbackCompletedAt !== undefined,
          totalAgeMs: Math.max(0, Date.now() - interaction.createdTimestamp),
          gatewayPingMs: this.client.ws.ping,
          eventLoopDelayMaxMs,
          errorCode: isRecord(error) &&
            (typeof error.code === 'number' || typeof error.code === 'string')
            ? String(error.code)
            : 'unknown',
        })
        throw error
      },
    )
    await this.discordIngressQueue.run(interaction.channelId, async () => {
      if (!(await acknowledgment)) return
      await this.waitForMutationIngressReady()
      const deferredInteraction = this.deferredCommandInteraction(interaction)
      if (this.deletedDiscordThreads.has(interaction.channelId)) {
        await deferredInteraction.reply({ content: '⨯ Discord thread was deleted.' })
        return
      }
      await this.handleCommand(deferredInteraction, true)
    })
  }

  private async handlePriorityCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
    await interaction.deferReply()
    await this.waitForMutationIngressReady()
    await this.handleCommand(this.deferredCommandInteraction(interaction), true)
  }

  private async handleCommand(
    interaction: ChatInputCommandInteraction,
    accessGranted = false,
  ): Promise<void> {
    if (!accessGranted && !(await this.requireAccess(interaction))) return
    await this.refreshProjectsSafely().catch((error: unknown) => {
      console.error(`Could not refresh project mappings: ${errorText(error)}`)
    })
    this.logVerbose('command', {
      name: interaction.commandName,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    })
    try {
      if (interaction.commandName === 'project') await this.handleProjectCommand(interaction)
      else if (interaction.commandName === 'add-project') await this.handleAddProjectCommand(interaction)
      else if (interaction.commandName === 'remove-project') await this.handleRemoveProjectCommand(interaction)
      else if (interaction.commandName === 'create-new-project') await this.handleCreateNewProjectCommand(interaction)
      else if (interaction.commandName === 'add-dir') await this.handleAddDirCommand(interaction)
      else if (interaction.commandName === 'permissions') await this.handlePermissionsCommand(interaction)
      else if (interaction.commandName === 'approve') await this.handleApproveCommand(interaction)
      else if (interaction.commandName === 'model') await this.handleModelCommand(interaction)
      else if (interaction.commandName === 'model-variant') await this.handleModelVariantCommand(interaction)
      else if (interaction.commandName === 'unset-model-override') await this.handleUnsetModelOverrideCommand(interaction)
      else if (interaction.commandName === 'mode') await this.handleModeCommand(interaction)
      else if (interaction.commandName === 'fast') await this.handleFastCommand(interaction)
      else if (interaction.commandName === 'yolo') await this.handleYoloCommand(interaction)
      else if (interaction.commandName === 'new-session') await this.handleNewSessionCommand(interaction)
      else if (interaction.commandName === 'init') await this.handleInitCommand(interaction)
      else if (interaction.commandName === 'resume') await this.handleResumeCommand(interaction)
      else if (interaction.commandName === 'rename') await this.handleRenameCommand(interaction)
      else if (interaction.commandName === 'fork') await this.handleForkCommand(interaction)
      else if (interaction.commandName === 'fork-subagent') await this.handleForkSubagentCommand(interaction)
      else if (interaction.commandName === 'subagents') await this.handleSubagentsCommand(interaction)
      else if (interaction.commandName === 'btw') await this.handleBtwCommand(interaction)
      else if (interaction.commandName === 'compact') await this.handleCompactCommand(interaction)
      else if (interaction.commandName === 'goal') await this.handleGoalCommand(interaction)
      else if (interaction.commandName === 'clear-goal') await this.handleClearGoalCommand(interaction)
      else if (interaction.commandName === 'archive') await this.handleArchiveCommand(interaction)
      else if (interaction.commandName === 'delete') await this.handleDeleteSessionCommand(interaction)
      else if (interaction.commandName === 'review') await this.handleReviewCommand(interaction)
      else if (interaction.commandName === 'diff') await this.handleDiffCommand(interaction)
      else if (interaction.commandName === 'schedule') await this.handleScheduleCommand(interaction)
      else if (interaction.commandName === 'tasks') await this.handleTasksCommand(interaction)
      else if (interaction.commandName === 'cancel-task') await this.handleCancelTaskCommand(interaction)
      else if (interaction.commandName === 'skill') await this.handleSkillCommand(interaction)
      else if (interaction.commandName === 'skills') await this.handleSkillsCommand(interaction)
      else if (interaction.commandName === 'skill-toggle') await this.handleSkillToggleCommand(interaction)
      else if (interaction.commandName === 'skill-roots') await this.handleSkillRootsCommand(interaction)
      else if (interaction.commandName === 'plugins') await this.handlePluginsCommand(interaction)
      else if (interaction.commandName === 'plugin') await this.handlePluginCommand(interaction)
      else if (interaction.commandName === 'hooks') await this.handleHooksCommand(interaction)
      else if (interaction.commandName === 'apps') await this.handleAppsCommand(interaction)
      else if (interaction.commandName === 'mcp-status') await this.handleMcpStatusCommand(interaction)
      else if (interaction.commandName === 'mcp') await this.handleMcpCommand(interaction)
      else if (interaction.commandName === 'mcp-login') await this.handleMcpLoginCommand(interaction)
      else if (interaction.commandName === 'auth-status') await this.handleAuthStatusCommand(interaction)
      else if (interaction.commandName === 'rate-limits') await this.handleRateLimitsCommand(interaction)
      else if (interaction.commandName === 'account-usage') await this.handleAccountUsageCommand(interaction)
      else if (interaction.commandName === 'login') await this.handleLoginCommand(interaction)
      else if (interaction.commandName === 'rollback') await this.handleRollbackCommand(interaction)
      else if (interaction.commandName === 'new-worktree') await this.handleNewWorktreeCommand(interaction)
      else if (interaction.commandName === 'toggle-worktrees') await this.handleToggleWorktreesCommand(interaction)
      else if (interaction.commandName === 'worktrees') await this.handleWorktreesCommand(interaction)
      else if (interaction.commandName === 'merge-worktree') await this.handleMergeWorktreeCommand(interaction)
      else if (interaction.commandName === 'delete-worktree') await this.handleDeleteWorktreeCommand(interaction)
      else if (interaction.commandName === 'queue') await this.handleQueueCommand(interaction)
      else if (interaction.commandName === 'clear-queue') await this.handleClearQueueCommand(interaction)
      else if (interaction.commandName === 'pending-prompts') await this.handlePendingPromptsCommand(interaction)
      else if (interaction.commandName === 'resolve-pending') await this.handleResolvePendingCommand(interaction)
      else if (interaction.commandName === 'run-shell-command') await this.handleShellCommand(interaction)
      else if (interaction.commandName === 'last-sessions') await this.handleLastSessionsCommand(interaction)
      else if (interaction.commandName === 'context-usage') await this.handleContextUsageCommand(interaction)
      else if (interaction.commandName === 'verbosity') await this.handleVerbosityCommand(interaction)
      else if (interaction.commandName === 'session-id') await this.handleSessionIdCommand(interaction)
      else if (interaction.commandName === 'abort') await this.handleAbortCommand(interaction)
      else if (interaction.commandName === 'ps') await this.handlePsCommand(interaction)
      else if (interaction.commandName === 'stop') await this.handleStopCommand(interaction)
      else if (interaction.commandName === 'status') await this.handleStatusCommand(interaction)
      else if (interaction.commandName === 'restart') await this.handleRestartCommand(interaction)
      else if (interaction.commandName === 'debug-config') await this.handleDebugConfigCommand(interaction)
    } catch (error) {
      const payload = { content: `⨯ ${truncate(errorText(error), 1_850)}` }
      if (interaction.deferred && !interaction.replied) await interaction.editReply(payload.content)
      else if (interaction.replied) await interaction.followUp(payload)
      else await interaction.reply(payload)
    }
  }

  private async replyWithChunks(
    interaction: ChatInputCommandInteraction,
    content: string,
    options: { ephemeral?: boolean } = {},
  ): Promise<void> {
    const chunks = splitMarkdownForDiscord(content || '…', 1_900)
    const first = chunks.shift() || '…'
    if (interaction.deferred && !interaction.replied) await interaction.editReply({
      content: first,
      allowedMentions: { parse: [] },
    })
    else if (!interaction.replied) await interaction.reply({
      content: first,
      allowedMentions: { parse: [] },
      ...(options.ephemeral ? { ephemeral: true } : {}),
    })
    else await interaction.followUp({
      content: first,
      allowedMentions: { parse: [] },
      ...(options.ephemeral ? { ephemeral: true } : {}),
    })
    for (const chunk of chunks) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
        ...(options.ephemeral ? { ephemeral: true } : {}),
      })
    }
  }

  private async handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = this.parentChannelId(interaction.channel)
    if (!channelId) throw new Error('Project command requires a guild text channel')
    const directory = await assertDirectory(interaction.options.getString('path', true))
    await this.projectMutationQueue.run(`channel:${channelId}`, async () => {
      await withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        const existingSessions = Object.values(this.state.sessions).filter(
          (session) => session.parentChannelId === channelId,
        )
        const existing = this.config.projects[channelId]
        if (existing?.kind === 'root') {
          if (path.resolve(existing.directory) === directory) {
            await interaction.reply({ content: `Root project is already mapped to \`${directory}\`.` })
            return
          }
        }
        const blocker = projectRemapBlocker(existing, existingSessions.length, directory)
        if (blocker) throw new Error(blocker)
        this.config.projects[channelId] = {
          directory,
          name: path.basename(directory),
          kind: existing?.kind || 'project',
        }
        await saveManagedConfig(this.config)
        await interaction.reply({ content: `Project mapped to \`${directory}\`.` })
      })
    })
  }

  private async assertProjectNotMapped(directory: string): Promise<void> {
    for (const { channelId, project } of projectMappings(this.config)) {
      if (path.resolve(project.directory) !== directory) continue
      try {
        const existing = await this.client.channels.fetch(channelId)
        if (existing) {
          throw new Error(`A channel already exists for this directory: <#${channelId}>`)
        }
        await this.cleanupProjectMapping(channelId, true)
      } catch (error) {
        if (!isUnknownDiscordChannelError(error)) throw error
        await this.cleanupProjectMapping(channelId, true)
      }
    }
  }

  private async handleAddProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild
    if (!guild || guild.id !== this.config.guildId) {
      throw new Error('Add-project requires the configured Discord server')
    }
    const selected = this.resolveProjectCandidate(interaction.options.getString('project', true))
    const directory = await assertDirectory(selected)
    await interaction.deferReply()
    await this.projectMutationQueue.run(`directory:${directory}`, async () => {
      await withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        await this.assertProjectNotMapped(directory)
        const created = await createProjectChannel({
          guild,
          projectDirectory: directory,
          config: this.config,
          ...(this.client.user?.username ? { botName: this.client.user.username } : {}),
        })
        this.config.projects[created.textChannel.id] = created.project
        try {
          await saveManagedConfig(this.config)
        } catch (error) {
          delete this.config.projects[created.textChannel.id]
          await created.textChannel.delete('Cordex mapping could not be saved').catch(() => undefined)
          throw error
        }
        await interaction.editReply(
          `Created <#${created.textChannel.id}> for \`${directory}\`.`,
        )
      })
    })
  }

  private async archiveProjectSessions(
    channelId: string,
    strict: boolean,
  ): Promise<Array<[string, SessionState]>> {
    const sessions = Object.entries(this.state.sessions).filter(
      ([, session]) => session.parentChannelId === channelId,
    )
    for (const [threadId, session] of sessions) {
      if (!session.archived) {
        if (session.lifecycleIntent?.kind !== 'delete-thread') {
          await this.persistDeletedThreadIntent(session, 'archive')
        }
        const archiveCodex = this.codex.archiveThread(session.codexThreadId)
        if (strict) await archiveCodex
        else await archiveCodex.catch(() => undefined)
      }
      this.loadedThreads.delete(session.codexThreadId)
      const channel = await this.client.channels.fetch(threadId).catch(() => undefined)
      if (channel?.isThread()) {
        await channel.setArchived(true, 'Project channel removed').catch(() => undefined)
      }
    }
    return sessions
  }

  private async cleanupProjectMapping(
    channelId: string,
    archiveSessions: boolean,
  ): Promise<number> {
    const project = this.config.projects[channelId]
    if (
      project &&
      (
        project.kind === 'root' ||
        path.resolve(project.directory) === path.resolve(rootProjectDirectory(this.config))
      )
    ) {
      const tombstones = this.state.rootChannelTombstones ||= {}
      const previous = tombstones[this.config.guildId]
      tombstones[this.config.guildId] = {
        channelId,
        projectDirectory: path.resolve(project.directory),
        deletedAt: new Date().toISOString(),
      }
      try {
        await saveState(this.state)
      } catch (error) {
        if (previous) tombstones[this.config.guildId] = previous
        else delete tombstones[this.config.guildId]
        throw error
      }
    }
    const matchingSessions = Object.entries(this.state.sessions).filter(
      ([, session]) => session.parentChannelId === channelId,
    )
    if (archiveSessions && matchingSessions.length > 0) {
      for (const [discordThreadId, session] of matchingSessions) {
        this.deletedDiscordThreads.add(discordThreadId)
        if (session.lifecycleIntent?.kind !== 'delete-thread') {
          await this.persistDeletedThreadIntent(session, 'archive')
        }
      }
      for (const [discordThreadId] of matchingSessions) {
        await this.dismissPendingControlsForChannel(
          discordThreadId,
          '_Project channel deleted._',
        )
      }
      await this.reconcileDeletedThreadIntents(
        new Set(matchingSessions.map(([discordThreadId]) => discordThreadId)),
      )
    } else if (!archiveSessions) {
      for (const [, session] of matchingSessions) {
        await this.completePendingWorktreeRemovalBeforeSessionDrop(session)
      }
    }
    const sessions = matchingSessions
    if (!project && sessions.length === 0) return 0
    for (const [discordThreadId, session] of sessions) {
      this.loadedThreads.delete(session.codexThreadId)
      this.clearTitleVerificationState(session.codexThreadId, [discordThreadId])
      this.clearQueuedSourceBlock(discordThreadId)
      this.unlinkedCodexSessionChannels.delete(discordThreadId)
    }
    const removed = removeProjectChannelData(this.config, this.state, channelId)
    for (const taskId of removed.taskIds) this.scheduler.cancel(taskId)
    await Promise.all([saveManagedConfig(this.config), saveState(this.state)])
    return sessions.length
  }

  private async handleChannelDelete(channelId: string): Promise<void> {
    await this.projectMutationQueue
      .run(`channel:${channelId}`, () => withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        await this.cleanupProjectMapping(channelId, true)
      }))
      .catch((error: unknown) => {
        console.error(`Failed to clean deleted project channel ${channelId}: ${errorText(error)}`)
      })
  }

  private async handleThreadDelete(
    threadId: string,
    interruption: Promise<unknown>,
  ): Promise<void> {
    const session = this.state.sessions[threadId]
    if (!session) return
    if (session.lifecycleIntent?.kind !== 'delete-thread') {
      await this.persistDeletedThreadIntent(session, 'archive')
    }
    await this.dismissPendingControlsForChannel(threadId, '_Thread deleted._')
    const immediateError = await interruption
    const reconciliation = await this.reconcileAbortIntent(session)
    if (!reconciliation.cleared) {
      const errors = [
        ...(immediateError === undefined ? [] : [errorText(immediateError)]),
        ...reconciliation.errors,
      ]
      throw new Error(
        `Deleted thread abort confirmation pending: ${errors.join('; ') || 'Codex still reports it active'}`,
      )
    }
    await this.codex.archiveThread(session.codexThreadId)
    await this.finalizeDeletedDiscordThread(session)
  }

  private interruptDeletedThreadTurn(threadId: string): Promise<void> {
    const session = this.state.sessions[threadId]
    if (!session) return Promise.resolve()
    const turnId = this.runs.get(session.codexThreadId)?.turnId || session.activeTurnId
    if (!turnId) return Promise.resolve()
    return this.interruptDeletedTurn(threadId, session.codexThreadId, turnId)
  }

  private async interruptDeletedTurn(
    discordThreadId: string,
    codexThreadId: string,
    turnId: string,
  ): Promise<void> {
    if (this.deletedThreadInterruptedTurns.get(discordThreadId)?.has(turnId)) return
    await this.codex.interruptTurn(codexThreadId, turnId)
    const interrupted = this.deletedThreadInterruptedTurns.get(discordThreadId) || new Set<string>()
    interrupted.add(turnId)
    this.deletedThreadInterruptedTurns.set(discordThreadId, interrupted)
  }

  private async handleRemoveProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const selected = interaction.options.getString('project', true)
    const initialMapping = findProjectMapping(this.config, selected)
    if (!initialMapping) throw new Error('Project mapping not found')
    const force = interaction.options.getBoolean('force') === true
    await interaction.deferReply()
    const result = await this.projectMutationQueue.run(
      `channel:${initialMapping.channelId}`,
      () => withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        const mapping = findProjectMapping(this.config, selected) ||
          findProjectMapping(this.config, initialMapping.channelId)
        if (!mapping) throw new Error('Project mapping not found')
        const { channelId, project } = mapping
        this.removingProjects.add(channelId)
        try {
          const sessions = Object.entries(this.state.sessions).filter(
            ([, session]) => session.parentChannelId === channelId,
          )
          const pendingStarts = Object.values(this.state.pendingInitialSessions || {})
            .filter((pending) => pending.parentChannelId === channelId)
          if (pendingStarts.length > 0) {
            throw new Error('Project has saved session creation work awaiting /pending-prompts review')
          }
          const blocker = projectRemovalBlocker(sessions, force)
          if (blocker) throw new Error(blocker)
          await this.archiveProjectSessions(channelId, true)
          const channel = await this.client.channels.fetch(channelId).catch((error: unknown) => {
            if (isUnknownDiscordChannelError(error)) return undefined
            throw error
          })
          if (channel) await channel.delete('Removed by /remove-project')
          await this.cleanupProjectMapping(channelId, true)
          return { project, sessionCount: sessions.length }
        } finally {
          this.removingProjects.delete(channelId)
        }
      }),
    )
    await interaction.editReply(
      `Removed project **${result.project.name || path.basename(result.project.directory)}** at \`${result.project.directory}\`${result.sessionCount ? ` and archived ${result.sessionCount} session${result.sessionCount === 1 ? '' : 's'}` : ''}.`,
    )
  }

  private async handleCreateNewProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guild = interaction.guild
    if (!guild || guild.id !== this.config.guildId) {
      throw new Error('Create-new-project requires the configured Discord server')
    }
    const name = interaction.options.getString('name', true)
    await interaction.deferReply()
    const { created, projectChannel } = await this.projectMutationQueue.run(
      `new-project:${name.toLowerCase()}`,
      () => withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        const created = await createProject({
          rootDirectory: getProjectsDirectory(this.config),
          name,
        })
        const projectChannel = await createProjectChannel({
          guild,
          projectDirectory: created.directory,
          config: this.config,
          ...(this.client.user?.username ? { botName: this.client.user.username } : {}),
        })
        this.config.projects[projectChannel.textChannel.id] = {
          ...projectChannel.project,
          name: created.name,
        }
        try {
          await saveManagedConfig(this.config)
        } catch (error) {
          delete this.config.projects[projectChannel.textChannel.id]
          await projectChannel.textChannel.delete('Cordex mapping could not be saved').catch(() => undefined)
          throw error
        }
        return { created, projectChannel }
      }),
    )
    const starter = await projectChannel.textChannel.send({
      content: `**New project initialized**\n\`${created.directory}\``,
      allowedMentions: { parse: [] },
    })
    const thread = await starter.startThread({
      name: `Init: ${created.name}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'New project session',
    })
    await thread.members.add(interaction.user.id).catch(() => undefined)
    try {
      await this.dispatchInput(
        thread,
        projectChannel.textChannel.id,
        [
          {
            type: 'text',
            text: 'The project was just initialized. Say hello and ask what the user wants to build.',
            text_elements: [],
          },
        ],
        interaction.id,
      )
    } catch (error) {
      if (!this.state.pendingInitialSessions?.[thread.id]) throw error
      await interaction.editReply(
        `Project **${created.name}** was created, but Codex session creation is pending review in ${thread}. Open that thread and use /pending-prompts.`,
      )
      return
    }
    await interaction.editReply(
      `Created project **${created.name}** at \`${created.directory}\`.\nChannel: <#${projectChannel.textChannel.id}>\nSession: ${thread}`,
    )
  }

  private runtimeWorkspaceRoots(session: SessionState): string[] | undefined {
    if (!session.workspaceRoots?.length) return undefined
    return [...new Set([path.resolve(session.directory), ...session.workspaceRoots.map((root) => path.resolve(root))])]
  }

  private async ensureSessionLoaded(session: SessionState): Promise<void> {
    await this.resumeQueue.run(session.codexThreadId, async () => {
      await this.codexEventQueue.run(session.codexThreadId, async () => {
        if (session.lifecycleIntent) {
          throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
        }
        if (this.loadedThreads.has(session.codexThreadId)) {
          await this.retryPendingSessionTitle(session)
          return
        }
        if (session.archived) throw new Error('Session is archived; run /resume first')
        const runtimeRoots = this.runtimeWorkspaceRoots(session)
        const serviceTier = await this.serviceTierForFastMode(
          session.model || this.config.defaultModel,
          session.fastMode,
        )
        const resumed = await this.codex.resumeThread({
          threadId: session.codexThreadId,
          cwd: session.directory,
          ...(session.model ? { model: session.model } : {}),
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
          ...(!session.yoloMode && session.permissions
            ? { permissions: session.permissions }
            : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
          approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
          ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
        })
        if (session.effort && resumed.effort !== session.effort) {
          await this.codex.updateThreadSettings({
            threadId: session.codexThreadId,
            effort: session.effort,
          })
        }
        this.loadedThreads.add(session.codexThreadId)
        await this.retryPendingSessionTitle(session)
      })
    })
  }

  private async handleAddDirCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    const requested = interaction.options.getString('directory')?.trim() || '*'
    const directory = requested === '*'
      ? path.parse(session.directory).root
      : await assertDirectory(path.resolve(session.directory, requested))
    if (path.resolve(directory) === path.resolve(session.directory)) {
      await interaction.reply({ content: 'Session directory is already accessible.' })
      return
    }
    const previousRoots = session.workspaceRoots ? [...session.workspaceRoots] : undefined
    const previousUpdatedAt = session.updatedAt
    const roots = new Set((session.workspaceRoots || []).map((root) => path.resolve(root)))
    roots.add(path.resolve(directory))
    session.workspaceRoots = [...roots]
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      if (previousRoots === undefined) delete session.workspaceRoots
      else session.workspaceRoots = previousRoots
      session.updatedAt = previousUpdatedAt
      throw error
    }
    await interaction.reply({
      content: requested === '*'
        ? `All external directories allowed${session.activeTurnId ? ' beginning with the next turn' : ''}.`
        : `Allowed \`${directory}\`${session.activeTurnId ? ' beginning with the next turn' : ''}.`,
    })
  }

  private async handleApproveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (interaction.ephemeral !== true) throw new Error('Exact-action approval requires a private interaction')
    const { session } = this.requireThreadSession(interaction)
    if (session.archived || session.abortIntent) throw new Error('Resume or finish stopping this session before approving a retry')
    const threadId = session.codexThreadId
    const reviewer = this.runs.get(threadId)?.approvalsReviewer || session.approvalsReviewer ||
      this.threadApprovalsReviewers.get(threadId) || await this.codex.configuredApprovalsReviewer(session.directory)
    if (session.yoloMode || reviewer === 'user') {
      await interaction.reply({ content: 'Exact denied-action retries are available while automatic review is active. This command never changes the reviewer or permission profile.' })
      return
    }
    const reviewId = interaction.options.getString('review')
    const entries = this.autoReviewDenials.list(threadId)
    if (!reviewId) {
      const lines = entries.map(entry => `• ${discordInlineCode(entry.id)} — ${entry.summary.split(' · ')[0]}${entry.unavailable ? ' (unsupported exact conversion; use the native TUI)' : ''}`)
      await this.replyWithChunks(interaction, lines.length
        ? `Recent native automatic-review denials (at most ten):\n${lines.join('\n')}\n\nUse /approve review:<exact ID> to record one retry. The action is not executed by this command, and its retry remains subject to native review.`
        : 'No recent native auto-review denials in this session. Denials expire across runtime restarts or session mapping changes.', { ephemeral: true })
      return
    }
    const candidate = entries.find(entry => entry.id === reviewId)
    if (!candidate) throw new Error('That exact denial is stale, consumed, or belongs to another session')
    if (candidate.unavailable) throw new Error('This native denial cannot be converted exactly by this client; use the native TUI')
    if (!this.loadedThreads.has(threadId)) throw new Error('Native thread context is no longer loaded; obtain a fresh denial after recovery')
    const generation = this.codexGeneration
    // Consume before the first async RPC boundary. An uncertain acceptance is
    // not safe to replay, even if the private confirmation cannot be delivered.
    const denial = this.autoReviewDenials.take(threadId, reviewId)
    if (!denial) throw new Error('That denial has already been consumed')
    try {
      await this.codex.approveGuardianDeniedAction(threadId, denial.event)
    } catch {
      await interaction.reply({ content: '⨯ Native retry approval was not confirmed. Its acceptance may be uncertain; this client did not resend it. No broader permissions or command rule were granted. Inspect the session before requesting another retry.' })
      return
    }
    const changed = generation !== this.codexGeneration || this.state.sessions[interaction.channelId]?.codexThreadId !== threadId
    await interaction.reply({
      content: `Approval context recorded for one retry of native denial ${discordInlineCode(reviewId)}. The retry still goes through automatic review; this is not execution success. ${changed ? 'The runtime/session changed meanwhile; do not reuse this approval in its replacement context.' : 'Ask Codex to retry that exact action when ready.'}`,
      allowedMentions: { parse: [] },
    })
  }

  private async handlePermissionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const profile = interaction.options.getString('profile')?.trim()
    const reviewer = interaction.options.getString('reviewer')?.trim()
    if (reviewer) {
      await this.handleReviewerPreference(interaction, profile, reviewer)
      return
    }
    if (profile && !session) throw new Error('Selecting a permission profile requires a Cordex thread')
    const directory = session?.directory || project.directory
    await interaction.deferReply()
    if (!profile) {
      const profiles = await this.codex.listPermissionProfiles(directory)
      const lines = profiles.flatMap((entry) => {
        if (typeof entry.id !== 'string') return []
        const allowed = entry.allowed === false ? 'not allowed' : 'allowed'
        const description = typeof entry.description === 'string' && entry.description
          ? ` — ${truncate(entry.description, 120)}`
          : ''
        const current = session?.permissions === entry.id ? ' · current' : ''
        return [`• \`${entry.id}\` — ${allowed}${current}${description}`]
      })
      await this.replyWithChunks(
        interaction,
        `${session ? `Current: \`${session.permissions || this.config.sandbox}\`\nReviewer preference: \`${session.approvalsReviewer || 'configured default'}\`\n` : ''}${lines.join('\n') || 'No permission profiles reported.'}`,
      )
      return
    }
    if (!session) throw new Error('Selecting a permission profile requires a Cordex thread')
    if (profile === 'default') {
      await this.ensureSessionLoaded(session)
      const previous = session.permissions
      const previousUpdatedAt = session.updatedAt
      delete session.permissions
      session.updatedAt = new Date().toISOString()
      try {
        await saveState(this.state)
      } catch (error) {
        if (previous === undefined) delete session.permissions
        else session.permissions = previous
        session.updatedAt = previousUpdatedAt
        throw error
      }
      try {
        await this.codex.updateThreadSettings({ threadId: session.codexThreadId, permissions: null })
      } catch (error) {
        if (previous === undefined) delete session.permissions
        else session.permissions = previous
        session.updatedAt = previousUpdatedAt
        await saveState(this.state)
        throw error
      }
      await interaction.editReply(`Permission override cleared. Using \`${this.config.sandbox}\`.`)
      return
    }
    const profiles = await this.codex.listPermissionProfiles(directory)
    const selected = profiles.find((entry) => entry.id === profile)
    if (!selected) {
      await interaction.editReply(`Unknown permission profile: \`${profile}\`.`)
      return
    }
    if (selected.allowed === false) {
      await interaction.editReply(`Permission profile is not allowed: \`${profile}\`.`)
      return
    }
    await this.ensureSessionLoaded(session)
    const previous = session.permissions
    const previousUpdatedAt = session.updatedAt
    session.permissions = profile
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      if (previous === undefined) delete session.permissions
      else session.permissions = previous
      session.updatedAt = previousUpdatedAt
      throw error
    }
    try {
      await this.codex.updateThreadSettings({ threadId: session.codexThreadId, permissions: profile })
    } catch (error) {
      if (previous === undefined) delete session.permissions
      else session.permissions = previous
      session.updatedAt = previousUpdatedAt
      await saveState(this.state)
      throw error
    }
    await interaction.editReply(`Permission profile: \`${profile}\`.`)
  }

  private async handleReviewerPreference(
    interaction: ChatInputCommandInteraction,
    profile: string | undefined,
    selection: string,
  ): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    if (session.archived) throw new Error('Session is archived; run /resume first')
    if (!['user', 'auto_review', 'default'].includes(selection)) throw new Error('Unknown approvals reviewer')
    await interaction.deferReply()
    if (profile && profile !== 'default') {
      const selected = (await this.codex.listPermissionProfiles(session.directory))
        .find((entry) => entry.id === profile)
      if (!selected) throw new Error(`Unknown permission profile: ${profile}`)
      if (selected.allowed === false) throw new Error(`Permission profile is not allowed: ${profile}`)
    }
    const reviewer = selection === 'default'
      ? await this.codex.configuredApprovalsReviewer(session.directory)
      : selection as ApprovalsReviewer
    await this.ensureSessionLoaded(session)
    const previousPermissions = session.permissions
    const previousReviewer = session.approvalsReviewer
    const previousUpdatedAt = session.updatedAt
    if (profile === 'default') delete session.permissions
    else if (profile) session.permissions = profile
    if (selection === 'default') delete session.approvalsReviewer
    else session.approvalsReviewer = reviewer
    session.updatedAt = new Date().toISOString()
    const restore = () => {
      if (previousPermissions === undefined) delete session.permissions
      else session.permissions = previousPermissions
      if (previousReviewer === undefined) delete session.approvalsReviewer
      else session.approvalsReviewer = previousReviewer
      session.updatedAt = previousUpdatedAt
    }
    try {
      await saveState(this.state)
    } catch (error) {
      restore()
      throw error
    }
    try {
      await this.codex.updateThreadSettings({
        threadId: session.codexThreadId,
        approvalsReviewer: reviewer,
        ...(profile ? { permissions: profile === 'default' ? null : profile } : {}),
      })
    } catch (error) {
      restore()
      await saveState(this.state)
      throw error
    }
    this.threadApprovalsReviewers.set(session.codexThreadId, reviewer)
    const deferred = session.activeTurnId ? ' beginning with the next turn; pending approvals keep their original reviewer' : ''
    const automatic = reviewer !== 'user'
    const inactive = session.yoloMode || this.config.approvalPolicy === 'never' ||
      session.permissions === ':danger-full-access' ||
      (!session.permissions && this.config.sandbox === 'danger-full-access')
    await interaction.editReply(
      `Approval reviewer: ${discordInlineCode(reviewer)}${selection === 'default' ? ' (configured default)' : ''}${deferred}.${profile ? `\nPermission profile: ${discordInlineCode(profile === 'default' ? this.config.sandbox : profile)}.` : ''}${automatic ? `\n${inactive ? '⚠ Full access or approval_policy=never can bypass review. ' : ''}Automatic review only covers actions that require approval; it does not expand filesystem or network permissions.` : ''}`,
    )
  }

  private async handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Model command requires a project channel')
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const requestedScope = interaction.options.getString('scope')
    const scope = requestedScope || (session ? 'session' : 'channel')
    const model = interaction.options.getString('model') ?? undefined
    const effort = interaction.options.getString('effort') as ReasoningEffort | null
    if (!model && !effort) {
      const resolvedModel = session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default'
      const resolvedEffort = session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default'
      await interaction.reply({ content: `**Current model:** \`${formatModelLabel(resolvedModel, resolvedEffort)}\`` })
      return
    }
    if (scope === 'session' && !session) throw new Error('Session scope requires a Cordex thread')
    const currentModel = scope === 'channel'
      ? this.state.channelModels[parentId] || this.config.defaultModel
      : session?.model || this.state.channelModels[parentId] || this.config.defaultModel
    const currentEffort = scope === 'channel'
      ? this.state.channelEfforts[parentId] || this.config.defaultEffort
      : session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort
    const resolved = await this.resolveModelSettings({
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
    })
    let nextServiceTier: string | null | undefined
    if (model) {
      if (scope === 'channel') {
        await this.serviceTierForFastMode(
          resolved.model,
          this.state.channelFastMode[parentId],
          true,
        )
      }
      if (session) {
        nextServiceTier = await this.serviceTierForFastMode(
          resolved.model,
          session.fastMode ?? this.state.channelFastMode[parentId],
          true,
        )
      }
    }
    if (session) await this.ensureSessionLoaded(session)
    const previousSession = session
      ? {
          model: session.model,
          effort: session.effort,
          contextTokens: session.contextTokens,
          contextWindow: session.contextWindow,
          updatedAt: session.updatedAt,
        }
      : undefined
    const previousChannelModel = this.state.channelModels[parentId]
    const previousChannelEffort = this.state.channelEfforts[parentId]
    const hadChannelModel = Object.hasOwn(this.state.channelModels, parentId)
    const hadChannelEffort = Object.hasOwn(this.state.channelEfforts, parentId)
    const replayWasBlocked = session
      ? this.contextReplayBlocked.has(session.codexThreadId)
      : false
    const previousPendingUsage = session
      ? this.pendingContextUsage.get(session.codexThreadId)
      : undefined
    const restorePrevious = () => {
      if (session && previousSession) {
        if (previousSession.model === undefined) delete session.model
        else session.model = previousSession.model
        if (previousSession.effort === undefined) delete session.effort
        else session.effort = previousSession.effort
        if (previousSession.contextTokens === undefined) delete session.contextTokens
        else session.contextTokens = previousSession.contextTokens
        if (previousSession.contextWindow === undefined) delete session.contextWindow
        else session.contextWindow = previousSession.contextWindow
        session.updatedAt = previousSession.updatedAt
        if (replayWasBlocked) this.contextReplayBlocked.add(session.codexThreadId)
        else this.contextReplayBlocked.delete(session.codexThreadId)
        if (previousPendingUsage) {
          this.pendingContextUsage.set(session.codexThreadId, previousPendingUsage)
        } else {
          this.pendingContextUsage.delete(session.codexThreadId)
        }
      }
      if (hadChannelModel) this.state.channelModels[parentId] = previousChannelModel!
      else delete this.state.channelModels[parentId]
      if (hadChannelEffort) this.state.channelEfforts[parentId] = previousChannelEffort!
      else delete this.state.channelEfforts[parentId]
    }
    try {
      if (scope === 'session') {
        if (model) session!.model = resolved.model!
        if (resolved.effort) session!.effort = resolved.effort
        if (model && model !== previousSession?.model) this.clearContextUsage(session!, true)
        session!.updatedAt = new Date().toISOString()
      } else {
        if (model) this.state.channelModels[parentId] = resolved.model!
        if (resolved.effort) this.state.channelEfforts[parentId] = resolved.effort
        if (session) {
          if (model) session.model = resolved.model!
          if (resolved.effort) session.effort = resolved.effort
          if (model && model !== previousSession?.model) this.clearContextUsage(session, true)
          session.updatedAt = new Date().toISOString()
        }
      }
      await saveState(this.state)
    } catch (error) {
      restorePrevious()
      throw error
    }
    if (session && (model || effort)) {
      try {
        await this.codex.updateThreadSettings({
          threadId: session.codexThreadId,
          ...(model ? { model: resolved.model } : {}),
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          ...(nextServiceTier !== undefined ? { serviceTier: nextServiceTier } : {}),
        })
      } catch (error) {
        restorePrevious()
        await saveState(this.state)
        throw error
      }
    }
    const effectiveModel = resolved.model || session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default'
    const effectiveEffort = resolved.effort || session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default'
    await interaction.reply({
      content: `Model set for this ${scope}:\n**${formatModelLabel(effectiveModel, effectiveEffort)}**`,
    })
  }

  private async resolveModelSettings(options: {
    model?: string
    effort?: ReasoningEffort
    currentModel?: string
    currentEffort?: ReasoningEffort
  }): Promise<{ model?: string; effort?: ReasoningEffort }> {
    const selectedModel = options.model || options.currentModel
    const models = await this.getModels().catch(() => [])
    const catalogEntry = selectedModel
      ? models.find((entry) => entry.model === selectedModel || entry.id === selectedModel)
      : undefined
    if (options.model && models.length > 0 && !catalogEntry) {
      throw new Error(`Unknown Codex model: ${options.model}`)
    }
    const supported = catalogEntry?.supportedReasoningEfforts
    const supportedEfforts = supported ? new Set(supported.map((entry) => entry.reasoningEffort)) : undefined
    if (options.effort && supportedEfforts && !supportedEfforts.has(options.effort)) {
      throw new Error(`Model ${catalogEntry?.displayName || selectedModel} does not support effort ${options.effort}`)
    }
    let effort = options.effort || options.currentEffort
    if (effort && supportedEfforts && !supportedEfforts.has(effort)) {
      effort = catalogEntry?.defaultReasoningEffort
    }
    return {
      ...(selectedModel ? { model: catalogEntry?.model || selectedModel } : {}),
      ...(effort ? { effort } : {}),
    }
  }

  private async serviceTierForFastMode(
    model: string | undefined,
    fastMode: boolean | undefined,
    strict = false,
  ): Promise<string | null | undefined> {
    if (fastMode === undefined) return undefined
    if (!fastMode) return null
    const models = await this.getModels().catch(() => [])
    const catalogEntry = model
      ? models.find((entry) => entry.model === model || entry.id === model)
      : models.find((entry) => entry.isDefault)
    if (!catalogEntry || catalogEntry.serviceTiers === undefined) return 'fast'
    const tier = this.fastServiceTier(catalogEntry)
    if (tier) return tier.id
    if (strict) {
      throw new Error(`Model ${catalogEntry.displayName} does not support Fast mode`)
    }
    return null
  }

  private fastServiceTier(
    catalogEntry: CodexModel,
  ): NonNullable<CodexModel['serviceTiers']>[number] | undefined {
    const tiers = catalogEntry.serviceTiers
    if (!tiers) return undefined
    return tiers.find((entry) => entry.id === 'priority') ||
      tiers.find((entry) => entry.id === 'fast') ||
      tiers.find((entry) => this.serviceTierLooksFast(entry))
  }

  private serviceTierLooksFast(tier: { id: string; name: string }): boolean {
    return /fast|priority/i.test(`${tier.id} ${tier.name}`)
  }

  private serviceTierIsFast(
    model: string | undefined,
    serviceTier: string | null,
    models: CodexModel[],
  ): boolean {
    if (serviceTier === null) return false
    const catalogEntry = model
      ? models.find((entry) => entry.model === model || entry.id === model)
      : models.find((entry) => entry.isDefault)
    if (catalogEntry?.serviceTiers !== undefined) {
      const selectedTier = catalogEntry.serviceTiers.find((entry) => entry.id === serviceTier)
      return selectedTier ? this.serviceTierLooksFast(selectedTier) : false
    }
    return this.serviceTierLooksFast({ id: serviceTier, name: '' })
  }

  private async fastModeForServiceTier(
    model: string | undefined,
    serviceTier: string | null,
  ): Promise<boolean> {
    const models = await this.getModels().catch(() => [])
    return this.serviceTierIsFast(model, serviceTier, models)
  }

  private async handleModelVariantCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Model variant requires a project channel')
    const effort = interaction.options.getString('effort', true) as ReasoningEffort
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const model = session?.model || this.state.channelModels[parentId] || this.config.defaultModel
    const resolved = await this.resolveModelSettings({
      ...(model ? { currentModel: model } : {}),
      currentEffort: effort,
      effort,
    })
    if (session) {
      await this.ensureSessionLoaded(session)
      const previousEffort = session.effort
      const previousUpdatedAt = session.updatedAt
      session.effort = resolved.effort || effort
      session.updatedAt = new Date().toISOString()
      try {
        await saveState(this.state)
      } catch (error) {
        if (previousEffort === undefined) delete session.effort
        else session.effort = previousEffort
        session.updatedAt = previousUpdatedAt
        throw error
      }
      try {
        await this.codex.updateThreadSettings({
          threadId: session.codexThreadId,
          effort: resolved.effort || effort,
        })
      } catch (error) {
        if (previousEffort === undefined) delete session.effort
        else session.effort = previousEffort
        session.updatedAt = previousUpdatedAt
        await saveState(this.state)
        throw error
      }
    } else {
      const previousEffort = this.state.channelEfforts[parentId]
      const hadPrevious = Object.hasOwn(this.state.channelEfforts, parentId)
      this.state.channelEfforts[parentId] = resolved.effort || effort
      try {
        await saveState(this.state)
      } catch (error) {
        if (hadPrevious) this.state.channelEfforts[parentId] = previousEffort!
        else delete this.state.channelEfforts[parentId]
        throw error
      }
    }
    await interaction.reply({
      content: `Model set for this ${session ? 'session' : 'channel'}:\n**${formatModelLabel(model || 'Codex default', resolved.effort || effort)}**`,
    })
  }

  private async handleUnsetModelOverrideCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Model override requires a project channel')
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    if (session) {
      await this.ensureSessionLoaded(session)
      const fallback = this.state.channelModels[parentId] || this.config.defaultModel
      const resolved = await this.resolveModelSettings({
        ...(fallback ? { model: fallback } : {}),
        ...(session.effort ? { currentEffort: session.effort } : {}),
      })
      const serviceTier = await this.serviceTierForFastMode(
        resolved.model || fallback,
        session.fastMode ?? this.state.channelFastMode[parentId],
        true,
      )
      const previous = {
        model: session.model,
        effort: session.effort,
        contextTokens: session.contextTokens,
        contextWindow: session.contextWindow,
        updatedAt: session.updatedAt,
      }
      const replayWasBlocked = this.contextReplayBlocked.has(session.codexThreadId)
      const previousPendingUsage = this.pendingContextUsage.get(session.codexThreadId)
      if (fallback) session.model = resolved.model || fallback
      else delete session.model
      if (resolved.effort) session.effort = resolved.effort
      else delete session.effort
      this.clearContextUsage(session, true)
      session.updatedAt = new Date().toISOString()
      try {
        await saveState(this.state)
      } catch (error) {
        if (previous.model === undefined) delete session.model
        else session.model = previous.model
        if (previous.effort === undefined) delete session.effort
        else session.effort = previous.effort
        if (previous.contextTokens === undefined) delete session.contextTokens
        else session.contextTokens = previous.contextTokens
        if (previous.contextWindow === undefined) delete session.contextWindow
        else session.contextWindow = previous.contextWindow
        session.updatedAt = previous.updatedAt
        if (replayWasBlocked) this.contextReplayBlocked.add(session.codexThreadId)
        else this.contextReplayBlocked.delete(session.codexThreadId)
        if (previousPendingUsage) {
          this.pendingContextUsage.set(session.codexThreadId, previousPendingUsage)
        } else {
          this.pendingContextUsage.delete(session.codexThreadId)
        }
        throw error
      }
      try {
        await this.codex.updateThreadSettings({
          threadId: session.codexThreadId,
          model: fallback || null,
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          ...(serviceTier !== undefined ? { serviceTier } : {}),
        })
      } catch (error) {
        if (previous.model === undefined) delete session.model
        else session.model = previous.model
        if (previous.effort === undefined) delete session.effort
        else session.effort = previous.effort
        if (previous.contextTokens === undefined) delete session.contextTokens
        else session.contextTokens = previous.contextTokens
        if (previous.contextWindow === undefined) delete session.contextWindow
        else session.contextWindow = previous.contextWindow
        session.updatedAt = previous.updatedAt
        if (replayWasBlocked) this.contextReplayBlocked.add(session.codexThreadId)
        else this.contextReplayBlocked.delete(session.codexThreadId)
        if (previousPendingUsage) {
          this.pendingContextUsage.set(session.codexThreadId, previousPendingUsage)
        } else {
          this.pendingContextUsage.delete(session.codexThreadId)
        }
        await saveState(this.state)
        throw error
      }
      await interaction.reply({
        content: `Session model override removed. Using **${formatModelLabel(fallback || 'Codex default', session.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default')}**.`,
      })
      return
    }
    const previous = this.state.channelModels[parentId]
    const hadPrevious = Object.hasOwn(this.state.channelModels, parentId)
    delete this.state.channelModels[parentId]
    try {
      await saveState(this.state)
    } catch (error) {
      if (hadPrevious) this.state.channelModels[parentId] = previous!
      throw error
    }
    await interaction.reply({
      content: `Channel model override removed. Using **${formatModelLabel(this.config.defaultModel || 'Codex default', this.config.defaultEffort || 'default')}**.`,
    })
  }

  private async handleModeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    const mode = interaction.options.getString('mode') as 'default' | 'plan' | null
    if (!mode) {
      await interaction.reply({ content: `Mode: **${session.mode || 'default'}**` })
      return
    }
    const previousMode = session.mode
    const previousUpdatedAt = session.updatedAt
    session.mode = mode
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      if (previousMode === undefined) delete session.mode
      else session.mode = previousMode
      session.updatedAt = previousUpdatedAt
      throw error
    }
    await interaction.reply({ content: `Mode: **${mode}**. Applies next turn.` })
  }

  private async handleFastCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Fast mode requires a project channel')
    this.requireProject(parentId)
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const action = interaction.options.getString('action') || 'status'
    const enabled = session?.fastMode ?? this.state.channelFastMode[parentId] ?? false
    if (action === 'status') {
      await interaction.reply(`Fast mode: **${enabled ? 'on' : 'off'}** (${session ? 'session' : 'channel'}).`)
      return
    }
    const next = action === 'on'
    const model = session?.model || this.state.channelModels[parentId] || this.config.defaultModel
    const serviceTier = await this.serviceTierForFastMode(model, next, true)
    if (session) {
      await this.ensureSessionLoaded(session)
      const previous = session.fastMode
      const previousUpdatedAt = session.updatedAt
      session.fastMode = next
      session.updatedAt = new Date().toISOString()
      try {
        await saveState(this.state)
      } catch (error) {
        if (previous === undefined) delete session.fastMode
        else session.fastMode = previous
        session.updatedAt = previousUpdatedAt
        throw error
      }
      try {
        await this.codex.updateThreadSettings({
          threadId: session.codexThreadId,
          serviceTier: serviceTier ?? null,
        })
      } catch (error) {
        if (previous === undefined) delete session.fastMode
        else session.fastMode = previous
        session.updatedAt = previousUpdatedAt
        await saveState(this.state)
        throw error
      }
    } else {
      const previous = this.state.channelFastMode[parentId]
      const hadPrevious = Object.hasOwn(this.state.channelFastMode, parentId)
      this.state.channelFastMode[parentId] = next
      try {
        await saveState(this.state)
      } catch (error) {
        if (hadPrevious) this.state.channelFastMode[parentId] = previous!
        else delete this.state.channelFastMode[parentId]
        throw error
      }
    }
    await interaction.reply(`Fast mode: **${next ? 'on' : 'off'}** (${session ? 'session' : 'channel'}).`)
  }

  private async handleYoloCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('YOLO mode requires a project channel')
    this.requireProject(parentId)
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const action = interaction.options.getString('action') || 'status'
    const enabled = session?.yoloMode ?? this.state.channelYoloMode[parentId] ?? false
    if (action === 'status') {
      await interaction.reply(`YOLO mode: **${enabled ? 'on' : 'off'}** (${session ? 'session' : 'channel'}).`)
      return
    }
    const next = action === 'on'
    if (session) {
      await this.ensureSessionLoaded(session)
      const previous = session.yoloMode
      const previousUpdatedAt = session.updatedAt
      session.yoloMode = next
      session.updatedAt = new Date().toISOString()
      try {
        await saveState(this.state)
      } catch (error) {
        if (previous === undefined) delete session.yoloMode
        else session.yoloMode = previous
        session.updatedAt = previousUpdatedAt
        throw error
      }
      try {
        if (next) {
          await this.codex.updateThreadSettings({
            threadId: session.codexThreadId,
            ...(session.permissions ? { permissions: null } : {}),
            sandbox: 'danger-full-access',
            approvalPolicy: 'never',
          })
        } else if (session.permissions) {
          await this.codex.updateThreadSettings({
            threadId: session.codexThreadId,
            permissions: session.permissions,
            approvalPolicy: this.config.approvalPolicy,
          })
        } else {
          await this.codex.updateThreadSettings({
            threadId: session.codexThreadId,
            sandbox: this.config.sandbox,
            approvalPolicy: this.config.approvalPolicy,
          })
        }
      } catch (error) {
        if (previous === undefined) delete session.yoloMode
        else session.yoloMode = previous
        session.updatedAt = previousUpdatedAt
        await saveState(this.state)
        throw error
      }
    } else {
      const previous = this.state.channelYoloMode[parentId]
      const hadPrevious = Object.hasOwn(this.state.channelYoloMode, parentId)
      this.state.channelYoloMode[parentId] = next
      try {
        await saveState(this.state)
      } catch (error) {
        if (hadPrevious) this.state.channelYoloMode[parentId] = previous!
        else delete this.state.channelYoloMode[parentId]
        throw error
      }
    }
    await interaction.reply(
      `YOLO mode: **${next ? 'on' : 'off'}** (${session ? 'session' : 'channel'}).${next ? '\nApprovals disabled; sandbox set to danger-full-access.' : ''}`,
    )
  }

  private requireProject(parentChannelId: string | undefined) {
    if (!parentChannelId) throw new Error('Command requires a project channel')
    const project = this.config.projects[parentChannelId]
    if (!project) throw new Error('Channel is not mapped. Run /project first.')
    return { parentChannelId, project }
  }

  private async createSessionThread(options: {
    parentChannelId: string
    name: string
    userId: string
  }): Promise<ThreadChannel> {
    const parent = await this.client.channels.fetch(options.parentChannelId)
    if (!parent || parent.type !== ChannelType.GuildText) {
      throw new Error('Project parent must be a text channel')
    }
    const thread = await parent.threads.create({
      name: normalizeThreadTitle(options.name),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Start Cordex session',
    })
    await thread.members.add(options.userId).catch(() => undefined)
    return thread
  }

  private buildNewSessionState(options: {
    discordThreadId: string
    parentChannelId: string
    directory: string
    codexThreadId: string
    model?: string
  }): SessionState {
    return {
      discordThreadId: options.discordThreadId,
      parentChannelId: options.parentChannelId,
      directory: options.directory,
      codexThreadId: options.codexThreadId,
      ...(options.model ? { model: options.model } : {}),
      ...(this.state.channelEfforts[options.parentChannelId]
        ? { effort: this.state.channelEfforts[options.parentChannelId] }
        : this.config.defaultEffort
          ? { effort: this.config.defaultEffort }
          : {}),
      ...(Object.hasOwn(this.state.channelFastMode, options.parentChannelId)
        ? { fastMode: this.state.channelFastMode[options.parentChannelId] }
        : {}),
      ...(Object.hasOwn(this.state.channelYoloMode, options.parentChannelId)
        ? { yoloMode: this.state.channelYoloMode[options.parentChannelId] }
        : {}),
      updatedAt: new Date().toISOString(),
    }
  }

  private clearContextUsage(session: SessionState, blockReplay = false): void {
    delete session.contextTokens
    delete session.contextWindow
    this.pendingContextUsage.delete(session.codexThreadId)
    if (blockReplay) this.contextReplayBlocked.add(session.codexThreadId)
  }

  private hydratePendingContextUsage(session: SessionState): boolean {
    const pending = this.pendingContextUsage.get(session.codexThreadId)
    if (!pending) return false
    this.pendingContextUsage.delete(session.codexThreadId)
    if (pending.expiresAt <= Date.now()) return false
    applyContextUsage(session, pending.update)
    this.contextUsageVersions.set(
      session.codexThreadId,
      this.contextUsageVersion(session.codexThreadId) + 1,
    )
    return true
  }

  private contextUsageVersion(threadId: string): number {
    return this.contextUsageVersions.get(threadId) || 0
  }

  private invalidateContextUsageUnlessUpdated(session: SessionState, version: number): boolean {
    if (this.contextUsageVersion(session.codexThreadId) !== version) return false
    this.clearContextUsage(session)
    return true
  }

  private rememberPendingContextUsage(update: ContextUsageUpdate): void {
    const now = Date.now()
    for (const [threadId, pending] of this.pendingContextUsage) {
      if (pending.expiresAt <= now) this.pendingContextUsage.delete(threadId)
    }
    this.pendingContextUsage.set(update.threadId, {
      update,
      expiresAt: now + pendingContextUsageTtlMs,
    })
    while (this.pendingContextUsage.size > maxPendingContextUsage) {
      const oldest = this.pendingContextUsage.keys().next().value as string | undefined
      if (!oldest) break
      this.pendingContextUsage.delete(oldest)
    }
  }

  private async handleNewSessionCommand(
    interaction: ChatInputCommandInteraction,
    preset?: { prompt: string; title: string; validateDirectory: (directory: string) => Promise<string | undefined> },
  ): Promise<void> {
    const { parentChannelId, project } = this.requireProject(this.parentChannelId(interaction.channel))
    const prompt = preset?.prompt ?? interaction.options.getString('prompt', true)
    const requestedFiles = preset ? null : interaction.options.getString('files')
    await interaction.deferReply()
    const sourceThreadId = interaction.channel?.isThread() ? interaction.channel.id : undefined
    let reservedDirectory: string | undefined
    const inherited = sourceThreadId
      ? await this.projectMutationQueue.run(`channel:${parentChannelId}`, async () => {
          await this.refreshProjectsSafely()
          if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
          const sourceSession = this.state.sessions[sourceThreadId]
          if (!sourceSession) return undefined
          if (sourceSession.lifecycleIntent) {
            throw new Error(`Session ${sourceSession.lifecycleIntent.kind} operation is still pending`)
          }
          const directory = path.resolve(sourceSession.directory)
          this.pendingSessionDirectoryReservations.set(
            directory,
            (this.pendingSessionDirectoryReservations.get(directory) || 0) + 1,
          )
          reservedDirectory = directory
          return {
            directory: sourceSession.directory,
            workspaceRoots: sourceSession.workspaceRoots ? [...sourceSession.workspaceRoots] : undefined,
            worktree: Boolean(sourceSession.worktree && !sourceSession.worktree.merged),
          }
        })
      : undefined
    const directory = inherited?.directory || project.directory
    let worktree: CreatedWorktree | undefined
    let thread: ThreadChannel | undefined
    try {
      const files = requestedFiles ? await resolveProjectFiles(directory, requestedFiles) : []
      worktree = inherited
        ? undefined
        : await this.createAutomaticWorktree(parentChannelId, preset?.title || prompt)
      const initialLocation: InitialSessionLocation | undefined = inherited
        ? {
            directory,
            ...(inherited.workspaceRoots?.length
              ? { workspaceRoots: inherited.workspaceRoots }
              : {}),
          }
        : worktree
          ? { directory: worktree.directory, worktree }
          : undefined
      const notice = await preset?.validateDirectory(initialLocation?.directory || directory)
      if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
      thread = await this.createSessionThread({
        parentChannelId,
        name: `${worktree || inherited?.worktree ? '⬦ ' : ''}${preset?.title || prompt}`,
        userId: interaction.user.id,
      })
      await this.dispatchInput(
        thread,
        parentChannelId,
        [{
          type: 'text',
          text: files.length
            ? `${prompt}\n\nFiles to inspect:\n${files.map((file) => `- ${file}`).join('\n')}`
            : prompt,
          text_elements: [],
        }],
        interaction.id,
        initialLocation,
      )
      await interaction.editReply(
        `Session started: ${thread}${worktree ? `\nWorktree: \`${worktree.branch}\`` : inherited?.worktree ? `\nDirectory: \`${directory}\`` : ''}${files.length ? `\nFiles: ${files.map((file) => `\`${file}\``).join(', ')}` : ''}${notice ? `\n${notice}` : ''}`,
      )
    } catch (error) {
      const pendingInitial = thread && this.state.pendingInitialSessions?.[thread.id]
      if (worktree && (!thread || (!this.state.sessions[thread.id] && !pendingInitial))) {
        await removeWorktree(worktree).catch(() => undefined)
      }
      if (thread && !this.state.sessions[thread.id] && !pendingInitial) {
        await thread.delete('Cordex session could not be started').catch(() => undefined)
      }
      if (thread && pendingInitial) {
        await interaction.editReply(pendingInitial.abortIntent
          ? `Codex session creation was cancelled in ${thread}. Saved prompts are held; open that thread and use /pending-prompts.`
          : `Codex session creation is pending review in ${thread}. Your initial prompt is saved; open that thread and use /pending-prompts.`)
        return
      }
      throw error
    } finally {
      if (reservedDirectory) {
        const reservations = this.pendingSessionDirectoryReservations.get(reservedDirectory) || 0
        if (reservations <= 1) this.pendingSessionDirectoryReservations.delete(reservedDirectory)
        else this.pendingSessionDirectoryReservations.set(reservedDirectory, reservations - 1)
      }
    }
  }

  private async handleInitCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const update = interaction.options.getBoolean('update') ?? false
    const instructions = interaction.options.getString('instructions') || undefined
    const prompt = repositoryInitPrompt({ update, ...(instructions ? { instructions } : {}) })
    if (!interaction.channel?.isThread()) {
      await this.handleNewSessionCommand(interaction, {
        prompt,
        title: update ? 'Refresh AGENTS.md' : 'Initialize AGENTS.md',
        validateDirectory: async (directory) => {
          await assertRepositoryInitTarget(directory, update)
          return repositoryInitOverrideNotice(directory)
        },
      })
      return
    }
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.archived) throw new Error('Session is archived; run /resume first')
    await interaction.deferReply()
    await assertRepositoryInitTarget(session.directory, update)
    const notice = await repositoryInitOverrideNotice(session.directory)
    const suffix = notice ? `\n${notice}` : ''
    try {
      await this.persistAndDeliverDirectPrompt(session, channel, {
        id: interaction.id,
        authorId: interaction.user.id,
        authorName: interaction.user.displayName,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        displayText: update ? '[Refresh AGENTS.md]' : '[Initialize AGENTS.md]',
        createdAt: new Date().toISOString(),
        deliveryKind: 'direct',
      })
    } catch (error) {
      if (!this.queueFor(channel.id).some((entry) => entry.id === interaction.id)) throw error
      await interaction.editReply(
        `AGENTS.md request is saved, but Codex delivery is deferred. Use /pending-prompts to inspect it.\n${truncate(errorText(error), 900)}${suffix}`,
      )
      return
    }
    const pending = this.queueFor(channel.id).find((entry) => entry.id === interaction.id)
    await interaction.editReply(pending
      ? `AGENTS.md request is saved for later delivery.${pending.reviewRequired ? ' Use /pending-prompts to review it.' : ''}${suffix}`
      : `AGENTS.md initialization submitted. Codex will report progress and the result in this thread.${suffix}`)
  }

  private async handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { parentChannelId, project } = this.requireProject(this.parentChannelId(interaction.channel))
    const codexThreadId = interaction.options.getString('session', true)
    await interaction.deferReply()
    let queueDrain: { session: SessionState; channel: ThreadChannel } | undefined
    let resumeReply: string | undefined
    await this.resumeQueue.run(codexThreadId, async () => {
      await this.codexEventQueue.run(codexThreadId, async () => {
        const knownEntry = Object.entries(this.state.sessions).find(
          ([, session]) => session.codexThreadId === codexThreadId,
        )
        const knownSession = knownEntry?.[1]
        if (
          knownSession?.lifecycleIntent &&
          knownSession.lifecycleIntent.kind !== 'resume'
        ) {
          throw new Error(`Session ${knownSession.lifecycleIntent.kind} operation is still pending`)
        }
        let existingChannel: ThreadChannel | undefined
        if (knownEntry) {
          try {
            const channel = await this.client.channels.fetch(knownEntry[0])
            if (channel?.isThread()) existingChannel = channel
          } catch (error) {
            if (!isUnknownDiscordChannelError(error)) throw error
          }
          if (
            existingChannel &&
            knownSession &&
            !knownSession.archived &&
            this.loadedThreads.has(codexThreadId)
          ) {
            const channelAvailable = await this.convergeDiscordLifecycleState(
              knownSession,
              'resume',
              false,
              'Resume existing Cordex session',
              existingChannel,
            )
            if (!channelAvailable) {
              throw new Error('Discord session thread no longer exists; run /resume again')
            }
            await existingChannel.members.add(interaction.user.id).catch(() => undefined)
            queueDrain = { session: knownSession, channel: existingChannel }
            resumeReply = `Session is already linked: ${existingChannel}`
            return
          }
        }

        const targetParentChannelId = knownSession && this.config.projects[knownSession.parentChannelId]
          ? knownSession.parentChannelId
          : parentChannelId
        const directory = knownSession?.directory || project.directory
        const model = knownSession?.model ||
          this.state.channelModels[targetParentChannelId] ||
          this.config.defaultModel
        const effort = knownSession?.effort ||
          this.state.channelEfforts[targetParentChannelId] ||
          this.config.defaultEffort
        const fastMode = knownSession?.fastMode ?? this.state.channelFastMode[targetParentChannelId]
        const yoloMode = knownSession?.yoloMode ??
          this.state.channelYoloMode[targetParentChannelId] ??
          false
        const runtimeRoots = knownSession ? this.runtimeWorkspaceRoots(knownSession) : undefined
        const serviceTier = await this.serviceTierForFastMode(model, fastMode)
        const resumeOptions = {
          threadId: codexThreadId,
          includeTurns: true,
          cwd: directory,
          ...(model ? { model } : {}),
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
          ...(!yoloMode && knownSession?.permissions
            ? { permissions: knownSession.permissions }
            : { sandbox: yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
          approvalPolicy: yoloMode ? 'never' as const : this.config.approvalPolicy,
          ...(knownSession?.approvalsReviewer ? { approvalsReviewer: knownSession.approvalsReviewer } : {}),
        }

        let resumed
        if (knownSession?.archived || knownSession?.lifecycleIntent?.kind === 'resume') {
          if (!knownSession) throw new Error('Archived session linkage is missing')
          await this.persistSessionLifecycleIntent(knownSession, 'resume')
          this.preserveArchivedUntilResume.add(codexThreadId)
          let unarchiveError: unknown
          try {
            await this.codex.unarchiveThread(codexThreadId)
            this.expectArchiveNotification(codexThreadId, 'unarchived')
          } catch (error) {
            unarchiveError = error
          }
          try {
            resumed = await this.codex.resumeThread(resumeOptions)
          } catch (error) {
            throw unarchiveError || error
          }
        } else {
          try {
            resumed = await this.codex.resumeThread(resumeOptions)
          } catch (error) {
            if (!/archived.*unarchive|session .* is archived/i.test(errorText(error))) throw error
            if (knownSession) {
              await this.persistSessionLifecycleIntent(knownSession, 'resume')
              this.preserveArchivedUntilResume.add(codexThreadId)
            }
            await this.codex.unarchiveThread(codexThreadId)
            this.expectArchiveNotification(codexThreadId, 'unarchived')
            resumed = await this.codex.resumeThread(resumeOptions)
          }
        }

        if (effort && resumed.effort !== effort) {
          await this.codex.updateThreadSettings({ threadId: codexThreadId, effort })
        }

        const modelTransition = model !== undefined &&
          resumed.model !== undefined &&
          model !== resumed.model
        const resumedFastMode = resumed.serviceTier !== undefined
          ? await this.fastModeForServiceTier(resumed.model || model, resumed.serviceTier)
          : fastMode
        const replayWasBlocked = this.contextReplayBlocked.has(codexThreadId)
        const pendingUsage = this.pendingContextUsage.get(codexThreadId)
        if (modelTransition) {
          this.contextReplayBlocked.add(codexThreadId)
          this.pendingContextUsage.delete(codexThreadId)
        } else {
          this.contextReplayBlocked.delete(codexThreadId)
        }

        if (knownSession && existingChannel) {
          const previousSession = structuredClone(knownSession)
          const resumedModel = resumed.model || model
          if (resumedModel) knownSession.model = resumedModel
          const resumedEffort = effort || resumed.effort
          if (resumedEffort) knownSession.effort = resumedEffort
          if (resumedFastMode !== undefined) knownSession.fastMode = resumedFastMode
          knownSession.yoloMode = yoloMode
          delete knownSession.archived
          knownSession.updatedAt = new Date().toISOString()
          if (modelTransition) {
            delete knownSession.contextTokens
            delete knownSession.contextWindow
          }
          if (!modelTransition) this.hydratePendingContextUsage(knownSession)
          this.loadedThreads.add(codexThreadId)
          try {
            await saveState(this.state)
          } catch (error) {
            this.restoreSessionState(knownSession, previousSession)
            this.loadedThreads.delete(codexThreadId)
            if (replayWasBlocked) this.contextReplayBlocked.add(codexThreadId)
            else this.contextReplayBlocked.delete(codexThreadId)
            if (pendingUsage) this.pendingContextUsage.set(codexThreadId, pendingUsage)
            else this.pendingContextUsage.delete(codexThreadId)
            if (previousSession.archived) this.preserveArchivedUntilResume.add(codexThreadId)
            throw error
          }
          this.preserveArchivedUntilResume.delete(codexThreadId)
          const channelAvailable = await this.convergeDiscordLifecycleState(
            knownSession,
            'resume',
            false,
            'Resume existing Cordex session',
            existingChannel,
          )
          if (!channelAvailable) {
            throw new Error('Discord session thread no longer exists; run /resume again')
          }
          await this.synchronizeThreadTitle(
            knownSession,
            existingChannel,
            resumed.name || existingChannel.name,
          ).catch((error: unknown) => {
            this.logVerbose('resume title synchronization failed', {
              threadId: codexThreadId,
              error: errorText(error),
            })
            void existingChannel.send(
              '⚠ Session title synchronization failed; Cordex will retry on the next load.',
            ).catch(() => undefined)
          })
          await existingChannel.members.add(interaction.user.id).catch(() => undefined)
          queueDrain = { session: knownSession, channel: existingChannel }
          resumeReply = `Session resumed: ${existingChannel}`
          return
        }

        const thread = await this.createSessionThread({
          parentChannelId: targetParentChannelId,
          name: `${knownSession?.worktree && !knownSession.worktree.merged ? '⬦ ' : ''}${resumed.name || resumed.preview || codexThreadId.slice(0, 12)}`,
          userId: interaction.user.id,
        })
        const session = this.buildNewSessionState({
          discordThreadId: thread.id,
          parentChannelId: targetParentChannelId,
          directory,
          codexThreadId,
          ...(resumed.model || model ? { model: resumed.model || model } : {}),
        })
        const resumedEffort = effort || resumed.effort
        if (resumedEffort) session.effort = resumedEffort
        if (knownSession?.mode) session.mode = knownSession.mode
        if (knownSession?.worktree) session.worktree = { ...knownSession.worktree }
        if (knownSession?.workspaceRoots) session.workspaceRoots = [...knownSession.workspaceRoots]
        if (knownSession?.permissions) session.permissions = knownSession.permissions
        if (knownSession?.approvalsReviewer) session.approvalsReviewer = knownSession.approvalsReviewer
        if (resumedFastMode !== undefined) session.fastMode = resumedFastMode
        session.yoloMode = yoloMode
        if (
          !modelTransition &&
          knownSession?.contextTokens !== undefined &&
          session.model === knownSession.model
        ) {
          applyContextUsage(session, {
            contextTokens: knownSession.contextTokens,
            contextWindow: knownSession.contextWindow ?? null,
          })
        }
        const previousQueue = knownEntry ? this.state.queues[knownEntry[0]] : undefined
        const migratedTasks = knownEntry
          ? Object.values(this.state.tasks).filter((task) => task.threadId === knownEntry[0])
          : []
        if (knownEntry) {
          delete this.state.sessions[knownEntry[0]]
          const queued = this.state.queues[knownEntry[0]]
          if (queued) {
            const migrated = queued.filter((prompt) =>
              this.promptDeliveryKind(prompt) === 'direct' || !prompt.sourceMessageId)
            if (migrated.length > 0) this.state.queues[thread.id] = migrated
            delete this.state.queues[knownEntry[0]]
          }
          for (const task of migratedTasks) task.threadId = thread.id
        }
        this.state.sessions[thread.id] = session
        if (!modelTransition) this.hydratePendingContextUsage(session)
        this.loadedThreads.add(codexThreadId)
        try {
          await saveState(this.state)
        } catch (error) {
          delete this.state.sessions[thread.id]
          delete this.state.queues[thread.id]
          if (knownEntry && knownSession) {
            this.state.sessions[knownEntry[0]] = knownSession
            if (previousQueue) this.state.queues[knownEntry[0]] = previousQueue
            for (const task of migratedTasks) task.threadId = knownEntry[0]
          }
          this.loadedThreads.delete(codexThreadId)
          if (replayWasBlocked) this.contextReplayBlocked.add(codexThreadId)
          else this.contextReplayBlocked.delete(codexThreadId)
          if (pendingUsage) this.pendingContextUsage.set(codexThreadId, pendingUsage)
          else this.pendingContextUsage.delete(codexThreadId)
          if (knownSession?.archived) this.preserveArchivedUntilResume.add(codexThreadId)
          await thread.delete('Cordex resume state could not be saved').catch(() => undefined)
          throw error
        }
        if (knownEntry) this.clearQueuedSourceBlock(knownEntry[0])
        this.preserveArchivedUntilResume.delete(codexThreadId)
        await this.synchronizeCodexThreadTitle(codexThreadId, thread.name).catch((error: unknown) => {
          this.logVerbose('resume title synchronization failed', {
            threadId: codexThreadId,
            error: errorText(error),
          })
          void thread.send(
            '⚠ Session title synchronization failed; Cordex will retry on the next load.',
          ).catch(() => undefined)
        })
        await thread.send(`Resumed Codex session \`${codexThreadId}\`.`)
        try {
          for (const historyChunk of formatThreadHistory(resumed.turns, {
            verbosity: this.state.channelVerbosity[targetParentChannelId] || defaultVerbosity,
          })) {
            await thread.send({ content: historyChunk, allowedMentions: { parse: [] } })
          }
        } catch (error) {
          await thread.send(`⨯ History replay failed: ${truncate(errorText(error), 1_800)}`).catch(() => undefined)
        }
        queueDrain = { session, channel: thread }
        resumeReply = `Session resumed: ${thread}`
      })
    })
    if (queueDrain && (this.state.queues[queueDrain.session.discordThreadId]?.length || 0) > 0) {
      await this.recoverPersistedPrompts(queueDrain.session, queueDrain.channel).catch((error: unknown) => {
        this.logVerbose('resumed prompt recovery failed', {
          threadId: queueDrain?.session.codexThreadId,
          error: errorText(error),
        })
      })
    }
    if (resumeReply) await interaction.editReply(resumeReply)
  }

  private requireThreadSession(
    interaction: ChatInputCommandInteraction,
    allowedLifecycleIntent?: NonNullable<SessionState['lifecycleIntent']>['kind'],
  ): {
    channel: ThreadChannel
    session: SessionState
  } {
    if (!interaction.channel?.isThread()) throw new Error('Command requires a Cordex thread')
    const session = this.state.sessions[interaction.channel.id]
    if (!session) throw new Error('Thread has no Cordex session')
    if (
      session.lifecycleIntent &&
      session.lifecycleIntent.kind !== allowedLifecycleIntent
    ) {
      throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
    }
    return { channel: interaction.channel, session }
  }

  private requirePendingPromptTarget(interaction: ChatInputCommandInteraction):
    | { channel: ThreadChannel; session: SessionState; pendingInitial?: never }
    | { channel: ThreadChannel; session?: never; pendingInitial: PendingInitialSession } {
    if (!interaction.channel?.isThread() || interaction.channel.guildId !== this.config.guildId) {
      throw new Error('Command requires a Cordex thread in the configured server')
    }
    if (this.state.sessions[interaction.channel.id]) return this.requireThreadSession(interaction)
    const pendingInitial = this.state.pendingInitialSessions?.[interaction.channel.id]
    if (!pendingInitial || interaction.channel.parentId !== pendingInitial.parentChannelId ||
      !this.config.projects[pendingInitial.parentChannelId]) {
      throw new Error('Thread has no Cordex session or pending session creation')
    }
    return { channel: interaction.channel, pendingInitial }
  }

  private restoreSessionState(target: SessionState, snapshot: SessionState): void {
    const mutable = target as unknown as Record<string, unknown>
    for (const key of Object.keys(mutable)) delete mutable[key]
    Object.assign(target, structuredClone(snapshot))
  }

  private consumeExpectedTitle(
    expectations: Map<string, string>,
    recent: Map<string, Map<string, number>>,
    key: string,
    title: string,
  ): 'expected' | 'recent' | 'none' {
    const expected = expectations.get(key)
    if (expected === title) {
      expectations.delete(key)
      this.rememberTitleEcho(recent, key, title)
      return 'expected'
    }
    const echoes = recent.get(key)
    const expiresAt = echoes?.get(title)
    if (expiresAt !== undefined) {
      echoes?.delete(title)
      if (echoes?.size === 0) recent.delete(key)
      if (expiresAt > Date.now()) return 'recent'
    }
    if (expected !== undefined) {
      expectations.delete(key)
      this.rememberTitleEcho(recent, key, expected)
    }
    return 'none'
  }

  private rememberTitleEcho(
    recent: Map<string, Map<string, number>>,
    key: string,
    title: string,
  ): void {
    const echoes = recent.get(key) || new Map<string, number>()
    const now = Date.now()
    for (const [value, expiresAt] of echoes) {
      if (expiresAt <= now) echoes.delete(value)
    }
    echoes.set(title, now + 30_000)
    recent.set(key, echoes)
  }

  private expectTitle(
    expectations: Map<string, string>,
    recent: Map<string, Map<string, number>>,
    key: string,
    title: string,
  ): void {
    const previous = expectations.get(key)
    if (previous !== undefined && previous !== title) {
      this.rememberTitleEcho(recent, key, previous)
    }
    expectations.set(key, title)
  }

  private discardExpectedTitle(
    expectations: Map<string, string>,
    recent: Map<string, Map<string, number>>,
    key: string,
  ): void {
    const expected = expectations.get(key)
    if (expected === undefined) return
    expectations.delete(key)
    this.rememberTitleEcho(recent, key, expected)
  }

  private async writeDiscordThreadTitle(channel: ThreadChannel, title: string): Promise<void> {
    if (channel.name === title) {
      this.pendingDiscordTitles.delete(channel.id)
      return
    }
    this.expectTitle(
      this.expectedDiscordTitles,
      this.recentDiscordTitleEchoes,
      channel.id,
      title,
    )
    try {
      await channel.setName(title, 'Synchronize Cordex session title')
      this.pendingDiscordTitles.delete(channel.id)
    } catch (error) {
      if (this.expectedDiscordTitles.get(channel.id) === title) {
        this.expectedDiscordTitles.delete(channel.id)
      }
      throw error
    }
  }

  private async writeCodexThreadTitle(threadId: string, title: string): Promise<void> {
    this.expectTitle(
      this.expectedCodexTitles,
      this.recentCodexTitleEchoes,
      threadId,
      title,
    )
    try {
      await this.codex.setThreadName(threadId, title)
      this.pendingCodexTitles.delete(threadId)
    } catch (error) {
      if (this.expectedCodexTitles.get(threadId) === title) {
        this.expectedCodexTitles.delete(threadId)
      }
      throw error
    }
  }

  private async synchronizeThreadTitleUnlocked(
    session: SessionState,
    channel: ThreadChannel,
    value: string,
    options: {
      codex?: boolean
      discord?: boolean
      previousTitle?: string
      rollbackCodexOnDiscordFailure?: boolean
    } = {},
  ): Promise<string> {
    const title = normalizeThreadTitle(value)
    const previousTitle = normalizeThreadTitle(options.previousTitle ?? channel.name)
    let codexWritten = false
    if (options.codex === false) this.pendingCodexTitles.delete(session.codexThreadId)
    if (options.codex !== false) {
      try {
        await this.writeCodexThreadTitle(session.codexThreadId, title)
        codexWritten = true
      } catch (error) {
        this.pendingCodexTitles.set(session.codexThreadId, title)
        throw error
      }
    }
    if (options.discord === false) this.pendingDiscordTitles.delete(channel.id)
    if (options.discord !== false) {
      try {
        await this.writeDiscordThreadTitle(channel, title)
      } catch (firstError) {
        try {
          await this.writeDiscordThreadTitle(channel, title)
        } catch (secondError) {
          if (codexWritten && options.rollbackCodexOnDiscordFailure !== false) {
            this.expectedCodexTitles.delete(session.codexThreadId)
            try {
              await this.writeCodexThreadTitle(session.codexThreadId, previousTitle)
            } catch (rollbackError) {
              this.pendingCodexTitles.set(session.codexThreadId, previousTitle)
              this.logVerbose('title compensation failed', {
                threadId: session.codexThreadId,
                error: errorText(rollbackError),
              })
            }
          } else {
            this.pendingDiscordTitles.set(channel.id, title)
          }
          throw secondError || firstError
        }
      }
    }
    return title
  }

  private async synchronizeThreadTitle(
    session: SessionState,
    channel: ThreadChannel,
    value: string,
  ): Promise<string> {
    return this.titleQueue.run(session.codexThreadId, async () => {
      const current = this.state.sessions[channel.id]
      if (
        current?.codexThreadId !== session.codexThreadId ||
        current.archived ||
        this.deletedDiscordThreads.has(channel.id)
      ) {
        throw new Error('Session is no longer available for rename')
      }
      return this.synchronizeThreadTitleUnlocked(current, channel, value)
    })
  }

  private async synchronizeCodexThreadTitle(threadId: string, value: string): Promise<string> {
    const title = normalizeThreadTitle(value)
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.titleQueue.run(threadId, () => this.writeCodexThreadTitle(threadId, title))
        return title
      } catch (error) {
        lastError = error
      }
    }
    this.pendingCodexTitles.set(threadId, title)
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async handleDiscordThreadTitleUpdate(
    channel: ThreadChannel,
    previousName?: string,
  ): Promise<void> {
    const title = normalizeThreadTitle(channel.name)
    const session = this.state.sessions[channel.id]
    if (!session || session.archived || this.deletedDiscordThreads.has(channel.id)) return
    await this.titleQueue.run(session.codexThreadId, async () => {
      const current = this.state.sessions[channel.id]
      if (
        current?.codexThreadId !== session.codexThreadId ||
        current.archived ||
        current.abortIntent ||
        this.deletedDiscordThreads.has(channel.id)
      ) return
      if (this.pendingDiscordTitleVerifications.has(channel.id)) {
        this.deferDiscordTitleVerification(current, title)
        return
      }
      const echo = this.consumeExpectedTitle(
        this.expectedDiscordTitles,
        this.recentDiscordTitleEchoes,
        channel.id,
        title,
      )
      if (echo === 'expected') return
      let authoritativeChannel = channel
      let authoritativeTitle = title
      if (echo === 'recent') {
        const authoritative = await this.client.channels.fetch(channel.id, { force: true })
          .catch(() => undefined)
        if (!authoritative?.isThread()) {
          this.deferDiscordTitleVerification(current, title)
          return
        }
        const latest = this.state.sessions[channel.id]
        if (
          latest?.codexThreadId !== current.codexThreadId ||
          latest.archived ||
          this.deletedDiscordThreads.has(channel.id)
        ) return
        authoritativeTitle = normalizeThreadTitle(authoritative.name)
        if (authoritativeTitle === title) {
          this.discardExpectedTitle(
            this.expectedDiscordTitles,
            this.recentDiscordTitleEchoes,
            channel.id,
          )
        } else {
          this.rememberTitleEcho(this.recentDiscordTitleEchoes, channel.id, title)
          return
        }
        authoritativeChannel = authoritative
      }
      await this.synchronizeThreadTitleUnlocked(current, authoritativeChannel, authoritativeTitle, {
        discord: authoritativeChannel.name !== authoritativeTitle,
        rollbackCodexOnDiscordFailure: false,
        ...(previousName !== undefined ? { previousTitle: previousName } : {}),
      })
    })
  }

  private async handleRenameCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    const title = await this.synchronizeThreadTitle(
      session,
      channel,
      interaction.options.getString('name', true),
    )
    await interaction.reply(`Session renamed to **${escapeInlineMarkdown(title)}**.`)
  }

  private async forkSession(options: {
    source: SessionState
    sourceThreadId?: string
    parentChannelId: string
    name: string
    userId: string
  }): Promise<{ thread: ThreadChannel; session: SessionState }> {
    const runtimeRoots = this.runtimeWorkspaceRoots(options.source)
    const isSubagentFork = options.sourceThreadId !== undefined
    const yoloMode = options.source.yoloMode === true
    const serviceTier = await this.serviceTierForFastMode(
      options.source.model || this.config.defaultModel,
      options.source.fastMode,
    )
    const forked = await this.codex.forkThread({
      threadId: options.sourceThreadId || options.source.codexThreadId,
      cwd: options.source.directory,
      ...(!isSubagentFork && options.source.model ? { model: options.source.model } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
      ...(!yoloMode && options.source.permissions
        ? { permissions: options.source.permissions }
        : { sandbox: yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
      approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
      ...(options.source.approvalsReviewer ? { approvalsReviewer: options.source.approvalsReviewer } : {}),
    })
    const modelTransition = !isSubagentFork && options.source.model !== undefined &&
      options.source.model !== forked.model
    const forkEffort = isSubagentFork
      ? forked.effort
      : options.source.effort || forked.effort
    const thread = await this.createSessionThread({
      parentChannelId: options.parentChannelId,
      name: options.name,
      userId: options.userId,
    })
    const session: SessionState = {
      discordThreadId: thread.id,
      parentChannelId: options.parentChannelId,
      directory: options.source.directory,
      codexThreadId: forked.threadId,
      model: isSubagentFork ? forked.model : options.source.model || forked.model,
      ...(forkEffort ? { effort: forkEffort } : {}),
      ...(!isSubagentFork && options.source.mode ? { mode: options.source.mode } : {}),
      ...(options.source.fastMode !== undefined ? { fastMode: options.source.fastMode } : {}),
      ...(options.source.yoloMode !== undefined ? { yoloMode: options.source.yoloMode } : {}),
      ...(options.source.workspaceRoots ? { workspaceRoots: [...options.source.workspaceRoots] } : {}),
      ...(options.source.permissions ? { permissions: options.source.permissions } : {}),
      ...(options.source.approvalsReviewer ? { approvalsReviewer: options.source.approvalsReviewer } : {}),
      updatedAt: new Date().toISOString(),
    }
    if (modelTransition) {
      this.contextReplayBlocked.add(forked.threadId)
      this.pendingContextUsage.delete(forked.threadId)
    } else {
      this.contextReplayBlocked.delete(forked.threadId)
    }
    this.state.sessions[thread.id] = session
    if (!modelTransition) this.hydratePendingContextUsage(session)
    this.loadedThreads.add(forked.threadId)
    await saveState(this.state)
    await this.synchronizeCodexThreadTitle(forked.threadId, thread.name).catch((error: unknown) => {
      this.logVerbose('fork title synchronization failed', {
        threadId: forked.threadId,
        error: errorText(error),
      })
      void thread.send(
        '⚠ Session title synchronization failed; Cordex will retry on the next load.',
      ).catch(() => undefined)
    })
    return { thread, session }
  }

  private async handleForkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    await interaction.deferReply()
    const forked = await this.forkSession({
      source: session,
      parentChannelId: session.parentChannelId,
      name: `Fork: ${channel.name}`,
      userId: interaction.user.id,
    })
    await interaction.editReply(`Session forked: ${forked.thread}`)
  }

  private subagentLabel(subagent: CodexSubagentThread): string {
    const agent = subagent.agentPath?.split('/').filter(Boolean).at(-1)
    return truncate((agent || subagent.prompt || `subagent ${subagent.threadId.slice(0, 8)}`)
      .replace(/\s+/g, ' ').trim(), 100)
  }

  private async handleSubagentsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await interaction.deferReply({ ephemeral: true })
    const subagents = await this.codex.listSubagentThreads(session.codexThreadId)
    const shown = subagents.slice(0, 25)
    const lines = shown.map((subagent, index) => {
      const label = escapeInlineMarkdown(this.subagentLabel(subagent).replace(/\s+/g, ' '))
      const status = subagent.status || subagent.activity || 'status unknown'
      return `${index + 1}. **${label}** — ${discordInlineCode(status)}\n${discordInlineCode(subagent.threadId)}`
    })
    await this.replyWithChunks(
      interaction,
      `${subagents.length} Codex subagent${subagents.length === 1 ? '' : 's'} found${subagents.length > shown.length ? `; showing the newest ${shown.length}` : ''}.\n${lines.join('\n') || 'No subagent tasks found in this session.'}\nUse /fork-subagent to continue one in a new Discord thread.`,
      { ephemeral: true },
    )
  }

  private async handleForkSubagentCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await interaction.deferReply()
    const subagents = (await this.codex.listSubagentThreads(session.codexThreadId)).slice(0, 25)
    if (subagents.length === 0) {
      await interaction.editReply('No Codex subagent tasks found in this session.')
      return
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`fork-subagent:${session.codexThreadId}`)
      .setPlaceholder('Select a Codex subagent to fork')
      .addOptions(
        subagents.map((subagent) => ({
          label: this.subagentLabel(subagent),
          value: subagent.threadId,
          description: truncate(
            subagent.prompt || `${subagent.status || subagent.activity || 'known'} · ${subagent.threadId}`,
            100,
          ),
        })),
      )
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
    await interaction.editReply({
      content: '**Fork Codex subagent**\nSelect a task to continue in a new Discord thread.',
      components: [row],
    })
  }

  private async handleForkSubagentSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: 'Subagent fork requires a Cordex thread.' })
      return
    }
    const session = this.state.sessions[interaction.channel.id]
    if (!session) {
      await interaction.reply({ content: 'Thread has no Cordex session.' })
      return
    }
    const expectedParentThreadId = interaction.customId.slice('fork-subagent:'.length)
    if (expectedParentThreadId !== session.codexThreadId) {
      await interaction.reply({ content: 'This subagent list is stale. Run /fork-subagent again.' })
      return
    }
    const childThreadId = interaction.values[0]
    if (!childThreadId) {
      await interaction.reply({ content: 'No subagent selected.' })
      return
    }
    await interaction.deferReply()
    await this.waitForMutationIngressReady()
    const currentSession = this.state.sessions[interaction.channel.id]
    if (!currentSession || currentSession.codexThreadId !== expectedParentThreadId) {
      await interaction.editReply('This subagent list is stale. Run /fork-subagent again.')
      return
    }
    const selected = (await this.codex.listSubagentThreads(currentSession.codexThreadId))
      .find((subagent) => subagent.threadId === childThreadId)
    if (!selected) {
      await interaction.editReply('Selected subagent is no longer available.')
      return
    }
    const forked = await this.forkSession({
      source: currentSession,
      sourceThreadId: selected.threadId,
      parentChannelId: currentSession.parentChannelId,
      name: `Fork: ${this.subagentLabel(selected)}`,
      userId: interaction.user.id,
    })
    await forked.thread.send(
      `Forked Codex subagent \`${selected.threadId}\`. Continue its task from this thread.`,
    )
    try {
      const turns = await this.codex.listThreadTurns(forked.session.codexThreadId, 30)
      for (const historyChunk of formatThreadHistory(turns, {
        verbosity: this.verbosityFor(forked.session),
      })) {
        await forked.thread.send({ content: historyChunk, allowedMentions: { parse: [] } })
      }
    } catch (error) {
      await forked.thread.send(`⨯ History replay failed: ${truncate(errorText(error), 1_800)}`).catch(() => undefined)
    }
    await interaction.editReply(`Subagent forked: ${forked.thread}`)
  }

  private async handleBtwCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    const prompt = interaction.options.getString('prompt', true)
    await interaction.deferReply()
    const forked = await this.forkSession({
      source: session,
      parentChannelId: session.parentChannelId,
      name: `BTW: ${prompt}`,
      userId: interaction.user.id,
    })
    await this.dispatchInput(
      forked.thread,
      session.parentChannelId,
      [
        {
          type: 'text',
          text: `Answer only this side question. Do not continue the previous task.\n\n${prompt}`,
          text_elements: [],
        },
      ],
      interaction.id,
    )
    await interaction.editReply(`Side session started: ${forked.thread}`)
  }

  private async handleCompactCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    await interaction.deferReply()
    await this.ensureSessionLoaded(session)
    const contextVersion = this.contextUsageVersion(session.codexThreadId)
    await this.codex.compactThread(session.codexThreadId)
    if (this.invalidateContextUsageUnlessUpdated(session, contextVersion)) await saveState(this.state)
    await interaction.editReply('📦 Session compacted.')
  }

  private formatGoal(goal: import('./codex-app-server.js').CodexThreadGoal): string {
    const budget = goal.tokenBudget
      ? `${goal.tokensUsed.toLocaleString('en-US')} / ${goal.tokenBudget.toLocaleString('en-US')} tokens`
      : `${goal.tokensUsed.toLocaleString('en-US')} tokens`
    return `**Goal:** ${goal.objective}\n**Status:** ${goal.status}\n**Usage:** ${budget} · ${formatDuration(goal.timeUsedSeconds * 1_000)}`
  }

  private async handleGoalCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    const objective = interaction.options.getString('objective')?.trim()
    const tokenBudget = interaction.options.getInteger('token-budget') ?? undefined
    const status = interaction.options.getString('status') as
      'active' | 'paused' | 'blocked' | 'complete' | null
    if (session.abortIntent && (objective || tokenBudget !== undefined || status)) {
      throw new Error('Turn abort is still pending')
    }
    await interaction.deferReply()
    let goal
    let mutated = false
    if (objective || tokenBudget !== undefined || status) {
      mutated = true
      if (!objective) {
        const existing = await this.codex.getThreadGoal(session.codexThreadId)
        if (!existing) throw new Error('No thread goal is set; provide an objective')
      }
      goal = await this.codex.setThreadGoal(session.codexThreadId, {
        ...(objective ? { objective } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(status ? { status } : {}),
      })
    } else {
      const existing = await this.codex.getThreadGoal(session.codexThreadId)
      goal = existing
    }
    if (mutated && goal?.status === 'active') await this.ensureSessionLoaded(session)
    await interaction.editReply(goal ? this.formatGoal(goal) : 'No thread goal is set.')
  }

  private async handleClearGoalCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await interaction.deferReply()
    const cleared = await this.codex.clearThreadGoal(session.codexThreadId)
    await interaction.editReply(cleared ? 'Thread goal cleared.' : 'No thread goal was set.')
  }

  private async handleArchiveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction, 'archive')
    await interaction.deferReply()
    if (session.archived && !session.lifecycleIntent) {
      await this.persistSessionLifecycleIntent(session, 'archive')
      await this.convergeDiscordLifecycleState(
        session,
        'archive',
        true,
        'Archived by Cordex user',
        channel,
      )
      await interaction.editReply('Session is already archived.')
      return
    }

    await this.promptQueue.run(channel.id, async () => {
      if (session.activeTurnId || this.runs.has(session.codexThreadId)) {
        throw new Error('Wait for active turn or run /abort first')
      }
      if (this.pendingTurnStarts.has(session.codexThreadId)) {
        throw new Error('Wait for the pending turn start or run /abort first')
      }
      if (this.queuedPromptsFor(channel.id).length > 0) {
        throw new Error('Clear queued prompts before archiving')
      }
      if ((this.state.queues[channel.id] || []).some(
        (prompt) => this.promptDeliveryKind(prompt) === 'direct',
      )) {
        throw new Error('Wait for pending prompt delivery or recovery before archiving')
      }
      const pendingTask = Object.values(this.state.tasks).find(
        (task) => task.threadId === channel.id &&
          (task.status === 'scheduled' || task.status === 'running'),
      )
      if (pendingTask) throw new Error(`Cancel scheduled task ${pendingTask.id} before archiving`)
      this.archivingDiscordThreads.add(channel.id)
    })

    try {
      await this.resumeQueue.run(session.codexThreadId, async () => {
        await this.codexEventQueue.run(session.codexThreadId, async () => {
          if (session.activeTurnId || this.runs.has(session.codexThreadId)) {
            throw new Error('Wait for active turn or run /abort first')
          }
          if (this.pendingTurnStarts.has(session.codexThreadId)) {
            throw new Error('Wait for the pending turn start or run /abort first')
          }
          const goal = await this.codex.getThreadGoal(session.codexThreadId)
          if (goal?.status === 'active') throw new Error('Pause, complete, or clear the active goal before archiving')
          await this.persistSessionLifecycleIntent(session, 'archive')
          await this.codex.archiveThread(session.codexThreadId)
          this.expectArchiveNotification(session.codexThreadId, 'archived')
          await this.finalizeArchivedSession(session)
          await this.convergeDiscordLifecycleState(
            session,
            'archive',
            true,
            'Archived by Cordex user',
            channel,
          )
        })
      })
      await interaction.editReply('Session archived.')
    } finally {
      this.archivingDiscordThreads.delete(channel.id)
    }
  }

  private async handleDeleteSessionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    const confirmedId = interaction.options.getString('confirm-session-id', true).trim()
    if (confirmedId !== session.codexThreadId) {
      throw new Error('Confirmation must match this exact Codex session ID. Use /session-id to copy it.')
    }
    await interaction.deferReply({ ephemeral: true })
    await this.promptQueue.run(channel.id, async () => {
      if (this.state.sessions[channel.id] !== session) {
        throw new Error('The Discord thread is no longer linked to this Codex session')
      }
      if (session.activeTurnId || this.runs.has(session.codexThreadId)) {
        throw new Error('Wait for the active turn or run /abort before deleting')
      }
      if (this.pendingTurnStarts.has(session.codexThreadId)) {
        throw new Error('Wait for the pending turn start or run /abort before deleting')
      }
      if (session.abortIntent) throw new Error('Turn abort is still pending')
      const prompts = this.state.queues[channel.id] || []
      if (prompts.some((prompt) => this.promptDeliveryKind(prompt) === 'queued')) {
        throw new Error('Clear queued prompts before deleting')
      }
      if (prompts.some((prompt) => this.promptDeliveryKind(prompt) === 'direct')) {
        throw new Error('Wait for pending prompt delivery or recovery before deleting')
      }
      const pendingTask = Object.values(this.state.tasks).find(
        (task) => task.threadId === channel.id &&
          (task.status === 'scheduled' || task.status === 'running'),
      )
      if (pendingTask) throw new Error(`Cancel scheduled task ${pendingTask.id} before deleting`)
      if (!session.archived) await this.ensureSessionLoaded(session)
      const runtime = await this.codex.getThreadRuntimeState(session.codexThreadId)
      if (runtime.status === 'active') throw new Error('Codex still reports an active turn; run /abort first')
      if (runtime.status === 'systemError') throw new Error('Codex thread status is unavailable; deletion was not started')
      const terminals = await this.codex.listBackgroundTerminals(session.codexThreadId)
      if (terminals.length > 0) throw new Error('Stop background terminals with /stop before deleting')
      if (!session.archived) {
        const goal = await this.codex.getThreadGoal(session.codexThreadId)
        if (goal?.status === 'active') {
          throw new Error('Pause, complete, or clear the active goal before deleting')
        }
      }
      await this.persistDeletedThreadIntent(session, 'delete')
    })
    await this.reconcileDeletedThreadIntents(new Set([channel.id]))
    if (this.state.sessions[channel.id]?.codexThreadId === session.codexThreadId) {
      throw new Error('Session deletion is still pending; Cordex will retry during recovery')
    }
    const warnings: string[] = []
    await channel.send({
      content: 'This Codex session transcript was permanently deleted. Project files and Discord history remain; this thread is no longer linked.',
      allowedMentions: { parse: [] },
    }).catch((error: unknown) => warnings.push(`Discord notice failed: ${errorText(error)}`))
    await channel.setArchived(true, 'Codex session deleted by Cordex user')
      .catch((error: unknown) => warnings.push(`Discord archiving failed: ${errorText(error)}`))
    await interaction.editReply(
      `Deleted Codex session ${discordInlineCode(session.codexThreadId)} and its spawned descendants. Project files and Discord history were kept.${warnings.length ? ` ${warnings.join('; ')}` : ''}`,
    )
  }

  private async handleReviewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.abortIntent) throw new Error('Turn abort is still pending')
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    const kind = interaction.options.getString('target') || 'uncommitted'
    const branch = interaction.options.getString('branch')
    const instructions = interaction.options.getString('instructions')
    const commit = interaction.options.getString('commit')
    const title = interaction.options.getString('title')?.trim()
    if (!['uncommitted', 'base', 'commit', 'custom'].includes(kind)) throw new Error('Unknown review target')
    if (kind !== 'base' && branch) throw new Error('Branch option requires target=base')
    if (kind !== 'custom' && instructions) throw new Error('Instructions option requires target=custom')
    if (kind !== 'commit' && (commit || title)) throw new Error('Commit and title options require target=commit')
    let target: ReviewTarget
    if (kind === 'base') {
      if (!branch?.trim()) throw new Error('Base review requires branch option')
      target = { type: 'baseBranch', branch: branch.trim() }
    } else if (kind === 'commit') {
      if (!commit?.trim()) throw new Error('Commit review requires commit option')
      target = { type: 'commit', sha: commit, ...(title ? { title } : {}) }
    } else if (kind === 'custom') {
      if (!instructions?.trim()) throw new Error('Custom review requires instructions option')
      target = { type: 'custom', instructions }
    } else {
      target = { type: 'uncommittedChanges' }
    }
    await interaction.deferReply()
    if (target.type === 'commit') {
      target.sha = await resolveGitCommit({ cwd: session.directory, revision: target.sha })
    }
    await this.ensureSessionLoaded(session)
    const review = await this.codex.startReview({
      threadId: session.codexThreadId,
      target,
      delivery: 'inline',
    })
    session.activeTurnId = review.turnId
    session.updatedAt = new Date().toISOString()
    this.startRun(session, channel)
    await saveState(this.state)
    await interaction.editReply(target.type === 'commit'
      ? `Review started (commit ${discordInlineCode(target.sha)}).`
      : `Review started (${kind}).`)
  }

  private async handleRollbackCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    if (session.abortIntent) throw new Error('Turn abort is still pending')
    const turns = interaction.options.getInteger('turns', true)
    await interaction.deferReply()
    const previous = structuredClone(session)
    const forked = await this.codex.rollbackThread(session.codexThreadId, turns)
    session.codexThreadId = forked.threadId
    session.model = forked.model
    if (!session.effort && forked.effort) session.effort = forked.effort
    this.clearContextUsage(session)
    this.hydratePendingContextUsage(session)
    session.updatedAt = new Date().toISOString()
    try {
      await saveState(this.state)
    } catch (error) {
      this.restoreSessionState(session, previous)
      await this.codex.deleteThread(forked.threadId).catch((cleanupError: unknown) => {
        this.logVerbose('rollback fork cleanup failed', {
          threadId: forked.threadId,
          error: errorText(cleanupError),
        })
      })
      throw error
    }
    this.loadedThreads.add(forked.threadId)
    await this.synchronizeCodexThreadTitle(forked.threadId, channel.name).catch((error: unknown) => {
      this.logVerbose('rollback fork title synchronization failed', {
        threadId: forked.threadId,
        error: errorText(error),
      })
    })
    await interaction.editReply(
      `Current session continues before the last ${turns} turn${turns === 1 ? '' : 's'}. Files unchanged. Previous Codex session: \`${previous.codexThreadId}\`.`,
    )
  }

  private async handleDiffCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await interaction.deferReply()
    const result = await readGitDiff({
      cwd: directory,
      maxBytes: discordDiffPartBytes * maxDiscordDiffParts,
    })
    if (result.tooLarge) {
      throw new Error(
        `Git diff exceeds the ${discordDiffPartBytes * maxDiscordDiffParts}-byte Discord delivery limit`,
      )
    }
    if (result.exitCode !== 0 || result.timedOut) {
      await interaction.editReply({
        content: `Could not create a complete Git diff${result.timedOut ? ' (timed out)' : ''}: ${truncate(result.stderr || 'Git diff failed', 1_800)}`,
        allowedMentions: { parse: [] },
      })
      return
    }
    if (result.patch.length === 0) {
      await interaction.editReply('No uncommitted changes.')
      return
    }
    const inlinePatch = result.patch.toString('utf8')
    if (
      result.patch.length <= 1_500 &&
      !inlinePatch.includes('```') &&
      Buffer.from(inlinePatch, 'utf8').equals(result.patch)
    ) {
      await interaction.editReply({
        content: `Complete Git diff:\n\`\`\`diff\n${inlinePatch}\n\`\`\``,
        allowedMentions: { parse: [] },
      })
      return
    }
    const files: Array<{ attachment: Buffer; name: string }> = []
    for (let offset = 0; offset < result.patch.length; offset += discordDiffPartBytes) {
      const index = files.length + 1
      files.push({
        attachment: result.patch.subarray(offset, offset + discordDiffPartBytes),
        name: result.patch.length <= discordDiffPartBytes
          ? 'cordex.diff'
          : `cordex.part-${String(index).padStart(2, '0')}.diff`,
      })
    }
    await interaction.editReply({
      content: `Complete git diff attached (${result.patch.length.toLocaleString('en-US')} bytes${files.length > 1 ? ` in ${files.length} parts` : ''}).`,
      files,
    })
  }

  private async handleScheduleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel } = this.requireThreadSession(interaction)
    const prompt = interaction.options.getString('prompt', true)
    const delaySeconds = interaction.options.getInteger('delay-seconds', true)
    const repeatSeconds = interaction.options.getInteger('repeat-seconds')
    if (delaySeconds < 1) throw new Error('Delay must be at least one second')
    if (repeatSeconds !== null && repeatSeconds < 1) throw new Error('Repeat interval must be at least one second')
    const task: ScheduledTask = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      threadId: channel.id,
      prompt,
      runAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
      ...(repeatSeconds !== null ? { repeatMs: repeatSeconds * 1_000 } : {}),
      createdBy: interaction.user.id,
      status: 'scheduled',
    }
    this.state.tasks[task.id] = task
    try {
      await saveState(this.state)
    } catch (error) {
      if (this.state.tasks[task.id] === task) delete this.state.tasks[task.id]
      throw error
    }
    this.scheduler.schedule(task)
    await interaction.reply({
      content: `Scheduled \`${task.id}\` for <t:${Math.floor(Date.parse(task.runAt) / 1_000)}:R>${task.repeatMs ? `; repeats every ${repeatSeconds}s` : ''}.`,
    })
  }

  private async handleTasksCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const tasks = filterScheduledTasks(
      Object.values(this.state.tasks),
      interaction.options.getBoolean('all') === true,
    )
    if (tasks.length === 0) {
      await interaction.reply({ content: 'No scheduled tasks.' })
      return
    }
    const batches: Array<{
      content: string
      components: ActionRowBuilder<ButtonBuilder>[]
    }> = []
    let lines: string[] = []
    let components: ActionRowBuilder<ButtonBuilder>[] = []
    const flush = () => {
      if (lines.length === 0) return
      batches.push({ content: lines.join('\n'), components })
      lines = []
      components = []
    }
    for (const task of tasks) {
      const line = `\`${task.id}\` · **${task.status}** · <#${task.threadId}> · <t:${Math.floor(Date.parse(task.runAt) / 1_000)}:R> · ${truncate(task.prompt, 120)}`
      if (components.length >= 5 || [...lines, line].join('\n').length > 1_850) flush()
      lines.push(line)
      const row = new ActionRowBuilder<ButtonBuilder>()
      if (task.status === 'scheduled') {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`task:run:${task.id}`)
            .setLabel('Run now')
            .setStyle(ButtonStyle.Primary),
        )
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`task:delete:${task.id}`)
          .setLabel(task.status === 'running' ? 'Cancel' : 'Delete')
          .setStyle(task.status === 'running' ? ButtonStyle.Secondary : ButtonStyle.Danger),
      )
      components.push(row)
    }
    flush()
    const first = batches.shift()
    if (!first) return
    await interaction.reply(first)
    for (const batch of batches) await interaction.followUp(batch)
  }

  private async handleCancelTaskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString('id', true)
    if (!(await this.scheduler.cancel(id))) throw new Error(`Unknown task: ${id}`)
    await interaction.reply({ content: `Cancelled \`${id}\`.` })
  }

  private resolveSkillSelection(
    skills: CodexSkillMetadata[],
    selected: string,
  ): CodexSkillMetadata {
    const exact = skills.filter((skill) => skill.name === selected)
    const matches = exact.length > 0
      ? exact
      : skills.filter((skill) => skill.name.toLowerCase() === selected.toLowerCase())
    if (matches.length === 0) throw new Error(`Unknown Codex skill: ${selected}`)
    if (matches.length > 1) {
      throw new Error(`Ambiguous Codex skill name: ${selected}`)
    }
    const skill = matches[0]
    if (!skill) throw new Error(`Unknown Codex skill: ${selected}`)
    if (!skill.enabled) throw new Error(`Codex skill is disabled: ${skill.name}`)
    return skill
  }

  private async handleSkillCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.archived) throw new Error('Session is archived; run /resume first')
    const selected = interaction.options.getString('skill', true).trim()
    const prompt = interaction.options.getString('prompt')?.trim()
    const { skills } = await this.directorySkills(session.directory, {
      refresh: true,
      forceReload: true,
    })
    const skill = this.resolveSkillSelection(skills, selected)
    const input: UserInput[] = [{
      type: 'skill',
      name: skill.name,
      path: path.resolve(session.directory, skill.path),
    }]
    if (prompt) input.push({ type: 'text', text: prompt, text_elements: [] })
    await this.persistAndDeliverDirectPrompt(session, channel, {
      id: interaction.id,
      authorId: interaction.user.id,
      authorName: interaction.user.displayName,
      input,
      displayText: prompt || `[${skill.name} skill]`,
      createdAt: new Date().toISOString(),
      deliveryKind: 'direct',
    })
    await interaction.reply({
      content: `Invoked Codex skill ${discordInlineCode(skill.name)}.`,
    })
  }

  private async handleSkillsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await interaction.deferReply()
    const { skills, errors } = await this.directorySkills(directory, {
      refresh: true,
      forceReload: true,
    })
    const lines = skills.map((skill) => {
      const enabled = skill.enabled ? 'enabled' : 'disabled'
      const displayName = this.skillDisplayName(skill)
      const description = skill.interface?.shortDescription ||
        skill.shortDescription ||
        skill.description
      const label = displayName === skill.name
        ? discordInlineCode(skill.name)
        : `**${escapeInlineMarkdown(displayName)}** (${discordInlineCode(skill.name)})`
      return `• ${label} — ${skill.scope}, ${enabled}${description ? ` — ${truncate(description, 110)}` : ''}`
    })
    for (const error of errors) {
      lines.push(`⚠ ${discordInlineCode(truncate(error.path, 120))} — ${truncate(error.message, 180)}`)
    }
    await this.replyWithChunks(interaction, lines.join('\n') || 'No Codex skills found.')
  }

  private async handleSkillToggleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    const skillName = interaction.options.getString('skill', true)
    const enabled = interaction.options.getBoolean('enabled', true)
    await interaction.deferReply({ ephemeral: true })
    const { skills } = await this.directorySkills(directory, {
      refresh: true,
      forceReload: true,
    })
    const matches = skills.filter((skill) => skill.name === skillName)
    if (matches.length === 0) throw new Error(`Unknown Codex skill: ${skillName}`)
    if (matches.length > 1) throw new Error(`Codex skill name is ambiguous: ${skillName}`)
    const skill = matches[0]!
    const result = await this.codex.writeSkillConfig({ path: skill.path, enabled })
    this.invalidateSkillCache()
    const requested = enabled ? 'enabled' : 'disabled'
    const effective = result.effectiveEnabled ? 'enabled' : 'disabled'
    await interaction.editReply(
      `Codex skill **${this.skillDisplayName(skill)}** ${requested}.` +
      (effective !== requested
        ? ` Effective state remains **${effective}** because another config layer overrides it.`
        : ''),
    )
  }

  private async handleSkillRootsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const rawPaths = interaction.options.getString('paths') || ''
    const requested = [...new Set(
      rawPaths.split(',').map((value) => value.trim()).filter(Boolean),
    )]
    if (requested.length > 25) throw new Error('Specify at most 25 skill roots')
    await interaction.deferReply({ ephemeral: true })
    const roots = await Promise.all(requested.map((value) => assertDirectory(value)))
    await this.codex.setSkillsExtraRoots(roots)
    this.invalidateSkillCache()
    await interaction.editReply(
      roots.length > 0
        ? `Runtime Codex skill roots set:\n${roots.map((root) => `• \`${root}\``).join('\n')}`
        : 'Runtime Codex skill roots cleared.',
    )
  }

  private async handlePluginsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireProject(this.parentChannelId(interaction.channel))
    await interaction.deferReply({ ephemeral: true })
    const query = interaction.options.getString('query')?.trim().toLowerCase() || ''
    const includeAvailable = interaction.options.getBoolean('include-available') === true
    const catalog = await listCodexCliPlugins(includeAvailable,
      this.options.pluginCliEnv ? { env: this.options.pluginCliEnv } : {})
    const entries = [...catalog.installed, ...(includeAvailable ? catalog.available : [])]
    const matched = entries.filter((plugin) =>
      `${plugin.name} ${plugin.pluginId} ${plugin.marketplaceName}`.toLowerCase().includes(query))
    const shown = matched.slice(0, 20)
    const lines = shown.map((plugin) => {
      const status = plugin.installed
        ? plugin.enabled ? 'installed, enabled' : 'installed, disabled'
        : plugin.installPolicy === 'NOT_AVAILABLE' ? 'unavailable' : 'available'
      return `• **${escapeInlineMarkdown(truncate(plugin.name.replace(/\s+/g, ' '), 75))}** — ${discordInlineCode(plugin.pluginId)} — ${status}`
    })
    const summary = `${catalog.installed.length} installed; ${includeAvailable ? `${catalog.available.length} additional catalog entries` : 'available catalog not requested'}. ${matched.length} match${matched.length === 1 ? '' : 'es'}${matched.length > shown.length ? `; showing first ${shown.length}` : ''}.`
    await this.replyWithChunks(
      interaction,
      `${summary}\n${lines.join('\n') || 'No matching plugins.'}\nUse /plugin with an exact ID to inspect or manage an entry.`,
      { ephemeral: true },
    )
  }

  private async handlePluginCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireProject(this.parentChannelId(interaction.channel))
    await interaction.deferReply({ ephemeral: true })
    const action = interaction.options.getString('action', true)
    const pluginId = interaction.options.getString('plugin-id', true).trim()
    if (!['inspect', 'install', 'enable', 'disable', 'uninstall'].includes(action)) {
      throw new Error('Unknown Codex plugin action')
    }
    if (!pluginId) throw new Error('Plugin ID is required')
    if (action !== 'inspect' && interaction.options.getString('confirm-plugin-id')?.trim() !== pluginId) {
      throw new Error('Repeat the exact plugin ID in confirm-plugin-id before changing global Codex plugins')
    }
    const cliOptions = this.options.pluginCliEnv ? { env: this.options.pluginCliEnv } : {}
    const reply = await this.pluginMutationQueue.run('global', async () => {
      const catalog = await listCodexCliPlugins(true, cliOptions)
      const plugin: CodexCliPlugin | undefined =
        catalog.installed.find((entry) => entry.pluginId === pluginId) ||
        catalog.available.find((entry) => entry.pluginId === pluginId)
      if (!plugin) throw new Error(`Plugin ${pluginId} is not in the current Codex catalog`)
      const label = `**${escapeInlineMarkdown(truncate(plugin.name.replace(/\s+/g, ' '), 75))}** (${discordInlineCode(pluginId)})`
      if (action === 'inspect') {
        return `${label}\nMarketplace: ${discordInlineCode(plugin.marketplaceName)} · version: ${discordInlineCode(plugin.version || 'unknown')}\nState: ${plugin.installed ? plugin.enabled ? 'installed, enabled' : 'installed, disabled' : 'not installed'} · install policy: ${discordInlineCode(plugin.installPolicy)} · auth policy: ${discordInlineCode(plugin.authPolicy)}`
      }
      if (action === 'install') {
        if (plugin.installed) throw new Error('Plugin is already installed')
        if (plugin.installPolicy !== 'AVAILABLE') {
          throw new Error(`Plugin install policy is ${plugin.installPolicy}; Cordex cannot override it`)
        }
        await installCodexCliPlugin(pluginId, cliOptions)
        const updated = await listCodexCliPlugins(false, cliOptions)
        if (!updated.installed.some((entry) => entry.pluginId === pluginId)) {
          throw new Error('Codex reported installation success, but the installed catalog does not contain the plugin')
        }
        return `Installed ${label}. Start a new Codex session to use bundled skills or tools. Plugin hooks are not trusted automatically.`
      }
      if (!plugin.installed) throw new Error('Plugin is not installed')
      if (plugin.installPolicy !== 'AVAILABLE') {
        throw new Error(`Plugin install policy is ${plugin.installPolicy}; Cordex cannot change a managed/default plugin`)
      }
      if (action === 'uninstall') {
        await removeCodexCliPlugin(pluginId, cliOptions)
        const updated = await listCodexCliPlugins(false, cliOptions)
        if (updated.installed.some((entry) => entry.pluginId === pluginId)) {
          throw new Error('Codex reported uninstallation success, but the plugin is still installed')
        }
        return `Uninstalled ${label}. Existing external service connections are not changed.`
      }
      const enabled = action === 'enable'
      await this.codex.writePluginEnabled(pluginId, enabled)
      const updated = await listCodexCliPlugins(false, cliOptions)
      const effective = updated.installed.find((entry) => entry.pluginId === pluginId)
      if (!effective) throw new Error('Plugin disappeared from the installed catalog after the config change')
      return `${enabled ? 'Enabled' : 'Disabled'} ${label} in Codex config. Effective state: **${effective.enabled ? 'enabled' : 'disabled'}**${effective.enabled !== enabled ? ' (a higher-priority layer may override this setting)' : ''}. Start a new Codex session for the change to take effect; enabling does not trust plugin hooks automatically.`
    })
    await interaction.editReply(reply)
  }

  private async handleHooksCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await interaction.deferReply({ ephemeral: true })
    const event = interaction.options.getString('event')?.trim().toLowerCase() || ''
    const entries = await this.codex.listHooks({ cwds: [directory] })
    const hooks = entries.flatMap((entry) => entry.hooks)
      .filter((hook) => hook.eventName.toLowerCase().includes(event))
    const shown = hooks.slice(0, 25)
    const lines = shown.map((hook) =>
      `• ${discordInlineCode(hook.eventName)} — ${hook.enabled ? 'enabled' : 'disabled'}, ${hook.trustStatus}${hook.isManaged ? ', managed' : ''} — ${hook.source}`)
    const warningCount = entries.reduce((count, entry) => count + entry.warnings.length, 0)
    const errorCount = entries.reduce((count, entry) => count + entry.errors.length, 0)
    await this.replyWithChunks(
      interaction,
      `${hooks.length} matching hook${hooks.length === 1 ? '' : 's'}${hooks.length > shown.length ? `; showing first ${shown.length}` : ''}.${warningCount || errorCount ? ` ${warningCount} warning(s), ${errorCount} error(s) in discovery.` : ''}\n${lines.join('\n') || 'No matching hooks.'}\nTrust and enable/disable controls are not yet available through Discord.`,
      { ephemeral: true },
    )
  }

  private async handleAppsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    this.requireProject(this.parentChannelId(interaction.channel))
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    await interaction.deferReply({ ephemeral: true })
    if (session) await this.ensureSessionLoaded(session)
    const options = session ? { threadId: session.codexThreadId } : {}
    const [available, installed] = await Promise.all([
      this.codex.listApps(options),
      this.codex.listInstalledApps(options),
    ])
    const byId = new Map(available.map((app) => [app.id, app]))
    const runtime = new Map(installed.map((app) => [app.id, app]))
    const ids = [...new Set([...byId.keys(), ...runtime.keys()])]
    const query = interaction.options.getString('query')?.trim().toLowerCase() || ''
    const matched = ids.filter((id) =>
      `${id} ${byId.get(id)?.name || ''} ${runtime.get(id)?.runtimeName || ''}`.toLowerCase().includes(query))
    const shown = matched.slice(0, 25)
    const lines = shown.map((id) => {
      const app = byId.get(id)
      const active = runtime.get(id)
      const name = app?.name || active?.runtimeName || id
      const status = active?.callable
        ? 'callable'
        : active?.enabled
          ? 'enabled, not callable'
          : active
            ? 'installed, disabled'
            : app?.isAccessible && app.isEnabled
              ? 'accessible, not installed'
              : app?.isAccessible
                ? 'accessible, disabled'
                : 'not accessible'
      return `• **${escapeInlineMarkdown(truncate(name.replace(/\s+/g, ' '), 75))}** — ${discordInlineCode(id)} — ${status}`
    })
    await this.replyWithChunks(
      interaction,
      `${available.length} discoverable; ${installed.length} installed; ${installed.filter((app) => app.callable).length} callable. ${matched.length} match${matched.length === 1 ? '' : 'es'}${matched.length > shown.length ? `; showing first ${shown.length}` : ''}.\n${lines.join('\n') || 'No matching apps.'}\nApp invocation is not yet available through Discord.`,
      { ephemeral: true },
    )
  }

  private async handleMcpStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { cwd, threadId } = this.mcpContext(interaction.channel)
    await interaction.deferReply({ ephemeral: true })
    const [configured, active] = await Promise.all([
      this.codex.listConfiguredMcpServers(cwd),
      this.codex.listMcpServers(threadId),
    ])
    const activeByName = new Map(
      active.flatMap((server) => typeof server.name === 'string' ? [[server.name, server] as const] : []),
    )
    const lines = configured.map((configuredServer) => {
      const server = activeByName.get(configuredServer.name)
      activeByName.delete(configuredServer.name)
      const scope = configuredServer.globalConfigurable ? 'global config' : `${configuredServer.scope} config`
      if (!configuredServer.enabled) return `• **${configuredServer.name}** — disabled — ${scope}`
      if (!server) return `• **${configuredServer.name}** — enabled — ${scope} — not currently reported`
      const name = text(server.name) || 'unknown'
      const auth = text(server.authStatus) || 'unknown auth'
      const tools = isRecord(server.tools) ? Object.keys(server.tools).length : 0
      return `• **${name}** — enabled — ${scope} — ${tools} tool${tools === 1 ? '' : 's'} — ${auth}`
    })
    for (const server of activeByName.values()) {
      const name = text(server.name) || 'unknown'
      const auth = text(server.authStatus) || 'unknown auth'
      const tools = isRecord(server.tools) ? Object.keys(server.tools).length : 0
      lines.push(`• **${name}** — active — ${tools} tool${tools === 1 ? '' : 's'} — ${auth}`)
    }
    await this.replyWithChunks(
      interaction,
      lines.join('\n') || 'No MCP servers reported.',
      { ephemeral: true },
    )
  }

  private async handleMcpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const server = interaction.options.getString('server')
    const action = interaction.options.getString('action') || (server ? 'login' : 'status')
    if (action === 'status') {
      await this.handleMcpStatusCommand(interaction)
      return
    }
    if (action === 'reload') {
      if (server) throw new Error('MCP reload does not take a server name')
      await interaction.deferReply({ ephemeral: true })
      await this.mcpConfigQueue.run('global-mcp-config', async () => {
        await this.codex.reloadMcpServers()
        await interaction.editReply(
          'MCP configuration reload requested. Loaded sessions refresh for subsequent turns; use /mcp-status to inspect the current inventory.',
        )
      })
      return
    }
    if (!server) throw new Error(`MCP ${action} requires a server`)
    if (action === 'login') {
      await this.handleMcpLoginCommand(interaction)
      return
    }
    if (action !== 'enable-global' && action !== 'disable-global') {
      throw new Error(`Unknown MCP action: ${action}`)
    }
    await this.handleMcpToggleCommand(interaction, server, action === 'enable-global')
  }

  private mcpContext(channel: ChatInputCommandInteraction['channel']): {
    cwd?: string
    threadId?: string
  } {
    if (channel?.isThread()) {
      const session = this.state.sessions[channel.id]
      const projectDirectory = channel.parentId
        ? this.config.projects[channel.parentId]?.directory
        : undefined
      const cwd = session?.directory || projectDirectory
      return {
        ...(cwd ? { cwd } : {}),
        ...(session?.codexThreadId ? { threadId: session.codexThreadId } : {}),
      }
    }
    const parentId = this.parentChannelId(channel)
    const directory = parentId ? this.config.projects[parentId]?.directory : undefined
    return directory ? { cwd: directory } : {}
  }

  private async handleMcpToggleCommand(
    interaction: ChatInputCommandInteraction,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    const { cwd } = this.mcpContext(interaction.channel)
    await interaction.deferReply({ ephemeral: true })
    await this.mcpConfigQueue.run('global-mcp-config', async () => {
      const result = await this.codex.setMcpServerEnabled(server, enabled, cwd)
      const requested = enabled ? 'enabled' : 'disabled'
      const effective = result.effectiveEnabled ? 'enabled' : 'disabled'
      const warning = result.status === 'okOverridden' || result.effectiveEnabled !== enabled
        ? `\nWarning: effective state is **${effective}** because another Codex config layer overrides this value.`
        : ''
      await interaction.editReply(
        `**${server}** globally ${requested}; MCP servers reloaded.\nConfig: \`${result.filePath}\`${warning}`,
      )
    })
  }

  private async handleMcpLoginCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const server = interaction.options.getString('server', true)
    const threadId = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.codexThreadId
      : undefined
    await interaction.deferReply({ ephemeral: true })
    const authorizationUrl = await this.codex.loginMcpServer(server, threadId)
    await interaction.editReply(
      `MCP OAuth started for **${server}**. Open this URL to finish login:\n${authorizationUrl}`,
    )
  }

  private async handleAuthStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const auth = await this.codex.getAuthStatus()
    const account = await this.codex.getAccount().catch(() => null)
    const lines = [
      `Auth method: **${auth.authMethod || 'none'}**`,
      `Token: **${auth.hasToken ? 'present' : 'not available'}**`,
      `OpenAI auth required: **${auth.requiresOpenaiAuth ? 'yes' : 'no'}**`,
    ]
    if (account) {
      if (typeof account.type === 'string') lines.push(`Account: **${account.type}**`)
      if (typeof account.email === 'string' && account.email) lines.push(`Email: \`${account.email}\``)
      if (typeof account.planType === 'string') lines.push(`Plan: **${account.planType}**`)
    }
    await this.replyWithChunks(interaction, lines.join('\n'), { ephemeral: true })
  }

  private formatRateLimitWindow(label: string, value: unknown): string | undefined {
    if (!isRecord(value) || typeof value.usedPercent !== 'number') return undefined
    const reset = typeof value.resetsAt === 'number' ? ` · resets <t:${Math.floor(value.resetsAt)}:R>` : ''
    const duration = typeof value.windowDurationMins === 'number' ? ` · ${value.windowDurationMins}m window` : ''
    return `**${label}:** ${Math.round(value.usedPercent)}% used${duration}${reset}`
  }

  private async handleRateLimitsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const response = await this.codex.getAccountRateLimits()
    const snapshots = isRecord(response.rateLimitsByLimitId)
      ? Object.entries(response.rateLimitsByLimitId).filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
      : isRecord(response.rateLimits)
        ? [['account', response.rateLimits] as [string, JsonObject]]
        : []
    const lines = snapshots.flatMap(([id, snapshot]) => {
      const name = text(snapshot.limitName) || text(snapshot.limitId) || id
      const output = [`**${name}**`]
      const primary = this.formatRateLimitWindow('Primary', snapshot.primary)
      const secondary = this.formatRateLimitWindow('Secondary', snapshot.secondary)
      if (primary) output.push(primary)
      if (secondary) output.push(secondary)
      if (isRecord(snapshot.credits)) {
        const credits = snapshot.credits
        if (credits.unlimited === true) output.push('**Credits:** unlimited')
        else if (typeof credits.balance === 'string') output.push(`**Credits:** ${credits.balance}`)
      }
      return output
    })
    await this.replyWithChunks(
      interaction,
      lines.join('\n') || 'No account rate limits reported.',
      { ephemeral: true },
    )
  }

  private formatUsageNumber(value: unknown): string {
    if (typeof value === 'number') return value.toLocaleString('en-US')
    if (typeof value === 'string') return value
    return 'unavailable'
  }

  private async handleAccountUsageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const response = await this.codex.getAccountUsage()
    if (!isRecord(response.summary)) {
      await interaction.editReply('No account usage reported.')
      return
    }
    const summary = response.summary
    await interaction.editReply([
      `**Lifetime tokens:** ${this.formatUsageNumber(summary.lifetimeTokens)}`,
      `**Peak daily tokens:** ${this.formatUsageNumber(summary.peakDailyTokens)}`,
      `**Current streak:** ${this.formatUsageNumber(summary.currentStreakDays)} days`,
      `**Longest streak:** ${this.formatUsageNumber(summary.longestStreakDays)} days`,
      `**Longest turn:** ${this.formatUsageNumber(summary.longestRunningTurnSec)} seconds`,
    ].join('\n'))
  }

  private async handleLoginCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const method = (interaction.options.getString('method') || 'chatgpt') as 'chatgpt' | 'chatgptDeviceCode'
    await interaction.deferReply({ ephemeral: true })
    const login = await this.codex.startAccountLogin(method)
    if (login.type === 'chatgpt') {
      await interaction.editReply(
        `Codex login started. Open this URL to authenticate:\n${login.authUrl}\n\nLogin ID: \`${login.loginId}\``,
      )
      return
    }
    await interaction.editReply(
      `Codex device login started. Open ${login.verificationUrl} and enter code \`${login.userCode}\`.\n\nLogin ID: \`${login.loginId}\``,
    )
  }

  private async runScheduledTask(task: ScheduledTask, recoverRunning: boolean): Promise<void> {
    const session = this.state.sessions[task.threadId]
    if (!session) throw new Error('Session no longer exists')
    if (!this.config.projects[session.parentChannelId]) {
      throw new Error('Scheduled task parent project is no longer mapped')
    }
    const channel = await this.client.channels.fetch(task.threadId).catch(() => undefined)
    if (!channel?.isThread()) throw new Error('Discord session thread unavailable')
    if (
      channel.guildId !== this.config.guildId ||
      channel.parentId !== session.parentChannelId
    ) {
      throw new Error('Scheduled task Discord thread is outside the configured server or project')
    }
    if (task.status !== 'running' || this.state.tasks[task.id] !== task) return
    const input: UserInput[] = [{ type: 'text', text: task.prompt, text_elements: [] }]
    const deliveryId = scheduledTaskDeliveryId(task)
    // A recovered running occurrence with no queue may have crossed the
    // Codex acceptance boundary before Cordex could save task completion.
    const uncertainAfterRecovery = recoverRunning && !this.queueFor(channel.id).some(
      (prompt) => this.queuedPromptDeliveryId(prompt) === deliveryId,
    )
    await this.enqueuePrompt(channel.id, {
      id: deliveryId,
      authorId: task.createdBy,
      authorName: 'scheduled task',
      input,
      displayText: task.prompt,
      createdAt: new Date().toISOString(),
      deliveryKind: 'queued',
      ...(uncertainAfterRecovery ? { reviewRequired: true } : {}),
    }, session.archived === true)
    if (session.archived && session.lifecycleIntent?.kind !== 'archive') {
      const reviewNote = uncertainAfterRecovery ? ' Delivery needs review after the session is resumed.' : ''
      await channel.send(`» **scheduled task queued while archived:** ${truncate(task.prompt, 1_650)}${reviewNote}`)
        .catch(() => undefined)
    } else {
      await this.recoverPersistedPrompts(session, channel).catch((error: unknown) => {
        this.logVerbose('scheduled prompt drain deferred after durable enqueue', {
          taskId: task.id,
          error: errorText(error),
        })
      })
      const pending = this.queueFor(channel.id).find((prompt) =>
        this.queuedPromptDeliveryId(prompt) === deliveryId)
      if (pending?.reviewRequired) {
        await this.sendUncertainPromptNotice(session, channel, pending)
      } else if (pending) {
        await channel.send(`» **scheduled task:** ${truncate(task.prompt, 1_700)}`)
          .catch((error: unknown) => {
            this.logVerbose('scheduled prompt announcement failed', {
              taskId: task.id,
              error: errorText(error),
            })
          })
      }
    }
  }

  private async handleNewWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    if (session.worktree && !session.worktree.merged) throw new Error('Session already uses a worktree')
    const project = this.config.projects[session.parentChannelId]
    if (!project) throw new Error('Parent project mapping not found')
    const requestedName = interaction.options.getString('name') || channel.name.replace(/^⬦\s*/, '')
    const baseRef = interaction.options.getString('base-branch') || undefined
    await interaction.deferReply()
    const created = await createWorktree({
      projectDirectory: project.directory,
      dataRoot: getCordexHome(),
      name: requestedName,
      ...(baseRef ? { baseRef } : {}),
    })
    try {
      const serviceTier = await this.serviceTierForFastMode(
        session.model || this.config.defaultModel,
        session.fastMode,
      )
      const forked = await this.codex.forkThread({
        threadId: session.codexThreadId,
        cwd: created.directory,
        ...(session.model ? { model: session.model } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(session.workspaceRoots?.length
          ? { runtimeWorkspaceRoots: [created.directory, ...session.workspaceRoots] }
          : {}),
        ...(!session.yoloMode && session.permissions
          ? { permissions: session.permissions }
          : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
        approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
        ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
      })
      const modelTransition = session.model !== undefined && session.model !== forked.model
      const thread = await this.createSessionThread({
        parentChannelId: session.parentChannelId,
        name: `⬦ ${requestedName}`,
        userId: interaction.user.id,
      })
      const worktreeSession: SessionState = {
        discordThreadId: thread.id,
        parentChannelId: session.parentChannelId,
        directory: created.directory,
        codexThreadId: forked.threadId,
        model: session.model || forked.model,
        ...(session.effort || forked.effort ? { effort: session.effort || forked.effort } : {}),
        ...(session.mode ? { mode: session.mode } : {}),
        ...(session.fastMode !== undefined ? { fastMode: session.fastMode } : {}),
        ...(session.yoloMode !== undefined ? { yoloMode: session.yoloMode } : {}),
        ...(session.workspaceRoots ? { workspaceRoots: [...session.workspaceRoots] } : {}),
        ...(session.permissions ? { permissions: session.permissions } : {}),
        ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
        worktree: {
          projectDirectory: created.projectDirectory,
          directory: created.directory,
          branch: created.branch,
        },
        updatedAt: new Date().toISOString(),
      }
      if (modelTransition) {
        this.contextReplayBlocked.add(forked.threadId)
        this.pendingContextUsage.delete(forked.threadId)
      } else {
        this.contextReplayBlocked.delete(forked.threadId)
      }
      this.state.sessions[thread.id] = worktreeSession
      if (!modelTransition) this.hydratePendingContextUsage(worktreeSession)
      this.loadedThreads.add(forked.threadId)
      await saveState(this.state)
      await this.synchronizeCodexThreadTitle(forked.threadId, thread.name).catch((error: unknown) => {
        this.logVerbose('worktree title synchronization failed', {
          threadId: forked.threadId,
          error: errorText(error),
        })
        void thread.send(
          '⚠ Session title synchronization failed; Cordex will retry on the next load.',
        ).catch(() => undefined)
      })
      await interaction.editReply(
        `Worktree ready: ${thread}\nBranch: \`${created.branch}\`\nDirectory: \`${created.directory}\``,
      )
    } catch (error) {
      await removeWorktree(created).catch(() => undefined)
      throw error
    }
  }

  private async handleToggleWorktreesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { parentChannelId } = this.requireProject(this.parentChannelId(interaction.channel))
    const previous = this.state.channelAutoWorktrees[parentChannelId]
    const hadPrevious = Object.hasOwn(this.state.channelAutoWorktrees, parentChannelId)
    const enabled = !this.state.channelAutoWorktrees[parentChannelId]
    this.state.channelAutoWorktrees[parentChannelId] = enabled
    try {
      await saveState(this.state)
    } catch (error) {
      if (hadPrevious) this.state.channelAutoWorktrees[parentChannelId] = previous!
      else delete this.state.channelAutoWorktrees[parentChannelId]
      throw error
    }
    await interaction.reply({
      content: `Automatic worktrees: **${enabled ? 'enabled' : 'disabled'}** for this project channel.`,
    })
  }

  private async handleWorktreesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply()
    const managedByDirectory = new Map(
      activeWorktreeSessions(Object.values(this.state.sessions)).flatMap((session) =>
        session.worktree
          ? [[path.resolve(session.worktree.directory), session] as const]
          : []),
    )
    const projects = new Map<string, { name: string; channels: string[] }>()
    for (const { channelId, project } of projectMappings(this.config)) {
      const directory = path.resolve(project.directory)
      const existing = projects.get(directory)
      if (existing) existing.channels.push(channelId)
      else projects.set(directory, {
        name: project.name || path.basename(directory),
        channels: [channelId],
      })
    }

    const lines: string[] = []
    for (const [directory, project] of projects) {
      let inventory
      try {
        inventory = await listWorktreeInventory(directory)
      } catch (error) {
        lines.push(`• **${project.name}** — unavailable: ${truncate(errorText(error), 300)}`)
        continue
      }
      for (const entry of inventory) {
        const managed = managedByDirectory.get(path.resolve(entry.directory))
        const branch = entry.branch?.replace(/^refs\/heads\//, '') || 'detached'
        const owner = entry.isMainWorktree
          ? 'main checkout'
          : managed
            ? `<#${managed.discordThreadId}>`
            : 'unlinked worktree'
        const status = [
          entry.checkoutState,
          entry.locked ? `locked${entry.lockedReason ? `: ${entry.lockedReason}` : ''}` : '',
          entry.prunable ? `prunable${entry.prunableReason ? `: ${entry.prunableReason}` : ''}` : '',
          entry.comparison
            ? `${entry.comparison.relation} vs ${entry.comparison.ref}` +
              (entry.comparison.ahead !== null && entry.comparison.behind !== null
                ? ` (+${entry.comparison.ahead}/-${entry.comparison.behind})`
                : '')
            : '',
          entry.reachableFromLocalBranch === false ? 'unreachable from local branches' : '',
        ].filter(Boolean).join(' · ')
        lines.push(
          `• **${project.name}** — ${owner} — \`${branch}\`\n  \`${entry.directory}\`\n  ${status || 'status unavailable'}` +
          (entry.errors.length > 0 ? `\n  ⚠ ${truncate(entry.errors.join('; '), 500)}` : ''),
        )
      }
    }
    await this.replyWithChunks(interaction, lines.join('\n') || 'No Git worktrees found.')
  }

  private async handleMergeWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const initial = this.requireThreadSession(interaction)
    const targetBranch = interaction.options.getString('target-branch') || undefined
    await interaction.deferReply()
    const { channel, session, result } = await this.projectMutationQueue.run(
      `channel:${initial.session.parentChannelId}`,
      async () => {
        const current = this.requireThreadSession(interaction)
        if (current.session.activeTurnId) {
          throw new Error('Wait for active turn or run /abort first')
        }
        const worktree = current.session.worktree
        if (!worktree) throw new Error('Session is not associated with a worktree')
        if (worktree.merged) throw new Error('Worktree already merged')
        const worktreeDirectory = path.resolve(worktree.directory)
        if ((this.pendingSessionDirectoryReservations.get(worktreeDirectory) || 0) > 0) {
          throw new Error('Worktree is being inherited by a new session; retry after it finishes starting')
        }
        const sharedSession = Object.values(this.state.sessions).find((candidate) =>
          candidate.discordThreadId !== current.session.discordThreadId &&
          !candidate.archived &&
          path.resolve(candidate.directory) === worktreeDirectory)
        if (sharedSession) {
          throw new Error(`Worktree is still used by <#${sharedSession.discordThreadId}>; archive that session before merging`)
        }
        const result = await mergeWorktree({
          projectDirectory: worktree.projectDirectory,
          worktreeDirectory: worktree.directory,
          branch: worktree.branch,
          ...(targetBranch ? { targetBranch } : {}),
        })
        if (result.status !== 'conflict') {
          const previous = structuredClone(current.session)
          worktree.merged = true
          current.session.updatedAt = new Date().toISOString()
          try {
            await saveState(this.state)
          } catch (error) {
            this.restoreSessionState(current.session, previous)
            throw error
          }
        }
        return { ...current, result }
      },
    )
    if (result.status === 'conflict') {
      const input: UserInput[] = [
        {
          type: 'text',
          text: [
            `A rebase conflict occurred while merging this worktree into ${result.targetBranch}.`,
            'Inspect git status, both sides, and the replayed commit intent.',
            'Resolve conflicts preserving both intended changes, stage files, then run git rebase --continue.',
            'Repeat until rebase fully finishes and git status is clean. Do not merge into the main checkout yourself.',
            'Report when complete so /merge-worktree can be run again.',
          ].join('\n'),
          text_elements: [],
        },
      ]
      await this.enqueuePrompt(channel.id, {
        id: interaction.id,
        authorId: interaction.user.id,
        authorName: interaction.user.displayName,
        input,
        displayText: `Resolve the rebase conflict against ${result.targetBranch}.`,
        createdAt: new Date().toISOString(),
        deliveryKind: 'direct',
      })
      await this.recoverPersistedPrompts(session, channel)
      await interaction.editReply(
        `Rebase conflict against \`${result.targetBranch}\`. Asking Codex to resolve and finish rebase.`,
      )
      return
    }
    let titleWarning = ''
    if (channel.name.startsWith('⬦ ')) {
      await this.synchronizeThreadTitle(session, channel, channel.name.slice(2)).catch((error: unknown) => {
        titleWarning = `\nTitle synchronization failed: ${truncate(errorText(error), 300)}`
      })
    }
    if (result.status === 'nothing-to-merge') {
      await interaction.editReply(
        `Nothing to merge from \`${result.branch}\` into \`${result.targetBranch}\`; cleared the worktree marker.${titleWarning}`,
      )
    } else if (result.status === 'already-merged') {
      await interaction.editReply(
        `Recovered completed merge of \`${result.branch}\` into \`${result.targetBranch}\` @ ${result.shortSha}.\nWorktree remains at detached HEAD.${titleWarning}`,
      )
    } else {
      await interaction.editReply(
        `Merged \`${result.branch}\` into \`${result.targetBranch}\` @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'}).\nWorktree remains at detached HEAD.${titleWarning}`,
      )
    }
  }

  private async handleDeleteWorktreeCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const initial = this.requireThreadSession(interaction, 'remove-worktree')
    await interaction.deferReply()
    const removal = await this.projectMutationQueue.run(
      `channel:${initial.session.parentChannelId}`,
      async () => this.resumeQueue.run(initial.session.codexThreadId, async () =>
        this.codexEventQueue.run(initial.session.codexThreadId, async () =>
          this.promptQueue.run(initial.channel.id, async () => {
            const { channel, session } = this.requireThreadSession(interaction, 'remove-worktree')
            const worktree = session.worktree
            if (!worktree) throw new Error('Session is not associated with a worktree')
            const existingIntent = session.lifecycleIntent
            if (existingIntent && existingIntent.kind !== 'remove-worktree') {
              throw new Error(`Session ${existingIntent.kind} operation is still pending`)
            }
            if (session.activeTurnId || this.runs.has(session.codexThreadId)) {
              throw new Error('Wait for active turn or run /abort first')
            }
            if (this.pendingTurnStarts.has(session.codexThreadId)) {
              throw new Error('Wait for the pending turn start or run /abort first')
            }
            if ((this.state.queues[channel.id] || []).length > 0) {
              throw new Error('Wait for or clear pending prompts before deleting the worktree')
            }
            const pendingTask = Object.values(this.state.tasks).find(
              (task) => task.threadId === channel.id &&
                (task.status === 'scheduled' || task.status === 'running'),
            )
            if (pendingTask) {
              throw new Error(`Cancel scheduled task ${pendingTask.id} before deleting the worktree`)
            }
            const goal = await this.codex.getThreadGoal(session.codexThreadId)
            if (goal?.status === 'active') {
              throw new Error('Pause, complete, or clear the active goal before deleting the worktree')
            }
            const project = this.config.projects[session.parentChannelId]
            if (!project) throw new Error('Parent project mapping not found')
            if (path.resolve(project.directory) !== path.resolve(worktree.projectDirectory)) {
              throw new Error('Worktree project no longer matches its Discord project mapping')
            }
            const worktreeDirectory = path.resolve(worktree.directory)
            const reservedDirectory = [...this.pendingSessionDirectoryReservations.entries()]
              .find(([directory, count]) => count > 0 && pathIsWithinOrEqual(worktreeDirectory, directory))
            if (reservedDirectory) {
              throw new Error('Worktree is being inherited by a new session; retry after it finishes starting')
            }
            const sharedSession = Object.values(this.state.sessions).find((candidate) => {
              if (candidate.discordThreadId === session.discordThreadId) return false
              return pathIsWithinOrEqual(worktreeDirectory, candidate.directory) ||
                (candidate.worktree !== undefined &&
                  pathIsWithinOrEqual(worktreeDirectory, candidate.worktree.directory)) ||
                candidate.workspaceRoots?.some((root) => pathIsWithinOrEqual(worktreeDirectory, root))
            })
            if (sharedSession) {
              throw new Error(
                `Worktree is still referenced by <#${sharedSession.discordThreadId}>; move or remove that session first`,
              )
            }

            await inspectMergedWorktreeRemoval({
              projectDirectory: worktree.projectDirectory,
              worktreeDirectory: worktree.directory,
              branch: worktree.branch,
            })
            if (!existingIntent) {
              const previous = structuredClone(session)
              session.lifecycleIntent = {
                kind: 'remove-worktree',
                requestedAt: new Date().toISOString(),
              }
              session.updatedAt = session.lifecycleIntent.requestedAt
              try {
                await saveState(this.state)
              } catch (error) {
                this.restoreSessionState(session, previous)
                throw error
              }
            }
            const result = await removeMergedWorktree({
              projectDirectory: worktree.projectDirectory,
              worktreeDirectory: worktree.directory,
              branch: worktree.branch,
            })
            await this.finalizeWorktreeRemoval(session, worktree)
            return { channel, session, result }
          }),
        ),
      ),
    )

    let warning = ''
    if (!removal.session.archived) {
      await this.ensureSessionLoaded(removal.session).catch((error: unknown) => {
        warning += `\nCodex reload deferred: ${truncate(errorText(error), 300)}`
      })
    }
    if (removal.channel.name.startsWith('⬦ ')) {
      await this.synchronizeThreadTitle(
        removal.session,
        removal.channel,
        removal.channel.name.slice(2),
      ).catch((error: unknown) => {
        warning += `\nTitle synchronization failed: ${truncate(errorText(error), 300)}`
      })
    }
    await interaction.editReply(
      `${removal.result.status === 'already-removed' ? 'Reconciled' : 'Deleted'} merged worktree. ` +
      `Session now uses \`${removal.session.directory}\`.${warning}`,
    )
  }

  private queueFor(threadId: string): QueuedPrompt[] {
    return (this.state.queues[threadId] ??= [])
  }

  private queuedPromptsFor(threadId: string): QueuedPrompt[] {
    return this.queueFor(threadId).filter((prompt) => this.promptDeliveryKind(prompt) === 'queued')
  }

  private async enqueuePrompt(
    threadId: string,
    prompt: QueuedPrompt,
    allowArchived = false,
  ): Promise<number> {
    return this.promptQueue.run(threadId, async () => {
      this.assertDiscordThreadAvailable(threadId)
      const session = this.state.sessions[threadId]
      if (this.archivingDiscordThreads.has(threadId)) {
        throw new Error('Session is being archived')
      }
      if (!session || this.unlinkedCodexSessionChannels.has(threadId)) {
        throw new Error('Thread has no Codex session')
      }
      if (session.lifecycleIntent) {
        throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
      }
      if (
        this.removingProjects.has(session.parentChannelId) ||
        !this.config.projects[session.parentChannelId]
      ) {
        throw new Error('Project is no longer available')
      }
      if (session.archived && !allowArchived) throw new Error('Session is archived; run /resume first')
      const queue = this.queueFor(threadId)
      const deliveryId = this.queuedPromptDeliveryId(prompt)
      const existingIndex = queue.findIndex(
        (queued) => this.queuedPromptDeliveryId(queued) === deliveryId,
      )
      if (existingIndex >= 0) {
        return queue
          .slice(0, existingIndex + 1)
          .filter((queued) => this.promptDeliveryKind(queued) === 'queued')
          .length
      }
      queue.push(prompt)
      try {
        await saveState(this.state)
      } catch (error) {
        const index = queue.lastIndexOf(prompt)
        if (index >= 0) queue.splice(index, 1)
        throw error
      }
      if (
        this.unlinkedCodexSessionChannels.has(threadId) ||
        this.state.sessions[threadId]?.codexThreadId !== session.codexThreadId
      ) {
        throw new Error('Thread has no Codex session')
      }
      return this.promptDeliveryKind(prompt) === 'queued'
        ? queue.filter((queued) => this.promptDeliveryKind(queued) === 'queued').length
        : 0
    })
  }

  private async enqueuePendingInitialPrompt(
    threadId: string,
    prompt: QueuedPrompt,
  ): Promise<number> {
    return this.promptQueue.run(threadId, async () => {
      this.assertDiscordThreadAvailable(threadId)
      const pending = this.state.pendingInitialSessions?.[threadId]
      if (!pending || this.state.sessions[threadId] ||
        !this.config.projects[pending.parentChannelId]) {
        throw new Error('Pending Codex session is no longer available')
      }
      const queue = this.queueFor(threadId)
      const existing = queue.findIndex((item) =>
        this.queuedPromptDeliveryId(item) === this.queuedPromptDeliveryId(prompt))
      if (existing >= 0) return existing + 1
      queue.push(prompt)
      try {
        await saveState(this.state)
      } catch (error) {
        const index = queue.indexOf(prompt)
        if (index >= 0) queue.splice(index, 1)
        throw error
      }
      return queue.length
    })
  }

  private async announceQueuedPrompt(channel: ThreadChannel, prompt: QueuedPrompt): Promise<void> {
    await channel.send({
      content: `» **${escapeInlineMarkdown(prompt.authorName)}:** ${truncate(prompt.displayText, 1_700)}`,
      allowedMentions: { parse: [] },
    })
  }

  private queuedPromptDeliveryId(prompt: QueuedPrompt): string {
    return prompt.sourceMessageId || prompt.id
  }

  private promptDeliveryKind(prompt: QueuedPrompt): 'direct' | 'queued' {
    return prompt.deliveryKind || 'queued'
  }

  private async announceDeliveredPrompt(channel: ThreadChannel, prompt: QueuedPrompt): Promise<void> {
    if (this.promptDeliveryKind(prompt) === 'queued') {
      await this.announceQueuedPrompt(channel, prompt)
    }
  }

  private async removeQueuedPrompt(threadId: string, prompt: QueuedPrompt): Promise<boolean> {
    const queue = this.queueFor(threadId)
    const deliveryId = this.queuedPromptDeliveryId(prompt)
    const index = queue.findIndex((queued) => this.queuedPromptDeliveryId(queued) === deliveryId)
    if (index < 0) return false
    const [removed] = queue.splice(index, 1)
    try {
      await saveState(this.state)
    } catch (error) {
      if (removed) queue.splice(Math.min(index, queue.length), 0, removed)
      throw error
    }
    return true
  }

  private async removeDeliveredQueuePrompts(
    session: SessionState,
    channel: ThreadChannel,
    knownRuntime?: CodexThreadRuntimeState,
  ): Promise<void> {
    const queue = this.queueFor(channel.id)
    if (queue.length === 0) return
    const runtime = knownRuntime || await this.readThreadRuntimeState(session)
    const deliveredIds = new Set(runtime.userMessageClientIds || [])
    const delivered = queue.filter((prompt) =>
      deliveredIds.has(this.queuedPromptDeliveryId(prompt)))
    if (delivered.length === 0) return
    const original = [...queue]
    queue.splice(
      0,
      queue.length,
      ...queue.filter((prompt) => !deliveredIds.has(this.queuedPromptDeliveryId(prompt))),
    )
    try {
      await saveState(this.state)
    } catch (error) {
      queue.splice(0, queue.length, ...original)
      throw error
    }
    for (const prompt of delivered) await this.announceDeliveredPrompt(channel, prompt)
  }

  private async markPromptDeliveryStarted(prompt: QueuedPrompt): Promise<void> {
    const previouslyStarted = prompt.deliveryStarted === true
    prompt.deliveryStarted = true
    try {
      await saveState(this.state)
    } catch (error) {
      if (!previouslyStarted) delete prompt.deliveryStarted
      throw error
    }
  }

  private async sendUncertainPromptNotice(
    session: SessionState,
    channel: ThreadChannel,
    prompt: QueuedPrompt,
  ): Promise<void> {
    await this.sendDurableDiscordOutput({
      channel,
      codexThreadId: session.codexThreadId,
      turnId: `pending-direct:${this.queuedPromptDeliveryId(prompt)}`,
      itemKey: 'review',
      value: `⚠ This saved prompt's delivery to Codex is uncertain. Cordex will not retry it automatically. Source ID: ${discordInlineCode(this.queuedPromptDeliveryId(prompt))}. Review it with /pending-prompts before choosing whether to retry or discard it. Later queued work is held too.`,
      suppressNotifications: false,
      format: false,
    }).catch((error: unknown) => {
      this.logVerbose('uncertain prompt notice delivery deferred', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
    })
  }

  private async sendPendingInitialSessionNotice(
    channel: ThreadChannel,
    pending: PendingInitialSession,
  ): Promise<void> {
    if (this.state.pendingInitialSessions?.[channel.id] !== pending) return
    const first = this.queueFor(channel.id)[0]
    if (!first) return
    await this.sendDurableDiscordOutput({
      channel,
      codexThreadId: `pending-session:${channel.id}`,
      turnId: `pending-start:${this.queuedPromptDeliveryId(first)}`,
      itemKey: 'review',
      value: pending.abortIntent
        ? `⚠ Codex session creation ${pending.abortIntent.reconciledAt ? 'was cancelled' : 'cancellation is pending'}. The first prompt is saved and will not run automatically. Source ID: ${discordInlineCode(this.queuedPromptDeliveryId(first))}. Review it with /pending-prompts, then use /resolve-pending to retry or discard it. Later work is held too.`
        : `⚠ Cordex could not confirm Codex session creation. The first prompt is saved and will not run automatically. Source ID: ${discordInlineCode(this.queuedPromptDeliveryId(first))}. Review it with /pending-prompts, then use /resolve-pending to retry or discard it. Later work is held too.`,
      suppressNotifications: false,
      format: false,
    }).catch((error: unknown) => {
      this.logVerbose('pending initial-session notice delivery deferred', {
        discordThreadId: channel.id,
        error: errorText(error),
      })
    })
  }

  private async holdPendingInitialPrompt(
    channel: ThreadChannel,
    pending: PendingInitialSession,
  ): Promise<void> {
    if (this.state.pendingInitialSessions?.[channel.id] !== pending) return
    const first = this.queueFor(channel.id)[0]
    if (!first) return
    first.reviewRequired = true
    await saveState(this.state).catch((error: unknown) => {
      this.logVerbose('pending initial-session hold save deferred', {
        discordThreadId: channel.id,
        error: errorText(error),
      })
    })
    await this.sendPendingInitialSessionNotice(channel, pending)
  }

  private async clearPendingInitialSessionNotice(threadId: string): Promise<void> {
    await this.updateDiscordOutbox((outbox) => {
      const originalLength = outbox.length
      for (let index = outbox.length - 1; index >= 0; index--) {
        const entry = outbox[index]
        if (entry?.discordThreadId === threadId &&
          entry.codexThreadId === `pending-session:${threadId}`) outbox.splice(index, 1)
      }
      return outbox.length !== originalLength
    })
  }

  private async reconcilePendingInitialAbort(
    threadId: string,
    pending: PendingInitialSession,
    startedThreadId?: string,
  ): Promise<void> {
    if (startedThreadId) {
      try {
        await this.promptQueue.run(threadId, async () => {
          if (this.state.pendingInitialSessions?.[threadId] !== pending || !pending.abortIntent) {
            throw new Error('Pending Codex session abort is no longer available')
          }
          if (pending.abortIntent.codexThreadId &&
            pending.abortIntent.codexThreadId !== startedThreadId) {
            throw new Error('Pending Codex session abort references a different Codex thread')
          }
          const previous = { ...pending.abortIntent }
          pending.abortIntent = { ...pending.abortIntent, codexThreadId: startedThreadId }
          try {
            await saveState(this.state)
          } catch (error) {
            pending.abortIntent = previous
            throw error
          }
        })
      } catch (error) {
        try {
          await this.codex.deleteThread(startedThreadId)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Could not persist or clean up the cancelled Codex session',
          )
        }
        throw error
      }
    }

    const cleanupThreadId = pending.abortIntent?.codexThreadId
    if (cleanupThreadId) {
      try {
        await this.codex.deleteThread(cleanupThreadId)
      } catch (error) {
        if (!this.isUnloadedCodexThreadError(error, cleanupThreadId) &&
          !this.isMissingCodexRolloutError(error, cleanupThreadId)) throw error
      }
      this.loadedThreads.delete(cleanupThreadId)
    }

    await this.promptQueue.run(threadId, async () => {
      if (this.state.pendingInitialSessions?.[threadId] !== pending || !pending.abortIntent) return
      if (cleanupThreadId && pending.abortIntent.codexThreadId !== cleanupThreadId) {
        throw new Error('Pending Codex session abort changed during cleanup')
      }
      const previous = { ...pending.abortIntent }
      pending.abortIntent = {
        requestedAt: pending.abortIntent.requestedAt,
        reconciledAt: new Date().toISOString(),
      }
      try {
        await saveState(this.state)
      } catch (error) {
        pending.abortIntent = previous
        throw error
      }
    })
  }

  private async holdUncertainPrompt(
    session: SessionState,
    channel: ThreadChannel,
    prompt: QueuedPrompt,
  ): Promise<void> {
    if (!this.queueFor(channel.id).includes(prompt)) return
    prompt.reviewRequired = true
    await saveState(this.state).catch((error: unknown) => {
      this.logVerbose('uncertain prompt hold save deferred; delivery marker remains durable', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
    })
    await this.sendUncertainPromptNotice(session, channel, prompt)
  }

  private async deliverPersistedDirectPromptsUnlocked(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    while (true) {
      const current = this.state.sessions[channel.id]
      if (
        current?.codexThreadId !== session.codexThreadId ||
        current.archived ||
        this.deletedDiscordThreads.has(channel.id)
      ) return
      this.assertCodexSessionLinked(current)
      const next = this.queueFor(channel.id).find(
        (prompt) => this.promptDeliveryKind(prompt) === 'direct',
      )
      if (!next) return
      if (next.reviewRequired) return

      const runtime = await this.readThreadRuntimeState(current)
      await this.removeDeliveredQueuePrompts(current, channel, runtime)
      if (!this.queueFor(channel.id).includes(next)) continue
      if (runtime.status === 'active' && runtime.activeTurnId) {
        await this.adoptActiveTurn(current, channel, runtime.activeTurnId)
      } else if (runtime.status === 'idle') {
        await this.clearInactiveTurn(current, channel)
      } else if (runtime.status === 'systemError') {
        throw new Error('Codex thread is unavailable for persisted prompt recovery')
      }

      await this.markPromptDeliveryStarted(next)
      try {
        await this.dispatchInputUnlocked(
          channel,
          current.parentChannelId,
          next.input,
          this.queuedPromptDeliveryId(next),
        )
        await this.removeQueuedPrompt(channel.id, next)
      } catch (error) {
        await this.holdUncertainPrompt(current, channel, next)
        throw error
      }
    }
  }

  private async recoverPersistedPromptsUnlocked(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    if (this.unlinkedCodexSessionChannels.has(channel.id)) {
      throw new Error('Thread has no Codex session')
    }
    const current = this.state.sessions[channel.id]
    if (
      current?.codexThreadId !== session.codexThreadId ||
      current.archived ||
      this.deletedDiscordThreads.has(channel.id)
    ) return
    const uncertain = this.queueFor(channel.id).find((prompt) => prompt.reviewRequired)
    if (uncertain) await this.sendUncertainPromptNotice(current, channel, uncertain)
    if (current.abortIntent) {
      const reconciliation = await this.reconcileAbortIntent(current)
      if (!reconciliation.cleared) return
    }
    let runtime: CodexThreadRuntimeState
    try {
      runtime = await this.readThreadRuntimeState(current)
    } catch (error) {
      if (uncertain) return
      if ((this.isUnloadedCodexThreadError(error, current.codexThreadId) ||
        this.isMissingCodexRolloutError(error, current.codexThreadId) ||
        this.isUnsupportedCodexHistoryError(error)) &&
        this.queueFor(channel.id).length > 0) {
        const next = this.queueFor(channel.id)[0]!
        await this.holdUncertainPrompt(current, channel, next)
        return
      }
      throw error
    }
    this.assertCodexSessionLinked(current)
    await this.removeDeliveredQueuePrompts(current, channel, runtime)
    if (uncertain && this.queueFor(channel.id).includes(uncertain)) return
    if (runtime.status === 'active' && runtime.activeTurnId) {
      await this.adoptActiveTurn(current, channel, runtime.activeTurnId)
    } else if (runtime.status === 'idle') {
      await this.clearInactiveTurn(current, channel)
    } else if (runtime.status === 'systemError') {
      throw new Error('Codex thread is unavailable for persisted prompt recovery')
    }
    await this.deliverPersistedDirectPromptsUnlocked(current, channel)
    if (this.blockedQueuedSourceThreads.has(channel.id)) {
      await this.reconcilePersistedQueuedSourcesUnlocked(current, channel)
    }
    if (!this.blockedQueuedSourceThreads.has(channel.id)) {
      await this.drainQueueAfterTurnUnlocked(current, channel, true)
    }
  }

  private async recoverPersistedPrompts(
    session: SessionState,
    channel: ThreadChannel,
    waitForRecovery = true,
  ): Promise<void> {
    const finishStartup = this.beginPendingStartupProgress(channel)
    try {
      if (waitForRecovery) await this.waitForCodexRecovery()
      await this.projectMutationQueue.run(`channel:${session.parentChannelId}`, async () => {
        await this.refreshProjectsSafely()
        if (
          this.removingProjects.has(session.parentChannelId) ||
          !this.config.projects[session.parentChannelId]
        ) {
          throw new Error('Project is no longer available')
        }
        await this.promptQueue.run(channel.id, () =>
          this.recoverPersistedPromptsUnlocked(session, channel))
      })
    } finally {
      finishStartup()
    }
  }

  private async persistAndDeliverDirectPrompt(
    session: SessionState,
    channel: ThreadChannel,
    prompt: QueuedPrompt,
  ): Promise<void> {
    await this.enqueuePrompt(channel.id, { ...prompt, deliveryKind: 'direct' })
    await this.recoverPersistedPrompts(session, channel)
  }

  async enqueueDaemonPrompt(options: {
    threadId: string
    requestId: string
    input: UserInput[]
    displayText: string
  }): Promise<{ threadId: string; position: number }> {
    if (this.stopping) throw new CordexStoppingError()
    await this.waitForIngressReady()
    const channel = await this.client.channels.fetch(options.threadId)
    if (!channel?.isThread()) throw new Error('Discord target is not an existing thread')
    const session = this.state.sessions[channel.id]
    if (!session || this.unlinkedCodexSessionChannels.has(channel.id)) {
      throw new Error('Discord thread has no Cordex session')
    }
    if (session.archived) throw new Error('Session is archived; resume it before sending')
    const position = await this.enqueuePrompt(channel.id, {
      id: `cli:${options.requestId}`,
      authorId: this.client.user?.id || this.config.applicationId,
      authorName: 'Cordex CLI',
      input: options.input,
      displayText: options.displayText,
      createdAt: new Date().toISOString(),
      deliveryKind: 'direct',
    })
    this.trackBackgroundWork(
      this.recoverPersistedPrompts(session, channel).catch((error: unknown) => {
        this.logVerbose('daemon prompt delivery deferred', {
          threadId: session.codexThreadId,
          requestId: options.requestId,
          error: errorText(error),
        })
      }),
      'daemon prompt recovery',
    )
    return { threadId: channel.id, position }
  }

  async uploadDaemonFiles(options: {
    target: { kind: 'thread' | 'session'; id: string }
    requestId: string
    filePaths: string[]
    allowOutsideProject: boolean
    rejectHidden?: boolean
  }): Promise<{ threadId: string; fileCount: number }> {
    if (this.stopping) throw new CordexStoppingError()
    await this.waitForMutationIngressReady()
    const candidates = options.target.kind === 'session'
      ? Object.values(this.state.sessions).filter((candidate) =>
          candidate.codexThreadId === options.target.id &&
          !this.unlinkedCodexSessionChannels.has(candidate.discordThreadId))
      : [this.state.sessions[options.target.id]].filter((candidate): candidate is SessionState =>
          candidate !== undefined)
    if (candidates.length !== 1) {
      throw new Error(candidates.length > 1
        ? 'Codex session maps to multiple Discord threads; use --thread to choose one'
        : 'No linked Cordex session matches the upload target')
    }
    const session = candidates[0]!
    if (session.archived || session.lifecycleIntent ||
      this.unlinkedCodexSessionChannels.has(session.discordThreadId)) {
      throw new Error('Session is unavailable; resume it before uploading files')
    }
    if (!this.config.projects[session.parentChannelId]) {
      throw new Error('Session parent project is no longer mapped')
    }
    const channel = await this.client.channels.fetch(session.discordThreadId)
    if (!channel?.isThread() ||
      channel.guildId !== this.config.guildId ||
      channel.parentId !== session.parentChannelId) {
      throw new Error('Discord session thread is unavailable or outside the configured project')
    }
    const identity = {
      discordThreadId: channel.id,
      codexThreadId: session.codexThreadId,
      turnId: `upload:${options.requestId}`,
      itemKey: 'files',
    }
    const outputKey = discordOutboxOutputKey(identity)
    const fileCount = await this.outgoingMediaQueue.run('cache', async () => {
      const existing = this.state.discordOutbox?.find((entry) =>
        discordOutboxOutputKey(entry) === outputKey)
      if (existing?.fileAttachments) return existing.fileAttachments.length
      if (this.state.discordOutboxDeliveredKeys?.includes(outputKey)) return 0
      const prepared = await readOutgoingFiles({
        paths: options.filePaths,
        sessionDirectory: session.directory,
        allowOutsideProject: options.allowOutsideProject,
        ...(options.rejectHidden ? { rejectHidden: true } : {}),
      })
      if (
        this.stopping ||
        this.state.sessions[channel.id] !== session ||
        session.archived ||
        session.lifecycleIntent ||
        !this.config.projects[session.parentChannelId]
      ) throw new Error('Session changed before the files could be queued')
      try {
        for (const file of prepared) {
          await cacheOutgoingFile(this.outgoingFileDirectory, file.bytes, file.attachment)
        }
        const fileAttachments = prepared.map((file) => file.attachment)
        const names = fileAttachments.map((attachment) => discordInlineCode(attachment.name)).join(', ')
        await this.persistDiscordOutput(createDiscordOutboxEntries({
          ...identity,
          chunks: [`📎 Uploaded ${fileAttachments.length} file${fileAttachments.length === 1 ? '' : 's'}: ${names}`],
          fileAttachments,
          suppressNotifications: false,
        }))
      } catch (error) {
        const referenced = (this.state.discordOutbox || []).flatMap((entry) =>
          entry.fileAttachments || [])
        await pruneOutgoingFileCache(this.outgoingFileDirectory, referenced).catch(() => undefined)
        throw error
      }
      return prepared.length
    })
    this.scheduleDiscordOutboxRetry(true)
    return { threadId: channel.id, fileCount }
  }

  private async steerNextQueuedPrompt(run: ActiveRun): Promise<void> {
    await this.promptQueue.run(run.channel.id, () => this.steerNextQueuedPromptUnlocked(run))
  }

  private async steerNextQueuedPromptUnlocked(run: ActiveRun): Promise<void> {
    if (
      this.deletedDiscordThreads.has(run.channel.id) ||
      run.session.archived ||
      run.session.abortIntent ||
      this.queueFor(run.channel.id).some((prompt) => prompt.reviewRequired) ||
      this.blockedQueuedSourceThreads.has(run.channel.id)
    ) return
    try {
      await this.removeDeliveredQueuePrompts(run.session, run.channel)
    } catch (error) {
      await run.channel.send(`⨯ Queued prompt deferred: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      return
    }
    if (this.deletedDiscordThreads.has(run.channel.id) || run.session.archived) return
    const turnId = run.turnId || run.session.activeTurnId
    const queue = this.queueFor(run.channel.id)
    const next = turnId ? queue[0] : undefined
    if (!turnId || !next) return
    try {
      const delivered = await this.steerActiveTurn(
        run.session,
        run.channel,
        next.input,
        this.queuedPromptDeliveryId(next),
      )
      if (!delivered) throw new Error('Active turn ended before the queued prompt was delivered')
      await this.removeQueuedPrompt(run.channel.id, next)
    } catch (error) {
      await run.channel.send(`⨯ Queued prompt deferred: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      return
    }
    await this.announceDeliveredPrompt(run.channel, next)
  }

  private async drainQueueAfterTurnUnlocked(
    session: SessionState,
    channel: ThreadChannel,
    allowWithoutGoal: boolean,
    knownGoalStatus?: string,
  ): Promise<void> {
    if (
      this.deletedDiscordThreads.has(channel.id) ||
      session.archived ||
      session.abortIntent ||
      this.queueFor(channel.id).some((prompt) => prompt.reviewRequired) ||
      this.blockedQueuedSourceThreads.has(channel.id)
    ) return
    const queue = this.queueFor(channel.id)
    if (queue.length === 0) return
    if (session.activeTurnId || this.runs.has(session.codexThreadId)) return
    try {
      await this.removeDeliveredQueuePrompts(session, channel)
    } catch (error) {
      await channel.send(`⨯ Queued prompt deferred: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      return
    }
    if (queue.length === 0) return
    let goalStatus = knownGoalStatus
    if (goalStatus === undefined) {
      try {
        goalStatus = (await this.codex.getThreadGoal(session.codexThreadId))?.status
      } catch (error) {
        this.logVerbose('goal lookup before queue drain failed', {
          threadId: session.codexThreadId,
          error: errorText(error),
        })
      }
    }
    if (goalStatus === 'active') return
    if (!allowWithoutGoal && !goalStatus) return
    const next = queue[0]
    if (!next) return
    try {
      await this.markPromptDeliveryStarted(next)
    } catch (error) {
      await channel.send(`⨯ Queued prompt deferred before delivery: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      return
    }
    try {
      await this.dispatchInputUnlocked(
        channel,
        session.parentChannelId,
        next.input,
        this.queuedPromptDeliveryId(next),
      )
      await this.removeQueuedPrompt(channel.id, next)
    } catch (error) {
      await this.holdUncertainPrompt(session, channel, next)
      await channel.send(`⨯ Queued prompt deferred: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      return
    }
    await this.announceDeliveredPrompt(channel, next)
  }

  private scheduleQueueDrain(
    session: SessionState,
    channel: ThreadChannel,
    allowWithoutGoal: boolean,
    knownGoalStatus?: string,
  ): void {
    this.trackBackgroundWork((async () => {
      while (!this.stopping) {
        await this.waitForCodexRecovery()
        let retryAfterRecovery = false
        try {
          await this.projectMutationQueue.run(`channel:${session.parentChannelId}`, async () => {
            if (this.removingProjects.has(session.parentChannelId)) return
            if (this.codexRecoveryPromise) {
              retryAfterRecovery = true
              return
            }
            await this.promptQueue.run(
              channel.id,
              () => this.drainQueueAfterTurnUnlocked(
                session,
                channel,
                allowWithoutGoal,
                knownGoalStatus,
              ),
            )
          })
        } catch (error) {
          console.error(`Failed to drain queued Discord prompt: ${errorText(error)}`)
          return
        }
        if (!retryAfterRecovery) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    })(), 'queued Discord prompt drain')
  }

  private async handleQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    const message = interaction.options.getString('message', true)
    const input: UserInput[] = [{ type: 'text', text: message, text_elements: [] }]
    const position = await this.enqueuePrompt(channel.id, {
      id: interaction.id,
      authorId: interaction.user.id,
      authorName: interaction.user.displayName,
      input,
      displayText: message,
      createdAt: new Date().toISOString(),
      deliveryKind: 'queued',
    })
    await this.recoverPersistedPrompts(session, channel)
    const remainsQueued = this.queueFor(channel.id).some((prompt) =>
      this.queuedPromptDeliveryId(prompt) === interaction.id)
    await interaction.reply({
      content: remainsQueued
        ? `Queued message (position ${position})`
        : `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${truncate(message, 1_000)}`,
    })
  }

  private async handleClearQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel } = this.requireThreadSession(interaction)
    const position = interaction.options.getInteger('position')
    const removed = await this.promptQueue.run(channel.id, async () => {
      const queue = this.queueFor(channel.id)
      const original = [...queue]
      const queued = this.queuedPromptsFor(channel.id)
      try {
        if (position !== null) {
          const selected = queued[position - 1]
          if (!selected) throw new Error(`No queued message at position ${position}`)
          const index = queue.indexOf(selected)
          if (index >= 0) queue.splice(index, 1)
          await saveState(this.state)
          return [selected]
        }
        for (let index = queue.length - 1; index >= 0; index--) {
          if (this.promptDeliveryKind(queue[index]!) === 'queued') queue.splice(index, 1)
        }
        await saveState(this.state)
        return queued
      } catch (error) {
        queue.splice(0, queue.length, ...original)
        throw error
      }
    })
    await interaction.reply({
      content: clearedQueueReply(removed),
      allowedMentions: { parse: [] },
    })
  }

  private async handlePendingPromptsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel } = this.requirePendingPromptTarget(interaction)
    await interaction.deferReply({ ephemeral: true })
    if (!interaction.ephemeral) {
      await interaction.editReply('⨯ Private pending-prompt review is unavailable for this interaction.')
      return
    }
    const pending = this.queueFor(channel.id).filter((prompt) => prompt.reviewRequired)
    if (pending.length === 0) {
      await interaction.editReply('No uncertain prompts are waiting for review.')
      return
    }
    const later = this.queueFor(channel.id).length - pending.length
    const lines = pending.map((prompt, index) =>
      `${index + 1}. ${this.promptDeliveryKind(prompt)} source ID ${discordInlineCode(this.queuedPromptDeliveryId(prompt))}\n` +
      `   ${escapeInlineMarkdown(truncate(prompt.displayText.replace(/\s+/g, ' '), 700))}`)
    await this.replyWithChunks(interaction, [
      `**Uncertain prompts:** ${pending.length}`,
      ...lines,
      `${later} later saved prompt${later === 1 ? '' : 's'} held behind them.`,
      'Codex may already have accepted a prompt even if its history does not show it yet.',
      'Use /resolve-pending with the exact source ID to retry or discard one prompt. Retrying can duplicate side effects; inspect the transcript and workspace first.',
    ].join('\n'), { ephemeral: true })
  }

  private async handleResolvePendingInitialSession(
    interaction: ChatInputCommandInteraction,
    channel: ThreadChannel,
    pendingInitial: PendingInitialSession,
    action: 'retry' | 'discard',
    sourceId: string,
  ): Promise<void> {
    type InitialResolution =
      | { kind: 'missing' }
      | { kind: 'discarded'; laterHeld: boolean }
      | { kind: 'retry'; session: SessionState }
    let result: InitialResolution
    try {
      result = await this.projectMutationQueue.run(`channel:${pendingInitial.parentChannelId}`, async () => {
        await this.refreshProjectsSafely()
        return this.promptQueue.run(channel.id, async (): Promise<InitialResolution> => {
          if (this.state.pendingInitialSessions?.[channel.id] !== pendingInitial ||
            this.state.sessions[channel.id] ||
            channel.guildId !== this.config.guildId ||
            channel.parentId !== pendingInitial.parentChannelId ||
            !this.config.projects[pendingInitial.parentChannelId] ||
            this.deletedDiscordThreads.has(channel.id)) {
            throw new Error('Pending Codex session is no longer available')
          }
          if (pendingInitial.abortIntent && !pendingInitial.abortIntent.reconciledAt) {
            throw new Error('Pending Codex session cancellation is still being reconciled')
          }
          const queue = this.queueFor(channel.id)
          const selected = queue.find((prompt) =>
            prompt.reviewRequired && this.queuedPromptDeliveryId(prompt) === sourceId)
          if (!selected) return { kind: 'missing' }
          await this.clearPendingInitialSessionNotice(channel.id)
          if (action === 'discard') {
            const previousQueue = [...queue]
            const previousReviews = queue.map((prompt) => prompt.reviewRequired === true)
            let removedEmptyQueue = false
            queue.splice(queue.indexOf(selected), 1)
            if (queue.length > 0) queue[0]!.reviewRequired = true
            else {
              delete this.state.pendingInitialSessions![channel.id]
              delete this.state.queues[channel.id]
              removedEmptyQueue = true
            }
            try {
              await saveState(this.state)
            } catch (error) {
              if (removedEmptyQueue) this.state.queues[channel.id] = queue
              queue.splice(0, queue.length, ...previousQueue)
              previousQueue.forEach((prompt, index) => {
                if (previousReviews[index]) prompt.reviewRequired = true
                else delete prompt.reviewRequired
              })
              this.state.pendingInitialSessions![channel.id] = pendingInitial
              throw error
            }
            return { kind: 'discarded', laterHeld: queue.length > 0 }
          }

          const runtimeRoots = pendingInitial.workspaceRoots?.length
            ? [...new Set([path.resolve(pendingInitial.directory), ...pendingInitial.workspaceRoots])]
            : undefined
          const serviceTier = await this.serviceTierForFastMode(
            pendingInitial.model || this.config.defaultModel,
            pendingInitial.fastMode,
          )
          const started = await this.codex.startThread({
            cwd: pendingInitial.directory,
            ...(pendingInitial.model ? { model: pendingInitial.model } : {}),
            ...(serviceTier !== undefined ? { serviceTier } : {}),
            dynamicTools: cordexDynamicTools,
            ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
            sandbox: pendingInitial.yoloMode ? 'danger-full-access' : this.config.sandbox,
            approvalPolicy: pendingInitial.yoloMode ? 'never' : this.config.approvalPolicy,
          })
          if (this.state.pendingInitialSessions?.[channel.id] !== pendingInitial ||
            this.state.sessions[channel.id] || this.deletedDiscordThreads.has(channel.id)) {
            throw new Error('Pending Codex session changed during creation')
          }
          const session: SessionState = {
            discordThreadId: channel.id,
            parentChannelId: pendingInitial.parentChannelId,
            directory: pendingInitial.directory,
            codexThreadId: started.threadId,
            model: pendingInitial.model || started.model,
            ...(pendingInitial.effort || started.effort
              ? { effort: pendingInitial.effort || started.effort }
              : {}),
            ...(pendingInitial.fastMode !== undefined ? { fastMode: pendingInitial.fastMode } : {}),
            ...(pendingInitial.yoloMode !== undefined ? { yoloMode: pendingInitial.yoloMode } : {}),
            ...(pendingInitial.workspaceRoots?.length
              ? { workspaceRoots: [...pendingInitial.workspaceRoots] }
              : {}),
            ...(pendingInitial.worktree ? { worktree: { ...pendingInitial.worktree } } : {}),
            updatedAt: new Date().toISOString(),
          }
          this.state.sessions[channel.id] = session
          delete this.state.pendingInitialSessions![channel.id]
          try {
            await saveState(this.state)
          } catch (error) {
            delete this.state.sessions[channel.id]
            this.state.pendingInitialSessions![channel.id] = pendingInitial
            throw error
          }
          this.loadedThreads.add(started.threadId)
          await this.synchronizeCodexThreadTitle(started.threadId, channel.name)
            .catch((error: unknown) => {
              this.logVerbose('pending-session title sync deferred', {
                threadId: started.threadId,
                error: errorText(error),
              })
            })
          delete selected.reviewRequired
          try {
            await saveState(this.state)
          } catch (error) {
            selected.reviewRequired = true
            throw error
          }
          return { kind: 'retry', session }
        })
      })
    } catch (error) {
      await this.holdPendingInitialPrompt(channel, pendingInitial)
      throw error
    }
    if (result.kind === 'missing') {
      await interaction.editReply('No uncertain prompt matches that source ID. Run /pending-prompts again.')
      return
    }
    if (result.kind === 'discarded') {
      if (result.laterHeld) await this.sendPendingInitialSessionNotice(channel, pendingInitial)
      await interaction.editReply(result.laterHeld
        ? 'Saved prompt discarded. Later work remains held until you review its exact source ID.'
        : 'Saved prompt discarded. No pending Codex session creation remains.')
      return
    }
    try {
      await this.recoverPersistedPrompts(result.session, channel)
    } catch (error) {
      await this.promptQueue.run(channel.id, async () => {
        const prompt = this.queueFor(channel.id).find((item) =>
          this.queuedPromptDeliveryId(item) === sourceId)
        if (!prompt) return
        prompt.reviewRequired = true
        await saveState(this.state)
      })
      throw error
    }
    await interaction.editReply(
      'A Codex thread was saved before retrying this exact prompt. Watch this thread for output; an unanswered earlier thread/start may have left an empty orphan.',
    )
  }

  private isUnloadedCodexThreadError(error: unknown, threadId: string): boolean {
    return error instanceof Error &&
      error.message === `Codex RPC -32600: thread not loaded: ${threadId}`
  }

  private isMissingCodexRolloutError(error: unknown, threadId: string): boolean {
    return error instanceof Error &&
      error.message === `Codex RPC -32600: no rollout found for thread id ${threadId}`
  }

  private isUnsupportedCodexHistoryError(error: unknown): boolean {
    return error instanceof Error &&
      error.message.startsWith('Codex RPC -32601: list_turns is not supported yet')
  }

  private async confirmMissingCodexRollout(session: SessionState): Promise<boolean> {
    const threadId = session.codexThreadId
    const runtimeRoots = this.runtimeWorkspaceRoots(session)
    const serviceTier = await this.serviceTierForFastMode(
      session.model || this.config.defaultModel,
      session.fastMode,
    )
    let resumed: Awaited<ReturnType<CodexAppServer['resumeThread']>>
    try {
      resumed = await this.codex.resumeThread({
        threadId,
        cwd: session.directory,
        ...(session.model ? { model: session.model } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
        ...(!session.yoloMode && session.permissions
          ? { permissions: session.permissions }
          : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
        approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
        ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
      })
    } catch (error) {
      if (this.isMissingCodexRolloutError(error, threadId)) return true
      throw error
    }
    this.assertCodexSessionLinked(session)
    if (session.effort && resumed.effort !== session.effort) {
      await this.codex.updateThreadSettings({ threadId, effort: session.effort })
    }
    this.loadedThreads.add(threadId)
    return false
  }

  private async replaceMissingCodexThread(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    this.assertCodexSessionLinked(session)
    this.assertDiscordThreadAvailable(channel.id)
    if (session.archived || session.abortIntent || session.activeTurnId ||
      session.lifecycleIntent || this.runs.has(session.codexThreadId)) {
      throw new Error('Cannot replace a Codex thread while this session is active or changing')
    }
    if (!this.config.projects[session.parentChannelId]) {
      throw new Error('Project is no longer available')
    }
    const runtimeRoots = this.runtimeWorkspaceRoots(session)
    const serviceTier = await this.serviceTierForFastMode(
      session.model || this.config.defaultModel,
      session.fastMode,
    )
    const started = await this.codex.startThread({
      cwd: session.directory,
      ...(session.model ? { model: session.model } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      dynamicTools: cordexDynamicTools,
      ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
      ...(!session.yoloMode && session.permissions
        ? { permissions: session.permissions }
        : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
      approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
      ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
    })
    this.assertCodexSessionLinked(session)
    const oldThreadId = session.codexThreadId
    const oldUpdatedAt = session.updatedAt
    const oldContextTokens = session.contextTokens
    const oldContextWindow = session.contextWindow
    session.codexThreadId = started.threadId
    session.updatedAt = new Date().toISOString()
    delete session.contextTokens
    delete session.contextWindow
    try {
      await saveState(this.state)
    } catch (error) {
      session.codexThreadId = oldThreadId
      session.updatedAt = oldUpdatedAt
      if (oldContextTokens !== undefined) session.contextTokens = oldContextTokens
      if (oldContextWindow !== undefined) session.contextWindow = oldContextWindow
      throw error
    }
    this.loadedThreads.delete(oldThreadId)
    this.loadedThreads.add(started.threadId)
    await this.synchronizeCodexThreadTitle(started.threadId, channel.name)
      .catch((error: unknown) => {
        this.logVerbose('replacement Codex thread title sync deferred', {
          threadId: started.threadId,
          error: errorText(error),
        })
      })
  }

  private async handleResolvePendingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = this.requirePendingPromptTarget(interaction)
    const { channel } = target
    const action = interaction.options.getString('action', true)
    const sourceId = interaction.options.getString('source-id', true).trim()
    if (action !== 'retry' && action !== 'discard') throw new Error('Invalid pending-prompt action')
    if (!sourceId) throw new Error('Source ID is required')
    await interaction.deferReply({ ephemeral: true })
    if (!interaction.ephemeral) {
      await interaction.editReply('⨯ Private pending-prompt resolution is unavailable for this interaction.')
      return
    }
    if (target.pendingInitial) {
      await this.handleResolvePendingInitialSession(
        interaction, channel, target.pendingInitial, action, sourceId,
      )
      return
    }
    const session = target.session
    if (!session) throw new Error('Thread has no Cordex session')
    const result = await this.promptQueue.run(channel.id, async () => {
      const queue = this.queueFor(channel.id)
      const pending = queue.find((prompt) =>
        prompt.reviewRequired && this.queuedPromptDeliveryId(prompt) === sourceId)
      if (!pending) return 'missing' as const
      let runtime: CodexThreadRuntimeState | undefined
      let missingRollout = false
      try {
        runtime = await this.readThreadRuntimeState(session)
      } catch (error) {
        if (!this.isUnloadedCodexThreadError(error, session.codexThreadId) &&
          !this.isMissingCodexRolloutError(error, session.codexThreadId)) throw error
        missingRollout = await this.confirmMissingCodexRollout(session)
        if (!missingRollout) runtime = await this.readThreadRuntimeState(session)
      }
      if (runtime?.status === 'systemError') {
        throw new Error('Codex thread is unavailable for pending-prompt review')
      }
      if (runtime) await this.removeDeliveredQueuePrompts(session, channel, runtime)
      if (!queue.includes(pending)) return 'accepted' as const
      if (action === 'discard') {
        await this.removeQueuedPrompt(channel.id, pending)
        return missingRollout ? 'discarded-missing' as const : 'discarded' as const
      }
      if (missingRollout) await this.replaceMissingCodexThread(session, channel)
      delete pending.reviewRequired
      try {
        await saveState(this.state)
      } catch (error) {
        pending.reviewRequired = true
        throw error
      }
      return missingRollout ? 'retry-recreated' as const : 'retry' as const
    })
    if (result === 'missing') {
      await interaction.editReply('No uncertain prompt matches that source ID. Run /pending-prompts again.')
      return
    }
    if (result === 'accepted') {
      await this.recoverPersistedPrompts(session, channel)
      await interaction.editReply('Codex had already accepted that prompt. It was removed from the pending queue without retry.')
      return
    }
    if (result === 'discarded') {
      await this.recoverPersistedPrompts(session, channel)
      await interaction.editReply('Uncertain prompt discarded. Later queued work may now run automatically.')
      return
    }
    if (result === 'discarded-missing') {
      await this.recoverPersistedPrompts(session, channel).catch((error: unknown) => {
        if (!this.isUnloadedCodexThreadError(error, session.codexThreadId) &&
          !this.isMissingCodexRolloutError(error, session.codexThreadId)) throw error
      })
      await interaction.editReply(
        'Uncertain prompt discarded. Its Codex thread was not persisted; later work remains held for review.',
      )
      return
    }
    try {
      await this.recoverPersistedPrompts(session, channel)
    } catch (error) {
      await this.promptQueue.run(channel.id, async () => {
        const prompt = this.queueFor(channel.id).find((item) =>
          this.queuedPromptDeliveryId(item) === sourceId)
        if (!prompt) return
        prompt.reviewRequired = true
        await saveState(this.state)
      })
      throw error
    }
    await interaction.editReply(result === 'retry-recreated'
      ? 'The old Codex thread had no persisted rollout. A replacement thread was saved before retrying this exact prompt. Watch this thread for output; a prior acceptance not visible in history could still cause duplicate work.'
      : 'Retry requested for the exact saved prompt. Watch this thread for Codex output; a prior acceptance not visible in history could still cause duplicate work.')
  }

  private async sendShellResult(interaction: ChatInputCommandInteraction, command: string, directory: string): Promise<void> {
    if (!this.config.allowShellCommands) {
      throw new Error('Direct shell commands are disabled; set allowShellCommands to true to enable them')
    }
    await interaction.deferReply()
    const result = await runShellCommand({ command, cwd: directory })
    await interaction.editReply(formatShellCommandResult({
      command,
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }))
  }

  private async handleShellCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { project } = this.requireProject(this.parentChannelId(interaction.channel))
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    if (session?.lifecycleIntent) {
      throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
    }
    if (session?.abortIntent) throw new Error('Turn abort is still pending')
    const directory = session?.directory || project.directory
    await this.sendShellResult(interaction, interaction.options.getString('command', true), directory)
  }

  private async handleLastSessionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const searchTerm = interaction.options.getString('query')?.trim() || undefined
    const includeArchived = interaction.options.getBoolean('include-archived') === true
    const threads = await this.listAllProjectThreads(20, {
      ...(searchTerm ? { searchTerm } : {}),
      includeArchived,
    })
    const lines = threads.map((thread, index) => {
      const title = (thread.name || thread.preview || 'Untitled').replace(/\s+/g, ' ').trim()
      return `${index + 1}. **${escapeInlineMarkdown(truncate(title, 80))}**${thread.archived ? ' · archived' : ''}\n${discordInlineCode(thread.id)} · ${discordInlineCode(thread.cwd)}`
    })
    await this.replyWithChunks(
      interaction,
      lines.join('\n') || (searchTerm
        ? `No Codex session titles match ${discordInlineCode(searchTerm)} in mapped projects${includeArchived ? ' (including archived)' : ''}.`
        : 'No Codex sessions found.'),
      { ephemeral: true },
    )
  }

  private async handleContextUsageCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    if (session.contextTokens === undefined) {
      await interaction.reply({ content: 'Token usage not available for this session yet.' })
      return
    }
    const usage = formatContextUsage({
      contextTokens: session.contextTokens,
      ...(session.contextWindow !== undefined ? { contextWindow: session.contextWindow } : {}),
    })
    if (!usage) {
      await interaction.reply({ content: 'Token usage not available for this session yet.' })
      return
    }
    const run = this.runs.get(session.codexThreadId)
    await interaction.reply({
      content: `**Context usage:** ${usage}\n**Model:** ${formatModelLabel(run?.model || session.model || this.config.defaultModel || 'Codex default', run?.effort || session.effort || this.config.defaultEffort || 'default')}`,
    })
  }

  private verbosityFor(session: SessionState): VerbosityLevel {
    return this.state.channelVerbosity[session.parentChannelId] || defaultVerbosity
  }

  private async handleVerbosityCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Verbosity requires a project channel')
    const level = interaction.options.getString('level') as VerbosityLevel | null
    if (!level) {
      const override = Object.hasOwn(this.state.channelVerbosity, parentId)
      const current = this.state.channelVerbosity[parentId] || defaultVerbosity
      await interaction.reply({
        content: `**Verbosity**\nCurrent: \`${current}\` (${override ? 'channel override' : 'global default'})`,
      })
      return
    }
    const previous = this.state.channelVerbosity[parentId]
    const hadPrevious = Object.hasOwn(this.state.channelVerbosity, parentId)
    this.state.channelVerbosity[parentId] = level
    try {
      await saveState(this.state)
    } catch (error) {
      if (hadPrevious) this.state.channelVerbosity[parentId] = previous!
      else delete this.state.channelVerbosity[parentId]
      throw error
    }
    const description = level === 'tools_and_text'
      ? 'All output including tool executions and status messages'
      : level === 'text_and_essential_tools'
        ? 'Text + essential tools (edits, custom MCP). Hides read/search.'
        : 'Agent text plus essential progress and turn-end status. Hides tool details and routine footers.'
    await interaction.reply({
      content: `Verbosity set to \`${level}\` for this channel.\n${description}\nApplies immediately, including active sessions.`,
    })
  }

  private async handleSessionIdCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    const command = `cd ${shellQuote(session.directory)} && codex resume ${shellQuote(session.codexThreadId)}`
    await interaction.reply({
      content: `**Session ID:** \`${session.codexThreadId}\`\n**Resume command:**\n\`\`\`bash\n${command}\n\`\`\``,
      ephemeral: true,
    })
  }

  private async handleAbortCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.channel?.isThread()) throw new Error('Abort must run inside a Cordex thread')
    const channel = interaction.channel
    const session = this.state.sessions[channel.id]
    if (!session) {
      const pending = this.state.pendingInitialSessions?.[channel.id]
      if (!pending) {
        await interaction.reply({ content: 'No active turn.' })
        return
      }
      const state = await this.promptQueue.run(channel.id, async () => {
        if (this.state.pendingInitialSessions?.[channel.id] !== pending ||
          this.state.sessions[channel.id]) {
          throw new Error('Pending Codex session is no longer available')
        }
        const first = this.queueFor(channel.id)[0]
        if (!first) return 'empty' as const
        if (pending.abortIntent?.reconciledAt) return 'reconciled' as const
        if (pending.abortIntent) return 'pending' as const
        const previousReview = first.reviewRequired === true
        pending.abortIntent = { requestedAt: new Date().toISOString() }
        first.reviewRequired = true
        try {
          await saveState(this.state)
        } catch (error) {
          delete pending.abortIntent
          if (!previousReview) delete first.reviewRequired
          throw error
        }
        return 'requested' as const
      })
      if (state === 'empty') {
        await interaction.reply({ content: 'No active turn.' })
        return
      }
      this.stopPendingStartupProgress(channel.id)
      await this.sendPendingInitialSessionNotice(channel, pending)
      await interaction.reply(state === 'reconciled'
        ? 'Codex session creation is already cancelled. Saved prompts remain held for review.'
        : state === 'pending'
          ? 'Codex session creation cancellation is already pending. Saved prompts will not run automatically.'
          : 'Abort requested. Codex session creation will be cancelled; saved prompts will not run automatically.')
      return
    }
    const activeTurnId = this.runs.get(session.codexThreadId)?.turnId || session.activeTurnId
    const hadPendingStart = this.pendingTurnStarts.has(session.codexThreadId)
    const hadIntent = session.abortIntent !== undefined
    await this.persistAbortIntent(session, activeTurnId)
    await this.dismissPendingControlsForChannel(channel.id, '_Turn aborted._')
    const result = await this.reconcileAbortIntent(session, activeTurnId)
    if (result.errors.length > 0) {
      await interaction.reply({
        content: `Abort requested; confirmation pending: ${truncate(result.errors.join('; '), 1_700)}`,
      })
      return
    }
    let backgroundWarning = ''
    if (activeTurnId || hadPendingStart || hadIntent) {
      try {
        const terminals = await this.codex.listBackgroundTerminals(session.codexThreadId)
        if (terminals.length > 0) {
          backgroundWarning = `\n${terminals.length} background terminal${terminals.length === 1 ? '' : 's'} still running. Use /ps to inspect or /stop to terminate.`
        }
      } catch (error) {
        backgroundWarning = '\nBackground terminal status could not be verified; use /ps to inspect it.'
        this.logVerbose('post-abort background terminal query failed', {
          threadId: session.codexThreadId,
          error: errorText(error),
        })
      }
    }
    if (
      result.cleared &&
      !activeTurnId &&
      !hadPendingStart &&
      !hadIntent &&
      !result.goalPaused &&
      !result.interrupted
    ) {
      await interaction.reply({ content: `No active turn.${backgroundWarning}` })
      return
    }
    await interaction.reply(`Abort requested.${backgroundWarning}`)
  }

  private async handlePsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await this.ensureSessionLoaded(session)
    const terminals = await this.codex.listBackgroundTerminals(session.codexThreadId)
    const lines = terminals.map((terminal) =>
      `• ${discordInlineCode(terminal.processId)} — ${escapeInlineMarkdown(truncate(terminal.command.replace(/\s+/g, ' ').trim(), 150))} — ${discordInlineCode(terminal.cwd)}`,
    )
    await this.replyWithChunks(
      interaction,
      lines.join('\n') || 'No background terminals in this Codex session.',
      { ephemeral: true },
    )
  }

  private async handleStopCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await this.ensureSessionLoaded(session)
    const selected = interaction.options.getString('process-id')?.trim()
    const before = await this.codex.listBackgroundTerminals(session.codexThreadId)
    if (selected) {
      if (!before.some((terminal) => terminal.processId === selected)) {
        await interaction.reply(`No running background terminal with Codex process ID ${discordInlineCode(selected)}.`)
        return
      }
      const terminated = await this.codex.terminateBackgroundTerminal(session.codexThreadId, selected)
      if (!terminated) {
        await interaction.reply(`Codex process ${discordInlineCode(selected)} was no longer running.`)
        return
      }
    } else {
      if (before.length === 0) {
        await interaction.reply('No background terminals to stop.')
        return
      }
      await this.codex.cleanBackgroundTerminals(session.codexThreadId)
    }
    let remaining = await this.codex.listBackgroundTerminals(session.codexThreadId)
    for (let attempt = 0; remaining.length > 0 && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      remaining = await this.codex.listBackgroundTerminals(session.codexThreadId)
    }
    this.reportedBackgroundTerminals.set(
      session.codexThreadId,
      new Set(remaining.map((terminal) => terminal.processId)),
    )
    await interaction.reply(
      remaining.length === 0
        ? `Stopped ${selected ? 'the selected' : String(before.length)} background terminal${selected || before.length === 1 ? '' : 's'}.`
        : `Stop requested; ${remaining.length} background terminal${remaining.length === 1 ? '' : 's'} still reported. Run /ps to inspect.`,
    )
  }

  private async runtimeRestartBlockers(): Promise<string[]> {
    const blockers: string[] = []
    if (this.runtimeRestartRequested || this.stopping) blockers.push('a shutdown or restart is already pending')
    if (this.codexRecoveryPromise || this.codexUnavailableError) blockers.push('the Codex runtime is recovering or unavailable')
    if (this.runs.size > 0 || Object.values(this.state.sessions).some((session) => session.activeTurnId)) {
      blockers.push('a Codex turn is active or being finalized')
    }
    if (this.pendingTurnStarts.size > 0 || Object.keys(this.state.pendingInitialSessions || {}).length > 0) {
      blockers.push('session or turn creation is pending')
    }
    if (Object.values(this.state.queues).some((queue) => queue.length > 0)) {
      blockers.push('queued or uncertain prompts remain')
    }
    if ((this.state.discordOutbox?.length || 0) > 0 || this.discordOutboxRetryTimer) {
      blockers.push('Discord output is pending delivery')
    }
    if (Object.values(this.state.tasks).some((task) => task.status === 'running')) {
      blockers.push('a scheduled occurrence is running')
    }
    if (Object.values(this.state.sessions).some((session) => session.lifecycleIntent || session.abortIntent)) {
      blockers.push('a session lifecycle or abort intent is pending')
    }
    if (
      this.approvals.size > 0 ||
      this.pendingUserInputs.size > 0 ||
      this.pendingActionButtons.size > 0 ||
      this.pendingMcpElicitations.size > 0 ||
      this.pendingRequestControls.size > 0
    ) blockers.push('an approval, question, action, or elicitation is pending')
    if (
      this.archivingDiscordThreads.size > 0 ||
      this.removingProjects.size > 0 ||
      this.pendingSessionDirectoryReservations.size > 0
    ) blockers.push('a project or session mutation is pending')
    if (blockers.length > 0) return blockers

    try {
      const terminals = await Promise.all(
        [...this.loadedThreads].map((threadId) => this.codex.listBackgroundTerminals(threadId)),
      )
      if (terminals.some((entries) => entries.length > 0)) blockers.push('a background terminal is still running')
    } catch {
      blockers.push('background-terminal readiness could not be verified')
    }
    return blockers
  }

  private async handleRestartCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (!this.config.runtimeRestartUserIds?.includes(interaction.user.id)) {
      throw new Error('Runtime restart is disabled for this Discord user')
    }
    if (!this.options.requestRuntimeRestart) throw new Error('This Cordex host does not support managed restart handoff')

    const blockers = await this.runtimeRestartBlockers()
    const confirm = interaction.options.getString('confirm')?.trim()
    if (!confirm) {
      await interaction.reply({
        content: blockers.length > 0
          ? `Runtime restart is currently blocked:\n${blockers.map((blocker) => `• ${blocker}`).join('\n')}`
          : `Runtime restart is ready. Re-run /restart with confirm set to the exact current session ID ${discordInlineCode(session.codexThreadId)}. The host must use a restart-on-failure supervisor; Cordex exits with code 75.`,
        allowedMentions: { parse: [] },
      })
      return
    }
    if (confirm !== session.codexThreadId) throw new Error('Restart confirmation must exactly match the current Codex session ID')
    if (blockers.length > 0) throw new Error(`Runtime restart blocked: ${blockers.join('; ')}`)

    this.runtimeRestartRequested = true
    const requestedAt = new Date().toISOString()
    const epochSeconds = Math.floor(Date.parse(requestedAt) / 1_000)
    const restartId = interaction.id
    const turnId = `cordex-restart:${restartId}`
    const itemKey = 'replacement-ready'
    try {
      await interaction.reply({
        content: 'Restart checks passed. Persisting the supervisor handoff now; Cordex has not exited yet.',
        allowedMentions: { parse: [] },
      })
      await this.stageDurableDiscordOutput({
        channel,
        codexThreadId: session.codexThreadId,
        turnId,
        itemKey,
        value: `✓ Cordex restarted after the supervisor handoff requested <t:${epochSeconds}:R>. This confirms the replacement reached Discord and recovered the durable outbox. Use /status to verify session state.`,
        suppressNotifications: false,
        format: false,
      })
      const staged = this.state.discordOutbox?.some((entry) =>
        entry.discordThreadId === channel.id &&
        entry.codexThreadId === session.codexThreadId &&
        entry.turnId === turnId &&
        entry.itemKey === itemKey)
      if (!staged) throw new Error('Durable restart completion could not be staged')
      await interaction.reply({
        content: 'Restart handoff persisted. Cordex is exiting with code 75 and waiting for the configured external supervisor.',
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
    } catch (error) {
      this.runtimeRestartRequested = false
      throw error
    }

    setImmediate(() => this.options.requestRuntimeRestart?.())
  }

  private async handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Status requires a project channel')
    const project = this.config.projects[parentId]
    const session = interaction.channel?.isThread() ? this.state.sessions[interaction.channel.id] : undefined
    const run = session ? this.runs.get(session.codexThreadId) : undefined
    const active = Boolean(session?.activeTurnId || run)
    const directory = session?.directory || project?.directory
    const model = session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default'
    const effort = session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default'
    const yolo = session?.yoloMode ?? this.state.channelYoloMode[parentId] ?? false
    const fast = session?.fastMode ?? this.state.channelFastMode[parentId] ?? false
    const queued = interaction.channel?.isThread()
      ? this.queuedPromptsFor(interaction.channel.id).length
      : 0
    const context = session?.contextTokens === undefined
      ? 'unavailable'
      : formatContextUsage({
          contextTokens: session.contextTokens,
          ...(session.contextWindow !== undefined ? { contextWindow: session.contextWindow } : {}),
        }) || 'unavailable'
    const policy = yolo
      ? { sandbox: 'danger-full-access', approval: 'never' }
      : session?.permissions
        ? { sandbox: 'controlled by permission profile', approval: this.config.approvalPolicy }
        : { sandbox: this.config.sandbox, approval: this.config.approvalPolicy }
    const writableRoots = yolo || (!session?.permissions && this.config.sandbox === 'danger-full-access')
      ? 'unrestricted'
      : session?.permissions
        ? 'controlled by permission profile'
        : this.config.sandbox === 'read-only'
          ? 'none (read-only sandbox)'
          : directory
            ? [directory, ...(session?.workspaceRoots || [])]
                .filter((root, index, roots) => roots.indexOf(root) === index)
                .map(discordInlineCode)
                .join(', ')
            : 'unavailable'
    const lines = [
      `Project: ${project ? discordInlineCode(project.directory) : 'not configured'}`,
      `Working directory: ${directory ? discordInlineCode(directory) : 'unavailable'}`,
      `Session: ${session ? discordInlineCode(session.codexThreadId) : 'none'}`,
      `Turn: ${session?.activeTurnId ? `active (${discordInlineCode(session.activeTurnId)})` : active ? 'starting or recovering' : 'idle'}`,
      ...(active ? [
        `Current turn model: ${run ? formatModelLabel(run.model, run.effort) : 'unavailable while starting or recovering'}`,
        `Next turn model: ${formatModelLabel(model, effort)}`,
      ] : [`Model: ${formatModelLabel(model, effort)}`]),
      `Mode${active ? ' (next turn)' : ''}: ${session?.mode || 'default'}`,
      `Fast mode${active ? ' (next turn)' : ''}: ${fast ? 'on' : 'off'}`,
      `YOLO mode${active ? ' (next turn)' : ''}: ${yolo ? 'on' : 'off'}`,
      `Sandbox${active ? ' (next turn)' : ''}: ${policy.sandbox}`,
      `Approval policy${active ? ' (next turn)' : ''}: ${policy.approval}`,
      ...(session?.permissions ? [`Permission profile: ${discordInlineCode(session.permissions)}${yolo ? ' (bypassed by YOLO)' : ''}`] : []),
      ...(active ? [`Current turn reviewer: ${run?.approvalsReviewer || 'configured default (not captured)'}`] : []),
      `Reviewer preference${active ? ' (next turn)' : ''}: ${session?.approvalsReviewer || 'configured default'}`,
      `Writable roots${active ? ' (next turn)' : ''}: ${writableRoots}`,
      `Context usage: ${context}`,
      `Auto worktrees: ${this.state.channelAutoWorktrees[parentId] ? 'enabled' : 'disabled'}`,
      `Verbosity: ${this.state.channelVerbosity[parentId] || defaultVerbosity}`,
      `Queue: ${queued}`,
    ]
    await this.replyWithChunks(interaction, lines.join('\n'), { ephemeral: true })
  }

  private async handleDebugConfigCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Config diagnostics require a project channel')
    const project = this.config.projects[parentId]
    if (!project) throw new Error('This channel is not mapped to a project')
    const session = interaction.channel?.isThread() ? this.state.sessions[interaction.channel.id] : undefined
    const cwd = session?.directory || project.directory
    await interaction.deferReply({ ephemeral: true })
    if (!interaction.ephemeral) {
      await interaction.editReply('⨯ Private config diagnostics are unavailable for this interaction.')
      return
    }

    let response: JsonObject
    try {
      const raw = await this.codex.request('config/read', { includeLayers: true, cwd })
      if (!isRecord(raw) || !isRecord(raw.config)) throw new Error('Invalid config/read response')
      response = raw
    } catch {
      await interaction.editReply('⨯ Codex configuration diagnostics are unavailable for this project.')
      return
    }

    let requirements: JsonObject | null | undefined
    try {
      const raw = await this.codex.request('configRequirements/read', {})
      requirements = isRecord(raw) && isRecord(raw.requirements)
        ? raw.requirements
        : isRecord(raw) && raw.requirements === null
          ? null
          : undefined
    } catch {
      requirements = undefined
    }

    const config = response.config as JsonObject
    const origins = isRecord(response.origins) ? response.origins : {}
    const describeSource = (value: unknown): string => {
      if (!isRecord(value)) return 'unattributed'
      const source = isRecord(value.name) ? value.name : value
      const type = text(source.type) || 'unknown'
      if (type === 'user' && typeof source.profile === 'string') {
        return `profile ${discordInlineCode(truncate(source.profile, 80))}`
      }
      return discordInlineCode(truncate(type, 80))
    }
    const safeSetting = (key: string, label: string): string => {
      const value = config[key]
      const rendered = typeof value === 'string'
        ? discordInlineCode(truncate(value, 100))
        : value === null || value === undefined
          ? 'not set'
          : 'configured (details hidden)'
      return `${label}: ${rendered} · source: ${describeSource(origins[key])}`
    }
    const hasLayers = Array.isArray(response.layers)
    const rawLayers = hasLayers ? response.layers as unknown[] : []
    const layers = rawLayers.filter(isRecord).reverse()
    const layerLines = layers.map((layer, index) => {
      const name = isRecord(layer.name) ? layer.name : {}
      const type = text(name.type) || 'unknown'
      const location = typeof name.dotCodexFolder === 'string'
        ? name.dotCodexFolder
        : typeof name.file === 'string'
          ? name.file
          : typeof name.name === 'string'
            ? name.name
            : null
      const source = location ? ` · ${discordInlineCode(truncate(location, 160))}` : ''
      const disabled = typeof layer.disabledReason === 'string' && layer.disabledReason
        ? ' · disabled (reason hidden)'
        : ' · active'
      const keys = isRecord(layer.config) ? Object.keys(layer.config) : []
      const shownKeys = keys.slice(0, 20).map((key) => discordInlineCode(truncate(key, 70)))
      const keySummary = shownKeys.length
        ? shownKeys.join(', ') + (keys.length > shownKeys.length ? `, +${keys.length - shownKeys.length} more` : '')
        : 'no settings'
      return `${index + 1}. ${discordInlineCode(truncate(type, 70))}${source}${disabled}\n   Keys: ${keySummary}`
    })
    const policyLines = requirements === undefined
      ? ['Managed requirements: unavailable (Codex did not return them).']
      : requirements === null
        ? ['Managed requirements: none configured.']
        : [
            'Managed requirements: configured.',
            `Policy sections: ${Object.keys(requirements).slice(0, 25).map((key) => discordInlineCode(truncate(key, 70))).join(', ') || 'none'}${Object.keys(requirements).length > 25 ? ', …' : ''}`,
            ...(Array.isArray(requirements.allowedApprovalPolicies)
              ? [`Allowed approvals: ${requirements.allowedApprovalPolicies.slice(0, 12).map((value) => discordInlineCode(truncate(String(value), 70))).join(', ') || 'none'}`]
              : []),
            ...(Array.isArray(requirements.allowedSandboxModes)
              ? [`Allowed sandboxes: ${requirements.allowedSandboxModes.slice(0, 12).map((value) => discordInlineCode(truncate(String(value), 70))).join(', ') || 'none'}`]
              : []),
            ...(isRecord(requirements.network) ? ['Network requirements: configured (details hidden).'] : []),
          ]
    const lines = [
      '**Codex configuration diagnostics**',
      `Working directory: ${discordInlineCode(truncate(cwd, 300))}`,
      '_Effective config defaults; an active turn or session override may differ._',
      safeSetting('model', 'Model'),
      safeSetting('model_reasoning_effort', 'Reasoning effort'),
      safeSetting('service_tier', 'Service tier'),
      safeSetting('approval_policy', 'Approval policy'),
      safeSetting('sandbox_mode', 'Sandbox mode'),
      '',
      `**Layers (lowest precedence first):** ${hasLayers ? String(layers.length) : 'unavailable'}`,
      ...layerLines,
      '',
      ...policyLines,
      '_Only setting names and selected non-secret defaults are shown; config values are not dumped._',
    ]
    await this.replyWithChunks(interaction, lines.join('\n'), { ephemeral: true })
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (!message.guild || message.guild.id !== this.config.guildId || message.author.bot) return
    await this.refreshProjectsSafely().catch((error: unknown) => {
      console.error(`Could not refresh project mappings: ${errorText(error)}`)
    })
    const parentId = message.channel.isThread() ? message.channel.parentId : message.channel.id
    if (!parentId || !this.config.projects[parentId]) return
    if (this.removingProjects.has(parentId)) return
    if (!(await this.memberAllowed(message.author.id))) return
    const leadingMention = message.channel.isThread()
      ? message.content.match(/^\s*<@!?(\d+)>/)
      : null
    const isPassiveContext = Boolean(
      leadingMention && leadingMention[1] !== this.client.user?.id,
    )
    const finishStartup = message.channel.isThread() &&
      !isPassiveContext &&
      !message.content.startsWith('!')
      ? this.beginPendingStartupProgress(message.channel)
      : () => undefined
    try {
      let interactivePreparationError: unknown
      if (message.channel.isThread() && !isPassiveContext) {
        const channel = message.channel
        const session = this.state.sessions[channel.id]
        if (session) {
          try {
            await this.codexEventQueue.run(session.codexThreadId, async () => {
              const current = this.state.sessions[channel.id]
              if (current?.codexThreadId !== session.codexThreadId) return
              await this.prepareSessionForUserPrompt(current, channel)
            })
          } catch (error) {
            interactivePreparationError = error
          }
        }
      }
      if (message.content.startsWith('!')) {
        if (interactivePreparationError) throw interactivePreparationError
        if (!this.config.allowShellCommands) {
          throw new Error('Direct shell commands are disabled by Cordex configuration')
        }
        const command = message.content.slice(1).trim()
        if (!command) return
        const project = this.config.projects[parentId]
        const session = message.channel.isThread()
          ? this.state.sessions[message.channel.id]
          : undefined
        if (session?.lifecycleIntent) {
          throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
        }
        const directory = session?.directory || project.directory
        this.logVerbose('shell command', { command, directory, userId: message.author.id })
        const result = await runShellCommand({ command, cwd: directory })
        const content = formatShellCommandResult({
          command,
          output: result.output,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        })
        if (message.channel.isThread()) await message.channel.send(content)
        else await message.reply(content)
        return
      }
      if (message.channel.isThread()) {
        if (isPassiveContext) {
          const session = this.state.sessions[message.channel.id]
          if (!session) return
          await this.injectPassiveDiscordContext(session, message)
          return
        }
        await this.processPrompt(
          message.channel,
          parentId,
          message,
          undefined,
          interactivePreparationError,
        )
        return
      }
      if (message.channel.type !== ChannelType.GuildText) return
      const name = normalizeThreadTitle(message.content)
      const worktree = await this.createAutomaticWorktree(parentId, name)
      let thread: ThreadChannel | undefined
      try {
        if (this.removingProjects.has(parentId)) throw new Error('Project is being removed')
        thread = await message.startThread({
          name: normalizeThreadTitle(`${worktree ? '⬦ ' : ''}${message.content}`),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Codex session',
        })
        await thread.members.add(message.author.id).catch(() => undefined)
        const finishThreadStartup = this.beginPendingStartupProgress(thread)
        try {
          await this.processPrompt(thread, parentId, message, worktree)
        } finally {
          finishThreadStartup()
        }
      } catch (error) {
        const pendingInitial = thread && this.state.pendingInitialSessions?.[thread.id]
        if (worktree && (!thread || (!this.state.sessions[thread.id] && !pendingInitial))) {
          await removeWorktree(worktree).catch(() => undefined)
        }
        if (thread && !this.state.sessions[thread.id] && !pendingInitial) {
          await thread.delete('Cordex session could not be started').catch(() => undefined)
        }
        if (thread && pendingInitial) {
          await message.reply(
            `⚠ Codex session creation is pending review in ${thread}. The prompt is saved; open that thread and use /pending-prompts.`,
          ).catch(() => undefined)
          return
        }
        throw error
      }
    } catch (error) {
      const content = `⨯ ${truncate(errorText(error), 1_850)}`
      if (message.channel.isThread()) await message.channel.send(content).catch(() => undefined)
      else await message.reply(content).catch(() => undefined)
    } finally {
      finishStartup()
    }
  }

  private async injectPassiveDiscordContext(
    session: SessionState,
    message: DiscordMessage,
  ): Promise<void> {
    await this.ensureSessionLoaded(session)
    const built = await this.buildInput(message)
    const textContent = built.input
      .flatMap((item) => item.type === 'text' ? [item.text] : [])
      .join('\n\n')
      .trim()
    const attachmentNames = [...message.attachments.values()]
      .map((attachment) => attachment.name)
      .filter((name): name is string => Boolean(name))
    const body = textContent || message.content.trim() || '(attachment-only message)'
    const attachmentNote = attachmentNames.length > 0
      ? `\n\nAttachments referenced in Discord: ${attachmentNames.join(', ')}`
      : ''
    await this.codex.injectThreadItems(session.codexThreadId, [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          `Discord conversation context from ${message.author.displayName} (${message.author.id}).`,
          'This message was addressed to another user and did not request a Cordex response.',
          '',
          `${body}${attachmentNote}`,
        ].join('\n'),
      }],
    }])
    await this.pruneAttachmentCache().catch(() => undefined)
  }

  private async buildInput(
    message: DiscordMessage,
    contentOverride?: string,
  ): Promise<DiscordInputResult> {
    return buildDiscordInput({
      message,
      ...(this.client.user?.id ? { botUserId: this.client.user.id } : {}),
      ...(contentOverride !== undefined ? { contentOverride } : {}),
    })
  }

  private async requireSupportedInput(
    channel: ThreadChannel,
    built: DiscordInputResult,
  ): Promise<UserInput[]> {
    if (built.input.length === 0) {
      throw new Error(
        built.feedback.map((item) => item.message).join(' ') ||
        'Message has no prompt text or supported attachment',
      )
    }
    if (built.feedback.length > 0) {
      await channel.send({
        content: truncate(built.feedback.map((item) => `⚠ ${item.message}`).join('\n'), 1_900),
        allowedMentions: { parse: [] },
      })
    }
    return built.input
  }

  private btwInput(input: UserInput[]): UserInput[] {
    const instruction = 'Answer only this side question. Do not continue the previous task.'
    const textIndex = input.findIndex((item) => item.type === 'text')
    if (textIndex < 0) {
      return [{ type: 'text', text: `${instruction}\n\nInspect the attached input.`, text_elements: [] }, ...input]
    }
    return input.map((item, index) => index === textIndex && item.type === 'text'
      ? { ...item, text: `${instruction}\n\n${item.text}` }
      : item)
  }

  private async processPrompt(
    channel: ThreadChannel,
    parentChannelId: string,
    message: DiscordMessage,
    initialWorktree?: CreatedWorktree,
    interactivePreparationError?: unknown,
  ): Promise<void> {
    this.assertDiscordThreadAvailable(channel.id)
    const session = this.state.sessions[channel.id]
    const pendingInitial = this.state.pendingInitialSessions?.[channel.id]
    const btw = session ? parseBtwMessage(message.content) : { prompt: message.content, fork: false }
    if (session && btw.fork) {
      if (interactivePreparationError) throw interactivePreparationError
      const input = this.btwInput(await this.requireSupportedInput(
        channel,
        await this.buildInput(message, btw.prompt),
      ))
      this.assertDiscordThreadAvailable(channel.id)
      const forked = await this.forkSession({
        source: session,
        parentChannelId: session.parentChannelId,
        name: `BTW: ${btw.prompt || 'attachment'}`,
        userId: message.author.id,
      })
      await this.dispatchInput(
        forked.thread,
        session.parentChannelId,
        input,
        message.id,
      )
      await this.pruneAttachmentCache().catch(() => undefined)
      await channel.send(`Side session started: ${forked.thread}`)
      return
    }

    const parsed = parseQueueMessage(message.content)
    const queuedContent = parsed.queued ? parsed.text : undefined
    if (interactivePreparationError && !session?.abortIntent) {
      throw interactivePreparationError
    }
    const input = await this.requireSupportedInput(
      channel,
      await this.buildInput(message, queuedContent),
    )
    this.assertDiscordThreadAvailable(channel.id)
    if (pendingInitial && !session) {
      if (channel.guildId !== this.config.guildId ||
        channel.parentId !== pendingInitial.parentChannelId) {
        throw new Error('Pending Codex session is outside the configured project')
      }
      const position = await this.enqueuePendingInitialPrompt(channel.id, {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.displayName,
        input,
        displayText: (queuedContent ?? message.content.trim()) || '(attachment)',
        createdAt: new Date().toISOString(),
        sourceMessageId: message.id,
        deliveryKind: 'queued',
      })
      await channel.send(`Saved prompt (position ${position}) while Codex session creation awaits review. Use /pending-prompts.`)
      await this.pruneAttachmentCache().catch(() => undefined)
      return
    }
    if (queuedContent !== undefined && session) {
      const position = await this.enqueuePrompt(channel.id, {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.displayName,
        input,
        displayText: queuedContent || '(attachment)',
        createdAt: new Date().toISOString(),
        sourceMessageId: message.id,
        deliveryKind: 'queued',
      })
      if (interactivePreparationError) throw interactivePreparationError
      await this.recoverPersistedPrompts(session, channel)
      await this.pruneAttachmentCache().catch(() => undefined)
      if (this.queueFor(channel.id).some((prompt) => this.queuedPromptDeliveryId(prompt) === message.id)) {
        await channel.send(`Queued message (position ${position})`)
      }
      return
    }
    if (session) {
      await this.enqueuePrompt(channel.id, {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.displayName,
        input,
        displayText: message.content.trim() || '(attachment)',
        createdAt: new Date().toISOString(),
        sourceMessageId: message.id,
        deliveryKind: 'direct',
      })
      if (interactivePreparationError) throw interactivePreparationError
      await this.recoverPersistedPrompts(session, channel)
      await this.pruneAttachmentCache().catch(() => undefined)
      return
    }
    await this.dispatchInput(
      channel,
      parentChannelId,
      input,
      message.id,
      initialWorktree
        ? { directory: initialWorktree.directory, worktree: initialWorktree }
        : undefined,
    )
    await this.pruneAttachmentCache().catch(() => undefined)
  }

  private async createAutomaticWorktree(
    parentChannelId: string,
    sessionName: string,
  ): Promise<CreatedWorktree | undefined> {
    return this.projectMutationQueue.run(`channel:${parentChannelId}`, async () => {
      await this.refreshProjectsSafely()
      if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
      if (!this.state.channelAutoWorktrees[parentChannelId]) return undefined
      const project = this.config.projects[parentChannelId]
      if (!project) throw new Error('Project not configured')
      const uniqueName = `${truncate(sessionName, 48)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      return createWorktree({
        projectDirectory: project.directory,
        dataRoot: getCordexHome(),
        name: uniqueName,
      })
    })
  }

  private async dispatchInput(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
    initialLocation?: InitialSessionLocation,
  ): Promise<void> {
    this.assertDiscordThreadAvailable(channel.id)
    const initialPrompt: QueuedPrompt | undefined = clientUserMessageId
      ? {
          id: clientUserMessageId,
          authorId: 'discord-user',
          authorName: 'Discord user',
          input,
          displayText: input.flatMap((item) => item.type === 'text' ? [item.text] : [])
            .join('\n').trim() || '(attachment)',
          createdAt: new Date().toISOString(),
          sourceMessageId: clientUserMessageId,
          deliveryKind: 'direct',
        }
      : undefined
    const finishStartup = this.beginPendingStartupProgress(channel)
    try {
      await this.waitForCodexRecovery()
      await this.projectMutationQueue.run(`channel:${parentChannelId}`, async () => {
        await this.refreshProjectsSafely()
        if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
        this.assertDiscordThreadAvailable(channel.id)
        try {
          await this.dispatchInputUnlocked(
            channel,
            parentChannelId,
            input,
            clientUserMessageId,
            initialLocation,
            0,
            initialPrompt,
          )
          if (initialPrompt) {
            const queued = this.queueFor(channel.id).find((prompt) =>
              this.queuedPromptDeliveryId(prompt) === clientUserMessageId)
            if (queued) await this.removeQueuedPrompt(channel.id, queued)
          }
        } catch (error) {
          const session = this.state.sessions[channel.id]
          const pendingInitial = this.state.pendingInitialSessions?.[channel.id]
          const queued = initialPrompt && this.queueFor(channel.id).find((prompt) =>
            this.queuedPromptDeliveryId(prompt) === clientUserMessageId)
          if (session && queued?.deliveryStarted) {
            await this.holdUncertainPrompt(session, channel, queued)
          } else if (!session && pendingInitial) {
            await this.holdPendingInitialPrompt(channel, pendingInitial)
          }
          throw error
        }
      })
    } finally {
      finishStartup()
    }
  }

  private assertDiscordThreadAvailable(threadId: string): void {
    if (this.deletedDiscordThreads.has(threadId)) throw new Error('Discord thread was deleted')
  }

  private assertCodexSessionLinked(session: SessionState): void {
    if (
      this.unlinkedCodexSessionChannels.has(session.discordThreadId) ||
      this.state.sessions[session.discordThreadId]?.codexThreadId !== session.codexThreadId
    ) {
      throw new Error('Thread has no Codex session')
    }
  }

  private async dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
    initialLocation?: InitialSessionLocation,
    deliveryAttempt = 0,
    initialPrompt?: QueuedPrompt,
  ): Promise<void> {
    this.assertDiscordThreadAvailable(channel.id)
    if (this.archivingDiscordThreads.has(channel.id)) throw new Error('Session is being archived')
    const project = this.config.projects[parentChannelId]
    if (!project) throw new Error('Project not configured')
    let session = this.state.sessions[channel.id]
    if (session?.lifecycleIntent) {
      throw new Error(`Session ${session.lifecycleIntent.kind} operation is still pending`)
    }
    if (session?.abortIntent) throw new Error('Turn abort is still pending')
    if (session) this.assertCodexSessionLinked(session)
    if (session?.archived) throw new Error('Session is archived; run /resume first')
    let persistedInitialPrompt: QueuedPrompt | undefined
    if (session && initialPrompt) {
      const queue = this.queueFor(channel.id)
      persistedInitialPrompt = queue.find((prompt) =>
        this.queuedPromptDeliveryId(prompt) === this.queuedPromptDeliveryId(initialPrompt))
      if (!persistedInitialPrompt) {
        queue.push(initialPrompt)
        try {
          await saveState(this.state)
        } catch (error) {
          const index = queue.indexOf(initialPrompt)
          if (index >= 0) queue.splice(index, 1)
          throw error
        }
        persistedInitialPrompt = initialPrompt
      }
    }
    let createdSession = false
    if (!session) {
      if (this.state.pendingInitialSessions?.[channel.id]) {
        throw new Error('Session creation has saved work awaiting review; use /pending-prompts')
      }
      const model = this.state.channelModels[parentChannelId] || this.config.defaultModel
      const fastMode = this.state.channelFastMode[parentChannelId]
      const yoloMode = this.state.channelYoloMode[parentChannelId] ?? false
      const selectedEffort = this.state.channelEfforts[parentChannelId] || this.config.defaultEffort
      const directory = initialLocation?.directory || project.directory
      const runtimeWorkspaceRoots = initialLocation?.workspaceRoots?.length
        ? [...new Set([
            path.resolve(directory),
            ...initialLocation.workspaceRoots.map((root) => path.resolve(root)),
          ])]
        : undefined
      if (initialPrompt) {
        const queue = this.queueFor(channel.id)
        if (queue.length > 0) {
          throw new Error('Thread has saved work without a Codex session; use /pending-prompts')
        }
        const pendingInitial: PendingInitialSession = {
          parentChannelId,
          directory,
          createdAt: new Date().toISOString(),
          ...(model ? { model } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
          ...(Object.hasOwn(this.state.channelYoloMode, parentChannelId) ? { yoloMode } : {}),
          ...(runtimeWorkspaceRoots ? { workspaceRoots: runtimeWorkspaceRoots } : {}),
          ...(initialLocation?.worktree
            ? { worktree: {
                projectDirectory: initialLocation.worktree.projectDirectory,
                directory: initialLocation.worktree.directory,
                branch: initialLocation.worktree.branch,
              } }
            : {}),
        }
        queue.push(initialPrompt)
        ;(this.state.pendingInitialSessions ??= {})[channel.id] = pendingInitial
        try {
          await saveState(this.state)
        } catch (error) {
          const index = queue.indexOf(initialPrompt)
          if (index >= 0) queue.splice(index, 1)
          delete this.state.pendingInitialSessions[channel.id]
          throw error
        }
        persistedInitialPrompt = initialPrompt
      }
      const serviceTier = await this.serviceTierForFastMode(model, fastMode)
      let started!: Awaited<ReturnType<CodexAppServer['startThread']>>
      try {
        started = await this.codex.startThread({
          cwd: directory,
          ...(model ? { model } : {}),
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          dynamicTools: cordexDynamicTools,
          ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
          sandbox: yoloMode ? 'danger-full-access' : this.config.sandbox,
          approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
        })
        const abortedPending = this.state.pendingInitialSessions?.[channel.id]
        if (abortedPending?.abortIntent) {
          await this.reconcilePendingInitialAbort(channel.id, abortedPending, started.threadId)
          throw new Error('Codex session creation was cancelled')
        }
      } catch (error) {
        const abortedPending = this.state.pendingInitialSessions?.[channel.id]
        if (!started && abortedPending?.abortIntent) {
          await this.reconcilePendingInitialAbort(channel.id, abortedPending)
        }
        throw error
      }
      const effectiveEffort = this.state.channelEfforts[parentChannelId] ||
        this.config.defaultEffort || started.effort
      session = {
        discordThreadId: channel.id,
        parentChannelId,
        directory,
        codexThreadId: started.threadId,
        model: model || started.model,
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(fastMode !== undefined ? { fastMode } : {}),
        ...(Object.hasOwn(this.state.channelYoloMode, parentChannelId) ? { yoloMode } : {}),
        ...(initialLocation?.workspaceRoots?.length
          ? { workspaceRoots: [...initialLocation.workspaceRoots] }
          : {}),
        ...(initialLocation?.worktree
          ? {
              worktree: {
                projectDirectory: initialLocation.worktree.projectDirectory,
                directory: initialLocation.worktree.directory,
                branch: initialLocation.worktree.branch,
              },
            }
          : {}),
        updatedAt: new Date().toISOString(),
      }
      this.state.sessions[channel.id] = session
      createdSession = true
      this.loadedThreads.add(session.codexThreadId)
      const pendingInitial = this.state.pendingInitialSessions?.[channel.id]
      if (pendingInitial) delete this.state.pendingInitialSessions![channel.id]
      if (initialPrompt) {
        const queue = this.queueFor(channel.id)
        persistedInitialPrompt = queue.find((prompt) =>
          this.queuedPromptDeliveryId(prompt) === this.queuedPromptDeliveryId(initialPrompt))
        if (!persistedInitialPrompt) {
          queue.push(initialPrompt)
          persistedInitialPrompt = initialPrompt
        }
      }
      try {
        await saveState(this.state)
      } catch (error) {
        delete this.state.sessions[channel.id]
        if (pendingInitial) this.state.pendingInitialSessions![channel.id] = pendingInitial
        else if (initialPrompt && persistedInitialPrompt === initialPrompt) {
          const queue = this.queueFor(channel.id)
          const index = queue.indexOf(initialPrompt)
          if (index >= 0) queue.splice(index, 1)
        }
        this.loadedThreads.delete(started.threadId)
        throw error
      }
      this.unlinkedCodexSessionChannels.delete(channel.id)
      if (this.deletedDiscordThreads.has(channel.id)) {
        await this.persistDeletedThreadIntent(session, 'delete')
        await this.codex.deleteThread(started.threadId)
        await this.finalizeDeletedDiscordThread(session)
        this.assertDiscordThreadAvailable(channel.id)
      }
      await this.synchronizeCodexThreadTitle(session.codexThreadId, channel.name)
        .catch(async () => {
          await channel.send(
            '⚠ Session title synchronization failed; Cordex will retry on the next load.',
          ).catch(() => undefined)
        })
    } else await this.ensureSessionLoaded(session)
    this.assertCodexSessionLinked(session)
    this.assertDiscordThreadAvailable(channel.id)
    if (createdSession) {
      await channel.send(formatModelBanner(
        session.model || this.config.defaultModel || 'Codex default',
        session.effort || this.config.defaultEffort || 'default',
      ))
    }

    if (persistedInitialPrompt) {
      if (persistedInitialPrompt.reviewRequired || persistedInitialPrompt.deliveryStarted) {
        throw new Error('Saved prompt needs delivery review; use /pending-prompts')
      }
      await this.markPromptDeliveryStarted(persistedInitialPrompt)
    }

    if (await this.steerActiveTurn(session, channel, input, clientUserMessageId)) return
    this.assertDiscordThreadAvailable(channel.id)
    await channel.sendTyping().catch((error: unknown) => {
      if (isUnknownDiscordChannelError(error)) throw error
      this.logVerbose('typing notice deferred before turn start', {
        channelId: channel.id,
        error: errorText(error),
      })
    })
    this.assertDiscordThreadAvailable(channel.id)
    const runtimeRoots = this.runtimeWorkspaceRoots(session)
    const serviceTier = await this.serviceTierForFastMode(
      session.model || this.config.defaultModel,
      session.fastMode,
    )
    let turnId: string | undefined
    let retryAfterStartFailure = false
    let abortMaterializedTurn = false
    let startError: unknown
    this.pendingTurnStarts.add(session.codexThreadId)
    try {
      turnId = await this.codex.startTurn({
        threadId: session.codexThreadId,
        input,
        cwd: session.directory,
        ...(session.model ? { model: session.model } : {}),
        ...(session.effort ? { effort: session.effort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(session.mode ? { mode: session.mode } : {}),
        ...(session.approvalsReviewer ? { approvalsReviewer: session.approvalsReviewer } : {}),
        ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
        ...(!session.yoloMode && session.permissions ? { permissions: session.permissions } : {}),
        ...(session.yoloMode
          ? { sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const }
          : {}),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      })
      this.assertCodexSessionLinked(session)
      if (session.abortIntent) {
        const reconciliation = await this.reconcileAbortIntent(session, turnId)
        abortMaterializedTurn = true
        if (reconciliation.errors.length > 0) {
          this.logVerbose('materialized turn abort reconciliation pending', {
            threadId: session.codexThreadId,
            errors: reconciliation.errors,
          })
        }
      } else if (this.deletedDiscordThreads.has(channel.id)) {
        await this.interruptDeletedTurn(channel.id, session.codexThreadId, turnId)
          .catch(() => undefined)
        this.assertDiscordThreadAvailable(channel.id)
      }
    } catch (error) {
      startError = error
      if (session.abortIntent) {
        const reconciliation = await this.reconcileAbortIntent(session)
        abortMaterializedTurn = true
        if (reconciliation.errors.length > 0) {
          this.logVerbose('pending start abort reconciliation pending', {
            threadId: session.codexThreadId,
            errors: reconciliation.errors,
          })
        }
      } else {
        if (this.deletedDiscordThreads.has(channel.id)) {
          if (!turnId) {
            await this.interruptDeletedRuntimeTurn(channel.id, session).catch((interruptError: unknown) => {
              this.logVerbose('deleted thread turn reconciliation failed', {
                threadId: session.codexThreadId,
                error: errorText(interruptError),
              })
            })
          }
          throw error
        }
        await this.waitForActiveTurn(session)
        let runtime: CodexThreadRuntimeState
        try {
          runtime = await this.readThreadRuntimeState(session)
        } catch {
          throw error
        }
        if (this.runtimeHasClientMessage(runtime, clientUserMessageId)) {
          await this.reconcileDeliveredInput(session, channel, runtime)
          return
        }
        const activeTurnId = await this.reconcileActiveTurn(session, channel, runtime)
        // A missing user item immediately after an RPC error does not prove that
        // Codex rejected the input. clientUserMessageId is not an idempotency key.
        if (clientUserMessageId) throw error
        if (!activeTurnId) throw error
        if (await this.steerActiveTurn(session, channel, input, clientUserMessageId)) return
        retryAfterStartFailure = true
      }
    } finally {
      this.pendingTurnStarts.delete(session.codexThreadId)
    }
    if (abortMaterializedTurn || session.abortIntent) {
      const reconciliation = await this.reconcileAbortIntent(session)
      if (reconciliation.errors.length > 0) {
        this.logVerbose('turn abort confirmation pending', {
          threadId: session.codexThreadId,
          errors: reconciliation.errors,
        })
      }
      this.assertDiscordThreadAvailable(channel.id)
      return
    }
    if (retryAfterStartFailure) {
      if (deliveryAttempt >= 3) throw startError
      await this.dispatchInputUnlocked(
        channel,
        parentChannelId,
        input,
        clientUserMessageId,
        initialLocation,
        deliveryAttempt + 1,
      )
      return
    }
    if (!turnId) throw startError || new Error('Codex turn did not start')
    session.activeTurnId = turnId
    session.updatedAt = new Date().toISOString()
    this.startRun(session, channel)
    await saveState(this.state)
  }

  private async reconcileActiveTurn(
    session: SessionState,
    channel: ThreadChannel,
    knownRuntime?: CodexThreadRuntimeState,
  ): Promise<string | undefined> {
    const runtime = knownRuntime || await this.readThreadRuntimeState(session)
    if (runtime.status !== 'active' || !runtime.activeTurnId) return undefined
    await this.adoptActiveTurn(session, channel, runtime.activeTurnId)
    return runtime.activeTurnId
  }

  private async readThreadRuntimeState(
    session: SessionState,
  ): Promise<CodexThreadRuntimeState> {
    this.assertCodexSessionLinked(session)
    let runtime = await this.codex.getThreadRuntimeState(session.codexThreadId)
    this.assertCodexSessionLinked(session)
    if (runtime.status !== 'notLoaded') return runtime
    this.loadedThreads.delete(session.codexThreadId)
    await this.ensureSessionLoaded(session)
    this.assertCodexSessionLinked(session)
    runtime = await this.codex.getThreadRuntimeState(session.codexThreadId)
    this.assertCodexSessionLinked(session)
    return runtime
  }

  private async interruptRuntimeTurn(session: SessionState): Promise<void> {
    const runtime = await this.readThreadRuntimeState(session)
    if (runtime.status !== 'active' || !runtime.activeTurnId) return
    await this.codex.interruptTurn(session.codexThreadId, runtime.activeTurnId)
  }

  private async interruptDeletedRuntimeTurn(
    discordThreadId: string,
    session: SessionState,
  ): Promise<void> {
    const runtime = await this.readThreadRuntimeState(session)
    if (runtime.status !== 'active' || !runtime.activeTurnId) return
    await this.interruptDeletedTurn(
      discordThreadId,
      session.codexThreadId,
      runtime.activeTurnId,
    )
  }

  private runtimeHasClientMessage(
    runtime: CodexThreadRuntimeState,
    clientUserMessageId?: string,
  ): boolean {
    return Boolean(
      clientUserMessageId && runtime.userMessageClientIds?.includes(clientUserMessageId),
    )
  }

  private async adoptActiveTurn(
    session: SessionState,
    channel: ThreadChannel,
    activeTurnId: string,
  ): Promise<void> {
    if (session.abortIntent) throw new Error('Turn abort is still pending')
    const previousTurnId = session.activeTurnId
    session.activeTurnId = activeTurnId
    session.updatedAt = new Date().toISOString()
    const run = this.startRun(session, channel)
    if (previousTurnId !== activeTurnId || run.turnId !== activeTurnId) {
      run.turnId = activeTurnId
      run.agentText.clear()
      run.activeItems.clear()
      run.startedAt = Date.now()
      run.visibleOutput = false
    }
    await saveState(this.state)
  }

  private async clearInactiveTurn(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    const staleRun = this.runs.get(session.codexThreadId)
    if (staleRun) {
      clearInterval(staleRun.typingTimer)
      this.runs.delete(session.codexThreadId)
    }
    const hadActiveTurn = session.activeTurnId !== undefined
    delete session.activeTurnId
    if (!staleRun && !hadActiveTurn) return
    session.updatedAt = new Date().toISOString()
    await this.dismissPendingControlsForChannel(channel.id, '_Turn already ended._')
    await saveState(this.state)
  }

  private async reconcileDeliveredInput(
    session: SessionState,
    channel: ThreadChannel,
    runtime: CodexThreadRuntimeState,
  ): Promise<void> {
    if (runtime.status === 'active' && runtime.activeTurnId) {
      await this.adoptActiveTurn(session, channel, runtime.activeTurnId)
      return
    }
    await this.clearInactiveTurn(session, channel)
  }

  private async steerActiveTurn(
    session: SessionState,
    channel: ThreadChannel,
    input: UserInput[],
    clientUserMessageId?: string,
    remainingReconciliations = 3,
  ): Promise<boolean> {
    this.assertCodexSessionLinked(session)
    if (session.abortIntent) throw new Error('Turn abort is still pending')
    const expectedTurnId = session.activeTurnId
    if (!expectedTurnId) return false
    const steer = (turnId: string) => this.codex.steerTurn({
      threadId: session.codexThreadId,
      expectedTurnId: turnId,
      input,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    })
    try {
      await steer(expectedTurnId)
      this.assertCodexSessionLinked(session)
      return true
    } catch (steerError) {
      let runtime: CodexThreadRuntimeState
      try {
        runtime = await this.readThreadRuntimeState(session)
      } catch {
        throw steerError
      }

      if (this.runtimeHasClientMessage(runtime, clientUserMessageId)) {
        await this.reconcileDeliveredInput(session, channel, runtime)
        return true
      }

      // Even a now-idle or different active turn can follow an accepted steer.
      // Leave persisted input for explicit review instead of replaying it,
      // but stop a stale heartbeat or follow the authoritative active turn.
      if (clientUserMessageId) {
        if (runtime.status === 'idle') await this.clearInactiveTurn(session, channel)
        else if (runtime.status === 'active' && runtime.activeTurnId && runtime.activeTurnId !== expectedTurnId) {
          await this.adoptActiveTurn(session, channel, runtime.activeTurnId)
        }
        throw steerError
      }

      if (runtime.status === 'active' && runtime.activeTurnId) {
        if (runtime.activeTurnId === expectedTurnId) throw steerError
        if (!this.runs.has(session.codexThreadId)) await channel.sendTyping().catch(() => undefined)
        await this.adoptActiveTurn(session, channel, runtime.activeTurnId)
        if (remainingReconciliations <= 0) throw steerError
        return this.steerActiveTurn(
          session,
          channel,
          input,
          clientUserMessageId,
          remainingReconciliations - 1,
        )
      }
      if (runtime.status !== 'idle') throw steerError
      await this.clearInactiveTurn(session, channel)
      return false
    }
  }

  private async waitForActiveTurn(
    session: SessionState,
    timeoutMs = 1_000,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    while (!session.activeTurnId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return session.activeTurnId
  }

  private async handleQueuedMessageUpdate(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return
    const threadId = Object.entries(this.state.queues).find(([, queue]) =>
      queue.some((item) =>
        this.promptDeliveryKind(item) === 'queued' && item.sourceMessageId === message.id))?.[0]
    if (!threadId) return
    await this.promptQueue.run(threadId, async () => {
      const queue = this.queueFor(threadId)
      const original = [...queue]
      const index = queue.findIndex((item) =>
        this.promptDeliveryKind(item) === 'queued' && item.sourceMessageId === message.id)
      const channel = message.channel.isThread()
        ? message.channel
        : await this.client.channels.fetch(threadId).then((target) =>
            target?.isThread() ? target : undefined).catch(() => undefined)
      if (index === -1) {
        await channel?.send('Queue update ignored: the prompt was already delivered.').catch(() => undefined)
        return
      }
      const queued = queue[index]
      if (!queued) return
      const parsed = parseQueueMessage(message.content)
      let displayText = 'removed'
      if (!parsed.queued) {
        queue.splice(index, 1)
      } else if (!channel) {
        return
      } else {
        try {
          const input = await this.requireSupportedInput(
            channel,
            await this.buildInput(message, parsed.text),
          )
          queue[index] = {
            ...queued,
            input: [
              ...queued.input.filter((item) => item.type === 'skill'),
              ...input,
            ],
            displayText: parsed.text || '(attachment)',
          }
          displayText = parsed.text || '(attachment)'
        } catch (error) {
          displayText = `unchanged (${errorText(error)})`
        }
      }
      try {
        await saveState(this.state)
      } catch (error) {
        queue.splice(0, queue.length, ...original)
        await this.pruneAttachmentCache().catch(() => undefined)
        throw error
      }
      await this.pruneAttachmentCache().catch(() => undefined)
      await channel?.send(`Queue updated: ${truncate(displayText, 1_700)}`).catch(() => undefined)
    })
  }

  private async handleQueuedMessageDelete(messageId: string): Promise<void> {
    const threadId = Object.entries(this.state.queues).find(([, queue]) =>
      queue.some((item) =>
        this.promptDeliveryKind(item) === 'queued' && item.sourceMessageId === messageId))?.[0]
    if (!threadId) return
    await this.promptQueue.run(threadId, async () => {
      const queue = this.queueFor(threadId)
      const original = [...queue]
      const index = queue.findIndex((item) =>
        this.promptDeliveryKind(item) === 'queued' && item.sourceMessageId === messageId)
      if (index === -1) return
      queue.splice(index, 1)
      try {
        await saveState(this.state)
      } catch (error) {
        queue.splice(0, queue.length, ...original)
        throw error
      }
      await this.pruneAttachmentCache().catch(() => undefined)
    })
  }

  private stopPendingStartupProgress(discordThreadId: string): void {
    const progress = this.pendingStartupProgress.get(discordThreadId)
    if (!progress) return
    clearInterval(progress.timer)
    this.pendingStartupProgress.delete(discordThreadId)
  }

  private beginPendingStartupProgress(channel: ThreadChannel): () => void {
    const session = this.state.sessions[channel.id]
    if (session && this.runs.has(session.codexThreadId)) return () => undefined
    const existing = this.pendingStartupProgress.get(channel.id)
    if (existing) {
      existing.references++
      return () => {
        if (this.pendingStartupProgress.get(channel.id) !== existing) return
        if (--existing.references <= 0) this.stopPendingStartupProgress(channel.id)
      }
    }
    const startedAt = Date.now()
    let progress!: PendingStartupProgress
    const timer = setInterval(() => {
      void channel.sendTyping().catch(() => undefined)
      this.maybeReportPendingStartupProgress(progress)
    }, 6_000)
    timer.unref()
    progress = { channel, startedAt, sequence: 1, references: 1, timer }
    this.pendingStartupProgress.set(channel.id, progress)
    void channel.sendTyping().catch(() => undefined)
    return () => {
      if (this.pendingStartupProgress.get(channel.id) !== progress) return
      if (--progress.references <= 0) this.stopPendingStartupProgress(channel.id)
    }
  }

  private maybeReportPendingStartupProgress(progress: PendingStartupProgress): void {
    if (this.stopping || this.pendingStartupProgress.get(progress.channel.id) !== progress || progress.sending) return
    const now = Date.now()
    if (now - progress.startedAt < 6_000 ||
      (progress.lastSentAt && now - progress.lastSentAt < 60_000)) return
    const session = this.state.sessions[progress.channel.id]
    if (session && this.runs.has(session.codexThreadId)) {
      this.stopPendingStartupProgress(progress.channel.id)
      return
    }
    const phase = this.codexRecoveryPromise
      ? 'recovering the Codex runtime before this turn'
      : !session
        ? 'starting this Codex session'
        : this.pendingTurnStarts.has(session.codexThreadId)
          ? 'starting this Codex turn'
          : 'preparing this Codex turn'
    const content = `Codex is still ${phase} (${formatDuration(now - progress.startedAt)} elapsed).`
    const nonce = discordOutboxNonce(`startup:${progress.channel.id}:${progress.startedAt}:${progress.sequence}`)
    const work = progress.channel.send({
      content,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
      nonce,
      enforceNonce: true,
    }).then(async (message) => {
      if (this.pendingStartupProgress.get(progress.channel.id) !== progress) {
        await message.edit({ content: '_Codex preparation finished._' }).catch(() => undefined)
        return
      }
      progress.lastSentAt = Date.now()
      progress.sequence++
    }).catch((error: unknown) => {
      this.logVerbose('Codex startup progress delivery deferred', {
        discordThreadId: progress.channel.id,
        error: errorText(error),
      })
    })
    progress.sending = work
    this.trackBackgroundWork(work, 'Codex startup progress')
    void work.finally(() => {
      if (progress.sending === work) delete progress.sending
    })
  }

  private startRun(session: SessionState, channel: ThreadChannel): ActiveRun {
    this.stopPendingStartupProgress(channel.id)
    const existing = this.runs.get(session.codexThreadId)
    if (existing) return existing
    let run: ActiveRun | undefined
    const typingTimer = setInterval(() => {
      void channel.sendTyping().catch(() => undefined)
      if (run) this.maybeReportRunProgress(run)
    }, 6_000)
    typingTimer.unref()
    const contextPercent = contextUsagePercent(session.contextTokens || 0, session.contextWindow)
    const startedAt = Date.now()
    run = {
      session,
      channel,
      model: session.model || this.config.defaultModel || 'default',
      requestedModel: session.model || this.config.defaultModel || 'default',
      effort: session.effort || this.config.defaultEffort || 'default',
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      startedAt,
      agentText: new Map(),
      activeItems: new Map(),
      autoReviews: new Map(),
      ...(session.approvalsReviewer || this.threadApprovalsReviewers.get(session.codexThreadId)
        ? { approvalsReviewer: session.approvalsReviewer || this.threadApprovalsReviewers.get(session.codexThreadId)! }
        : {}),
      typingTimer,
      visibleOutput: false,
      lastProgressAt: startedAt,
      progressSequence: 0,
      ...(session.contextTokens !== undefined && contextPercent !== undefined ? { contextPercent } : {}),
    }
    this.runs.set(session.codexThreadId, run)
    return run
  }

  private maybeReportRunProgress(run: ActiveRun): void {
    if (this.runs.get(run.session.codexThreadId) !== run || run.progressPromise) return
    const now = Date.now()
    if (now - run.startedAt < 6_000) return
    if (run.lastVisibleOutputAt && now - run.lastVisibleOutputAt < 60_000) return
    if (run.progressSequence > 0 && now - run.lastProgressAt < 60_000) return
    const sequence = ++run.progressSequence
    run.lastProgressAt = now
    const hookActivity = Array.from(run.activeItems.entries()).reverse()
      .find(([key]) => key.startsWith('hook:'))?.[1]
    const activity = run.activeItems.get('__cordex_model_verification') ||
      hookActivity ||
      run.activeItems.get('__cordex_safety_buffering') ||
      Array.from(run.activeItems.values()).at(-1)
    const work = this.sendDurableDiscordOutput({
      channel: run.channel,
      codexThreadId: run.session.codexThreadId,
      turnId: this.durableTurnId(run, {}),
      itemKey: `progress:${sequence}`,
      value: `Codex is still working (${formatDuration(now - run.startedAt)} elapsed)${activity ? ` — ${activity}` : ''}.`,
      suppressNotifications: true,
      format: false,
    }).catch((error: unknown) => {
      this.logVerbose('turn progress delivery deferred', {
        threadId: run.session.codexThreadId,
        error: errorText(error),
      })
    })
    run.progressPromise = work
    this.trackBackgroundWork(work, 'Codex turn progress')
    void work.finally(() => {
      if (run.progressPromise === work) delete run.progressPromise
    })
  }

  private findRun(params: JsonObject): ActiveRun | undefined {
    const threadId = text(params.threadId) || text(params.conversationId)
    return threadId ? this.runs.get(threadId) : undefined
  }

  private turnIdFrom(params: JsonObject): string | undefined {
    if (typeof params.turnId === 'string') return params.turnId
    return isRecord(params.turn) ? text(params.turn.id) : undefined
  }

  private async adoptCodexStartedRun(
    params: JsonObject,
    requirePersistedTurn = false,
  ): Promise<ActiveRun | undefined> {
    const threadId = text(params.threadId) || text(params.conversationId)
    const turnId = this.turnIdFrom(params)
    if (!threadId || !turnId) return undefined

    const existing = this.runs.get(threadId)
    if (existing) {
      if (existing.turnId && existing.turnId !== turnId) {
        this.logVerbose('nested Codex turn started while root turn is active', {
          threadId,
          rootTurnId: existing.turnId,
          nestedTurnId: turnId,
        })
        return existing
      }
      const changedTurn = existing.turnId !== turnId
      existing.turnId = turnId
      existing.session.activeTurnId = turnId
      existing.session.updatedAt = new Date().toISOString()
      if (changedTurn) {
        existing.agentText.clear()
        existing.activeItems.clear()
        existing.visibleOutput = false
        existing.startedAt = isRecord(params.turn) && typeof params.turn.startedAt === 'number'
          ? params.turn.startedAt * 1_000
          : Date.now()
        delete existing.lastVisibleOutputAt
        existing.lastProgressAt = existing.startedAt
        existing.progressSequence = 0
        await saveState(this.state)
      }
      return existing
    }

    const session = Object.values(this.state.sessions).find(
      (candidate) => candidate.codexThreadId === threadId,
    )
    if (!session) return undefined
    if (session.abortIntent) return undefined
    if (requirePersistedTurn && session.activeTurnId !== turnId) return undefined
    const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
    if (!channel?.isThread()) return undefined

    session.activeTurnId = turnId
    session.updatedAt = new Date().toISOString()
    this.loadedThreads.add(threadId)
    await channel.sendTyping().catch(() => undefined)
    const run = this.startRun(session, channel)
    run.turnId = turnId
    if (isRecord(params.turn) && typeof params.turn.startedAt === 'number') {
      run.startedAt = params.turn.startedAt * 1_000
    }
    await saveState(this.state)
    return run
  }

  private notificationMatchesRun(run: ActiveRun, params: JsonObject): boolean {
    const turnId = this.turnIdFrom(params)
    const activeTurnId = run.turnId || run.session.activeTurnId
    return !turnId || !activeTurnId || turnId === activeTurnId
  }

  private codexEventKey(params: JsonObject): string {
    return text(params.threadId) || text(params.conversationId) || 'global'
  }

  private async enqueueNotification(
    notification: ServerNotification,
    generation = this.codexGeneration,
  ): Promise<void> {
    await this.codexEventQueue.run(
      this.codexEventKey(notification.params),
      async () => {
        if (generation !== this.codexGeneration) return
        await this.handleNotification(notification, generation)
      },
    )
  }

  private async enqueueServerRequest(
    request: ServerRequest,
    generation = this.codexGeneration,
  ): Promise<void> {
    await this.codexEventQueue.run(
      this.codexEventKey(request.params),
      async () => {
        if (generation !== this.codexGeneration) return
        await this.handleServerRequest(request)
      },
    )
  }

  private async handleNotification(
    notification: ServerNotification,
    generation = this.codexGeneration,
  ): Promise<void> {
    if (notification.method === 'thread/name/updated') {
      await this.onThreadNameUpdated(notification.params)
      return
    }
    if (notification.method === 'skills/changed') {
      this.invalidateSkillCache()
      return
    }
    if (notification.method === 'thread/status/changed') {
      this.onThreadStatusChanged(notification.params)
      return
    }
    if (notification.method === 'thread/archived') {
      await this.onThreadArchived(notification.params)
      return
    }
    if (notification.method === 'thread/unarchived') {
      await this.onThreadUnarchived(notification.params)
      return
    }
    if (notification.method === 'thread/closed') {
      this.onThreadClosed(notification.params)
      return
    }
    if (notification.method === 'thread/deleted') {
      await this.onThreadDeleted(notification.params)
      return
    }
    if (notification.method === 'serverRequest/resolved') {
      await this.onServerRequestResolved(notification.params)
      return
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      await this.onTokenUsage(notification.params)
      return
    }
    if (notification.method === 'thread/settings/updated') {
      await this.onThreadSettingsUpdated(notification.params)
      return
    }
    if (notification.method === 'warning' || notification.method === 'guardianWarning') {
      if (this.handleLegacyAutoReviewWarning(notification.params, generation)) return
      await this.onWarning(notification.params)
      return
    }
    if (notification.method === 'thread/goal/updated') {
      await this.onGoalUpdated(notification.params, generation)
      return
    }
    if (notification.method === 'turn/started') {
      const existing = this.findRun(notification.params)
      const threadId = text(notification.params.threadId) || text(notification.params.conversationId)
      const session = threadId
        ? Object.values(this.state.sessions).find(
            (candidate) => candidate.codexThreadId === threadId,
          )
        : undefined
      if (session?.abortIntent) {
        const reconciliation = await this.reconcileAbortIntent(
          session,
          this.turnIdFrom(notification.params),
        )
        if (reconciliation.errors.length > 0) {
          this.logVerbose('turn-start abort reconciliation pending', {
            threadId,
            errors: reconciliation.errors,
          })
        }
        return
      }
      const cordexStartPending = threadId ? this.pendingTurnStarts.has(threadId) : false
      const run = await this.adoptCodexStartedRun(notification.params)
      if (generation !== this.codexGeneration) return
      if (run && !existing && !cordexStartPending) await this.steerNextQueuedPrompt(run)
      return
    }
    if (notification.method === 'turn/completed') {
      const threadId = text(notification.params.threadId) || text(notification.params.conversationId)
      const session = threadId
        ? Object.values(this.state.sessions).find(
            (candidate) => candidate.codexThreadId === threadId,
          )
        : undefined
      if (session?.abortIntent && !this.runs.has(threadId || '')) {
        const reconciliation = await this.reconcileAbortIntent(session)
        if (reconciliation.errors.length > 0) {
          this.logVerbose('turn-completion abort reconciliation pending', {
            threadId,
            errors: reconciliation.errors,
          })
        }
        return
      }
    }
    const run = this.findRun(notification.params) ||
      await this.adoptCodexStartedRun(notification.params, true)
    if (!run || !this.notificationMatchesRun(run, notification.params)) return
    if (notification.method === 'item/started') await this.onItemStarted(run, notification.params)
    else if (notification.method === 'item/autoApprovalReview/started' || notification.method === 'item/autoApprovalReview/completed') {
      await this.onAutoApprovalReview(run, notification.method, notification.params)
    }
    else if (notification.method === 'autoApprovalReview/strictReviewRequired') {
      const startedAt = typeof notification.params.startedAtMs === 'number' &&
        Number.isSafeInteger(notification.params.startedAtMs) && notification.params.startedAtMs >= 0
        ? String(notification.params.startedAtMs)
        : 'unidentified'
      await this.reportRunNotice(run, notification.params, `auto-review:strict:${startedAt}`,
        '⚠ Codex requires a stricter automatic approval review for this turn. This notice is not an approval or an execution result.', true)
    }
    else if (notification.method === 'item/agentMessage/delta') this.onAgentDelta(run, notification.params)
    else if (notification.method === 'item/completed') await this.onItemCompleted(run, notification.params)
    else if (notification.method === 'model/verification') await this.onModelVerification(run, notification.params)
    else if (notification.method === 'model/safetyBuffering/updated') await this.onModelSafetyBuffering(run, notification.params)
    else if (notification.method === 'model/rerouted') await this.onModelRerouted(run, notification.params)
    else if (notification.method === 'hook/started' || notification.method === 'hook/completed') {
      await this.onHookLifecycle(run, notification.method, notification.params)
    }
    else if (notification.method === 'error') await this.onTurnError(run, notification.params)
    else if (notification.method === 'turn/completed') {
      await this.onTurnCompleted(run, notification.params, generation)
    }
  }

  private async onThreadNameUpdated(params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    const rawTitle = text(params.threadName)
    if (!threadId || rawTitle === undefined) return
    const title = normalizeThreadTitle(rawTitle)
    const entry = Object.entries(this.state.sessions).find(
      ([discordThreadId, session]) =>
        session.codexThreadId === threadId &&
        !session.archived &&
        !this.deletedDiscordThreads.has(discordThreadId),
    )
    if (!entry) return
    await this.titleQueue.run(threadId, async () => {
      const current = this.state.sessions[entry[0]]
      if (
        current?.codexThreadId !== threadId ||
        current.archived ||
        this.deletedDiscordThreads.has(entry[0])
      ) return
      if (this.pendingCodexTitleVerifications.has(threadId)) {
        this.deferCodexTitleVerification(current, title)
        return
      }
      const echo = this.consumeExpectedTitle(
        this.expectedCodexTitles,
        this.recentCodexTitleEchoes,
        threadId,
        title,
      )
      if (echo === 'expected') return
      let authoritativeRawTitle = rawTitle
      let authoritativeTitle = title
      if (echo === 'recent') {
        const authoritative = await this.codex.getThreadSummary(threadId).catch(() => undefined)
        if (authoritative?.name === undefined) {
          this.deferCodexTitleVerification(current, title)
          return
        }
        const latest = this.state.sessions[entry[0]]
        if (
          latest?.codexThreadId !== threadId ||
          latest.archived ||
          this.deletedDiscordThreads.has(entry[0])
        ) return
        authoritativeTitle = normalizeThreadTitle(authoritative.name)
        if (authoritativeTitle === title) {
          this.discardExpectedTitle(
            this.expectedCodexTitles,
            this.recentCodexTitleEchoes,
            threadId,
          )
        } else {
          this.rememberTitleEcho(this.recentCodexTitleEchoes, threadId, title)
          return
        }
        authoritativeRawTitle = authoritative.name
      }
      const channel = await this.client.channels.fetch(current.discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) return
      const latest = this.state.sessions[entry[0]]
      if (
        latest?.codexThreadId !== threadId ||
        latest.archived ||
        this.deletedDiscordThreads.has(entry[0])
      ) return
      await this.synchronizeThreadTitleUnlocked(latest, channel, authoritativeTitle, {
        codex: authoritativeRawTitle !== authoritativeTitle,
      })
    })
  }

  private async onThreadSettingsUpdated(params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    const settings = isRecord(params.threadSettings) ? params.threadSettings : undefined
    if (!threadId || !settings) return
    const reviewer = text(settings.approvalsReviewer)
    if (reviewer === 'user' || reviewer === 'auto_review' || reviewer === 'guardian_subagent') {
      this.threadApprovalsReviewers.set(threadId, reviewer)
    }
    const model = text(settings.model)
    const effort = settings.effort === null ? null : reasoningEffort(settings.effort)
    const serviceTier = settings.serviceTier === null || typeof settings.serviceTier === 'string'
      ? settings.serviceTier
      : undefined
    if (!model && effort === undefined && serviceTier === undefined) return
    const models = serviceTier !== undefined
      ? await this.getModels().catch(() => [])
      : []

    const restorations: Array<{
      session: SessionState
      previous: SessionState
      replayWasBlocked: boolean
      pendingUsage?: { update: ContextUsageUpdate; expiresAt: number }
    }> = []
    for (const session of Object.values(this.state.sessions)) {
      if (session.codexThreadId !== threadId) continue
      const previous = structuredClone(session)
      const replayWasBlocked = this.contextReplayBlocked.has(session.codexThreadId)
      const pendingUsage = this.pendingContextUsage.get(session.codexThreadId)
      let sessionChanged = false
      const modelChanged = model !== undefined && session.model !== model
      if (modelChanged) {
        session.model = model
        this.clearContextUsage(session, true)
        sessionChanged = true
      }
      if (effort === null) {
        if (session.effort !== undefined) {
          delete session.effort
          sessionChanged = true
        }
      } else if (effort !== undefined && session.effort !== effort) {
        session.effort = effort
        sessionChanged = true
      }
      if (serviceTier !== undefined) {
        const fastMode = this.serviceTierIsFast(model || session.model, serviceTier, models)
        if (session.fastMode !== fastMode) {
          session.fastMode = fastMode
          sessionChanged = true
        }
      }
      if (sessionChanged) {
        session.updatedAt = new Date().toISOString()
        restorations.push({
          session,
          previous,
          replayWasBlocked,
          ...(pendingUsage ? { pendingUsage } : {}),
        })
      }
    }
    if (restorations.length === 0) return
    try {
      await saveState(this.state)
    } catch (error) {
      for (const restoration of restorations) {
        this.restoreSessionState(restoration.session, restoration.previous)
        if (restoration.replayWasBlocked) {
          this.contextReplayBlocked.add(restoration.session.codexThreadId)
        } else {
          this.contextReplayBlocked.delete(restoration.session.codexThreadId)
        }
        if (restoration.pendingUsage) {
          this.pendingContextUsage.set(restoration.session.codexThreadId, restoration.pendingUsage)
        } else {
          this.pendingContextUsage.delete(restoration.session.codexThreadId)
        }
      }
      throw error
    }
  }

  private onThreadStatusChanged(params: JsonObject): void {
    const threadId = text(params.threadId)
    const status = isRecord(params.status) ? text(params.status.type) : undefined
    if (threadId && status === 'notLoaded') this.loadedThreads.delete(threadId)
  }

  private acceptsArchiveNotification(
    threadId: string,
    kind: 'archived' | 'unarchived',
  ): boolean {
    const expected = this.expectedArchiveNotifications.get(threadId)
    if (!expected) return true
    if (expected.expiresAt <= Date.now()) {
      this.expectedArchiveNotifications.delete(threadId)
      return true
    }
    if (expected.kind !== kind) return false
    this.expectedArchiveNotifications.delete(threadId)
    return true
  }

  private expectArchiveNotification(
    threadId: string,
    kind: 'archived' | 'unarchived',
  ): void {
    this.expectedArchiveNotifications.set(threadId, {
      kind,
      expiresAt: Date.now() + 30_000,
    })
  }

  private async onThreadArchived(params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    if (!threadId || !this.acceptsArchiveNotification(threadId, 'archived')) return
    this.loadedThreads.delete(threadId)
    const entries = Object.entries(this.state.sessions).filter(
      ([, session]) => session.codexThreadId === threadId,
    )
    this.clearTitleVerificationState(threadId, entries.map(([discordThreadId]) => discordThreadId))
    this.expectedCodexTitles.delete(threadId)
    this.pendingCodexTitles.delete(threadId)
    this.recentCodexTitleEchoes.delete(threadId)
    let changed = false
    const restorations: Array<{ session: SessionState; previous: SessionState }> = []
    const now = new Date().toISOString()
    for (const [discordThreadId, session] of entries) {
      if (this.deletedDiscordThreads.has(discordThreadId)) continue
      this.expectedDiscordTitles.delete(discordThreadId)
      this.recentDiscordTitleEchoes.delete(discordThreadId)
      this.pendingDiscordTitles.delete(discordThreadId)
      if (!session.archived || !session.lifecycleIntent) {
        restorations.push({ session, previous: structuredClone(session) })
        session.archived = true
        session.lifecycleIntent ||= { kind: 'archive', requestedAt: now }
        session.updatedAt = now
        changed = true
      }
    }
    if (changed) {
      try {
        await saveState(this.state)
      } catch (error) {
        for (const { session, previous } of restorations) {
          this.restoreSessionState(session, previous)
        }
        throw error
      }
    }
    await Promise.all(entries.map(async ([discordThreadId, original]) => {
      if (this.deletedDiscordThreads.has(discordThreadId)) return
      const session = this.state.sessions[discordThreadId]
      if (
        !session ||
        session.codexThreadId !== original.codexThreadId ||
        session.lifecycleIntent?.kind !== 'archive'
      ) return
      await this.convergeDiscordLifecycleState(
        session,
        'archive',
        true,
        'Codex session archived',
      )
    }))
  }

  private async onThreadUnarchived(params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    if (!threadId || !this.acceptsArchiveNotification(threadId, 'unarchived')) return
    if (this.preserveArchivedUntilResume.delete(threadId)) return
    if (Object.values(this.state.sessions).some(
      (session) => session.codexThreadId === threadId &&
        session.lifecycleIntent?.kind === 'resume',
    )) return
    let changed = false
    const restorations: Array<{ session: SessionState; previous: SessionState }> = []
    const recoveries: Array<{ session: SessionState; channel: ThreadChannel }> = []
    for (const [discordThreadId, session] of Object.entries(this.state.sessions)) {
      if (
        session.codexThreadId !== threadId ||
        this.deletedDiscordThreads.has(discordThreadId) ||
        !session.archived ||
        session.lifecycleIntent?.kind === 'archive'
      ) continue
      const channel = await this.client.channels.fetch(discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) continue
      if (channel.archived) {
        try {
          await channel.setArchived(false, 'Codex session unarchived')
        } catch {
          continue
        }
      }
      restorations.push({ session, previous: structuredClone(session) })
      delete session.archived
      session.updatedAt = new Date().toISOString()
      changed = true
      recoveries.push({ session, channel })
    }
    if (changed) {
      try {
        await saveState(this.state)
      } catch (error) {
        for (const { session, previous } of restorations) {
          this.restoreSessionState(session, previous)
        }
        throw error
      }
    }
    for (const { session, channel } of recoveries) {
      if ((this.state.queues[channel.id]?.length || 0) === 0) continue
      if (this.blockedQueuedSourceThreads.has(channel.id)) {
        this.scheduleQueuedSourceRetry(channel.id)
      }
      const timer = setTimeout(() => {
        if (this.stopping) return
        this.trackBackgroundWork(
          this.recoverPersistedPrompts(session, channel).catch((error: unknown) => {
            this.logVerbose('externally unarchived prompt recovery failed', {
              threadId: session.codexThreadId,
              error: errorText(error),
            })
            if (this.blockedQueuedSourceThreads.has(channel.id)) {
              this.scheduleQueuedSourceRetry(channel.id)
            }
          }),
          'externally unarchived prompt recovery',
        )
      }, 0)
      timer.unref()
    }
  }

  private onThreadClosed(params: JsonObject): void {
    const threadId = text(params.threadId)
    if (threadId) {
      this.loadedThreads.delete(threadId)
      // Exact retry context is only valid while this native thread context is
      // loaded. A later resume must obtain a fresh denial.
      this.autoReviewDenials.delete(threadId)
    }
  }

  private async onThreadDeleted(params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    if (!threadId) return
    this.autoReviewDenials.delete(threadId)
    this.loadedThreads.delete(threadId)
    this.pendingTurnStarts.delete(threadId)
    this.preserveArchivedUntilResume.delete(threadId)
    this.expectedArchiveNotifications.delete(threadId)
    this.expectedCodexTitles.delete(threadId)
    this.pendingCodexTitles.delete(threadId)
    this.recentCodexTitleEchoes.delete(threadId)
    this.pendingContextUsage.delete(threadId)
    this.contextReplayBlocked.delete(threadId)
    this.goalStatusAnnouncements.delete(threadId)
    const run = this.runs.get(threadId)
    if (run) clearInterval(run.typingTimer)
    this.runs.delete(threadId)

    const entries = Object.entries(this.state.sessions).filter(
      ([discordThreadId, session]) =>
        session.codexThreadId === threadId &&
        !this.unlinkedCodexSessionChannels.has(discordThreadId),
    )
    for (const [discordThreadId] of entries) {
      this.unlinkedCodexSessionChannels.add(discordThreadId)
    }
    this.clearTitleVerificationState(threadId, entries.map(([discordThreadId]) => discordThreadId))
    if (entries.length === 0) return
    let cleanup!: Promise<void>
    cleanup = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.cleanupDeletedCodexThread(threadId, entries)
          .catch((error: unknown) => {
            console.error(`Failed to clean deleted Codex thread ${threadId}: ${errorText(error)}`)
          })
          .finally(resolve)
      })
    })
    this.pendingCodexDeletionCleanups.add(cleanup)
    void cleanup.finally(() => this.pendingCodexDeletionCleanups.delete(cleanup))
  }

  private async cleanupDeletedCodexThread(
    threadId: string,
    entries: Array<[string, SessionState]>,
  ): Promise<void> {
    const removedChannels = new Set<string>()
    await Promise.all(entries.map(async ([discordThreadId]) => {
      await this.dismissPendingControlsForChannel(discordThreadId, '_Codex session deleted._')
      this.expectedDiscordTitles.delete(discordThreadId)
      this.recentDiscordTitleEchoes.delete(discordThreadId)
      this.pendingDiscordTitles.delete(discordThreadId)
      await this.promptQueue.run(discordThreadId, async () => {
        const current = this.state.sessions[discordThreadId]
        if (current?.codexThreadId !== threadId) {
          this.unlinkedCodexSessionChannels.delete(discordThreadId)
          return
        }
        // Keep a durable marker before removing local state. A failed final
        // write leaves the marker available for startup reconciliation.
        if (current.lifecycleIntent?.kind !== 'delete-thread') {
          await this.persistDeletedThreadIntent(current, 'delete')
        }
        await this.finalizeDeletedDiscordThreadWithinPrompt(current)
        this.unlinkedCodexSessionChannels.add(discordThreadId)
        removedChannels.add(discordThreadId)
      })
    }))
    if (removedChannels.size === 0) await saveState(this.state)
    await Promise.all(entries.map(async ([discordThreadId]) => {
      if (!removedChannels.has(discordThreadId)) return
      if (this.deletedDiscordThreads.has(discordThreadId)) return
      if (
        this.state.sessions[discordThreadId] ||
        !this.unlinkedCodexSessionChannels.has(discordThreadId)
      ) return
      const channel = await this.client.channels.fetch(discordThreadId).catch(() => undefined)
      if (!channel?.isThread()) return
      await channel.send(
        'This Codex session was deleted. The Discord thread is no longer linked.',
      ).catch(() => undefined)
    }))
  }

  private onItemStarted(run: ActiveRun, params: JsonObject): void {
    if (!isRecord(params.item)) return
    const item = params.item
    const itemId = text(item.id)
    if (!itemId) return
    if (item.type === 'agentMessage') {
      run.agentText.set(itemId, '')
    }
    const activity: Record<string, string> = {
      reasoning: 'thinking',
      commandExecution: 'running a command',
      fileChange: 'editing files',
      mcpToolCall: 'using an MCP tool',
      dynamicToolCall: 'using a tool',
      collabAgentToolCall: 'coordinating agents',
      collabToolCall: 'coordinating agents',
      subAgentActivity: 'waiting for an agent',
      webSearch: 'searching the web',
      imageGeneration: 'generating an image',
      contextCompaction: 'compacting context',
      agentMessage: 'drafting a response',
      plan: 'planning',
      sleep: 'waiting',
    }
    const label = typeof item.type === 'string' ? activity[item.type] : undefined
    if (label) run.activeItems.set(itemId, label)
  }

  private onAgentDelta(run: ActiveRun, params: JsonObject): void {
    const itemId = text(params.itemId)
    const delta = text(params.delta)
    if (!itemId || delta === undefined) return
    const next = `${run.agentText.get(itemId) || ''}${delta}`
    run.agentText.set(itemId, next)
  }

  private durableTurnId(run: ActiveRun, params: JsonObject): string {
    return this.turnIdFrom(params) ||
      run.turnId ||
      run.session.activeTurnId ||
      `started:${run.startedAt}`
  }

  private async sendRunBlock(
    run: ActiveRun,
    params: JsonObject,
    itemId: string,
    value: string,
  ): Promise<void> {
    await this.stageDurableDiscordOutput({
      channel: run.channel,
      codexThreadId: run.session.codexThreadId,
      turnId: this.durableTurnId(run, params),
      itemKey: `item:${itemId}`,
      value,
      suppressNotifications: true,
    })
    run.visibleOutput = true
    await this.drainDiscordOutbox(run.channel).catch((error: unknown) => {
      this.logVerbose('turn item delivery deferred', {
        threadId: run.session.codexThreadId,
        itemId,
        error: errorText(error),
      })
    })
    if (this.runs.get(run.session.codexThreadId) === run) {
      await run.channel.sendTyping().catch(() => undefined)
    }
  }

  private async sendRunGeneratedImage(
    run: ActiveRun,
    params: JsonObject,
    itemId: string,
    item: JsonObject,
  ): Promise<void> {
    if (item.status === 'failed' || isRecord(item.failure)) {
      const reason = isRecord(item.failure) && item.failure.type === 'usageLimitExceeded'
        ? ' (usage limit exceeded)'
        : ''
      await this.sendRunBlock(run, params, itemId, `⨯ Image generation failed${reason}.`)
      return
    }
    try {
      const { bytes, attachment } = decodeGeneratedImage(item.result)
      await this.outgoingMediaQueue.run('cache', async () => {
        await cacheGeneratedImage(this.outgoingMediaDirectory, bytes, attachment)
        await this.stageDurableDiscordOutput({
          channel: run.channel,
          codexThreadId: run.session.codexThreadId,
          turnId: this.durableTurnId(run, params),
          itemKey: `item:${itemId}`,
          value: '🖼 Generated image',
          suppressNotifications: true,
          format: false,
          attachment,
        })
      })
      run.visibleOutput = true
      await this.drainDiscordOutbox(run.channel).catch((error: unknown) => {
        this.logVerbose('generated-image delivery deferred', {
          threadId: run.session.codexThreadId,
          itemId,
          error: errorText(error),
        })
      })
    } catch (error) {
      const reason = error instanceof Error && error.message.includes('8 MiB')
        ? ' It exceeds the 8 MiB Discord upload limit.'
        : ''
      await this.sendRunBlock(
        run,
        params,
        itemId,
        `⚠ Image generation completed, but Cordex could not prepare the Discord attachment.${reason} Ask Codex for its saved project path.`,
      )
      this.logVerbose('generated-image attachment preparation failed', {
        threadId: run.session.codexThreadId,
        itemId,
        error: errorText(error),
      })
    }
  }

  private async onItemCompleted(run: ActiveRun, params: JsonObject): Promise<void> {
    if (!isRecord(params.item)) return
    const item = params.item
    const itemId = text(item.id)
    if (!itemId) return
    run.activeItems.delete(itemId)
    if (item.type === 'imageGeneration') {
      await this.sendRunGeneratedImage(run, params, itemId, item)
    } else if (item.type === 'agentMessage') {
      const finalText = text(item.text) || run.agentText.get(itemId) || ''
      run.agentText.delete(itemId)
      if (finalText.trim()) await this.sendRunBlock(run, params, itemId, finalText)
    } else if (item.type === 'plan' && text(item.text)?.trim()) {
      await this.sendRunBlock(run, params, itemId, text(item.text) || '')
    } else {
      const tool = formatCompletedToolItem(item, this.verbosityFor(run.session))
      if (tool) await this.sendRunBlock(run, params, itemId, tool)
    }
  }

  private async reportRunNotice(
    run: ActiveRun,
    params: JsonObject,
    itemKey: string,
    value: string,
    suppressNotifications: boolean,
  ): Promise<boolean> {
    const identity = {
      discordThreadId: run.channel.id,
      codexThreadId: run.session.codexThreadId,
      turnId: this.durableTurnId(run, params),
    }
    const outputKey = discordOutboxOutputKey({ ...identity, itemKey })
    try {
      await this.stageDurableDiscordOutput({
        channel: run.channel,
        codexThreadId: identity.codexThreadId,
        turnId: identity.turnId,
        itemKey,
        value,
        suppressNotifications,
        format: false,
      })
      // Staging can be a no-op after a session was replaced or deleted. Only
      // claim a notice when it is durable, already delivered, or actually sent.
      if (!this.state.discordOutboxDeliveredKeys?.includes(outputKey) &&
        !this.state.discordOutbox?.some((entry) => discordOutboxOutputKey(entry) === outputKey)) return false
    } catch (error) {
      this.logVerbose('Codex event notice persistence failed', {
        threadId: run.session.codexThreadId,
        itemKey,
        error: errorText(error),
      })
      let sent = false
      await run.channel.send({
        content: value,
        allowedMentions: { parse: [] },
        ...(suppressNotifications ? { flags: MessageFlags.SuppressNotifications } : {}),
      }).then((message) => {
        sent = true
        this.recordVisibleDiscordOutput(identity, message)
      }).catch(() => undefined)
      return sent
    }
    await this.drainDiscordOutbox(run.channel).catch((error: unknown) => {
      this.logVerbose('Codex event notice delivery deferred', {
        threadId: run.session.codexThreadId,
        itemKey,
        error: errorText(error),
      })
    })
    return true
  }

  private handleLegacyAutoReviewWarning(params: JsonObject, generation: number): boolean {
    const message = text(params.message)
    const parsed = message ? parseLegacyAutoReviewWarning(message) : undefined
    const run = parsed ? this.findRun(params) : undefined
    if (!parsed || !run || !this.notificationMatchesRun(run, params)) return false
    const signature = autoReviewSignature(parsed)
    if (!signature) return false
    const threadId = run.session.codexThreadId
    const context = { ...params, threadId, turnId: this.durableTurnId(run, params) }
    // Native 0.159 emits the legacy warning immediately before the structured
    // completion. Keep a delayed fallback if that completion is unavailable.
    this.trackBackgroundWork(new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      timer.unref()
    }).then(() => this.codexEventQueue.run(threadId, async () => {
      // Join the same thread queue as native completions. A slow earlier send
      // must not let this timer overtake an already-received structured result.
      if (this.stopping || generation !== this.codexGeneration ||
        run.autoReviewSummaries?.has(signature) ||
        this.deletedDiscordThreads.has(run.channel.id) ||
        this.state.sessions[run.channel.id]?.codexThreadId !== threadId) return
      const reported = await this.reportRunNotice(run, context, `auto-review:legacy:${signature}`,
        formatAutoReviewNotice(parsed, this.verbosityFor(run.session)), true)
      if (reported) (run.autoReviewSummaries ??= new Set()).add(signature)
    })), 'automatic-review legacy fallback')
    return true
  }

  private async onAutoApprovalReview(
    run: ActiveRun,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    const reviewId = text(params.reviewId)
    if (!reviewId) {
      await this.reportRunNotice(run, params, `auto-review:unidentified:${method}`,
        '⚠ Codex sent an automatic-review notice without its review ID; this client cannot track that result reliably.', true)
      return
    }
    const completed = method.endsWith('/completed')
    const review = isRecord(params.review) ? params.review : undefined
    const status = review ? text(review.status) : undefined
    const terminal = completed && ['approved', 'denied', 'timedOut', 'aborted'].includes(status || '')
    if (terminal && status === 'denied') this.autoReviewDenials.record(run.session.codexThreadId, params)
    const key = `auto-review:${reviewId}`
    const statuses = run.autoReviews ??= new Map()
    const completionItemKey = `${key}:completed`
    const completionOutputKey = discordOutboxOutputKey({
      discordThreadId: run.channel.id,
      codexThreadId: run.session.codexThreadId,
      turnId: this.durableTurnId(run, params),
      itemKey: completionItemKey,
    })
    if (statuses.get(reviewId) === 'completed' ||
      this.state.discordOutboxDeliveredKeys?.includes(completionOutputKey) ||
      this.state.discordOutbox?.some((entry) => entry.turnId === this.durableTurnId(run, params) &&
        entry.codexThreadId === run.session.codexThreadId && entry.itemKey === completionItemKey)) return
    if (!completed && statuses.get(reviewId) === 'started') return
    const signature = terminal ? autoReviewSignature(params) : undefined
    run.approvalsReviewer = 'auto_review'
    if (completed) run.activeItems.delete(key)
    else run.activeItems.set(key, 'waiting for automatic approval review')
    const displayedParams = completed && !terminal
      ? { ...params, review: { ...review, status: 'unknown' } }
      : params
    const reported = await this.reportRunNotice(
      run,
      params,
      terminal ? completionItemKey : completed ? `${key}:unknown` : `progress:${key}:started`,
      formatAutoReviewNotice(displayedParams, this.verbosityFor(run.session)),
      true,
    )
    if (reported) {
      if (signature) (run.autoReviewSummaries ??= new Set()).add(signature)
      if (terminal) statuses.set(reviewId, 'completed')
      else if (!completed) statuses.set(reviewId, 'started')
    }
  }

  private async onModelVerification(run: ActiveRun, params: JsonObject): Promise<void> {
    const verifications = Array.isArray(params.verifications) ? params.verifications : []
    if (verifications.length === 0) {
      run.activeItems.delete('__cordex_model_verification')
      return
    }
    run.activeItems.set('__cordex_model_verification', 'waiting for account verification')
    const trustedAccess = verifications.includes('trustedAccessForCyber')
    const notice = trustedAccess
      ? '⚠ Codex requires Trusted Access for Cyber for this turn. Identity verification alone may not grant model access; approval and provisioning are account-side. Review <https://learn.chatgpt.com/docs/cyber-safety> or choose an available model with /model.'
      : '⚠ Codex requires additional account verification for this turn. Complete the provider-side requirement or choose another available model with /model.'
    await this.reportRunNotice(run, params, 'model-verification', notice, false)
  }

  private async onModelSafetyBuffering(run: ActiveRun, params: JsonObject): Promise<void> {
    if (params.showBufferingUi !== true) {
      run.activeItems.delete('__cordex_safety_buffering')
      return
    }
    run.activeItems.set('__cordex_safety_buffering', 'checking the response')
    await this.reportRunNotice(
      run,
      params,
      'progress:safety-buffering',
      'Codex is checking this response before continuing; it may take longer than usual.',
      true,
    )
  }

  private async onHookLifecycle(
    run: ActiveRun,
    method: string,
    params: JsonObject,
  ): Promise<void> {
    const hook = isRecord(params.run) ? params.run : undefined
    const hookId = hook ? text(hook.id) : undefined
    if (!hookId) return
    const key = `hook:${hookId}`
    if (method === 'hook/started') {
      run.activeItems.set(key, 'running a lifecycle hook')
      return
    }
    run.activeItems.delete(key)
    if (hook?.status === 'failed' || hook?.status === 'blocked') {
      await this.reportRunNotice(
        run,
        params,
        `hook:${hookId}:failure`,
        `⚠ A Codex lifecycle hook ${hook.status === 'blocked' ? 'blocked work' : 'failed'}. Use /hooks to inspect its configured source.`,
        true,
      )
    }
  }

  private async onModelRerouted(run: ActiveRun, params: JsonObject): Promise<void> {
    const threadId = text(params.threadId)
    const turnId = text(params.turnId)
    const fromModel = text(params.fromModel)
    const toModel = text(params.toModel)
    const reason = text(params.reason)
    const expectedTurnId = run.turnId || run.session.activeTurnId
    if (
      !threadId || !turnId || !fromModel || !toModel ||
      threadId !== run.session.codexThreadId || turnId !== expectedTurnId
    ) return
    run.model = toModel
    const reasonText = reason ? ` Reason: ${discordInlineCode(truncate(reason, 120))}.` : ''
    const key = createHash('sha256').update(`${fromModel}|${toModel}|${reason || ''}`).digest('hex').slice(0, 16)
    await this.reportRunNotice(
      run,
      params,
      `model-rerouted:${key}`,
      `⚠ Codex rerouted this turn from ${discordInlineCode(fromModel)} to ${discordInlineCode(toModel)}.${reasonText} The next-turn model setting is unchanged.`,
      true,
    )
  }

  private async onTokenUsage(params: JsonObject): Promise<void> {
    const update = parseContextUsage(params)
    if (!update) return

    const run = this.runs.get(update.threadId)
    if (run && update.turnId === '') return
    const runTurnMatches = run !== undefined && update.turnId !== '' &&
      update.turnId === (run.turnId || run.session.activeTurnId)
    if (run && update.turnId !== '' && !runTurnMatches) return

    if (runTurnMatches && run) {
      const percent = contextUsagePercent(update.contextTokens, update.contextWindow)
      if (percent === undefined) delete run.contextPercent
      else run.contextPercent = percent
    }

    if (this.contextReplayBlocked.has(update.threadId)) {
      const requestedModel = run?.requestedModel || run?.model
      const configuredModel = run?.session.model || this.config.defaultModel || 'default'
      if (!runTurnMatches || requestedModel !== configuredModel) return
      this.contextReplayBlocked.delete(update.threadId)
    }

    const sessions = Object.values(this.state.sessions).filter(
      (session) => session.codexThreadId === update.threadId,
    )
    if (sessions.length === 0) {
      this.rememberPendingContextUsage(update)
      return
    }
    if (sessions.length > 1 && !run) return
    this.contextUsageVersions.set(update.threadId, this.contextUsageVersion(update.threadId) + 1)
    this.pendingContextUsage.delete(update.threadId)

    let changed = false
    const targetSessions = run
      ? sessions.filter((session) => session === run.session)
      : sessions
    for (const session of targetSessions) {
      // A model selection made during an active turn applies to the next turn.
      // Keep the current run footer accurate, but do not repopulate persisted
      // usage with the old model's window after the selection cleared it.
      const configuredModel = session.model || this.config.defaultModel || 'default'
      const requestedModel = run?.requestedModel || run?.model
      if (run?.session === session && requestedModel !== configuredModel) continue
      applyContextUsage(session, update)
      changed = true
    }
    if (changed) await saveState(this.state)
  }

  private async onTurnError(run: ActiveRun, params: JsonObject): Promise<void> {
    const message = isRecord(params.error) ? text(params.error.message) : undefined
    if (!message) return
    if (params.willRetry === true) {
      const key = createHash('sha256').update(message).digest('hex').slice(0, 16)
      await this.reportRunNotice(
        run,
        params,
        `progress:retry:${key}`,
        `⚠ ${truncate(message, 1_780)} Retrying.`,
        true,
      )
      return
    }
    run.lastError = message
    await this.sendDurableDiscordOutput({
      channel: run.channel,
      codexThreadId: run.session.codexThreadId,
      turnId: this.durableTurnId(run, params),
      itemKey: 'failure',
      value: `⨯ ${truncate(message, 1_850)}`,
      suppressNotifications: this.queuedPromptsFor(run.channel.id).length > 0,
      format: false,
    }).catch((error: unknown) => {
      this.logVerbose('final turn failure delivery deferred', {
        threadId: run.session.codexThreadId,
        error: errorText(error),
      })
    })
  }

  private async onWarning(params: JsonObject): Promise<void> {
    const message = text(params.message)
    if (!message) return
    const threadId = text(params.threadId) || text(params.conversationId)
    const channel = await this.resolveThreadChannel(params)
    if (!channel) {
      this.logger.warn('codex_warning_unrouted', {
        ...(threadId ? { threadId } : {}),
        bytes: Buffer.byteLength(message, 'utf8'),
        lineCount: message.split(/\r?\n/).length,
      })
      return
    }
    const content = `⚠ ${truncate(message, 1_850)}`
    const session = this.state.sessions[channel.id]
    if (!session || session.codexThreadId !== threadId) {
      await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => undefined)
      return
    }
    const warningTurnId = this.turnIdFrom(params)
    const activeTurnId = this.runs.get(session.codexThreadId)?.turnId || session.activeTurnId
    if (warningTurnId && warningTurnId !== activeTurnId) return
    const itemKey = `warning:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`
    try {
      await this.stageDurableDiscordOutput({
        channel,
        codexThreadId: session.codexThreadId,
        turnId: warningTurnId || session.activeTurnId || `warning:${session.updatedAt}`,
        itemKey,
        value: content,
        suppressNotifications: true,
        format: false,
      })
    } catch (error) {
      this.logVerbose('Codex warning persistence failed', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
      await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => undefined)
      return
    }
    await this.drainDiscordOutbox(channel).catch((error: unknown) => {
      this.logVerbose('Codex warning delivery deferred', {
        threadId: session.codexThreadId,
        error: errorText(error),
      })
    })
  }

  private async onGoalUpdated(
    params: JsonObject,
    generation = this.codexGeneration,
  ): Promise<void> {
    const threadId = text(params.threadId)
    const goal = isRecord(params.goal) ? params.goal : undefined
    const status = goal ? text(goal.status) : undefined
    if (!threadId || !goal || !status) return
    if (!['blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status)) return
    const announcementKey = `${status}:${String(goal.updatedAt ?? '')}`
    if (this.goalStatusAnnouncements.get(threadId) === announcementKey) return
    const channel = await this.resolveThreadChannel(params)
    if (!channel) return
    this.goalStatusAnnouncements.set(threadId, announcementKey)
    const labels: Record<string, string> = {
      blocked: 'blocked',
      usageLimited: 'usage limited',
      budgetLimited: 'budget limited',
      complete: 'complete',
    }
    const tokensUsed = typeof goal.tokensUsed === 'number'
      ? `${goal.tokensUsed.toLocaleString('en-US')} tokens`
      : ''
    const duration = typeof goal.timeUsedSeconds === 'number'
      ? formatDuration(goal.timeUsedSeconds * 1_000)
      : ''
    const usage = [tokensUsed, duration].filter(Boolean).join(' · ')
    await channel.send(`**Goal ${labels[status] || status}.**${usage ? ` ${usage}` : ''}`)
    const session = this.state.sessions[channel.id] || Object.values(this.state.sessions).find(
      (candidate) => candidate.codexThreadId === threadId,
    )
    if (
      generation !== this.codexGeneration ||
      !session ||
      session.abortIntent ||
      session.activeTurnId ||
      this.runs.has(threadId)
    ) return
    this.scheduleQueueDrain(session, channel, false, status)
  }

  private async buildRunFooter(run: ActiveRun, duration: number): Promise<string> {
    const projectDirectory = run.session.worktree?.projectDirectory ||
      this.config.projects[run.session.parentChannelId]?.directory ||
      run.session.directory
    const branchResult = await runGit(run.session.directory, ['branch', '--show-current'], 3_000)
      .catch(() => undefined)
    const branch = branchResult?.exitCode === 0
      ? branchResult.stdout.trim()
      : run.session.worktree?.branch
    return formatRunFooter({
      project: path.basename(projectDirectory) || projectDirectory,
      ...(branch ? { branch } : {}),
      duration: formatDuration(duration),
      ...(run.contextPercent !== undefined ? { contextPercent: run.contextPercent } : {}),
      model: run.model,
      effort: run.effort,
    })
  }

  private async reportSurvivingBackgroundTerminals(run: ActiveRun, turnId: string): Promise<void> {
    let timeout: NodeJS.Timeout | undefined
    let terminals: Awaited<ReturnType<CodexAppServer['listBackgroundTerminals']>>
    try {
      terminals = await Promise.race([
        this.codex.listBackgroundTerminals(run.session.codexThreadId),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Background terminal inspection timed out')), 5_000)
          timeout.unref()
        }),
      ])
    } catch (error) {
      this.logVerbose('post-turn background terminal query failed', {
        threadId: run.session.codexThreadId,
        error: errorText(error),
      })
      return
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (
      this.stopping ||
      this.state.sessions[run.channel.id]?.codexThreadId !== run.session.codexThreadId
    ) return
    const known = this.reportedBackgroundTerminals.get(run.session.codexThreadId) || new Set<string>()
    const newlyReported = terminals.filter((terminal) => !known.has(terminal.processId))
    const current = new Set(terminals.map((terminal) => terminal.processId))
    if (newlyReported.length === 0) {
      this.reportedBackgroundTerminals.set(run.session.codexThreadId, current)
      return
    }
    await this.stageDurableDiscordOutput({
      channel: run.channel,
      codexThreadId: run.session.codexThreadId,
      turnId,
      itemKey: 'background-terminals',
      value: `⚠ ${newlyReported.length} background terminal${newlyReported.length === 1 ? '' : 's'} still running after this turn. Use /ps to inspect or /stop to terminate.`,
      suppressNotifications: false,
      format: false,
    })
    this.reportedBackgroundTerminals.set(run.session.codexThreadId, current)
    await this.drainDiscordOutbox(run.channel)
  }

  private async onTurnCompleted(
    run: ActiveRun,
    params: JsonObject,
    generation = this.codexGeneration,
  ): Promise<void> {
    clearInterval(run.typingTimer)
    await run.progressPromise
    const turn = isRecord(params.turn) ? params.turn : {}
    const status = text(turn.status) || 'completed'
    const duration = typeof turn.durationMs === 'number' ? turn.durationMs : Date.now() - run.startedAt
    const completionError = isRecord(turn.error) ? text(turn.error.message) : undefined
    const durableTurnId = this.durableTurnId(run, params)
    let shouldDrainTerminalOutput = false
    if (status === 'failed') {
      const message = completionError || (run.lastError ? undefined : 'Turn failed.')
      if (message && message !== run.lastError) {
        run.lastError = message
        try {
          await this.stageDurableDiscordOutput({
            channel: run.channel,
            codexThreadId: run.session.codexThreadId,
            turnId: durableTurnId,
            itemKey: 'failure',
            value: `⨯ ${truncate(message, 1_850)}`,
            suppressNotifications: this.queuedPromptsFor(run.channel.id).length > 0,
            format: false,
          })
          shouldDrainTerminalOutput = true
        } catch (error) {
          this.logVerbose('completed turn failure persistence deferred', {
            threadId: run.session.codexThreadId,
            error: errorText(error),
          })
        }
      } else if (run.lastError) {
        shouldDrainTerminalOutput = true
      }
    } else if (
      status === 'completed' &&
      run.visibleOutput &&
      showStatusFooter(this.verbosityFor(run.session))
    ) {
      try {
        await this.stageDurableDiscordOutput({
          channel: run.channel,
          codexThreadId: run.session.codexThreadId,
          turnId: durableTurnId,
            itemKey: 'footer',
            value: await this.buildRunFooter(run, duration),
            suppressNotifications: this.queuedPromptsFor(run.channel.id).length > 0,
          format: false,
        })
        shouldDrainTerminalOutput = true
      } catch (error) {
        this.logVerbose('turn footer persistence deferred', {
          threadId: run.session.codexThreadId,
          error: errorText(error),
        })
      }
    } else if (status === 'interrupted' || !run.visibleOutput) {
      const terminal = status === 'completed'
        ? 'Codex finished without a visible response.'
        : status === 'interrupted'
          ? 'Codex turn stopped.'
          : `Codex turn ended (${status}).`
      try {
        await this.stageDurableDiscordOutput({
          channel: run.channel,
          codexThreadId: run.session.codexThreadId,
          turnId: durableTurnId,
          itemKey: 'terminal',
          value: terminal,
          suppressNotifications: this.queuedPromptsFor(run.channel.id).length > 0,
          format: false,
        })
        shouldDrainTerminalOutput = true
      } catch (error) {
        this.logVerbose('silent turn completion persistence deferred', {
          threadId: run.session.codexThreadId,
          error: errorText(error),
        })
      }
    }
    delete run.session.activeTurnId
    run.session.updatedAt = new Date().toISOString()
    this.runs.delete(run.session.codexThreadId)
    try {
      await this.dismissPendingControlsForChannel(run.channel.id, '_Turn ended._')
      await saveState(this.state)
    } catch (error) {
      throw this.markCodexUnavailable('Cordex turn finalization failed', error)
    }
    let abortCleared = run.session.abortIntent === undefined
    if (run.session.abortIntent) {
      const reconciliation = await this.reconcileAbortIntent(run.session)
      abortCleared = reconciliation.cleared
      if (reconciliation.errors.length > 0) {
        this.logVerbose('completed turn abort reconciliation pending', {
          threadId: run.session.codexThreadId,
          errors: reconciliation.errors,
        })
      }
    }
    if (shouldDrainTerminalOutput) {
      this.trackBackgroundWork(
        this.drainDiscordOutbox(run.channel).catch((error: unknown) => {
          this.logVerbose('terminal turn output delivery deferred', {
            threadId: run.session.codexThreadId,
            error: errorText(error),
          })
        }),
        'terminal turn output delivery',
      )
    }
    if (status !== 'interrupted') {
      this.trackBackgroundWork(
        this.reportSurvivingBackgroundTerminals(run, durableTurnId).catch((error: unknown) => {
          this.logVerbose('post-turn background terminal notice deferred', {
            threadId: run.session.codexThreadId,
            error: errorText(error),
          })
        }),
        'post-turn background terminal inspection',
      )
    }
    if (generation === this.codexGeneration && abortCleared) {
      this.scheduleQueueDrain(run.session, run.channel, status === 'completed')
    }
  }

  private protocolRequestKey(requestId: string | number): string {
    return `${typeof requestId}:${String(requestId)}`
  }

  private registerPendingRequestControl(
    request: ServerRequest,
    kind: PendingRequestControl['kind'],
    key: string,
  ): void {
    const threadId = text(request.params.threadId) || text(request.params.conversationId)
    this.pendingRequestControls.set(this.protocolRequestKey(request.id), {
      kind,
      key,
      ...(threadId ? { threadId } : {}),
    })
  }

  private unregisterPendingRequestControl(
    request: ServerRequest,
    kind: PendingRequestControl['kind'],
    key: string,
  ): void {
    const requestKey = this.protocolRequestKey(request.id)
    const control = this.pendingRequestControls.get(requestKey)
    if (control?.kind === kind && control.key === key) {
      this.pendingRequestControls.delete(requestKey)
    }
  }

  private takePendingApproval(key: string): PendingApproval | undefined {
    const pending = this.approvals.get(key)
    if (!pending) return undefined
    this.approvals.delete(key)
    clearTimeout(pending.timeout)
    this.unregisterPendingRequestControl(pending.request, 'approval', key)
    return pending
  }

  private takePendingUserInput(key: string): PendingUserInput | undefined {
    const pending = this.pendingUserInputs.get(key)
    if (!pending) return undefined
    this.pendingUserInputs.delete(key)
    if (pending.timeout) clearTimeout(pending.timeout)
    this.unregisterPendingRequestControl(pending.request, 'userInput', key)
    return pending
  }

  private takePendingMcpElicitation(key: string): PendingMcpElicitation | undefined {
    const pending = this.pendingMcpElicitations.get(key)
    if (!pending) return undefined
    this.pendingMcpElicitations.delete(key)
    clearTimeout(pending.timeout)
    this.unregisterPendingRequestControl(pending.request, 'mcpElicitation', key)
    return pending
  }

  private mcpElicitationMessages(pending: PendingMcpElicitation): DiscordMessage[] {
    return [...pending.fieldMessages, pending.actionMessage]
  }

  private async onServerRequestResolved(params: JsonObject): Promise<void> {
    const requestId = params.requestId
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return
    const requestKey = this.protocolRequestKey(requestId)
    const control = this.pendingRequestControls.get(requestKey)
    if (!control) return
    const threadId = text(params.threadId) || text(params.conversationId)
    if (threadId && control.threadId && threadId !== control.threadId) return

    // Claim the control before editing Discord so a concurrent interaction cannot
    // send a second response for a request Codex has already resolved.
    this.pendingRequestControls.delete(requestKey)
    if (control.kind === 'approval') {
      const pending = this.takePendingApproval(control.key)
      if (!pending) return
      await pending.message.edit({
        content: `${pending.message.content}\n\n**Resolved elsewhere.**`,
        components: [],
      }).catch(() => undefined)
      return
    }
    if (control.kind === 'userInput') {
      const pending = this.takePendingUserInput(control.key)
      if (!pending) return
      await Promise.all(pending.messages.map((message) => message.edit({
        content: `${message.content}\n_Resolved elsewhere._`,
        components: [],
      }).catch(() => undefined)))
      return
    }
    if (control.kind === 'mcpElicitation') {
      const pending = this.takePendingMcpElicitation(control.key)
      if (!pending) return
      await Promise.all(this.mcpElicitationMessages(pending).map((message) => message.edit({
        content: `${message.content}\n_Resolved elsewhere._`,
        components: [],
      }).catch(() => undefined)))
      return
    }
    const pending = this.takePendingActionButtons(control.key)
    if (!pending) return
    await pending.message.edit({
      content: '**Action Required**\n_Resolved elsewhere._',
      components: [],
    }).catch(() => undefined)
  }

  private async dismissPendingControlsForChannel(
    discordThreadId: string,
    status: string,
  ): Promise<void> {
    const approvals = Array.from(this.approvals.entries())
      .filter(([, pending]) => pending.channel.id === discordThreadId)
      .flatMap(([key]) => {
        const pending = this.takePendingApproval(key)
        return pending ? [pending] : []
      })
    const userInputs = Array.from(this.pendingUserInputs.entries())
      .filter(([, pending]) => pending.channel.id === discordThreadId)
      .flatMap(([key]) => {
        const pending = this.takePendingUserInput(key)
        return pending ? [pending] : []
      })
    const actionButtons = Array.from(this.pendingActionButtons.entries())
      .filter(([, pending]) => pending.channel.id === discordThreadId)
      .flatMap(([key]) => {
        const pending = this.takePendingActionButtons(key)
        return pending ? [pending] : []
      })
    const mcpElicitations = Array.from(this.pendingMcpElicitations.entries())
      .filter(([, pending]) => pending.channel.id === discordThreadId)
      .flatMap(([key]) => {
        const pending = this.takePendingMcpElicitation(key)
        return pending ? [pending] : []
      })

    await Promise.all([
      ...approvals.map((pending) => pending.message.edit({
        content: `${pending.message.content}\n\n${status}`,
        components: [],
      }).catch(() => undefined)),
      ...userInputs.flatMap((pending) => pending.messages.map((message) => message.edit({
        content: `${message.content}\n${status}`,
        components: [],
      }).catch(() => undefined))),
      ...actionButtons.map((pending) => pending.message.edit({
        content: `**Action Required**\n${status}`,
        components: [],
      }).catch(() => undefined)),
      ...mcpElicitations.flatMap((pending) => this.mcpElicitationMessages(pending).map(
        (message) => message.edit({
          content: `${message.content}\n${status}`,
          components: [],
        }).catch(() => undefined),
      )),
    ])
  }

  private async prepareSessionForUserPrompt(
    session: SessionState,
    channel: ThreadChannel,
  ): Promise<void> {
    const hasBlockingControl =
      Array.from(this.approvals.values()).some((pending) => pending.channel.id === channel.id) ||
      Array.from(this.pendingUserInputs.values()).some((pending) => pending.channel.id === channel.id) ||
      Array.from(this.pendingMcpElicitations.values()).some(
        (pending) => pending.channel.id === channel.id,
      )
    const activeTurnId = this.runs.get(session.codexThreadId)?.turnId || session.activeTurnId
    if (hasBlockingControl) await this.persistAbortIntent(session, activeTurnId)

    let actionError: unknown
    try {
      await this.cancelActionButtonsForChannel(
        channel.id,
        '_Dismissed because a newer message was sent._',
        'Action button request cancelled because the user sent another message.',
      )
    } catch (error) {
      actionError = error
    }

    if (hasBlockingControl) {
      await this.dismissPendingControlsForChannel(
        channel.id,
        '_Dismissed because a newer message was sent._',
      )
      const result = await this.reconcileAbortIntent(session, activeTurnId)
      if (!result.cleared) {
        throw new Error(
          `Previous turn abort confirmation pending: ${result.errors.join('; ') || 'Codex still reports it active'}`,
        )
      }
    }
    if (actionError) throw actionError
  }

  private parseUserInputQuestions(params: JsonObject): UserInputQuestion[] {
    if (!Array.isArray(params.questions)) return []
    return params.questions.flatMap((value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') {
        return []
      }
      const options = Array.isArray(value.options)
        ? value.options.flatMap((option) => {
            if (!isRecord(option) || typeof option.label !== 'string') return []
            return [
              {
                label: option.label,
                description: typeof option.description === 'string' ? option.description : '',
              },
            ]
          })
        : null
      return [
        {
          id: value.id,
          header: typeof value.header === 'string' ? value.header : 'Question',
          question: value.question,
          isOther: value.isOther === true,
          isSecret: value.isSecret === true,
          options,
        },
      ]
    })
  }

  private async handleUserInputRequest(request: ServerRequest): Promise<void> {
    const channel = await this.resolveRunChannel(request)
    const questions = this.parseUserInputQuestions(request.params)
    if (!channel || questions.length === 0) {
      this.respondToCodex(request, { answers: {} })
      return
    }
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    const pending: PendingUserInput = {
      request,
      channel,
      questions,
      answers: {},
      messages: [],
    }
    this.pendingUserInputs.set(key, pending)
    this.registerPendingRequestControl(request, 'userInput', key)
    try {
      for (let index = 0; index < questions.length; index++) {
        const question = questions[index]
        if (!question) continue
        const content = `**${truncate(question.header, 100)}**\n${truncate(question.question, 1_700)}${question.isSecret ? '\n*Answer entered privately.*' : ''}`
        if (question.options?.length) {
          const select = new StringSelectMenuBuilder()
            .setCustomId(`userinput:${key}:${index}`)
            .setPlaceholder('Choose an answer')
            .addOptions(
              ...question.options.slice(0, question.isOther ? 24 : 25).map((option, optionIndex) => ({
                label: truncate(option.label, 100),
                value: `option:${optionIndex}`,
                ...(option.description ? { description: truncate(option.description, 100) } : {}),
              })),
              ...(question.isOther ? [{ label: 'Other…', value: 'other' }] : []),
            )
          const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
          pending.messages.push(await channel.send({ content, components: [row] }))
        } else {
          const button = new ButtonBuilder()
            .setCustomId(`userinput-text:${key}:${index}`)
            .setLabel(question.isSecret ? 'Enter private answer' : 'Answer')
            .setStyle(ButtonStyle.Primary)
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)
          pending.messages.push(await channel.send({ content, components: [row] }))
        }
      }
    } catch (error) {
      const claimed = this.takePendingUserInput(key)
      if (claimed) {
        this.respondToCodex(claimed.request, { answers: {} })
        await Promise.all(claimed.messages.map((message) => message.edit({
          content: `${message.content}\n_Cancelled because Discord could not show every question._`,
          components: [],
        }).catch(() => undefined)))
      }
      this.logVerbose('user input UI failed', { requestId: request.id, error: errorText(error) })
      return
    }
    const autoResolutionMs = request.params.autoResolutionMs
    if (typeof autoResolutionMs === 'number' && autoResolutionMs > 0) {
      pending.timeout = setTimeout(() => {
        if (this.stopping) return
        this.trackBackgroundWork(
          this.finishUserInput(key, true),
          'user input auto-resolution',
        )
      }, autoResolutionMs)
      pending.timeout.unref()
    }
  }

  private async showUserInputModal(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    key: string,
    questionIndex: number,
  ): Promise<void> {
    const pending = this.pendingUserInputs.get(key)
    const question = pending?.questions[questionIndex]
    if (!pending || !question) {
      await interaction.reply({ content: 'Question expired.' })
      return
    }
    const input = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel(truncate(question.header || 'Answer', 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4_000)
    const modal = new ModalBuilder()
      .setCustomId(`userinput-modal:${key}:${questionIndex}`)
      .setTitle(truncate(question.header || 'Answer', 45))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    await interaction.showModal(modal)
  }

  private async handleUserInputSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!interaction.customId.startsWith('userinput:')) return
    if (!(await this.requireAccess(interaction))) return
    const [, key, indexText] = interaction.customId.split(':')
    const index = Number(indexText)
    const pending = key ? this.pendingUserInputs.get(key) : undefined
    const question = pending?.questions[index]
    if (!key || !pending || !question) {
      await interaction.reply({ content: 'Question expired.' })
      return
    }
    const selected = interaction.values[0]
    if (selected === 'other') {
      await this.showUserInputModal(interaction, key, index)
      return
    }
    const optionIndex = selected?.startsWith('option:') ? Number(selected.slice(7)) : Number.NaN
    const option = question.options?.[optionIndex]
    if (!option) {
      await interaction.reply({ content: 'Invalid answer.' })
      return
    }
    await interaction.deferUpdate()
    await this.waitForMutationIngressReady()
    const currentPending = this.pendingUserInputs.get(key)
    const currentQuestion = currentPending?.questions[index]
    const currentOption = currentQuestion?.options?.[optionIndex]
    if (!currentPending || !currentQuestion || !currentOption) {
      await interaction.followUp({ content: 'Question expired.', ephemeral: true }).catch(() => undefined)
      return
    }
    currentPending.answers[currentQuestion.id] = [currentOption.label]
    if (!currentQuestion.isSecret) {
      await currentPending.channel.send({
        content: `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${currentOption.label}`,
        allowedMentions: { parse: [] },
      }).catch((error: unknown) => {
        this.logVerbose('user input echo delivery failed', {
          threadId: text(currentPending.request.params.threadId),
          error: errorText(error),
        })
      })
    }
    await this.finishUserInput(key)
  }

  private async handleUserInputModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith('userinput-modal:')) return
    if (!(await this.requireAccess(interaction))) return
    const [, key, indexText] = interaction.customId.split(':')
    const index = Number(indexText)
    const pending = key ? this.pendingUserInputs.get(key) : undefined
    const question = pending?.questions[index]
    if (!key || !pending || !question) {
      await interaction.reply({ content: 'Question expired.' })
      return
    }
    const answer = interaction.fields.getTextInputValue('answer')
    await interaction.deferUpdate()
    await this.waitForMutationIngressReady()
    const currentPending = this.pendingUserInputs.get(key)
    const currentQuestion = currentPending?.questions[index]
    if (!currentPending || !currentQuestion) {
      await interaction.followUp({ content: 'Question expired.', ephemeral: true }).catch(() => undefined)
      return
    }
    currentPending.answers[currentQuestion.id] = [answer]
    if (!currentQuestion.isSecret) {
      await currentPending.channel.send({
        content: `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${answer}`,
        allowedMentions: { parse: [] },
      }).catch((error: unknown) => {
        this.logVerbose('user input echo delivery failed', {
          threadId: text(currentPending.request.params.threadId),
          error: errorText(error),
        })
      })
    }
    await this.finishUserInput(key)
  }

  private async finishUserInput(key: string, timedOut = false): Promise<void> {
    const pending = this.pendingUserInputs.get(key)
    if (!pending) return
    const complete = pending.questions.every((question) => pending.answers[question.id])
    if (!complete && !timedOut) return
    const claimed = this.takePendingUserInput(key)
    if (!claimed) return
    const answers = Object.fromEntries(
      Object.entries(claimed.answers).map(([questionId, values]) => [questionId, { answers: values }]),
    )
    this.respondToCodex(claimed.request, { answers })
    for (let index = 0; index < claimed.messages.length; index++) {
      const message = claimed.messages[index]
      const question = claimed.questions[index]
      if (!message || !question) continue
      const answer = claimed.answers[question.id]?.join(', ')
      const result = answer
        ? question.isSecret ? 'Answer recorded privately' : answer
        : 'Auto-resolved'
      await message
        .edit({
          content: `${message.content}\n✓ _${escapeInlineMarkdown(result)}_`,
          components: [],
        })
        .catch(() => undefined)
    }
  }

  private mcpElicitationHeader(request: ServerRequest): string {
    const serverName = text(request.params.serverName) || 'unknown'
    const message = text(request.params.message)?.trim() || 'The MCP server requested input.'
    return [
      `**MCP request from ${discordInlineCode(serverName)}**`,
      truncate(message, 650),
    ].join('\n')
  }

  private mcpToolApprovalDisclosureChunks(request: ServerRequest): string[] | undefined {
    const params = mcpToolApprovalDisplayParams(request.params._meta)
    let rendered = `${this.mcpElicitationHeader(request)}\n\n**Tool parameters**`
    if (params.length === 0) {
      rendered += '\n_None._'
    } else {
      try {
        const serialized = JSON.stringify(params.map((param) => ({
          name: param.name,
          displayName: param.displayName,
          value: param.value,
        })), null, 2)
        if (serialized === undefined) return undefined
        rendered += `\n\`\`\`json\n${serialized}\n\`\`\``
      } catch {
        return undefined
      }
    }
    const chunks = splitMarkdownForDiscord(rendered, 1_900)
    return chunks.length <= maxMcpToolApprovalDisclosureChunks ? chunks : undefined
  }

  private mcpElicitationFieldValueLabel(
    field: McpElicitationField,
    value: JsonValue | undefined,
  ): string {
    if (value === undefined) return '_Not answered_'
    if (field.kind === 'string' || field.kind === 'number') return '_Recorded_'
    if (field.kind === 'boolean') return value === true ? '`True`' : '`False`'
    if (field.kind === 'singleSelect' && typeof value === 'string') {
      return discordInlineCode(field.options.find((option) => option.value === value)?.label || value || '(empty)')
    }
    if (field.kind === 'multiSelect' && Array.isArray(value)) {
      if (value.length === 0) return '`None`'
      const labels = value.slice(0, 5).map((entry) => {
        const selected = typeof entry === 'string'
          ? field.options.find((option) => option.value === entry)?.label || entry
          : String(entry)
        return discordInlineCode(truncate(selected, 80))
      })
      if (value.length > labels.length) labels.push(`_${value.length - labels.length} more_`)
      return labels.join(', ')
    }
    return discordInlineCode(truncate(String(value), 180))
  }

  private mcpElicitationFieldContent(
    request: ServerRequest,
    field: McpElicitationField,
    value: JsonValue | undefined,
    includeHeader: boolean,
  ): string {
    const sections: string[] = []
    if (includeHeader) sections.push(this.mcpElicitationHeader(request))
    const required = field.required ? ' · required' : ' · optional'
    const fieldLines = [`**${escapeInlineMarkdown(truncate(field.label, 100))}**${required}`]
    if (field.description !== field.label) fieldLines.push(truncate(field.description, 500))
    const constraints: string[] = []
    if (field.kind === 'string') {
      if (field.format) constraints.push(field.format)
      if (field.minLength !== undefined) constraints.push(`min ${field.minLength} characters`)
      if (field.maxLength !== undefined) constraints.push(`max ${field.maxLength} characters`)
    } else if (field.kind === 'number') {
      constraints.push(field.integer ? 'integer' : 'number')
      if (field.minimum !== undefined) constraints.push(`min ${field.minimum}`)
      if (field.maximum !== undefined) constraints.push(`max ${field.maximum}`)
    } else if (field.kind === 'multiSelect') {
      if (field.minItems !== undefined) constraints.push(`min ${field.minItems} selections`)
      if (field.maxItems !== undefined) constraints.push(`max ${field.maxItems} selections`)
    }
    if (constraints.length > 0) fieldLines.push(`_${constraints.join(' · ')}_`)
    fieldLines.push(`Current: ${this.mcpElicitationFieldValueLabel(field, value)}`)
    sections.push(fieldLines.join('\n'))
    return sections.join('\n\n')
  }

  private mcpElicitationFieldComponents(
    key: string,
    index: number,
    field: McpElicitationField,
    value: JsonValue | undefined,
  ) {
    if (field.kind === 'string' || field.kind === 'number') {
      const fixedEmpty = field.kind === 'string' && field.maxLength === 0
      const button = new ButtonBuilder()
        .setCustomId(`mcp-elicit-field:${key}:${index}`)
        .setLabel(fixedEmpty ? 'Empty value' : value === undefined ? 'Enter value' : 'Edit value')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(fixedEmpty)
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)]
    }
    const selected = new Set(
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : typeof value === 'string'
          ? [value]
          : [],
    )
    const options = field.kind === 'boolean'
      ? [
          { label: 'True', value: 'true', selected: value === true },
          { label: 'False', value: 'false', selected: value === false },
        ]
      : field.options.map((option, optionIndex) => ({
          label: truncate(option.label || '(empty)', 100),
          value: `option:${optionIndex}`,
          selected: selected.has(option.value),
        }))
    if (field.kind === 'multiSelect' && field.maxItems === 0) {
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-field:${key}:${index}`)
          .setLabel('Empty selection')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      )]
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`mcp-elicit-select:${key}:${index}`)
      .setPlaceholder(truncate(field.label || 'Choose a value', 100))
      .addOptions(...options.map((option) => ({
        label: option.label,
        value: option.value,
        default: option.selected,
      })))
    if (field.kind === 'multiSelect') {
      select
        .setMinValues(field.minItems ?? 0)
        .setMaxValues(Math.min(field.maxItems ?? field.options.length, field.options.length))
    } else {
      select.setMinValues(field.required ? 1 : 0).setMaxValues(1)
    }
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)]
  }

  private mcpElicitationActionComponents(
    key: string,
    request: ServerRequest,
    form: McpElicitationForm | undefined,
    url: string | undefined,
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (url) {
      const serverName = text(request.params.serverName)
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:open`)
          .setLabel(serverName === 'codex_apps' ? 'Open sign-in URL' : 'Open link')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:accept`)
          .setLabel(serverName === 'codex_apps' ? 'I already signed in' : 'I finished')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:decline`)
          .setLabel('Decline')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      )]
    }
    if (form && form.fields.length > 0) {
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:submit`)
          .setLabel('Submit')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:decline`)
          .setLabel('Decline')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`mcp-elicit-action:${key}:cancel`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger),
      )]
    }
    const toolApproval = isMcpToolApproval(request.params._meta)
    const buttons = [new ButtonBuilder()
      .setCustomId(`mcp-elicit-action:${key}:accept`)
      .setLabel('Allow')
      .setStyle(ButtonStyle.Success)]
    const persistModes = mcpElicitationPersistModes(request.params._meta)
    if (persistModes.includes('session')) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`mcp-elicit-action:${key}:session`)
        .setLabel('Allow for this session')
        .setStyle(ButtonStyle.Primary))
    }
    if (persistModes.includes('always')) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`mcp-elicit-action:${key}:always`)
        .setLabel('Always allow')
        .setStyle(ButtonStyle.Primary))
    }
    if (!toolApproval) {
      buttons.push(new ButtonBuilder()
        .setCustomId(`mcp-elicit-action:${key}:decline`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Secondary))
    }
    buttons.push(new ButtonBuilder()
      .setCustomId(`mcp-elicit-action:${key}:cancel`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger))
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)]
  }

  private async resolvePendingMcpElicitation(
    key: string,
    result: JsonObject,
    status: string,
  ): Promise<boolean> {
    const pending = this.takePendingMcpElicitation(key)
    if (!pending) return false
    this.respondToCodex(pending.request, result)
    await Promise.all(this.mcpElicitationMessages(pending).map((message) => message.edit({
      content: `${message.content}\n${status}`,
      components: [],
    }).catch(() => undefined)))
    return true
  }

  private async expireMcpElicitation(key: string): Promise<boolean> {
    return this.resolvePendingMcpElicitation(
      key,
      { action: 'cancel', content: null, _meta: null },
      '_Request expired._',
    )
  }

  private async handleMcpElicitationRequest(request: ServerRequest): Promise<void> {
    const channel = await this.resolveRunChannel(request)
    if (!channel) {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      return
    }
    const mode = text(request.params.mode)
    if (mode === 'openai/form') {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      return
    }
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
    let form: McpElicitationForm | undefined
    let url: string | undefined
    if (mode === 'form') {
      try {
        form = parseMcpElicitationForm(request.params.requestedSchema)
      } catch (error) {
        this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
        this.logVerbose('MCP elicitation schema declined', {
          requestId: request.id,
          error: errorText(error),
        })
        await channel.send({
          content: `${this.mcpElicitationHeader(request)}\n\n_This form could not be rendered safely and was declined._`,
          allowedMentions: { parse: [] },
        }).catch(() => undefined)
        return
      }
    } else if (mode === 'url') {
      url = validateMcpElicitationUrl(request.params.url, request.params.serverName)
      if (!url || typeof request.params.elicitationId !== 'string') {
        this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
        await channel.send({
          content: `${this.mcpElicitationHeader(request)}\n\n_The external URL was unsafe or unsupported and was declined._`,
          allowedMentions: { parse: [] },
        }).catch(() => undefined)
        return
      }
    } else {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      return
    }

    const toolApproval = Boolean(
      form && form.fields.length === 0 && isMcpToolApproval(request.params._meta),
    )
    const toolApprovalChunks = toolApproval
      ? this.mcpToolApprovalDisclosureChunks(request)
      : undefined
    if (toolApproval && !toolApprovalChunks) {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      await channel.send({
        content: `${this.mcpElicitationHeader(request)}\n\n_The complete tool parameters were too large to display safely, so this request was declined._`,
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return
    }

    const fieldMessages: DiscordMessage[] = []
    let actionMessage: DiscordMessage
    try {
      if (form) {
        for (let index = 0; index < form.fields.length; index++) {
          const field = form.fields[index]
          if (!field) continue
          fieldMessages.push(await channel.send({
            content: this.mcpElicitationFieldContent(
              request,
              field,
              form.initialContent[field.id],
              index === 0,
            ),
            components: this.mcpElicitationFieldComponents(
              key,
              index,
              field,
              form.initialContent[field.id],
            ),
            allowedMentions: { parse: [] },
          }))
        }
      }
      if (toolApprovalChunks) {
        for (const chunk of toolApprovalChunks.slice(0, -1)) {
          fieldMessages.push(await channel.send({
            content: chunk,
            allowedMentions: { parse: [] },
          }))
        }
      }
      const actionContent = toolApprovalChunks?.at(-1) || (form?.fields.length
        ? '**MCP form response**'
        : this.mcpElicitationHeader(request))
      actionMessage = await channel.send({
        content: actionContent,
        components: this.mcpElicitationActionComponents(key, request, form, url),
        allowedMentions: { parse: [] },
      })
    } catch (error) {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      await Promise.all(fieldMessages.map((message) => message.edit({
        content: `${message.content}\n_Cancelled because Discord could not show the complete request._`,
        components: [],
      }).catch(() => undefined)))
      this.logVerbose('MCP elicitation UI failed', { requestId: request.id, error: errorText(error) })
      return
    }
    const timeout = setTimeout(() => {
      if (this.stopping) return
      this.trackBackgroundWork(
        this.expireMcpElicitation(key).then(() => undefined),
        'MCP elicitation expiry',
      )
    }, defaultMcpElicitationTimeoutMinutes * 60_000)
    timeout.unref()
    this.pendingMcpElicitations.set(key, {
      request,
      channel,
      mode,
      ...(form ? { form } : {}),
      ...(url ? { url } : {}),
      content: form
        ? Object.assign(Object.create(null), structuredClone(form.initialContent)) as Record<string, JsonValue>
        : Object.create(null) as Record<string, JsonValue>,
      fieldMessages,
      actionMessage,
      timeout,
      toolApproval,
    })
    this.registerPendingRequestControl(request, 'mcpElicitation', key)
  }

  private async refreshMcpElicitationField(
    key: string,
    pending: PendingMcpElicitation,
    index: number,
  ): Promise<void> {
    const field = pending.form?.fields[index]
    const message = pending.fieldMessages[index]
    if (!field || !message) return
    await message.edit({
      content: this.mcpElicitationFieldContent(
        pending.request,
        field,
        pending.content[field.id],
        index === 0,
      ),
      components: this.mcpElicitationFieldComponents(
        key,
        index,
        field,
        pending.content[field.id],
      ),
      allowedMentions: { parse: [] },
    })
  }

  private async showMcpElicitationModal(
    interaction: ButtonInteraction,
    key: string,
    index: number,
  ): Promise<void> {
    const pending = this.pendingMcpElicitations.get(key)
    const field = pending?.form?.fields[index]
    if (
      !pending ||
      !field ||
      (field.kind !== 'string' && field.kind !== 'number') ||
      interaction.channelId !== pending.channel.id
    ) {
      await interaction.reply({ content: 'This MCP request is no longer available.', ephemeral: true })
      return
    }
    const current = pending.content[field.id]
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel(truncate(field.label || 'Value', 45))
      .setStyle(field.kind === 'string' && (field.maxLength ?? 4_000) > 200
        ? TextInputStyle.Paragraph
        : TextInputStyle.Short)
      .setRequired(field.kind === 'number' ? field.required : field.required && (field.minLength ?? 0) > 0)
      .setMaxLength(field.kind === 'string' ? Math.max(1, Math.min(field.maxLength ?? 4_000, 4_000)) : 100)
    if (field.kind === 'string' && field.minLength && field.minLength <= 4_000) {
      input.setMinLength(field.minLength)
    }
    if (current !== undefined) input.setValue(String(current).slice(0, 4_000))
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`mcp-elicit-modal:${key}:${index}`)
      .setTitle(truncate(field.label || 'MCP request', 45))
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)))
  }

  private async handleMcpElicitationSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
    const [, key, indexText] = interaction.customId.split(':')
    const index = Number(indexText)
    const pending = key ? this.pendingMcpElicitations.get(key) : undefined
    const field = pending?.form?.fields[index]
    if (
      !key ||
      !pending ||
      !field ||
      (field.kind !== 'boolean' && field.kind !== 'singleSelect' && field.kind !== 'multiSelect') ||
      interaction.channelId !== pending.channel.id
    ) {
      await interaction.reply({ content: 'This MCP request is no longer available.', ephemeral: true })
      return
    }
    await interaction.deferUpdate()
    await this.waitForMutationIngressReady()
    const current = this.pendingMcpElicitations.get(key)
    const currentField = current?.form?.fields[index]
    if (!current || !currentField || currentField.kind !== field.kind) {
      await interaction.followUp({ content: 'This MCP request is no longer available.', ephemeral: true })
        .catch(() => undefined)
      return
    }
    let value: JsonValue | undefined
    if (currentField.kind === 'boolean') {
      if (interaction.values.length === 1) {
        if (interaction.values[0] !== 'true' && interaction.values[0] !== 'false') {
          await interaction.followUp({ content: 'Invalid boolean selection.', ephemeral: true })
            .catch(() => undefined)
          return
        }
        value = interaction.values[0] === 'true'
      }
    } else {
      const indexes = interaction.values.map((selected) =>
        selected.startsWith('option:') ? Number(selected.slice(7)) : Number.NaN)
      if (indexes.some((selected) => !Number.isInteger(selected) || !currentField.options[selected])) {
        await interaction.followUp({ content: 'Invalid MCP form selection.', ephemeral: true })
          .catch(() => undefined)
        return
      }
      const values = indexes.map((selected) => currentField.options[selected]?.value || '')
      value = currentField.kind === 'singleSelect' ? values[0] : values
    }
    if (value === undefined || (currentField.kind !== 'multiSelect' && interaction.values.length === 0)) {
      delete current.content[currentField.id]
    } else if (currentField.kind === 'multiSelect' && interaction.values.length === 0 && !currentField.required) {
      delete current.content[currentField.id]
    } else {
      const error = validateMcpElicitationFieldValue(currentField, value)
      if (error) {
        await interaction.followUp({
          content: `${currentField.label} ${error}.`,
          ephemeral: true,
        }).catch(() => undefined)
        return
      }
      current.content[currentField.id] = value
    }
    await this.refreshMcpElicitationField(key, current, index)
  }

  private async handleMcpElicitationModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
    const [, key, indexText] = interaction.customId.split(':')
    const index = Number(indexText)
    const pending = key ? this.pendingMcpElicitations.get(key) : undefined
    const field = pending?.form?.fields[index]
    if (
      !key ||
      !pending ||
      !field ||
      (field.kind !== 'string' && field.kind !== 'number') ||
      interaction.channelId !== pending.channel.id
    ) {
      await interaction.reply({ content: 'This MCP request is no longer available.', ephemeral: true })
      return
    }
    const raw = interaction.fields.getTextInputValue('value')
    await interaction.deferUpdate()
    await this.waitForMutationIngressReady()
    const current = this.pendingMcpElicitations.get(key)
    const currentField = current?.form?.fields[index]
    if (
      !current ||
      !currentField ||
      (currentField.kind !== 'string' && currentField.kind !== 'number')
    ) {
      await interaction.followUp({ content: 'This MCP request is no longer available.', ephemeral: true })
        .catch(() => undefined)
      return
    }
    if (raw === '' && !currentField.required) {
      delete current.content[currentField.id]
      await this.refreshMcpElicitationField(key, current, index)
      return
    }
    const value = currentField.kind === 'number' ? parseMcpElicitationNumberInput(raw) : raw
    if (value === undefined) {
      await interaction.followUp({ content: `${currentField.label} must be a number.`, ephemeral: true })
        .catch(() => undefined)
      return
    }
    const error = validateMcpElicitationFieldValue(currentField, value)
    if (error) {
      await interaction.followUp({ content: `${currentField.label} ${error}.`, ephemeral: true })
        .catch(() => undefined)
      return
    }
    current.content[currentField.id] = value
    await this.refreshMcpElicitationField(key, current, index)
  }

  private takePendingActionButtons(key: string): PendingActionButtons | undefined {
    const pending = this.pendingActionButtons.get(key)
    if (!pending) return undefined
    this.pendingActionButtons.delete(key)
    clearTimeout(pending.timeout)
    this.unregisterPendingRequestControl(pending.request, 'actionButtons', key)
    return pending
  }

  private async finishPendingActionButtons(
    key: string,
    status: string,
    resultText: string,
    success: boolean,
  ): Promise<boolean> {
    const pending = this.takePendingActionButtons(key)
    if (!pending) return false
    try {
      this.respondToCodex(pending.request, actionButtonToolResult(resultText, success))
    } finally {
      await pending.message
        .edit({ content: `**Action Required**\n${status}`, components: [] })
        .catch(() => undefined)
    }
    return true
  }

  private async cancelActionButtonsForChannel(
    discordThreadId: string,
    status: string,
    resultText: string,
  ): Promise<void> {
    const matches = Array.from(this.pendingActionButtons.entries())
      .filter(([, pending]) => pending.channel.id === discordThreadId)
    for (const [key] of matches) {
      await this.finishPendingActionButtons(key, status, resultText, false)
    }
  }

  private async handleActionButtonsRequest(request: ServerRequest): Promise<void> {
    const tool = text(request.params.tool)
    if (tool !== actionButtonsToolName || typeof request.params.namespace === 'string') {
      this.respondToCodex(
        request,
        actionButtonToolResult(`Unsupported Cordex dynamic tool: ${tool || 'unknown'}`, false),
      )
      return
    }
    const threadId = text(request.params.threadId)
    const channel = await this.resolveRunChannel(request)
    const session = channel ? this.state.sessions[channel.id] : undefined
    if (!threadId || !channel || !session || session.codexThreadId !== threadId) {
      this.respondToCodex(
        request,
        actionButtonToolResult('Discord session is unavailable for action buttons.', false),
      )
      return
    }
    let buttons: ActionButtonOption[]
    try {
      buttons = parseActionButtons(request.params.arguments)
    } catch (error) {
      this.respondToCodex(request, actionButtonToolResult(errorText(error), false))
      return
    }

    await this.cancelActionButtonsForChannel(
      channel.id,
      '_Replaced by a newer action._',
      'Action button request replaced by a newer request.',
    )
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...buttons.map((button, index) => new ButtonBuilder()
        .setCustomId(`action-tool:${key}:${index}`)
        .setLabel(button.label)
        .setStyle(actionButtonStyle(button.color))),
    )
    let message: DiscordMessage
    try {
      message = await channel.send({ content: '**Action Required**', components: [row] })
    } catch (error) {
      this.respondToCodex(
        request,
        actionButtonToolResult(`Failed to show Discord action buttons: ${errorText(error)}`, false),
      )
      return
    }
    const timeout = setTimeout(() => {
      if (this.stopping) return
      this.trackBackgroundWork(
        this.finishPendingActionButtons(
          key,
          '_Expired._',
          'Action button request expired before the user selected an option.',
          false,
        ).then(() => undefined),
        'action button expiry',
      )
    }, actionButtonTtlMs)
    timeout.unref()
    this.pendingActionButtons.set(key, { request, threadId, channel, buttons, message, timeout })
    this.registerPendingRequestControl(request, 'actionButtons', key)
  }

  private async handleFileUploadToolRequest(request: ServerRequest): Promise<void> {
    const tool = text(request.params.tool)
    if (tool !== fileUploadToolName || typeof request.params.namespace === 'string') {
      this.respondToCodex(request, actionButtonToolResult('Unsupported Cordex upload tool.', false))
      return
    }
    const threadId = text(request.params.threadId)
    const channel = await this.resolveRunChannel(request)
    const session = channel ? this.state.sessions[channel.id] : undefined
    if (!threadId || !channel || !session || session.codexThreadId !== threadId) {
      this.respondToCodex(request, actionButtonToolResult('Discord session is unavailable for file upload.', false))
      return
    }
    try {
      const requested = parseFileUploadPaths(request.params.arguments)
      const root = path.resolve(session.directory)
      const filePaths = requested.map((value) => {
        const filePath = path.resolve(root, value)
        if (!pathIsWithinOrEqual(root, filePath)) {
          throw new Error('Upload tool paths must stay inside the current session directory')
        }
        const relative = path.relative(root, filePath)
        if (relative.split(path.sep).some((segment) => segment.startsWith('.'))) {
          throw new Error('Upload tool cannot send hidden files or hidden directories')
        }
        return filePath
      })
      const turnId = this.turnIdFrom(request.params) || ''
      const itemId = text(request.params.itemId) || ''
      const requestId = `tool-${createHash('sha256')
        .update(`${threadId}|${turnId}|${itemId}|${String(request.id)}`)
        .digest('hex').slice(0, 32)}`
      const result = await this.uploadDaemonFiles({
        target: { kind: 'thread', id: channel.id },
        requestId,
        filePaths,
        allowOutsideProject: false,
        rejectHidden: true,
      })
      this.respondToCodex(request, actionButtonToolResult(
        result.fileCount > 0
          ? `Queued ${result.fileCount} file${result.fileCount === 1 ? '' : 's'} for this Discord thread.`
          : 'This upload was already queued or delivered.',
        true,
      ))
    } catch (error) {
      this.respondToCodex(request, actionButtonToolResult(
        `File upload failed: ${truncate(errorText(error), 900)}`,
        false,
      ))
    }
  }

  private async resolveThreadChannel(params: JsonObject): Promise<ThreadChannel | undefined> {
    const run = this.findRun(params)
    if (run) return run.channel
    const threadId = text(params.threadId) || text(params.conversationId)
    if (!threadId) return undefined
    const session = Object.values(this.state.sessions).find((candidate) => candidate.codexThreadId === threadId)
    if (!session) return undefined
    const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
    return channel?.isThread() ? channel : undefined
  }

  private async resolveRunChannel(request: ServerRequest): Promise<ThreadChannel | undefined> {
    return this.resolveThreadChannel(request.params)
  }

  private approvalDetail(
    lines: string[],
    label: string,
    value: unknown,
    limit: number,
  ): void {
    if (value === undefined || value === null || value === '') return
    let rendered: string
    if (typeof value === 'string') {
      rendered = value
    } else {
      try {
        rendered = JSON.stringify(value)
      } catch {
        rendered = String(value)
      }
    }
    lines.push(`**${label}:** ${discordInlineCode(truncate(rendered, limit))}`)
  }

  private approvalDescription(request: ServerRequest): string {
    const header = '⚠️ **Permission Required**'
    const lines = [header]
    if (request.method === 'item/permissions/requestApproval') {
      lines.push('**Type:** `permissions`')
      this.approvalDetail(lines, 'Working directory', request.params.cwd, 180)
      this.approvalDetail(lines, 'Reason', request.params.reason, 220)
      this.approvalDetail(
        lines,
        'Requested permissions',
        isRecord(request.params.permissions)
          ? request.params.permissions
          : 'Additional permissions',
        700,
      )
      return lines.join('\n')
    }
    if (request.method.includes('commandExecution')) {
      const hasCommand = Boolean(text(request.params.command))
      lines.push(`**Type:** \`${hasCommand ? 'command' : 'network'}\``)
      this.approvalDetail(lines, 'Command', request.params.command, 380)
      this.approvalDetail(lines, 'Working directory', request.params.cwd, 180)
      this.approvalDetail(lines, 'Reason', request.params.reason, 220)
      this.approvalDetail(lines, 'Network context', request.params.networkApprovalContext, 200)
      this.approvalDetail(lines, 'Additional permissions', request.params.additionalPermissions, 220)
      this.approvalDetail(
        lines,
        'Proposed exec policy amendment',
        request.params.proposedExecpolicyAmendment,
        200,
      )
      this.approvalDetail(
        lines,
        'Proposed network amendments',
        request.params.proposedNetworkPolicyAmendments,
        220,
      )
      return lines.join('\n')
    }
    if (request.method === 'execCommandApproval' && Array.isArray(request.params.command)) {
      lines.push('**Type:** `command`')
      this.approvalDetail(lines, 'Command', request.params.command.join(' '), 900)
      this.approvalDetail(lines, 'Working directory', request.params.cwd, 300)
      this.approvalDetail(lines, 'Reason', request.params.reason, 300)
      return lines.join('\n')
    }
    lines.push('**Type:** `file_change`')
    this.approvalDetail(lines, 'Reason', request.params.reason, 500)
    this.approvalDetail(lines, 'Grant root', request.params.grantRoot, 500)
    if (isRecord(request.params.fileChanges)) {
      this.approvalDetail(lines, 'Files', Object.keys(request.params.fileChanges), 600)
    }
    return lines.join('\n')
  }

  private exactApprovalChoice(decision: unknown): ApprovalChoice | undefined {
    if (typeof decision === 'string') {
      if (decision === 'accept') {
        return {
          label: 'Accept',
          style: ButtonStyle.Success,
          result: { decision },
          confirmation: 'Approved',
        }
      }
      if (decision === 'acceptForSession') {
        return {
          label: 'Accept for Session',
          style: ButtonStyle.Success,
          result: { decision },
          confirmation: 'Approved for this session',
        }
      }
      if (decision === 'decline') {
        return {
          label: 'Deny',
          style: ButtonStyle.Secondary,
          result: { decision },
          confirmation: 'Declined',
        }
      }
      if (decision === 'cancel') {
        return {
          label: 'Deny and Stop',
          style: ButtonStyle.Danger,
          result: { decision },
          confirmation: 'Declined and stopped',
        }
      }
      return undefined
    }
    if (!isRecord(decision)) return undefined

    const execPolicy = decision.acceptWithExecpolicyAmendment
    if (
      isRecord(execPolicy) &&
      Array.isArray(execPolicy.execpolicy_amendment) &&
      execPolicy.execpolicy_amendment.every((part) => typeof part === 'string')
    ) {
      return {
        label: 'Accept and Remember Command',
        style: ButtonStyle.Primary,
        result: { decision },
        confirmation: 'Approved and command policy updated',
      }
    }

    const networkPolicy = decision.applyNetworkPolicyAmendment
    if (!isRecord(networkPolicy) || !isRecord(networkPolicy.network_policy_amendment)) {
      return undefined
    }
    const amendment = networkPolicy.network_policy_amendment
    const host = text(amendment.host)
    const action = text(amendment.action)
    if (!host || (action !== 'allow' && action !== 'deny')) return undefined
    return {
      label: truncate(`${action === 'allow' ? 'Always Allow' : 'Always Deny'} ${host}`, 80),
      style: action === 'allow' ? ButtonStyle.Primary : ButtonStyle.Danger,
      result: { decision },
      confirmation: action === 'allow'
        ? 'Approved and network policy updated'
        : 'Declined and network policy updated',
    }
  }

  private approvalChoices(request: ServerRequest): ApprovalChoice[] {
    if (
      request.method === 'item/commandExecution/requestApproval' &&
      Array.isArray(request.params.availableDecisions)
    ) {
      return request.params.availableDecisions
        .map((decision) => this.exactApprovalChoice(decision))
        .filter((choice): choice is ApprovalChoice => choice !== undefined)
    }
    return [
      {
        label: 'Accept',
        style: ButtonStyle.Success,
        result: this.approvalResult(request, 'once'),
        confirmation: 'Approved',
      },
      {
        label: 'Accept Always',
        style: ButtonStyle.Success,
        result: this.approvalResult(request, 'session'),
        confirmation: 'Approved for this session',
      },
      {
        label: 'Deny',
        style: ButtonStyle.Secondary,
        result: this.approvalResult(request, 'decline'),
        confirmation: 'Declined',
      },
    ]
  }

  private approvalTimeoutResult(pending: PendingApproval): JsonObject {
    const refusal = pending.choices.find((choice) => {
      const decision = choice.result.decision
      return decision === 'decline' || decision === 'cancel' || decision === 'denied'
    })
    return refusal?.result ?? this.approvalResult(pending.request, 'decline')
  }

  private serverRequestMatchesActiveTurn(request: ServerRequest): boolean {
    const turnId = this.turnIdFrom(request.params)
    if (!turnId) return true
    const run = this.findRun(request.params)
    if (run) return this.notificationMatchesRun(run, request.params)
    const threadId = text(request.params.threadId) || text(request.params.conversationId)
    if (!threadId) return false
    const session = Object.values(this.state.sessions).find(
      (candidate) => candidate.codexThreadId === threadId,
    )
    return session?.activeTurnId === turnId
  }

  private rejectStaleServerRequest(request: ServerRequest): void {
    if (request.method === 'item/tool/requestUserInput') {
      this.respondToCodex(request, { answers: {} })
      return
    }
    if (request.method === 'item/tool/call') {
      this.respondToCodex(
        request,
        actionButtonToolResult('Discord turn is no longer active.', false),
      )
      return
    }
    if (request.method === 'mcpServer/elicitation/request') {
      this.respondToCodex(request, { action: 'decline', content: null, _meta: null })
      return
    }
    this.respondToCodex(request, this.approvalResult(request, 'decline'))
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (request.method === 'currentTime/read') {
      this.respondToCodex(request, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      return
    }
    if (!this.serverRequestMatchesActiveTurn(request)) {
      this.rejectStaleServerRequest(request)
      return
    }
    if (request.method === 'item/tool/requestUserInput') {
      await this.handleUserInputRequest(request)
      return
    }
    if (request.method === 'item/tool/call') {
      if (text(request.params.tool) === fileUploadToolName) {
        await this.handleFileUploadToolRequest(request)
      } else await this.handleActionButtonsRequest(request)
      return
    }
    if (request.method === 'mcpServer/elicitation/request') {
      await this.handleMcpElicitationRequest(request)
      return
    }
    const supported = new Set([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'execCommandApproval',
      'applyPatchApproval',
    ])
    if (!supported.has(request.method)) {
      this.respondToCodex(request, { error: `Unsupported Cordex request: ${request.method}` })
      return
    }
    const channel = await this.resolveRunChannel(request)
    if (!channel) {
      this.respondToCodex(request, this.approvalResult(request, 'decline'))
      return
    }
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const choices = this.approvalChoices(request)
    if (choices.length === 0) {
      this.respondToCodex(request, this.approvalResult(request, 'decline'))
      await channel.send({
        content: `${this.approvalDescription(request)}\n\n**No supported approval choices were provided; declined.**`,
        allowedMentions: { parse: [] },
      }).catch(() => undefined)
      return
    }
    const rows: ActionRowBuilder<ButtonBuilder>[] = []
    for (let index = 0; index < choices.length; index += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...choices.slice(index, index + 5).map((choice, offset) => new ButtonBuilder()
          .setCustomId(`approve:${key}:${index + offset}`)
          .setLabel(choice.label)
          .setStyle(choice.style)),
      ))
    }
    let message: DiscordMessage
    try {
      message = await channel.send({
        content: this.approvalDescription(request),
        components: rows,
        allowedMentions: { parse: [] },
      })
    } catch (error) {
      this.respondToCodex(request, this.approvalResult(request, 'decline'))
      this.logVerbose('approval UI failed', { requestId: request.id, error: errorText(error) })
      return
    }
    const expiry = setTimeout(() => {
      if (this.stopping) return
      const pending = this.takePendingApproval(key)
      if (!pending) return
      this.respondToCodex(pending.request, this.approvalTimeoutResult(pending))
      this.trackBackgroundWork(
        pending.message
          .edit({ content: `${pending.message.content}\n\n**Approval expired.**`, components: [] })
          .then(() => undefined)
          .catch(() => undefined),
        'approval expiry',
      )
    }, (this.config.approvalTimeoutMinutes ?? 10) * 60_000)
    expiry.unref()
    this.approvals.set(key, { request, channel, message, choices, timeout: expiry })
    this.registerPendingRequestControl(request, 'approval', key)
  }

  private approvalResult(request: ServerRequest, choice: 'once' | 'session' | 'decline'): JsonObject {
    const method = request.method
    if (method === 'item/permissions/requestApproval') {
      if (choice === 'decline' || !isRecord(request.params.permissions)) {
        return { permissions: {}, scope: 'turn' }
      }
      const granted: JsonObject = {}
      if (isRecord(request.params.permissions.network)) {
        granted.network = request.params.permissions.network
      }
      if (isRecord(request.params.permissions.fileSystem)) {
        granted.fileSystem = request.params.permissions.fileSystem
      }
      return { permissions: granted, scope: choice === 'session' ? 'session' : 'turn' }
    }
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
    if (legacy) {
      return { decision: choice === 'once' ? 'approved' : choice === 'session' ? 'approved_for_session' : 'denied' }
    }
    return { decision: choice === 'once' ? 'accept' : choice === 'session' ? 'acceptForSession' : 'decline' }
  }

  private mcpElicitationActionResult(
    pending: PendingMcpElicitation,
    action: string,
  ): { result: JsonObject; confirmation: string } | { error: string } {
    if (action === 'cancel') {
      return {
        result: { action: 'cancel', content: null, _meta: null },
        confirmation: 'Cancelled',
      }
    }
    if (action === 'decline') {
      if (pending.toolApproval) return { error: 'This tool approval can only be allowed or cancelled.' }
      return {
        result: { action: 'decline', content: null, _meta: null },
        confirmation: 'Declined',
      }
    }
    if (action === 'submit') {
      if (!pending.form || pending.form.fields.length === 0) return { error: 'Invalid form action.' }
      const validationError = validateMcpElicitationContent(pending.form, pending.content)
      if (validationError) return { error: validationError }
      return {
        result: {
          action: 'accept',
          content: structuredClone(pending.content),
          _meta: null,
        },
        confirmation: 'Submitted',
      }
    }
    if (action === 'accept') {
      if (pending.mode === 'form' && pending.form && pending.form.fields.length > 0) {
        return { error: 'Complete and submit the form instead.' }
      }
      return {
        result: { action: 'accept', content: null, _meta: null },
        confirmation: 'Accepted',
      }
    }
    if (action === 'session' || action === 'always') {
      if (
        pending.mode !== 'form' ||
        !pending.form ||
        pending.form.fields.length > 0 ||
        !mcpElicitationPersistModes(pending.request.params._meta).includes(action)
      ) return { error: 'This persistence option is unavailable.' }
      return {
        result: {
          action: 'accept',
          content: null,
          _meta: { persist: action },
        },
        confirmation: action === 'session' ? 'Accepted for this session' : 'Always accepted',
      }
    }
    return { error: 'Invalid MCP request action.' }
  }

  private async handleMcpElicitationButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
    if (interaction.customId.startsWith('mcp-elicit-field:')) {
      const [, key, indexText] = interaction.customId.split(':')
      const index = Number(indexText)
      if (!key || !Number.isInteger(index)) {
        await interaction.reply({ content: 'Invalid MCP form field.', ephemeral: true })
        return
      }
      await this.showMcpElicitationModal(interaction, key, index)
      return
    }
    const [, key, action] = interaction.customId.split(':')
    const pending = key ? this.pendingMcpElicitations.get(key) : undefined
    if (!key || !action || !pending || interaction.channelId !== pending.channel.id) {
      await interaction.reply({ content: 'This MCP request is no longer available.', ephemeral: true })
      return
    }
    if (action === 'open') {
      if (pending.mode !== 'url' || !pending.url) {
        await interaction.reply({ content: 'This MCP link is no longer available.', ephemeral: true })
        return
      }
      await interaction.reply({
        content: `Open this link: <${pending.url}>`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      })
      return
    }
    const preview = this.mcpElicitationActionResult(pending, action)
    if ('error' in preview) {
      await interaction.reply({ content: preview.error, ephemeral: true })
      return
    }
    await interaction.deferUpdate()
    await this.waitForMutationIngressReady()
    const current = this.pendingMcpElicitations.get(key)
    if (!current || interaction.channelId !== current.channel.id) {
      await interaction.followUp({ content: 'This MCP request is no longer available.', ephemeral: true })
        .catch(() => undefined)
      return
    }
    const resolution = this.mcpElicitationActionResult(current, action)
    if ('error' in resolution) {
      await interaction.followUp({ content: resolution.error, ephemeral: true }).catch(() => undefined)
      return
    }
    await this.resolvePendingMcpElicitation(
      key,
      resolution.result,
      `**${resolution.confirmation} by ${interaction.user}.**`,
    )
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (
      interaction.customId.startsWith('mcp-elicit-field:') ||
      interaction.customId.startsWith('mcp-elicit-action:')
    ) {
      await this.handleMcpElicitationButton(interaction)
      return
    }
    if (interaction.customId.startsWith('task:')) {
      if (!(await this.requireAccess(interaction))) return
      const [, action, taskId] = interaction.customId.split(':')
      if (!taskId || (action !== 'run' && action !== 'delete')) {
        await interaction.reply({ content: 'Invalid scheduled task action.', ephemeral: true })
        return
      }
      await interaction.deferReply({ ephemeral: true })
      await this.waitForMutationIngressReady()
      if (action === 'run') {
        if (!(await this.scheduler.runNow(taskId))) {
          await interaction.editReply(`Scheduled task \`${taskId}\` is no longer available.`)
          return
        }
        await interaction.editReply(`Ran scheduled task \`${taskId}\` now.`)
        return
      }
      const task = this.state.tasks[taskId]
      if (!task) {
        await interaction.editReply(`Scheduled task \`${taskId}\` is no longer available.`)
        return
      }
      if (task.status === 'running') {
        await this.scheduler.cancel(taskId)
        await interaction.editReply(
          `Cancelled scheduled task \`${taskId}\`. An occurrence already in progress may still finish.`,
        )
        return
      }
      if (task.status === 'scheduled') {
        await this.scheduler.cancel(taskId)
      }
      if (!(await this.scheduler.deleteTerminal(taskId))) {
        await interaction.editReply(`Scheduled task \`${taskId}\` changed state; refresh /tasks.`)
        return
      }
      await interaction.editReply(`Deleted scheduled task \`${taskId}\`.`)
      return
    }
    if (interaction.customId.startsWith('userinput-text:')) {
      if (!(await this.requireAccess(interaction))) return
      const [, key, indexText] = interaction.customId.split(':')
      if (!key) {
        await interaction.reply({ content: 'Question expired.' })
        return
      }
      await this.showUserInputModal(interaction, key, Number(indexText))
      return
    }
    if (interaction.customId.startsWith('action-tool:')) {
      if (!(await this.requireAccess(interaction))) return
      await this.waitForMutationIngressReady()
      const [, key, indexText] = interaction.customId.split(':')
      const index = Number(indexText)
      if (!key || !Number.isInteger(index)) {
        await interaction.reply({ content: 'Invalid action button.' })
        return
      }
      const pending = this.pendingActionButtons.get(key)
      const button = pending?.buttons[index]
      const currentSession = interaction.channelId
        ? this.state.sessions[interaction.channelId]
        : undefined
      if (
        !pending ||
        !button ||
        interaction.channelId !== pending.channel.id ||
        currentSession?.codexThreadId !== pending.threadId
      ) {
        await interaction.reply({ content: 'This action is no longer available.' })
        return
      }
      const claimed = this.takePendingActionButtons(key)
      if (!claimed) {
        await interaction.reply({ content: 'This action is no longer available.' })
        return
      }
      this.respondToCodex(
        claimed.request,
        actionButtonToolResult(`User clicked: ${button.label}`, true),
      )
      await interaction.update({
        content: `**Action Required**\n_Selected: ${button.label}_`,
        components: [],
      })
      return
    }
    if (!interaction.customId.startsWith('approve:')) return
    if (!(await this.requireAccess(interaction))) return
    await this.waitForMutationIngressReady()
    const [, key, rawChoice] = interaction.customId.split(':')
    const choiceIndex = Number(rawChoice)
    if (!key || !Number.isInteger(choiceIndex) || choiceIndex < 0) {
      await interaction.reply({ content: 'Invalid approval.' })
      return
    }
    const current = this.approvals.get(key)
    const choice = current?.choices[choiceIndex]
    if (!choice) {
      await interaction.reply({ content: 'Approval expired.' })
      return
    }
    const pending = this.takePendingApproval(key)
    if (!pending) {
      await interaction.reply({ content: 'Approval expired.' })
      return
    }
    this.respondToCodex(pending.request, choice.result)
    const content = `${pending.message.content}\n\n**${choice.confirmation} by ${interaction.user}.**`
    try {
      await interaction.update({ content, components: [] })
    } catch (error) {
      const edited = await pending.message.edit({ content, components: [] })
        .then(() => true, () => false)
      if (!edited) {
        const session = this.state.sessions[pending.channel.id]
        if (session) {
          await this.sendDurableDiscordOutput({
            channel: pending.channel,
            codexThreadId: session.codexThreadId,
            turnId: text(pending.request.params.turnId) || session.activeTurnId || `approval:${String(pending.request.id)}`,
            itemKey: `approval:${typeof pending.request.id}:${String(pending.request.id)}`,
            value: `Approval recorded: ${choice.confirmation} by ${escapeInlineMarkdown(interaction.user.displayName)}. The original control could not be updated.`,
            suppressNotifications: true,
            format: false,
          }).catch((noticeError: unknown) => {
            this.logVerbose('approval confirmation delivery deferred', {
              threadId: session.codexThreadId,
              error: errorText(noticeError),
            })
          })
        }
      }
      this.logVerbose('approval interaction update failed', {
        threadId: text(pending.request.params.threadId),
        error: errorText(error),
        fallbackEdited: edited,
      })
    }
  }
}
