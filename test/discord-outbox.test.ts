import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { emptyState, loadState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import {
  formatAssistantText,
  splitMarkdownForDiscord,
} from '../src/discord-output.js'
import type { CordexConfig, CordexState, JsonObject, SessionState } from '../src/types.js'

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

type SendPayload = string | {
  content?: string
  nonce?: string | number
  enforceNonce?: boolean
}

type TestRun = {
  session: SessionState
  channel: ThreadChannel
  model: string
  requestedModel: string
  effort: string
  turnId: string
  startedAt: number
  agentText: Map<string, string>
  typingTimer: NodeJS.Timeout
  lastError?: string
}

type InternalBot = {
  runs: Map<string, TestRun>
  onItemCompleted(run: TestRun, params: JsonObject): Promise<void>
  onTurnCompleted(run: TestRun, params: JsonObject, generation?: number): Promise<void>
  recoverDiscordOutbox(): Promise<void>
  scheduleQueueDrain(...args: unknown[]): void
  beginIngressBarrier(): void
  beginCodexRecovery(generation: number): void
  finishIngressBarrier(): void
  finishCodexRecovery(generation: number): void
  handleButton(interaction: unknown): Promise<void>
  handlePriorityCommand(interaction: unknown): Promise<void>
  handleUserInputSelect(interaction: unknown): Promise<void>
  handleUserInputModal(interaction: unknown): Promise<void>
  handleServerRequest(request: JsonObject): Promise<void>
  pendingUserInputs: Map<string, unknown>
  refreshProjectsSafely(): Promise<void>
  scheduler: {
    runNow(taskId: string): Promise<boolean>
    cancel(taskId: string): Promise<boolean>
    deleteTerminal(taskId: string): Promise<boolean>
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

function makeState(directory: string, suffix = '1'): { state: CordexState; session: SessionState } {
  const state = emptyState()
  const session: SessionState = {
    discordThreadId: `discord-thread-${suffix}`,
    parentChannelId: 'parent-1',
    directory,
    codexThreadId: `codex-thread-${suffix}`,
    model: 'gpt-test',
    effort: 'xhigh',
    activeTurnId: `turn-${suffix}`,
    updatedAt: new Date(0).toISOString(),
  }
  state.sessions[session.discordThreadId] = session
  return { state, session }
}

function makeRun(session: SessionState, channel: ThreadChannel): TestRun {
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  return {
    session,
    channel,
    model: 'gpt-test',
    requestedModel: 'gpt-test',
    effort: 'xhigh',
    turnId: session.activeTurnId || 'turn',
    startedAt: Date.now() - 1_000,
    agentText: new Map(),
    typingTimer,
  }
}

async function withFixture(
  run: (fixture: {
    home: string
    directory: string
    state: CordexState
    session: SessionState
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-outbox-home-'))
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-outbox-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const { state, session } = makeState(directory)
  try {
    await run({ home, directory, state, session })
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('completed output is persisted before send and duplicate item notifications do not resend', async () => {
  await withFixture(async ({ directory, state, session }) => {
    const payloads: Array<Exclude<SendPayload, string>> = []
    const channel = {
      id: session.discordThreadId,
      async send(payload: SendPayload) {
        assert.equal(typeof payload, 'object')
        const resolved = payload as Exclude<SendPayload, string>
        const persisted = await loadState()
        assert.ok(persisted.discordOutbox?.some((entry) => entry.nonce === resolved.nonce))
        payloads.push(resolved)
        return { async edit() { return this } }
      },
    } as unknown as ThreadChannel
    const bot = new CordexDiscordBot(
      makeConfig(directory),
      state,
      new FakeCodex() as unknown as CodexAppServer,
    )
    const internal = bot as unknown as InternalBot
    const run = makeRun(session, channel)
    const params = {
      threadId: session.codexThreadId,
      turnId: run.turnId,
      item: { type: 'agentMessage', id: 'message-1', text: 'Durable response.' },
    }

    try {
      await internal.onItemCompleted(run, params)
      await internal.onItemCompleted(run, {
        ...params,
        item: {
          ...params.item,
          text: `Durable response.\n${'Duplicate payload must stay suppressed.\n'.repeat(100)}`,
        },
      })

      assert.equal(payloads.length, 1)
      assert.equal(payloads[0]?.content, 'Durable response.')
      assert.equal(payloads[0]?.enforceNonce, true)
      assert.equal(typeof payloads[0]?.nonce, 'string')
      assert.ok(String(payloads[0]?.nonce).length <= 32)
      assert.deepEqual(state.discordOutbox, [])
      assert.equal(state.discordOutboxDeliveredKeys?.length, 2)
      const deliveredKey = state.discordOutboxDeliveredKeys?.find((key) => key.includes('chunk:0')) || ''
      assert.match(deliveredKey, /codex-thread-1/)
      assert.match(deliveredKey, /turn-1/)
      assert.match(deliveredKey, /message-1/)
      assert.match(deliveredKey, /chunk:0/)
      assert.deepEqual((await loadState()).discordOutbox, [])
    } finally {
      clearInterval(run.typingTimer)
      bot.client.destroy()
    }
  })
})

test('a crash after a partial chunk send recovers only unsent chunks with stable nonces', async () => {
  await withFixture(async ({ directory, state, session }) => {
    const answer = [
      '**Durable output**',
      ...Array.from({ length: 180 }, (_, index) => `- chunk line ${index}: ${'x'.repeat(30)}`),
    ].join('\n')
    const expectedChunks = splitMarkdownForDiscord(formatAssistantText(answer), 1_900)
    assert.ok(expectedChunks.length > 2)
    const firstPayloads: Array<Exclude<SendPayload, string>> = []
    let attempts = 0
    let failedNonce: string | number | undefined
    const firstChannel = {
      id: session.discordThreadId,
      async send(payload: SendPayload) {
        attempts += 1
        assert.equal(typeof payload, 'object')
        const resolved = payload as Exclude<SendPayload, string>
        assert.ok((await loadState()).discordOutbox?.some((entry) => entry.nonce === resolved.nonce))
        if (attempts === 2) {
          failedNonce = resolved.nonce
          throw new Error('Discord temporarily unavailable')
        }
        firstPayloads.push(resolved)
        return { async edit() { return this } }
      },
    } as unknown as ThreadChannel
    const firstBot = new CordexDiscordBot(
      makeConfig(directory),
      state,
      new FakeCodex() as unknown as CodexAppServer,
    )
    const firstRun = makeRun(session, firstChannel)

    try {
      await assert.rejects(
        (firstBot as unknown as InternalBot).onItemCompleted(firstRun, {
          threadId: session.codexThreadId,
          turnId: firstRun.turnId,
          item: { type: 'agentMessage', id: 'message-chunked', text: answer },
        }),
        /temporarily unavailable/,
      )
      assert.deepEqual(firstPayloads.map((payload) => payload.content), expectedChunks.slice(0, 1))
      assert.deepEqual(
        state.discordOutbox?.map((entry) => entry.chunkIndex),
        expectedChunks.slice(1).map((_, index) => index + 1),
      )
    } finally {
      clearInterval(firstRun.typingTimer)
      firstBot.client.destroy()
    }

    const recoveredState = await loadState()
    const recoveredPayloads: Array<Exclude<SendPayload, string>> = []
    const recoveredChannel = {
      id: session.discordThreadId,
      isThread: () => true,
      async send(payload: SendPayload) {
        assert.equal(typeof payload, 'object')
        recoveredPayloads.push(payload as Exclude<SendPayload, string>)
        return { async edit() { return this } }
      },
    } as unknown as ThreadChannel
    const recoveredBot = new CordexDiscordBot(
      makeConfig(directory),
      recoveredState,
      new FakeCodex() as unknown as CodexAppServer,
    )
    ;(recoveredBot.client.channels as unknown as {
      fetch(id: string): Promise<ThreadChannel>
    }).fetch = async (id: string) => {
      assert.equal(id, session.discordThreadId)
      return recoveredChannel
    }

    try {
      await (recoveredBot as unknown as InternalBot).recoverDiscordOutbox()
      assert.deepEqual(
        recoveredPayloads.map((payload) => payload.content),
        expectedChunks.slice(1),
      )
      assert.equal(recoveredPayloads[0]?.nonce, failedNonce)
      assert.ok(recoveredPayloads.every((payload) => payload.enforceNonce === true))
      assert.ok(recoveredPayloads.every((payload) => String(payload.nonce).length <= 32))
      assert.deepEqual(recoveredState.discordOutbox, [])
      assert.equal(recoveredState.discordOutboxDeliveredKeys?.length, expectedChunks.length + 1)
      assert.deepEqual((await loadState()).discordOutbox, [])
    } finally {
      recoveredBot.client.destroy()
    }
  })
})

test('footer is durable before turn finalization and delivery cannot hold queue drain', async () => {
  await withFixture(async ({ directory, state, session }) => {
    let releaseSend: () => void = () => undefined
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    let sendCalls = 0
    const channel = {
      id: session.discordThreadId,
      async send(payload: SendPayload) {
        sendCalls += 1
        assert.equal(typeof payload, 'object')
        await sendGate
        return { async edit() { return this } }
      },
    } as unknown as ThreadChannel
    const bot = new CordexDiscordBot(
      makeConfig(directory),
      state,
      new FakeCodex() as unknown as CodexAppServer,
    )
    const internal = bot as unknown as InternalBot & {
      dismissPendingControlsForChannel(): Promise<void>
    }
    const run = makeRun(session, channel)
    internal.runs.set(session.codexThreadId, run)
    let drainCalls = 0
    let stagedState: CordexState | undefined
    internal.scheduleQueueDrain = () => {
      drainCalls += 1
    }
    internal.dismissPendingControlsForChannel = async () => {
      stagedState = await loadState()
    }

    try {
      await internal.onTurnCompleted(run, {
        threadId: session.codexThreadId,
        turnId: run.turnId,
        turn: { id: run.turnId, status: 'completed', durationMs: 1_000 },
      })

      assert.equal(stagedState?.sessions[session.discordThreadId]?.activeTurnId, run.turnId)
      assert.deepEqual(stagedState?.discordOutbox?.map((entry) => entry.itemKey), ['footer'])
      assert.equal(session.activeTurnId, undefined)
      assert.equal(internal.runs.has(session.codexThreadId), false)
      assert.equal(drainCalls, 1)
      await waitFor(() => sendCalls === 1)

      const finalizedState = await loadState()
      assert.equal(finalizedState.sessions[session.discordThreadId]?.activeTurnId, undefined)
      assert.deepEqual(finalizedState.discordOutbox?.map((entry) => entry.itemKey), ['footer'])

      releaseSend()
      await waitFor(() => state.discordOutbox?.length === 0)
    } finally {
      releaseSend()
      clearInterval(run.typingTimer)
      bot.client.destroy()
    }
  })
})

test('mutating interactions acknowledge then wait for startup and restart recovery', async () => {
  await withFixture(async ({ directory, state, session }) => {
    const codex = new FakeCodex()
    const bot = new CordexDiscordBot(
      makeConfig(directory),
      state,
      codex as unknown as CodexAppServer,
    )
    const internal = bot as unknown as InternalBot
    internal.refreshProjectsSafely = async () => undefined
    const taskId = 'task-barrier'
    state.tasks[taskId] = {
      id: taskId,
      threadId: session.discordThreadId,
      prompt: 'Run after recovery.',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: 'user-1',
      status: 'scheduled',
    }
    const schedulerCalls: string[] = []
    internal.scheduler = {
      async runNow(id) {
        schedulerCalls.push(id)
        return true
      },
      async cancel() {
        return true
      },
      async deleteTerminal() {
        return true
      },
    }
    internal.pendingUserInputs.set('select-key', {
      request: { id: 'select-request', method: 'item/tool/requestUserInput', params: {} },
      channel: { id: session.discordThreadId },
      questions: [{
        id: 'selection',
        header: 'Selection',
        question: 'Continue?',
        isOther: false,
        isSecret: true,
        options: [{ label: 'Continue', description: 'Proceed.' }],
      }],
      answers: {},
      messages: [],
    })
    internal.pendingUserInputs.set('modal-key', {
      request: { id: 'modal-request', method: 'item/tool/requestUserInput', params: {} },
      channel: { id: session.discordThreadId },
      questions: [{
        id: 'answer',
        header: 'Answer',
        question: 'Value?',
        isOther: false,
        isSecret: true,
        options: null,
      }],
      answers: {},
      messages: [],
    })
    const acknowledgments: string[] = []
    const replies: string[] = []
    const abortState = { deferred: false, replied: false }
    const abortChannel = {
      id: session.discordThreadId,
      isThread: () => true,
    }

    internal.beginIngressBarrier()
    internal.beginCodexRecovery(7)
    const interactions = [
      internal.handleButton({
        customId: `task:run:${taskId}`,
        guildId: 'guild-1',
        user: { id: 'user-1' },
        async deferReply() {
          acknowledgments.push('button')
        },
        async editReply(value: string) {
          replies.push(value)
        },
      }),
      internal.handlePriorityCommand({
        commandName: 'abort',
        channelId: session.discordThreadId,
        channel: abortChannel,
        guildId: 'guild-1',
        user: { id: 'user-1' },
        options: {},
        get deferred() {
          return abortState.deferred
        },
        get replied() {
          return abortState.replied
        },
        async deferReply() {
          abortState.deferred = true
          acknowledgments.push('abort')
        },
        async editReply(value: string | { content: string }) {
          abortState.replied = true
          replies.push(typeof value === 'string' ? value : value.content)
        },
        async followUp(value: string | { content: string }) {
          replies.push(typeof value === 'string' ? value : value.content)
        },
        async reply(value: string | { content: string }) {
          abortState.replied = true
          replies.push(typeof value === 'string' ? value : value.content)
        },
      }),
      internal.handleUserInputSelect({
        customId: 'userinput:select-key:0',
        values: ['option:0'],
        guildId: 'guild-1',
        user: { id: 'user-1', displayName: 'Fixture User' },
        async deferUpdate() {
          acknowledgments.push('select')
        },
        async reply() {},
        async followUp() {},
      }),
      internal.handleUserInputModal({
        customId: 'userinput-modal:modal-key:0',
        guildId: 'guild-1',
        user: { id: 'user-1', displayName: 'Fixture User' },
        fields: { getTextInputValue: () => 'private answer' },
        async deferUpdate() {
          acknowledgments.push('modal')
        },
        async reply() {},
        async followUp() {},
      }),
    ]

    try {
      await waitFor(() => acknowledgments.length === 4)
      assert.deepEqual(schedulerCalls, [])
      assert.deepEqual(codex.interrupts, [])
      assert.equal(codex.responses.length, 0)

      internal.finishIngressBarrier()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(schedulerCalls, [])
      assert.deepEqual(codex.interrupts, [])
      assert.equal(codex.responses.length, 0)

      internal.finishCodexRecovery(7)
      await Promise.all(interactions)
      assert.deepEqual(schedulerCalls, [taskId])
      assert.deepEqual(codex.interrupts, [{
        threadId: session.codexThreadId,
        turnId: session.activeTurnId,
      }])
      assert.deepEqual(codex.responses.map((response) => response.id).sort(), [
        'modal-request',
        'select-request',
      ])
      assert.equal(internal.pendingUserInputs.size, 0)
      assert.match(replies.join('\n'), /Ran scheduled task/)
      assert.match(replies.join('\n'), /Abort requested/)
    } finally {
      internal.finishIngressBarrier()
      internal.finishCodexRecovery(7)
      await Promise.allSettled(interactions)
      bot.client.destroy()
    }
  })
})

for (const completion of [
  { status: 'completed', itemKey: 'footer' },
  { status: 'failed', itemKey: 'failure' },
] as const) {
  test(`${completion.itemKey} delivery failure does not block turn finalization or queue drain`, async () => {
    await withFixture(async ({ directory, state, session }) => {
      let drainCalls = 0
      let sendCalls = 0
      const channel = {
        id: session.discordThreadId,
        async send(payload: SendPayload) {
          sendCalls += 1
          assert.equal(typeof payload, 'object')
          const persisted = await loadState()
          assert.ok(persisted.discordOutbox?.some(
            (entry) => entry.itemKey === completion.itemKey,
          ))
          throw new Error('Discord offline')
        },
      } as unknown as ThreadChannel
      const bot = new CordexDiscordBot(
        makeConfig(directory),
        state,
        new FakeCodex() as unknown as CodexAppServer,
      )
      const internal = bot as unknown as InternalBot
      const run = makeRun(session, channel)
      internal.runs.set(session.codexThreadId, run)
      internal.scheduleQueueDrain = () => {
        drainCalls += 1
      }

      try {
        await internal.onTurnCompleted(run, {
          threadId: session.codexThreadId,
          turnId: run.turnId,
          turn: {
            id: run.turnId,
            status: completion.status,
            durationMs: 1_000,
            ...(completion.status === 'failed'
              ? { error: { message: 'Terminal failure.' } }
              : {}),
          },
        })

        await waitFor(() => sendCalls === 1)
        assert.equal(sendCalls, 1)
        assert.equal(session.activeTurnId, undefined)
        assert.equal(internal.runs.has(session.codexThreadId), false)
        assert.equal(drainCalls, 1)
        assert.deepEqual(state.discordOutbox?.map((entry) => entry.itemKey), [completion.itemKey])
        const persisted = await loadState()
        assert.equal(persisted.sessions[session.discordThreadId]?.activeTurnId, undefined)
        assert.deepEqual(
          persisted.discordOutbox?.map((entry) => entry.itemKey),
          [completion.itemKey],
        )
      } finally {
        clearInterval(run.typingTimer)
        bot.client.destroy()
      }
    })
  })
}
