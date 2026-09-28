import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState, saveConfig } from '../src/config.js'
import type { CordexConfig, UserInput } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function isStartupNotice(content: string): boolean {
  return content.startsWith('Codex is still starting this Codex ') ||
    content.startsWith('Codex is still preparing this Codex turn') ||
    content.startsWith('Codex is still recovering the Codex runtime')
}

test('new and existing real Codex turns report slow startup without stale notices', {
  skip: !process.env.CORDEX_STARTUP_PROGRESS_TEST,
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-startup-progress-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-startup-progress-project-'))
  const previousHome = process.env.CORDEX_HOME
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
  const catalog = await codex.listModels()
  const preferred = catalog.find((model) => model.model === 'gpt-6-luna' && !model.hidden)
  const discordThreadId = '1554030000000000000'
  const parentChannelId = '1554030000000000001'
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    ...(preferred ? { defaultModel: preferred.model } : {}),
    defaultEffort: 'low',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  await saveConfig(config)
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  let archived = false
  let channelArchived = false
  let typingCalls = 0
  let failFirstStartup = true
  const startupAttempts: Array<{ content: string; nonce: string }> = []
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    guildId: config.guildId,
    parentId: parentChannelId,
    name: 'Startup progress E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() { typingCalls++ },
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string; nonce?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      const nonce = typeof payload === 'string' ? '' : payload.nonce || ''
      if (isStartupNotice(content)) {
        startupAttempts.push({ content, nonce })
        if (failFirstStartup) {
          failFirstStartup = false
          throw new Error('Simulated Discord startup notice outage')
        }
      }
      delivered.push(content)
      return { id: `message-${delivered.length}`, content, async edit(next: string | { content: string }) {
        this.content = typeof next === 'string' ? next : next.content
        return this
      } }
    },
  } as unknown as ThreadChannel

  try {
    bot = new CordexDiscordBot(config, state, codex)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
    const internal = bot as unknown as {
      dispatchInput(channel: ThreadChannel, parentId: string, input: UserInput[], id: string): Promise<void>
      enqueueDaemonPrompt(options: {
        threadId: string
        requestId: string
        input: UserInput[]
        displayText: string
      }): Promise<{ threadId: string; position: number }>
      pendingStartupProgress: Map<string, unknown>
    }
    const originalStartThread = codex.startThread.bind(codex)
    let releaseNewStart!: () => void
    const newStartGate = new Promise<void>((resolve) => { releaseNewStart = resolve })
    codex.startThread = async (options) => {
      await newStartGate
      return originalStartThread(options)
    }
    const firstInput: UserInput[] = [{
      type: 'text',
      text: 'Read fixture.json. Sum amounts where done is false and due is on or before 2026-09-27, subtract credit, and reply exactly startup-first-42. Do not edit files.',
      text_elements: [],
    }]
    const firstDispatch = internal.dispatchInput(channel, parentChannelId, firstInput, 'startup-first-client-id')
      .then(() => undefined, (error: unknown) => error)
    await waitFor(() => startupAttempts.length >= 2 &&
      delivered.some((content) => content.includes('starting this Codex session')),
    'retried new-session startup notice', 30_000)
    assert.ok(typingCalls >= 2)
    assert.equal(startupAttempts[0]?.nonce, startupAttempts[1]?.nonce)
    assert.equal(Object.keys(state.sessions).length, 0)
    releaseNewStart()
    const dispatchError = await firstDispatch
    if (dispatchError) throw dispatchError
    await waitFor(() => {
      const session = state.sessions[discordThreadId]
      return Boolean(session && session.activeTurnId === undefined &&
        delivered.some((content) => content.includes('startup-first-42')))
    }, 'first real Codex turn')
    codexThreadId = state.sessions[discordThreadId]!.codexThreadId
    assert.equal(internal.pendingStartupProgress.size, 0)
    const firstNoticeCount = delivered.filter((content) => content.includes('starting this Codex session')).length
    assert.equal(firstNoticeCount, 1)

    const originalRuntimeRead = codex.getThreadRuntimeState.bind(codex)
    let releaseExistingRead!: () => void
    const existingReadGate = new Promise<void>((resolve) => { releaseExistingRead = resolve })
    let delayedReadEntered = false
    codex.getThreadRuntimeState = async (threadId) => {
      if (!delayedReadEntered) {
        delayedReadEntered = true
        await existingReadGate
      }
      return originalRuntimeRead(threadId)
    }
    const secondInput: UserInput[] = [{
      type: 'text',
      text: 'Read fixture.json. Count unfinished rows due after 2026-09-27 and reply exactly startup-second-2. Do not edit files.',
      text_elements: [],
    }]
    await internal.enqueueDaemonPrompt({
      threadId: discordThreadId,
      requestId: 'startup-second-client-id',
      input: secondInput,
      displayText: 'Second real prompt after slow reconciliation',
    })
    await waitFor(() => delayedReadEntered, 'existing-session reconciliation started')
    await waitFor(() => delivered.some((content) => content.includes('preparing this Codex turn')),
      'existing-session startup notice', 20_000)
    releaseExistingRead()
    await waitFor(() => {
      const session = state.sessions[discordThreadId]
      return Boolean(session && session.activeTurnId === undefined &&
        delivered.some((content) => content.includes('startup-second-2')) &&
        (state.queues[discordThreadId]?.length || 0) === 0)
    }, 'second real Codex turn')
    assert.equal(internal.pendingStartupProgress.size, 0)
    const startupCount = delivered.filter(isStartupNotice).length
    await new Promise((resolve) => setTimeout(resolve, 7_000))
    assert.equal(delivered.filter(isStartupNotice).length, startupCount)
    assert.equal(startupCount, 2)
    assert.equal(state.discordOutbox?.length || 0, 0)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-startup-progress-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'delayed real Codex new-session and existing-session starts with a failed startup notice send',
      command: 'npm run test:live-startup-progress',
      codexThreadId,
      typingCalls,
      startupAttempts,
      delivered,
      startupCount,
      pendingStartupProgress: internal.pendingStartupProgress.size,
      pendingOutbox: state.discordOutbox?.length || 0,
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
    await rm(workspace, { recursive: true, force: true })
  }
})
