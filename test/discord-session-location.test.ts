import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, SessionState, UserInput } from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly starts: Record<string, unknown>[] = []
  readonly turns: Record<string, unknown>[] = []

  async startThread(options: Record<string, unknown>) {
    this.starts.push(options)
    return { threadId: 'codex-new', model: 'gpt-test' }
  }

  async startTurn(options: Record<string, unknown>) {
    this.turns.push(options)
    return 'turn-new'
  }
}

type InitialSessionLocation = {
  directory: string
  worktree?: { projectDirectory: string; directory: string; branch: string }
  workspaceRoots?: string[]
}

type InternalBot = {
  runs: Map<string, { typingTimer: NodeJS.Timeout }>
  refreshProjectsSafely(): Promise<void>
  handleNewSessionCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleMergeWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  createAutomaticWorktree(parentChannelId: string, sessionName: string): Promise<unknown>
  createSessionThread(options: {
    parentChannelId: string
    name: string
    userId: string
  }): Promise<ThreadChannel>
  dispatchInput(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
    initialLocation?: InitialSessionLocation,
  ): Promise<void>
  dispatchInputUnlocked(
    channel: ThreadChannel,
    parentChannelId: string,
    input: UserInput[],
    clientUserMessageId?: string,
    initialLocation?: InitialSessionLocation,
  ): Promise<void>
  synchronizeCodexThreadTitle(threadId: string, title: string): Promise<void>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function config(projectDirectory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    defaultModel: 'gpt-test',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: projectDirectory } },
  }
}

function state(session?: SessionState): CordexState {
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

test('/new-session in a thread inherits its working directory without claiming the worktree', async () => {
  const source: SessionState = {
    discordThreadId: 'source-thread',
    parentChannelId: 'parent-1',
    directory: '/tmp/cordex-shared-worktree',
    codexThreadId: 'codex-source',
    workspaceRoots: ['/tmp/cordex-extra-root'],
    worktree: {
      projectDirectory: '/tmp/cordex-project',
      directory: '/tmp/cordex-shared-worktree',
      branch: 'codex/cordex-source',
    },
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const bot = new CordexDiscordBot(
    config('/tmp/cordex-project'),
    state(source),
    new FakeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.refreshProjectsSafely = async () => undefined
  let automaticWorktrees = 0
  let threadName = ''
  let location: InitialSessionLocation | undefined
  internal.createAutomaticWorktree = async () => {
    automaticWorktrees += 1
    return undefined
  }
  const createdThread = {
    id: 'created-thread',
    toString: () => '<#created-thread>',
  } as unknown as ThreadChannel
  internal.createSessionThread = async (options) => {
    threadName = options.name
    return createdThread
  }
  internal.dispatchInput = async (_channel, _parent, _input, _messageId, initialLocation) => {
    location = initialLocation
  }
  let reply = ''
  const interaction = {
    id: 'interaction-1',
    channel: {
      id: source.discordThreadId,
      parentId: source.parentChannelId,
      isThread: () => true,
    },
    user: { id: 'user-1' },
    options: {
      getString(name: string, required?: boolean) {
        if (name === 'prompt') return 'Inspect inherited checkout'
        if (required) throw new Error(`missing ${name}`)
        return null
      },
    },
    async deferReply() {},
    async editReply(value: string) {
      reply = value
    },
  } as unknown as ChatInputCommandInteraction

  try {
    await internal.handleNewSessionCommand(interaction)
    assert.equal(automaticWorktrees, 0)
    assert.equal(threadName, '⬦ Inspect inherited checkout')
    assert.deepEqual(location, {
      directory: source.directory,
      workspaceRoots: source.workspaceRoots,
    })
    assert.match(reply, /Directory: `\/tmp\/cordex-shared-worktree`/)
  } finally {
    bot.client.destroy()
  }
})

test('/merge-worktree cannot race a child session inheriting the same directory', async () => {
  const source: SessionState = {
    discordThreadId: 'source-thread',
    parentChannelId: 'parent-1',
    directory: '/tmp/cordex-shared-worktree',
    codexThreadId: 'codex-source',
    worktree: {
      projectDirectory: '/tmp/cordex-project',
      directory: '/tmp/cordex-shared-worktree',
      branch: 'codex/cordex-source',
    },
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const bot = new CordexDiscordBot(
    config('/tmp/cordex-project'),
    state(source),
    new FakeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.refreshProjectsSafely = async () => undefined
  const sessionThreadStarted = deferred()
  const allowSessionThread = deferred()
  const createdThread = {
    id: 'created-thread',
    toString: () => '<#created-thread>',
  } as unknown as ThreadChannel
  internal.createSessionThread = async () => {
    sessionThreadStarted.resolve()
    await allowSessionThread.promise
    return createdThread
  }
  internal.dispatchInput = async () => undefined
  const sourceChannel = {
    id: source.discordThreadId,
    parentId: source.parentChannelId,
    name: 'Source thread',
    isThread: () => true,
  } as unknown as ThreadChannel
  const newSessionInteraction = {
    id: 'new-session-interaction',
    channel: sourceChannel,
    user: { id: 'user-1' },
    options: {
      getString(name: string, required?: boolean) {
        if (name === 'prompt') return 'Start child session'
        if (required) throw new Error(`missing ${name}`)
        return null
      },
    },
    async deferReply() {},
    async editReply() {},
  } as unknown as ChatInputCommandInteraction
  const mergeInteraction = {
    id: 'merge-interaction',
    channel: sourceChannel,
    user: { id: 'user-1', displayName: 'User' },
    options: { getString: () => null },
    async deferReply() {},
  } as unknown as ChatInputCommandInteraction

  try {
    const starting = internal.handleNewSessionCommand(newSessionInteraction)
    await sessionThreadStarted.promise
    await assert.rejects(
      internal.handleMergeWorktreeCommand(mergeInteraction),
      /being inherited by a new session/,
    )
    allowSessionThread.resolve()
    await starting
  } finally {
    allowSessionThread.resolve()
    bot.client.destroy()
  }
})

test('initial session location reaches Codex start and persisted session runtime roots', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-session-location-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const projectDirectory = path.join(home, 'project')
  const inheritedDirectory = path.join(home, 'worktree')
  const extraRoot = path.join(home, 'extra')
  const currentState = state()
  const codex = new FakeCodex()
  const bot = new CordexDiscordBot(
    config(projectDirectory),
    currentState,
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.synchronizeCodexThreadTitle = async () => undefined
  const sent: string[] = []
  const channel = {
    id: 'created-thread',
    name: 'Inherited session',
    isThread: () => true,
    async send(payload: string | { content?: string }) {
      sent.push(typeof payload === 'string' ? payload : payload.content || '')
      return { id: `message-${sent.length}` }
    },
    async sendTyping() {},
  } as unknown as ThreadChannel

  try {
    await internal.dispatchInputUnlocked(
      channel,
      'parent-1',
      [{ type: 'text', text: 'hello', text_elements: [] }],
      'message-1',
      { directory: inheritedDirectory, workspaceRoots: [extraRoot] },
    )

    assert.equal(codex.starts[0]?.cwd, inheritedDirectory)
    assert.deepEqual(codex.starts[0]?.runtimeWorkspaceRoots, [inheritedDirectory, extraRoot])
    assert.deepEqual(codex.turns[0]?.runtimeWorkspaceRoots, [inheritedDirectory, extraRoot])
    assert.equal(currentState.sessions[channel.id]?.directory, inheritedDirectory)
    assert.deepEqual(currentState.sessions[channel.id]?.workspaceRoots, [extraRoot])
    assert.equal(currentState.sessions[channel.id]?.worktree, undefined)
  } finally {
    for (const run of internal.runs.values()) clearInterval(run.typingTimer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
