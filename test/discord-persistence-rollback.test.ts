import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, Message, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, QueuedPrompt } from '../src/types.js'

class FakeCodex extends EventEmitter {}

type InternalBot = {
  blockedQueuedSourceThreads: Set<string>
  handleScheduleCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleClearQueueCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleQueuedMessageUpdate(message: Message): Promise<void>
  handleQueuedMessageDelete(messageId: string): Promise<void>
  reconcilePersistedQueuedSourcesUnlocked(
    session: CordexState['sessions'][string],
    channel: ThreadChannel,
  ): Promise<void>
}

function config(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory } },
  }
}

function prompt(id: string, kind: 'direct' | 'queued' = 'queued'): QueuedPrompt {
  return {
    id,
    authorId: 'user-1',
    authorName: 'User',
    input: [{ type: 'text', text: id, text_elements: [] }],
    displayText: id,
    createdAt: new Date().toISOString(),
    sourceMessageId: id,
    deliveryKind: kind,
  }
}

async function withFailingStateHome(
  run: (fixture: {
    state: CordexState
    internal: InternalBot
    bot: CordexDiscordBot
    channel: ThreadChannel
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-persist-rollback-'))
  const blocker = path.join(root, 'not-a-directory')
  await writeFile(blocker, 'block state directory creation')
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = blocker
  const state: CordexState = {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {
      'thread-1': {
        discordThreadId: 'thread-1',
        parentChannelId: 'parent-1',
        directory: root,
        codexThreadId: 'codex-thread-1',
        updatedAt: new Date().toISOString(),
      },
    },
    queues: {},
    tasks: {},
  }
  const bot = new CordexDiscordBot(
    config(root),
    state,
    new FakeCodex() as unknown as CodexAppServer,
  )
  const channel = {
    id: 'thread-1',
    parentId: 'parent-1',
    isThread: () => true,
    async send() {
      return { id: 'message-1' }
    },
  } as unknown as ThreadChannel
  try {
    await run({ state, internal: bot as unknown as InternalBot, bot, channel })
  } finally {
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  }
}

test('failed queue clear restores direct and queued ledger entries', async () => {
  await withFailingStateHome(async ({ state, internal, channel }) => {
    const direct = prompt('direct-1', 'direct')
    const queued = prompt('queued-1')
    state.queues[channel.id] = [direct, queued]
    const interaction = {
      channel,
      options: { getInteger: () => null },
      async reply() {
        return undefined as never
      },
    } as unknown as ChatInputCommandInteraction

    await assert.rejects(internal.handleClearQueueCommand(interaction), /EEXIST|ENOTDIR/)
    assert.deepEqual(state.queues[channel.id], [direct, queued])
  })
})

test('failed task creation removes the in-memory orphan', async () => {
  await withFailingStateHome(async ({ state, internal, channel }) => {
    const interaction = {
      channel,
      user: { id: 'user-1' },
      options: {
        getString: () => 'Run verification',
        getInteger(name: string) {
          return name === 'delay-seconds' ? 60 : null
        },
      },
      async reply() {
        return undefined as never
      },
    } as unknown as ChatInputCommandInteraction

    await assert.rejects(internal.handleScheduleCommand(interaction), /EEXIST|ENOTDIR/)
    assert.deepEqual(state.tasks, {})
  })
})

test('failed queued source edit and delete restore the original prompt', async () => {
  await withFailingStateHome(async ({ state, internal, channel }) => {
    const queued = prompt('queued-source')
    state.queues[channel.id] = [queued]
    const edited = {
      id: queued.sourceMessageId,
      content: 'remove queue suffix',
      author: { bot: false },
      channel,
    } as unknown as Message

    await assert.rejects(internal.handleQueuedMessageUpdate(edited), /EEXIST|ENOTDIR/)
    assert.deepEqual(state.queues[channel.id], [queued])
    await assert.rejects(internal.handleQueuedMessageDelete(queued.sourceMessageId!), /EEXIST|ENOTDIR/)
    assert.deepEqual(state.queues[channel.id], [queued])
  })
})

test('failed queued source reconciliation restores a missing-source prompt and stays blocked', async () => {
  await withFailingStateHome(async ({ state, internal, channel }) => {
    const queued = prompt('missing-source')
    state.queues[channel.id] = [queued]
    const sourceChannel = {
      ...channel,
      messages: {
        async fetch() {
          throw { code: 10_008 }
        },
      },
    } as unknown as ThreadChannel

    await assert.rejects(
      internal.reconcilePersistedQueuedSourcesUnlocked(
        state.sessions[channel.id]!,
        sourceChannel,
      ),
      /EEXIST|ENOTDIR/,
    )
    assert.deepEqual(state.queues[channel.id], [queued])
    assert.equal(internal.blockedQueuedSourceThreads.has(channel.id), true)
  })
})
