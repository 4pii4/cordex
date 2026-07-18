import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, SessionState } from '../src/types.js'

const execFileAsync = promisify(execFile)

type InternalBot = {
  handleWorktreesCommand(interaction: ChatInputCommandInteraction): Promise<void>
}

class InventoryCodex extends EventEmitter {}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

function makeInteraction(replies: string[]): ChatInputCommandInteraction {
  const interaction = {
    deferred: false,
    replied: false,
    async deferReply() {
      interaction.deferred = true
    },
    async editReply(content: string) {
      interaction.replied = true
      replies.push(content)
      return content
    },
    async followUp(payload: string | { content: string }) {
      replies.push(typeof payload === 'string' ? payload : payload.content)
      return payload
    },
  }
  return interaction as unknown as ChatInputCommandInteraction
}

test('/worktrees includes main, managed, and unlinked Git registrations', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-inventory-ui-'))
  const project = path.join(sandbox, 'project')
  const managedDirectory = path.join(sandbox, 'managed')
  const manualDirectory = path.join(sandbox, 'manual')
  try {
    await mkdir(project)
    await git(project, ['init', '-b', 'main'])
    await git(project, ['config', 'user.email', 'cordex@test.invalid'])
    await git(project, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(project, 'README.md'), 'base\n')
    await git(project, ['add', 'README.md'])
    await git(project, ['commit', '-m', 'base'])
    await git(project, ['worktree', 'add', '-b', 'managed', managedDirectory])
    await git(project, ['worktree', 'add', '-b', 'manual', manualDirectory])
    await writeFile(path.join(manualDirectory, 'README.md'), 'dirty\n')

    const session: SessionState = {
      discordThreadId: '123456789012345678',
      parentChannelId: '223456789012345678',
      directory: managedDirectory,
      codexThreadId: 'codex-managed',
      worktree: {
        projectDirectory: project,
        directory: managedDirectory,
        branch: 'managed',
      },
      updatedAt: new Date().toISOString(),
    }
    const config: CordexConfig = {
      token: 'fixture-token',
      applicationId: 'application-1',
      guildId: 'guild-1',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      allowAllUsers: true,
      allowShellCommands: false,
      projects: {
        [session.parentChannelId]: { name: 'Inventory Project', directory: project },
      },
    }
    const state: CordexState = {
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
    const bot = new CordexDiscordBot(
      config,
      state,
      new InventoryCodex() as unknown as CodexAppServer,
    )
    const replies: string[] = []
    try {
      await (bot as unknown as InternalBot).handleWorktreesCommand(makeInteraction(replies))
    } finally {
      bot.client.destroy()
    }
    const output = replies.join('\n')
    assert.match(output, /main checkout/)
    assert.match(output, /<#123456789012345678>/)
    assert.match(output, /unlinked worktree/)
    assert.match(output, /dirty/)
    assert.match(output, new RegExp(manualDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})
