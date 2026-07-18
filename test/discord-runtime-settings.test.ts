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
import type { CordexConfig, CordexState, JsonObject, SessionState } from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly settings: JsonObject[] = []
  failSettings = false

  async listPermissionProfiles() {
    return [
      { id: ':read-only', allowed: true },
      { id: 'trusted', allowed: true },
    ]
  }

  async updateThreadSettings(options: JsonObject): Promise<void> {
    this.settings.push(options)
    if (this.failSettings) throw new Error('settings RPC failed')
  }
}

type InternalBot = {
  handlePermissionsCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleYoloCommand(interaction: ChatInputCommandInteraction): Promise<void>
}

function config(directory: string): CordexConfig {
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

function fixtureState(directory: string): { state: CordexState; session: SessionState } {
  const session: SessionState = {
    discordThreadId: 'thread-1',
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: 'codex-thread-1',
    permissions: ':read-only',
    yoloMode: false,
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

function interaction(options: { profile?: string; action?: string }): ChatInputCommandInteraction {
  return {
    channel: {
      id: 'thread-1',
      parentId: 'parent-1',
      isThread: () => true,
    },
    options: {
      getString(name: string) {
        if (name === 'profile') return options.profile ?? null
        if (name === 'action') return options.action ?? null
        return null
      },
    },
    async deferReply() {},
    async editReply() {},
    async reply() {},
  } as unknown as ChatInputCommandInteraction
}

test('permission RPC failure restores the prior durable profile', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-permission-rollback-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = fixtureState(home)
  const codex = new FakeCodex()
  codex.failSettings = true
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handlePermissionsCommand(interaction({ profile: 'trusted' })),
      /settings RPC failed/,
    )
    assert.equal(session.permissions, ':read-only')
    assert.equal((await loadState()).sessions[session.discordThreadId]?.permissions, ':read-only')
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      permissions: 'trusted',
    }])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('YOLO RPC failure restores the prior durable runtime policy', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-yolo-rollback-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = fixtureState(home)
  const codex = new FakeCodex()
  codex.failSettings = true
  const bot = new CordexDiscordBot(config(home), state, codex as unknown as CodexAppServer)
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleYoloCommand(interaction({ action: 'on' })),
      /settings RPC failed/,
    )
    assert.equal(session.yoloMode, false)
    assert.equal((await loadState()).sessions[session.discordThreadId]?.yoloMode, false)
    assert.deepEqual(codex.settings, [{
      threadId: session.codexThreadId,
      permissions: null,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    }])
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
