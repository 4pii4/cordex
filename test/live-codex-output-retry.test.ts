import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState, loadState, saveState } from '../src/config.js'
import type { CordexConfig, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for recovered Discord output')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('real Codex output reaches Discord once after a transient send timeout', {
  skip: !process.env.CORDEX_OUTPUT_RETRY_TEST,
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-output-retry-home-'))
  const primaryHome = await mkdtemp(path.join(tmpdir(), 'cordex-output-retry-primary-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-output-retry-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = primaryHome
  const sentinel = emptyState()
  sentinel.channelModels['sentinel-project'] = 'sentinel-model'
  await saveState(sentinel)
  process.env.CORDEX_HOME = home
  await writeFile(path.join(workspace, 'fixture.json'), JSON.stringify({
    credit: 4,
    rows: [
      { id: 'a', amount: 17, due: '2026-09-20', done: false },
      { id: 'b', amount: 23, due: '2026-09-28', done: false },
      { id: 'c', amount: 25, due: '2026-09-27', done: false },
      { id: 'd', amount: 19, due: '2026-09-25', done: true },
      { id: 'e', amount: 4, due: '2026-09-25', done: false },
      { id: 'f', amount: 11, due: '2026-09-30', done: false },
      { id: 'g', amount: 8, due: '2026-09-27', done: true },
    ],
  }))

  const codex = new CodexAppServer()
  const discordThreadId = 'discord-output-retry-e2e'
  const parentChannelId = 'project-output-retry-e2e'
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
  let archived = false
  let sendAttempts = 0
  let channelArchived = false
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    name: 'Output retry E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(archived: boolean) {
      channelArchived = archived
      return channel
    },
    async send(payload: string | { content?: string }) {
      sendAttempts++
      if (sendAttempts === 1) throw new Error('Simulated Discord connect timeout')
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
        text: 'Read fixture.json. Sum amount where done is false and due is on or before 2026-09-27, subtract credit, and reply exactly: retry-e2e-<result>. Do not edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() =>
      sendAttempts >= 2 &&
      delivered.some((content) => content.includes('retry-e2e-42')) &&
      (state.discordOutbox?.length || 0) === 0 &&
      session.activeTurnId === undefined,
    )
    assert.equal(delivered.filter((content) => content.includes('retry-e2e-42')).length, 1)
    await codex.archiveThread(codexThreadId)
    archived = true
    await bot.stop()
    process.env.CORDEX_HOME = primaryHome
    state.channelModels['late-bound-write'] = 'test-home-only'
    await saveState(state)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const preserved = await loadState()
    assert.equal(preserved.channelModels['sentinel-project'], 'sentinel-model')
    assert.equal(Object.keys(preserved.sessions).length, 0)
    process.env.CORDEX_HOME = home
    const isolated = await loadState()
    assert.equal(isolated.channelModels['late-bound-write'], 'test-home-only')
    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-output-retry-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex turn with one simulated Discord send timeout',
      command: 'npm run test:live-output-retry',
      sendAttempts,
      delivered,
      pendingOutbox: state.discordOutbox?.length || 0,
      primaryStatePreserved: true,
      lateBoundWriteStayedInTestHome: true,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    process.env.CORDEX_HOME = home
    if (codexThreadId && !archived) await codex.archiveThread(codexThreadId).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(primaryHome, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
