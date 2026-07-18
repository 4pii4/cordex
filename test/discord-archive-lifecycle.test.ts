import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ThreadChannel,
} from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { loadState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CodexThreadSummary,
  CordexConfig,
  CordexState,
  ServerNotification,
  SessionState,
} from '../src/types.js'

type InternalBot = {
  loadedThreads: Set<string>
  pendingTurnStarts: Set<string>
  archivingDiscordThreads: Set<string>
  handleArchiveCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>
  reconcileSessionLifecycleIntents(): Promise<void>
  memberAllowed(userId: string): Promise<boolean>
  refreshProjectsSafely(): Promise<void>
}

class ArchiveCodex extends EventEmitter {
  readonly calls: string[] = []
  goalStatus: string | null = 'paused'
  persistedDuringArchive: SessionState | undefined

  async getThreadGoal(threadId: string) {
    this.calls.push(`goal:${threadId}`)
    return this.goalStatus
      ? {
          threadId,
          objective: 'Archive fixture goal',
          status: this.goalStatus,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        }
      : null
  }

  async archiveThread(threadId: string): Promise<void> {
    this.calls.push(`archive:${threadId}`)
    this.persistedDuringArchive = Object.values((await loadState()).sessions).find(
      (session) => session.codexThreadId === threadId,
    )
  }
}

class ResumeCodex extends EventEmitter {
  readonly calls: string[] = []
  resumeOptions: Record<string, unknown> | undefined
  persistedDuringUnarchive: SessionState | undefined

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    this.calls.push(`unarchive:${threadId}`)
    this.persistedDuringUnarchive = Object.values((await loadState()).sessions).find(
      (session) => session.codexThreadId === threadId,
    )
    return {
      id: threadId,
      preview: 'Archived fixture',
      cwd: '/unused',
      updatedAt: 1,
    }
  }

  async resumeThread(options: Record<string, unknown>) {
    this.calls.push(`resume:${String(options.threadId)}`)
    this.resumeOptions = options
    return { model: 'session-model', turns: [] }
  }

  async updateThreadSettings(): Promise<void> {}
}

class ReconciliationCodex extends EventEmitter {
  readonly calls: string[] = []

  constructor(
    private readonly active: CodexThreadSummary[],
    private readonly archived: CodexThreadSummary[],
  ) {
    super()
  }

  async listAllThreads(options: { archived?: boolean } = {}): Promise<CodexThreadSummary[]> {
    this.calls.push(`list:${options.archived ? 'archived' : 'active'}`)
    return options.archived ? [...this.archived] : [...this.active]
  }

  async archiveThread(threadId: string): Promise<void> {
    this.calls.push(`archive:${threadId}`)
    const index = this.active.findIndex((thread) => thread.id === threadId)
    if (index >= 0) this.archived.push(...this.active.splice(index, 1))
  }

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    this.calls.push(`unarchive:${threadId}`)
    const index = this.archived.findIndex((thread) => thread.id === threadId)
    const thread = index >= 0 ? this.archived.splice(index, 1)[0] : undefined
    if (!thread) throw new Error(`Archived fixture ${threadId} is missing`)
    this.active.push(thread)
    return thread
  }

  async resumeThread(options: Record<string, unknown>) {
    this.calls.push(`resume:${String(options.threadId)}`)
    return {
      model: 'session-model',
      effort: 'high' as const,
      serviceTier: 'fast',
      turns: [],
    }
  }

  async updateThreadSettings(): Promise<void> {}
}

class NotificationCodex extends EventEmitter {}

class AutocompleteCodex extends EventEmitter {
  readonly calls: Array<{ archived?: boolean; searchTerm?: string; limit?: number }> = []

  constructor(
    private readonly active: CodexThreadSummary[],
    private readonly archived: CodexThreadSummary[],
  ) {
    super()
  }

  async listThreads(options: { archived?: boolean; searchTerm?: string; limit?: number }) {
    this.calls.push({ ...options })
    return options.archived ? this.archived : this.active
  }
}

function makeConfig(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    defaultModel: 'default-model',
    defaultEffort: 'xhigh',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory } },
  }
}

function makeState(sessions: SessionState[]): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: Object.fromEntries(sessions.map((session) => [session.discordThreadId, session])),
    queues: {},
    tasks: {},
  }
}

function makeSession(
  directory: string,
  options: {
    discordThreadId?: string
    codexThreadId?: string
    archived?: boolean
    updatedAt?: string
  } = {},
): SessionState {
  return {
    discordThreadId: options.discordThreadId || 'discord-thread',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: options.codexThreadId || 'codex-thread',
    model: 'session-model',
    effort: 'high',
    fastMode: true,
    yoloMode: false,
    mode: 'plan',
    workspaceRoots: [path.join(directory, 'extra-root')],
    permissions: ':workspace-write',
    worktree: {
      projectDirectory: path.dirname(directory),
      directory,
      branch: 'codex/archive-fixture',
    },
    ...(options.archived ? { archived: true } : {}),
    contextTokens: 321,
    contextWindow: 4_096,
    updatedAt: options.updatedAt || new Date(0).toISOString(),
  }
}

function makeThreadChannel(
  id: string,
  options: { archived?: boolean; name?: string; setArchivedError?: Error } = {},
): ThreadChannel & {
  archiveCalls: boolean[]
  memberAdds: string[]
  sent: string[]
  setArchivedError?: Error
} {
  const channel = {
    id,
    name: options.name || id,
    parentId: 'parent-1',
    guildId: 'guild-1',
    archived: options.archived === true,
    archiveCalls: [] as boolean[],
    memberAdds: [] as string[],
    sent: [] as string[],
    ...(options.setArchivedError ? { setArchivedError: options.setArchivedError } : {}),
    isThread: () => true,
    toString: () => `<#${id}>`,
    members: {
      async add(userId: string) {
        channel.memberAdds.push(userId)
      },
    },
    async setArchived(value: boolean) {
      channel.archiveCalls.push(value)
      if (channel.setArchivedError) throw channel.setArchivedError
      channel.archived = value
      return channel
    },
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      channel.sent.push(content)
      return { content, async edit() { return this } }
    },
    async sendTyping() {},
  }
  return channel as unknown as ReturnType<typeof makeThreadChannel>
}

function archiveInteraction(channel: ThreadChannel): ChatInputCommandInteraction {
  return {
    channel,
    async deferReply() {},
    async editReply() {},
  } as unknown as ChatInputCommandInteraction
}

function resumeInteraction(
  codexThreadId: string,
  replies: string[],
): ChatInputCommandInteraction {
  return {
    channel: { id: 'parent-1', isThread: () => false },
    user: { id: 'resume-user' },
    options: {
      getString(name: string) {
        return name === 'session' ? codexThreadId : null
      },
    },
    async deferReply() {},
    async editReply(value: string) {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withTemporaryHome(run: (directory: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-archive-home-'))
  const project = await mkdtemp(path.join(tmpdir(), 'cordex-archive-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  try {
    await run(project)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
}

async function withFailingStateHome(
  run: (project: string, homePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-failing-state-root-'))
  const project = await mkdtemp(path.join(tmpdir(), 'cordex-failing-state-project-'))
  const homePath = path.join(root, 'home-as-file')
  await writeFile(homePath, 'not a directory')
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = homePath
  try {
    await run(project, homePath)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(root, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
}

test('archive preserves the full session and clears its loaded runtime marker', async () => {
  await withTemporaryHome(async (project) => {
    const directory = path.join(project, 'worktree')
    const session = makeSession(directory)
    const original = structuredClone(session)
    const state = makeState([session])
    const codex = new ArchiveCodex()
    const channel = makeThreadChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)

    try {
      await internal.handleArchiveCommand(archiveInteraction(channel))

      assert.strictEqual(state.sessions[channel.id], session)
      const { archived, updatedAt, ...preserved } = session
      const { updatedAt: _originalUpdatedAt, ...expected } = original
      assert.deepEqual(preserved, expected)
      assert.equal(archived, true)
      assert.notEqual(updatedAt, original.updatedAt)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.deepEqual(codex.calls, [
        `goal:${session.codexThreadId}`,
        `archive:${session.codexThreadId}`,
      ])
      assert.equal(codex.persistedDuringArchive?.archived, true)
      assert.equal(codex.persistedDuringArchive?.lifecycleIntent?.kind, 'archive')
      assert.equal(
        typeof codex.persistedDuringArchive?.lifecycleIntent?.requestedAt,
        'string',
      )
      assert.equal(session.lifecycleIntent, undefined)
      assert.deepEqual(channel.archiveCalls, [true])
    } finally {
      bot.client.destroy()
    }
  })
})

test('archive keeps its lifecycle intent when the final Discord archive fails', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    const state = makeState([session])
    const codex = new ArchiveCodex()
    const channel = makeThreadChannel(session.discordThreadId, {
      setArchivedError: new Error('Discord archive unavailable'),
    })
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)

    try {
      await assert.rejects(
        internal.handleArchiveCommand(archiveInteraction(channel)),
        /Discord archive unavailable/,
      )
      assert.equal(session.archived, true)
      assert.equal(session.lifecycleIntent?.kind, 'archive')
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.deepEqual(channel.archiveCalls, [true])
      assert.deepEqual(codex.calls, [
        `goal:${session.codexThreadId}`,
        `archive:${session.codexThreadId}`,
      ])
      assert.equal(
        (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent?.kind,
        'archive',
      )
    } finally {
      bot.client.destroy()
    }
  })
})

test('already archived command state also keeps an intent until Discord converges', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'), { archived: true })
    const state = makeState([session])
    const codex = new ArchiveCodex()
    const channel = makeThreadChannel(session.discordThreadId, {
      setArchivedError: new Error('Discord archive unavailable'),
    })
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot

    try {
      await assert.rejects(
        internal.handleArchiveCommand(archiveInteraction(channel)),
        /Discord archive unavailable/,
      )
      assert.equal(session.archived, true)
      assert.equal(session.lifecycleIntent?.kind, 'archive')
      assert.deepEqual(codex.calls, [])
      assert.deepEqual(channel.archiveCalls, [true])
      assert.equal(
        (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent?.kind,
        'archive',
      )
    } finally {
      bot.client.destroy()
    }
  })
})

test('archive does not call the non-idempotent RPC until archive intent is durable', async () => {
  await withFailingStateHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    const state = makeState([session])
    const codex = new ArchiveCodex()
    const channel = makeThreadChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)

    try {
      await assert.rejects(internal.handleArchiveCommand(archiveInteraction(channel)))
      assert.equal(session.archived, undefined)
      assert.equal(codex.calls.some((call) => call.startsWith('archive:')), false)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
      assert.deepEqual(channel.archiveCalls, [])
    } finally {
      bot.client.destroy()
    }
  })
})

test('archive rejects active goals, pending deliveries, queued prompts, scheduled tasks, and pending starts', async (t) => {
  const cases: Array<{
    name: string
    expected: RegExp
    configure(state: CordexState, codex: ArchiveCodex, internal: InternalBot, session: SessionState): void
  }> = [
    {
      name: 'active goal',
      expected: /active goal/i,
      configure(_state, codex) {
        codex.goalStatus = 'active'
      },
    },
    {
      name: 'queued prompt',
      expected: /clear queued prompts/i,
      configure(state, _codex, _internal, session) {
        state.queues[session.discordThreadId] = [{
          id: 'queued-1',
          authorId: 'user-1',
          authorName: 'Queue User',
          input: [{ type: 'text', text: 'Queued work', text_elements: [] }],
          displayText: 'Queued work',
          createdAt: new Date(0).toISOString(),
        }]
      },
    },
    {
      name: 'pending direct delivery',
      expected: /pending prompt delivery or recovery/i,
      configure(state, _codex, _internal, session) {
        state.queues[session.discordThreadId] = [{
          id: 'direct-1',
          authorId: 'user-1',
          authorName: 'Direct User',
          input: [{ type: 'text', text: 'Accepted work', text_elements: [] }],
          displayText: 'Accepted work',
          createdAt: new Date(0).toISOString(),
          deliveryKind: 'direct',
        }]
      },
    },
    {
      name: 'scheduled task',
      expected: /cancel scheduled task task-1/i,
      configure(state, _codex, _internal, session) {
        state.tasks['task-1'] = {
          id: 'task-1',
          threadId: session.discordThreadId,
          prompt: 'Scheduled work',
          runAt: new Date(Date.now() + 60_000).toISOString(),
          createdBy: 'user-1',
          status: 'scheduled',
        }
      },
    },
    {
      name: 'pending turn start',
      expected: /pending turn start/i,
      configure(_state, _codex, internal, session) {
        internal.pendingTurnStarts.add(session.codexThreadId)
      },
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withTemporaryHome(async (project) => {
        const session = makeSession(path.join(project, 'worktree'))
        const state = makeState([session])
        const codex = new ArchiveCodex()
        const channel = makeThreadChannel(session.discordThreadId)
        const bot = new CordexDiscordBot(
          makeConfig(project),
          state,
          codex as unknown as CodexAppServer,
        )
        const internal = bot as unknown as InternalBot
        internal.loadedThreads.add(session.codexThreadId)
        fixture.configure(state, codex, internal, session)

        try {
          await assert.rejects(
            internal.handleArchiveCommand(archiveInteraction(channel)),
            fixture.expected,
          )
          assert.equal(session.archived, undefined)
          assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
          assert.equal(codex.calls.some((call) => call.startsWith('archive:')), false)
          assert.deepEqual(channel.archiveCalls, [])
          assert.equal(internal.archivingDiscordThreads.has(channel.id), false)
        } finally {
          bot.client.destroy()
        }
      })
    })
  }
})

test('known archived resume unarchives then resumes and reuses the retained Discord session', async () => {
  await withTemporaryHome(async (project) => {
    const directory = path.join(project, 'retained-worktree')
    const session = makeSession(directory, { archived: true })
    const retained = structuredClone(session)
    const state = makeState([session])
    const codex = new ResumeCodex()
    const channel = makeThreadChannel(session.discordThreadId, { archived: true })
    const replies: string[] = []
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch = async () => channel

    try {
      await internal.handleResumeCommand(resumeInteraction(session.codexThreadId, replies))

      assert.deepEqual(codex.calls, [
        `unarchive:${session.codexThreadId}`,
        `resume:${session.codexThreadId}`,
      ])
      assert.deepEqual(codex.resumeOptions, {
        threadId: session.codexThreadId,
        includeTurns: true,
        cwd: directory,
        model: retained.model,
        serviceTier: 'fast',
        runtimeWorkspaceRoots: [directory, ...(retained.workspaceRoots || [])],
        permissions: retained.permissions,
        approvalPolicy: 'never',
      })
      assert.equal(codex.persistedDuringUnarchive?.archived, true)
      assert.equal(codex.persistedDuringUnarchive?.lifecycleIntent?.kind, 'resume')
      assert.equal(
        typeof codex.persistedDuringUnarchive?.lifecycleIntent?.requestedAt,
        'string',
      )
      assert.strictEqual(state.sessions[channel.id], session)
      assert.equal(Object.keys(state.sessions).length, 1)
      assert.equal(session.archived, undefined)
      assert.equal(session.lifecycleIntent, undefined)
      assert.equal(session.directory, retained.directory)
      assert.equal(session.effort, retained.effort)
      assert.equal(session.mode, retained.mode)
      assert.deepEqual(session.worktree, retained.worktree)
      assert.deepEqual(session.workspaceRoots, retained.workspaceRoots)
      assert.equal(session.permissions, retained.permissions)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
      assert.deepEqual(channel.archiveCalls, [false])
      assert.deepEqual(channel.memberAdds, ['resume-user'])
      assert.deepEqual(replies, [`Session resumed: ${channel}`])
    } finally {
      bot.client.destroy()
    }
  })
})

test('resume keeps its lifecycle intent until Discord unarchives and clears it on retry', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'retained-worktree'), { archived: true })
    const state = makeState([session])
    const codex = new ResumeCodex()
    const channel = makeThreadChannel(session.discordThreadId, {
      archived: true,
      setArchivedError: new Error('Discord unarchive unavailable'),
    })
    const replies: string[] = []
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async () => channel

    try {
      await assert.rejects(
        internal.handleResumeCommand(resumeInteraction(session.codexThreadId, replies)),
        /Discord unarchive unavailable/,
      )
      assert.equal(session.archived, undefined)
      assert.equal(session.lifecycleIntent?.kind, 'resume')
      assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
      assert.deepEqual(channel.archiveCalls, [false])
      assert.equal(
        (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent?.kind,
        'resume',
      )

      delete channel.setArchivedError
      await internal.handleResumeCommand(resumeInteraction(session.codexThreadId, replies))

      assert.equal(session.lifecycleIntent, undefined)
      assert.deepEqual(channel.archiveCalls, [false, false])
      assert.deepEqual(codex.calls, [
        `unarchive:${session.codexThreadId}`,
        `resume:${session.codexThreadId}`,
      ])
      assert.equal((await loadState()).sessions[session.discordThreadId]?.lifecycleIntent, undefined)
    } finally {
      bot.client.destroy()
    }
  })
})

test('resume persists its intent before RPC, rolls back on save failure, and retries', async () => {
  await withFailingStateHome(async (project, homePath) => {
    const session = makeSession(path.join(project, 'retained-worktree'), { archived: true })
    const retained = structuredClone(session)
    const state = makeState([session])
    const codex = new ResumeCodex()
    const channel = makeThreadChannel(session.discordThreadId, { archived: true })
    const replies: string[] = []
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch = async () => channel

    try {
      await assert.rejects(
        internal.handleResumeCommand(resumeInteraction(session.codexThreadId, replies)),
      )
      assert.deepEqual(session, retained)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.deepEqual(codex.calls, [])
      assert.deepEqual(channel.archiveCalls, [])

      await rm(homePath, { force: true })
      await mkdir(homePath)
      await internal.handleResumeCommand(resumeInteraction(session.codexThreadId, replies))

      assert.equal(session.archived, undefined)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
      assert.deepEqual(channel.archiveCalls, [false])
      assert.equal((await loadState()).sessions[channel.id]?.archived, undefined)
    } finally {
      bot.client.destroy()
    }
  })
})

test('startup reconciliation completes archive intents on either side of the RPC crash window', async (t) => {
  for (const remoteState of ['active', 'archived'] as const) {
    await t.test(remoteState, async () => {
      await withTemporaryHome(async (project) => {
        const session = makeSession(path.join(project, 'worktree'))
        session.archived = true
        session.lifecycleIntent = {
          kind: 'archive',
          requestedAt: '2026-07-19T01:02:03.004Z',
        }
        const retained = structuredClone(session)
        const state = makeState([session])
        state.queues[session.discordThreadId] = [{
          id: 'retained-queue',
          authorId: 'user-1',
          authorName: 'Queue User',
          input: [{ type: 'text', text: 'Retained work', text_elements: [] }],
          displayText: 'Retained work',
          createdAt: new Date(0).toISOString(),
        }]
        const summary: CodexThreadSummary = {
          id: session.codexThreadId,
          preview: 'Archive crash fixture',
          cwd: session.directory,
          updatedAt: 1,
        }
        const codex = new ReconciliationCodex(
          remoteState === 'active' ? [summary] : [],
          remoteState === 'archived' ? [summary] : [],
        )
        const channel = makeThreadChannel(session.discordThreadId)
        const bot = new CordexDiscordBot(
          makeConfig(project),
          state,
          codex as unknown as CodexAppServer,
        )
        const internal = bot as unknown as InternalBot
        internal.loadedThreads.add(session.codexThreadId)
        ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
          async () => channel

        try {
          await internal.reconcileSessionLifecycleIntents()

          assert.deepEqual(codex.calls, [
            'list:active',
            'list:archived',
            ...(remoteState === 'active' ? [`archive:${session.codexThreadId}`] : []),
          ])
          assert.equal(session.archived, true)
          assert.equal(session.lifecycleIntent, undefined)
          assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
          assert.deepEqual(session.worktree, retained.worktree)
          assert.deepEqual(session.workspaceRoots, retained.workspaceRoots)
          assert.equal(session.permissions, retained.permissions)
          assert.equal(session.contextTokens, retained.contextTokens)
          assert.deepEqual(state.queues[session.discordThreadId], [{
            id: 'retained-queue',
            authorId: 'user-1',
            authorName: 'Queue User',
            input: [{ type: 'text', text: 'Retained work', text_elements: [] }],
            displayText: 'Retained work',
            createdAt: new Date(0).toISOString(),
          }])
          assert.deepEqual(channel.archiveCalls, [true])
          assert.equal((await loadState()).sessions[session.discordThreadId]?.lifecycleIntent, undefined)
        } finally {
          bot.client.destroy()
        }
      })
    })
  }
})

test('startup reconciliation completes resume intents on either side of the unarchive crash window', async (t) => {
  for (const remoteState of ['archived', 'active'] as const) {
    await t.test(remoteState, async () => {
      await withTemporaryHome(async (project) => {
        const session = makeSession(path.join(project, 'worktree'), { archived: true })
        session.lifecycleIntent = {
          kind: 'resume',
          requestedAt: '2026-07-19T02:03:04.005Z',
        }
        const retained = structuredClone(session)
        const state = makeState([session])
        state.queues[session.discordThreadId] = [{
          id: 'resume-queue',
          authorId: 'user-1',
          authorName: 'Queue User',
          input: [{ type: 'text', text: 'Resume this work', text_elements: [] }],
          displayText: 'Resume this work',
          createdAt: new Date(0).toISOString(),
        }]
        const summary: CodexThreadSummary = {
          id: session.codexThreadId,
          preview: 'Resume crash fixture',
          cwd: session.directory,
          updatedAt: 1,
        }
        const codex = new ReconciliationCodex(
          remoteState === 'active' ? [summary] : [],
          remoteState === 'archived' ? [summary] : [],
        )
        const channel = makeThreadChannel(session.discordThreadId, { archived: true })
        const bot = new CordexDiscordBot(
          makeConfig(project),
          state,
          codex as unknown as CodexAppServer,
        )
        const internal = bot as unknown as InternalBot
        ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
          async () => channel

        try {
          await internal.reconcileSessionLifecycleIntents()

          assert.deepEqual(codex.calls, [
            'list:active',
            'list:archived',
            ...(remoteState === 'archived' ? [`unarchive:${session.codexThreadId}`] : []),
            `resume:${session.codexThreadId}`,
          ])
          assert.equal(session.archived, undefined)
          assert.equal(session.lifecycleIntent, undefined)
          assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
          assert.equal(session.directory, retained.directory)
          assert.equal(session.mode, retained.mode)
          assert.deepEqual(session.worktree, retained.worktree)
          assert.deepEqual(session.workspaceRoots, retained.workspaceRoots)
          assert.equal(session.permissions, retained.permissions)
          assert.equal(session.contextTokens, retained.contextTokens)
          assert.deepEqual(state.queues[session.discordThreadId]?.map((prompt) => prompt.id), [
            'resume-queue',
          ])
          assert.deepEqual(channel.archiveCalls, [false])
          assert.equal((await loadState()).sessions[session.discordThreadId]?.lifecycleIntent, undefined)
        } finally {
          bot.client.destroy()
        }
      })
    })
  }
})

test('startup reconciliation preserves lifecycle intents across transient Discord failures', async (t) => {
  for (const kind of ['archive', 'resume'] as const) {
    await t.test(kind, async () => {
      await withTemporaryHome(async (project) => {
        const session = makeSession(path.join(project, 'worktree'), {
          archived: kind === 'archive',
        })
        session.lifecycleIntent = {
          kind,
          requestedAt: '2026-07-19T02:30:00.000Z',
        }
        const state = makeState([session])
        const summary: CodexThreadSummary = {
          id: session.codexThreadId,
          preview: 'Discord convergence fixture',
          cwd: session.directory,
          updatedAt: 1,
        }
        const codex = new ReconciliationCodex(
          kind === 'resume' ? [summary] : [],
          kind === 'archive' ? [summary] : [],
        )
        const channel = makeThreadChannel(session.discordThreadId, {
          archived: kind === 'resume',
          setArchivedError: new Error('Discord lifecycle unavailable'),
        })
        const bot = new CordexDiscordBot(
          makeConfig(project),
          state,
          codex as unknown as CodexAppServer,
        )
        const internal = bot as unknown as InternalBot
        ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
          async () => channel

        try {
          await assert.rejects(
            internal.reconcileSessionLifecycleIntents(),
            /Discord lifecycle unavailable/,
          )
          assert.equal(session.lifecycleIntent?.kind, kind)
          assert.equal(
            (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent?.kind,
            kind,
          )

          delete channel.setArchivedError
          await internal.reconcileSessionLifecycleIntents()

          assert.equal(session.lifecycleIntent, undefined)
          assert.deepEqual(channel.archiveCalls, [kind === 'archive', kind === 'archive'])
          assert.equal(
            (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent,
            undefined,
          )
        } finally {
          bot.client.destroy()
        }
      })
    })
  }
})

test('startup reconciliation clears an intent when its Discord thread is authoritatively missing', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'), { archived: true })
    session.lifecycleIntent = {
      kind: 'archive',
      requestedAt: '2026-07-19T02:45:00.000Z',
    }
    const state = makeState([session])
    const summary: CodexThreadSummary = {
      id: session.codexThreadId,
      preview: 'Missing Discord thread fixture',
      cwd: session.directory,
      updatedAt: 1,
    }
    const codex = new ReconciliationCodex([], [summary])
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async () => {
        throw Object.assign(new Error('Unknown Channel'), { code: 10_003 })
      }

    try {
      await internal.reconcileSessionLifecycleIntents()
      assert.equal(session.archived, true)
      assert.equal(session.lifecycleIntent, undefined)
      assert.equal((await loadState()).sessions[session.discordThreadId]?.lifecycleIntent, undefined)
    } finally {
      bot.client.destroy()
    }
  })
})

test('startup reconciliation cleans a lifecycle intent whose Codex thread was deleted', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    session.archived = true
    session.lifecycleIntent = {
      kind: 'archive',
      requestedAt: '2026-07-19T03:04:05.006Z',
    }
    const state = makeState([session])
    const codex = new ReconciliationCodex([], [])
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot

    try {
      await internal.reconcileSessionLifecycleIntents()
      assert.equal(state.sessions[session.discordThreadId], undefined)
      assert.equal(codex.calls.some((call) => call.startsWith('archive:')), false)
    } finally {
      bot.client.destroy()
    }
  })
})

test('thread/archived creates and preserves an archive intent until Discord converges', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    const state = makeState([session])
    const codex = new NotificationCodex()
    const channel = makeThreadChannel(session.discordThreadId, {
      setArchivedError: new Error('Discord notification archive unavailable'),
    })
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async () => channel
    const notification: ServerNotification = {
      method: 'thread/archived',
      params: { threadId: session.codexThreadId },
    }

    try {
      await assert.rejects(
        internal.handleNotification(notification),
        /Discord notification archive unavailable/,
      )
      assert.equal(session.archived, true)
      assert.equal(session.lifecycleIntent?.kind, 'archive')
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.equal(
        (await loadState()).sessions[session.discordThreadId]?.lifecycleIntent?.kind,
        'archive',
      )

      delete channel.setArchivedError
      await internal.handleNotification(notification)

      assert.equal(session.lifecycleIntent, undefined)
      assert.deepEqual(channel.archiveCalls, [true, true])
      assert.equal((await loadState()).sessions[session.discordThreadId]?.lifecycleIntent, undefined)
    } finally {
      bot.client.destroy()
    }
  })
})

test('archive lifecycle notifications are idempotent and closed is non-destructive', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    const state = makeState([session])
    const codex = new NotificationCodex()
    const channel = makeThreadChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch = async () => channel

    try {
      session.archived = true
      session.lifecycleIntent = {
        kind: 'archive',
        requestedAt: '2026-07-19T04:05:06.007Z',
      }
      const archived: ServerNotification = {
        method: 'thread/archived',
        params: { threadId: session.codexThreadId },
      }
      await internal.handleNotification(archived)
      await internal.handleNotification(archived)
      assert.equal(session.archived, true)
      assert.equal(session.lifecycleIntent, undefined)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.deepEqual(channel.archiveCalls, [true])

      const unarchived: ServerNotification = {
        method: 'thread/unarchived',
        params: { threadId: session.codexThreadId },
      }
      await internal.handleNotification(unarchived)
      await internal.handleNotification(unarchived)
      assert.equal(session.archived, undefined)
      assert.deepEqual(channel.archiveCalls, [true, false])
      assert.strictEqual(state.sessions[channel.id], session)

      internal.loadedThreads.add(session.codexThreadId)
      await internal.handleNotification({
        method: 'thread/closed',
        params: { threadId: session.codexThreadId },
      })
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.strictEqual(state.sessions[channel.id], session)
    } finally {
      bot.client.destroy()
    }
  })
})

test('thread/deleted notification destructively removes linkage exactly once', async () => {
  await withTemporaryHome(async (project) => {
    const session = makeSession(path.join(project, 'worktree'))
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'queued-before-delete',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Queued work', text_elements: [] }],
      displayText: 'Queued work',
      createdAt: new Date(0).toISOString(),
    }]
    state.tasks['task-before-delete'] = {
      id: 'task-before-delete',
      threadId: session.discordThreadId,
      prompt: 'Scheduled work',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: 'user-1',
      status: 'scheduled',
    }
    const codex = new NotificationCodex()
    const channel = makeThreadChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch = async () => channel
    const notification: ServerNotification = {
      method: 'thread/deleted',
      params: { threadId: session.codexThreadId },
    }

    try {
      await internal.handleNotification(notification)
      await internal.handleNotification(notification)
      await waitUntil(
        () => state.sessions[channel.id] === undefined,
        'deleted Codex thread cleanup did not finish',
      )
      await waitUntil(
        () => channel.sent.length === 1,
        'deleted Codex thread notice was not sent',
      )

      assert.equal(state.sessions[channel.id], undefined)
      assert.equal(state.queues[channel.id], undefined)
      assert.equal(state.tasks['task-before-delete'], undefined)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.equal(channel.sent.length, 1)
      assert.match(channel.sent[0] || '', /deleted outside Cordex/i)
    } finally {
      bot.client.destroy()
    }
  })
})

test('resume autocomplete merges active, archived, and locally retained archived sessions', async () => {
  await withTemporaryHome(async (project) => {
    const remoteLinked = makeSession(project, {
      discordThreadId: 'discord-remote-linked',
      codexThreadId: 'remote-linked',
      archived: true,
      updatedAt: new Date(60_000).toISOString(),
    })
    const localOnly = makeSession(project, {
      discordThreadId: 'discord-local-only',
      codexThreadId: 'local-only',
      archived: true,
      updatedAt: new Date(55_000).toISOString(),
    })
    const state = makeState([remoteLinked, localOnly])
    const summary = (id: string, updatedAt: number, cwd = project): CodexThreadSummary => ({
      id,
      preview: `${id} preview`,
      cwd,
      updatedAt,
    })
    const codex = new AutocompleteCodex(
      [
        summary('active-only', 50),
        summary('transitioning', 40),
        summary('remote-linked', 65),
      ],
      [
        summary('remote-linked', 60),
        summary('transitioning', 45),
        summary('archived-only', 30),
        summary('outside-project', 100, path.dirname(project)),
      ],
    )
    const localChannel = makeThreadChannel(localOnly.discordThreadId, { name: 'Local archived session' })
    const bot = new CordexDiscordBot(makeConfig(project), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.memberAllowed = async () => true
    internal.refreshProjectsSafely = async () => undefined
    ;(bot.client.channels.cache as unknown as Map<string, unknown>)
      .set(localOnly.discordThreadId, localChannel)
    const responses: Array<Array<{ name: string; value: string }>> = []
    const interaction = {
      guildId: 'guild-1',
      user: { id: 'autocomplete-user' },
      commandName: 'resume',
      channel: { id: 'parent-1', isThread: () => false },
      options: {
        getFocused: () => ({ name: 'session', value: '' }),
      },
      async respond(choices: Array<{ name: string; value: string }>) {
        responses.push(choices)
      },
    } as unknown as AutocompleteInteraction

    try {
      await internal.handleAutocomplete(interaction)

      assert.deepEqual(codex.calls, [
        { limit: 100 },
        { limit: 100, archived: true },
      ])
      assert.deepEqual(responses[0]?.map((choice) => choice.value), [
        'remote-linked',
        'local-only',
        'active-only',
        'transitioning',
        'archived-only',
      ])
      assert.match(responses[0]?.find((choice) => choice.value === 'remote-linked')?.name || '', /Archived/)
      assert.match(responses[0]?.find((choice) => choice.value === 'local-only')?.name || '', /Archived/)
      assert.doesNotMatch(responses[0]?.find((choice) => choice.value === 'active-only')?.name || '', /Archived/)
      assert.equal(responses[0]?.some((choice) => choice.value === 'outside-project'), false)
    } finally {
      bot.client.channels.cache.delete(localOnly.discordThreadId)
      bot.client.destroy()
    }
  })
})
