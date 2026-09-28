import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('a completed Codex turn warns once about a surviving command and can stop it', {
  skip: !process.env.CORDEX_BACKGROUND_NOTICE_TEST,
  timeout: 130_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-background-notice-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-background-notice-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  await writeFile(path.join(workspace, 'slow-abort.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nsleep 180\n')
  await writeFile(path.join(workspace, 'README.md'), '# Background terminal fixture\n')

  const codex = new CodexAppServer()
  const discordThreadId = 'discord-background-notice-e2e'
  const parentChannelId = 'project-background-notice-e2e'
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  let channelArchived = false
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    name: 'Background notice E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(archived: boolean) {
      channelArchived = archived
      return channel
    },
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push(content)
      return { id: `message-${delivered.length}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel

  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
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

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Start bash slow-abort.sh with a one-second initial yield. Do not wait for or poll the 180-second command; leave its terminal running. Immediately reply exactly background-e2e-started. Do not edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() =>
      session.activeTurnId === undefined &&
      delivered.some((content) => content.includes('background-e2e-started')) &&
      delivered.some((content) => content.includes('background terminal still running after this turn')),
    'answer and background-terminal warning')
    const running = await codex.listBackgroundTerminals(codexThreadId)
    assert.equal(running.length, 1)
    assert.match(running[0]?.command || '', /slow-abort\.sh/)

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Read README.md and reply exactly background-e2e-followup. Do not touch the background command or edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() =>
      session.activeTurnId === undefined &&
      delivered.some((content) => content.includes('background-e2e-followup')),
    'follow-up turn')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(delivered.filter((content) => content.includes('background terminal still running after this turn')).length, 1)

    assert.equal(await codex.terminateBackgroundTerminal(codexThreadId, running[0]!.processId), true)
    let remaining = await codex.listBackgroundTerminals(codexThreadId)
    for (let attempt = 0; remaining.length > 0 && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      remaining = await codex.listBackgroundTerminals(codexThreadId)
    }
    assert.equal(remaining.length, 0)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-background-notice-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex turn leaves a command running, a second turn does not repeat the warning, then the terminal is stopped',
      command: 'npm run test:live-background-notice',
      processId: running[0]?.processId,
      delivered,
      remainingTerminals: remaining.length,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (codexThreadId) {
      await codex.cleanBackgroundTerminals(codexThreadId).catch(() => undefined)
      await codex.archiveThread(codexThreadId).catch(() => undefined)
    }
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
