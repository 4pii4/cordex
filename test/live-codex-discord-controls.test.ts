import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Events, type ButtonInteraction, type StringSelectMenuInteraction, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, ServerNotification, ServerRequest, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type FakeMessage = {
  id: string
  content: string
  components: Array<{ toJSON(): { components: Array<{ custom_id?: string; label?: string }> } }>
  edits: number
  edit(payload: { content?: string; components?: FakeMessage['components'] }): Promise<FakeMessage>
}

function fakeThread(id: string, parentId: string, guildId: string) {
  const sent: FakeMessage[] = []
  let failEchoOnce = false
  let echoFailures = 0
  let failApprovalEdits = 0
  let confirmationBlocked = false
  let confirmationSendFailures = 0
  let archived = false
  const channel = {
    id,
    parentId,
    guildId,
    name: 'Codex controls E2E',
    get archived() { return archived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(value: boolean) { archived = value; return channel },
    async send(payload: string | { content?: string; components?: FakeMessage['components'] }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      if (failEchoOnce && content.startsWith('» **')) {
        failEchoOnce = false
        echoFailures++
        throw new Error('Simulated Discord echo send failure')
      }
      if (confirmationBlocked && content.startsWith('Approval recorded:')) {
        confirmationSendFailures++
        throw new Error('Simulated Discord confirmation send failure')
      }
      const message: FakeMessage = {
        id: `${id}-message-${sent.length + 1}`,
        content,
        components: typeof payload === 'string' ? [] : payload.components || [],
        edits: 0,
        async edit(next) {
          if (this.content.includes('Permission Required') && failApprovalEdits > 0) {
            failApprovalEdits--
            throw new Error('Simulated Discord approval message edit failure')
          }
          if (next.content !== undefined) this.content = next.content
          if (next.components !== undefined) this.components = next.components
          this.edits++
          return this
        },
      }
      sent.push(message)
      return message
    },
  } as unknown as ThreadChannel
  return {
    channel,
    sent,
    failNextEcho() { failEchoOnce = true },
    failNextApprovalEdit() { failApprovalEdits++ },
    blockApprovalConfirmations(value: boolean) { confirmationBlocked = value },
    get echoFailures() { return echoFailures },
    get confirmationSendFailures() { return confirmationSendFailures },
  }
}

function componentId(message: FakeMessage, label?: string): string {
  const options = message.components.flatMap((row) => row.toJSON().components)
  const selected = label ? options.find((option) => option.label === label) : options[0]
  assert.ok(selected?.custom_id, `No control ${label || ''} found`)
  return selected.custom_id
}

test('real Codex Discord questions and approvals survive UI delivery failures', {
  skip: !process.env.CORDEX_DISCORD_CONTROLS_TEST,
  timeout: 180_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-controls-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-controls-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const parentChannelId = 'project-controls-e2e'
  const guildId = 'fixture-guild'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const codex = new CodexAppServer()
  const bot = new CordexDiscordBot(config, state, codex)
  const channels = new Map<string, ReturnType<typeof fakeThread>>()
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async (id: string) => {
      const channel = channels.get(id)?.channel
      if (!channel) throw new Error(`Unknown fake Discord thread ${id}`)
      return channel
    }
  const completed = new Map<string, string>()
  const completionCounts = new Map<string, number>()
  const requests: ServerRequest[] = []
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const threadId = notification.params.threadId
    const turn = notification.params.turn
    if (typeof threadId === 'string' && typeof turn === 'object' && turn !== null &&
      'status' in turn && typeof turn.status === 'string') {
      completed.set(threadId, turn.status)
      completionCounts.set(threadId, (completionCounts.get(threadId) || 0) + 1)
    }
  })
  codex.on('serverRequest', (request: ServerRequest) => requests.push(request))
  const user = { id: 'fixture-user', displayName: 'Fixture User', toString: () => '<@fixture-user>' }
  let questionThreadId = ''
  let approvalThreadId = ''
  try {
    await writeFile(path.join(workspace, 'README.md'), 'Discord controls fixture\n')
    const questionThread = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    questionThreadId = questionThread.threadId
    const questionDiscordId = 'discord-questions-e2e'
    const questionChannel = fakeThread(questionDiscordId, parentChannelId, guildId)
    channels.set(questionDiscordId, questionChannel)
    state.sessions[questionDiscordId] = {
      discordThreadId: questionDiscordId,
      parentChannelId,
      directory: workspace,
      codexThreadId: questionThreadId,
      model: questionThread.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    } satisfies SessionState
    await codex.startTurn({
      threadId: questionThreadId,
      model: questionThread.model,
      effort: 'low',
      mode: 'plan',
      input: [{
        type: 'text',
        text: 'Use request_user_input exactly once with two questions. First: id mode, header Mode, ask for Alpha or Beta with those two options. Second: id color, header Color, ask for Green or Blue with those two options. Wait for both answers, then reply exactly controls-e2e-Alpha-Green. Do not edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() => questionChannel.sent.filter((message) =>
      message.components.length > 0 && message.content.includes('**')).length >= 2,
    'two Discord question controls')
    const questionRequest = requests.find((request) =>
      request.method === 'item/tool/requestUserInput' && request.params.threadId === questionThreadId)
    assert.ok(questionRequest)
    const controls = bot as unknown as {
      handleUserInputSelect(value: StringSelectMenuInteraction): Promise<void>
      handleButton(value: ButtonInteraction): Promise<void>
      pendingUserInputs: Map<string, unknown>
      approvals: Map<string, unknown>
    }
    const questionMessages = questionChannel.sent.filter((message) => message.components.length > 0).slice(0, 2)
    assert.equal(questionMessages.length, 2)
    const firstQuestionId = componentId(questionMessages[0]!)
    const secondQuestionId = componentId(questionMessages[1]!)
    const makeSelect = (customId: string) => {
      const replies: string[] = []
      const value = {
        customId,
        values: ['option:0'],
        channelId: questionDiscordId,
        guildId,
        user,
        async deferUpdate() {},
        async reply(payload: string | { content: string }) {
          replies.push(typeof payload === 'string' ? payload : payload.content)
        },
        async followUp(payload: { content: string }) { replies.push(payload.content) },
      } as unknown as StringSelectMenuInteraction
      return { value, replies }
    }
    questionChannel.failNextEcho()
    await controls.handleUserInputSelect(makeSelect(firstQuestionId).value)
    assert.equal(questionChannel.echoFailures, 1)
    assert.equal(controls.pendingUserInputs.size, 1)
    assert.equal(completed.has(questionThreadId), false)
    await controls.handleUserInputSelect(makeSelect(secondQuestionId).value)
    await waitFor(() => completed.has(questionThreadId), 'question turn completion')
    assert.equal(completed.get(questionThreadId), 'completed')
    assert.equal(controls.pendingUserInputs.size, 0)
    assert.ok(questionMessages.every((message) => message.components.length === 0))
    const staleQuestion = makeSelect(firstQuestionId)
    await controls.handleUserInputSelect(staleQuestion.value)
    assert.ok(staleQuestion.replies.some((reply) => reply.includes('expired')))

    const approvalThread = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    approvalThreadId = approvalThread.threadId
    const approvalDiscordId = 'discord-approval-e2e'
    const approvalChannel = fakeThread(approvalDiscordId, parentChannelId, guildId)
    channels.set(approvalDiscordId, approvalChannel)
    state.sessions[approvalDiscordId] = {
      discordThreadId: approvalDiscordId,
      parentChannelId,
      directory: workspace,
      codexThreadId: approvalThreadId,
      model: approvalThread.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    } satisfies SessionState
    await codex.startTurn({
      threadId: approvalThreadId,
      model: approvalThread.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Use the shell tool to run exactly: printf approved-discord-controls > approval-result.txt. This disposable fixture is intended to be written. Request approval if required, wait for the decision, then reply exactly approval-controls-e2e.',
        text_elements: [],
      }],
    })
    try {
      await waitFor(() => approvalChannel.sent.some((message) =>
        message.content.includes('Permission Required') && message.components.length > 0),
      'Discord approval control')
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ` +
        `requestMethods=${JSON.stringify(requests.filter((request) => request.params.threadId === approvalThreadId).map((request) => request.method))}; ` +
        `turnStatus=${completed.get(approvalThreadId) || 'pending'}; ` +
        `discordMessages=${JSON.stringify(approvalChannel.sent.slice(-5).map((message) => message.content.slice(0, 160)))}`)
    }
    const approvalRequest = requests.find((request) =>
      request.method.includes('requestApproval') && request.params.threadId === approvalThreadId)
    assert.ok(approvalRequest)
    const approvalMessage = approvalChannel.sent.find((message) =>
      message.content.includes('Permission Required') && message.components.length > 0)!
    const acceptId = componentId(approvalMessage, 'Accept')
    const approvalReplies: string[] = []
    const approvalInteraction = {
      customId: acceptId,
      channelId: approvalDiscordId,
      guildId,
      user,
      async update() { throw new Error('Simulated Discord interaction update failure') },
      async reply(payload: string | { content: string }) {
        approvalReplies.push(typeof payload === 'string' ? payload : payload.content)
      },
    } as unknown as ButtonInteraction
    await controls.handleButton(approvalInteraction)
    assert.equal(approvalMessage.components.length, 0)
    assert.ok(approvalMessage.edits > 0)
    await waitFor(() => completed.has(approvalThreadId), 'approval turn completion')
    assert.equal(await readFile(path.join(workspace, 'approval-result.txt'), 'utf8'), 'approved-discord-controls')
    assert.equal(controls.approvals.size, 0)
    await controls.handleButton(approvalInteraction)
    assert.ok(approvalReplies.some((reply) => reply.includes('expired')))

    const approvalsBeforeSecondTurn = requests.filter((request) =>
      request.method.includes('requestApproval') && request.params.threadId === approvalThreadId).length
    const completedBeforeSecondTurn = completionCounts.get(approvalThreadId) || 0
    await codex.startTurn({
      threadId: approvalThreadId,
      model: approvalThread.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Use the shell tool to run exactly: printf double-fallback-ok > approval-double-fallback.txt. This disposable fixture is intended to be written. Request approval if required, wait for the decision, then reply exactly double-fallback-done.',
        text_elements: [],
      }],
    })
    await waitFor(() => requests.filter((request) =>
      request.method.includes('requestApproval') && request.params.threadId === approvalThreadId).length >
      approvalsBeforeSecondTurn, 'second real Codex approval request')
    const secondApprovalMessage = [...approvalChannel.sent].reverse().find((message) =>
      message.content.includes('Permission Required') && message.components.length > 0)
    assert.ok(secondApprovalMessage)
    approvalChannel.failNextApprovalEdit()
    approvalChannel.blockApprovalConfirmations(true)
    const doubleFallbackReplies: string[] = []
    const secondApprovalInteraction = {
      customId: componentId(secondApprovalMessage, 'Accept'),
      channelId: approvalDiscordId,
      guildId,
      user,
      async update() { throw new Error('Simulated Discord interaction update failure') },
      async reply(payload: string | { content: string }) {
        doubleFallbackReplies.push(typeof payload === 'string' ? payload : payload.content)
      },
    } as unknown as ButtonInteraction
    await controls.handleButton(secondApprovalInteraction)
    assert.ok(secondApprovalMessage.components.length > 0)
    await waitFor(() => state.discordOutbox?.some((entry) =>
      entry.itemKey.startsWith('approval:') && entry.content.includes('Approval recorded:')) === true,
    'durable confirmation after both UI writes failed')
    assert.ok(approvalChannel.confirmationSendFailures >= 1)
    await waitFor(() => (completionCounts.get(approvalThreadId) || 0) > completedBeforeSecondTurn,
      'second approved Codex turn completion')
    assert.equal(await readFile(path.join(workspace, 'approval-double-fallback.txt'), 'utf8'), 'double-fallback-ok')
    approvalChannel.blockApprovalConfirmations(false)
    bot.client.emit(Events.ShardResume, 0, 0)
    await waitFor(() =>
      approvalChannel.sent.some((message) => message.content.includes('Approval recorded: Approved')) &&
      approvalChannel.sent.some((message) => message.content.includes('double-fallback-done')) &&
      (state.discordOutbox?.length || 0) === 0,
    'Discord reconnect delivery of confirmation and final answer', 30_000)
    assert.equal(approvalChannel.sent.filter((message) =>
      message.content.includes('Approval recorded: Approved')).length, 1)
    await controls.handleButton(secondApprovalInteraction)
    assert.ok(doubleFallbackReplies.some((reply) => reply.includes('expired')))

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-discord-controls-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex two-question request and command approval through Discord controls with simulated delivery failures',
      command: 'npm run test:live-discord-controls',
      questionThreadId,
      approvalThreadId,
      questionIds: Array.isArray(questionRequest.params.questions)
        ? questionRequest.params.questions.flatMap((question) =>
          typeof question === 'object' && question !== null && 'id' in question ? [question.id] : [])
        : [],
      echoFailures: questionChannel.echoFailures,
      questionStatus: completed.get(questionThreadId),
      approvalStatus: completed.get(approvalThreadId),
      approvalFallbackEdits: approvalMessage.edits,
      approvedFile: 'approval-result.txt',
      doubleFallbackApprovedFile: 'approval-double-fallback.txt',
      doubleFallbackConfirmationSendFailures: approvalChannel.confirmationSendFailures,
      durableConfirmationDeliveredOnce: true,
      secondApprovalStatus: completed.get(approvalThreadId),
      staleDoubleFallbackControlRejected: true,
      staleQuestionRejected: true,
      staleApprovalRejected: true,
      pendingQuestionControls: controls.pendingUserInputs.size,
      pendingApprovalControls: controls.approvals.size,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (questionThreadId) await codex.archiveThread(questionThreadId).catch(() => undefined)
    if (approvalThreadId) await codex.archiveThread(approvalThreadId).catch(() => undefined)
    await bot.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
