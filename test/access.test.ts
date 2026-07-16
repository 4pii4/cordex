import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js'
import { userHasAccess } from '../src/access.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, ScheduledTask } from '../src/types.js'

class FakeCodex extends EventEmitter {}

function makeConfig(): CordexConfig {
  return {
    token: 'token',
    applicationId: 'application',
    guildId: 'guild',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projects: {},
  }
}

function makeState(): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {},
    queues: {},
    tasks: {},
  }
}

test('Cordex access is owner-only unless explicit IDs or allow-all are configured', () => {
  const restricted = {
    allowAllUsers: false,
    allowedUserIds: ['trusted-user'],
    allowedRoleIds: ['trusted-role'],
  }
  assert.equal(userHasAccess(restricted, 'owner', 'guild', 'owner', []), true)
  assert.equal(userHasAccess(restricted, 'trusted-user', 'guild', 'owner', []), true)
  assert.equal(userHasAccess(restricted, 'role-user', 'guild', 'owner', ['trusted-role']), true)
  assert.equal(userHasAccess(restricted, 'untrusted-user', 'guild', 'owner', ['other-role']), false)
  assert.equal(userHasAccess({ allowAllUsers: true }, 'any-user', 'guild', 'owner', []), true)
  assert.equal(
    userHasAccess(
      { allowAllUsers: false, allowedRoleIds: ['guild'] },
      'untrusted-user',
      'guild',
      'owner',
      ['guild'],
    ),
    false,
  )
})

test('unauthorized autocomplete cannot enumerate local Cordex data', async () => {
  const bot = new CordexDiscordBot(
    makeConfig(),
    makeState(),
    new FakeCodex() as unknown as CodexAppServer,
  ) as unknown as {
    memberAllowed(userId: string): Promise<boolean>
    handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>
  }
  bot.memberAllowed = async () => false
  const responses: unknown[] = []
  const interaction = {
    guildId: 'guild',
    user: { id: 'untrusted' },
    options: {
      getFocused: () => {
        throw new Error('autocomplete inspected options before checking access')
      },
    },
    respond: async (choices: unknown) => {
      responses.push(choices)
    },
  } as unknown as AutocompleteInteraction
  await bot.handleAutocomplete(interaction)
  assert.deepEqual(responses, [[]])
})

test('interactions from another guild fail closed even for an otherwise allowed user', async () => {
  const bot = new CordexDiscordBot(
    makeConfig(),
    makeState(),
    new FakeCodex() as unknown as CodexAppServer,
  ) as unknown as {
    memberAllowed(userId: string): Promise<boolean>
    requireAccess(interaction: ChatInputCommandInteraction): Promise<boolean>
  }
  bot.memberAllowed = async () => true
  const replies: unknown[] = []
  const interaction = {
    guildId: 'other-guild',
    user: { id: 'trusted' },
    reply: async (value: unknown) => {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
  assert.equal(await bot.requireAccess(interaction), false)
  assert.deepEqual(replies, [{
    content: 'Cordex is not configured for this Discord server.',
    ephemeral: true,
  }])
})

test('direct shell execution is disabled by default', async () => {
  const bot = new CordexDiscordBot(
    makeConfig(),
    makeState(),
    new FakeCodex() as unknown as CodexAppServer,
  ) as unknown as {
    sendShellResult(
      interaction: ChatInputCommandInteraction,
      command: string,
      directory: string,
    ): Promise<void>
  }
  const interaction = {
    deferReply: async () => {
      throw new Error('shell execution started before checking configuration')
    },
  } as unknown as ChatInputCommandInteraction
  await assert.rejects(
    bot.sendShellResult(interaction, 'echo unsafe', process.cwd()),
    /Direct shell commands are disabled/,
  )
})

test('stale channels and scheduled tasks cannot cross Discord guild boundaries', async () => {
  const config = makeConfig()
  config.projects.project = { directory: process.cwd() }
  const state = makeState()
  state.sessions.thread = {
    discordThreadId: 'thread',
    parentChannelId: 'project',
    directory: process.cwd(),
    codexThreadId: 'codex-thread',
    updatedAt: new Date(0).toISOString(),
  }
  const bot = new CordexDiscordBot(
    config,
    state,
    new FakeCodex() as unknown as CodexAppServer,
  ) as unknown as {
    client: { channels: { fetch(channelId: string): Promise<unknown> } }
    cleanupProjectMapping(channelId: string, archiveSessions: boolean): Promise<number>
    pruneDeletedProjectMappings(): Promise<void>
    runScheduledTask(task: ScheduledTask): Promise<void>
  }
  const cleaned: string[] = []
  bot.client.channels.fetch = async () => ({ guildId: 'old-guild' })
  bot.cleanupProjectMapping = async (channelId) => {
    cleaned.push(channelId)
    return 0
  }
  await bot.pruneDeletedProjectMappings()
  assert.deepEqual(cleaned, ['project'])

  delete config.projects.project
  await assert.rejects(
    bot.runScheduledTask({
      id: 'task',
      threadId: 'thread',
      prompt: 'unsafe',
      runAt: new Date().toISOString(),
      createdBy: 'user',
      status: 'scheduled',
    }),
    /parent project is no longer mapped/,
  )
})
