import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, JsonObject, SessionState } from '../src/types.js'

class FakeCodex extends EventEmitter {}

type InternalBot = {
  runs: Map<string, {
    session: SessionState
    model: string
    requestedModel?: string
    effort: string
    contextPercent?: number
    typingTimer: NodeJS.Timeout
  }>
  pendingContextUsage: Map<string, unknown>
  contextReplayBlocked: Set<string>
  handleNotification(notification: { method: string; params: JsonObject }): Promise<void>
  hydratePendingContextUsage(session: SessionState): boolean
}

function breakdown(totalTokens: number): JsonObject {
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

function tokenUsage(threadId: string, turnId: string, tokens: number, window: number | null): JsonObject {
  return {
    threadId,
    turnId,
    tokenUsage: {
      total: breakdown(tokens + 10),
      last: breakdown(tokens),
      modelContextWindow: window,
    },
  }
}

function makeConfig(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
  }
}

function makeState(session?: SessionState): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: session ? { [session.discordThreadId]: session } : {},
    queues: {},
    tasks: {},
  }
}

test('bot accepts strict token snapshots outside active runs and rejects stale active-turn updates', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-context-bot-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    model: 'gpt-test',
    updatedAt: new Date(0).toISOString(),
  }
  const state = makeState(session)
  const bot = new CordexDiscordBot(makeConfig(), state, new FakeCodex() as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  const timer = setInterval(() => undefined, 60_000)
  timer.unref()
  try {
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', 'turn-old', 32_000, 128_000),
    })
    assert.equal(session.contextTokens, 32_000)
    assert.equal(session.contextWindow, 128_000)

    session.activeTurnId = 'turn-current'
    internal.runs.set('codex-thread-1', {
      session,
      model: 'gpt-test',
      requestedModel: 'gpt-test',
      effort: 'high',
      contextPercent: 25,
      typingTimer: timer,
    })
    await internal.handleNotification({
      method: 'model/rerouted',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-current',
        fromModel: 'gpt-test',
        toModel: 'gpt-safe',
        reason: 'highRiskCyberActivity',
      },
    })
    assert.equal(internal.runs.get('codex-thread-1')?.model, 'gpt-safe')
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', 'turn-old', 90_000, 128_000),
    })
    assert.equal(session.contextTokens, 32_000)
    assert.equal(internal.runs.get('codex-thread-1')?.contextPercent, 25)

    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', '', 33_000, 128_000),
    })
    assert.equal(session.contextTokens, 32_000)
    assert.equal(internal.runs.get('codex-thread-1')?.contextPercent, 25)

    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', 'turn-current', 130_000, 128_000),
    })
    assert.equal(session.contextTokens, 130_000)
    assert.equal(session.contextWindow, 128_000)
    assert.equal(internal.runs.get('codex-thread-1')?.contextPercent, 102)

    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', 'turn-current', 131_000, null),
    })
    assert.equal(session.contextTokens, 131_000)
    assert.equal(session.contextWindow, undefined)
    assert.equal(internal.runs.get('codex-thread-1')?.contextPercent, undefined)

    const beforeMalformed = { ...session }
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: { ...tokenUsage('codex-thread-1', 'turn-current', 2_000, 1_000), tokenUsage: null },
    })
    assert.deepEqual(session, beforeMalformed)

    internal.runs.delete('codex-thread-1')
    delete session.activeTurnId
    delete session.contextTokens
    delete session.contextWindow
    session.model = 'gpt-next'
    internal.contextReplayBlocked.add('codex-thread-1')
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', '', 40_000, 128_000),
    })
    assert.equal(session.contextTokens, undefined)
    assert.equal(internal.contextReplayBlocked.has('codex-thread-1'), true)

    session.activeTurnId = 'turn-next'
    internal.runs.set('codex-thread-1', {
      session,
      model: 'gpt-next',
      requestedModel: 'gpt-next',
      effort: 'high',
      typingTimer: timer,
    })
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-1', 'turn-next', 41_000, 256_000),
    })
    assert.equal(session.contextTokens, 41_000)
    assert.equal(session.contextWindow, 256_000)
    assert.equal(internal.contextReplayBlocked.has('codex-thread-1'), false)
  } finally {
    clearInterval(timer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bot retains a replay snapshot until resume/fork links the Discord session', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-context-pending-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const state = makeState()
  const bot = new CordexDiscordBot(makeConfig(), state, new FakeCodex() as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  const session: SessionState = {
    discordThreadId: 'discord-thread-2',
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-2',
    model: 'gpt-test',
    updatedAt: new Date(0).toISOString(),
  }
  try {
    await internal.handleNotification({
      method: 'thread/tokenUsage/updated',
      params: tokenUsage('codex-thread-2', '', 12_345, 64_000),
    })
    assert.equal(internal.pendingContextUsage.size, 1)
    assert.equal(internal.hydratePendingContextUsage(session), true)
    assert.equal(session.contextTokens, 12_345)
    assert.equal(session.contextWindow, 64_000)
    assert.equal(internal.pendingContextUsage.size, 0)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
