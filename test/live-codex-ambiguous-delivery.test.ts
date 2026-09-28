import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState, loadState, saveConfig, saveState } from '../src/config.js'
import type { CordexConfig, QueuedPrompt, SessionState, UserInput } from '../src/types.js'

type TurnPage = {
  data?: Array<{
    id: string
    status: string
    items?: Array<{ type?: string; clientId?: string }>
  }>
}

async function completedClientIdCount(codex: CodexAppServer, threadId: string, clientId: string): Promise<number> {
  const page = await codex.request('thread/turns/list', {
    threadId,
    cursor: null,
    limit: 20,
    sortDirection: 'desc',
    itemsView: 'full',
  }) as TurnPage
  return (page.data || []).filter((turn) =>
    turn.status === 'completed' &&
    turn.items?.some((item) => item.type === 'userMessage' && item.clientId === clientId)).length
}

async function waitForCompletedClientId(codex: CodexAppServer, threadId: string, clientId: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if (await completedClientIdCount(codex, threadId, clientId)) return
    } catch {
      // A new rollout can briefly lack its first persisted turn.
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Codex did not complete client ID ${clientId}`)
}

test('real Codex accepts direct and queued input despite lost RPC replies; Cordex holds both across restart', {
  skip: !process.env.CORDEX_AMBIGUOUS_DELIVERY_TEST,
  timeout: 240_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-ambiguous-delivery-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-ambiguous-delivery-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const codex = new CodexAppServer()
  let resumedCodex: CodexAppServer | undefined
  let bot: CordexDiscordBot | undefined
  let resumedBot: CordexDiscordBot | undefined
  const discordThreadId = 'discord-ambiguous-delivery-e2e'
  const parentChannelId = 'project-ambiguous-delivery-e2e'
  const directId = 'ambiguous-direct-accepted'
  const queuedId = 'ambiguous-queued-accepted'
  const delivered: string[] = []
  const privateReplies: string[] = []
  const injected: string[] = []
  const hiddenClientIds = new Set<string>()
  const channel = {
    id: discordThreadId,
    guildId: 'fixture-guild',
    parentId: parentChannelId,
    name: 'Ambiguous delivery E2E',
    archived: false,
    isThread: () => true,
    async sendTyping() {},
    async send(payload: string | { content?: string }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push(content)
      return {
        id: `message-${delivered.length}`,
        content,
        async edit(next: string | { content: string }) {
          this.content = typeof next === 'string' ? next : next.content
          return this
        },
      }
    },
  } as unknown as ThreadChannel
  const input = (text: string): UserInput[] => [{ type: 'text', text, text_elements: [] }]
  const prompt = (id: string, text: string, deliveryKind: 'direct' | 'queued'): QueuedPrompt => ({
    id,
    authorId: 'fixture-user',
    authorName: 'tester',
    input: input(text),
    displayText: text,
    createdAt: new Date().toISOString(),
    deliveryKind,
  })
  const attachChannel = (target: CordexDiscordBot) => {
    ;(target.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
  }
  const interaction = (values: Record<string, string | null>) => {
    let deferred = false
    let replied = false
    return {
      channel,
      channelId: discordThreadId,
      ephemeral: true,
      get deferred() { return deferred },
      get replied() { return replied },
      options: { getString(name: string) { return values[name] ?? null } },
      async deferReply() { deferred = true },
      async editReply(value: string | { content: string }) {
        privateReplies.push(typeof value === 'string' ? value : value.content)
        replied = true
      },
      async followUp(value: string | { content: string }) {
        privateReplies.push(typeof value === 'string' ? value : value.content)
      },
    } as unknown as ChatInputCommandInteraction
  }
  type RecoveryControls = {
    recoverPersistedPrompts(session: SessionState, channel: ThreadChannel): Promise<void>
    handlePendingPromptsCommand(interaction: ChatInputCommandInteraction): Promise<void>
    handleResolvePendingCommand(interaction: ChatInputCommandInteraction): Promise<void>
  }

  try {
    await writeFile(path.join(workspace, 'README.md'), '# Disposable ambiguous-delivery project\n')
    const started = await codex.startThread({ cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' })
    const codexThreadId = started.threadId
    await codex.startTurn({
      threadId: codexThreadId,
      input: input('Reply exactly ambiguous-seed-ok. Do not call tools or edit files.'),
      effort: 'low',
      clientUserMessageId: 'ambiguous-seed',
    })
    await waitForCompletedClientId(codex, codexThreadId, 'ambiguous-seed')
    const config: CordexConfig = {
      token: 'fixture-token',
      applicationId: 'fixture-application',
      guildId: 'fixture-guild',
      defaultModel: started.model,
      defaultEffort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      allowAllUsers: true,
      allowShellCommands: false,
      projects: { [parentChannelId]: { directory: workspace } },
    }
    await saveConfig(config)
    const state = emptyState()
    state.sessions[discordThreadId] = {
      discordThreadId,
      parentChannelId,
      directory: workspace,
      codexThreadId,
      model: started.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    }
    state.queues[discordThreadId] = [
      prompt(directId, 'Read README.md line 1, then reply exactly ambiguous-direct-ok. Do not edit files.', 'direct'),
      prompt(queuedId, 'Read README.md line 1, then reply exactly ambiguous-queued-ok. Do not edit files.', 'queued'),
    ]
    await saveState(state)

    const realStartTurn = codex.startTurn.bind(codex)
    codex.startTurn = async (options) => {
      const turnId = await realStartTurn(options)
      const clientId = options.clientUserMessageId
      if (clientId === directId || clientId === queuedId) {
        injected.push(clientId)
        hiddenClientIds.add(clientId)
        throw new Error(`Simulated lost turn/start reply after Codex accepted ${clientId}`)
      }
      return turnId
    }
    const realRuntime = codex.getThreadRuntimeState.bind(codex)
    codex.getThreadRuntimeState = async (threadId) => {
      const runtime = await realRuntime(threadId)
      return runtime.userMessageClientIds
        ? { ...runtime, userMessageClientIds: runtime.userMessageClientIds.filter((id) => !hiddenClientIds.has(id)) }
        : runtime
    }

    bot = new CordexDiscordBot(config, state, codex)
    attachChannel(bot)
    const controls = bot as unknown as RecoveryControls
    await assert.rejects(
      controls.recoverPersistedPrompts(state.sessions[discordThreadId]!, channel),
      /Simulated lost turn\/start reply/,
    )
    assert.deepEqual(injected, [directId])
    assert.equal(state.queues[discordThreadId]?.[0]?.reviewRequired, true)
    assert.equal(state.queues[discordThreadId]?.[0]?.deliveryStarted, true)
    assert.equal(state.queues[discordThreadId]?.[1]?.deliveryStarted, undefined)
    assert.ok(delivered.some((value) => value.includes(directId) && value.includes('will not retry it automatically')))
    await waitForCompletedClientId(codex, codexThreadId, directId)
    assert.equal(await completedClientIdCount(codex, codexThreadId, directId), 1)

    await controls.handlePendingPromptsCommand(interaction({}))
    assert.ok(privateReplies.some((value) => value.includes(directId)))
    await controls.handleResolvePendingCommand(interaction({ action: 'discard', 'source-id': directId }))
    assert.deepEqual(injected, [directId, queuedId])
    assert.equal(state.queues[discordThreadId]?.length, 1)
    assert.equal(state.queues[discordThreadId]?.[0]?.id, queuedId)
    assert.equal(state.queues[discordThreadId]?.[0]?.reviewRequired, true)
    assert.equal(state.queues[discordThreadId]?.[0]?.deliveryStarted, true)
    await waitForCompletedClientId(codex, codexThreadId, queuedId)
    assert.equal(await completedClientIdCount(codex, codexThreadId, queuedId), 1)

    await bot.stop()
    bot = undefined
    const reloaded = await loadState()
    assert.equal(reloaded.queues[discordThreadId]?.[0]?.id, queuedId)
    assert.equal(reloaded.queues[discordThreadId]?.[0]?.reviewRequired, true)
    assert.equal(reloaded.queues[discordThreadId]?.[0]?.deliveryStarted, true)

    resumedCodex = new CodexAppServer()
    const resumedRuntime = resumedCodex.getThreadRuntimeState.bind(resumedCodex)
    resumedCodex.getThreadRuntimeState = async (threadId) => {
      const runtime = await resumedRuntime(threadId)
      return runtime.userMessageClientIds
        ? { ...runtime, userMessageClientIds: runtime.userMessageClientIds.filter((id) => id !== queuedId) }
        : runtime
    }
    resumedBot = new CordexDiscordBot(config, reloaded, resumedCodex)
    attachChannel(resumedBot)
    const resumedControls = resumedBot as unknown as RecoveryControls
    await resumedControls.recoverPersistedPrompts(reloaded.sessions[discordThreadId]!, channel)
    assert.equal(reloaded.queues[discordThreadId]?.[0]?.reviewRequired, true)
    await resumedControls.handlePendingPromptsCommand(interaction({}))
    assert.ok(privateReplies.some((value) => value.includes('queued source ID') && value.includes(queuedId)))
    await resumedControls.handleResolvePendingCommand(interaction({ action: 'discard', 'source-id': queuedId }))
    assert.equal(reloaded.queues[discordThreadId]?.length, 0)
    assert.equal(await completedClientIdCount(resumedCodex, codexThreadId, directId), 1)
    assert.equal(await completedClientIdCount(resumedCodex, codexThreadId, queuedId), 1)
    assert.deepEqual(injected, [directId, queuedId])
    assert.ok(privateReplies.filter((value) => value.includes('Uncertain prompt discarded.')).length >= 2)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-ambiguous-delivery-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, `${JSON.stringify({
      scenario: 'real Codex accepts direct and queued turns but two replies are lost; immediate history hides accepted IDs; queued hold survives bot/app-server restart',
      command: 'npm run test:live-ambiguous-delivery',
      codexThreadId,
      directId,
      queuedId,
      acceptedButReplyLost: injected,
      completedClientIdCounts: { direct: 1, queued: 1 },
      directHeldBeforeManualDiscard: true,
      queuedHeldAfterRestart: true,
      privateReviewsVisible: true,
      privateDiscardsAcknowledged: 2,
      remainingQueueLength: reloaded.queues[discordThreadId]?.length || 0,
      warningCount: delivered.filter((value) => value.includes('will not retry it automatically')).length,
    }, null, 2)}\n`, { mode: 0o600 })
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    await resumedBot?.stop().catch(() => undefined)
    await bot?.stop().catch(() => undefined)
    await resumedCodex?.close().catch(() => undefined)
    await codex.close().catch(() => undefined)
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
