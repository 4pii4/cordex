import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { normalizeThreadTitle, threadTitleMaxLength } from '../src/thread-title.js'
import type {
  CordexConfig,
  CordexState,
  ServerNotification,
  SessionState,
} from '../src/types.js'

type InternalBot = {
  discordIngressQueue: {
    run<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  expectedDiscordTitles: Map<string, string>
  expectedCodexTitles: Map<string, string>
  pendingCodexTitles: Map<string, string>
  pendingDiscordTitles: Map<string, string>
  pendingCodexTitleVerifications: Map<string, string>
  pendingDiscordTitleVerifications: Map<string, string>
  recentDiscordTitleEchoes: Map<string, Map<string, number>>
  titleVerificationRetryTimers: Map<string, NodeJS.Timeout>
  deferCodexTitleVerification(session: SessionState, title: string): void
  deferDiscordTitleVerification(session: SessionState, title: string): void
  handleRenameCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  preserveDiscordTitleEchoesAcrossRestart(): void
  retryPendingSessionTitle(session: SessionState): Promise<void>
  synchronizeCodexThreadTitle(threadId: string, value: string): Promise<string>
}

class TitleCodex extends EventEmitter {
  readonly names: Array<{ threadId: string; name: string }> = []
  private currentName: string

  constructor(
    initialName = 'Initial title',
    private failuresRemaining = 0,
    private summaryFailuresRemaining = 0,
  ) {
    super()
    this.currentName = initialName
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.names.push({ threadId, name })
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('Fixture Codex title failure')
    }
    this.currentName = name
  }

  async getThreadSummary(threadId: string) {
    if (this.summaryFailuresRemaining > 0) {
      this.summaryFailuresRemaining -= 1
      throw new Error('Fixture Codex summary failure')
    }
    return {
      id: threadId,
      preview: '',
      name: this.currentName,
      cwd: '/tmp/title-project',
      updatedAt: Date.now(),
    }
  }

  setAuthoritativeName(name: string): void {
    this.currentName = name
  }
}

type TestThreadChannel = ThreadChannel & {
  nameCalls: string[]
  archived: boolean
}

function makeConfig(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: '/tmp/title-project' } },
  }
}

function makeSession(): SessionState {
  return {
    discordThreadId: 'discord-title-thread',
    parentChannelId: 'parent-1',
    directory: '/tmp/title-project',
    codexThreadId: 'codex-title-thread',
    model: 'gpt-test',
    updatedAt: new Date(0).toISOString(),
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

function makeChannel(name = 'Initial title', nameFailures = 0): TestThreadChannel {
  const channel = {
    id: 'discord-title-thread',
    name,
    parentId: 'parent-1',
    guildId: 'guild-1',
    archived: false,
    nameCalls: [] as string[],
    isThread: () => true,
    toString: () => '<#discord-title-thread>',
    async setName(value: string) {
      channel.nameCalls.push(value)
      if (nameFailures > 0) {
        nameFailures -= 1
        throw new Error('Fixture Discord title failure')
      }
      channel.name = value
      return channel
    },
  }
  return channel as unknown as TestThreadChannel
}

function makeRenameInteraction(
  channel: ThreadChannel,
  name: string,
  replies: string[],
): ChatInputCommandInteraction {
  return {
    channel,
    options: {
      getString(option: string) {
        return option === 'name' ? name : null
      },
    },
    async reply(value: string) {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
}

function makeFixture(
  name = 'Initial title',
  options: {
    codexFailures?: number
    codexSummaryFailures?: number
    discordFailures?: number
    discordFetchFailures?: number
  } = {},
) {
  const session = makeSession()
  const state = makeState(session)
  const codex = new TitleCodex(name, options.codexFailures, options.codexSummaryFailures)
  const channel = makeChannel(name, options.discordFailures)
  const bot = new CordexDiscordBot(makeConfig(), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  let fetchCount = 0
  let forcedFetchFailures = options.discordFetchFailures || 0
  ;(bot.client.channels as unknown as {
    fetch(id: string, options?: { force?: boolean }): Promise<ThreadChannel | undefined>
  }).fetch = async (id, fetchOptions) => {
    fetchCount += 1
    if (fetchOptions?.force && forcedFetchFailures > 0) {
      forcedFetchFailures -= 1
      throw new Error('Fixture Discord fetch failure')
    }
    return id === channel.id ? channel : undefined
  }
  return {
    bot,
    internal,
    state,
    session,
    codex,
    channel,
    fetchCount: () => fetchCount,
  }
}

async function flushThreadUpdate(internal: InternalBot, threadId: string): Promise<void> {
  await internal.discordIngressQueue.run(threadId, async () => undefined)
}

test('/rename writes one normalized title to Codex and Discord', async () => {
  const fixture = makeFixture()
  const replies: string[] = []
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, '  Renamed\n  session  ', replies),
    )

    assert.deepEqual(fixture.codex.names, [{
      threadId: fixture.session.codexThreadId,
      name: 'Renamed session',
    }])
    assert.deepEqual(fixture.channel.nameCalls, ['Renamed session'])
    assert.equal(fixture.channel.name, 'Renamed session')
    assert.deepEqual(replies, ['Session renamed to **Renamed session**.'])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('/rename compensates Codex when Discord rejects the second title write', async () => {
  const fixture = makeFixture('Initial title', { discordFailures: 2 })
  try {
    await assert.rejects(
      fixture.internal.handleRenameCommand(
        makeRenameInteraction(fixture.channel, 'Divergent target', []),
      ),
      /Fixture Discord title failure/,
    )

    assert.deepEqual(fixture.codex.names, [
      { threadId: fixture.session.codexThreadId, name: 'Divergent target' },
      { threadId: fixture.session.codexThreadId, name: 'Initial title' },
    ])
    assert.deepEqual(fixture.channel.nameCalls, ['Divergent target', 'Divergent target'])
    assert.equal(fixture.channel.name, 'Initial title')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('creation-time Codex title synchronization retries once', async () => {
  const fixture = makeFixture('Initial title', { codexFailures: 1 })
  try {
    await fixture.internal.synchronizeCodexThreadTitle(
      fixture.session.codexThreadId,
      'Retry title',
    )

    assert.deepEqual(fixture.codex.names, [
      { threadId: fixture.session.codexThreadId, name: 'Retry title' },
      { threadId: fixture.session.codexThreadId, name: 'Retry title' },
    ])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('Codex thread/name/updated normalizes and converges the Discord title', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: '  Remote\n   title  ',
      },
    })

    assert.deepEqual(fixture.codex.names, [{
      threadId: fixture.session.codexThreadId,
      name: 'Remote title',
    }])
    assert.deepEqual(fixture.channel.nameCalls, ['Remote title'])
    assert.equal(fixture.channel.name, 'Remote title')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('Discord ThreadUpdate normalizes the title and writes it to Codex', async () => {
  const fixture = makeFixture()
  const oldThread = { id: fixture.channel.id, name: fixture.channel.name }
  fixture.channel.name = '  Discord    title\n update '
  try {
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      oldThread,
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names, [{
      threadId: fixture.session.codexThreadId,
      name: 'Discord title update',
    }])
    assert.deepEqual(fixture.channel.nameCalls, ['Discord title update'])
    assert.equal(fixture.channel.name, 'Discord title update')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('expected Codex and Discord title echoes do not loop', async () => {
  const fixture = makeFixture()
  const replies: string[] = []
  const oldTitle = fixture.channel.name
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Echo target', replies),
    )
    assert.equal(fixture.internal.expectedCodexTitles.get(fixture.session.codexThreadId), 'Echo target')
    assert.equal(fixture.internal.expectedDiscordTitles.get(fixture.channel.id), 'Echo target')

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Echo target',
      },
    })
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: oldTitle },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.equal(fixture.internal.expectedCodexTitles.has(fixture.session.codexThreadId), false)
    assert.equal(fixture.internal.expectedDiscordTitles.has(fixture.channel.id), false)
    assert.equal(fixture.codex.names.length, 1)
    assert.equal(fixture.channel.nameCalls.length, 1)
  } finally {
    fixture.bot.client.destroy()
  }
})

test('delayed older title echoes cannot reverse a newer rename', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title A',
      },
    })
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      { ...fixture.channel, name: 'Title A' },
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title B',
      },
    })
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title A' },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('failed Discord authority fetch defers a stale echo until the current title is confirmed', async () => {
  const fixture = makeFixture('Initial title', { discordFetchFailures: 2 })
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )

    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      { ...fixture.channel, name: 'Title A' },
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.equal(
      fixture.internal.pendingDiscordTitleVerifications.get(fixture.channel.id),
      'Title A',
    )
    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    fixture.internal.recentDiscordTitleEchoes.clear()
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      { ...fixture.channel, name: 'Title A' },
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(
      fixture.internal.pendingDiscordTitleVerifications.get(fixture.channel.id),
      'Title A',
    )
    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(fixture.internal.pendingDiscordTitleVerifications.has(fixture.channel.id), false)
    assert.equal(
      fixture.internal.titleVerificationRetryTimers.has(fixture.session.codexThreadId),
      false,
    )
    assert.equal(fixture.codex.names.at(-1)?.name, 'Title B')
    assert.equal(fixture.channel.name, 'Title B')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('failed Discord authority fetch eventually applies a confirmed rename back', async () => {
  const fixture = makeFixture('Initial title', { discordFetchFailures: 1 })
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )
    fixture.channel.name = 'Title A'

    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.equal(
      fixture.internal.pendingDiscordTitleVerifications.get(fixture.channel.id),
      'Title A',
    )
    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(fixture.internal.pendingDiscordTitleVerifications.has(fixture.channel.id), false)
    assert.equal(fixture.codex.names.at(-1)?.name, 'Title A')
    assert.equal(fixture.channel.name, 'Title A')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('failed Codex authority lookup defers a stale echo until the current title is confirmed', async () => {
  const fixture = makeFixture('Initial title', { codexSummaryFailures: 2 })
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title A',
      },
    })

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.get(fixture.session.codexThreadId),
      'Title A',
    )
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title A',
      },
    })

    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.get(fixture.session.codexThreadId),
      'Title A',
    )
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.has(fixture.session.codexThreadId),
      false,
    )
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('confirmed stale title events remain quarantined when duplicated', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )

    for (let duplicate = 0; duplicate < 2; duplicate++) {
      await fixture.internal.handleNotification({
        method: 'thread/name/updated',
        params: {
          threadId: fixture.session.codexThreadId,
          threadName: 'Title A',
        },
      })
      ;(fixture.bot.client as unknown as EventEmitter).emit(
        'threadUpdate',
        { id: fixture.channel.id, name: 'Title B' },
        { ...fixture.channel, name: 'Title A' },
      )
      await flushThreadUpdate(fixture.internal, fixture.channel.id)
    }

    assert.equal(fixture.channel.name, 'Title B')
    assert.equal(fixture.codex.names.at(-1)?.name, 'Title B')
    assert.equal(
      fixture.codex.names.slice(2).some((entry) => entry.name === 'Title A'),
      false,
    )
  } finally {
    fixture.bot.client.destroy()
  }
})

test('Discord stale-echo protection survives a Codex restart', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )
    fixture.internal.preserveDiscordTitleEchoesAcrossRestart()

    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      { ...fixture.channel, name: 'Title A' },
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), ['Title A', 'Title B'])
    assert.equal(fixture.channel.name, 'Title B')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('latest pending title source is not blocked by an older authority failure', async () => {
  const fixture = makeFixture('Initial title', { codexSummaryFailures: 1 })
  try {
    fixture.internal.deferCodexTitleVerification(fixture.session, 'Older Codex title')
    fixture.channel.name = 'Latest Discord title'
    fixture.internal.deferDiscordTitleVerification(fixture.session, 'Latest Discord title')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.has(fixture.session.codexThreadId),
      false,
    )
    assert.equal(
      fixture.internal.pendingDiscordTitleVerifications.has(fixture.channel.id),
      false,
    )
    assert.equal(fixture.codex.names.at(-1)?.name, 'Latest Discord title')
    assert.equal(fixture.channel.name, 'Latest Discord title')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('failed Codex authority lookup eventually applies a confirmed rename back', async () => {
  const fixture = makeFixture('Initial title', { codexSummaryFailures: 1 })
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )
    fixture.codex.setAuthoritativeName('Title A')

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title A',
      },
    })

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.get(fixture.session.codexThreadId),
      'Title A',
    )
    assert.equal(fixture.channel.name, 'Title B')

    await fixture.internal.retryPendingSessionTitle(fixture.session)

    assert.equal(
      fixture.internal.pendingCodexTitleVerifications.has(fixture.session.codexThreadId),
      false,
    )
    assert.equal(fixture.channel.name, 'Title A')
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B', 'Title A'])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('a legitimate Codex rename back to a recent title remains authoritative', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )
    fixture.codex.setAuthoritativeName('Title A')

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Title A',
      },
    })

    assert.equal(fixture.channel.name, 'Title A')
    assert.deepEqual(fixture.channel.nameCalls, ['Title A', 'Title B', 'Title A'])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('a legitimate Discord rename back to a recent title remains authoritative', async () => {
  const fixture = makeFixture()
  try {
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title A', []),
    )
    await fixture.internal.handleRenameCommand(
      makeRenameInteraction(fixture.channel, 'Title B', []),
    )
    fixture.channel.name = 'Title A'

    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Title B' },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names.map((entry) => entry.name), [
      'Title A',
      'Title B',
      'Title A',
    ])
    assert.equal(fixture.channel.name, 'Title A')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('authoritative Discord titles retire stale pending Discord writes', async () => {
  const fixture = makeFixture()
  try {
    fixture.internal.pendingDiscordTitles.set(fixture.channel.id, 'Obsolete title')
    fixture.channel.name = 'Authoritative Discord title'
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Initial title' },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.equal(fixture.internal.pendingDiscordTitles.has(fixture.channel.id), false)
    assert.equal(fixture.channel.name, 'Authoritative Discord title')
    await fixture.internal.retryPendingSessionTitle(fixture.session)
    assert.equal(fixture.codex.names.at(-1)?.name, 'Authoritative Discord title')
    assert.equal(fixture.channel.name, 'Authoritative Discord title')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('authoritative Codex titles retire stale pending Codex writes', async () => {
  const fixture = makeFixture()
  try {
    fixture.internal.pendingCodexTitles.set(fixture.session.codexThreadId, 'Obsolete title')
    fixture.codex.setAuthoritativeName('Authoritative Codex title')
    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Authoritative Codex title',
      },
    })

    assert.equal(fixture.internal.pendingCodexTitles.has(fixture.session.codexThreadId), false)
    assert.equal(fixture.channel.name, 'Authoritative Codex title')
    await fixture.internal.retryPendingSessionTitle(fixture.session)
    assert.equal(fixture.channel.name, 'Authoritative Codex title')
  } finally {
    fixture.bot.client.destroy()
  }
})

test('archive-only Discord ThreadUpdate performs no title RPC', async () => {
  const fixture = makeFixture('Stable title')
  const oldThread = {
    id: fixture.channel.id,
    name: fixture.channel.name,
    archived: false,
  }
  fixture.channel.archived = true
  try {
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      oldThread,
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names, [])
    assert.deepEqual(fixture.channel.nameCalls, [])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('late Codex and Discord title events after mapping removal are no-ops', async () => {
  const fixture = makeFixture()
  const oldThread = { id: fixture.channel.id, name: fixture.channel.name }
  delete fixture.state.sessions[fixture.channel.id]
  fixture.channel.name = 'Late Discord title'
  try {
    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: 'Late Codex title',
      },
    })
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      oldThread,
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.deepEqual(fixture.codex.names, [])
    assert.deepEqual(fixture.channel.nameCalls, [])
    assert.equal(fixture.fetchCount(), 0)
  } finally {
    fixture.bot.client.destroy()
  }
})

test('long remote titles converge once at the shared 80-character limit', async () => {
  const fixture = makeFixture()
  const rawTitle = `⬦ ${'Long title '.repeat(12)}`
  const expected = normalizeThreadTitle(rawTitle)
  try {
    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: rawTitle,
      },
    })
    assert.equal(expected.length, threadTitleMaxLength)
    assert.equal(fixture.channel.name, expected)
    assert.deepEqual(fixture.codex.names, [{
      threadId: fixture.session.codexThreadId,
      name: expected,
    }])
    assert.deepEqual(fixture.channel.nameCalls, [expected])

    await fixture.internal.handleNotification({
      method: 'thread/name/updated',
      params: {
        threadId: fixture.session.codexThreadId,
        threadName: expected,
      },
    })
    ;(fixture.bot.client as unknown as EventEmitter).emit(
      'threadUpdate',
      { id: fixture.channel.id, name: 'Initial title' },
      fixture.channel,
    )
    await flushThreadUpdate(fixture.internal, fixture.channel.id)

    assert.equal(fixture.codex.names.length, 1)
    assert.equal(fixture.channel.nameCalls.length, 1)
  } finally {
    fixture.bot.client.destroy()
  }
})
