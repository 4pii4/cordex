import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  ThreadAutoArchiveDuration,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message as DiscordMessage,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import {
  assertDirectory,
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
} from './channel-management.js'
import {
  CodexAppServer,
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
import { buildSlashCommands } from './discord-commands.js'
import {
  formatCompletedToolItem,
  formatAssistantText,
  formatModelBanner,
  formatModelLabel,
  formatRunFooter,
  formatShellCommandResult,
  splitMarkdownForDiscord,
} from './discord-output.js'
import { isUnknownDiscordChannelError } from './discord-errors.js'
import { formatThreadHistory } from './history.js'
import { editQueuedPrompt, parseQueueMessage } from './queue.js'
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
import { filterScheduledTasks, TaskScheduler } from './scheduler.js'
import {
  activeWorktreeSessions,
  createWorktree,
  mergeWorktree,
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
  CordexConfig,
  CordexState,
  JsonObject,
  QueuedPrompt,
  ReasoningEffort,
  ServerNotification,
  ServerRequest,
  SessionState,
  ScheduledTask,
  UserInput,
  VerbosityLevel,
} from './types.js'

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const actionButtonTtlMs = 24 * 60 * 60_000
const pendingContextUsageTtlMs = 5 * 60_000
const maxPendingContextUsage = 100

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeInlineMarkdown(value: string): string {
  return value.replace(/([*_~|`\\])/g, '\\$1')
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

async function sendCompleteBlock(channel: ThreadChannel, value: string): Promise<void> {
  const rendered = formatAssistantText(value)
  for (const chunk of splitMarkdownForDiscord(rendered, 1_900)) {
    await channel.send({ content: chunk, allowedMentions: { parse: [] } })
  }
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
  typingTimer: NodeJS.Timeout
  contextPercent?: number
}

type PendingApproval = {
  request: ServerRequest
  message: DiscordMessage
  userId?: string
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

export class CordexDiscordBot {
  readonly client: Client
  private readonly runs = new Map<string, ActiveRun>()
  private readonly contextUsageVersions = new Map<string, number>()
  private readonly contextReplayBlocked = new Set<string>()
  private readonly pendingContextUsage = new Map<string, {
    update: ContextUsageUpdate
    expiresAt: number
  }>()
  private readonly loadedThreads = new Set<string>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly pendingActionButtons = new Map<string, PendingActionButtons>()
  private readonly pendingUserInputs = new Map<string, PendingUserInput>()
  private readonly codexEventQueue = new KeyedSerialQueue()
  private readonly resumeQueue = new KeyedSerialQueue()
  private readonly mcpConfigQueue = new KeyedSerialQueue()
  private readonly projectMutationQueue = new KeyedSerialQueue()
  private readonly removingProjects = new Set<string>()
  private readonly projectCandidates = new Map<string, { directory: string; expiresAt: number }>()
  private readonly scheduler: TaskScheduler
  private modelCache: { expiresAt: number; models: CodexModel[] } | undefined

  constructor(
    private readonly config: CordexConfig,
    private readonly state: CordexState,
    private readonly codex: CodexAppServer,
    private readonly options: { verbose?: boolean } = {},
  ) {
    this.scheduler = new TaskScheduler(
      this.state.tasks,
      (task) => this.runScheduledTask(task),
      () => saveState(this.state),
    )
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message)
    })
    this.client.on(Events.MessageUpdate, (_oldMessage, message) => {
      void this.handleQueuedMessageUpdate(message)
    })
    this.client.on(Events.MessageDelete, (message) => {
      void this.handleQueuedMessageDelete(message.id)
    })
    this.client.on(Events.ChannelDelete, (channel) => {
      void this.handleChannelDelete(channel.id)
    })
    this.client.on(Events.ThreadDelete, (thread) => {
      void this.handleThreadDelete(thread.id)
    })
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) void this.handleAutocomplete(interaction)
      else if (interaction.isChatInputCommand()) void this.handleCommand(interaction)
      else if (interaction.isButton()) void this.handleButton(interaction)
      else if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('fork-subagent:')) {
          void this.handleForkSubagentSelect(interaction)
        } else {
          void this.handleUserInputSelect(interaction)
        }
      }
      else if (interaction.isModalSubmit()) void this.handleUserInputModal(interaction)
    })
    this.codex.on('notification', (notification: ServerNotification) => {
      this.logVerbose('notification', notification)
      void this.enqueueNotification(notification).catch((error: unknown) => {
        console.error(`Failed to handle Codex notification: ${errorText(error)}`)
      })
    })
    this.codex.on('serverRequest', (request: ServerRequest) => {
      this.logVerbose('server request', request)
      void this.enqueueServerRequest(request).catch((error: unknown) => {
        console.error(`Failed to handle Codex server request: ${errorText(error)}`)
      })
    })
    this.codex.on('protocolError', (error: Error) => console.error(error.message))
    this.codex.on('stderr', (chunk: string) => {
      if (this.options.verbose || /\b(error|panic|fatal)\b/i.test(chunk)) {
        console.error(`[codex stderr] ${chunk.trim()}`)
      }
    })
  }

  private logVerbose(label: string, value: unknown): void {
    if (!this.options.verbose) return
    console.error(`[cordex ${label}] ${JSON.stringify(value)}`)
  }

  async start(): Promise<void> {
    await this.registerCommands()
    await this.client.login(this.config.token)
    try {
      await withManagementLock(async () => {
        await this.refreshProjectsFromDisk()
        await this.pruneDeletedProjectMappings()
        await this.pruneOrphanedState()
        const guild = await this.client.guilds.fetch(this.config.guildId)
        const root = await ensureRootChannel({
          guild,
          config: this.config,
          ...(this.client.user?.username ? { botName: this.client.user.username } : {}),
        })
        if (root) {
          try {
            await saveManagedConfig(this.config)
          } catch (error) {
            if (root.created) {
              delete this.config.projects[root.textChannel.id]
              await root.textChannel.delete('Cordex root mapping could not be saved').catch(() => undefined)
            }
            throw error
          }
          if (root.created) {
            await this.sendRootWelcome(root.textChannel).catch((error: unknown) => {
              console.error(`Failed to send Cordex root welcome: ${errorText(error)}`)
            })
          }
        }
      })
    } catch (error) {
      throw new Error(`Cordex channel setup failed: ${errorText(error)}`, { cause: error })
    }
    this.scheduler.start()
  }

  async stop(): Promise<void> {
    this.scheduler.stop()
    for (const run of this.runs.values()) clearInterval(run.typingTimer)
    this.client.destroy()
    await this.codex.close()
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
        const channel = await this.client.channels.fetch(channelId)
        if (
          !channel ||
          !('guildId' in channel) ||
          channel.guildId !== this.config.guildId
        ) {
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
      if (mappedChannels.has(session.parentChannelId)) continue
      let parentExists = true
      try {
        parentExists = (await this.client.channels.fetch(session.parentChannelId)) !== null
      } catch (error) {
        if (isUnknownDiscordChannelError(error)) parentExists = false
        else continue
      }
      if (parentExists) continue
      await this.codex.archiveThread(session.codexThreadId).catch(() => undefined)
      this.loadedThreads.delete(session.codexThreadId)
      delete this.state.sessions[threadId]
      delete this.state.queues[threadId]
      for (const [taskId, task] of Object.entries(this.state.tasks)) {
        if (task.threadId !== threadId) continue
        this.scheduler.cancel(taskId)
        delete this.state.tasks[taskId]
      }
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
    if (await this.memberAllowed(interaction.user.id)) return true
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
    if (interaction.commandName === 'resume') {
      const parentId = this.parentChannelId(interaction.channel)
      const project = parentId ? this.config.projects[parentId] : undefined
      const threads = parentId && project
        ? await this.listProjectThreads(parentId, project.directory, query, 25).catch(() => [])
        : []
      await interaction.respond(
        threads.slice(0, 25).map((thread) => ({
          name: truncate(thread.name || thread.preview || thread.id, 100),
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

  private async listProjectThreads(
    parentChannelId: string,
    projectDirectory: string,
    searchTerm?: string,
    limit = 20,
  ) {
    const directories = new Set([
      path.resolve(projectDirectory),
      ...Object.values(this.state.sessions)
        .filter((session) => session.parentChannelId === parentChannelId)
        .map((session) => path.resolve(session.directory)),
    ])
    const threads = await this.codex.listThreads({
      ...(searchTerm ? { searchTerm } : {}),
      limit: 100,
    })
    const linked = new Set(Object.values(this.state.sessions).map((session) => session.codexThreadId))
    return threads
      .filter((thread) => directories.has(path.resolve(thread.cwd)))
      .filter((thread) => !linked.has(thread.id))
      .slice(0, limit)
  }

  private async listAllProjectThreads(limit = 20) {
    const directories = new Set([
      ...Object.values(this.config.projects).map((project) => path.resolve(project.directory)),
      ...Object.values(this.state.sessions).map((session) => path.resolve(session.directory)),
    ])
    if (directories.size === 0) return []
    const threads = await this.codex.listThreads({ limit: 100 })
    return threads.filter((thread) => directories.has(path.resolve(thread.cwd))).slice(0, limit)
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireAccess(interaction))) return
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
      else if (interaction.commandName === 'model') await this.handleModelCommand(interaction)
      else if (interaction.commandName === 'model-variant') await this.handleModelVariantCommand(interaction)
      else if (interaction.commandName === 'unset-model-override') await this.handleUnsetModelOverrideCommand(interaction)
      else if (interaction.commandName === 'mode') await this.handleModeCommand(interaction)
      else if (interaction.commandName === 'fast') await this.handleFastCommand(interaction)
      else if (interaction.commandName === 'yolo') await this.handleYoloCommand(interaction)
      else if (interaction.commandName === 'new-session') await this.handleNewSessionCommand(interaction)
      else if (interaction.commandName === 'resume') await this.handleResumeCommand(interaction)
      else if (interaction.commandName === 'fork') await this.handleForkCommand(interaction)
      else if (interaction.commandName === 'fork-subagent') await this.handleForkSubagentCommand(interaction)
      else if (interaction.commandName === 'btw') await this.handleBtwCommand(interaction)
      else if (interaction.commandName === 'compact') await this.handleCompactCommand(interaction)
      else if (interaction.commandName === 'goal') await this.handleGoalCommand(interaction)
      else if (interaction.commandName === 'clear-goal') await this.handleClearGoalCommand(interaction)
      else if (interaction.commandName === 'archive') await this.handleArchiveCommand(interaction)
      else if (interaction.commandName === 'review') await this.handleReviewCommand(interaction)
      else if (interaction.commandName === 'diff') await this.handleDiffCommand(interaction)
      else if (interaction.commandName === 'schedule') await this.handleScheduleCommand(interaction)
      else if (interaction.commandName === 'tasks') await this.handleTasksCommand(interaction)
      else if (interaction.commandName === 'cancel-task') await this.handleCancelTaskCommand(interaction)
      else if (interaction.commandName === 'skills') await this.handleSkillsCommand(interaction)
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
      else if (interaction.commandName === 'queue') await this.handleQueueCommand(interaction)
      else if (interaction.commandName === 'clear-queue') await this.handleClearQueueCommand(interaction)
      else if (interaction.commandName === 'run-shell-command') await this.handleShellCommand(interaction)
      else if (interaction.commandName === 'last-sessions') await this.handleLastSessionsCommand(interaction)
      else if (interaction.commandName === 'context-usage') await this.handleContextUsageCommand(interaction)
      else if (interaction.commandName === 'verbosity') await this.handleVerbosityCommand(interaction)
      else if (interaction.commandName === 'session-id') await this.handleSessionIdCommand(interaction)
      else if (interaction.commandName === 'abort') await this.handleAbortCommand(interaction)
      else if (interaction.commandName === 'status') await this.handleStatusCommand(interaction)
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
    if (interaction.deferred && !interaction.replied) await interaction.editReply(first)
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
      const archiveCodex = this.codex.archiveThread(session.codexThreadId)
      if (strict) await archiveCodex
      else await archiveCodex.catch(() => undefined)
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
    const sessions = archiveSessions
      ? await this.archiveProjectSessions(channelId, false)
      : Object.entries(this.state.sessions).filter(
          ([, session]) => session.parentChannelId === channelId,
        )
    if (!project && sessions.length === 0) return 0
    for (const [, session] of sessions) {
      this.loadedThreads.delete(session.codexThreadId)
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

  private async handleThreadDelete(threadId: string): Promise<void> {
    const session = this.state.sessions[threadId]
    if (!session) return
    await this.codex.archiveThread(session.codexThreadId).catch(() => undefined)
    this.loadedThreads.delete(session.codexThreadId)
    const run = this.runs.get(session.codexThreadId)
    if (run) clearInterval(run.typingTimer)
    this.runs.delete(session.codexThreadId)
    delete this.state.sessions[threadId]
    delete this.state.queues[threadId]
    for (const [taskId, task] of Object.entries(this.state.tasks)) {
      if (task.threadId !== threadId) continue
      this.scheduler.cancel(taskId)
      delete this.state.tasks[taskId]
    }
    await saveState(this.state)
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
          const blocker = projectRemovalBlocker(sessions, force)
          if (blocker) throw new Error(blocker)
          await this.archiveProjectSessions(channelId, true)
          const channel = await this.client.channels.fetch(channelId).catch((error: unknown) => {
            if (isUnknownDiscordChannelError(error)) return undefined
            throw error
          })
          if (channel) await channel.delete('Removed by /remove-project')
          await this.cleanupProjectMapping(channelId, false)
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
    await interaction.editReply(
      `Created project **${created.name}** at \`${created.directory}\`.\nChannel: <#${projectChannel.textChannel.id}>\nSession: ${thread}`,
    )
  }

  private runtimeWorkspaceRoots(session: SessionState): string[] | undefined {
    if (!session.workspaceRoots?.length) return undefined
    return [...new Set([path.resolve(session.directory), ...session.workspaceRoots.map((root) => path.resolve(root))])]
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
    const roots = new Set((session.workspaceRoots || []).map((root) => path.resolve(root)))
    roots.add(path.resolve(directory))
    session.workspaceRoots = [...roots]
    session.updatedAt = new Date().toISOString()
    await saveState(this.state)
    await interaction.reply({
      content: requested === '*'
        ? `All external directories allowed${session.activeTurnId ? ' beginning with the next turn' : ''}.`
        : `Allowed \`${directory}\`${session.activeTurnId ? ' beginning with the next turn' : ''}.`,
    })
  }

  private async handlePermissionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    const profile = interaction.options.getString('profile')?.trim()
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
        `${session ? `Current: \`${session.permissions || this.config.sandbox}\`\n` : ''}${lines.join('\n') || 'No permission profiles reported.'}`,
      )
      return
    }
    if (!session) throw new Error('Selecting a permission profile requires a Cordex thread')
    if (profile === 'default') {
      await this.codex.updateThreadSettings({ threadId: session.codexThreadId, permissions: null })
      delete session.permissions
      session.updatedAt = new Date().toISOString()
      await saveState(this.state)
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
    await this.codex.updateThreadSettings({ threadId: session.codexThreadId, permissions: profile })
    session.permissions = profile
    session.updatedAt = new Date().toISOString()
    await saveState(this.state)
    await interaction.editReply(`Permission profile: \`${profile}\`.`)
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
    if (scope === 'session') {
      if (!session) throw new Error('Session scope requires a Cordex thread')
      if (model) {
        session.model = model
        this.clearContextUsage(session, true)
      }
      if (effort) session.effort = effort
      session.updatedAt = new Date().toISOString()
    } else {
      if (model) this.state.channelModels[parentId] = model
      if (effort) this.state.channelEfforts[parentId] = effort
    }
    await saveState(this.state)
    const effectiveModel = model || session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default'
    const effectiveEffort = effort || session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default'
    await interaction.reply({
      content: `Model set for this ${scope}:\n**${formatModelLabel(effectiveModel, effectiveEffort)}**`,
    })
  }

  private async handleModelVariantCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Model variant requires a project channel')
    const effort = interaction.options.getString('effort', true) as ReasoningEffort
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    if (session) {
      session.effort = effort
      session.updatedAt = new Date().toISOString()
      await this.codex.updateThreadSettings({ threadId: session.codexThreadId, effort })
    } else {
      this.state.channelEfforts[parentId] = effort
    }
    await saveState(this.state)
    const model = session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default'
    await interaction.reply({
      content: `Model set for this ${session ? 'session' : 'channel'}:\n**${formatModelLabel(model, effort)}**`,
    })
  }

  private async handleUnsetModelOverrideCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Model override requires a project channel')
    const session = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]
      : undefined
    if (session) {
      const fallback = this.state.channelModels[parentId] || this.config.defaultModel
      if (fallback) session.model = fallback
      else delete session.model
      this.clearContextUsage(session, true)
      session.updatedAt = new Date().toISOString()
      await this.codex.updateThreadSettings({
        threadId: session.codexThreadId,
        model: fallback || null,
      })
      await saveState(this.state)
      await interaction.reply({
        content: `Session model override removed. Using **${formatModelLabel(fallback || 'Codex default', session.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default')}**.`,
      })
      return
    }
    delete this.state.channelModels[parentId]
    await saveState(this.state)
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
    session.mode = mode
    session.updatedAt = new Date().toISOString()
    await saveState(this.state)
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
    if (session) {
      session.fastMode = next
      session.updatedAt = new Date().toISOString()
      await this.codex.updateThreadSettings({
        threadId: session.codexThreadId,
        serviceTier: next ? 'fast' : null,
      })
    } else {
      this.state.channelFastMode[parentId] = next
    }
    await saveState(this.state)
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
      session.yoloMode = next
      session.updatedAt = new Date().toISOString()
      if (next) {
        if (session.permissions) {
          await this.codex.updateThreadSettings({ threadId: session.codexThreadId, permissions: null })
        }
        await this.codex.updateThreadSettings({
          threadId: session.codexThreadId,
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
    } else {
      this.state.channelYoloMode[parentId] = next
    }
    await saveState(this.state)
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
      name: truncate(options.name.replace(/\s+/g, ' ').trim() || 'Cordex session', 80),
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

  private async handleNewSessionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { parentChannelId, project } = this.requireProject(this.parentChannelId(interaction.channel))
    const prompt = interaction.options.getString('prompt', true)
    const requestedFiles = interaction.options.getString('files')
    const files = requestedFiles ? await resolveProjectFiles(project.directory, requestedFiles) : []
    await interaction.deferReply()
    const worktree = await this.createAutomaticWorktree(parentChannelId, prompt)
    let thread: ThreadChannel | undefined
    try {
      if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
      thread = await this.createSessionThread({
        parentChannelId,
        name: `${worktree ? '⬦ ' : ''}${prompt}`,
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
        worktree,
      )
      await interaction.editReply(
        `Session started: ${thread}${worktree ? `\nWorktree: \`${worktree.branch}\`` : ''}${files.length ? `\nFiles: ${files.map((file) => `\`${file}\``).join(', ')}` : ''}`,
      )
    } catch (error) {
      if (worktree && (!thread || !this.state.sessions[thread.id])) {
        await removeWorktree(worktree).catch(() => undefined)
      }
      if (thread && !this.state.sessions[thread.id]) {
        await thread.delete('Cordex session could not be started').catch(() => undefined)
      }
      throw error
    }
  }

  private async handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { parentChannelId, project } = this.requireProject(this.parentChannelId(interaction.channel))
    const codexThreadId = interaction.options.getString('session', true)
    await interaction.deferReply()
    await this.resumeQueue.run(codexThreadId, async () => {
      const knownEntry = Object.entries(this.state.sessions).find(
        ([, session]) => session.codexThreadId === codexThreadId,
      )
      const knownSession = knownEntry?.[1]
      if (knownEntry) {
        let existingChannel
        try {
          existingChannel = await this.client.channels.fetch(knownEntry[0])
        } catch (error) {
          if (!isUnknownDiscordChannelError(error)) throw error
        }
        if (existingChannel?.isThread()) {
          if (existingChannel.archived) await existingChannel.setArchived(false, 'Resume existing Cordex session')
          await existingChannel.members.add(interaction.user.id).catch(() => undefined)
          await interaction.editReply(`Session is already linked: ${existingChannel}`)
          return
        }
        delete this.state.sessions[knownEntry[0]]
        delete this.state.queues[knownEntry[0]]
        for (const [taskId, task] of Object.entries(this.state.tasks)) {
          if (task.threadId !== knownEntry[0]) continue
          this.scheduler.cancel(taskId)
          delete this.state.tasks[taskId]
        }
        await saveState(this.state)
      }
      const directory = knownSession?.directory || project.directory
      const model = this.state.channelModels[parentChannelId] || knownSession?.model || this.config.defaultModel
      const fastMode = knownSession?.fastMode ?? this.state.channelFastMode[parentChannelId]
      const yoloMode = knownSession?.yoloMode ?? this.state.channelYoloMode[parentChannelId] ?? false
      const runtimeRoots = knownSession ? this.runtimeWorkspaceRoots(knownSession) : undefined
      const resumed = await this.codex.resumeThread({
        threadId: codexThreadId,
        includeTurns: true,
        cwd: directory,
        ...(model ? { model } : {}),
        ...(fastMode !== undefined ? { serviceTier: fastMode ? 'fast' : null } : {}),
        ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
        ...(!yoloMode && knownSession?.permissions
          ? { permissions: knownSession.permissions }
          : { sandbox: yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
        approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
      })
      const modelTransition = model !== undefined && model !== resumed.model
      const thread = await this.createSessionThread({
        parentChannelId,
        name: `${knownSession?.worktree && !knownSession.worktree.merged ? '⬦ ' : ''}Resume: ${resumed.name || resumed.preview || codexThreadId.slice(0, 12)}`,
        userId: interaction.user.id,
      })
      const session = this.buildNewSessionState({
        discordThreadId: thread.id,
        parentChannelId,
        directory,
        codexThreadId,
        ...(model || resumed.model ? { model: model || resumed.model } : {}),
      })
      if (knownSession?.worktree) session.worktree = { ...knownSession.worktree }
      if (knownSession?.workspaceRoots) session.workspaceRoots = [...knownSession.workspaceRoots]
      if (knownSession?.permissions) session.permissions = knownSession.permissions
      if (fastMode !== undefined) session.fastMode = fastMode
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
      if (modelTransition) {
        this.contextReplayBlocked.add(codexThreadId)
        this.pendingContextUsage.delete(codexThreadId)
      } else {
        this.contextReplayBlocked.delete(codexThreadId)
      }
      this.state.sessions[thread.id] = session
      if (!modelTransition) this.hydratePendingContextUsage(session)
      this.loadedThreads.add(codexThreadId)
      await saveState(this.state)
      await thread.send(`Resumed Codex session \`${codexThreadId}\`.`)
      try {
        for (const historyChunk of formatThreadHistory(resumed.turns, {
          verbosity: this.state.channelVerbosity[parentChannelId] || defaultVerbosity,
        })) {
          await thread.send({ content: historyChunk, allowedMentions: { parse: [] } })
        }
      } catch (error) {
        await thread.send(`⨯ History replay failed: ${truncate(errorText(error), 1_800)}`).catch(() => undefined)
      }
      await interaction.editReply(`Session resumed: ${thread}`)
    })
  }

  private requireThreadSession(interaction: ChatInputCommandInteraction): {
    channel: ThreadChannel
    session: SessionState
  } {
    if (!interaction.channel?.isThread()) throw new Error('Command requires a Cordex thread')
    const session = this.state.sessions[interaction.channel.id]
    if (!session) throw new Error('Thread has no Cordex session')
    return { channel: interaction.channel, session }
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
    const forked = await this.codex.forkThread({
      threadId: options.sourceThreadId || options.source.codexThreadId,
      cwd: options.source.directory,
      ...(!isSubagentFork && options.source.model ? { model: options.source.model } : {}),
      ...(options.source.fastMode !== undefined
        ? { serviceTier: options.source.fastMode ? 'fast' : null }
        : {}),
      ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
      ...(!yoloMode && options.source.permissions
        ? { permissions: options.source.permissions }
        : { sandbox: yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
      approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
    })
    const modelTransition = !isSubagentFork && options.source.model !== undefined &&
      options.source.model !== forked.model
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
      ...(!isSubagentFork && options.source.effort ? { effort: options.source.effort } : {}),
      ...(!isSubagentFork && options.source.mode ? { mode: options.source.mode } : {}),
      ...(options.source.fastMode !== undefined ? { fastMode: options.source.fastMode } : {}),
      ...(options.source.yoloMode !== undefined ? { yoloMode: options.source.yoloMode } : {}),
      ...(options.source.workspaceRoots ? { workspaceRoots: [...options.source.workspaceRoots] } : {}),
      ...(options.source.permissions ? { permissions: options.source.permissions } : {}),
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
    return truncate(agent || subagent.prompt || `subagent ${subagent.threadId.slice(0, 8)}`, 100)
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
    const selected = (await this.codex.listSubagentThreads(session.codexThreadId))
      .find((subagent) => subagent.threadId === childThreadId)
    if (!selected) {
      await interaction.editReply('Selected subagent is no longer available.')
      return
    }
    const forked = await this.forkSession({
      source: session,
      sourceThreadId: selected.threadId,
      parentChannelId: session.parentChannelId,
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
    const status = (interaction.options.getString('status') || 'active') as 'active' | 'paused' | 'blocked' | 'complete'
    await interaction.deferReply()
    let goal
    if (objective) {
      goal = await this.codex.setThreadGoal(session.codexThreadId, objective, tokenBudget, status)
    } else if (tokenBudget !== undefined || interaction.options.getString('status')) {
      const existing = await this.codex.getThreadGoal(session.codexThreadId)
      if (!existing) throw new Error('No thread goal is set; provide an objective')
      goal = await this.codex.setThreadGoal(
        session.codexThreadId,
        existing.objective,
        tokenBudget ?? existing.tokenBudget,
        status,
      )
    } else {
      goal = await this.codex.getThreadGoal(session.codexThreadId)
    }
    await interaction.editReply(goal ? this.formatGoal(goal) : 'No thread goal is set.')
  }

  private async handleClearGoalCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    await interaction.deferReply()
    const cleared = await this.codex.clearThreadGoal(session.codexThreadId)
    await interaction.editReply(cleared ? 'Thread goal cleared.' : 'No thread goal was set.')
  }

  private async handleArchiveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    await interaction.deferReply()
    await this.codex.archiveThread(session.codexThreadId)
    delete this.state.sessions[channel.id]
    delete this.state.queues[channel.id]
    await saveState(this.state)
    await channel.setArchived(true, 'Archived by Cordex user')
    await interaction.editReply('Session archived.')
  }

  private async handleReviewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    const kind = interaction.options.getString('target') || 'uncommitted'
    let target: ReviewTarget
    if (kind === 'base') {
      const branch = interaction.options.getString('branch')
      if (!branch) throw new Error('Base review requires branch option')
      target = { type: 'baseBranch', branch }
    } else if (kind === 'custom') {
      const instructions = interaction.options.getString('instructions')
      if (!instructions) throw new Error('Custom review requires instructions option')
      target = { type: 'custom', instructions }
    } else {
      target = { type: 'uncommittedChanges' }
    }
    await interaction.deferReply()
    const review = await this.codex.startReview({
      threadId: session.codexThreadId,
      target,
      delivery: 'inline',
    })
    session.activeTurnId = review.turnId
    session.updatedAt = new Date().toISOString()
    this.startRun(session, channel)
    await saveState(this.state)
    await interaction.editReply(`Review started (${kind}).`)
  }

  private async handleRollbackCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    const turns = interaction.options.getInteger('turns', true)
    await interaction.deferReply()
    const contextVersion = this.contextUsageVersion(session.codexThreadId)
    await this.codex.rollbackThread(session.codexThreadId, turns)
    this.invalidateContextUsageUnlessUpdated(session, contextVersion)
    session.updatedAt = new Date().toISOString()
    await saveState(this.state)
    await interaction.editReply(`Removed ${turns} turn${turns === 1 ? '' : 's'} from Codex history. Files unchanged.`)
  }

  private async handleDiffCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await interaction.deferReply()
    const result = await runShellCommand({
      command: 'git diff HEAD --stat && git diff HEAD',
      cwd: directory,
      maxOutputBytes: 100_000,
    })
    const body = result.output || '(no changes)'
    await interaction.editReply(formatShellCommandResult({
      command: 'git diff HEAD',
      output: body,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      language: 'diff',
    }))
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
    await saveState(this.state)
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
    const lines = tasks.map(
      (task) => `\`${task.id}\` · **${task.status}** · <t:${Math.floor(Date.parse(task.runAt) / 1_000)}:R> · ${truncate(task.prompt, 120)}`,
    )
    await this.replyWithChunks(interaction, lines.join('\n') || 'No scheduled tasks.')
  }

  private async handleCancelTaskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getString('id', true)
    if (!this.scheduler.cancel(id)) throw new Error(`Unknown task: ${id}`)
    await interaction.reply({ content: `Cancelled \`${id}\`.` })
  }

  private async handleSkillsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    const project = this.requireProject(parentId).project
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await interaction.deferReply()
    const entries = await this.codex.listSkills(directory)
    const lines = entries.flatMap((entry) => {
      if (!Array.isArray(entry.skills)) return []
      return entry.skills.flatMap((skill) => {
        if (!isRecord(skill) || typeof skill.name !== 'string') return []
        const enabled = skill.enabled === false ? 'disabled' : 'enabled'
        const description = typeof skill.description === 'string' ? ` — ${truncate(skill.description, 110)}` : ''
        return [`• \`${skill.name}\` (${enabled})${description}`]
      })
    })
    await this.replyWithChunks(interaction, lines.join('\n') || 'No Codex skills found.')
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

  private async runScheduledTask(task: ScheduledTask): Promise<void> {
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
    const input: UserInput[] = [{ type: 'text', text: task.prompt, text_elements: [] }]
    if (session.activeTurnId) {
      await this.enqueuePrompt(channel.id, {
        id: task.id,
        authorId: task.createdBy,
        authorName: 'scheduled task',
        input,
        displayText: task.prompt,
        createdAt: new Date().toISOString(),
      })
      await channel.send(`» **scheduled task:** ${truncate(task.prompt, 1_700)}`)
      return
    }
    await this.dispatchInput(channel, session.parentChannelId, input, task.id)
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
      const forked = await this.codex.forkThread({
        threadId: session.codexThreadId,
        cwd: created.directory,
        ...(session.model ? { model: session.model } : {}),
        ...(session.fastMode !== undefined
          ? { serviceTier: session.fastMode ? 'fast' : null }
          : {}),
        ...(session.workspaceRoots?.length
          ? { runtimeWorkspaceRoots: [created.directory, ...session.workspaceRoots] }
          : {}),
        ...(!session.yoloMode && session.permissions
          ? { permissions: session.permissions }
          : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
        approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
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
        ...(session.effort ? { effort: session.effort } : {}),
        ...(session.mode ? { mode: session.mode } : {}),
        ...(session.fastMode !== undefined ? { fastMode: session.fastMode } : {}),
        ...(session.yoloMode !== undefined ? { yoloMode: session.yoloMode } : {}),
        ...(session.workspaceRoots ? { workspaceRoots: [...session.workspaceRoots] } : {}),
        ...(session.permissions ? { permissions: session.permissions } : {}),
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
    const enabled = !this.state.channelAutoWorktrees[parentChannelId]
    this.state.channelAutoWorktrees[parentChannelId] = enabled
    await saveState(this.state)
    await interaction.reply({
      content: `Automatic worktrees: **${enabled ? 'enabled' : 'disabled'}** for this project channel.`,
    })
  }

  private async handleWorktreesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessions = activeWorktreeSessions(Object.values(this.state.sessions))
    const lines = sessions.map((session) => {
      const worktree = session.worktree
      if (!worktree) return ''
      const project = this.config.projects[session.parentChannelId]
      return `• <#${session.discordThreadId}> — **${project?.name || path.basename(worktree.projectDirectory)}** — \`${worktree.branch}\`\n  \`${worktree.directory}\``
    })
    await this.replyWithChunks(interaction, lines.join('\n') || 'No active worktree sessions.')
  }

  private async handleMergeWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    if (session.activeTurnId) throw new Error('Wait for active turn or run /abort first')
    const worktree = session.worktree
    if (!worktree) throw new Error('Session is not associated with a worktree')
    if (worktree.merged) throw new Error('Worktree already merged')
    const targetBranch = interaction.options.getString('target-branch') || undefined
    await interaction.deferReply()
    const result = await mergeWorktree({
      projectDirectory: worktree.projectDirectory,
      worktreeDirectory: worktree.directory,
      branch: worktree.branch,
      ...(targetBranch ? { targetBranch } : {}),
    })
    if (result.status === 'conflict') {
      await interaction.editReply(
        `Rebase conflict against \`${result.targetBranch}\`. Asking Codex to resolve and finish rebase.`,
      )
      await this.dispatchInput(
        channel,
        session.parentChannelId,
        [
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
        ],
        interaction.id,
      )
      return
    }
    worktree.merged = true
    session.updatedAt = new Date().toISOString()
    await saveState(this.state)
    if (channel.name.startsWith('⬦ ')) await channel.setName(channel.name.slice(2)).catch(() => undefined)
    await interaction.editReply(
      `Merged \`${result.branch}\` into \`${result.targetBranch}\` @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'}).\nWorktree remains at detached HEAD.`,
    )
  }

  private queueFor(threadId: string): QueuedPrompt[] {
    return (this.state.queues[threadId] ??= [])
  }

  private async enqueuePrompt(threadId: string, prompt: QueuedPrompt): Promise<number> {
    const queue = this.queueFor(threadId)
    queue.push(prompt)
    await saveState(this.state)
    return queue.length
  }

  private async handleQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel, session } = this.requireThreadSession(interaction)
    const message = interaction.options.getString('message', true)
    const input: UserInput[] = [{ type: 'text', text: message, text_elements: [] }]
    if (!session.activeTurnId) {
      await this.dispatchInput(channel, session.parentChannelId, input, interaction.id)
      await interaction.reply({
        content: `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${truncate(message, 1_000)}`,
      })
      return
    }
    const position = await this.enqueuePrompt(channel.id, {
      id: interaction.id,
      authorId: interaction.user.id,
      authorName: interaction.user.displayName,
      input,
      displayText: message,
      createdAt: new Date().toISOString(),
    })
    await interaction.reply({ content: `Queued message (position ${position})` })
  }

  private async handleClearQueueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const { channel } = this.requireThreadSession(interaction)
    const queue = this.queueFor(channel.id)
    const position = interaction.options.getInteger('position')
    if (position !== null) {
      if (!queue[position - 1]) throw new Error(`No queued message at position ${position}`)
      queue.splice(position - 1, 1)
      await saveState(this.state)
      await interaction.reply({ content: `Cleared queued message ${position}.` })
      return
    }
    const count = queue.length
    queue.length = 0
    await saveState(this.state)
    await interaction.reply({ content: `Cleared ${count} queued message${count === 1 ? '' : 's'}.` })
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
    const directory = interaction.channel?.isThread()
      ? this.state.sessions[interaction.channel.id]?.directory || project.directory
      : project.directory
    await this.sendShellResult(interaction, interaction.options.getString('command', true), directory)
  }

  private async handleLastSessionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const threads = await this.listAllProjectThreads(20)
    const lines = threads.map(
      (thread, index) => `${index + 1}. **${truncate(thread.name || thread.preview || 'Untitled', 80)}**\n\`${thread.id}\` · \`${thread.cwd}\``,
    )
    await this.replyWithChunks(
      interaction,
      lines.join('\n') || 'No Codex sessions found.',
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
    this.state.channelVerbosity[parentId] = level
    await saveState(this.state)
    const description = level === 'tools_and_text'
      ? 'All output including tool executions and status messages'
      : level === 'text_and_essential_tools'
        ? 'Text + essential tools (edits, custom MCP). Hides read/search.'
        : 'Only text responses. Hides all tools and status messages.'
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
    const session = this.state.sessions[interaction.channel.id]
    if (!session?.activeTurnId) {
      await interaction.reply({ content: 'No active turn.' })
      return
    }
    await this.codex.interruptTurn(session.codexThreadId, session.activeTurnId)
    await this.cancelActionButtonsForChannel(
      interaction.channel.id,
      '_Turn aborted._',
      'Action button request cancelled because the turn was aborted.',
    )
    await interaction.reply('Abort requested.')
  }

  private async handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const parentId = this.parentChannelId(interaction.channel)
    if (!parentId) throw new Error('Status requires a project channel')
    const project = this.config.projects[parentId]
    const session = interaction.channel?.isThread() ? this.state.sessions[interaction.channel.id] : undefined
    const queued = interaction.channel?.isThread() ? this.queueFor(interaction.channel.id).length : 0
    await interaction.reply({
      content: [
        `Project: ${project ? `\`${project.directory}\`` : 'not configured'}`,
        `Session: ${session ? `\`${session.codexThreadId}\`` : 'none'}`,
        `Turn: ${session?.activeTurnId ? `active (\`${session.activeTurnId}\`)` : 'idle'}`,
        `Mode: ${session?.mode || 'default'}`,
        `Model: ${formatModelLabel(session?.model || this.state.channelModels[parentId] || this.config.defaultModel || 'Codex default', session?.effort || this.state.channelEfforts[parentId] || this.config.defaultEffort || 'default')}`,
        `Fast mode: ${(session?.fastMode ?? this.state.channelFastMode[parentId] ?? false) ? 'on' : 'off'}`,
        `YOLO mode: ${(session?.yoloMode ?? this.state.channelYoloMode[parentId] ?? false) ? 'on' : 'off'}`,
        `Auto worktrees: ${this.state.channelAutoWorktrees[parentId] ? 'enabled' : 'disabled'}`,
        `Extra roots: ${session?.workspaceRoots?.length || 0}`,
        `Permissions: ${session?.permissions || this.config.sandbox}`,
        `Verbosity: ${this.state.channelVerbosity[parentId] || defaultVerbosity}`,
        `Queue: ${queued}`,
      ].join('\n'),
      ephemeral: true,
    })
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
    try {
      if (message.content.startsWith('!')) {
        if (!this.config.allowShellCommands) {
          throw new Error('Direct shell commands are disabled by Cordex configuration')
        }
        const command = message.content.slice(1).trim()
        if (!command) return
        const project = this.config.projects[parentId]
        const directory = message.channel.isThread()
          ? this.state.sessions[message.channel.id]?.directory || project.directory
          : project.directory
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
        await this.processPrompt(message.channel, parentId, message)
        return
      }
      if (message.channel.type !== ChannelType.GuildText) return
      const name = truncate(message.content.replace(/\s+/g, ' ').trim() || 'Cordex session', 80)
      const worktree = await this.createAutomaticWorktree(parentId, name)
      let thread: ThreadChannel | undefined
      try {
        if (this.removingProjects.has(parentId)) throw new Error('Project is being removed')
        thread = await message.startThread({
          name: `${worktree ? '⬦ ' : ''}${name}`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Codex session',
        })
        await thread.members.add(message.author.id).catch(() => undefined)
        await this.processPrompt(thread, parentId, message, worktree)
      } catch (error) {
        if (worktree && (!thread || !this.state.sessions[thread.id])) {
          await removeWorktree(worktree).catch(() => undefined)
        }
        if (thread && !this.state.sessions[thread.id]) {
          await thread.delete('Cordex session could not be started').catch(() => undefined)
        }
        throw error
      }
    } catch (error) {
      const content = `⨯ ${truncate(errorText(error), 1_850)}`
      if (message.channel.isThread()) await message.channel.send(content).catch(() => undefined)
      else await message.reply(content).catch(() => undefined)
    }
  }

  private async buildInput(message: DiscordMessage, contentOverride?: string): Promise<UserInput[]> {
    let content = contentOverride ?? message.content
      .replace(new RegExp(`<@!?${this.client.user?.id ?? ''}>`, 'g'), '')
      .trim()
    const input: UserInput[] = []
    for (const attachment of message.attachments.values()) {
      const extension = path.extname(attachment.name || '').toLowerCase()
      if (attachment.contentType?.startsWith('image/') || imageExtensions.has(extension)) {
        input.push({ type: 'image', url: attachment.url })
      } else if ((attachment.size ?? 0) <= 1_000_000) {
        const attachmentText = await fetch(attachment.url).then((response) => {
          if (!response.ok) throw new Error(`Failed to read attachment ${attachment.name}`)
          return response.text()
        })
        content += `\n\nAttachment: ${attachment.name}\n\n${attachmentText}`
      }
    }
    if (content) input.unshift({ type: 'text', text: content, text_elements: [] })
    if (input.length === 0) throw new Error('Message has no prompt text or supported attachment')
    return input
  }

  private async processPrompt(
    channel: ThreadChannel,
    parentChannelId: string,
    message: DiscordMessage,
    initialWorktree?: CreatedWorktree,
  ): Promise<void> {
    await this.cancelActionButtonsForChannel(
      channel.id,
      '_Buttons dismissed._',
      'Action button request cancelled because the user sent another message.',
    )
    const parsed = parseQueueMessage(message.content)
    const queuedContent = parsed.queued ? parsed.text : undefined
    const input = await this.buildInput(message, queuedContent)
    const session = this.state.sessions[channel.id]
    if (queuedContent !== undefined && session?.activeTurnId) {
      const position = await this.enqueuePrompt(channel.id, {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.displayName,
        input,
        displayText: queuedContent || '(attachment)',
        createdAt: new Date().toISOString(),
        sourceMessageId: message.id,
      })
      await channel.send(`Queued message (position ${position})`)
      return
    }
    await this.dispatchInput(channel, parentChannelId, input, message.id, initialWorktree)
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
    initialWorktree?: CreatedWorktree,
  ): Promise<void> {
    await this.projectMutationQueue.run(`channel:${parentChannelId}`, async () => {
      await this.refreshProjectsSafely()
      if (this.removingProjects.has(parentChannelId)) throw new Error('Project is being removed')
      await this.dispatchInputUnlocked(
        channel,
        parentChannelId,
        input,
        clientUserMessageId,
        initialWorktree,
      )
    })
  }

  private async dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
    initialWorktree?: CreatedWorktree,
  ): Promise<void> {
    const project = this.config.projects[parentChannelId]
    if (!project) throw new Error('Project not configured')
    let session = this.state.sessions[channel.id]
    let createdSession = false
    if (!session) {
      const model = this.state.channelModels[parentChannelId] || this.config.defaultModel
      const fastMode = this.state.channelFastMode[parentChannelId]
      const yoloMode = this.state.channelYoloMode[parentChannelId] ?? false
      const directory = initialWorktree?.directory || project.directory
      const started = await this.codex.startThread({
        cwd: directory,
        ...(model ? { model } : {}),
        ...(fastMode !== undefined ? { serviceTier: fastMode ? 'fast' : null } : {}),
        dynamicTools: cordexDynamicTools,
        sandbox: yoloMode ? 'danger-full-access' : this.config.sandbox,
        approvalPolicy: yoloMode ? 'never' : this.config.approvalPolicy,
      })
      session = {
        discordThreadId: channel.id,
        parentChannelId,
        directory,
        codexThreadId: started.threadId,
        model: model || started.model,
        ...(this.state.channelEfforts[parentChannelId]
          ? { effort: this.state.channelEfforts[parentChannelId] }
          : this.config.defaultEffort
              ? { effort: this.config.defaultEffort }
              : {}),
        ...(fastMode !== undefined ? { fastMode } : {}),
        ...(Object.hasOwn(this.state.channelYoloMode, parentChannelId) ? { yoloMode } : {}),
        ...(initialWorktree
          ? {
              worktree: {
                projectDirectory: initialWorktree.projectDirectory,
                directory: initialWorktree.directory,
                branch: initialWorktree.branch,
              },
            }
          : {}),
        updatedAt: new Date().toISOString(),
      }
      this.state.sessions[channel.id] = session
      createdSession = true
      this.loadedThreads.add(session.codexThreadId)
      await this.codex.setThreadName(session.codexThreadId, channel.name).catch(() => undefined)
      await saveState(this.state)
    } else if (!this.loadedThreads.has(session.codexThreadId)) {
      const runtimeRoots = this.runtimeWorkspaceRoots(session)
      await this.codex.resumeThread({
        threadId: session.codexThreadId,
        cwd: session.directory,
        ...(session.model ? { model: session.model } : {}),
        ...(session.fastMode !== undefined
          ? { serviceTier: session.fastMode ? 'fast' : null }
          : {}),
        ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
        ...(!session.yoloMode && session.permissions
          ? { permissions: session.permissions }
          : { sandbox: session.yoloMode ? 'danger-full-access' as const : this.config.sandbox }),
        approvalPolicy: session.yoloMode ? 'never' : this.config.approvalPolicy,
      })
      this.loadedThreads.add(session.codexThreadId)
    }
    if (createdSession) {
      await channel.send(formatModelBanner(
        session.model || this.config.defaultModel || 'Codex default',
        session.effort || this.config.defaultEffort || 'default',
      ))
    }

    if (session.activeTurnId) {
      await this.codex.steerTurn({
        threadId: session.codexThreadId,
        expectedTurnId: session.activeTurnId,
        input,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      })
      return
    }
    await channel.sendTyping()
    const runtimeRoots = this.runtimeWorkspaceRoots(session)
    const turnId = await this.codex.startTurn({
      threadId: session.codexThreadId,
      input,
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      ...(session.fastMode !== undefined
        ? { serviceTier: session.fastMode ? 'fast' : null }
        : {}),
      ...(session.mode ? { mode: session.mode } : {}),
      ...(runtimeRoots ? { runtimeWorkspaceRoots: runtimeRoots } : {}),
      ...(!session.yoloMode && session.permissions ? { permissions: session.permissions } : {}),
      ...(session.yoloMode
        ? { sandbox: 'danger-full-access' as const, approvalPolicy: 'never' as const }
        : {}),
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    })
    session.activeTurnId = turnId
    session.updatedAt = new Date().toISOString()
    this.startRun(session, channel)
    await saveState(this.state)
  }

  private async handleQueuedMessageUpdate(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return
    for (const [threadId, queue] of Object.entries(this.state.queues)) {
      const queued = queue.find((item) => item.sourceMessageId === message.id)
      if (!queued) continue
      const edited = editQueuedPrompt(queued, message.content)
      if (!edited) {
        queue.splice(queue.indexOf(queued), 1)
      } else {
        queue[queue.indexOf(queued)] = edited
      }
      await saveState(this.state)
      await this.client.channels
        .fetch(threadId)
        .then((channel) => (channel?.isThread()
          ? channel.send(`Queue updated: ${truncate(edited?.displayText || 'removed', 1_700)}`)
          : undefined))
        .catch(() => undefined)
      return
    }
  }

  private async handleQueuedMessageDelete(messageId: string): Promise<void> {
    for (const queue of Object.values(this.state.queues)) {
      const index = queue.findIndex((item) => item.sourceMessageId === messageId)
      if (index === -1) continue
      queue.splice(index, 1)
      await saveState(this.state)
      return
    }
  }

  private startRun(session: SessionState, channel: ThreadChannel): ActiveRun {
    const existing = this.runs.get(session.codexThreadId)
    if (existing) return existing
    const typingTimer = setInterval(() => void channel.sendTyping().catch(() => undefined), 6_000)
    typingTimer.unref()
    const contextPercent = contextUsagePercent(session.contextTokens || 0, session.contextWindow)
    const run: ActiveRun = {
      session,
      channel,
      model: session.model || this.config.defaultModel || 'default',
      requestedModel: session.model || this.config.defaultModel || 'default',
      effort: session.effort || this.config.defaultEffort || 'default',
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      startedAt: Date.now(),
      agentText: new Map(),
      typingTimer,
      ...(session.contextTokens !== undefined && contextPercent !== undefined ? { contextPercent } : {}),
    }
    this.runs.set(session.codexThreadId, run)
    return run
  }

  private findRun(params: JsonObject): ActiveRun | undefined {
    const threadId = text(params.threadId) || text(params.conversationId)
    return threadId ? this.runs.get(threadId) : undefined
  }

  private codexEventKey(params: JsonObject): string {
    return text(params.threadId) || text(params.conversationId) || 'global'
  }

  private async enqueueNotification(notification: ServerNotification): Promise<void> {
    await this.codexEventQueue.run(
      this.codexEventKey(notification.params),
      () => this.handleNotification(notification),
    )
  }

  private async enqueueServerRequest(request: ServerRequest): Promise<void> {
    await this.codexEventQueue.run(
      this.codexEventKey(request.params),
      () => this.handleServerRequest(request),
    )
  }

  private async handleNotification(notification: ServerNotification): Promise<void> {
    if (notification.method === 'thread/tokenUsage/updated') {
      await this.onTokenUsage(notification.params)
      return
    }
    const run = this.findRun(notification.params)
    if (!run) return
    if (notification.method === 'item/started') await this.onItemStarted(run, notification.params)
    else if (notification.method === 'item/agentMessage/delta') this.onAgentDelta(run, notification.params)
    else if (notification.method === 'item/completed') await this.onItemCompleted(run, notification.params)
    else if (notification.method === 'model/rerouted') this.onModelRerouted(run, notification.params)
    else if (notification.method === 'error') await this.onTurnError(run, notification.params)
    else if (notification.method === 'turn/completed') await this.onTurnCompleted(run, notification.params)
  }

  private async onItemStarted(run: ActiveRun, params: JsonObject): Promise<void> {
    if (!isRecord(params.item)) return
    const item = params.item
    const itemId = text(item.id)
    if (!itemId) return
    if (item.type === 'agentMessage') {
      run.agentText.set(itemId, '')
    }
  }

  private onAgentDelta(run: ActiveRun, params: JsonObject): void {
    const itemId = text(params.itemId)
    const delta = text(params.delta)
    if (!itemId || delta === undefined) return
    const next = `${run.agentText.get(itemId) || ''}${delta}`
    run.agentText.set(itemId, next)
  }

  private async onItemCompleted(run: ActiveRun, params: JsonObject): Promise<void> {
    if (!isRecord(params.item)) return
    const item = params.item
    const itemId = text(item.id)
    if (!itemId) return
    if (item.type === 'agentMessage') {
      const finalText = text(item.text) || run.agentText.get(itemId) || ''
      run.agentText.delete(itemId)
      await sendCompleteBlock(run.channel, finalText)
    } else if (item.type === 'plan' && text(item.text)) {
      await sendCompleteBlock(run.channel, text(item.text) || '')
    } else {
      const tool = formatCompletedToolItem(item, this.verbosityFor(run.session))
      if (tool) await sendCompleteBlock(run.channel, tool)
    }
  }

  private onModelRerouted(run: ActiveRun, params: JsonObject): void {
    const threadId = text(params.threadId)
    const turnId = text(params.turnId)
    const fromModel = text(params.fromModel)
    const toModel = text(params.toModel)
    const reason = text(params.reason)
    const expectedTurnId = run.turnId || run.session.activeTurnId
    if (
      !threadId || !turnId || !fromModel || !toModel || !reason ||
      threadId !== run.session.codexThreadId || turnId !== expectedTurnId
    ) return
    run.model = toModel
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
    if (message) await run.channel.send(`⨯ ${truncate(message, 1_850)}`)
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

  private async onTurnCompleted(run: ActiveRun, params: JsonObject): Promise<void> {
    clearInterval(run.typingTimer)
    const turn = isRecord(params.turn) ? params.turn : {}
    const status = text(turn.status) || 'completed'
    const duration = typeof turn.durationMs === 'number' ? turn.durationMs : Date.now() - run.startedAt
    delete run.session.activeTurnId
    run.session.updatedAt = new Date().toISOString()
    await this.cancelActionButtonsForChannel(
      run.channel.id,
      '_Turn ended._',
      'Action button request cancelled because the turn ended.',
    )
    await saveState(this.state)
    this.runs.delete(run.session.codexThreadId)
    if (status === 'completed' && showStatusFooter(this.verbosityFor(run.session))) {
      await run.channel.send(await this.buildRunFooter(run, duration))
    }
    const queue = this.queueFor(run.channel.id)
    const next = queue.shift()
    await saveState(this.state)
    if (next) {
      await run.channel.send({
        content: `» **${escapeInlineMarkdown(next.authorName)}:** ${truncate(next.displayText, 1_700)}`,
        allowedMentions: { parse: [] },
      })
      await this.dispatchInput(run.channel, run.session.parentChannelId, next.input, next.sourceMessageId || next.id).catch(async (error: unknown) => {
        await run.channel.send(`⨯ Queued prompt failed: ${truncate(errorText(error), 1_700)}`).catch(() => undefined)
      })
    }
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
      this.codex.respond(request.id, { answers: {} })
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
    const autoResolutionMs = request.params.autoResolutionMs
    if (typeof autoResolutionMs === 'number' && autoResolutionMs > 0) {
      pending.timeout = setTimeout(() => {
        void this.finishUserInput(key, true)
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
    pending.answers[question.id] = [option.label]
    await interaction.deferUpdate()
    if (!question.isSecret) {
      await pending.channel.send({
        content: `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${option.label}`,
        allowedMentions: { parse: [] },
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
    pending.answers[question.id] = [answer]
    await interaction.deferUpdate()
    if (!question.isSecret) {
      await pending.channel.send({
        content: `» **${escapeInlineMarkdown(interaction.user.displayName)}:** ${answer}`,
        allowedMentions: { parse: [] },
      })
    }
    await this.finishUserInput(key)
  }

  private async finishUserInput(key: string, timedOut = false): Promise<void> {
    const pending = this.pendingUserInputs.get(key)
    if (!pending) return
    const complete = pending.questions.every((question) => pending.answers[question.id])
    if (!complete && !timedOut) return
    this.pendingUserInputs.delete(key)
    if (pending.timeout) clearTimeout(pending.timeout)
    const answers = Object.fromEntries(
      Object.entries(pending.answers).map(([questionId, values]) => [questionId, { answers: values }]),
    )
    this.codex.respond(pending.request.id, { answers })
    for (let index = 0; index < pending.messages.length; index++) {
      const message = pending.messages[index]
      const question = pending.questions[index]
      if (!message || !question) continue
      const answer = pending.answers[question.id]?.join(', ')
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

  private takePendingActionButtons(key: string): PendingActionButtons | undefined {
    const pending = this.pendingActionButtons.get(key)
    if (!pending) return undefined
    this.pendingActionButtons.delete(key)
    clearTimeout(pending.timeout)
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
      this.codex.respond(pending.request.id, actionButtonToolResult(resultText, success))
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
      this.codex.respond(
        request.id,
        actionButtonToolResult(`Unsupported Cordex dynamic tool: ${tool || 'unknown'}`, false),
      )
      return
    }
    const threadId = text(request.params.threadId)
    const channel = await this.resolveRunChannel(request)
    const session = channel ? this.state.sessions[channel.id] : undefined
    if (!threadId || !channel || !session || session.codexThreadId !== threadId) {
      this.codex.respond(
        request.id,
        actionButtonToolResult('Discord session is unavailable for action buttons.', false),
      )
      return
    }
    let buttons: ActionButtonOption[]
    try {
      buttons = parseActionButtons(request.params.arguments)
    } catch (error) {
      this.codex.respond(request.id, actionButtonToolResult(errorText(error), false))
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
      this.codex.respond(
        request.id,
        actionButtonToolResult(`Failed to show Discord action buttons: ${errorText(error)}`, false),
      )
      return
    }
    const timeout = setTimeout(() => {
      void this.finishPendingActionButtons(
        key,
        '_Expired._',
        'Action button request expired before the user selected an option.',
        false,
      )
    }, actionButtonTtlMs)
    timeout.unref()
    this.pendingActionButtons.set(key, { request, threadId, channel, buttons, message, timeout })
  }

  private async resolveRunChannel(request: ServerRequest): Promise<ThreadChannel | undefined> {
    const run = this.findRun(request.params)
    if (run) return run.channel
    const threadId = text(request.params.threadId) || text(request.params.conversationId)
    if (!threadId) return undefined
    const session = Object.values(this.state.sessions).find((candidate) => candidate.codexThreadId === threadId)
    if (!session) return undefined
    const channel = await this.client.channels.fetch(session.discordThreadId).catch(() => undefined)
    return channel?.isThread() ? channel : undefined
  }

  private approvalDescription(request: ServerRequest): string {
    const header = '⚠️ **Permission Required**'
    if (request.method === 'item/permissions/requestApproval') {
      const reason = text(request.params.reason)
      const permissions = isRecord(request.params.permissions)
        ? truncate(JSON.stringify(request.params.permissions, null, 2), 1_300)
        : 'Additional permissions'
      return `${header}\n**Type:** \`permissions\`${reason ? `\n**Reason:** ${truncate(reason, 400)}` : ''}\n\`\`\`json\n${permissions}\n\`\`\``
    }
    if (request.method.includes('commandExecution')) {
      return `${header}\n**Type:** \`command\`\n**Command:** ${discordInlineCode(truncate(text(request.params.command) || 'command', 1_400))}`
    }
    if (request.method === 'execCommandApproval' && Array.isArray(request.params.command)) {
      return `${header}\n**Type:** \`command\`\n**Command:** ${discordInlineCode(truncate(request.params.command.join(' '), 1_400))}`
    }
    const reason = text(request.params.reason)
    return `${header}\n**Type:** \`file_change\`${reason ? `\n**Reason:** ${truncate(reason, 1_500)}` : ''}`
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (request.method === 'currentTime/read') {
      this.codex.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      return
    }
    if (request.method === 'item/tool/requestUserInput') {
      await this.handleUserInputRequest(request)
      return
    }
    if (request.method === 'item/tool/call') {
      await this.handleActionButtonsRequest(request)
      return
    }
    if (request.method === 'mcpServer/elicitation/request') {
      this.codex.respond(request.id, { action: 'decline', content: null, _meta: null })
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
      this.codex.respond(request.id, { error: `Unsupported Cordex request: ${request.method}` })
      return
    }
    const channel = await this.resolveRunChannel(request)
    if (!channel) {
      this.codex.respond(request.id, this.approvalResult(request, 'decline'))
      return
    }
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`approve:${key}:once`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`approve:${key}:session`).setLabel('Accept Always').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`approve:${key}:decline`).setLabel('Deny').setStyle(ButtonStyle.Secondary),
    )
    const message = await channel.send({ content: this.approvalDescription(request), components: [row] })
    this.approvals.set(key, { request, message })
    const expiry = setTimeout(() => {
      const pending = this.approvals.get(key)
      if (!pending) return
      this.approvals.delete(key)
      this.codex.respond(request.id, this.approvalResult(request, 'decline'))
      void pending.message
        .edit({ content: `${pending.message.content}\n\n**Approval expired.**`, components: [] })
        .catch(() => undefined)
    }, 10 * 60_000)
    expiry.unref()
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

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
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
      this.codex.respond(
        claimed.request.id,
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
    const [, key, rawChoice] = interaction.customId.split(':')
    if (!key || !['once', 'session', 'decline'].includes(rawChoice || '')) {
      await interaction.reply({ content: 'Invalid approval.' })
      return
    }
    const pending = this.approvals.get(key)
    if (!pending) {
      await interaction.reply({ content: 'Approval expired.' })
      return
    }
    this.approvals.delete(key)
    const choice = rawChoice as 'once' | 'session' | 'decline'
    this.codex.respond(pending.request.id, this.approvalResult(pending.request, choice))
    await interaction.update({
      content: `${pending.message.content}\n\n**${choice === 'decline' ? 'Declined' : 'Approved'} by ${interaction.user}.**`,
      components: [],
    })
  }
}
