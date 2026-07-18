import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { AutocompleteInteraction, ThreadChannel } from 'discord.js'
import { Events } from 'discord.js'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { KeyedSerialQueue } from '../src/serial.js'
import type {
  CordexConfig,
  CordexState,
  ServerNotification,
  ServerRequest,
  SessionState,
} from '../src/types.js'

type InternalBot = {
  pendingDiscordIngress: Set<Promise<void>>
  pendingCodexNotifications: Set<Promise<void>>
  pendingCodexServerRequests: Set<Promise<void>>
  pendingCodexLifecycle: Set<Promise<void>>
  pendingCodexDeletionCleanups: Set<Promise<void>>
  pendingBackgroundWork: Set<Promise<void>>
  titleVerificationRetryTimers: Map<string, NodeJS.Timeout>
  state: CordexState
  projectMutationQueue: KeyedSerialQueue
  discordOutboxStateQueue: KeyedSerialQueue
  scheduler: { start(): void }
  pruneAttachmentCache(): Promise<void>
  handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>
  enqueueNotification(notification: ServerNotification, generation: number): Promise<void>
  enqueueServerRequest(request: ServerRequest, generation: number): Promise<void>
  onCodexRecovered(generation: number): Promise<void>
  beginCodexRecovery(generation: number): void
  waitForMutationIngressReady(): Promise<void>
  scheduleQueueDrain(
    session: SessionState,
    channel: ThreadChannel,
    allowWithoutGoal: boolean,
    knownGoalStatus?: string,
  ): void
  scheduleTitleVerificationRetry(session: SessionState): void
  retryPendingSessionTitle(session: SessionState): Promise<void>
}

class ShutdownCodex extends EventEmitter {
  generation = 1
  closeCalls = 0

  constructor(private readonly onClose: () => void = () => undefined) {
    super()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.onClose()
  }
}

function makeConfig(): CordexConfig {
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

function makeAutocomplete(): AutocompleteInteraction {
  return {
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  } as unknown as AutocompleteInteraction
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function fixture(codex = new ShutdownCodex()): {
  bot: CordexDiscordBot
  codex: ShutdownCodex
  internal: InternalBot
  destroyed: () => number
} {
  const bot = new CordexDiscordBot(
    makeConfig(),
    makeState(),
    codex as unknown as CodexAppServer,
  )
  let destroyCalls = 0
  Object.defineProperty(bot.client, 'destroy', {
    configurable: true,
    value: () => {
      destroyCalls += 1
    },
  })
  return {
    bot,
    codex,
    internal: bot as unknown as InternalBot,
    destroyed: () => destroyCalls,
  }
}

test('stop drains accepted Discord ingress, rejects new ingress, and is concurrent-safe', async () => {
  const gate = deferred()
  const started = deferred()
  const { bot, codex, internal, destroyed } = fixture()
  let calls = 0
  internal.handleAutocomplete = async () => {
    calls += 1
    started.resolve()
    await gate.promise
  }

  const emitter = bot.client as unknown as EventEmitter
  emitter.emit(Events.InteractionCreate, makeAutocomplete())
  await started.promise

  const firstStop = bot.stop()
  const secondStop = bot.stop()
  emitter.emit(Events.InteractionCreate, makeAutocomplete())
  await nextTurn()

  assert.equal(calls, 1)
  assert.equal(codex.closeCalls, 0)
  assert.equal(destroyed(), 0)

  gate.resolve()
  await Promise.all([firstStop, secondStop])
  await bot.stop()

  assert.equal(codex.closeCalls, 1)
  assert.equal(destroyed(), 1)
  assert.equal(internal.pendingDiscordIngress.size, 0)
})

test('stop drains Codex handlers, lifecycle work, deletion cleanup, and keyed state work', async () => {
  const gate = deferred()
  const starts = [deferred(), deferred(), deferred(), deferred(), deferred(), deferred()]
  const order: string[] = []
  const codex = new ShutdownCodex(() => order.push('codex-close'))
  const { bot, internal, destroyed } = fixture(codex)

  const wait = async (label: string, index: number) => {
    order.push(`${label}-start`)
    starts[index]?.resolve()
    await gate.promise
    order.push(`${label}-end`)
  }
  internal.enqueueNotification = async () => wait('notification', 0)
  internal.enqueueServerRequest = async () => wait('request', 1)
  internal.onCodexRecovered = async () => wait('lifecycle', 2)

  codex.emit('notification', { method: 'fixture/notification', params: {} })
  codex.emit('serverRequest', { id: 1, method: 'fixture/request', params: {} })
  codex.emit('ready', { generation: 1, restartAttempt: 1 })

  const deletion = wait('deletion', 3)
  internal.pendingCodexDeletionCleanups.add(deletion)
  void deletion.finally(() => internal.pendingCodexDeletionCleanups.delete(deletion))
  void internal.projectMutationQueue.run('fixture', () => wait('mutation', 4))
  void internal.discordOutboxStateQueue.run('state', () => wait('outbox', 5))

  await Promise.all(starts.map(({ promise }) => promise))
  const stopping = bot.stop()
  await nextTurn()
  assert.equal(codex.closeCalls, 0)

  gate.resolve()
  await stopping

  const closeIndex = order.indexOf('codex-close')
  assert.notEqual(closeIndex, -1)
  for (const label of ['notification', 'request', 'lifecycle', 'deletion', 'mutation', 'outbox']) {
    assert.ok(order.indexOf(`${label}-end`) < closeIndex, `${label} did not drain before Codex closed`)
  }
  assert.equal(internal.pendingCodexNotifications.size, 0)
  assert.equal(internal.pendingCodexServerRequests.size, 0)
  assert.equal(internal.pendingCodexLifecycle.size, 0)
  assert.equal(internal.pendingCodexDeletionCleanups.size, 0)
  assert.equal(destroyed(), 1)
})

test('stop breaks Discord mutation work out of an in-progress Codex recovery wait', async () => {
  const { bot, codex, internal, destroyed } = fixture()
  const started = deferred()
  let completed = false
  internal.beginCodexRecovery(codex.generation)
  internal.handleAutocomplete = async () => {
    started.resolve()
    await internal.waitForMutationIngressReady()
    completed = true
  }

  ;(bot.client as unknown as EventEmitter).emit(Events.InteractionCreate, makeAutocomplete())
  await started.promise
  let timeout!: NodeJS.Timeout
  try {
    await Promise.race([
      bot.stop(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('shutdown remained blocked on Codex recovery')),
          500,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }

  assert.equal(completed, false)
  assert.equal(codex.closeCalls, 1)
  assert.equal(destroyed(), 1)
  assert.equal(internal.pendingDiscordIngress.size, 0)
})

test('stop prevents in-progress startup from restarting work after teardown', async () => {
  const gate = deferred()
  const entered = deferred()
  const { bot, codex, internal, destroyed } = fixture()
  let schedulerStarts = 0
  internal.pruneAttachmentCache = async () => {
    entered.resolve()
    await gate.promise
  }
  internal.scheduler.start = () => {
    schedulerStarts += 1
  }

  const startupResult = assert.rejects(bot.start(), /Cordex is stopping/)
  await entered.promise
  await bot.stop()
  gate.resolve()
  await startupResult

  assert.equal(schedulerStarts, 0)
  assert.equal(codex.closeCalls, 1)
  assert.equal(destroyed(), 1)
})

test('stop drains a detached queue drain blocked on Codex recovery', async () => {
  const { bot, codex, internal, destroyed } = fixture()
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'project-1',
    directory: '/tmp/project',
    codexThreadId: 'codex-thread-1',
    updatedAt: new Date().toISOString(),
  }
  internal.beginCodexRecovery(codex.generation)
  internal.scheduleQueueDrain(
    session,
    { id: session.discordThreadId } as ThreadChannel,
    true,
  )
  assert.equal(internal.pendingBackgroundWork.size, 1)

  await bot.stop()

  assert.equal(internal.pendingBackgroundWork.size, 0)
  assert.equal(codex.closeCalls, 1)
  assert.equal(destroyed(), 1)
})

test('stop drains title retry work whose timer already fired', async () => {
  const gate = deferred()
  const started = deferred()
  const { bot, codex, internal, destroyed } = fixture()
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'project-1',
    directory: '/tmp/project',
    codexThreadId: 'codex-thread-1',
    updatedAt: new Date().toISOString(),
  }
  internal.state.sessions[session.discordThreadId] = session
  internal.retryPendingSessionTitle = async () => {
    started.resolve()
    await gate.promise
  }
  internal.scheduleTitleVerificationRetry(session)
  internal.titleVerificationRetryTimers.get(session.codexThreadId)?.ref()
  await started.promise
  assert.equal(internal.pendingBackgroundWork.size, 1)

  const stopping = bot.stop()
  await nextTurn()
  assert.equal(codex.closeCalls, 0)
  gate.resolve()
  await stopping

  assert.equal(internal.pendingBackgroundWork.size, 0)
  assert.equal(codex.closeCalls, 1)
  assert.equal(destroyed(), 1)
})
