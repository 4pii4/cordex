import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer, type CodexThreadRuntimeState } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import {
  formatAssistantText,
  splitMarkdownForDiscord,
} from '../src/discord-output.js'
import type { CordexConfig, CordexState, SessionState } from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly steered: Array<{
    threadId: string
    expectedTurnId: string
    input: unknown[]
    clientUserMessageId?: string
  }> = []
  goalStatus: string | null = null
  private nextTurn = 0

  async steerTurn(options: {
    threadId: string
    expectedTurnId: string
    input: unknown[]
    clientUserMessageId?: string
  }): Promise<void> {
    this.steered.push(options)
  }

  async getThreadGoal(_threadId: string): Promise<unknown> {
    return this.goalStatus
      ? {
          threadId: 'fixture-thread',
          objective: 'fixture goal',
          status: this.goalStatus,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        }
      : null
  }

  async startTurn(_options: { threadId: string }): Promise<string> {
    this.nextTurn += 1
    return `fake-turn-${this.nextTurn}`
  }

  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'idle' }
  }

  async updateThreadSettings(): Promise<void> {}
}

class GoalRaceCodex extends FakeCodex {
  async getThreadRuntimeState(): Promise<CodexThreadRuntimeState> {
    return { status: 'active', activeTurnId: 'automatic-goal-turn' }
  }

  async startTurn(options: { threadId: string }): Promise<string> {
    queueMicrotask(() => {
      this.emit('notification', {
        method: 'turn/started',
        params: {
          threadId: options.threadId,
          turn: { id: 'automatic-goal-turn', status: 'inProgress', startedAt: Date.now() / 1_000 },
        },
      })
    })
    throw new Error('Thread already has an active turn')
  }
}

class RestartGoalCodex extends FakeCodex {
  readonly calls: string[] = []
  goalUpdate: Record<string, unknown> | undefined
  private goal: {
    threadId: string
    objective: string
    status: string
    tokensUsed: number
    timeUsedSeconds: number
  } | undefined

  async resumeThread(): Promise<{ turns: [] }> {
    this.calls.push('resume')
    return { turns: [] }
  }

  async setThreadGoal(_threadId: string, update: Record<string, unknown>) {
    this.calls.push('set-goal')
    this.goalUpdate = update
    this.goal = {
      threadId: 'codex-thread-restart-goal',
      objective: String(update.objective || this.goal?.objective || 'existing goal'),
      status: String(update.status || this.goal?.status || 'active'),
      tokensUsed: 0,
      timeUsedSeconds: 0,
    }
    return this.goal
  }

  async getThreadGoal() {
    this.calls.push('get-goal')
    return this.goal
  }
}

class QueueDrainCodex extends FakeCodex {
  startCalls = 0

  async startTurn(options: { threadId: string }): Promise<string> {
    this.startCalls += 1
    const turnId = `queued-turn-${this.startCalls}`
    setTimeout(() => {
      this.emit('notification', {
        method: 'turn/started',
        params: {
          threadId: options.threadId,
          turn: { id: turnId, status: 'inProgress', startedAt: Date.now() / 1_000 },
        },
      })
    }, 0)
    return turnId
  }
}

class StartupGoalCodex extends FakeCodex {
  readonly resumed: string[] = []

  async getThreadGoal(threadId: string) {
    return {
      threadId,
      objective: `${threadId} objective`,
      status: threadId.endsWith('active') ? 'active' : 'paused',
      tokensUsed: 0,
      timeUsedSeconds: 0,
    }
  }

  async resumeThread(options: { threadId: string }): Promise<{ turns: [] }> {
    this.resumed.push(options.threadId)
    return { turns: [] }
  }
}

type InternalBot = {
  runs: Map<string, unknown>
}

type DispatchInternalBot = InternalBot & {
  loadedThreads: Set<string>
  dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: Array<{ type: 'text'; text: string; text_elements: [] }>,
    clientUserMessageId?: string,
  ): Promise<void>
}

type GoalInternalBot = InternalBot & {
  loadedThreads: Set<string>
  handleGoalCommand(interaction: ChatInputCommandInteraction): Promise<void>
  resumeActiveGoalSessions(): Promise<void>
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

function makeState(session: SessionState): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: { [session.discordThreadId]: session },
    queues: {},
    tasks: {},
  }
}

test('Codex notifications for a thread preserve Discord message order', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-order-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-order-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-1',
    model: 'gpt-test',
    effort: 'xhigh',
    activeTurnId: 'turn-1',
    updatedAt: new Date(0).toISOString(),
  }
  const state = makeState(session)
  const codex = new FakeCodex()
  const sent: string[] = []
  let assistantChunks = 0
  const channel = {
    id: session.discordThreadId,
    async sendTyping() {},
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      const isAssistantChunk = content.includes('Main Risks') ||
        content.includes('risk item') ||
        content.includes('Current Runtime Signal')
      if (isAssistantChunk) {
        assistantChunks += 1
        if (assistantChunks === 2) await sleep(200)
      }
      sent.push(content)
      return {
        content,
        async edit() {
          return this
        },
      }
    },
  } as unknown as ThreadChannel
  const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  const answer = [
    '**Main Risks**',
    ...Array.from({ length: 170 }, (_, index) => `- risk item ${index}: ${'x'.repeat(24)}`),
    '',
    '**Current Runtime Signal**',
    'CKP returned streams, but none are fresh enough for the current config.',
  ].join('\n')
  const expectedChunks = splitMarkdownForDiscord(formatAssistantText(answer), 1_900)
  assert.ok(expectedChunks.length > 1)

  try {
    internal.runs.set(session.codexThreadId, {
      session,
      channel,
      model: 'gpt-test',
      requestedModel: 'gpt-test',
      effort: 'xhigh',
      turnId: 'turn-1',
      startedAt: Date.now() - 225_000,
      agentText: new Map(),
      typingTimer,
    })

    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'message-1',
          text: answer,
        },
      },
    })
    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'turn-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          durationMs: 225_000,
        },
      },
    })

    await waitFor(() => sent.length === expectedChunks.length + 1)
    const footerIndex = sent.findIndex((content) => content.includes('gpt-test (xhigh)'))
    assert.equal(footerIndex, expectedChunks.length)
    assert.deepEqual(sent.slice(0, expectedChunks.length), expectedChunks)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex-started goal turns are adopted and streamed to the linked Discord thread', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-goal-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-goal-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-goal',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-goal',
    model: 'gpt-test',
    effort: 'xhigh',
    updatedAt: new Date(0).toISOString(),
  }
  const state = makeState(session)
  const codex = new FakeCodex()
  const sent: string[] = []
  let typingCalls = 0
  const channel = {
    id: session.discordThreadId,
    isThread: () => true,
    async sendTyping() {
      typingCalls += 1
    },
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
  const bot = new CordexDiscordBot(makeConfig(directory), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  const dispatchInternal = bot as unknown as DispatchInternalBot
  ;(dispatchInternal as unknown as {
    dispatchInput(
      channel: ThreadChannel,
      parentChannelId: string,
      input: Array<{ type: 'text'; text: string; text_elements: [] }>,
      clientUserMessageId?: string,
    ): Promise<void>
  }).dispatchInput = (targetChannel, parentChannelId, input, clientUserMessageId) =>
    dispatchInternal.dispatchInputUnlocked(targetChannel, parentChannelId, input, clientUserMessageId)
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async (id: string) => {
      assert.equal(id, session.discordThreadId)
      return channel
    }

  try {
    codex.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: session.codexThreadId,
        turnId: null,
        goal: { status: 'active' },
      },
    })
    codex.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-1',
          status: 'inProgress',
          startedAt: Math.floor(Date.now() / 1_000) - 2,
        },
      },
    })
    await waitFor(() => session.activeTurnId === 'goal-turn-1')
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'stale-turn',
        item: {
          type: 'agentMessage',
          id: 'stale-message',
          text: 'This stale response must not be sent.',
        },
      },
    })
    await sleep(30)
    assert.deepEqual(sent, [])
    codex.emit('notification', {
      method: 'item/started',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-1',
        item: { type: 'agentMessage', id: 'goal-message-1' },
      },
    })
    codex.emit('notification', {
      method: 'item/agentMessage/delta',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-1',
        itemId: 'goal-message-1',
        delta: 'Goal work is now visible.',
      },
    })
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-1',
        item: {
          type: 'agentMessage',
          id: 'goal-message-1',
          text: 'Goal work is now visible.',
        },
      },
    })
    codex.goalStatus = 'active'
    state.queues[session.discordThreadId] = [{
      id: 'queued-goal-message',
      authorId: 'user-1',
      authorName: 'Goal user',
      input: [{ type: 'text', text: 'Include this in the next goal turn.', text_elements: [] }],
      displayText: 'Include this in the next goal turn.',
      createdAt: new Date().toISOString(),
    }]
    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-1',
          status: 'completed',
          durationMs: 2_000,
        },
      },
    })

    await waitFor(() => sent.length === 2)
    assert.equal(typingCalls, 2)
    assert.equal(sent[0], 'Goal work is now visible.')
    assert.match(sent[1] || '', /gpt-test \(xhigh\)/)
    assert.equal(session.activeTurnId, undefined)
    assert.equal(internal.runs.size, 0)
    codex.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-2',
          status: 'inProgress',
          startedAt: Math.floor(Date.now() / 1_000),
        },
      },
    })
    await waitFor(() => codex.steered.length === 1)
    assert.equal(codex.steered[0]?.expectedTurnId, 'goal-turn-2')
    assert.equal(state.queues[session.discordThreadId]?.length, 0)
    assert.match(sent[2] || '', /Goal user.*Include this in the next goal turn/)
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-2',
        item: {
          type: 'agentMessage',
          id: 'goal-message-2',
          text: 'The second goal turn is visible too.',
        },
      },
    })
    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-2',
          status: 'completed',
          durationMs: 500,
        },
      },
    })
    await waitFor(() => sent.length === 5)
    assert.equal(typingCalls, 4)
    assert.equal(sent[3], 'The second goal turn is visible too.')
    assert.match(sent[4] || '', /gpt-test \(xhigh\)/)
    assert.equal(session.activeTurnId, undefined)
    assert.equal(internal.runs.size, 0)
    codex.emit('notification', {
      method: 'turn/started',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-3',
          status: 'inProgress',
          startedAt: Math.floor(Date.now() / 1_000),
        },
      },
    })
    await waitFor(() => session.activeTurnId === 'goal-turn-3')
    state.queues[session.discordThreadId] = [{
      id: 'queued-after-failure',
      authorId: 'user-1',
      authorName: 'Goal user',
      input: [{ type: 'text', text: 'Keep queued after failure.', text_elements: [] }],
      displayText: 'Keep queued after failure.',
      createdAt: new Date().toISOString(),
    }]
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-3',
        item: { type: 'agentMessage', id: 'empty-message', text: '   ' },
      },
    })
    codex.emit('notification', {
      method: 'error',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-3',
        error: { message: 'Temporary goal error.' },
        willRetry: true,
      },
    })
    await waitFor(() => sent.length === 6)
    assert.equal(sent[5], '⚠ Temporary goal error. Retrying.')
    codex.emit('notification', {
      method: 'error',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-3',
        error: { message: 'Goal turn failed.' },
        willRetry: false,
      },
    })
    await waitFor(() => sent.length === 7)
    assert.equal(sent[6], '⨯ Goal turn failed.')
    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turn: {
          id: 'goal-turn-3',
          status: 'failed',
          error: { message: 'Goal turn failed.' },
          durationMs: 100,
        },
      },
    })
    await waitFor(() => session.activeTurnId === undefined && internal.runs.size === 0)
    await sleep(30)
    assert.equal(typingCalls, 5)
    assert.equal(sent.length, 7)
    assert.deepEqual(state.queues[session.discordThreadId]?.map((item) => item.id), ['queued-after-failure'])
    assert.equal(session.activeTurnId, undefined)
    assert.equal(internal.runs.size, 0)
    codex.emit('notification', {
      method: 'warning',
      params: {
        threadId: session.codexThreadId,
        message: 'Goal warning is visible.',
      },
    })
    await waitFor(() => sent.length === 8)
    assert.equal(sent[7], '⚠ Goal warning is visible.')
    codex.emit('notification', {
      method: 'guardianWarning',
      params: {
        threadId: session.codexThreadId,
        message: 'Guardian warning is visible.',
      },
    })
    await waitFor(() => sent.length === 9)
    assert.equal(sent[8], '⚠ Guardian warning is visible.')
    const completedGoalNotification = {
      method: 'thread/goal/updated',
      params: {
        threadId: session.codexThreadId,
        turnId: null,
        goal: {
          status: 'complete',
          tokensUsed: 1_234,
          timeUsedSeconds: 7,
          updatedAt: 42,
        },
      },
    }
    codex.goalStatus = 'complete'
    codex.emit('notification', completedGoalNotification)
    codex.emit('notification', completedGoalNotification)
    await waitFor(() => sent.length === 11)
    assert.equal(sent[9], '**Goal complete.** 1,234 tokens · 7s')
    assert.match(sent[10] || '', /Keep queued after failure/)
    assert.equal(state.queues[session.discordThreadId]?.length, 0)
    const queuedRun = (internal.runs as Map<string, { typingTimer: NodeJS.Timeout }>).get(
      session.codexThreadId,
    )
    if (queuedRun) clearInterval(queuedRun.typingTimer)
    internal.runs.delete(session.codexThreadId)
    delete session.activeTurnId
    codex.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: session.codexThreadId,
        turnId: 'goal-turn-3',
        item: {
          type: 'agentMessage',
          id: 'late-goal-message',
          text: 'Late output must not resurrect a completed run.',
        },
      },
    })
    await sleep(30)
    assert.equal(sent.length, 11)
    assert.equal(session.activeTurnId, undefined)
    assert.equal(internal.runs.size, 0)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('Discord ingress steers when an automatic goal turn wins the start race', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-goal-race-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-goal-race-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-goal-race',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-goal-race',
    model: 'gpt-test',
    effort: 'xhigh',
    updatedAt: new Date(0).toISOString(),
  }
  const codex = new GoalRaceCodex()
  const channel = {
    id: session.discordThreadId,
    isThread: () => true,
    async sendTyping() {},
    async send() {
      return { async edit() { return this } }
    },
  } as unknown as ThreadChannel
  const bot = new CordexDiscordBot(
    makeConfig(directory),
    makeState(session),
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as DispatchInternalBot
  internal.loadedThreads.add(session.codexThreadId)
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async () => channel

  try {
    await internal.dispatchInputUnlocked(
      channel,
      session.parentChannelId,
      [{ type: 'text', text: 'Steer this into the goal turn.', text_elements: [] }],
      'discord-message-race',
    )
    assert.equal(session.activeTurnId, 'automatic-goal-turn')
    assert.equal(codex.steered.length, 1)
    assert.equal(codex.steered[0]?.expectedTurnId, 'automatic-goal-turn')
    assert.equal(codex.steered[0]?.clientUserMessageId, 'discord-message-race')

    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turn: { id: 'automatic-goal-turn', status: 'completed', durationMs: 10 },
      },
    })
    await waitFor(() => internal.runs.size === 0)
    await sleep(50)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('/goal resumes an unloaded session only after the final goal state is active', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-restart-goal-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-restart-goal-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-restart-goal',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-restart-goal',
    model: 'gpt-test',
    effort: 'xhigh',
    updatedAt: new Date(0).toISOString(),
  }
  const codex = new RestartGoalCodex()
  const channel = {
    id: session.discordThreadId,
    isThread: () => true,
  } as unknown as ThreadChannel
  let reply = ''
  let objective: string | null = 'Pause the persisted goal'
  let status: string | null = 'paused'
  const interaction = {
    channel,
    options: {
      getString(name: string) {
        if (name === 'objective') return objective
        if (name === 'status') return status
        return null
      },
      getInteger() {
        return null
      },
    },
    async deferReply() {},
    async editReply(value: string) {
      reply = value
    },
  } as unknown as ChatInputCommandInteraction
  const bot = new CordexDiscordBot(
    makeConfig(directory),
    makeState(session),
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as GoalInternalBot

  try {
    await internal.handleGoalCommand(interaction)
    assert.deepEqual(codex.calls, ['set-goal'])
    assert.deepEqual(codex.goalUpdate, {
      objective: 'Pause the persisted goal',
      status: 'paused',
    })
    assert.equal(internal.loadedThreads.has(session.codexThreadId), false)

    objective = null
    status = 'active'
    await internal.handleGoalCommand(interaction)
    assert.deepEqual(codex.calls, ['set-goal', 'get-goal', 'set-goal', 'resume'])
    assert.deepEqual(codex.goalUpdate, { status: 'active' })
    assert.equal(internal.loadedThreads.has(session.codexThreadId), true)
    assert.match(reply, /Pause the persisted goal/)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('a Cordex-started queue drain does not steer the next queued prompt into the same turn', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-queue-drain-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-queue-drain-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-queue-drain',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-queue-drain',
    model: 'gpt-test',
    effort: 'xhigh',
    activeTurnId: 'initial-turn',
    updatedAt: new Date(0).toISOString(),
  }
  const state = makeState(session)
  state.queues[session.discordThreadId] = [
    {
      id: 'queued-1',
      authorId: 'user-1',
      authorName: 'Queue user',
      input: [{ type: 'text', text: 'First queued prompt', text_elements: [] }],
      displayText: 'First queued prompt',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'queued-2',
      authorId: 'user-1',
      authorName: 'Queue user',
      input: [{ type: 'text', text: 'Second queued prompt', text_elements: [] }],
      displayText: 'Second queued prompt',
      createdAt: new Date().toISOString(),
    },
  ]
  const codex = new QueueDrainCodex()
  const sent: string[] = []
  const channel = {
    id: session.discordThreadId,
    isThread: () => true,
    async sendTyping() {},
    async send(payload: string | { content?: string }) {
      sent.push(typeof payload === 'string' ? payload : payload.content || '')
      return { async edit() { return this } }
    },
  } as unknown as ThreadChannel
  const bot = new CordexDiscordBot(
    makeConfig(directory),
    state,
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as DispatchInternalBot
  internal.loadedThreads.add(session.codexThreadId)
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async () => channel
  ;(internal as unknown as {
    dispatchInput(
      channel: ThreadChannel,
      parentChannelId: string,
      input: Array<{ type: 'text'; text: string; text_elements: [] }>,
      clientUserMessageId?: string,
    ): Promise<void>
  }).dispatchInput = (targetChannel, parentChannelId, input, clientUserMessageId) =>
    internal.dispatchInputUnlocked(targetChannel, parentChannelId, input, clientUserMessageId)
  const initialTypingTimer = setInterval(() => undefined, 60_000)
  initialTypingTimer.unref()
  internal.runs.set(session.codexThreadId, {
    session,
    channel,
    model: 'gpt-test',
    requestedModel: 'gpt-test',
    effort: 'xhigh',
    turnId: 'initial-turn',
    startedAt: Date.now(),
    agentText: new Map(),
    typingTimer: initialTypingTimer,
  })

  try {
    codex.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: session.codexThreadId,
        turn: { id: 'initial-turn', status: 'completed', durationMs: 10 },
      },
    })
    codex.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: session.codexThreadId,
        turnId: null,
        goal: {
          status: 'complete',
          tokensUsed: 10,
          timeUsedSeconds: 1,
          updatedAt: 10,
        },
      },
    })
    await waitFor(() => codex.startCalls === 1 && session.activeTurnId === 'queued-turn-1')
    await sleep(50)
    assert.equal(codex.steered.length, 0)
    assert.deepEqual(state.queues[session.discordThreadId]?.map((item) => item.id), ['queued-2'])
    assert.ok(sent.some((content) => content.includes('First queued prompt')))
    assert.ok(sent.every((content) => !content.includes('Second queued prompt')))
  } finally {
    for (const run of internal.runs.values() as Iterable<{ typingTimer: NodeJS.Timeout }>) {
      clearInterval(run.typingTimer)
    }
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('startup resumes active persisted goals without loading paused goals', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-startup-goal-project-'))
  const activeSession: SessionState = {
    discordThreadId: 'discord-startup-active',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-startup-active',
    updatedAt: new Date(0).toISOString(),
  }
  const pausedSession: SessionState = {
    discordThreadId: 'discord-startup-paused',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-startup-paused',
    updatedAt: new Date(0).toISOString(),
  }
  const state = makeState(activeSession)
  state.sessions[pausedSession.discordThreadId] = pausedSession
  const codex = new StartupGoalCodex()
  const bot = new CordexDiscordBot(
    makeConfig(directory),
    state,
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as GoalInternalBot

  try {
    await internal.resumeActiveGoalSessions()
    assert.deepEqual(codex.resumed, [activeSession.codexThreadId])
    assert.equal(internal.loadedThreads.has(activeSession.codexThreadId), true)
    assert.equal(internal.loadedThreads.has(pausedSession.codexThreadId), false)
  } finally {
    bot.client.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
