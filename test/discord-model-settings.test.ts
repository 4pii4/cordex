import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { loadState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CodexModel,
  CordexConfig,
  CordexState,
  JsonObject,
  ReasoningEffort,
  ServerNotification,
  SessionState,
} from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly settings: JsonObject[] = []
  readonly resumes: JsonObject[] = []
  resumeResult: {
    model?: string
    effort?: ReasoningEffort
    serviceTier?: string | null
    turns: []
  } = { turns: [] }
  settingsError: Error | undefined

  constructor(readonly models: CodexModel[]) {
    super()
  }

  async listModels(): Promise<CodexModel[]> {
    return this.models
  }

  async updateThreadSettings(options: JsonObject): Promise<void> {
    this.settings.push(options)
    if (this.settingsError) throw this.settingsError
  }

  async resumeThread(options: JsonObject) {
    this.resumes.push(options)
    return this.resumeResult
  }
}

type InternalBot = {
  handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleModelVariantCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleUnsetModelOverrideCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleFastCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleResumeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  ensureSessionLoaded(session: SessionState): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  synchronizeThreadTitle(): Promise<void>
}

const models: CodexModel[] = [
  {
    id: 'sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT 5.6 Sol',
    description: '',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'ultra',
    supportedReasoningEfforts: [
      { reasoningEffort: 'max', description: 'Maximum' },
      { reasoningEffort: 'ultra', description: 'Ultra' },
    ],
  },
  {
    id: 'luna',
    model: 'gpt-5.6-luna',
    displayName: 'GPT 5.6 Luna',
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'max', description: 'Maximum' },
    ],
    serviceTiers: [{ id: 'accelerated', name: 'Fast lane', description: 'Priority processing' }],
  },
  {
    id: 'terra',
    model: 'gpt-5.6-terra',
    displayName: 'GPT 5.6 Terra',
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
    ],
    serviceTiers: [{ id: 'standard', name: 'Standard', description: 'Standard processing' }],
  },
]

function config(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'ultra',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory } },
  }
}

function makeState(directory: string): { state: CordexState; session: SessionState } {
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-1',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    contextTokens: 1_000,
    contextWindow: 10_000,
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  return {
    session,
    state: {
      channelModels: {},
      channelEfforts: {},
      channelFastMode: {},
      channelYoloMode: {},
      channelAutoWorktrees: {},
      channelVerbosity: {},
      sessions: { [session.discordThreadId]: session },
      queues: {},
      tasks: {},
    },
  }
}

function interaction(options: {
  model?: string
  effort?: ReasoningEffort
  scope?: 'session' | 'channel'
  replies?: string[]
}): ChatInputCommandInteraction {
  return {
    channel: {
      id: 'discord-thread-1',
      parentId: 'parent-1',
      isThread: () => true,
    },
    options: {
      getString(name: string) {
        if (name === 'model') return options.model ?? null
        if (name === 'effort') return options.effort ?? null
        if (name === 'scope') return options.scope ?? null
        return null
      },
    },
    async reply(payload: string | { content: string }) {
      options.replies?.push(typeof payload === 'string' ? payload : payload.content)
      return undefined as never
    },
  } as unknown as ChatInputCommandInteraction
}

function fastInteraction(action: 'on' | 'off' | 'status'): ChatInputCommandInteraction {
  return {
    channel: {
      id: 'discord-thread-1',
      parentId: 'parent-1',
      isThread: () => true,
    },
    options: {
      getString(name: string) {
        return name === 'action' ? action : null
      },
    },
    async reply() {
      return undefined as never
    },
  } as unknown as ChatInputCommandInteraction
}

test('/model resets an incompatible effort and updates the live Codex session', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-session-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const replies: string[] = []
  try {
    await (bot as unknown as InternalBot).handleModelCommand(interaction({
      model: 'gpt-5.6-luna',
      scope: 'session',
      replies,
    }))

    assert.equal(session.model, 'gpt-5.6-luna')
    assert.equal(session.effort, 'medium')
    assert.equal(session.contextTokens, undefined)
    assert.equal(session.contextWindow, undefined)
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      model: 'gpt-5.6-luna',
      effort: 'medium',
    }])
    assert.match(replies[0] || '', /gpt-5\.6-luna.*medium/i)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('channel-scoped model changes also update the current thread session', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-channel-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  session.effort = 'max'
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await (bot as unknown as InternalBot).handleModelCommand(interaction({
      model: 'gpt-5.6-luna',
      scope: 'channel',
    }))

    assert.equal(state.channelModels['parent-1'], 'gpt-5.6-luna')
    assert.equal(state.channelEfforts['parent-1'], 'medium')
    assert.equal(session.model, 'gpt-5.6-luna')
    assert.equal(session.effort, 'medium')
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      model: 'gpt-5.6-luna',
      effort: 'medium',
    }])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('/model rejects effort values unsupported by the selected model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-effort-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleModelCommand(interaction({
        model: 'gpt-5.6-luna',
        effort: 'ultra',
      })),
      /does not support effort ultra/,
    )
    assert.equal(session.model, 'gpt-5.6-sol')
    assert.equal(session.effort, 'ultra')
    assert.deepEqual(codex.settings, [])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('channel-only model changes reject a Fast setting unsupported by the new model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-channel-fast-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state } = makeState(home)
  state.channelFastMode['parent-1'] = true
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const channelInteraction = interaction({ model: 'gpt-5.6-terra', scope: 'channel' })
  Object.assign(channelInteraction, {
    channel: {
      id: 'parent-1',
      parentId: null,
      isThread: () => false,
    },
  })
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleModelCommand(channelInteraction),
      /does not support Fast mode/,
    )
    assert.equal(state.channelModels['parent-1'], undefined)
    assert.deepEqual(codex.settings, [])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('/model RPC failure restores the prior durable model, effort, and context', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-rpc-rollback-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  const codex = new FakeCodex(models)
  codex.settingsError = new Error('settings RPC failed')
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleModelCommand(interaction({
        model: 'gpt-5.6-luna',
        scope: 'session',
      })),
      /settings RPC failed/,
    )
    assert.equal(session.model, 'gpt-5.6-sol')
    assert.equal(session.effort, 'ultra')
    assert.equal(session.contextTokens, 1_000)
    assert.equal(session.contextWindow, 10_000)
    const persisted = (await loadState()).sessions[session.discordThreadId]
    assert.equal(persisted?.model, 'gpt-5.6-sol')
    assert.equal(persisted?.effort, 'ultra')
    assert.equal(persisted?.contextTokens, 1_000)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('/model-variant and /fast RPC failures restore their prior durable overrides', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-setting-rollbacks-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  session.model = 'gpt-5.6-luna'
  session.effort = 'medium'
  const codex = new FakeCodex(models)
  codex.settingsError = new Error('settings RPC failed')
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  try {
    await assert.rejects(
      internal.handleModelVariantCommand(interaction({ effort: 'max' })),
      /settings RPC failed/,
    )
    assert.equal(session.effort, 'medium')
    assert.equal((await loadState()).sessions[session.discordThreadId]?.effort, 'medium')

    await assert.rejects(internal.handleFastCommand(fastInteraction('on')), /settings RPC failed/)
    assert.equal(session.fastMode, undefined)
    assert.equal((await loadState()).sessions[session.discordThreadId]?.fastMode, undefined)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('/unset-model-override rolls back RPC failure then resets an incompatible effort', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-unset-rollback-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  session.model = 'gpt-5.6-luna'
  session.effort = 'medium'
  const codex = new FakeCodex(models)
  codex.settingsError = new Error('settings RPC failed')
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  try {
    await assert.rejects(
      internal.handleUnsetModelOverrideCommand(interaction({})),
      /settings RPC failed/,
    )
    assert.equal(session.model, 'gpt-5.6-luna')
    assert.equal(session.effort, 'medium')
    let persisted = (await loadState()).sessions[session.discordThreadId]
    assert.equal(persisted?.model, 'gpt-5.6-luna')
    assert.equal(persisted?.effort, 'medium')

    codex.settingsError = undefined
    await internal.handleUnsetModelOverrideCommand(interaction({}))
    assert.equal(session.model, 'gpt-5.6-sol')
    assert.equal(session.effort, 'ultra')
    persisted = (await loadState()).sessions[session.discordThreadId]
    assert.equal(persisted?.model, 'gpt-5.6-sol')
    assert.equal(persisted?.effort, 'ultra')
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('lazy session resume reapplies the persisted reasoning effort through settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-resume-'))
  const { state, session } = makeState(home)
  session.effort = 'max'
  session.fastMode = true
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await (bot as unknown as InternalBot).ensureSessionLoaded(session)
    assert.equal(codex.resumes[0]?.effort, undefined)
    assert.equal(codex.resumes[0]?.serviceTier, 'fast')
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      effort: 'max',
    }])
  } finally {
    bot.client.destroy()
    await rm(home, { recursive: true, force: true })
  }
})

test('lazy resume sends null when catalog metadata has no fast tier', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-no-fast-tier-'))
  const { state, session } = makeState(home)
  session.model = 'gpt-5.6-terra'
  session.effort = 'medium'
  session.fastMode = true
  const codex = new FakeCodex(models)
  codex.resumeResult = {
    model: session.model,
    effort: session.effort,
    turns: [],
  }
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await (bot as unknown as InternalBot).ensureSessionLoaded(session)
    assert.equal(codex.resumes[0]?.serviceTier, null)
    assert.deepEqual(codex.settings, [])
  } finally {
    bot.client.destroy()
    await rm(home, { recursive: true, force: true })
  }
})

test('/resume preserves desired effort and recognizes a custom catalog fast tier', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-command-resume-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  session.model = 'gpt-5.6-luna'
  session.effort = 'max'
  session.fastMode = true
  const codex = new FakeCodex(models)
  codex.resumeResult = {
    model: session.model,
    effort: 'medium',
    serviceTier: 'accelerated',
    turns: [],
  }
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  const thread = {
    id: session.discordThreadId,
    name: 'Existing session',
    archived: false,
    isThread: () => true,
    toString: () => `<#${session.discordThreadId}>`,
    members: { async add() {} },
    async setArchived() {},
    async send() {},
  }
  ;(bot.client.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => thread
  internal.synchronizeThreadTitle = async () => {}
  const replies: string[] = []
  const resumeInteraction = {
    channel: { id: 'parent-1', isThread: () => false },
    user: { id: 'resume-user' },
    options: {
      getString(name: string) {
        return name === 'session' ? session.codexThreadId : null
      },
    },
    async deferReply() {},
    async editReply(value: string) {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
  try {
    await internal.handleResumeCommand(resumeInteraction)
    assert.equal(codex.resumes[0]?.serviceTier, 'accelerated')
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      effort: 'max',
    }])
    assert.equal(session.effort, 'max')
    assert.equal(session.fastMode, true)
    assert.match(replies[0] || '', /Session resumed/)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('/fast uses the selected model catalog service tier id', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-fast-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  session.model = 'gpt-5.6-luna'
  session.effort = 'medium'
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await (bot as unknown as InternalBot).handleFastCommand(fastInteraction('on'))
    assert.equal(session.fastMode, true)
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      serviceTier: 'accelerated',
    }])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('authoritative thread settings updates reconcile idle session metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-notification-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(home)
  const codex = new FakeCodex(models)
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  try {
    await internal.handleNotification({
      method: 'thread/settings/updated',
      params: {
        threadId: session.codexThreadId,
        threadSettings: {
          model: 'gpt-5.6-luna',
          effort: 'max',
          serviceTier: 'accelerated',
        },
      },
    })
    assert.equal(session.model, 'gpt-5.6-luna')
    assert.equal(session.effort, 'max')
    assert.equal(session.fastMode, true)
    assert.equal(session.contextTokens, undefined)
    assert.equal(session.contextWindow, undefined)

    session.contextTokens = 2_000
    session.contextWindow = 20_000
    await internal.handleNotification({
      method: 'thread/settings/updated',
      params: {
        threadId: session.codexThreadId,
        threadSettings: {
          model: 'gpt-5.6-luna',
          effort: 'medium',
          serviceTier: null,
        },
      },
    })
    assert.equal(session.effort, 'medium')
    assert.equal(session.fastMode, false)
    assert.equal(session.contextTokens, 2_000)
    assert.equal(session.contextWindow, 20_000)
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
