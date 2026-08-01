import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { AutocompleteInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, SessionState } from '../src/types.js'

const execFileAsync = promisify(execFile)

type BranchChoice = { name: string; value: string }

type InternalBot = {
  handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>
  memberAllowed(userId: string): Promise<boolean>
  refreshProjectsSafely(): Promise<void>
}

class AutocompleteCodex extends EventEmitter {}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

function makeSession(options: {
  id: string
  directory: string
  projectDirectory?: string
}): SessionState {
  return {
    discordThreadId: options.id,
    parentChannelId: 'parent-1',
    directory: options.directory,
    codexThreadId: `codex-${options.id}`,
    model: 'gpt-test',
    ...(options.projectDirectory
      ? {
          worktree: {
            projectDirectory: options.projectDirectory,
            directory: options.directory,
            branch: 'codex/cordex-test',
          },
        }
      : {}),
    updatedAt: new Date(0).toISOString(),
  }
}

function makeChannel(session: SessionState): ThreadChannel {
  return {
    id: session.discordThreadId,
    parentId: session.parentChannelId,
    guildId: 'guild-1',
    isThread: () => true,
  } as unknown as ThreadChannel
}

function makeInteraction(options: {
  commandName: 'new-worktree' | 'merge-worktree'
  optionName: 'base-branch' | 'target-branch'
  channel: ThreadChannel
  query: string
  responses: BranchChoice[][]
}): AutocompleteInteraction {
  return {
    guildId: 'guild-1',
    commandName: options.commandName,
    channel: options.channel,
    user: { id: 'user-1' },
    options: {
      getFocused: () => ({ name: options.optionName, value: options.query }),
    },
    async respond(choices: BranchChoice[]) {
      options.responses.push(choices)
    },
  } as unknown as AutocompleteInteraction
}

test('worktree branch autocomplete uses project refs within Discord choice bounds', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-autocomplete-'))
  const unrelatedDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-session-'))
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.email', 'cordex@example.invalid'])
  await git(repository, ['config', 'user.name', 'Cordex Test'])
  await writeFile(path.join(repository, 'README.md'), 'fixture\n')
  await git(repository, ['add', 'README.md'])
  await git(repository, ['commit', '-m', 'fixture'])
  await git(repository, ['branch', 'local-target'])
  await git(repository, ['branch', 'origin/main'])
  await git(repository, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  await git(repository, ['update-ref', 'refs/remotes/origin/feature/remote', 'HEAD'])
  await git(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  for (let index = 0; index < 30; index++) {
    await git(repository, ['branch', `feature/${String(index).padStart(2, '0')}`])
  }
  const oversizedRef = `feature/${'x'.repeat(100)}`
  await git(repository, ['branch', oversizedRef])

  const regularSession = makeSession({ id: 'thread-new', directory: unrelatedDirectory })
  const worktreeSession = makeSession({
    id: 'thread-merge',
    directory: unrelatedDirectory,
    projectDirectory: repository,
  })
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: repository } },
  }
  const state: CordexState = {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {
      [regularSession.discordThreadId]: regularSession,
      [worktreeSession.discordThreadId]: worktreeSession,
    },
    queues: {},
    tasks: {},
  }
  const bot = new CordexDiscordBot(
    config,
    state,
    new AutocompleteCodex() as unknown as CodexAppServer,
  )
  const internal = bot as unknown as InternalBot
  internal.memberAllowed = async () => true
  internal.refreshProjectsSafely = async () => undefined
  const responses: BranchChoice[][] = []

  try {
    await internal.handleAutocomplete(makeInteraction({
      commandName: 'new-worktree',
      optionName: 'base-branch',
      channel: makeChannel(regularSession),
      query: 'origin/',
      responses,
    }))
    assert.deepEqual(responses.shift(), [
      { name: 'origin/feature/remote', value: 'origin/feature/remote' },
      { name: 'origin/main', value: 'origin/main' },
    ])

    await internal.handleAutocomplete(makeInteraction({
      commandName: 'new-worktree',
      optionName: 'base-branch',
      channel: makeChannel(regularSession),
      query: 'feature/',
      responses,
    }))
    const capped = responses.shift() || []
    assert.equal(capped.length, 25)
    assert.equal(new Set(capped.map((choice) => choice.value)).size, capped.length)
    assert.ok(capped.every((choice) => choice.name.length <= 100 && choice.value.length <= 100))
    assert.equal(capped.some((choice) => choice.value === oversizedRef), false)

    await internal.handleAutocomplete(makeInteraction({
      commandName: 'new-worktree',
      optionName: 'base-branch',
      channel: makeChannel(regularSession),
      query: 'xxxxxxxx',
      responses,
    }))
    assert.deepEqual(responses.shift(), [])

    await internal.handleAutocomplete(makeInteraction({
      commandName: 'merge-worktree',
      optionName: 'target-branch',
      channel: makeChannel(worktreeSession),
      query: 'local-target',
      responses,
    }))
    assert.deepEqual(responses.shift(), [
      { name: 'local-target', value: 'local-target' },
    ])
  } finally {
    bot.client.destroy()
    await rm(repository, { recursive: true, force: true })
    await rm(unrelatedDirectory, { recursive: true, force: true })
  }
})
