import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import { isMcpToolApproval } from '../src/mcp-elicitation.js'
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
  components: Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>
  edit(payload: { content?: string; components?: FakeMessage['components'] }): Promise<FakeMessage>
}

function fakeThread(id: string, parentId: string, guildId: string) {
  const sent: FakeMessage[] = []
  let archived = false
  const channel = {
    id,
    parentId,
    guildId,
    name: 'MCP elicitation E2E',
    get archived() { return archived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(value: boolean) { archived = value; return channel },
    async send(payload: string | { content?: string; components?: FakeMessage['components'] }) {
      const message: FakeMessage = {
        id: `${id}-message-${sent.length + 1}`,
        content: typeof payload === 'string' ? payload : payload.content || '',
        components: typeof payload === 'string' ? [] : payload.components || [],
        async edit(next) {
          if (next.content !== undefined) this.content = next.content
          if (next.components !== undefined) this.components = next.components
          return this
        },
      }
      sent.push(message)
      return message
    },
  } as unknown as ThreadChannel
  return { channel, sent }
}

function componentId(message: FakeMessage): string {
  const id = message.components.flatMap((row) => row.toJSON().components)[0]?.custom_id
  assert.ok(id, `Message has no control: ${message.content.slice(0, 100)}`)
  return id
}

test('real MCP elicitation reaches Discord form controls and returns validated content', {
  skip: !process.env.CORDEX_MCP_ELICITATION_TEST,
  timeout: 360_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-mcp-elicit-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-mcp-elicit-project-'))
  const resultPath = path.join(workspace, 'mcp-result.json')
  const tracePath = path.join(workspace, 'mcp-trace.jsonl')
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const fixturePath = path.resolve('test/fixtures/mcp-elicitation-server.mjs')
  const serverName = 'cordex_e2e_elicitation'
  const codex = new CodexAppServer({
    args: [
      '-c', `mcp_servers.${serverName}.command="node"`,
      '-c', `mcp_servers.${serverName}.args=${JSON.stringify([fixturePath, resultPath, tracePath])}`,
      'app-server', '--stdio',
    ],
  })
  const responses: Array<{ id: string | number; method: string; action: unknown; error?: string }> = []
  const originalRespondTo = codex.respondTo.bind(codex)
  codex.respondTo = (request: ServerRequest, result: unknown) => {
    const action = typeof result === 'object' && result !== null && 'action' in result
      ? result.action
      : undefined
    try {
      originalRespondTo(request, result)
      responses.push({ id: request.id, method: request.method, action })
    } catch (error) {
      responses.push({
        id: request.id,
        method: request.method,
        action,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
  const parentChannelId = 'project-mcp-elicit-e2e'
  const discordThreadId = 'discord-mcp-elicit-e2e'
  const guildId = 'fixture-guild'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  const state = emptyState()
  const bot = new CordexDiscordBot(config, state, codex)
  const fake = fakeThread(discordThreadId, parentChannelId, guildId)
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
    async (id: string) => {
      if (id !== discordThreadId) throw new Error(`Unknown fake Discord thread ${id}`)
      return fake.channel
    }
  const controls = bot as unknown as {
    requireAccess(value: unknown): Promise<boolean>
    pendingMcpElicitations: Map<string, unknown>
    handleButton(value: ButtonInteraction): Promise<void>
    handleMcpElicitationModal(value: ModalSubmitInteraction): Promise<void>
    handleMcpElicitationSelect(value: StringSelectMenuInteraction): Promise<void>
  }
  controls.requireAccess = async () => true
  const requests: ServerRequest[] = []
  const resolvedRequestIds: Array<string | number> = []
  const completed = new Map<string, string>()
  codex.on('serverRequest', (request: ServerRequest) => requests.push(request))
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method === 'serverRequest/resolved') {
      const requestId = notification.params.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        resolvedRequestIds.push(requestId)
      }
    }
    if (notification.method !== 'turn/completed') return
    const threadId = notification.params.threadId
    const turn = notification.params.turn
    if (typeof threadId === 'string' && typeof turn === 'object' && turn !== null &&
      'status' in turn && typeof turn.status === 'string') {
      completed.set(threadId, turn.status)
    }
  })
  const user = { id: 'fixture-user', displayName: 'Fixture User', toString: () => '<@fixture-user>' }
  const replies: string[] = []
  const button = (customId: string) => ({
    customId,
    channelId: discordThreadId,
    guildId,
    user,
    async deferUpdate() {},
    async reply(payload: { content: string }) { replies.push(payload.content) },
    async followUp(payload: { content: string }) { replies.push(payload.content) },
    async showModal() {},
  }) as unknown as ButtonInteraction
  const modal = (customId: string, value: string) => ({
    customId,
    channelId: discordThreadId,
    guildId,
    user,
    fields: { getTextInputValue: () => value },
    async deferUpdate() {},
    async reply(payload: { content: string }) { replies.push(payload.content) },
    async followUp(payload: { content: string }) { replies.push(payload.content) },
  }) as unknown as ModalSubmitInteraction
  const select = (customId: string, values: string[]) => ({
    customId,
    channelId: discordThreadId,
    guildId,
    user,
    values,
    async deferUpdate() {},
    async reply(payload: { content: string }) { replies.push(payload.content) },
    async followUp(payload: { content: string }) { replies.push(payload.content) },
  }) as unknown as StringSelectMenuInteraction
  let codexThreadId = ''
  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    codexThreadId = started.threadId
    const inventory = await codex.request('mcpServerStatus/list', {
      threadId: codexThreadId,
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
    }) as { data?: Array<{ name: string; runtimeStatus?: string; tools?: Record<string, unknown>; toolsError?: string }> }
    const server = inventory.data?.find((entry) => entry.name === serverName)
    assert.equal(server?.runtimeStatus, 'connected', JSON.stringify(server))
    assert.ok(server?.tools?.collect_trip_preferences, JSON.stringify(server))
    state.sessions[discordThreadId] = {
      discordThreadId,
      parentChannelId,
      directory: workspace,
      codexThreadId,
      model: started.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    } satisfies SessionState
    const turnId = await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: `Call the collect_trip_preferences MCP tool from ${serverName} exactly once. Wait for its form and answer. After the tool completes, reply exactly mcp-elicit-e2e-done. Do not edit files.`,
        text_elements: [],
      }],
    })
    state.sessions[discordThreadId]!.activeTurnId = turnId
    await waitFor(() => controls.pendingMcpElicitations.size === 1 &&
      requests.some((entry) => entry.method === 'mcpServer/elicitation/request' &&
        isMcpToolApproval(entry.params._meta)),
    'MCP tool approval in Discord', 60_000)
    const approvalRequest = requests.find((entry) => entry.method === 'mcpServer/elicitation/request' &&
      isMcpToolApproval(entry.params._meta))
    assert.ok(approvalRequest)
    const approvalMessage = fake.sent.find((message) =>
      message.components.flatMap((row) => row.toJSON().components).some((control) =>
        control.custom_id?.includes('mcp-elicit-action:') && control.custom_id.endsWith(':accept')))
    assert.ok(approvalMessage)
    await controls.handleButton(button(componentId(approvalMessage)))
    await waitFor(() => controls.pendingMcpElicitations.size === 1 &&
      requests.some((entry) => entry.method === 'mcpServer/elicitation/request' &&
        entry.params.mode === 'form' && !isMcpToolApproval(entry.params._meta)),
    'real MCP form elicitation in Discord', 60_000)
    const request = requests.find((entry) => entry.method === 'mcpServer/elicitation/request' &&
      entry.params.mode === 'form' && !isMcpToolApproval(entry.params._meta))
    assert.ok(request)
    assert.equal(request.params.mode, 'form')
    assert.equal(request.params.serverName, serverName)
    const key = [...controls.pendingMcpElicitations.keys()][0]
    assert.ok(key)
    const fieldMessages = fake.sent.filter((message) =>
      message.components.flatMap((row) => row.toJSON().components).some((control) =>
        control.custom_id?.startsWith(`mcp-elicit-field:${key}:`) ||
        control.custom_id?.startsWith(`mcp-elicit-select:${key}:`)))
      .sort((left, right) => Number(componentId(left).split(':').at(-1)) -
        Number(componentId(right).split(':').at(-1)))
    assert.equal(fieldMessages.length, 5, fake.sent.map((message) => message.content).join('\n---\n'))
    const pending = controls.pendingMcpElicitations.get(key) as {
      form?: { fields: Array<{ id: string }> }
    } | undefined
    assert.ok(pending?.form)
    const fieldControl = (id: string) => {
      const index = pending.form!.fields.findIndex((field) => field.id === id)
      assert.ok(index >= 0, `Missing MCP field ${id}`)
      const message = fieldMessages.find((entry) => componentId(entry).endsWith(`:${index}`))
      assert.ok(message, `Missing Discord control for MCP field ${id}`)
      return componentId(message)
    }
    const actionMessage = fake.sent.find((message) => message.content === '**MCP form response**')
    assert.ok(actionMessage)
    await controls.handleMcpElicitationModal(modal(fieldControl('destination').replace('mcp-elicit-field:', 'mcp-elicit-modal:'), 'Hanoi'))
    const daysModalId = fieldControl('days').replace('mcp-elicit-field:', 'mcp-elicit-modal:')
    await controls.handleMcpElicitationModal(modal(daysModalId, '1'))
    assert.ok(replies.some((reply) => reply.includes('Days must be at least 2')))
    await controls.handleMcpElicitationModal(modal(daysModalId, '5'))
    await controls.handleMcpElicitationSelect(select(fieldControl('pace'), ['option:1']))
    await controls.handleMcpElicitationSelect(select(fieldControl('activities'), ['option:0', 'option:2']))
    await controls.handleMcpElicitationSelect(select(fieldControl('includeTravel'), ['true']))
    const submitId = componentId(actionMessage)
    await controls.handleButton(button(submitId))
    if (controls.pendingMcpElicitations.size > 0) {
      const current = controls.pendingMcpElicitations.get(key) as { content?: Record<string, unknown> } | undefined
      throw new Error(`Discord MCP form was not submitted; ` +
        `replies=${JSON.stringify(replies)}; content=${JSON.stringify(current?.content || {})}; ` +
        `fieldControls=${JSON.stringify(fieldMessages.map((message) => ({
          id: componentId(message),
          content: message.content.slice(0, 120),
        })))}`)
    }
    try {
      await waitFor(() => existsSync(resultPath), 'MCP server elicitation result', 30_000)
    } catch (error) {
      const trace = await readFile(tracePath, 'utf8').catch(() => '')
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ` +
        `MCP protocol trace=${JSON.stringify(trace.trim().split('\n').slice(-10))}; ` +
        `requests=${JSON.stringify(requests.map((entry) => ({ id: entry.id, method: entry.method, mode: entry.params.mode })))}; ` +
        `responses=${JSON.stringify(responses)}; resolvedRequestIds=${JSON.stringify(resolvedRequestIds)}`)
    }
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      clientSupportsElicitation: boolean
      action: string
      content: unknown
    }
    assert.equal(result.clientSupportsElicitation, true)
    assert.equal(result.action, 'accept')
    assert.deepEqual(result.content, {
      destination: 'Hanoi',
      days: 5,
      pace: 'balanced',
      activities: ['museum', 'food'],
      includeTravel: true,
    })
    try {
      await waitFor(() => completed.has(codexThreadId), 'MCP tool turn completion', 180_000)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ` +
        `MCP server accepted the exact form content but Codex has not completed the turn; ` +
        `requestMethods=${JSON.stringify(requests.map((entry) => entry.method))}`)
    }
    assert.equal(completed.get(codexThreadId), 'completed')
    assert.equal(controls.pendingMcpElicitations.size, 0)
    assert.ok([...fieldMessages, actionMessage].every((message) => message.components.length === 0))
    await controls.handleButton(button(submitId))
    assert.ok(replies.some((reply) => reply.includes('no longer available')))

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-mcp-elicit-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, `${JSON.stringify({
      scenario: 'real Codex MCP server elicitation with a five-field Discord form',
      command: 'npm run test:live-mcp-elicitation',
      codexThreadId,
      requestMethod: request.method,
      requestMode: request.params.mode,
      toolApprovalMethod: approvalRequest.method,
      toolApprovalAccepted: true,
      serverName: request.params.serverName,
      toolListed: true,
      invalidNumberRejected: true,
      response: result,
      turnStatus: completed.get(codexThreadId),
      controlsCleared: true,
      staleClickRejected: true,
      completed: true,
    }, null, 2)}\n`, { mode: 0o600 })
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (codexThreadId) await codex.archiveThread(codexThreadId).catch(() => undefined)
    await bot.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
