import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState } from '../src/types.js'

const execFileAsync = promisify(execFile)

type InternalBot = {
  handleDiffCommand(interaction: ChatInputCommandInteraction): Promise<void>
}

class DiffCodex extends EventEmitter {}

function config(directory: string): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'project-1': { directory } },
  }
}

function state(): CordexState {
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

function interaction(replies: unknown[]): ChatInputCommandInteraction {
  return {
    channel: { id: 'project-1', isThread: () => false },
    async deferReply() {},
    async editReply(payload: unknown) {
      replies.push(payload)
      return payload
    },
  } as unknown as ChatInputCommandInteraction
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function withBot(
  directory: string,
  run: (bot: CordexDiscordBot, internal: InternalBot) => Promise<void>,
): Promise<void> {
  const bot = new CordexDiscordBot(
    config(directory),
    state(),
    new DiffCodex() as unknown as CodexAppServer,
  )
  try {
    await run(bot, bot as unknown as InternalBot)
  } finally {
    bot.client.destroy()
  }
}

test('/diff attaches the complete patch when it does not fit in a Discord message', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-discord-diff-'))
  try {
    await git(directory, ['init', '-b', 'main'])
    await git(directory, ['config', 'user.email', 'cordex@test.invalid'])
    await git(directory, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(directory, 'notes.txt'), 'base\n')
    await git(directory, ['add', '.'])
    await git(directory, ['commit', '-m', 'base'])
    const changed = `${'complete-diff-line\n'.repeat(500)}`
    await writeFile(path.join(directory, 'notes.txt'), changed)
    const replies: unknown[] = []

    await withBot(directory, async (_bot, internal) => {
      await internal.handleDiffCommand(interaction(replies))
    })

    assert.equal(replies.length, 1)
    const reply = replies[0] as {
      content: string
      files: Array<{ attachment: Buffer; name: string }>
    }
    assert.match(reply.content, /Complete git diff attached/)
    assert.equal(reply.files.length, 1)
    assert.equal(reply.files[0]?.name, 'cordex.diff')
    const patch = reply.files[0]?.attachment.toString('utf8') || ''
    const expected = await execFileAsync(
      'git',
      ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'],
      { cwd: directory },
    )
    assert.equal(patch, expected.stdout)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('/diff reports an empty tree and git failures without attachments', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'cordex-discord-diff-empty-'))
  const notRepository = await mkdtemp(path.join(tmpdir(), 'cordex-discord-diff-error-'))
  try {
    await git(repository, ['init', '-b', 'main'])
    await git(repository, ['config', 'user.email', 'cordex@test.invalid'])
    await git(repository, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(repository, 'notes.txt'), 'base\n')
    await git(repository, ['add', '.'])
    await git(repository, ['commit', '-m', 'base'])

    const emptyReplies: unknown[] = []
    await withBot(repository, async (_bot, internal) => {
      await internal.handleDiffCommand(interaction(emptyReplies))
    })
    assert.deepEqual(emptyReplies, ['No uncommitted changes.'])

    const errorReplies: unknown[] = []
    await withBot(notRepository, async (_bot, internal) => {
      await internal.handleDiffCommand(interaction(errorReplies))
    })
    assert.match(String(errorReplies[0]), /not a git repository/i)
  } finally {
    await rm(repository, { recursive: true, force: true })
    await rm(notRepository, { recursive: true, force: true })
  }
})
