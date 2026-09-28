import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Events, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('silent real Codex work reports activity and reconnect delivers only useful output', {
  skip: !process.env.CORDEX_SILENT_PROGRESS_TEST,
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-silent-progress-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-silent-progress-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  await writeFile(path.join(workspace, 'slow-step.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nsleep 75\nprintf "silent-step-done\\n"\n')

  const codex = new CodexAppServer()
  const discordThreadId = 'discord-silent-progress-e2e'
  const parentChannelId = 'project-silent-progress-e2e'
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
  let networkDown = true
  let sendAttempts = 0
  let channelArchived = false
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    name: 'Silent progress E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(archived: boolean) {
      channelArchived = archived
      return channel
    },
    async send(payload: string | { content?: string }) {
      sendAttempts++
      if (networkDown) throw new Error('Simulated Discord network outage')
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push(content)
      return { id: `message-${sendAttempts}`, content, async edit() { return this } }
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
        text: 'Run bash slow-step.sh and wait for its stdout. Do not send commentary before it finishes. Then reply exactly progress-recovery-done. Do not edit files.',
        text_elements: [],
      }],
    })

    await waitFor(() => (state.discordOutbox || []).some((entry) => entry.itemKey === 'progress:1'), 'first progress')
    const firstProgress = (state.discordOutbox || []).find((entry) => entry.itemKey === 'progress:1')?.content
    assert.match(firstProgress || '', /Codex is still working/)
    await waitFor(() => (state.discordOutbox || []).some((entry) => entry.itemKey === 'progress:2'), 'second progress')
    const pendingProgress = (state.discordOutbox || []).filter((entry) => entry.itemKey.startsWith('progress:'))
    assert.equal(pendingProgress.length, 1)
    assert.match(pendingProgress[0]?.content || '', /running a command/)
    await waitFor(() =>
      session.activeTurnId === undefined &&
      (state.discordOutbox || []).some((entry) => entry.content.includes('progress-recovery-done')),
    'completed Codex turn and queued final answer')
    const pendingBeforeRecovery = (state.discordOutbox || []).map((entry) => ({
      itemKey: entry.itemKey,
      content: entry.content,
    }))
    assert.equal(pendingBeforeRecovery.filter((entry) => entry.itemKey.startsWith('progress:')).length, 0)

    networkDown = false
    bot.client.emit(Events.ShardResume, 0, 0)
    await waitFor(() =>
      delivered.some((content) => content.includes('progress-recovery-done')) &&
      (state.discordOutbox?.length || 0) === 0,
    'Discord reconnect delivery', 30_000)
    assert.equal(delivered.filter((content) => content.includes('progress-recovery-done')).length, 1)
    assert.equal(delivered.filter((content) => content.includes('Codex is still working')).length, 0)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-silent-progress-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real 75-second Codex command during simulated Discord outage',
      command: 'npm run test:live-progress',
      firstProgress,
      latestProgress: pendingProgress[0]?.content,
      pendingBeforeRecovery,
      sendAttempts,
      delivered,
      pendingOutbox: state.discordOutbox?.length || 0,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (codexThreadId) await codex.archiveThread(codexThreadId).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
