import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import {
  CodexAppServer,
  type CodexThreadRuntimeState,
} from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
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
  turnId?: string
  typingTimer: NodeJS.Timeout
}

type InternalBot = {
  codexEventQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  discordIngressQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  loadedThreads: Set<string>
  deletedDiscordThreads: Set<string>
  pendingTurnStarts: Set<string>
  runs: Map<string, InternalRun>
  startRun(session: SessionState, channel: ThreadChannel): InternalRun
  enqueuePrompt(threadId: string, prompt: CordexState['queues'][string][number]): Promise<number>
  dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
  ): Promise<void>
  steerNextQueuedPrompt(run: InternalRun): Promise<void>
  pruneOrphanedState(): Promise<void>
}

class ReconciliationCodex extends EventEmitter {
  readonly steered: SteerTurnOptions[] = []
  readonly started: StartTurnOptions[] = []

  constructor(private readonly runtime: CodexThreadRuntimeState) {
    super()
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
    if (this.steered.length === 1) throw new Error('Fixture stale turn rejection')
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return this.runtime
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    return 'replacement-turn'
  }
}

class LifecycleCodex extends EventEmitter {
  readonly resumed: string[] = []
  readonly started: StartTurnOptions[] = []

  async getThreadGoal(threadId: string) {
    return {
      threadId,
      objective: `${threadId} objective`,
      status: threadId === 'codex-goal' ? 'active' : 'paused',
      tokensUsed: 0,
      timeUsedSeconds: 0,
    }
  }

  async resumeThread(options: { threadId: string }): Promise<{ turns: [] }> {
    this.resumed.push(options.threadId)
    return { turns: [] }
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    return 'recovered-queued-turn'
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'idle' }
  }

  async updateThreadSettings(): Promise<void> {}
}

class OrphanRecoveryCodex extends EventEmitter {
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly archived: string[] = []

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'active', activeTurnId: 'offline-active-turn' }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class IngressCodex extends EventEmitter {
  readonly steered: SteerTurnOptions[] = []

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'active', activeTurnId: 'stale-turn' }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
  }
}

class StartFailureCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly steered: SteerTurnOptions[] = []
  runtimeReadAt = 0
  startFailedAt = 0

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    this.startFailedAt = Date.now()
    throw new Error('Fixture turn/start failed after Codex accepted the turn')
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    this.runtimeReadAt = Date.now()
    return { status: 'active', activeTurnId: 'authoritative-start-turn' }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
  }
}

class AcceptedStartLossCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly steered: SteerTurnOptions[] = []

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    throw new Error('Fixture accepted turn but lost the response')
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return {
      status: 'active',
      activeTurnId: 'accepted-start-turn',
      userMessageClientIds: ['message-start-loss'],
    }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
  }
}

class ReconcileLossCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly steered: SteerTurnOptions[] = []
  runtimeReads = 0

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    if (this.started.length === 1) throw new Error('Fixture accepted turn but lost start response')
    return 'replacement-after-reconciliation'
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    this.runtimeReads += 1
    return this.runtimeReads === 1
      ? { status: 'active', activeTurnId: 'authoritative-turn-a' }
      : { status: 'idle' }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
    throw new Error('Authoritative turn ended before recursive steer')
  }
}

class QueueDeliveryCodex extends EventEmitter {
  readonly steered: SteerTurnOptions[] = []
  runtimeReads = 0

  constructor(private readonly visibleAfterRead: number) {
    super()
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    this.runtimeReads += 1
    return {
      status: 'active',
      activeTurnId: 'stale-turn',
      ...(this.runtimeReads >= this.visibleAfterRead
        ? { userMessageClientIds: ['queued-delivery'] }
        : {}),
    }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
    throw new Error('Fixture lost the steer response')
  }
}

class BlockingQueueDeliveryCodex extends EventEmitter {
  readonly steered: SteerTurnOptions[] = []
  readonly steerCalled: Promise<void>
  private markSteerCalled!: () => void
  private resolveSteer!: () => void

  constructor() {
    super()
    this.steerCalled = new Promise<void>((resolve) => {
      this.markSteerCalled = resolve
    })
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'active', activeTurnId: 'stale-turn' }
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
    this.markSteerCalled()
    return new Promise<void>((resolve) => {
      this.resolveSteer = resolve
    })
  }

  releaseSteer(): void {
    this.resolveSteer()
  }
}

class PendingStartCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly archived: string[] = []
  readonly startCalled: Promise<void>
  private markStartCalled!: () => void
  private resolveStart!: (turnId: string) => void
  private rejectStart!: (error: Error) => void

  constructor(private readonly runtime: CodexThreadRuntimeState) {
    super()
    this.startCalled = new Promise<void>((resolve) => {
      this.markStartCalled = resolve
    })
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    this.markStartCalled()
    return new Promise<string>((resolve, reject) => {
      this.resolveStart = resolve
      this.rejectStart = reject
    })
  }

  succeed(turnId: string): void {
    this.resolveStart(turnId)
  }

  fail(): void {
    this.rejectStart(new Error('Fixture accepted turn but lost the response'))
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return this.runtime
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class EmptyThreadDeletionCodex extends EventEmitter {
  readonly deleted: string[] = []
  readonly archived: string[] = []
  readonly startCalled: Promise<void>
  private markStartCalled!: () => void
  private resolveStart!: () => void

  constructor() {
    super()
    this.startCalled = new Promise<void>((resolve) => {
      this.markStartCalled = resolve
    })
  }

  async startThread(): Promise<{ threadId: string; model: string }> {
    this.markStartCalled()
    await new Promise<void>((resolve) => {
      this.resolveStart = resolve
    })
    return { threadId: 'empty-codex-thread', model: 'gpt-test' }
  }

  releaseStart(): void {
    this.resolveStart()
  }

  async deleteThread(threadId: string): Promise<void> {
    this.deleted.push(threadId)
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class DeletedSteerCodex extends EventEmitter {
  readonly steered: SteerTurnOptions[] = []
  readonly started: StartTurnOptions[] = []
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly archived: string[] = []
  readonly steerCalled: Promise<void>
  private markSteerCalled!: () => void
  private rejectSteer!: (error: Error) => void

  constructor() {
    super()
    this.steerCalled = new Promise<void>((resolve) => {
      this.markSteerCalled = resolve
    })
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
    this.markSteerCalled()
    return new Promise<void>((_resolve, reject) => {
      this.rejectSteer = reject
    })
  }

  releaseSteer(): void {
    this.rejectSteer(new Error('Fixture steer interrupted by deletion'))
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'idle' }
  }

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    return 'unexpected-start'
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class DeletionCodex extends EventEmitter {
  readonly started: StartTurnOptions[] = []
  readonly steered: SteerTurnOptions[] = []
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly archived: string[] = []

  async startTurn(options: StartTurnOptions): Promise<string> {
    this.started.push(options)
    return 'unexpected-start'
  }

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    this.steered.push(options)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class StaleDeletionCodex extends EventEmitter {
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []
  readonly archived: string[] = []

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
    if (turnId === 'stale-turn') throw new Error('Fixture stale turn id')
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'active', activeTurnId: 'newer-automatic-turn' }
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
  }
}

class CommandOrderingCodex extends IngressCodex {
  readonly interrupted: Array<{ threadId: string; turnId: string }> = []

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupted.push({ threadId, turnId })
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

function makeSession(
  directory: string,
  discordThreadId = 'discord-thread',
  codexThreadId = 'codex-thread',
): SessionState {
  return {
    discordThreadId,
    parentChannelId: 'parent-1',
    directory,
    codexThreadId,
    model: 'gpt-test',
    effort: 'xhigh',
    activeTurnId: 'stale-turn',
    updatedAt: new Date(0).toISOString(),
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

function makeChannel(id: string, sent: string[] = []): ThreadChannel {
  return {
    id,
    name: id,
    parentId: 'parent-1',
    isThread: () => true,
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
  } as unknown as ThreadChannel
}

function makeMessage(options: {
  id: string
  content: string
  channel: ThreadChannel
  fetchReference?: () => Promise<unknown>
  attachments?: Array<{
    name: string
    contentType: string
    size: number
    url: string
  }>
}) {
  return {
    id: options.id,
    content: options.content,
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
    reference: options.fetchReference ? { messageId: 'referenced-message' } : null,
    async fetchReference() {
      if (!options.fetchReference) throw new Error('No referenced message')
      return options.fetchReference()
    },
  }
}

function clearRunTimers(internal: InternalBot): void {
  for (const run of internal.runs.values()) clearInterval(run.typingTimer)
  internal.runs.clear()
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition')
    await sleep(10)
  }
}

async function withTemporaryHome(run: (directory: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-runtime-recovery-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-runtime-recovery-project-'))
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

test('stale steer rejection against an idle runtime starts the same input as a new turn', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new ReconciliationCodex({ status: 'idle' })
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & { refreshProjectsSafely(): Promise<void> }
    internal.refreshProjectsSafely = async () => undefined
    internal.loadedThreads.add(session.codexThreadId)
    const staleRun = internal.startRun(session, channel)
    const input: UserInput[] = [{ type: 'text', text: 'Do not lose this prompt.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-idle')

      assert.deepEqual(codex.steered.map((attempt) => attempt.expectedTurnId), ['stale-turn'])
      assert.equal(codex.started.length, 1)
      assert.strictEqual(codex.started[0]?.input, input)
      assert.equal(codex.started[0]?.clientUserMessageId, 'message-idle')
      assert.equal(session.activeTurnId, 'replacement-turn')
      assert.notStrictEqual(internal.runs.get(session.codexThreadId), staleRun)
      assert.equal(internal.runs.get(session.codexThreadId)?.turnId, 'replacement-turn')
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('failed turn start reconciles the authoritative active turn after the notification wait', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new StartFailureCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const input: UserInput[] = [{ type: 'text', text: 'Recover this accepted input.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-start-failed')

      assert.equal(codex.started.length, 1)
      assert.strictEqual(codex.started[0]?.input, input)
      assert.ok(codex.runtimeReadAt - codex.startFailedAt >= 950)
      assert.deepEqual(codex.steered.map((attempt) => attempt.expectedTurnId), [
        'authoritative-start-turn',
      ])
      assert.strictEqual(codex.steered[0]?.input, input)
      assert.equal(codex.steered[0]?.clientUserMessageId, 'message-start-failed')
      assert.equal(session.activeTurnId, 'authoritative-start-turn')
      assert.equal(internal.runs.get(session.codexThreadId)?.turnId, 'authoritative-start-turn')
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('accepted turn start with a lost response is not delivered again', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new AcceptedStartLossCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const input: UserInput[] = [{ type: 'text', text: 'Deliver this once.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-start-loss')

      assert.equal(codex.started.length, 1)
      assert.equal(codex.steered.length, 0)
      assert.equal(session.activeTurnId, 'accepted-start-turn')
      assert.equal(internal.runs.get(session.codexThreadId)?.turnId, 'accepted-start-turn')
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('accepted turn steer with a lost response is not delivered again', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new ReconciliationCodex({
      status: 'active',
      activeTurnId: 'stale-turn',
      userMessageClientIds: ['message-steer-loss'],
    })
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    internal.startRun(session, channel)
    const input: UserInput[] = [{ type: 'text', text: 'Steer this once.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-steer-loss')

      assert.equal(codex.steered.length, 1)
      assert.equal(codex.started.length, 0)
      assert.equal(session.activeTurnId, 'stale-turn')
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('reconciliation loss retries exact input as a new turn within the delivery bound', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new ReconcileLossCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const input: UserInput[] = [{ type: 'text', text: 'Deliver exactly once after the race.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-reconcile-loss')

      assert.equal(codex.runtimeReads, 3)
      assert.equal(codex.started.length, 2)
      assert.equal(codex.steered.length, 1)
      assert.equal(codex.steered[0]?.expectedTurnId, 'authoritative-turn-a')
      for (const attempt of [...codex.started, ...codex.steered]) {
        assert.strictEqual(attempt.input, input)
        assert.equal(attempt.clientUserMessageId, 'message-reconcile-loss')
      }
      assert.equal(session.activeTurnId, 'replacement-after-reconciliation')
      assert.equal(
        internal.runs.get(session.codexThreadId)?.turnId,
        'replacement-after-reconciliation',
      )
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('lost queued steer response is confirmed before requeueing', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'queued-delivery',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Queued exactly once.', text_elements: [] }],
      displayText: 'Queued exactly once.',
      createdAt: new Date().toISOString(),
    }]
    const codex = new QueueDeliveryCodex(2)
    const sent: string[] = []
    const channel = makeChannel(session.discordThreadId, sent)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const run = internal.startRun(session, channel)
    run.turnId = 'stale-turn'

    try {
      await internal.steerNextQueuedPrompt(run)

      assert.equal(codex.steered.length, 1)
      assert.equal(state.queues[session.discordThreadId]?.length, 0)
      assert.equal(sent.filter((message) => message.includes('Queued exactly once.')).length, 1)
      assert.equal(sent.some((message) => message.includes('Queued prompt deferred')), false)
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('requeued steer is removed when delivery appears in later history', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'queued-delivery',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Delayed history delivery.', text_elements: [] }],
      displayText: 'Delayed history delivery.',
      createdAt: new Date().toISOString(),
    }]
    const codex = new QueueDeliveryCodex(3)
    const sent: string[] = []
    const channel = makeChannel(session.discordThreadId, sent)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const run = internal.startRun(session, channel)
    run.turnId = 'stale-turn'

    try {
      await internal.steerNextQueuedPrompt(run)
      assert.equal(codex.steered.length, 1)
      assert.equal(state.queues[session.discordThreadId]?.length, 1)

      await internal.steerNextQueuedPrompt(run)

      assert.equal(codex.steered.length, 1)
      assert.equal(state.queues[session.discordThreadId]?.length, 0)
      assert.equal(sent.filter((message) => message.includes('Delayed history delivery.')).length, 1)
      assert.equal(sent.filter((message) => message.includes('Queued prompt deferred')).length, 1)
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('queued prompt stays persisted until steer delivery is confirmed', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'persisted-during-steer',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Keep this durable.', text_elements: [] }],
      displayText: 'Keep this durable.',
      createdAt: new Date().toISOString(),
    }]
    const codex = new BlockingQueueDeliveryCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const run = internal.startRun(session, channel)
    run.turnId = 'stale-turn'

    const delivery = internal.steerNextQueuedPrompt(run)
    try {
      await codex.steerCalled
      assert.deepEqual(
        state.queues[session.discordThreadId]?.map((prompt) => prompt.id),
        ['persisted-during-steer'],
      )

      codex.releaseSteer()
      await delivery

      assert.equal(state.queues[session.discordThreadId]?.length, 0)
      assert.equal(codex.steered.length, 1)
    } finally {
      codex.releaseSteer()
      await delivery.catch(() => undefined)
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('queued message edit waits for in-flight delivery and cannot rewrite sent input', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const sourceMessageId = 'inflight-queue-message'
    const originalInput: UserInput[] = [{
      type: 'text',
      text: 'Original queued input.',
      text_elements: [],
    }]
    state.queues[session.discordThreadId] = [{
      id: sourceMessageId,
      authorId: 'user-1',
      authorName: 'Queue User',
      input: originalInput,
      displayText: 'Original queued input.',
      createdAt: new Date().toISOString(),
      sourceMessageId,
    }]
    const codex = new BlockingQueueDeliveryCodex()
    const sent: string[] = []
    const channel = makeChannel(session.discordThreadId, sent)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const run = internal.startRun(session, channel)
    run.turnId = 'stale-turn'
    const edited = makeMessage({
      id: sourceMessageId,
      content: 'Edited too late. queue',
      channel,
    })

    const delivery = internal.steerNextQueuedPrompt(run)
    try {
      await codex.steerCalled
      ;(bot.client as unknown as EventEmitter).emit('messageUpdate', edited, edited)
      await sleep(20)
      assert.equal(sent.some((message) => message.includes('Queue update')), false)

      codex.releaseSteer()
      await delivery
      await waitFor(() => sent.some((message) => message.includes('already delivered')))

      assert.strictEqual(codex.steered[0]?.input, originalInput)
      assert.equal(state.queues[session.discordThreadId]?.length, 0)
      assert.equal(sent.some((message) => message.includes('Queue updated: Edited too late')), false)
    } finally {
      codex.releaseSteer()
      await delivery.catch(() => undefined)
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('Discord ingress preserves MessageCreate order while the first reply preprocessing blocks', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new IngressCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      refreshProjectsSafely(): Promise<void>
      memberAllowed(userId: string): Promise<boolean>
    }
    internal.refreshProjectsSafely = async () => undefined
    internal.memberAllowed = async () => true
    internal.loadedThreads.add(session.codexThreadId)

    let releaseReference!: () => void
    let markReferenceStarted!: () => void
    const referenceStarted = new Promise<void>((resolve) => {
      markReferenceStarted = resolve
    })
    const first = makeMessage({
      id: 'message-first',
      content: 'First prompt.',
      channel,
      fetchReference: async () => {
        markReferenceStarted()
        await new Promise<void>((resolve) => {
          releaseReference = resolve
        })
        return {
          content: 'Earlier context.',
          cleanContent: 'Earlier context.',
          author: {
            id: 'reference-user',
            username: 'reference-user',
            displayName: 'Reference User',
          },
        }
      },
    })
    const second = makeMessage({
      id: 'message-second',
      content: 'Second prompt.',
      channel,
    })

    try {
      ;(bot.client as unknown as EventEmitter).emit('messageCreate', first)
      await referenceStarted
      ;(bot.client as unknown as EventEmitter).emit('messageCreate', second)
      await sleep(20)
      assert.equal(codex.steered.length, 0)

      releaseReference()
      await waitFor(() => codex.steered.length === 2)

      assert.deepEqual(
        codex.steered.map((attempt) => attempt.clientUserMessageId),
        ['message-first', 'message-second'],
      )
      assert.match(
        codex.steered[0]?.input[0]?.type === 'text' ? codex.steered[0].input[0].text : '',
        /First prompt\./,
      )
      assert.equal(
        codex.steered[1]?.input[0]?.type === 'text' ? codex.steered[1].input[0].text : '',
        'Second prompt.',
      )
    } finally {
      releaseReference()
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('queued MessageUpdate waits for blocked create preprocessing and replaces the original', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new IngressCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      refreshProjectsSafely(): Promise<void>
      memberAllowed(userId: string): Promise<boolean>
    }
    internal.refreshProjectsSafely = async () => undefined
    internal.memberAllowed = async () => true
    internal.loadedThreads.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel | undefined> }).fetch =
      async (id: string) => id === session.discordThreadId ? channel : undefined

    let releaseReference!: () => void
    let markReferenceStarted!: () => void
    const referenceStarted = new Promise<void>((resolve) => {
      markReferenceStarted = resolve
    })
    const created = makeMessage({
      id: 'queued-source-message',
      content: 'Original queued prompt. queue',
      channel,
      fetchReference: async () => {
        markReferenceStarted()
        await new Promise<void>((resolve) => {
          releaseReference = resolve
        })
        return {
          content: 'Earlier context.',
          cleanContent: 'Earlier context.',
          author: {
            id: 'reference-user',
            username: 'reference-user',
            displayName: 'Reference User',
          },
        }
      },
    })
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const edited = makeMessage({
      id: created.id,
      content: 'Edited queued prompt. queue',
      channel,
      fetchReference: async () => ({
        content: 'Updated reply context.',
        cleanContent: 'Updated reply context.',
        author: {
          id: 'edited-reference-user',
          username: 'edited-reference-user',
          displayName: 'Edited Reference User',
        },
      }),
      attachments: [
        {
          name: 'notes.txt',
          contentType: 'text/plain',
          size: 17,
          url: 'data:text/plain,updated%20attachment',
        },
        {
          name: 'screen.png',
          contentType: 'image/png',
          size: imageBytes.length,
          url: `data:image/png;base64,${imageBytes.toString('base64')}`,
        },
      ],
    })

    try {
      ;(bot.client as unknown as EventEmitter).emit('messageCreate', created)
      await referenceStarted
      ;(bot.client as unknown as EventEmitter).emit('messageUpdate', created, edited)
      await sleep(20)
      assert.equal(state.queues[session.discordThreadId], undefined)

      releaseReference()
      await waitFor(() => state.queues[session.discordThreadId]?.[0]?.displayText === 'Edited queued prompt')

      assert.equal(state.queues[session.discordThreadId]?.length, 1)
      assert.equal(state.queues[session.discordThreadId]?.[0]?.sourceMessageId, created.id)
      const rebuiltInput = state.queues[session.discordThreadId]?.[0]?.input || []
      assert.equal(rebuiltInput.length, 2)
      const rebuiltText = rebuiltInput[0]?.type === 'text' ? rebuiltInput[0].text : ''
      assert.match(rebuiltText, /Reply context from Edited Reference User/)
      assert.match(rebuiltText, /> Updated reply context\./)
      assert.match(rebuiltText, /Current Discord message:\nEdited queued prompt/)
      assert.match(rebuiltText, /Discord attachment "notes\.txt"/)
      assert.match(rebuiltText, /updated attachment/)
      assert.equal(rebuiltInput[1]?.type, 'localImage')
      const rebuiltImagePath = rebuiltInput[1]?.type === 'localImage' ? rebuiltInput[1].path : ''
      assert.deepEqual(await readFile(rebuiltImagePath), imageBytes)
      assert.equal(codex.steered.length, 0)
    } finally {
      releaseReference()
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('ThreadDelete deletes a newly started Codex thread before its first turn', async () => {
  await withTemporaryHome(async (directory) => {
    const state = makeState([])
    const codex = new EmptyThreadDeletionCodex()
    const channel = makeChannel('new-discord-thread')
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    const input: UserInput[] = [{ type: 'text', text: 'Never materialize this.', text_elements: [] }]

    const dispatch = internal.discordIngressQueue.run(
      channel.id,
      () => internal.dispatchInputUnlocked(
        channel,
        'parent-1',
        input,
        'empty-thread-message',
      ),
    )
    try {
      await codex.startCalled
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: channel.id })
      codex.releaseStart()

      await assert.rejects(dispatch, /Discord thread was deleted/)
      assert.deepEqual(codex.deleted, ['empty-codex-thread'])
      assert.deepEqual(codex.archived, [])
      assert.equal(state.sessions[channel.id], undefined)
    } finally {
      codex.releaseStart()
      await dispatch.catch(() => undefined)
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('ThreadDelete reconciles and interrupts an accepted start with a lost response', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new PendingStartCodex({
      status: 'active',
      activeTurnId: 'accepted-deleted-turn',
      userMessageClientIds: ['deleted-start-message'],
    })
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const input: UserInput[] = [{ type: 'text', text: 'Delete during start.', text_elements: [] }]

    const dispatch = internal.discordIngressQueue.run(
      channel.id,
      () => internal.dispatchInputUnlocked(
        channel,
        session.parentChannelId,
        input,
        'deleted-start-message',
      ),
    )
    try {
      await codex.startCalled
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: session.discordThreadId })
      assert.deepEqual(codex.interrupted, [])

      codex.fail()
      await assert.rejects(dispatch, /lost the response/)
      await waitFor(() => state.sessions[session.discordThreadId] === undefined)

      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'accepted-deleted-turn',
      }])
      assert.deepEqual(codex.archived, [session.codexThreadId])
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('ThreadDelete after an interrupted steer cannot start a replacement turn', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new DeletedSteerCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    internal.startRun(session, channel)
    const input: UserInput[] = [{ type: 'text', text: 'Do not restart after deletion.', text_elements: [] }]

    const dispatch = internal.discordIngressQueue.run(
      channel.id,
      () => internal.dispatchInputUnlocked(
        channel,
        session.parentChannelId,
        input,
        'deleted-steer-message',
      ),
    )
    try {
      await codex.steerCalled
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: session.discordThreadId })
      await waitFor(() => codex.interrupted.length === 1)

      codex.releaseSteer()
      await assert.rejects(dispatch, /Discord thread was deleted/)
      await waitFor(() => state.sessions[session.discordThreadId] === undefined)

      assert.equal(codex.started.length, 0)
      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'stale-turn',
      }])
      assert.deepEqual(codex.archived, [session.codexThreadId])
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('ThreadDelete retries a stale immediate interrupt against the authoritative turn', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new StaleDeletionCodex()
    const bot = new CordexDiscordBot(
      makeConfig(directory),
      state,
      codex as unknown as CodexAppServer,
    )
    const internal = bot as unknown as InternalBot

    try {
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: session.discordThreadId })
      await waitFor(() => state.sessions[session.discordThreadId] === undefined)

      assert.deepEqual(codex.interrupted, [
        { threadId: session.codexThreadId, turnId: 'stale-turn' },
        { threadId: session.codexThreadId, turnId: 'newer-automatic-turn' },
      ])
      assert.deepEqual(codex.archived, [session.codexThreadId])
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('ThreadDelete interrupts immediately and cleanup stays idempotent behind blocked ingress', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'existing-queued-message',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Existing queue entry.', text_elements: [] }],
      displayText: 'Existing queue entry.',
      createdAt: new Date().toISOString(),
    }]
    const codex = new DeletionCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      deletedDiscordThreads: Set<string>
      refreshProjectsSafely(): Promise<void>
      memberAllowed(userId: string): Promise<boolean>
    }
    internal.refreshProjectsSafely = async () => undefined
    internal.memberAllowed = async () => true
    internal.loadedThreads.add(session.codexThreadId)

    let releaseReference!: () => void
    let markReferenceStarted!: () => void
    const referenceStarted = new Promise<void>((resolve) => {
      markReferenceStarted = resolve
    })
    const message = makeMessage({
      id: 'message-deleted-thread',
      content: 'This prompt must never dispatch.',
      channel,
      fetchReference: async () => {
        markReferenceStarted()
        await new Promise<void>((resolve) => {
          releaseReference = resolve
        })
        return {
          content: 'Earlier context.',
          cleanContent: 'Earlier context.',
          author: {
            id: 'reference-user',
            username: 'reference-user',
            displayName: 'Reference User',
          },
        }
      },
    })
    const commandAcknowledgments: Array<{ ephemeral?: boolean }> = []
    const commandReplies: string[] = []
    const queuedCommand = {
      id: 'queued-before-delete',
      commandName: 'queue',
      channelId: session.discordThreadId,
      channel,
      guildId: 'guild-1',
      user: { id: 'user-1', displayName: 'Queue User' },
      options: {
        getString(name: string) {
          return name === 'message' ? 'Must not run after deletion.' : null
        },
      },
      deferred: false,
      replied: false,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      async deferReply(options?: { ephemeral?: boolean }) {
        this.deferred = true
        commandAcknowledgments.push(options || {})
      },
      async editReply(payload: string | { content: string }) {
        this.replied = true
        commandReplies.push(typeof payload === 'string' ? payload : payload.content)
      },
      async followUp(payload: string | { content: string }) {
        commandReplies.push(typeof payload === 'string' ? payload : payload.content)
      },
      async reply(payload: string | { content: string }) {
        this.replied = true
        commandReplies.push(typeof payload === 'string' ? payload : payload.content)
      },
    }

    try {
      ;(bot.client as unknown as EventEmitter).emit('messageCreate', message)
      await referenceStarted
      ;(bot.client as unknown as EventEmitter).emit('interactionCreate', queuedCommand)
      await waitFor(() => commandAcknowledgments.length === 1)
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: session.discordThreadId })
      ;(bot.client as unknown as EventEmitter).emit('threadDelete', { id: session.discordThreadId })
      assert.equal(internal.deletedDiscordThreads.has(session.discordThreadId), true)
      await waitFor(() => codex.interrupted.length === 1)
      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'stale-turn',
      }])

      releaseReference()
      await waitFor(() => commandReplies.length === 1)
      await waitFor(() => state.sessions[session.discordThreadId] === undefined)

      assert.deepEqual(commandReplies, ['⨯ Discord thread was deleted.'])
      assert.deepEqual(codex.steered, [])
      assert.deepEqual(codex.started, [])
      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'stale-turn',
      }])
      assert.deepEqual(codex.archived, [session.codexThreadId])
      assert.equal(state.queues[session.discordThreadId], undefined)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      await assert.rejects(
        internal.enqueuePrompt(session.discordThreadId, {
          id: 'late-scheduled-occurrence',
          authorId: 'user-1',
          authorName: 'scheduled task',
          input: [{ type: 'text', text: 'Must stay deleted.', text_elements: [] }],
          displayText: 'Must stay deleted.',
          createdAt: new Date().toISOString(),
        }),
        /Discord thread was deleted/,
      )
      assert.equal(state.queues[session.discordThreadId], undefined)
    } finally {
      releaseReference()
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('abort latches while turn start is pending and interrupts the materialized turn', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new PendingStartCodex({ status: 'idle' })
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      refreshProjectsSafely(): Promise<void>
    }
    internal.refreshProjectsSafely = async () => undefined
    internal.loadedThreads.add(session.codexThreadId)
    const input: UserInput[] = [{ type: 'text', text: 'Abort this pending start.', text_elements: [] }]
    const dispatch = internal.dispatchInputUnlocked(
      channel,
      session.parentChannelId,
      input,
      'pending-abort-message',
    )
    const acknowledgments: Array<{ ephemeral?: boolean }> = []
    const replies: string[] = []
    const responseState = { deferred: false, replied: false }
    const interaction = {
      id: 'abort-pending-start',
      commandName: 'abort',
      channelId: session.discordThreadId,
      channel,
      guildId: 'guild-1',
      user: { id: 'user-1', displayName: 'Abort User' },
      options: {},
      get deferred() {
        return responseState.deferred
      },
      get replied() {
        return responseState.replied
      },
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      async deferReply(options?: { ephemeral?: boolean }) {
        responseState.deferred = true
        acknowledgments.push(options || {})
      },
      async editReply(payload: string | { content: string }) {
        responseState.replied = true
        replies.push(typeof payload === 'string' ? payload : payload.content)
      },
      async followUp(payload: string | { content: string }) {
        replies.push(typeof payload === 'string' ? payload : payload.content)
      },
      async reply(payload: string | { content: string }) {
        responseState.replied = true
        replies.push(typeof payload === 'string' ? payload : payload.content)
      },
    }

    try {
      await codex.startCalled
      ;(bot.client as unknown as EventEmitter).emit('interactionCreate', interaction)
      await waitFor(() => replies.length === 1)

      assert.deepEqual(acknowledgments, [{}])
      assert.deepEqual(replies, ['Abort requested.'])
      assert.deepEqual(codex.interrupted, [])

      codex.succeed('materialized-after-abort')
      await dispatch

      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'materialized-after-abort',
      }])
      assert.equal(session.activeTurnId, undefined)
      assert.equal(internal.runs.size, 0)
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('prompt slash command waits behind MessageCreate while abort bypasses ingress', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new CommandOrderingCodex()
    const channel = makeChannel(session.discordThreadId)
    const config = makeConfig(directory)
    config.allowAllUsers = false
    config.allowedRoleIds = ['allowed-role']
    const bot = new CordexDiscordBot(config, state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      refreshProjectsSafely(): Promise<void>
      memberAllowed(userId: string): Promise<boolean>
    }
    internal.refreshProjectsSafely = async () => undefined
    let memberAllowedCalls = 0
    internal.memberAllowed = async () => {
      memberAllowedCalls += 1
      return true
    }
    internal.loadedThreads.add(session.codexThreadId)

    let releaseReference!: () => void
    let markReferenceStarted!: () => void
    const referenceStarted = new Promise<void>((resolve) => {
      markReferenceStarted = resolve
    })
    const message = makeMessage({
      id: 'message-before-command',
      content: 'Message prompt first.',
      channel,
      fetchReference: async () => {
        markReferenceStarted()
        await new Promise<void>((resolve) => {
          releaseReference = resolve
        })
        return {
          content: 'Earlier context.',
          cleanContent: 'Earlier context.',
          author: {
            id: 'reference-user',
            username: 'reference-user',
            displayName: 'Reference User',
          },
        }
      },
    })
    const queueReplies: string[] = []
    const abortReplies: string[] = []
    const queueResponseMethods: string[] = []
    const abortResponseMethods: string[] = []
    const queueAcknowledgments: Array<{ ephemeral?: boolean }> = []
    const abortAcknowledgments: Array<{ ephemeral?: boolean }> = []
    const interaction = (
      commandName: 'queue' | 'abort',
      id: string,
      replies: string[],
      responseMethods: string[],
      acknowledgments: Array<{ ephemeral?: boolean }>,
    ) => {
      const responseState = { deferred: false, replied: false }
      return {
        id,
        commandName,
        channelId: session.discordThreadId,
        channel,
        guildId: 'guild-1',
        guild: { id: 'guild-1', ownerId: 'owner-1' },
        member: { roles: ['allowed-role'] },
        user: { id: 'user-1', displayName: 'Queue User' },
        options: {
          getString(name: string) {
            return name === 'message' ? 'Slash prompt second.' : null
          },
        },
        get deferred() {
          return responseState.deferred
        },
        get replied() {
          return responseState.replied
        },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        async deferReply(options?: { ephemeral?: boolean }) {
          responseState.deferred = true
          acknowledgments.push(options || {})
        },
        async editReply(payload: string | { content: string }) {
          responseState.replied = true
          responseMethods.push('editReply')
          replies.push(typeof payload === 'string' ? payload : payload.content)
        },
        async followUp(payload: string | { content: string }) {
          responseMethods.push('followUp')
          replies.push(typeof payload === 'string' ? payload : payload.content)
        },
        async reply(payload: string | { content: string }) {
          responseState.replied = true
          responseMethods.push('reply')
          replies.push(typeof payload === 'string' ? payload : payload.content)
        },
      }
    }

    try {
      ;(bot.client as unknown as EventEmitter).emit('messageCreate', message)
      await referenceStarted
      const memberAllowedCallsBeforeCommands = memberAllowedCalls
      ;(bot.client as unknown as EventEmitter).emit(
        'interactionCreate',
        interaction(
          'queue',
          'queue-interaction',
          queueReplies,
          queueResponseMethods,
          queueAcknowledgments,
        ),
      )
      ;(bot.client as unknown as EventEmitter).emit(
        'interactionCreate',
        interaction(
          'abort',
          'abort-interaction',
          abortReplies,
          abortResponseMethods,
          abortAcknowledgments,
        ),
      )
      await waitFor(() => queueAcknowledgments.length === 1)
      assert.equal(memberAllowedCalls, memberAllowedCallsBeforeCommands)
      await waitFor(() => codex.interrupted.length === 1)
      await sleep(20)

      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'stale-turn',
      }])
      assert.deepEqual(abortReplies, ['Abort requested.'])
      assert.deepEqual(abortResponseMethods, ['editReply'])
      assert.deepEqual(abortAcknowledgments, [{}])
      assert.deepEqual(queueAcknowledgments, [{}])
      assert.deepEqual(queueReplies, [])
      assert.deepEqual(queueResponseMethods, [])
      assert.equal(state.queues[session.discordThreadId], undefined)
      assert.equal(codex.steered.length, 0)

      releaseReference()
      await waitFor(() => codex.steered.length === 1)
      await waitFor(() => state.queues[session.discordThreadId]?.length === 1)
      await waitFor(() => queueReplies.length === 1)

      assert.equal(codex.steered[0]?.clientUserMessageId, message.id)
      assert.match(
        codex.steered[0]?.input[0]?.type === 'text' ? codex.steered[0].input[0].text : '',
        /Message prompt first\./,
      )
      assert.equal(state.queues[session.discordThreadId]?.[0]?.displayText, 'Slash prompt second.')
      assert.equal(state.queues[session.discordThreadId]?.[0]?.sourceMessageId, undefined)
      assert.deepEqual(queueReplies, ['Queued message (position 1)'])
      assert.deepEqual(queueResponseMethods, ['editReply'])
    } finally {
      releaseReference()
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('queued slash command denies access ephemerally without deferring or dispatching', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new CommandOrderingCodex()
    const channel = makeChannel(session.discordThreadId)
    const config = makeConfig(directory)
    config.allowAllUsers = false
    config.allowedRoleIds = ['allowed-role']
    const bot = new CordexDiscordBot(config, state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & {
      memberAllowed(userId: string): Promise<boolean>
    }
    internal.memberAllowed = async () => {
      throw new Error('Cached interaction access unexpectedly fetched the Discord member')
    }

    const replies: Array<{ content: string; ephemeral?: boolean }> = []
    let deferrals = 0
    const interaction = {
      commandName: 'queue',
      channelId: session.discordThreadId,
      channel,
      guildId: 'guild-1',
      guild: { id: 'guild-1', ownerId: 'owner-1' },
      member: { roles: ['other-role'] },
      user: { id: 'denied-user', displayName: 'Denied User' },
      options: {
        getString(name: string) {
          return name === 'message' ? 'Must not queue.' : null
        },
      },
      deferred: false,
      replied: false,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      async deferReply() {
        deferrals += 1
      },
      async reply(payload: { content: string; ephemeral?: boolean }) {
        replies.push(payload)
      },
    }

    try {
      ;(bot.client as unknown as EventEmitter).emit('interactionCreate', interaction)
      await waitFor(() => replies.length === 1)

      assert.deepEqual(replies, [{ content: 'Missing Cordex permission.', ephemeral: true }])
      assert.equal(deferrals, 0)
      assert.equal(state.queues[session.discordThreadId], undefined)
      assert.deepEqual(codex.steered, [])
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('stale steer rejection retries with the authoritative active turn id', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new ReconciliationCodex({ status: 'active', activeTurnId: 'authoritative-turn' })
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    const staleRun = internal.startRun(session, channel)
    const input: UserInput[] = [{ type: 'text', text: 'Steer this exact prompt.', text_elements: [] }]

    try {
      await internal.dispatchInputUnlocked(channel, session.parentChannelId, input, 'message-active')

      assert.deepEqual(
        codex.steered.map((attempt) => attempt.expectedTurnId),
        ['stale-turn', 'authoritative-turn'],
      )
      assert.strictEqual(codex.steered[1]?.input, input)
      assert.equal(codex.steered[1]?.clientUserMessageId, 'message-active')
      assert.equal(codex.started.length, 0)
      assert.equal(session.activeTurnId, 'authoritative-turn')
      assert.strictEqual(internal.runs.get(session.codexThreadId), staleRun)
      assert.equal(staleRun.turnId, 'authoritative-turn')
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('child failure generation barrier drops a queued stale turn notification', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    delete session.activeTurnId
    const state = makeState([session])
    const codex = new LifecycleCodex()
    const channel = makeChannel(session.discordThreadId)
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel | undefined> }).fetch =
      async (id: string) => id === session.discordThreadId ? channel : undefined

    let releaseBlocker!: () => void
    let markBlockerStarted!: () => void
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve
    })
    const blocker = internal.codexEventQueue.run(session.codexThreadId, async () => {
      markBlockerStarted()
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve
      })
    })

    try {
      await blockerStarted
      codex.emit('notification', {
        method: 'turn/started',
        params: {
          threadId: session.codexThreadId,
          turn: {
            id: 'stale-child-turn',
            status: 'inProgress',
            startedAt: Date.now() / 1_000,
          },
        },
      })
      codex.emit('childFailure', new Error('fixture child exited'))
      releaseBlocker()
      await blocker
      await sleep(20)

      assert.equal(session.activeTurnId, undefined)
      assert.equal(internal.runs.size, 0)
    } finally {
      releaseBlocker()
      await blocker
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('startup prunes a persisted session whose Discord thread was deleted offline', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    state.queues[session.discordThreadId] = [{
      id: 'orphaned-queue',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: [{ type: 'text', text: 'Never resume this.', text_elements: [] }],
      displayText: 'Never resume this.',
      createdAt: new Date().toISOString(),
    }]
    state.tasks['orphaned-task'] = {
      id: 'orphaned-task',
      threadId: session.discordThreadId,
      prompt: 'Never schedule this.',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: 'user-1',
      status: 'scheduled',
    }
    const codex = new OrphanRecoveryCodex()
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot
    internal.loadedThreads.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<never> }).fetch = async () => {
      throw { code: 10_003 }
    }

    try {
      await internal.pruneOrphanedState()

      assert.deepEqual(codex.interrupted, [{
        threadId: session.codexThreadId,
        turnId: 'offline-active-turn',
      }])
      assert.deepEqual(codex.archived, [session.codexThreadId])
      assert.equal(state.sessions[session.discordThreadId], undefined)
      assert.equal(state.queues[session.discordThreadId], undefined)
      assert.equal(state.tasks['orphaned-task'], undefined)
      assert.equal(internal.loadedThreads.has(session.codexThreadId), false)
      assert.equal(internal.deletedDiscordThreads.has(session.discordThreadId), true)
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('app-server lifecycle events clear stale state then resume goals and queued work once', async () => {
  await withTemporaryHome(async (directory) => {
    const goalSession = makeSession(directory, 'discord-goal', 'codex-goal')
    const queuedSession = makeSession(directory, 'discord-queued', 'codex-queued')
    const state = makeState([goalSession, queuedSession])
    const queuedInput: UserInput[] = [{ type: 'text', text: 'Run after recovery.', text_elements: [] }]
    state.queues[queuedSession.discordThreadId] = [{
      id: 'queued-message',
      authorId: 'user-1',
      authorName: 'Queue User',
      input: queuedInput,
      displayText: 'Run after recovery.',
      createdAt: new Date().toISOString(),
    }]
    const codex = new LifecycleCodex()
    const sent = new Map<string, string[]>([
      [goalSession.discordThreadId, []],
      [queuedSession.discordThreadId, []],
    ])
    const channels = new Map<string, ThreadChannel>([
      [goalSession.discordThreadId, makeChannel(goalSession.discordThreadId, sent.get(goalSession.discordThreadId))],
      [queuedSession.discordThreadId, makeChannel(queuedSession.discordThreadId, sent.get(queuedSession.discordThreadId))],
    ])
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    const internal = bot as unknown as InternalBot & { refreshProjectsSafely(): Promise<void> }
    internal.refreshProjectsSafely = async () => undefined
    internal.loadedThreads.add(goalSession.codexThreadId)
    internal.loadedThreads.add(queuedSession.codexThreadId)
    internal.pendingTurnStarts.add(goalSession.codexThreadId)
    internal.startRun(goalSession, channels.get(goalSession.discordThreadId)!)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel | undefined> }).fetch =
      async (id: string) => channels.get(id)

    try {
      codex.emit('restarting', {
        attempt: 1,
        delayMs: 5,
        error: new Error('fixture app-server exit'),
      })
      await waitFor(() => (sent.get(goalSession.discordThreadId) || []).some(
        (message) => message.includes('runtime stopped unexpectedly'),
      ))

      assert.equal(internal.loadedThreads.size, 0)
      assert.equal(internal.pendingTurnStarts.size, 0)
      assert.equal(internal.runs.size, 0)
      assert.equal(goalSession.activeTurnId, undefined)
      assert.equal(queuedSession.activeTurnId, undefined)

      codex.emit('ready', { restartAttempt: 1 })
      await waitFor(() => codex.started.length === 1)
      await waitFor(() => [...sent.values()].every(
        (messages) => messages.filter((message) => message === '✓ Codex runtime recovered.').length === 1,
      ))

      assert.ok(codex.resumed.includes(goalSession.codexThreadId))
      assert.ok(codex.resumed.includes(queuedSession.codexThreadId))
      assert.strictEqual(codex.started[0]?.input, queuedInput)
      assert.equal(state.queues[queuedSession.discordThreadId]?.length, 0)
      assert.equal(queuedSession.activeTurnId, 'recovered-queued-turn')
      assert.equal(
        (sent.get(goalSession.discordThreadId) || [])
          .filter((message) => message.includes('runtime stopped unexpectedly')).length,
        1,
      )
      assert.equal(
        (sent.get(goalSession.discordThreadId) || [])
          .filter((message) => message === '✓ Codex runtime recovered.').length,
        1,
      )
      assert.equal(
        (sent.get(queuedSession.discordThreadId) || [])
          .filter((message) => message === '✓ Codex runtime recovered.').length,
        1,
      )
    } finally {
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})

test('terminal app-server failure without restarting clears runtime state before reporting', async () => {
  await withTemporaryHome(async (directory) => {
    const session = makeSession(directory)
    const state = makeState([session])
    const codex = new LifecycleCodex()
    const lifecycle: string[] = []
    const sent: string[] = []
    let reportSnapshot: {
      runs: number
      activeTurnId?: string
      actionButtons: number
      requestControls: number
    } | undefined
    let internal!: InternalBot & {
      pendingActionButtons: Map<string, unknown>
      pendingRequestControls: Map<string, unknown>
    }
    const channel = {
      id: session.discordThreadId,
      name: session.discordThreadId,
      parentId: session.parentChannelId,
      isThread: () => true,
      async sendTyping() {},
      async send(payload: string | { content?: string }) {
        const content = typeof payload === 'string' ? payload : payload.content || ''
        if (content.includes('runtime recovery failed')) {
          reportSnapshot = {
            runs: internal.runs.size,
            ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
            actionButtons: internal.pendingActionButtons.size,
            requestControls: internal.pendingRequestControls.size,
          }
          lifecycle.push('failure-reported')
        }
        sent.push(content)
        return { content, async edit() { return this } }
      },
    } as unknown as ThreadChannel
    const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
    internal = bot as unknown as typeof internal
    internal.loadedThreads.add(session.codexThreadId)
    internal.pendingTurnStarts.add(session.codexThreadId)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel | undefined> }).fetch =
      async (id: string) => id === session.discordThreadId ? channel : undefined

    let runTicks = 0
    const typingTimer = setInterval(() => {
      runTicks += 1
    }, 5)
    typingTimer.unref()
    internal.runs.set(session.codexThreadId, {
      session,
      channel,
      model: 'gpt-test',
      effort: 'xhigh',
      turnId: session.activeTurnId,
      startedAt: Date.now(),
      agentText: new Map(),
      typingTimer,
    } as unknown as InternalRun)

    let controlTimeoutFired = false
    const controlTimeout = setTimeout(() => {
      controlTimeoutFired = true
    }, 25)
    controlTimeout.unref()
    const controlMessage = {
      content: '**Action Required**',
      async edit(payload: { content: string; components: unknown[] }) {
        assert.deepEqual(payload.components, [])
        lifecycle.push('control-retired')
        this.content = payload.content
        return this
      },
    }
    const request = {
      id: 'terminal-control',
      method: 'item/tool/call',
      params: {
        threadId: session.codexThreadId,
        turnId: session.activeTurnId,
        tool: 'cordex_action_buttons',
      },
    }
    internal.pendingActionButtons.set('terminal-action', {
      request,
      threadId: session.codexThreadId,
      channel,
      buttons: [],
      message: controlMessage,
      timeout: controlTimeout,
    })
    internal.pendingRequestControls.set('string:terminal-control', {
      kind: 'actionButtons',
      key: 'terminal-action',
      threadId: session.codexThreadId,
    })

    try {
      codex.emit('failed', new Error('terminal fixture failure'))
      await waitFor(() => sent.some((message) => message.includes('runtime recovery failed')))
      const ticksAfterCleanup = runTicks
      await sleep(35)

      assert.deepEqual(lifecycle, ['control-retired', 'failure-reported'])
      assert.deepEqual(reportSnapshot, {
        runs: 0,
        actionButtons: 0,
        requestControls: 0,
      })
      assert.equal(internal.loadedThreads.size, 0)
      assert.equal(internal.pendingTurnStarts.size, 0)
      assert.equal(internal.runs.size, 0)
      assert.equal(session.activeTurnId, undefined)
      assert.equal(controlTimeoutFired, false)
      assert.equal(runTicks, ticksAfterCleanup)
      assert.equal(sent.filter((message) => message.includes('runtime recovery failed')).length, 1)
      assert.equal(sent.some((message) => message.includes('stopped unexpectedly')), false)
    } finally {
      clearInterval(typingTimer)
      clearTimeout(controlTimeout)
      clearRunTimers(internal)
      bot.client.destroy()
    }
  })
})
