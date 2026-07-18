import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { ButtonInteraction, ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, ScheduledTask } from '../src/types.js'

class FakeCodex extends EventEmitter {}

type TaskPayload = {
  content: string
  components?: Array<{ toJSON(): unknown }>
}

type SchedulerStub = {
  runNow(taskId: string): Promise<boolean>
  cancel(taskId: string): Promise<boolean>
  deleteTerminal(taskId: string): Promise<boolean>
}

type InternalBot = {
  scheduler: SchedulerStub
  handleTasksCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleButton(interaction: ButtonInteraction): Promise<void>
  requireAccess(interaction: ButtonInteraction): Promise<boolean>
  enqueuePrompt(threadId: string, prompt: CordexState['queues'][string][number]): Promise<number>
  recoverPersistedPrompts(
    session: CordexState['sessions'][string],
    channel: ThreadChannel,
  ): Promise<void>
  runScheduledTask(task: ScheduledTask): Promise<void>
}

function config(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
  }
}

function task(index: number, status: ScheduledTask['status'] = 'scheduled'): ScheduledTask {
  return {
    id: `task-${index}`,
    threadId: `thread-${index}`,
    prompt: `Prompt ${index}`,
    runAt: new Date(Date.now() + index * 60_000).toISOString(),
    createdBy: 'user-1',
    status,
  }
}

function state(tasks: ScheduledTask[]): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {},
    queues: {},
    tasks: Object.fromEntries(tasks.map((entry) => [entry.id, entry])),
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('/tasks includes channel mentions and batches bounded Run now/Delete controls', async () => {
  const currentState = state(Array.from({ length: 7 }, (_, index) => task(index + 1)))
  const bot = new CordexDiscordBot(
    config(),
    currentState,
    new FakeCodex() as unknown as CodexAppServer,
  )
  const payloads: TaskPayload[] = []
  const interaction = {
    options: { getBoolean: () => false },
    async reply(payload: TaskPayload) {
      payloads.push(payload)
      return undefined as never
    },
    async followUp(payload: TaskPayload) {
      payloads.push(payload)
      return undefined as never
    },
  } as unknown as ChatInputCommandInteraction

  try {
    await (bot as unknown as InternalBot).handleTasksCommand(interaction)
    assert.equal(payloads.length, 2)
    assert.equal(payloads[0]?.components?.length, 5)
    assert.equal(payloads[1]?.components?.length, 2)
    assert.match(payloads[0]?.content || '', /<#thread-1>/)
    const firstRow = payloads[0]?.components?.[0]?.toJSON() as {
      components?: Array<{ custom_id?: string; label?: string }>
    }
    assert.deepEqual(firstRow.components?.map((component) => ({
      id: component.custom_id,
      label: component.label,
    })), [
      { id: 'task:run:task-1', label: 'Run now' },
      { id: 'task:delete:task-1', label: 'Delete' },
    ])
  } finally {
    bot.client.destroy()
  }
})

test('scheduled task buttons route through durable scheduler transitions', async () => {
  const runTask = task(1)
  const deleteTask = task(2)
  const currentState = state([runTask, deleteTask])
  const bot = new CordexDiscordBot(
    config(),
    currentState,
    new FakeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  const calls: string[] = []
  internal.scheduler = {
    async runNow(taskId) {
      calls.push(`run:${taskId}`)
      return true
    },
    async cancel(taskId) {
      calls.push(`cancel:${taskId}`)
      const current = currentState.tasks[taskId]
      if (current) current.status = 'cancelled'
      return Boolean(current)
    },
    async deleteTerminal(taskId) {
      calls.push(`delete:${taskId}`)
      const current = currentState.tasks[taskId]
      if (!current || !['completed', 'failed', 'cancelled'].includes(current.status)) return false
      delete currentState.tasks[taskId]
      return true
    },
  }
  internal.requireAccess = async () => true

  const click = async (customId: string): Promise<string> => {
    let reply = ''
    await internal.handleButton({
      customId,
      async deferReply() {},
      async editReply(value: string) {
        reply = value
        return undefined as never
      },
    } as unknown as ButtonInteraction)
    return reply
  }

  try {
    assert.match(await click(`task:run:${runTask.id}`), /Ran scheduled task/)
    assert.match(await click(`task:delete:${deleteTask.id}`), /Deleted scheduled task/)
    assert.deepEqual(calls, [
      `run:${runTask.id}`,
      `cancel:${deleteTask.id}`,
      `delete:${deleteTask.id}`,
    ])
    assert.equal(currentState.tasks[deleteTask.id], undefined)
  } finally {
    bot.client.destroy()
  }
})

test('scheduled delivery succeeds at durable enqueue even when immediate drain fails', async () => {
  const oneShot = task(1, 'running')
  const currentState = state([oneShot])
  currentState.sessions[oneShot.threadId] = {
    discordThreadId: oneShot.threadId,
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    updatedAt: new Date().toISOString(),
  }
  const bot = new CordexDiscordBot(
    config(),
    currentState,
    new FakeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  const queued: CordexState['queues'][string] = []
  const channel = {
    id: oneShot.threadId,
    guildId: 'guild-1',
    parentId: 'parent-1',
    isThread: () => true,
    async send() {
      return { id: 'message-1' }
    },
  } as unknown as ThreadChannel
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async () => channel
  internal.enqueuePrompt = async (_threadId, prompt) => {
    queued.push(prompt)
    return queued.length
  }
  internal.recoverPersistedPrompts = async () => {
    throw new Error('Discord drain unavailable')
  }

  try {
    await internal.runScheduledTask(oneShot)
    assert.equal(queued.length, 1)
    assert.strictEqual(currentState.tasks[oneShot.id], oneShot)
  } finally {
    bot.client.destroy()
  }
})

test('cancelling and deleting a running task does not resurrect it around an accepted enqueue', async () => {
  const oneShot = task(1, 'running')
  const currentState = state([oneShot])
  currentState.sessions[oneShot.threadId] = {
    discordThreadId: oneShot.threadId,
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    updatedAt: new Date().toISOString(),
  }
  const bot = new CordexDiscordBot(
    config(),
    currentState,
    new FakeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  const enqueueStarted = deferred()
  const allowEnqueue = deferred()
  const queued: CordexState['queues'][string] = []
  const channel = {
    id: oneShot.threadId,
    guildId: 'guild-1',
    parentId: 'parent-1',
    isThread: () => true,
    async send() {
      return { id: 'message-1' }
    },
  } as unknown as ThreadChannel
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async () => channel
  internal.enqueuePrompt = async (_threadId, prompt) => {
    enqueueStarted.resolve()
    await allowEnqueue.promise
    queued.push(prompt)
    return queued.length
  }
  internal.recoverPersistedPrompts = async () => undefined

  try {
    const delivery = internal.runScheduledTask(oneShot)
    await enqueueStarted.promise
    oneShot.status = 'cancelled'
    delete currentState.tasks[oneShot.id]
    allowEnqueue.resolve()
    await delivery

    assert.equal(queued.length, 1)
    assert.equal(currentState.tasks[oneShot.id], undefined)
  } finally {
    allowEnqueue.resolve()
    bot.client.destroy()
  }
})
