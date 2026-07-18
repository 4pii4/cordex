import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  Attachment,
  ChatInputCommandInteraction,
  Message as DiscordMessage,
  ThreadChannel,
} from 'discord.js'
import {
  CodexAppServer,
  type CodexThreadRuntimeState,
} from '../src/codex-app-server.js'
import { loadState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { DiscordInputResult } from '../src/discord-input.js'
import type {
  CodexThreadSummary,
  CordexConfig,
  CordexState,
  QueuedPrompt,
  ServerNotification,
  SessionState,
  UserInput,
} from '../src/types.js'

type StartTurnOptions = {
  threadId: string
  input: UserInput[]
  clientUserMessageId?: string
}

type SteerTurnOptions = {
  threadId: string
  expectedTurnId: string
  input: UserInput[]
  clientUserMessageId?: string
}

type InternalRun = {
  typingTimer: NodeJS.Timeout
}

type InternalBot = {
  blockedQueuedSourceThreads: Set<string>
  codexRecoveryPromise: Promise<void> | undefined
  pendingCodexDeletionCleanups: Set<Promise<void>>
  unlinkedCodexSessionChannels: Set<string>
  queuedSourceRetryAttempts: Map<string, number>
  queuedSourceRetryTimers: Map<string, NodeJS.Timeout>
  discordIngressQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  codexEventQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  promptQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  projectMutationQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  loadedThreads: Set<string>
  runs: Map<string, InternalRun>
  stopping: boolean
  beginIngressBarrier(): void
  buildInput(message: DiscordMessage, contentOverride?: string): Promise<DiscordInputResult>
  clearAllQueuedSourceRetries(): void
  createSessionThread(options: Record<string, unknown>): Promise<ThreadChannel>
  finishIngressBarrier(): void
  enqueuePrompt(threadId: string, prompt: QueuedPrompt): Promise<number>
  handleClearQueueCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleMessage(message: DiscordMessage): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void>
  memberAllowed(userId: string): Promise<boolean>
  reconcilePersistedQueuedSources(): Promise<void>
  recoverPersistedPrompts(session: SessionState, channel: ThreadChannel): Promise<void>
  refreshProjectsSafely(): Promise<void>
  retryBlockedQueuedSourceThread(threadId: string): Promise<void>
  scheduleQueueDrain(
    session: SessionState,
    channel: ThreadChannel,
    allowWithoutGoal: boolean,
    knownGoalStatus?: string,
  ): void
  synchronizeCodexThreadTitle(threadId: string, value: string): Promise<string>
  synchronizeThreadTitle(
    session: SessionState,
    channel: ThreadChannel,
    value: string,
  ): Promise<string>
  waitForCodexRecovery(): Promise<void>
}

class RecoveryCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly steered: SteerTurnOptions[] = []
  runtimeReads = 0

  constructor(public runtime: CodexThreadRuntimeState = { status: 'idle' }) {
    super()
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    this.runtimeReads += 1
    return structuredClone(this.runtime)
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    return `recovered-turn-${this.started.length}`
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
  }

  async getThreadGoal(): Promise<null> {
    return null
  }

  async updateThreadSettings(): Promise<void> {}
}

class ResumeRecoveryCodex extends RecoveryCodex {
  readonly resumeCalls: string[] = []

  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    this.resumeCalls.push(`unarchive:${threadId}`)
    return {
      id: threadId,
      preview: 'Recovered ingress session',
      cwd: '/unused',
      updatedAt: 1,
    }
  }

  async resumeThread(options: Record<string, unknown>) {
    const threadId = String(options.threadId)
    this.resumeCalls.push(`resume:${threadId}`)
    return {
      model: 'gpt-test',
      name: 'Ingress recovery session',
      turns: [],
    }
  }
}

function makeConfig(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    defaultModel: 'gpt-test',
    defaultEffort: 'xhigh',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory } },
  }
}

function makeSession(directory: string): SessionState {
  return {
    discordThreadId: 'discord-thread',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread',
    model: 'gpt-test',
    effort: 'xhigh',
    updatedAt: new Date(0).toISOString(),
  }
}

function makeState(session: SessionState, queue: QueuedPrompt[] = []): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: { [session.discordThreadId]: session },
    queues: queue.length > 0 ? { [session.discordThreadId]: queue } : {},
    tasks: {},
  }
}

function makePrompt(options: {
  id: string
  text: string
  deliveryKind: 'direct' | 'queued'
  sourceMessageId?: string
  input?: UserInput[]
}): QueuedPrompt {
  return {
    id: options.id,
    authorId: 'user-1',
    authorName: 'Queue User',
    input: options.input || [{ type: 'text', text: options.text, text_elements: [] }],
    displayText: options.text,
    createdAt: new Date(0).toISOString(),
    ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
    deliveryKind: options.deliveryKind,
  }
}

function makeChannel(
  session: SessionState,
  options: {
    archived?: boolean
    sent?: string[]
    fetchMessage?: (id: string) => Promise<unknown>
  } = {},
): ThreadChannel & {
  archiveCalls: boolean[]
  memberAdds: string[]
  sent: string[]
} {
  const sent = options.sent || []
  const channel = {
    id: session.discordThreadId,
    name: 'Ingress recovery session',
    parentId: session.parentChannelId,
    guildId: 'guild-1',
    archived: options.archived === true,
    archiveCalls: [] as boolean[],
    memberAdds: [] as string[],
    sent,
    isThread: () => true,
    toString: () => `<#${session.discordThreadId}>`,
    members: {
      async add(userId: string) {
        channel.memberAdds.push(userId)
      },
    },
    async setArchived(value: boolean) {
      channel.archiveCalls.push(value)
      channel.archived = value
      return channel
    },
    async sendTyping() {},
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      sent.push(content)
      return {
        content,
        async edit() {
          return this
        },
      }
    },
    messages: {
      async fetch(id: string) {
        if (!options.fetchMessage) throw new Error(`Unexpected message fetch: ${id}`)
        return options.fetchMessage(id)
      },
    },
  }
  return channel as unknown as ReturnType<typeof makeChannel>
}

function makeMessage(options: {
  id: string
  content: string
  channel: ThreadChannel
  attachments?: Attachment[]
  editedTimestamp?: number | null
}): DiscordMessage {
  return {
    id: options.id,
    content: options.content,
    editedTimestamp: options.editedTimestamp === undefined ? Date.now() : options.editedTimestamp,
    partial: false,
    guild: { id: 'guild-1' },
    author: {
      id: 'user-1',
      bot: false,
      username: 'queue-user',
      displayName: 'Queue User',
    },
    channel: options.channel,
    attachments: new Map(
      (options.attachments || []).map((attachment, index) => [String(index), attachment]),
    ),
    reference: null,
    async fetchReference() {
      throw new Error('No referenced message')
    },
  } as unknown as DiscordMessage
}

function makeCommandInteraction(
  channel: ThreadChannel,
  replies: unknown[],
  position: number | null = null,
): ChatInputCommandInteraction {
  return {
    channel,
    options: {
      getInteger: () => position,
    },
    async reply(payload: unknown) {
      replies.push(payload)
    },
  } as unknown as ChatInputCommandInteraction
}

function replyContent(reply: unknown): string {
  if (typeof reply === 'string') return reply
  if (reply && typeof reply === 'object' && 'content' in reply) {
    return String((reply as { content: unknown }).content)
  }
  return ''
}

function makeResumeInteraction(
  codexThreadId: string,
  options: { editReplyError?: Error; replies?: string[] } = {},
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
      if (options.editReplyError) throw options.editReplyError
      options.replies?.push(value)
    },
  } as unknown as ChatInputCommandInteraction
}

function clearRunTimers(internal: InternalBot): void {
  internal.clearAllQueuedSourceRetries()
  for (const run of internal.runs.values()) clearInterval(run.typingTimer)
  internal.runs.clear()
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(5)
  }
}

async function withTemporaryHome(run: (directory: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-ingress-recovery-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-ingress-recovery-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  try {
    await run(directory)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
}

async function withFailingStateHome(
  run: (directory: string, homePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-ingress-failing-state-root-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-ingress-failing-state-project-'))
  const homePath = path.join(root, 'home-as-file')
  await writeFile(homePath, 'not a directory')
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = homePath
  try {
    await run(directory, homePath)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
}

function makeFixture(
  directory: string,
  queue: QueuedPrompt[] = [],
  codex = new RecoveryCodex(),
) {
  const session = makeSession(directory)
  const state = makeState(session, queue)
  const bot = new CordexDiscordBot(
    makeConfig(directory),
    state,
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.refreshProjectsSafely = async () => undefined
  internal.memberAllowed = async () => true
  return { bot, internal, codex, session, state }
}

function setFetchedChannel(bot: CordexDiscordBot, channel: ThreadChannel): void {
  const channels = bot.client.channels as unknown as {
    fetch(id: string, options?: unknown): Promise<ThreadChannel | undefined>
  }
  channels.fetch = async (id: string) => id === channel.id ? channel : undefined
}

test('enqueuePrompt deduplicates stable delivery IDs', async () => {
  await withTemporaryHome(async (directory) => {
    const fixture = makeFixture(directory)
    const direct = makePrompt({
      id: 'direct-ledger-a',
      text: 'Original direct input.',
      deliveryKind: 'direct',
      sourceMessageId: 'discord-delivery-a',
    })

    try {
      assert.equal(await fixture.internal.enqueuePrompt(fixture.session.discordThreadId, direct), 0)
      assert.equal(await fixture.internal.enqueuePrompt(fixture.session.discordThreadId, {
        ...direct,
        id: 'direct-ledger-b',
        displayText: 'Duplicate input must not replace the original.',
      }), 0)

      const queued = makePrompt({
        id: 'queued-delivery',
        text: 'Queued once.',
        deliveryKind: 'queued',
      })
      assert.equal(await fixture.internal.enqueuePrompt(fixture.session.discordThreadId, queued), 1)
      assert.equal(await fixture.internal.enqueuePrompt(fixture.session.discordThreadId, {
        ...queued,
        displayText: 'Queued duplicate.',
      }), 1)

      assert.deepEqual(
        fixture.state.queues[fixture.session.discordThreadId]?.map((prompt) => prompt.displayText),
        ['Original direct input.', 'Queued once.'],
      )
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('enqueuePrompt rolls back an in-memory prompt when persistence fails', async () => {
  await withFailingStateHome(async (directory, homePath) => {
    const fixture = makeFixture(directory)
    const prompt = makePrompt({
      id: 'durable-direct',
      text: 'Persist before delivery.',
      deliveryKind: 'direct',
      sourceMessageId: 'durable-source',
    })

    try {
      await assert.rejects(
        fixture.internal.enqueuePrompt(fixture.session.discordThreadId, prompt),
      )
      assert.deepEqual(fixture.state.queues[fixture.session.discordThreadId], [])

      await rm(homePath, { force: true })
      await mkdir(homePath)
      assert.equal(
        await fixture.internal.enqueuePrompt(fixture.session.discordThreadId, prompt),
        0,
      )
      assert.deepEqual(fixture.state.queues[fixture.session.discordThreadId], [prompt])
      assert.deepEqual(
        (await loadState()).queues[fixture.session.discordThreadId],
        [prompt],
      )
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('direct ledger entries are hidden from queued position, status, and clear operations', async () => {
  await withTemporaryHome(async (directory) => {
    const direct = makePrompt({
      id: 'hidden-direct',
      text: 'Accepted direct input.',
      deliveryKind: 'direct',
    })
    const fixture = makeFixture(directory, [direct])
    const channel = makeChannel(fixture.session)
    const replies: unknown[] = []

    try {
      assert.equal(await fixture.internal.enqueuePrompt(
        fixture.session.discordThreadId,
        makePrompt({ id: 'queued-1', text: 'First queued.', deliveryKind: 'queued' }),
      ), 1)

      await fixture.internal.handleStatusCommand(makeCommandInteraction(channel, replies))
      assert.match(replyContent(replies.shift()), /Queue: 1/)

      await fixture.internal.handleClearQueueCommand(makeCommandInteraction(channel, replies, 1))
      assert.equal(replyContent(replies.shift()), 'Cleared queued message 1.')
      assert.deepEqual(fixture.state.queues[channel.id], [direct])

      assert.equal(await fixture.internal.enqueuePrompt(
        channel.id,
        makePrompt({ id: 'queued-2', text: 'Second queued.', deliveryKind: 'queued' }),
      ), 1)
      assert.equal(await fixture.internal.enqueuePrompt(
        channel.id,
        makePrompt({ id: 'queued-3', text: 'Third queued.', deliveryKind: 'queued' }),
      ), 2)
      await fixture.internal.handleClearQueueCommand(makeCommandInteraction(channel, replies))

      assert.equal(replyContent(replies.shift()), 'Cleared 2 queued messages.')
      assert.deepEqual(fixture.state.queues[channel.id], [direct])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('persisted direct input already present in runtime history is removed without delivery', async () => {
  await withTemporaryHome(async (directory) => {
    const deliveryId = 'accepted-direct-message'
    const direct = makePrompt({
      id: 'direct-ledger',
      text: 'Already accepted.',
      deliveryKind: 'direct',
      sourceMessageId: deliveryId,
    })
    const codex = new RecoveryCodex({
      status: 'idle',
      userMessageClientIds: [deliveryId],
    })
    const fixture = makeFixture(directory, [direct], codex)
    const channel = makeChannel(fixture.session)

    try {
      await fixture.internal.recoverPersistedPrompts(fixture.session, channel)

      assert.equal(codex.started.length, 0)
      assert.equal(codex.steered.length, 0)
      assert.deepEqual(fixture.state.queues[channel.id], [])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('missing persisted direct input is delivered once and removed', async () => {
  await withTemporaryHome(async (directory) => {
    const input: UserInput[] = [{ type: 'text', text: 'Recover exactly once.', text_elements: [] }]
    const direct = makePrompt({
      id: 'direct-ledger',
      text: 'Recover exactly once.',
      deliveryKind: 'direct',
      sourceMessageId: 'missing-direct-message',
      input,
    })
    const fixture = makeFixture(directory, [direct])
    const channel = makeChannel(fixture.session)
    fixture.internal.loadedThreads.add(fixture.session.codexThreadId)

    try {
      await fixture.internal.recoverPersistedPrompts(fixture.session, channel)
      await fixture.internal.recoverPersistedPrompts(fixture.session, channel)

      assert.equal(fixture.codex.started.length, 1)
      assert.strictEqual(fixture.codex.started[0]?.input, input)
      assert.equal(fixture.codex.started[0]?.clientUserMessageId, 'missing-direct-message')
      assert.equal(fixture.codex.steered.length, 0)
      assert.deepEqual(fixture.state.queues[channel.id], [])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('external unarchive recovers direct input and re-arms blocked queued source recovery', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'blocked-unarchive-source'
    const direct = makePrompt({
      id: 'unarchive-direct-ledger',
      text: 'Deliver after external unarchive.',
      deliveryKind: 'direct',
      sourceMessageId: 'unarchive-direct-source',
    })
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Retain blocked source.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const codex = new ResumeRecoveryCodex()
    const fixture = makeFixture(directory, [direct, queued], codex)
    fixture.session.archived = true
    const channel = makeChannel(fixture.session, {
      archived: true,
      fetchMessage: async () => Promise.reject(new Error('Discord source still unavailable')),
    })
    setFetchedChannel(fixture.bot, channel)
    fixture.internal.blockedQueuedSourceThreads.add(channel.id)

    try {
      await fixture.internal.handleNotification({
        method: 'thread/unarchived',
        params: { threadId: fixture.session.codexThreadId },
      })
      await waitUntil(
        () => codex.started.length === 1 &&
          fixture.state.queues[channel.id]?.length === 1,
        'external unarchive did not finish persisted prompt recovery',
      )

      assert.equal(fixture.session.archived, undefined)
      assert.equal(channel.archived, false)
      assert.deepEqual(channel.archiveCalls, [false])
      assert.deepEqual(codex.resumeCalls, [`resume:${fixture.session.codexThreadId}`])
      assert.equal(codex.started.length, 1)
      assert.equal(
        codex.started[0]?.clientUserMessageId,
        direct.sourceMessageId,
      )
      assert.deepEqual(fixture.state.queues[channel.id], [queued])
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), true)
      assert.equal(fixture.internal.queuedSourceRetryTimers.has(channel.id), true)
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('ingress barrier holds MessageCreate until persisted recovery is released', async () => {
  await withTemporaryHome(async (directory) => {
    const fixture = makeFixture(directory)
    const channel = makeChannel(fixture.session)
    const message = makeMessage({
      id: 'barrier-message',
      content: 'Wait for startup recovery.',
      channel,
    })
    fixture.internal.loadedThreads.add(fixture.session.codexThreadId)
    fixture.internal.beginIngressBarrier()

    try {
      ;(fixture.bot.client as unknown as EventEmitter).emit('messageCreate', message)
      await sleep(25)

      assert.equal(fixture.codex.started.length, 0)
      assert.equal(fixture.state.queues[channel.id], undefined)

      fixture.internal.finishIngressBarrier()
      await fixture.internal.discordIngressQueue.run(channel.id, async () => undefined)

      assert.equal(fixture.codex.started.length, 1)
      assert.equal(fixture.codex.started[0]?.clientUserMessageId, message.id)
      assert.deepEqual(fixture.state.queues[channel.id], [])
    } finally {
      fixture.internal.finishIngressBarrier()
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('thread deletion during slow preprocessing cannot persist an orphan prompt', async () => {
  await withTemporaryHome(async (directory) => {
    const fixture = makeFixture(directory)
    const channel = makeChannel(fixture.session)
    const message = makeMessage({
      id: 'slow-preprocessing-message',
      content: 'Do not outlive the deleted Codex thread.',
      channel,
    })
    setFetchedChannel(fixture.bot, channel)
    let releaseBuild: () => void = () => undefined
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let markBuildStarted: () => void = () => undefined
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve
    })
    fixture.internal.buildInput = async () => {
      markBuildStarted()
      await buildGate
      return {
        input: [{ type: 'text', text: message.content, text_elements: [] }],
        feedback: [],
      }
    }

    try {
      const handling = fixture.internal.handleMessage(message)
      await buildStarted
      fixture.codex.emit('notification', {
        method: 'thread/deleted',
        params: { threadId: fixture.session.codexThreadId },
      })
      await waitUntil(
        () => fixture.internal.unlinkedCodexSessionChannels.has(channel.id),
        'deleted Codex thread was not tombstoned',
      )
      releaseBuild()
      await handling
      await waitUntil(
        () => fixture.state.sessions[channel.id] === undefined,
        'deleted Codex thread cleanup did not finish',
      )
      while (fixture.internal.pendingCodexDeletionCleanups.size > 0) {
        await Promise.all([...fixture.internal.pendingCodexDeletionCleanups])
      }

      assert.equal(fixture.state.sessions[channel.id], undefined)
      assert.equal(fixture.state.queues[channel.id], undefined)
      assert.equal(fixture.codex.started.length, 0)
      assert.equal(fixture.codex.steered.length, 0)
    } finally {
      releaseBuild()
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('Codex deletion releases the event queue before waiting for prompt cleanup', async () => {
  await withTemporaryHome(async (directory) => {
    const fixture = makeFixture(directory)
    const channel = makeChannel(fixture.session)
    setFetchedChannel(fixture.bot, channel)
    let releaseCodexAttempt: () => void = () => undefined
    const codexAttemptGate = new Promise<void>((resolve) => {
      releaseCodexAttempt = resolve
    })
    let markPromptHeld: () => void = () => undefined
    const promptHeld = new Promise<void>((resolve) => {
      markPromptHeld = resolve
    })
    const delivery = fixture.internal.promptQueue.run(channel.id, async () => {
      markPromptHeld()
      await codexAttemptGate
      await fixture.internal.codexEventQueue.run(
        fixture.session.codexThreadId,
        async () => undefined,
      )
    })

    try {
      await promptHeld
      fixture.codex.emit('notification', {
        method: 'thread/deleted',
        params: { threadId: fixture.session.codexThreadId },
      })
      await waitUntil(
        () => fixture.internal.unlinkedCodexSessionChannels.has(channel.id),
        'deleted Codex thread was not tombstoned',
      )
      releaseCodexAttempt()
      await Promise.race([
        delivery,
        sleep(250).then(() => {
          throw new Error('Codex deletion cleanup deadlocked with prompt delivery')
        }),
      ])
      await waitUntil(
        () => fixture.state.sessions[channel.id] === undefined,
        'deleted Codex thread cleanup did not finish after lock release',
      )
      while (fixture.internal.pendingCodexDeletionCleanups.size > 0) {
        await Promise.all([...fixture.internal.pendingCodexDeletionCleanups])
      }
    } finally {
      releaseCodexAttempt()
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('startup reconciliation rebuilds edited queued source input', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'offline-edited-message'
    const skill: UserInput = {
      type: 'skill',
      name: 'fixture-skill',
      path: '/tmp/fixture-skill/SKILL.md',
    }
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Original queued input.',
      deliveryKind: 'queued',
      sourceMessageId,
      input: [skill, { type: 'text', text: 'Original queued input.', text_elements: [] }],
    })
    let channel!: ThreadChannel
    let fetches = 0
    const fixture = makeFixture(directory, [queued])
    channel = makeChannel(fixture.session, {
      fetchMessage: async (id) => {
        fetches += 1
        assert.equal(id, sourceMessageId)
        return makeMessage({ id, content: 'Edited while Cordex was offline. queue', channel })
      },
    })
    setFetchedChannel(fixture.bot, channel)

    try {
      await fixture.internal.reconcilePersistedQueuedSources()

      const rebuilt = fixture.state.queues[channel.id]?.[0]
      assert.equal(fetches, 1)
      assert.equal(rebuilt?.displayText, 'Edited while Cordex was offline')
      assert.deepEqual(rebuilt?.input[0], skill)
      assert.deepEqual(rebuilt?.input[1], {
        type: 'text',
        text: 'Edited while Cordex was offline',
        text_elements: [],
      })
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), false)
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('source reconciliation accepts attachment-only queue edits and permanent feedback', async () => {
  await withTemporaryHome(async (directory) => {
    const attachmentSourceId = 'attachment-only-source'
    const warningSourceId = 'permanent-warning-source'
    const removedSourceId = 'removed-attachment-source'
    const skill: UserInput = {
      type: 'skill',
      name: 'fixture-skill',
      path: '/tmp/fixture-skill/SKILL.md',
    }
    const attachmentPrompt = makePrompt({
      id: attachmentSourceId,
      text: 'Original attachment prompt.',
      deliveryKind: 'queued',
      sourceMessageId: attachmentSourceId,
      input: [skill, { type: 'text', text: 'Original attachment prompt.', text_elements: [] }],
    })
    const warningPrompt = makePrompt({
      id: warningSourceId,
      text: 'Original warning prompt.',
      deliveryKind: 'queued',
      sourceMessageId: warningSourceId,
    })
    const removedPrompt = makePrompt({
      id: removedSourceId,
      text: 'Removed attachment prompt.',
      deliveryKind: 'queued',
      sourceMessageId: removedSourceId,
      input: [{ type: 'text', text: 'Attachment that no longer exists.', text_elements: [] }],
    })
    const fixture = makeFixture(directory, [attachmentPrompt, warningPrompt, removedPrompt])
    let channel!: ThreadChannel
    const attachmentBody = 'attachment-only body'
    const textAttachment = {
      name: 'notes.txt',
      contentType: 'text/plain',
      size: Buffer.byteLength(attachmentBody),
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(attachmentBody)}`,
    } as Attachment
    const unsupportedAttachment = {
      name: 'archive.zip',
      contentType: 'application/zip',
      size: 3,
      url: 'data:application/zip,zip',
    } as Attachment
    channel = makeChannel(fixture.session, {
      fetchMessage: async (id) => {
        if (id === attachmentSourceId) {
          return makeMessage({
            id,
            content: '. queue',
            channel,
            attachments: [textAttachment],
          })
        }
        if (id === warningSourceId) {
          return makeMessage({
            id,
            content: 'Valid text despite an unsupported attachment. queue',
            channel,
            attachments: [unsupportedAttachment],
          })
        }
        assert.equal(id, removedSourceId)
        return makeMessage({ id, content: '. queue', channel })
      },
    })
    setFetchedChannel(fixture.bot, channel)

    try {
      await fixture.internal.reconcilePersistedQueuedSources()

      const rebuiltAttachment = fixture.state.queues[channel.id]?.[0]
      assert.equal(rebuiltAttachment?.displayText, '(attachment)')
      assert.deepEqual(rebuiltAttachment?.input[0], skill)
      assert.equal(rebuiltAttachment?.input[1]?.type, 'text')
      assert.match(
        rebuiltAttachment?.input[1]?.type === 'text'
          ? rebuiltAttachment.input[1].text
          : '',
        /attachment-only body/,
      )

      const rebuiltWarning = fixture.state.queues[channel.id]?.[1]
      assert.equal(
        rebuiltWarning?.displayText,
        'Valid text despite an unsupported attachment',
      )
      assert.deepEqual(rebuiltWarning?.input, [{
        type: 'text',
        text: 'Valid text despite an unsupported attachment',
        text_elements: [],
      }])
      assert.equal(
        fixture.state.queues[channel.id]?.some((prompt) => prompt.id === removedSourceId),
        false,
      )
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), false)
      assert.equal(fixture.internal.queuedSourceRetryTimers.has(channel.id), false)
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('startup reconciliation prunes deleted queued source messages', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'offline-deleted-message'
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Delete while offline.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [queued])
    const channel = makeChannel(fixture.session, {
      fetchMessage: async () => Promise.reject({ code: 10_008 }),
    })
    setFetchedChannel(fixture.bot, channel)

    try {
      await fixture.internal.reconcilePersistedQueuedSources()

      assert.deepEqual(fixture.state.queues[channel.id], [])
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), false)
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('transient queued source fetch failure retains input and blocks queue drain', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'offline-transient-message'
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Retain on transient failure.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [queued])
    const channel = makeChannel(fixture.session, {
      fetchMessage: async () => Promise.reject(new Error('Fixture Discord outage')),
    })
    setFetchedChannel(fixture.bot, channel)
    fixture.internal.loadedThreads.add(fixture.session.codexThreadId)

    try {
      await fixture.internal.reconcilePersistedQueuedSources()
      await fixture.internal.recoverPersistedPrompts(fixture.session, channel)

      assert.deepEqual(fixture.state.queues[channel.id], [queued])
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), true)
      assert.equal(fixture.codex.started.length, 0)
      assert.equal(fixture.codex.steered.length, 0)
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('blocked queued source retry unblocks and drains after Discord recovers', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'retry-transient-message'
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Original retry input.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [queued])
    let channel!: ThreadChannel
    let fetches = 0
    channel = makeChannel(fixture.session, {
      fetchMessage: async (id) => {
        fetches += 1
        if (fetches === 1) throw new Error('Fixture transient Discord failure')
        return makeMessage({
          id,
          content: 'Recovered queued input. queue',
          channel,
        })
      },
    })
    setFetchedChannel(fixture.bot, channel)
    fixture.internal.loadedThreads.add(fixture.session.codexThreadId)

    try {
      await fixture.internal.reconcilePersistedQueuedSources()
      assert.equal(fetches, 1)
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), true)
      assert.deepEqual(fixture.state.queues[channel.id], [queued])

      await fixture.internal.retryBlockedQueuedSourceThread(channel.id)

      assert.equal(fetches, 2)
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(channel.id), false)
      assert.equal(fixture.codex.started.length, 1)
      assert.equal(fixture.codex.started[0]?.clientUserMessageId, sourceMessageId)
      assert.deepEqual(fixture.codex.started[0]?.input, [{
        type: 'text',
        text: 'Recovered queued input',
        text_elements: [],
      }])
      assert.deepEqual(fixture.state.queues[channel.id], [])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('resume recovers persisted input before a failed editReply can abort the command', async () => {
  await withTemporaryHome(async (directory) => {
    const direct = makePrompt({
      id: 'resume-direct-ledger',
      text: 'Recover even when Discord reply fails.',
      deliveryKind: 'direct',
      sourceMessageId: 'resume-direct-source',
    })
    const codex = new ResumeRecoveryCodex()
    const fixture = makeFixture(directory, [direct], codex)
    fixture.session.archived = true
    const channel = makeChannel(fixture.session, { archived: true })
    setFetchedChannel(fixture.bot, channel)
    fixture.internal.synchronizeThreadTitle = async (_session, _channel, value) => value

    try {
      await assert.rejects(
        fixture.internal.handleResumeCommand(makeResumeInteraction(
          fixture.session.codexThreadId,
          { editReplyError: new Error('Discord editReply failed') },
        )),
        /Discord editReply failed/,
      )

      assert.deepEqual(codex.resumeCalls, [
        `unarchive:${fixture.session.codexThreadId}`,
        `resume:${fixture.session.codexThreadId}`,
      ])
      assert.equal(fixture.session.archived, undefined)
      assert.equal(codex.started.length, 1)
      assert.equal(codex.started[0]?.clientUserMessageId, direct.sourceMessageId)
      assert.deepEqual(fixture.state.queues[channel.id], [])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('resume from a deleted Discord thread migrates only replay-safe prompts and clears source retry state', async () => {
  await withTemporaryHome(async (directory) => {
    const direct = makePrompt({
      id: 'migrate-direct',
      text: 'Retain direct ledger.',
      deliveryKind: 'direct',
      sourceMessageId: 'migrate-direct-source',
    })
    const sourceBacked = makePrompt({
      id: 'migrate-source-backed',
      text: 'Drop unavailable Discord source.',
      deliveryKind: 'queued',
      sourceMessageId: 'deleted-source-message',
    })
    const sourceLess = makePrompt({
      id: 'migrate-source-less',
      text: 'Retain source-less queued work.',
      deliveryKind: 'queued',
    })
    const codex = new ResumeRecoveryCodex()
    const fixture = makeFixture(directory, [direct, sourceBacked, sourceLess], codex)
    const oldDiscordThreadId = fixture.session.discordThreadId
    const newSession = {
      ...fixture.session,
      discordThreadId: 'replacement-discord-thread',
    }
    const newChannel = makeChannel(newSession)
    const replies: string[] = []
    fixture.internal.createSessionThread = async () => newChannel
    fixture.internal.synchronizeCodexThreadTitle = async (_threadId, value) => value
    fixture.internal.recoverPersistedPrompts = async () => undefined
    ;(fixture.bot.client.channels as unknown as {
      fetch(id: string): Promise<ThreadChannel | undefined>
    }).fetch = async (id: string) => {
      if (id === oldDiscordThreadId) throw { code: 10_003 }
      return undefined
    }
    fixture.internal.blockedQueuedSourceThreads.add(oldDiscordThreadId)
    fixture.internal.queuedSourceRetryAttempts.set(oldDiscordThreadId, 4)
    const retryTimer = setTimeout(() => undefined, 60_000)
    retryTimer.unref()
    fixture.internal.queuedSourceRetryTimers.set(oldDiscordThreadId, retryTimer)

    try {
      await fixture.internal.handleResumeCommand(makeResumeInteraction(
        fixture.session.codexThreadId,
        { replies },
      ))

      assert.equal(fixture.state.sessions[oldDiscordThreadId], undefined)
      assert.equal(
        fixture.state.sessions[newChannel.id]?.codexThreadId,
        fixture.session.codexThreadId,
      )
      assert.equal(fixture.state.queues[oldDiscordThreadId], undefined)
      assert.deepEqual(fixture.state.queues[newChannel.id], [direct, sourceLess])
      assert.equal(
        fixture.state.queues[newChannel.id]?.some((prompt) => prompt === sourceBacked),
        false,
      )
      assert.equal(fixture.internal.blockedQueuedSourceThreads.has(oldDiscordThreadId), false)
      assert.equal(fixture.internal.queuedSourceRetryAttempts.has(oldDiscordThreadId), false)
      assert.equal(fixture.internal.queuedSourceRetryTimers.has(oldDiscordThreadId), false)
      assert.deepEqual(replies, [`Session resumed: ${newChannel}`])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('scheduleQueueDrain never holds the project mutation lock while waiting for recovery', async () => {
  await withTemporaryHome(async (directory) => {
    const queued = makePrompt({
      id: 'lock-safe-queued-prompt',
      text: 'Drain without deadlocking recovery.',
      deliveryKind: 'queued',
    })
    const fixture = makeFixture(directory, [queued])
    const channel = makeChannel(fixture.session)
    fixture.internal.loadedThreads.add(fixture.session.codexThreadId)
    const projectKey = `channel:${fixture.session.parentChannelId}`
    let releaseProjectBlock: () => void = () => undefined
    const projectBlockGate = new Promise<void>((resolve) => {
      releaseProjectBlock = resolve
    })
    let markProjectHeld: () => void = () => undefined
    const projectHeld = new Promise<void>((resolve) => {
      markProjectHeld = resolve
    })
    const blocker = fixture.internal.projectMutationQueue.run(projectKey, async () => {
      markProjectHeld()
      await projectBlockGate
    })
    let markInitialWaitDone: () => void = () => undefined
    const initialWaitDone = new Promise<void>((resolve) => {
      markInitialWaitDone = resolve
    })
    const waitForRecovery = fixture.internal.waitForCodexRecovery.bind(fixture.internal)
    let waitCalls = 0
    fixture.internal.waitForCodexRecovery = async () => {
      waitCalls += 1
      await waitForRecovery()
      if (waitCalls === 1) markInitialWaitDone()
    }
    let releaseRecovery: () => void = () => undefined
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })

    try {
      await projectHeld
      fixture.internal.scheduleQueueDrain(fixture.session, channel, true)
      await initialWaitDone
      fixture.internal.codexRecoveryPromise = recoveryGate
      releaseProjectBlock()
      await blocker

      const competingMutation = fixture.internal.projectMutationQueue.run(
        projectKey,
        async () => undefined,
      )
      const acquiredBeforeRecoveryRelease = await Promise.race([
        competingMutation.then(() => true),
        sleep(100).then(() => false),
      ])
      await competingMutation

      assert.equal(acquiredBeforeRecoveryRelease, true)
    } finally {
      fixture.internal.stopping = true
      fixture.internal.codexRecoveryPromise = undefined
      releaseRecovery()
      releaseProjectBlock()
      await blocker
      await fixture.internal.projectMutationQueue.run(projectKey, async () => undefined)
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('MessageUpdate and MessageDelete do not mutate direct ledger entries', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'accepted-direct-source'
    const direct = makePrompt({
      id: 'accepted-direct-ledger',
      text: 'Accepted direct input.',
      deliveryKind: 'direct',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [direct])
    const channel = makeChannel(fixture.session)
    const edited = makeMessage({
      id: sourceMessageId,
      content: 'Edited into a queue marker. queue',
      channel,
    })

    try {
      ;(fixture.bot.client as unknown as EventEmitter).emit('messageUpdate', edited, edited)
      ;(fixture.bot.client as unknown as EventEmitter).emit('messageDelete', {
        id: sourceMessageId,
        channel,
      })
      await fixture.internal.discordIngressQueue.run(channel.id, async () => undefined)

      assert.deepEqual(fixture.state.queues[channel.id], [direct])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('embed-only MessageUpdate without an edited timestamp is ignored', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'embed-only-queued-source'
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Original queued input.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [queued])
    const sent: string[] = []
    const channel = makeChannel(fixture.session, { sent })
    const embedOnlyUpdate = makeMessage({
      id: sourceMessageId,
      content: 'Content must not be rebuilt. queue',
      channel,
      editedTimestamp: null,
    })

    try {
      ;(fixture.bot.client as unknown as EventEmitter).emit(
        'messageUpdate',
        embedOnlyUpdate,
        embedOnlyUpdate,
      )
      await fixture.internal.discordIngressQueue.run(channel.id, async () => undefined)

      assert.deepEqual(fixture.state.queues[channel.id], [queued])
      assert.deepEqual(sent, [])
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})

test('partial MessageUpdate fetches the full message before rebuilding queued input', async () => {
  await withTemporaryHome(async (directory) => {
    const sourceMessageId = 'partial-queued-source'
    const queued = makePrompt({
      id: sourceMessageId,
      text: 'Original partial input.',
      deliveryKind: 'queued',
      sourceMessageId,
    })
    const fixture = makeFixture(directory, [queued])
    const sent: string[] = []
    const channel = makeChannel(fixture.session, { sent })
    const resolved = makeMessage({
      id: sourceMessageId,
      content: 'Fetched partial edit. queue',
      channel,
    })
    let fetches = 0
    const partial = {
      id: sourceMessageId,
      partial: true,
      channel,
      async fetch() {
        fetches += 1
        return resolved
      },
    }

    try {
      ;(fixture.bot.client as unknown as EventEmitter).emit('messageUpdate', partial, partial)
      await fixture.internal.discordIngressQueue.run(channel.id, async () => undefined)

      assert.equal(fetches, 1)
      assert.equal(fixture.state.queues[channel.id]?.[0]?.displayText, 'Fetched partial edit')
      assert.deepEqual(fixture.state.queues[channel.id]?.[0]?.input, [{
        type: 'text',
        text: 'Fetched partial edit',
        text_elements: [],
      }])
      assert.ok(sent.some((message) => message === 'Queue updated: Fetched partial edit'))
    } finally {
      clearRunTimers(fixture.internal)
      fixture.bot.client.destroy()
    }
  })
})
