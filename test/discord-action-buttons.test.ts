import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ButtonStyle, type ButtonInteraction, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  JsonObject,
  ServerRequest,
} from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly responses: Array<{ id: string | number; result: unknown }> = []

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result })
  }
}

type TestBot = {
  runs: Map<string, unknown>
  pendingActionButtons: Map<string, unknown>
  requireAccess(interaction: ButtonInteraction): Promise<boolean>
  handleServerRequest(request: ServerRequest): Promise<void>
  handleButton(interaction: ButtonInteraction): Promise<void>
  cancelActionButtonsForChannel(channelId: string, status: string, resultText: string): Promise<void>
}

type SentPayload = {
  content: string
  components: Array<{ toJSON(): unknown }>
}

test('Discord action buttons resolve once and return selection to Codex', async () => {
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
  }
  const state: CordexState = {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {
      'discord-thread-1': {
        discordThreadId: 'discord-thread-1',
        parentChannelId: 'parent-1',
        directory: process.cwd(),
        codexThreadId: 'codex-thread-1',
        activeTurnId: 'turn-1',
        updatedAt: '2026-07-16T00:00:00.000Z',
      },
    },
    queues: {},
    tasks: {},
  }
  const sent: SentPayload[] = []
  const edits: Array<{ content: string; components: unknown[] }> = []
  const fakeMessage = {
    content: '**Action Required**',
    async edit(payload: { content: string; components: unknown[] }) {
      edits.push(payload)
      return this
    },
  }
  const channel = {
    id: 'discord-thread-1',
    async send(payload: SentPayload) {
      sent.push(payload)
      return fakeMessage
    },
  } as unknown as ThreadChannel
  const codex = new FakeCodex()
  const bot = new CordexDiscordBot(config, state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as TestBot
  internal.requireAccess = async () => true
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  internal.runs.set('codex-thread-1', {
    session: state.sessions['discord-thread-1'],
    channel,
    model: 'fixture-model',
    turnId: 'turn-1',
    startedAt: Date.now(),
    agentMessages: new Map(),
    agentText: new Map(),
    toolMessages: new Map(),
    typingTimer,
  })
  const request: ServerRequest = {
    id: 77,
    method: 'item/tool/call',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: 'cordex_action_buttons',
      arguments: {
        buttons: [
          { label: 'Continue', color: 'green' },
          { label: 'Cancel' },
        ],
      },
    },
  }

  try {
    await internal.handleServerRequest(request)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]?.content, '**Action Required**')
    const row = sent[0]?.components[0]?.toJSON() as JsonObject | undefined
    const components = Array.isArray(row?.components) ? row.components : []
    assert.deepEqual(
      components.map((component) => {
        const value = component as JsonObject
        return { label: value.label, style: value.style }
      }),
      [
        { label: 'Continue', style: ButtonStyle.Success },
        { label: 'Cancel', style: ButtonStyle.Secondary },
      ],
    )
    assert.equal(codex.responses.length, 0)

    const [key] = internal.pendingActionButtons.keys()
    assert.ok(key)
    const updates: Array<{ content: string; components: unknown[] }> = []
    const replies: string[] = []
    const interaction = {
      customId: `action-tool:${key}:0`,
      channelId: 'discord-thread-1',
      user: { id: 'user-1' },
      async update(payload: { content: string; components: unknown[] }) {
        updates.push(payload)
      },
      async reply(payload: { content: string }) {
        replies.push(payload.content)
      },
    } as unknown as ButtonInteraction

    await internal.handleButton(interaction)
    assert.deepEqual(codex.responses, [{
      id: 77,
      result: {
        contentItems: [{ type: 'inputText', text: 'User clicked: Continue' }],
        success: true,
      },
    }])
    assert.deepEqual(updates, [{
      content: '**Action Required**\n_Selected: Continue_',
      components: [],
    }])
    assert.equal(internal.pendingActionButtons.size, 0)

    await internal.handleButton(interaction)
    assert.deepEqual(replies, ['This action is no longer available.'])

    await internal.handleServerRequest({ ...request, id: 78 })
    await internal.cancelActionButtonsForChannel(
      'discord-thread-1',
      '_Buttons dismissed._',
      'Action button request cancelled.',
    )
    assert.deepEqual(codex.responses.at(-1), {
      id: 78,
      result: {
        contentItems: [{ type: 'inputText', text: 'Action button request cancelled.' }],
        success: false,
      },
    })
    assert.deepEqual(edits.at(-1), {
      content: '**Action Required**\n_Buttons dismissed._',
      components: [],
    })

    const sentBeforeStale = sent.length
    await internal.handleServerRequest({
      ...request,
      id: 79,
      params: { ...request.params, turnId: 'stale-turn' },
    })
    assert.equal(sent.length, sentBeforeStale)
    assert.deepEqual(codex.responses.at(-1), {
      id: 79,
      result: {
        contentItems: [{ type: 'inputText', text: 'Discord turn is no longer active.' }],
        success: false,
      },
    })

    internal.runs.delete('codex-thread-1')
    delete state.sessions['discord-thread-1']?.activeTurnId
    await internal.handleServerRequest({ ...request, id: 80 })
    assert.equal(sent.length, sentBeforeStale)
    assert.deepEqual(codex.responses.at(-1), {
      id: 80,
      result: {
        contentItems: [{ type: 'inputText', text: 'Discord turn is no longer active.' }],
        success: false,
      },
    })
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})
