import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ThreadChannel,
} from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  JsonObject,
  ServerNotification,
  ServerRequest,
  SessionState,
} from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly responses: Array<{ id: string | number; result: unknown }> = []
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result })
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId })
  }
}

class StaleResponseCodex extends FakeCodex {
  readonly staleResponseAttempts: Array<string | number> = []

  respondTo(request: ServerRequest, _result: unknown): void {
    this.staleResponseAttempts.push(request.id)
    throw new Error('Fixture request belongs to a dead app-server child')
  }
}

type EditPayload = { content: string; components: unknown[] }

type FakeMessage = {
  content: string
  edits: EditPayload[]
  edit(payload: EditPayload): Promise<FakeMessage>
}

type InternalBot = {
  runs: Map<string, unknown>
  approvals: Map<string, unknown>
  pendingActionButtons: Map<string, unknown>
  pendingUserInputs: Map<string, unknown>
  pendingRequestControls: Map<string, unknown>
  handleServerRequest(request: ServerRequest): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  handleAbortCommand(interaction: ChatInputCommandInteraction): Promise<void>
  requireAccess(interaction: ButtonInteraction): Promise<boolean>
  handleButton(interaction: ButtonInteraction): Promise<void>
  onTurnCompleted(run: unknown, params: JsonObject): Promise<void>
}

function makeConfig(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
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

function makeHarness(codex: FakeCodex = new FakeCodex()): {
  bot: CordexDiscordBot
  internal: InternalBot
  codex: FakeCodex
  session: SessionState
  channel: ThreadChannel
  messages: FakeMessage[]
  run: unknown
  typingTimer: NodeJS.Timeout
} {
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    activeTurnId: 'turn-1',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const messages: FakeMessage[] = []
  const channel = {
    id: session.discordThreadId,
    isThread() {
      return true
    },
    async send(payload: string | { content: string }) {
      const message: FakeMessage = {
        content: typeof payload === 'string' ? payload : payload.content,
        edits: [],
        async edit(update) {
          this.content = update.content
          this.edits.push(update)
          return this
        },
      }
      messages.push(message)
      return message
    },
  } as unknown as ThreadChannel
  const bot = new CordexDiscordBot(
    makeConfig(),
    makeState(session),
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  const run = {
    session,
    channel,
    model: 'fixture-model',
    effort: 'medium',
    turnId: 'turn-1',
    startedAt: Date.now(),
    agentText: new Map(),
    typingTimer,
  }
  internal.runs.set(session.codexThreadId, run)
  return { bot, internal, codex, session, channel, messages, run, typingTimer }
}

test('stale Codex responses retire approval, action, and user-input controls', async () => {
  const codex = new StaleResponseCodex()
  const { bot, internal, messages, typingTimer } = makeHarness(codex)
  internal.requireAccess = async () => true
  try {
    await internal.handleServerRequest(approvalRequest('stale-approval'))
    const approvalMessage = messages.at(-1)
    assert.ok(approvalMessage)
    const [approvalKey] = internal.approvals.keys()
    assert.ok(approvalKey)
    const approvalUpdates: EditPayload[] = []
    await assert.doesNotReject(() => internal.handleButton({
      customId: `approve:${approvalKey}:0`,
      channelId: 'discord-thread-1',
      user: { id: 'user-1' },
      async update(payload: EditPayload) {
        approvalUpdates.push(payload)
      },
      async reply() {},
    } as unknown as ButtonInteraction))
    assert.equal(internal.approvals.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.equal(approvalUpdates.at(-1)?.components.length, 0)

    await internal.handleServerRequest(actionButtonsRequest('stale-action'))
    const [actionKey] = internal.pendingActionButtons.keys()
    assert.ok(actionKey)
    const actionUpdates: EditPayload[] = []
    await assert.doesNotReject(() => internal.handleButton({
      customId: `action-tool:${actionKey}:0`,
      channelId: 'discord-thread-1',
      user: { id: 'user-1' },
      async update(payload: EditPayload) {
        actionUpdates.push(payload)
      },
      async reply() {},
    } as unknown as ButtonInteraction))
    assert.equal(internal.pendingActionButtons.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.deepEqual(actionUpdates.at(-1), {
      content: '**Action Required**\n_Selected: Continue_',
      components: [],
    })

    await internal.handleServerRequest(userInputRequest('stale-input', 20))
    const inputMessage = messages.at(-1)
    assert.ok(inputMessage)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(internal.pendingUserInputs.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.equal(inputMessage.edits.at(-1)?.components.length, 0)
    assert.match(inputMessage.edits.at(-1)?.content || '', /Auto-resolved/)

    assert.deepEqual(codex.staleResponseAttempts, [
      'stale-approval',
      'stale-action',
      'stale-input',
    ])
    assert.deepEqual(codex.responses, [])
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

function approvalRequest(id: string | number): ServerRequest {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      command: 'printf resolved',
    },
  }
}

function userInputRequest(id: string | number, autoResolutionMs = 1_000): ServerRequest {
  return {
    id,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      autoResolutionMs,
      questions: [{
        id: 'confirmation',
        header: 'Confirm',
        question: 'Continue?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Continue', description: 'Proceed with the operation.' }],
      }],
    },
  }
}

function actionButtonsRequest(id: string | number): ServerRequest {
  return {
    id,
    method: 'item/tool/call',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      callId: `call-${String(id)}`,
      namespace: null,
      tool: 'cordex_action_buttons',
      arguments: { buttons: [{ label: 'Continue', color: 'green' }] },
    },
  }
}

test('serverRequest/resolved retires every pending Discord control without responding', async () => {
  const { bot, internal, codex, messages, typingTimer } = makeHarness()
  try {
    await internal.handleServerRequest(approvalRequest('approval-1'))
    const approvalMessage = messages.at(-1)
    assert.ok(approvalMessage)
    const approvalContent = approvalMessage.content
    assert.equal(internal.pendingRequestControls.has('string:approval-1'), true)
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'different-thread', requestId: 'approval-1' },
    })
    assert.equal(internal.approvals.size, 1)
    assert.deepEqual(approvalMessage.edits, [])
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'codex-thread-1', requestId: 'approval-1' },
    })
    assert.equal(internal.approvals.size, 0)
    assert.deepEqual(approvalMessage.edits.at(-1), {
      content: `${approvalContent}\n\n**Resolved elsewhere.**`,
      components: [],
    })

    await internal.handleServerRequest(userInputRequest('input-1', 20))
    const inputMessage = messages.at(-1)
    assert.ok(inputMessage)
    const inputContent = inputMessage.content
    assert.equal(internal.pendingRequestControls.has('string:input-1'), true)
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'codex-thread-1', requestId: 'input-1' },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(internal.pendingUserInputs.size, 0)
    assert.deepEqual(inputMessage.edits.at(-1), {
      content: `${inputContent}\n_Resolved elsewhere._`,
      components: [],
    })

    await internal.handleServerRequest(actionButtonsRequest(77))
    const actionMessage = messages.at(-1)
    assert.ok(actionMessage)
    assert.equal(internal.pendingRequestControls.has('number:77'), true)
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'codex-thread-1', requestId: 77 },
    })
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: { threadId: 'codex-thread-1', requestId: 77 },
    })
    assert.equal(internal.pendingActionButtons.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.deepEqual(actionMessage.edits, [{
      content: '**Action Required**\n_Resolved elsewhere._',
      components: [],
    }])
    assert.deepEqual(codex.responses, [])
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('abort retires approvals, user input, and action buttons without duplicate Codex responses', async () => {
  const { bot, internal, codex, session, channel, messages, typingTimer } = makeHarness()
  try {
    await internal.handleServerRequest(approvalRequest('approval-abort'))
    await internal.handleServerRequest(userInputRequest('input-abort'))
    await internal.handleServerRequest(actionButtonsRequest('action-abort'))
    const replies: string[] = []
    const interaction = {
      channel,
      async reply(value: string | { content: string }) {
        replies.push(typeof value === 'string' ? value : value.content)
      },
    } as unknown as ChatInputCommandInteraction

    await internal.handleAbortCommand(interaction)

    assert.deepEqual(codex.interrupts, [{ threadId: session.codexThreadId, turnId: 'turn-1' }])
    assert.deepEqual(codex.responses, [])
    assert.deepEqual(replies, ['Abort requested.'])
    assert.equal(internal.approvals.size, 0)
    assert.equal(internal.pendingUserInputs.size, 0)
    assert.equal(internal.pendingActionButtons.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.equal(messages.every((message) => message.edits.at(-1)?.components.length === 0), true)
    assert.equal(messages.every((message) => message.content.includes('Turn aborted.')), true)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('terminal turn cleanup retires every pending control without responding', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-request-resolution-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { bot, internal, codex, run, messages, typingTimer } = makeHarness()
  try {
    await internal.handleServerRequest(approvalRequest('approval-terminal'))
    await internal.handleServerRequest(userInputRequest('input-terminal'))
    await internal.handleServerRequest(actionButtonsRequest('action-terminal'))

    await internal.onTurnCompleted(run, {
      threadId: 'codex-thread-1',
      turn: { id: 'turn-1', status: 'interrupted', durationMs: 10 },
    })

    assert.deepEqual(codex.responses, [])
    assert.equal(internal.approvals.size, 0)
    assert.equal(internal.pendingUserInputs.size, 0)
    assert.equal(internal.pendingActionButtons.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)
    assert.equal(messages.every((message) => message.edits.at(-1)?.components.length === 0), true)
    assert.equal(messages.every((message) => message.content.includes('Turn ended.')), true)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
