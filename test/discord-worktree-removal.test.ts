import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { emptyState } from '../src/config.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, SessionState } from '../src/types.js'
import {
  createWorktree,
  mergeWorktree,
  removeMergedWorktree,
  runGit,
  type CreatedWorktree,
} from '../src/worktrees.js'

class WorktreeCodex extends EventEmitter {
  readonly resumes: Record<string, unknown>[] = []

  async getThreadGoal() {
    return undefined
  }

  async resumeThread(options: Record<string, unknown>) {
    this.resumes.push(options)
    return { threadId: String(options.threadId), model: 'gpt-test' }
  }
}

type InternalBot = {
  loadedThreads: Set<string>
  pendingSessionDirectoryReservations: Map<string, number>
  handleMergeWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  handleDeleteWorktreeCommand(interaction: ChatInputCommandInteraction): Promise<void>
  reconcileWorktreeRemovalIntents(): Promise<void>
  synchronizeThreadTitle(
    session: SessionState,
    channel: ThreadChannel,
    title: string,
  ): Promise<void>
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args)
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
}

async function unmergedWorktreeFixture(): Promise<{
  root: string
  dataRoot: string
  created: CreatedWorktree
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-project-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-data-'))
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.email', 'cordex@test.invalid'])
  await git(root, ['config', 'user.name', 'Cordex Test'])
  await writeFile(path.join(root, 'README.md'), 'base\n')
  await git(root, ['add', 'README.md'])
  await git(root, ['commit', '-m', 'base'])
  const created = await createWorktree({
    projectDirectory: root,
    dataRoot,
    name: 'delete merged',
  })
  await writeFile(path.join(created.directory, 'README.md'), 'base\nfeature\n')
  await git(created.directory, ['add', 'README.md'])
  await git(created.directory, ['commit', '-m', 'feature'])
  return { root, dataRoot, created }
}

async function mergedWorktreeFixture(): Promise<{
  root: string
  dataRoot: string
  created: CreatedWorktree
}> {
  const fixture = await unmergedWorktreeFixture()
  const merged = await mergeWorktree({
    projectDirectory: fixture.root,
    worktreeDirectory: fixture.created.directory,
    branch: fixture.created.branch,
  })
  assert.equal(merged.status, 'merged')
  return fixture
}

function config(projectDirectory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    defaultModel: 'gpt-test',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: projectDirectory } },
  }
}

function session(created: CreatedWorktree, merged = true): SessionState {
  return {
    discordThreadId: 'thread-1',
    parentChannelId: 'parent-1',
    directory: created.directory,
    codexThreadId: 'codex-thread-1',
    model: 'gpt-test',
    worktree: { ...created, ...(merged ? { merged: true } : {}) },
    updatedAt: '2026-07-19T00:00:00.000Z',
  }
}

function interaction(current: SessionState, replies: string[]): ChatInputCommandInteraction {
  const channel = {
    id: current.discordThreadId,
    parentId: current.parentChannelId,
    name: '⬦ Delete merged',
    isThread: () => true,
  } as unknown as ThreadChannel
  return {
    id: 'interaction-1',
    channel,
    channelId: channel.id,
    user: { id: 'user-1', displayName: 'User' },
    options: { getString: () => null },
    async deferReply() {},
    async editReply(value: string) {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
}

test('/merge-worktree recovers when Git succeeded but the merged marker was not saved', async () => {
  const fixture = await unmergedWorktreeFixture()
  const failureRoot = await mkdtemp(path.join(tmpdir(), 'cordex-discord-merge-failure-'))
  const homeFile = path.join(failureRoot, 'home-as-file')
  await writeFile(homeFile, 'not a directory')
  const recoveryHome = await mkdtemp(path.join(tmpdir(), 'cordex-discord-merge-recovery-'))
  const previousHome = process.env.CORDEX_HOME
  let crashingBot: CordexDiscordBot | undefined
  let recoveryBot: CordexDiscordBot | undefined
  try {
    process.env.CORDEX_HOME = homeFile
    const beforeCrash = session(fixture.created, false)
    const beforeCrashState = emptyState()
    beforeCrashState.sessions[beforeCrash.discordThreadId] = beforeCrash
    crashingBot = new CordexDiscordBot(
      config(fixture.root),
      beforeCrashState,
      new WorktreeCodex() as unknown as CodexAppServer,
    )
    await assert.rejects(
      (crashingBot as unknown as InternalBot).handleMergeWorktreeCommand(
        interaction(beforeCrash, []),
      ),
    )
    assert.equal(beforeCrash.worktree?.merged, undefined)
    assert.equal((await runGit(
      fixture.root,
      ['show-ref', '--verify', '--quiet', `refs/heads/${fixture.created.branch}`],
    )).exitCode, 1)
    assert.equal((await runGit(
      fixture.created.directory,
      ['branch', '--show-current'],
    )).stdout, '')
    crashingBot.client.destroy()
    crashingBot = undefined

    process.env.CORDEX_HOME = recoveryHome
    const recovered = session(fixture.created, false)
    const recoveredState = emptyState()
    recoveredState.sessions[recovered.discordThreadId] = recovered
    recoveryBot = new CordexDiscordBot(
      config(fixture.root),
      recoveredState,
      new WorktreeCodex() as unknown as CodexAppServer,
    )
    const recoveryInternal = recoveryBot as unknown as InternalBot
    recoveryInternal.synchronizeThreadTitle = async () => undefined
    const replies: string[] = []
    await recoveryInternal.handleMergeWorktreeCommand(interaction(recovered, replies))
    assert.equal(recovered.worktree?.merged, true)
    assert.match(replies[0] || '', /Recovered completed merge/)
  } finally {
    crashingBot?.client.destroy()
    recoveryBot?.client.destroy()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(failureRoot, { recursive: true, force: true })
    await rm(recoveryHome, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.dataRoot, { recursive: true, force: true })
  }
})

test('/delete-worktree persists removal, deletes exactly the checkout, and reloads at project root', async () => {
  const fixture = await mergedWorktreeFixture()
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-home-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const current = session(fixture.created)
  const state = emptyState()
  state.sessions[current.discordThreadId] = current
  const codex = new WorktreeCodex()
  const bot = new CordexDiscordBot(
    config(fixture.root),
    state,
    codex as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.loadedThreads.add(current.codexThreadId)
  let synchronizedTitle = ''
  internal.synchronizeThreadTitle = async (_session, _channel, title) => {
    synchronizedTitle = title
  }
  const replies: string[] = []
  try {
    await internal.handleDeleteWorktreeCommand(interaction(current, replies))
    await assert.rejects(access(fixture.created.directory))
    assert.equal(current.directory, fixture.root)
    assert.equal(current.worktree, undefined)
    assert.equal(current.lifecycleIntent, undefined)
    assert.equal(codex.resumes.length, 1)
    assert.equal(codex.resumes[0]?.cwd, fixture.root)
    assert.equal(synchronizedTitle, 'Delete merged')
    assert.match(replies[0] || '', /Deleted merged worktree/)
  } finally {
    bot.client.destroy()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.dataRoot, { recursive: true, force: true })
  }
})

test('/delete-worktree accepts a proven merged checkout when the persisted marker is stale', async () => {
  const fixture = await mergedWorktreeFixture()
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-stale-marker-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const current = session(fixture.created, false)
  const state = emptyState()
  state.sessions[current.discordThreadId] = current
  const bot = new CordexDiscordBot(
    config(fixture.root),
    state,
    new WorktreeCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.synchronizeThreadTitle = async () => undefined
  const replies: string[] = []
  try {
    await internal.handleDeleteWorktreeCommand(interaction(current, replies))
    await assert.rejects(access(fixture.created.directory))
    assert.equal(current.directory, fixture.root)
    assert.equal(current.worktree, undefined)
    assert.match(replies[0] || '', /Deleted merged worktree/)
  } finally {
    bot.client.destroy()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.dataRoot, { recursive: true, force: true })
  }
})

test('/delete-worktree does not touch Git until its removal intent is durable', async () => {
  const fixture = await mergedWorktreeFixture()
  const failureRoot = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-failure-'))
  const homeFile = path.join(failureRoot, 'home-as-file')
  await writeFile(homeFile, 'not a directory')
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = homeFile
  const current = session(fixture.created)
  const state = emptyState()
  state.sessions[current.discordThreadId] = current
  const bot = new CordexDiscordBot(
    config(fixture.root),
    state,
    new WorktreeCodex() as unknown as CodexAppServer,
  )
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleDeleteWorktreeCommand(interaction(current, [])),
    )
    await access(fixture.created.directory)
    assert.equal(current.lifecycleIntent, undefined)
    assert.ok(current.worktree)
  } finally {
    bot.client.destroy()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(failureRoot, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.dataRoot, { recursive: true, force: true })
  }
})

test('startup reconciles a worktree removed after intent persistence but before state finalization', async () => {
  const fixture = await mergedWorktreeFixture()
  await removeMergedWorktree({
    projectDirectory: fixture.root,
    worktreeDirectory: fixture.created.directory,
    branch: fixture.created.branch,
  })
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-discord-remove-recovery-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const current = session(fixture.created)
  current.lifecycleIntent = {
    kind: 'remove-worktree',
    requestedAt: '2026-07-19T01:02:03.004Z',
  }
  const state = emptyState()
  state.sessions[current.discordThreadId] = current
  const bot = new CordexDiscordBot(
    config(fixture.root),
    state,
    new WorktreeCodex() as unknown as CodexAppServer,
  )
  try {
    await (bot as unknown as InternalBot).reconcileWorktreeRemovalIntents()
    assert.equal(current.directory, fixture.root)
    assert.equal(current.worktree, undefined)
    assert.equal(current.lifecycleIntent, undefined)
  } finally {
    bot.client.destroy()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.dataRoot, { recursive: true, force: true })
  }
})

test('/delete-worktree rejects archived and in-flight sessions that still reference the checkout', async () => {
  const current: SessionState = {
    discordThreadId: 'thread-1',
    parentChannelId: 'parent-1',
    directory: '/tmp/cordex-shared-remove',
    codexThreadId: 'codex-thread-1',
    worktree: {
      projectDirectory: '/tmp/cordex-project',
      directory: '/tmp/cordex-shared-remove',
      branch: 'codex/cordex-shared',
      merged: true,
    },
    updatedAt: new Date(0).toISOString(),
  }
  const state = emptyState()
  state.sessions[current.discordThreadId] = current
  state.sessions['thread-2'] = {
    discordThreadId: 'thread-2',
    parentChannelId: 'parent-1',
    directory: current.directory,
    codexThreadId: 'codex-thread-2',
    archived: true,
    updatedAt: new Date(0).toISOString(),
  }
  const bot = new CordexDiscordBot(
    config('/tmp/cordex-project'),
    state,
    new WorktreeCodex() as unknown as CodexAppServer,
  )
  try {
    await assert.rejects(
      (bot as unknown as InternalBot).handleDeleteWorktreeCommand(interaction(current, [])),
      /still referenced by <#thread-2>/,
    )
    delete state.sessions['thread-2']
    ;(bot as unknown as InternalBot).pendingSessionDirectoryReservations.set(
      path.resolve(current.directory),
      1,
    )
    await assert.rejects(
      (bot as unknown as InternalBot).handleDeleteWorktreeCommand(interaction(current, [])),
      /being inherited by a new session/,
    )
  } finally {
    bot.client.destroy()
  }
})
