import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { type ChatInputCommandInteraction, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('real Codex status separates active and next-turn settings and reports the actual policy', {
  skip: !process.env.CORDEX_STATUS_TEST,
  timeout: 200_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-status-home-'))
  const project = await mkdtemp(path.join(tmpdir(), 'cordex-status-project-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-status-worktree-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const codex = new CodexAppServer()
  const discordThreadId = 'discord-status-e2e'
  const parentChannelId = 'project-status-e2e'
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: project } },
  }
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  let archived = false
  let channelArchived = false
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    parentId: parentChannelId,
    name: 'Status E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push(content)
      return { id: `message-${delivered.length}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel

  function interaction(option?: { key: string; value: string }): {
    command: ChatInputCommandInteraction
    replies: string[]
  } {
    const replies: string[] = []
    const command = {
      channel,
      deferred: false,
      replied: false,
      options: {
        getString(name: string) { return name === option?.key ? option.value : null },
      },
      async reply(payload: string | { content: string }) {
        replies.push(typeof payload === 'string' ? payload : payload.content)
      },
      async followUp(payload: string | { content: string }) {
        replies.push(typeof payload === 'string' ? payload : payload.content)
      },
    } as unknown as ChatInputCommandInteraction
    return { command, replies }
  }

  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    codexThreadId = started.threadId
    const session: SessionState = {
      discordThreadId,
      parentChannelId,
      directory: workspace,
      codexThreadId,
      model: started.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    }
    state.sessions[discordThreadId] = session
    bot = new CordexDiscordBot(config, state, codex)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
    const internal = bot as unknown as {
      handleStatusCommand(command: ChatInputCommandInteraction): Promise<void>
      handleModelVariantCommand(command: ChatInputCommandInteraction): Promise<void>
      handleYoloCommand(command: ChatInputCommandInteraction): Promise<void>
      runs: Map<string, unknown>
    }
    const before = interaction()
    await internal.handleStatusCommand(before.command)
    assert.match(before.replies.join('\n'), /Context usage: unavailable/)
    assert.match(before.replies.join('\n'), new RegExp(`Working directory:.*${path.basename(workspace)}`))

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{ type: 'text', text: 'Run pwd and reply exactly status-baseline-ok. Do not edit files.', text_elements: [] }],
    })
    await waitFor(() => delivered.some((content) => content.includes('status-baseline-ok')) &&
      session.activeTurnId === undefined && session.contextTokens !== undefined,
    'baseline Codex turn and context usage')
    const idle = interaction()
    await internal.handleStatusCommand(idle.command)
    const idleStatus = idle.replies.join('\n')
    assert.match(idleStatus, /Approval policy: on-request/)
    assert.match(idleStatus, /Sandbox: workspace-write/)
    assert.match(idleStatus, /Context usage: .*tokens/)
    assert.match(idleStatus, new RegExp(`Project:.*${path.basename(project)}`))
    assert.match(idleStatus, new RegExp(`Working directory:.*${path.basename(workspace)}`))

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: "Run the exact shell command `rtk proxy sh -c 'sleep 25; printf status-active-ok'` and wait for its output. Do not edit files. Then reply exactly status-active-ok.",
        text_elements: [],
      }],
    })
    await waitFor(() => Boolean(session.activeTurnId && internal.runs.has(codexThreadId)), 'active Codex run')
    const variant = interaction({ key: 'effort', value: 'high' })
    await internal.handleModelVariantCommand(variant.command)
    assert.match(variant.replies.join('\n'), /high/)
    const during = interaction()
    await internal.handleStatusCommand(during.command)
    const activeStatus = during.replies.join('\n')
    assert.match(activeStatus, new RegExp(`Current turn model: ${started.model} \\(low\\)`))
    assert.match(activeStatus, new RegExp(`Next turn model: ${started.model} \\(high\\)`))
    assert.match(activeStatus, /Approval policy \(next turn\): on-request/)
    await waitFor(() => delivered.some((content) => content.includes('status-active-ok')) &&
      session.activeTurnId === undefined,
    'active turn completion')
    const after = interaction()
    await internal.handleStatusCommand(after.command)
    assert.match(after.replies.join('\n'), new RegExp(`Model: ${started.model} \\(high\\)`))

    const on = interaction({ key: 'action', value: 'on' })
    await internal.handleYoloCommand(on.command)
    const unrestricted = interaction()
    await internal.handleStatusCommand(unrestricted.command)
    const unrestrictedStatus = unrestricted.replies.join('\n')
    assert.match(unrestrictedStatus, /YOLO mode: on/)
    assert.match(unrestrictedStatus, /Sandbox: danger-full-access/)
    assert.match(unrestrictedStatus, /Approval policy: never/)
    assert.match(unrestrictedStatus, /Writable roots: unrestricted/)
    const off = interaction({ key: 'action', value: 'off' })
    await internal.handleYoloCommand(off.command)
    assert.equal(session.yoloMode, false)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-status-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex active turn with next-turn effort change and YOLO policy readback',
      command: 'npm run test:live-status',
      codexThreadId,
      project,
      workspace,
      beforeStatus: before.replies,
      idleStatus,
      activeStatus,
      afterStatus: after.replies,
      unrestrictedStatus,
      yoloRestored: session.yoloMode === false,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
    await codex.archiveThread(codexThreadId)
    archived = true
  } finally {
    if (codexThreadId && !archived) await codex.archiveThread(codexThreadId).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
