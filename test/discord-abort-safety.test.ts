import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import type {
  CodexAppServer,
  CodexThreadGoal,
  CodexThreadRuntimeState,
  SetThreadGoalOptions,
} from '../src/codex-app-server.js'
import { emptyState, loadState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  QueuedPrompt,
  ServerNotification,
  SessionState,
  UserInput,
} from '../src/types.js'

class AbortCodex extends EventEmitter {
  readonly events: string[] = []
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  goal: CodexThreadGoal | null = null
  runtime: CodexThreadRuntimeState = { status: 'idle' }
  interruptError?: Error
  runtimeError?: Error
  onGoalRead?: () => Promise<void>

  async getThreadGoal(): Promise<CodexThreadGoal | null> {
    this.events.push('goal:get')
    await this.onGoalRead?.()
    return this.goal
  }

  async setThreadGoal(_threadId: string, update: SetThreadGoalOptions): Promise<CodexThreadGoal> {
    this.events.push(`goal:set:${update.status || ''}`)
    assert.ok(this.goal)
    this.goal = { ...this.goal, ...(update.status ? { status: update.status } : {}) }
    return this.goal
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    this.events.push('runtime:get')
    if (this.runtimeError) throw this.runtimeError
    return this.runtime
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.events.push(`interrupt:${turnId}`)
    this.interrupts.push({ threadId, turnId })
    if (this.interruptError) throw this.interruptError
    this.runtime = { status: 'idle' }
  }
}

class RejectingStartAbortCodex extends AbortCodex {
  readonly startCalled: Promise<void>
  private resolveStartCalled!: () => void
  private rejectStart!: (error: Error) => void
  startCount = 0

  constructor() {
    super()
    this.startCalled = new Promise<void>((resolve) => {
      this.resolveStartCalled = resolve
    })
  }

  async startTurn(): Promise<string> {
    this.startCount += 1
    this.resolveStartCalled()
    return new Promise<string>((_resolve, reject) => {
      this.rejectStart = reject
    })
  }

  failStart(): void {
    this.rejectStart(new Error('start response lost'))
  }
}

type TestRun = {
  session: SessionState
  channel: ThreadChannel
  model: string
  requestedModel: string
  effort: string
  turnId: string
  startedAt: number
  agentText: Map<string, string>
  typingTimer: NodeJS.Timeout
}

type InternalBot = {
  runs: Map<string, TestRun>
  loadedThreads: Set<string>
  pendingTurnStarts: Set<string>
  handleAbortCommand(interaction: ChatInputCommandInteraction): Promise<void>
  reconcileAbortIntents(expectedGeneration?: number): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
  ): Promise<void>
  steerNextQueuedPromptUnlocked(run: TestRun): Promise<void>
}

function makeConfig(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory } },
  }
}

function makeSession(directory: string): SessionState {
  return {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-1',
    activeTurnId: 'turn-1',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function makeState(session: SessionState, queuedPrompt?: QueuedPrompt): CordexState {
  const state = emptyState()
  state.sessions[session.discordThreadId] = session
  if (queuedPrompt) state.queues[session.discordThreadId] = [queuedPrompt]
  return state
}

function makeChannel(session: SessionState): ThreadChannel {
  return {
    id: session.discordThreadId,
    name: 'abort-safety',
    isThread: () => true,
    async send() {},
    async sendTyping() {},
  } as unknown as ThreadChannel
}

function makeRun(session: SessionState, channel: ThreadChannel): TestRun {
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  return {
    session,
    channel,
    model: 'fixture-model',
    requestedModel: 'fixture-model',
    effort: 'medium',
    turnId: session.activeTurnId || 'turn-1',
    startedAt: Date.now(),
    agentText: new Map(),
    typingTimer,
  }
}

async function withHarness(
  run: (fixture: {
    home: string
    bot: CordexDiscordBot
    internal: InternalBot
    codex: AbortCodex
    state: CordexState
    session: SessionState
    channel: ThreadChannel
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-abort-safety-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session = makeSession(home)
  const state = makeState(session)
  const codex = new AbortCodex()
  const channel = makeChannel(session)
  const bot = new CordexDiscordBot(makeConfig(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  Object.defineProperty(bot.client.channels, 'fetch', {
    configurable: true,
    value: async (channelId: string) => channelId === channel.id ? channel : undefined,
  })
  try {
    await run({ home, bot, internal, codex, state, session, channel })
  } finally {
    for (const active of internal.runs.values()) clearInterval(active.typingTimer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
}

function abortInteraction(channel: ThreadChannel, replies: string[]): ChatInputCommandInteraction {
  return {
    channel,
    async reply(payload: string | { content: string }) {
      replies.push(typeof payload === 'string' ? payload : payload.content)
    },
  } as unknown as ChatInputCommandInteraction
}

test('abort intent is durable before goal pause and interruption, then clears after idle proof', async () => {
  await withHarness(async ({ internal, codex, session, channel }) => {
    codex.goal = {
      threadId: session.codexThreadId,
      objective: 'Keep working',
      status: 'active',
      tokensUsed: 1,
      timeUsedSeconds: 1,
    }
    codex.runtime = { status: 'active', activeTurnId: 'turn-1' }
    codex.onGoalRead = async () => {
      assert.deepEqual((await loadState()).sessions[session.discordThreadId]?.abortIntent, {
        requestedAt: session.abortIntent?.requestedAt,
        turnId: 'turn-1',
      })
    }
    const replies: string[] = []

    await internal.handleAbortCommand(abortInteraction(channel, replies))

    assert.deepEqual(codex.events, [
      'goal:get',
      'goal:set:paused',
      'interrupt:turn-1',
      'runtime:get',
    ])
    assert.equal(codex.goal?.status, 'paused')
    assert.equal(session.abortIntent, undefined)
    assert.equal(session.activeTurnId, undefined)
    assert.equal((await loadState()).sessions[session.discordThreadId]?.abortIntent, undefined)
    assert.deepEqual(replies, ['Abort requested.'])
  })
})

test('abort intent survives interrupt failure and reports confirmation pending', async () => {
  await withHarness(async ({ internal, codex, session, channel }) => {
    codex.goal = null
    codex.runtime = { status: 'active', activeTurnId: 'turn-1' }
    codex.interruptError = new Error('interrupt transport failed')
    const replies: string[] = []

    await internal.handleAbortCommand(abortInteraction(channel, replies))

    assert.ok(session.abortIntent)
    assert.ok((await loadState()).sessions[session.discordThreadId]?.abortIntent)
    assert.match(replies[0] || '', /confirmation pending/i)
    assert.match(replies[0] || '', /interrupt transport failed/i)
  })
})

test('abort intent survives runtime query failure and reports confirmation pending', async () => {
  await withHarness(async ({ internal, codex, session, channel }) => {
    codex.goal = null
    codex.runtimeError = new Error('runtime query failed')
    const replies: string[] = []

    await internal.handleAbortCommand(abortInteraction(channel, replies))

    assert.ok(session.abortIntent)
    assert.ok((await loadState()).sessions[session.discordThreadId]?.abortIntent)
    assert.match(replies[0] || '', /confirmation pending/i)
    assert.match(replies[0] || '', /runtime query failed/i)
  })
})

test('pending abort blocks new dispatch and queued steering', async () => {
  await withHarness(async ({ internal, codex, state, session, channel }) => {
    session.abortIntent = {
      requestedAt: '2026-08-01T00:01:00.000Z',
      turnId: 'turn-1',
    }
    const prompt: QueuedPrompt = {
      id: 'queued-1',
      authorId: 'user-1',
      authorName: 'Fixture User',
      input: [{ type: 'text', text: 'Do not steer this.', text_elements: [] }],
      displayText: 'Do not steer this.',
      createdAt: '2026-08-01T00:01:01.000Z',
      deliveryKind: 'queued',
    }
    state.queues[channel.id] = [prompt]
    const run = makeRun(session, channel)
    internal.runs.set(session.codexThreadId, run)

    await assert.rejects(
      internal.dispatchInputUnlocked(
        channel,
        session.parentChannelId,
        [{ type: 'text', text: 'Do not dispatch this.', text_elements: [] }],
        'direct-1',
      ),
      /abort is still pending/i,
    )
    await internal.steerNextQueuedPromptUnlocked(run)

    assert.deepEqual(state.queues[channel.id], [prompt])
    assert.deepEqual(codex.events, [])
    clearInterval(run.typingTimer)
    internal.runs.delete(session.codexThreadId)
  })
})

test('startup reconciliation pauses the goal, interrupts the runtime turn, and clears the intent', async () => {
  await withHarness(async ({ internal, codex, session, channel }) => {
    session.abortIntent = {
      requestedAt: '2026-08-01T00:01:00.000Z',
      turnId: 'turn-1',
    }
    codex.goal = {
      threadId: session.codexThreadId,
      objective: 'Keep working',
      status: 'active',
      tokensUsed: 1,
      timeUsedSeconds: 1,
    }
    codex.runtime = { status: 'active', activeTurnId: 'turn-1' }
    const run = makeRun(session, channel)
    internal.runs.set(session.codexThreadId, run)

    await internal.reconcileAbortIntents()

    assert.equal(codex.goal.status, 'paused')
    assert.deepEqual(codex.interrupts, [{
      threadId: session.codexThreadId,
      turnId: 'turn-1',
    }])
    assert.equal(session.abortIntent, undefined)
    assert.equal(session.activeTurnId, undefined)
    assert.equal(internal.runs.size, 0)
  })
})

test('turn start notification reconciles a persisted abort before queue steering', async () => {
  await withHarness(async ({ internal, codex, state, session }) => {
    delete session.activeTurnId
    session.abortIntent = {
      requestedAt: '2026-08-01T00:01:00.000Z',
    }
    state.queues[session.discordThreadId] = [{
      id: 'queued-after-start',
      authorId: 'user-1',
      authorName: 'Fixture User',
      input: [{ type: 'text', text: 'Must remain queued.', text_elements: [] }],
      displayText: 'Must remain queued.',
      createdAt: '2026-08-01T00:01:01.000Z',
      deliveryKind: 'queued',
    }]
    codex.runtime = { status: 'active', activeTurnId: 'replacement-turn' }

    await internal.handleNotification({
      method: 'turn/started',
      params: {
        threadId: session.codexThreadId,
        turn: { id: 'replacement-turn', startedAt: Date.now() / 1_000 },
      },
    })

    assert.deepEqual(codex.interrupts, [{
      threadId: session.codexThreadId,
      turnId: 'replacement-turn',
    }])
    assert.equal(session.abortIntent, undefined)
    assert.deepEqual(state.queues[session.discordThreadId]?.map((prompt) => prompt.id), [
      'queued-after-start',
    ])
  })
})

test('a rejected pending start after abort is not retried or adopted', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-abort-rejected-start-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session = makeSession(home)
  delete session.activeTurnId
  const state = makeState(session)
  const codex = new RejectingStartAbortCodex()
  const channel = makeChannel(session)
  const bot = new CordexDiscordBot(makeConfig(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  internal.loadedThreads.add(session.codexThreadId)
  const replies: string[] = []

  try {
    const dispatch = internal.dispatchInputUnlocked(
      channel,
      session.parentChannelId,
      [{ type: 'text', text: 'Start once.', text_elements: [] }],
      'pending-start-message',
    )
    await codex.startCalled

    await internal.handleAbortCommand(abortInteraction(channel, replies))
    assert.ok(session.abortIntent)
    codex.failStart()
    await dispatch

    assert.equal(codex.startCount, 1)
    assert.equal(session.activeTurnId, undefined)
    assert.equal(session.abortIntent, undefined)
    assert.equal(internal.runs.has(session.codexThreadId), false)
    assert.equal((await loadState()).sessions[session.discordThreadId]?.abortIntent, undefined)
    assert.deepEqual(replies, ['Abort requested.'])
  } finally {
    for (const active of internal.runs.values()) clearInterval(active.typingTimer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
