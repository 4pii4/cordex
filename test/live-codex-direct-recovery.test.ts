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

async function waitForAcceptedUserMessage(
  codex: CodexAppServer,
  threadId: string,
  clientId: string,
): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await codex.request('thread/turns/list', {
        threadId,
        cursor: null,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'full',
      }) as { data?: Array<{ status?: string; items?: Array<{ type?: string; clientId?: string }> }> }
      if (response.data?.some((turn) => turn.status === 'completed' &&
        turn.items?.some((item) => item.type === 'userMessage' && item.clientId === clientId))) return
    } catch {
      // The new rollout may briefly be empty before Codex writes its first item.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Accepted Codex user item did not complete')
}

test('real Codex restart recovery deduplicates accepted input and holds uncertain direct input', {
  skip: !process.env.CORDEX_DIRECT_RECOVERY_TEST,
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-direct-recovery-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-direct-recovery-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const codex = new CodexAppServer()
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  const discordThreadId = 'discord-direct-recovery-e2e'
  const parentChannelId = 'project-direct-recovery-e2e'
  const acceptedId = 'direct-accepted-before-crash'
  const uncertainId = 'direct-uncertain-after-crash'
  const queuedId = 'queued-behind-uncertain'
  const acceptedInput: UserInput[] = [{
    type: 'text',
    text: 'Reply exactly accepted-before-crash-ok. Do not call tools or edit files.',
    text_elements: [],
  }]
  const uncertainInput: UserInput[] = [{
    type: 'text',
    text: 'Read README.md line 1, then reply exactly uncertain-direct-ran. Do not edit files.',
    text_elements: [],
  }]
  const queuedInput: UserInput[] = [{
    type: 'text',
    text: 'Reply exactly queued-after-uncertain-ran. Do not edit files.',
    text_elements: [],
  }]
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    guildId: 'fixture-guild',
    parentId: parentChannelId,
    name: 'Direct recovery E2E',
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

  try {
    await writeFile(path.join(workspace, 'README.md'), '# Disposable recovery project\n')
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    codexThreadId = started.threadId
    await codex.startTurn({
      threadId: codexThreadId,
      input: acceptedInput,
      effort: 'low',
      clientUserMessageId: acceptedId,
    })
    await waitForAcceptedUserMessage(codex, codexThreadId, acceptedId)

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
    const prompt = (id: string, input: UserInput[], deliveryKind: 'direct' | 'queued'): QueuedPrompt => ({
      id,
      authorId: 'fixture-user',
      authorName: 'tester',
      input,
      displayText: String((input[0] as { text?: string })?.text || id),
      createdAt: new Date().toISOString(),
      deliveryKind,
    })
    state.queues[discordThreadId] = [
      prompt(acceptedId, acceptedInput, 'direct'),
      prompt(uncertainId, uncertainInput, 'direct'),
      prompt(queuedId, queuedInput, 'queued'),
    ]
    await saveState(state)
    const reloaded = await loadState()
    assert.equal(reloaded.queues[discordThreadId]?.length, 3)

    bot = new CordexDiscordBot(config, reloaded, codex)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
    const internal = bot as unknown as {
      recoverPersistedPrompts(session: SessionState, channel: ThreadChannel): Promise<void>
      handlePendingPromptsCommand(interaction: ChatInputCommandInteraction): Promise<void>
      handleResolvePendingCommand(interaction: ChatInputCommandInteraction): Promise<void>
    }
    await internal.recoverPersistedPrompts(reloaded.sessions[discordThreadId]!, channel)
    const remaining = reloaded.queues[discordThreadId] || []
    assert.equal(remaining.some((item) => item.id === acceptedId), false)
    assert.equal(remaining.some((item) => item.id === uncertainId), true)
    assert.equal(remaining.some((item) => item.id === queuedId), true)
    assert.equal(remaining.find((item) => item.id === uncertainId)?.reviewRequired, true)
    assert.ok(delivered.some((content) => content.includes('will not retry it automatically')), delivered.join('\n'))
    const pausedQueue = remaining.map((item) => ({ id: item.id, reviewRequired: item.reviewRequired === true }))
    const turns = await codex.request('thread/turns/list', {
      threadId: codexThreadId,
      cursor: null,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    }) as { data?: Array<{ id: string; items?: Array<{ type?: string; clientId?: string }> }> }
    const clientIds = (turns.data || []).flatMap((turn) =>
      (turn.items || []).filter((item) => item.type === 'userMessage').map((item) => item.clientId))
    assert.equal(clientIds.filter((id) => id === acceptedId).length, 1)
    assert.equal(clientIds.filter((id) => id === uncertainId).length, 0)

    const privateReplies: string[] = []
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
    await internal.handlePendingPromptsCommand(interaction({}))
    assert.ok(privateReplies.some((reply) => reply.includes(uncertainId)))
    await internal.handleResolvePendingCommand(interaction({ action: 'retry', 'source-id': uncertainId }))
    await waitForAcceptedUserMessage(codex, codexThreadId, uncertainId)
    await waitForAcceptedUserMessage(codex, codexThreadId, queuedId)
    assert.equal(reloaded.queues[discordThreadId]?.length, 0)
    assert.ok(delivered.some((content) => content.includes('uncertain-direct-ran')))
    assert.ok(delivered.some((content) => content.includes('queued-after-uncertain-ran')))
    const after = await codex.request('thread/turns/list', {
      threadId: codexThreadId,
      cursor: null,
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    }) as { data?: Array<{ items?: Array<{ type?: string; clientId?: string }> }> }
    const clientIdsAfter = (after.data || []).flatMap((turn) =>
      (turn.items || []).filter((item) => item.type === 'userMessage').map((item) => item.clientId))
    assert.equal(clientIdsAfter.filter((id) => id === acceptedId).length, 1)
    assert.equal(clientIdsAfter.filter((id) => id === uncertainId).length, 1)
    assert.equal(clientIdsAfter.filter((id) => id === queuedId).length, 1)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-direct-recovery-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, `${JSON.stringify({
      scenario: 'real Codex accepted direct input, simulated restart, uncertain direct input, and queued follow-up',
      command: 'npm run test:live-direct-recovery',
      codexThreadId,
      acceptedId,
      uncertainId,
      queuedId,
      pausedQueue,
      remainingAfterExplicitRetry: reloaded.queues[discordThreadId]?.length || 0,
      acceptedClientIdCount: clientIds.filter((id) => id === acceptedId).length,
      uncertainClientIdCount: clientIds.filter((id) => id === uncertainId).length,
      clientIdCountsAfterExplicitRetry: Object.fromEntries(
        [acceptedId, uncertainId, queuedId].map((id) => [id, clientIdsAfter.filter((value) => value === id).length]),
      ),
      noticeDelivered: delivered.some((content) => content.includes('will not retry it automatically')),
      privateReviewDisplayed: privateReplies.some((reply) => reply.includes(uncertainId)),
      explicitRetryAcknowledged: privateReplies.some((reply) => reply.includes('Retry requested')),
    }, null, 2)}\n`, { mode: 0o600 })
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    await bot?.stop().catch(() => undefined)
    await codex.close().catch(() => undefined)
    process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
