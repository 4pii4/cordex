import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import {
  formatAssistantText,
  splitMarkdownForDiscord,
} from '../src/discord-output.js'
import type { CordexConfig, CordexState, SessionState } from '../src/types.js'

class FakeCodex extends EventEmitter {}

type InternalBot = {
  runs: Map<string, unknown>
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
