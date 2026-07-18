import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  ButtonStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  JsonObject,
  ServerNotification,
  ServerRequest,
} from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly responses: Array<{ id: string | number; result: unknown }> = []

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result })
  }
}

type MessagePayload = {
  content: string
  components?: Array<{ toJSON(): unknown }>
  allowedMentions?: unknown
}

type FakeMessage = {
  content: string
  components: Array<{ toJSON(): unknown }>
  edits: MessagePayload[]
  edit(payload: MessagePayload): Promise<FakeMessage>
}

type PendingMcp = {
  content: Record<string, unknown>
  timeout: NodeJS.Timeout
}

type InternalBot = {
  runs: Map<string, unknown>
  pendingMcpElicitations: Map<string, PendingMcp>
  pendingRequestControls: Map<string, unknown>
  requireAccess(interaction: unknown): Promise<boolean>
  handleServerRequest(request: ServerRequest): Promise<void>
  handleButton(interaction: ButtonInteraction): Promise<void>
  handleMcpElicitationSelect(interaction: StringSelectMenuInteraction): Promise<void>
  handleMcpElicitationModal(interaction: ModalSubmitInteraction): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  expireMcpElicitation(key: string): Promise<boolean>
  dismissPendingControlsForChannel(channelId: string, status: string): Promise<void>
}

function harness(): {
  bot: CordexDiscordBot
  internal: InternalBot
  codex: FakeCodex
  messages: FakeMessage[]
  typingTimer: NodeJS.Timeout
} {
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
  }
  const state: CordexState = {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: {
      'discord-thread-1': {
        discordThreadId: 'discord-thread-1',
        parentChannelId: 'parent-1',
        directory: process.cwd(),
        codexThreadId: 'codex-thread-1',
        activeTurnId: 'turn-1',
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    },
    queues: {},
    tasks: {},
  }
  const messages: FakeMessage[] = []
  const channel = {
    id: 'discord-thread-1',
    isThread() {
      return true
    },
    async send(payload: MessagePayload) {
      const message: FakeMessage = {
        content: payload.content,
        components: payload.components || [],
        edits: [],
        async edit(update) {
          this.content = update.content
          this.components = update.components || []
          this.edits.push(update)
          return this
        },
      }
      messages.push(message)
      return message
    },
  } as unknown as ThreadChannel
  const codex = new FakeCodex()
  const bot = new CordexDiscordBot(config, state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  internal.requireAccess = async () => true
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  internal.runs.set('codex-thread-1', {
    session: state.sessions['discord-thread-1'],
    channel,
    model: 'fixture-model',
    effort: 'medium',
    turnId: 'turn-1',
    startedAt: Date.now(),
    agentText: new Map(),
    typingTimer,
  })
  return { bot, internal, codex, messages, typingTimer }
}

function formRequest(
  id: string,
  requestedSchema: JsonObject,
  meta: unknown = null,
): ServerRequest {
  return {
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      serverName: 'calendar',
      mode: 'form',
      _meta: meta,
      message: 'Allow Calendar to continue?',
      requestedSchema,
    },
  }
}

function rowComponents(message: FakeMessage, rowIndex = 0): JsonObject[] {
  const row = message.components[rowIndex]?.toJSON() as JsonObject | undefined
  return Array.isArray(row?.components) ? row.components as JsonObject[] : []
}

function buttonInteraction(
  customId: string,
  replies: string[] = [],
  payloads?: Array<{
    content: string
    ephemeral?: boolean
    allowedMentions?: unknown
  }>,
): ButtonInteraction {
  return {
    customId,
    channelId: 'discord-thread-1',
    user: { id: 'user-1', toString: () => '<@user-1>' },
    async deferUpdate() {},
    async reply(payload: { content: string; ephemeral?: boolean; allowedMentions?: unknown }) {
      replies.push(payload.content)
      payloads?.push(payload)
    },
    async followUp(payload: { content: string; ephemeral?: boolean; allowedMentions?: unknown }) {
      replies.push(payload.content)
      payloads?.push(payload)
    },
    async showModal() {},
  } as unknown as ButtonInteraction
}

function modalInteraction(
  customId: string,
  value: string,
  followUps: string[],
): ModalSubmitInteraction {
  return {
    customId,
    channelId: 'discord-thread-1',
    user: { id: 'user-1' },
    fields: { getTextInputValue: () => value },
    async deferUpdate() {},
    async reply(payload: { content: string }) {
      followUps.push(payload.content)
    },
    async followUp(payload: { content: string }) {
      followUps.push(payload.content)
    },
  } as unknown as ModalSubmitInteraction
}

function selectInteraction(
  customId: string,
  values: string[],
  followUps: string[] = [],
): StringSelectMenuInteraction {
  return {
    customId,
    channelId: 'discord-thread-1',
    user: { id: 'user-1' },
    values,
    async deferUpdate() {},
    async reply(payload: { content: string }) {
      followUps.push(payload.content)
    },
    async followUp(payload: { content: string }) {
      followUps.push(payload.content)
    },
  } as unknown as StringSelectMenuInteraction
}

test('empty tool-approval forms expose persist choices and resolve exactly once', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  try {
    await internal.handleServerRequest(formRequest('approval-1', {
      type: 'object',
      properties: {},
    }, {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: {
        title: 'Roadmap review',
        visibility: 'private',
        attendees: 12,
        notify: true,
      },
      tool_params_display: [
        { name: 'title', display_name: 'Title', value: 'stale display value' },
      ],
    }))

    assert.equal(messages.length, 1)
    const disclosure = messages.map((message) => message.content).join('\n')
    assert.match(disclosure, /Title/)
    assert.match(disclosure, /Roadmap review/)
    assert.match(disclosure, /visibility/)
    assert.match(disclosure, /private/)
    assert.match(disclosure, /attendees/)
    assert.match(disclosure, /notify/)
    assert.doesNotMatch(disclosure, /stale display value/)
    assert.deepEqual(rowComponents(messages.at(-1)!).map((component) => ({
      label: component.label,
      style: component.style,
    })), [
      { label: 'Allow', style: ButtonStyle.Success },
      { label: 'Allow for this session', style: ButtonStyle.Primary },
      { label: 'Always allow', style: ButtonStyle.Primary },
      { label: 'Cancel', style: ButtonStyle.Danger },
    ])
    const [key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    await internal.handleButton(buttonInteraction(`mcp-elicit-action:${key}:session`))
    assert.deepEqual(codex.responses, [{
      id: 'approval-1',
      result: {
        action: 'accept',
        content: null,
        _meta: { persist: 'session' },
      },
    }])
    assert.equal(internal.pendingMcpElicitations.size, 0)
    assert.equal(internal.pendingRequestControls.size, 0)

    const replies: string[] = []
    await internal.handleButton(buttonInteraction(`mcp-elicit-action:${key}:session`, replies))
    assert.deepEqual(replies, ['This MCP request is no longer available.'])
    assert.equal(codex.responses.length, 1)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('Discord MCP forms collect and validate strings, numbers, booleans, and enums', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  try {
    await internal.handleServerRequest(formRequest('form-1', {
      type: 'object',
      properties: {
        email: { type: 'string', title: 'Email', format: 'email', maxLength: 80 },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 5 },
        confirmed: { type: 'boolean', title: 'Confirmed', default: true },
        region: {
          type: 'string',
          title: 'Region',
          oneOf: [
            { const: 'us', title: 'United States' },
            { const: 'eu', title: 'Europe' },
          ],
        },
        scopes: {
          type: 'array',
          title: 'Scopes',
          minItems: 2,
          maxItems: 2,
          items: { type: 'string', enum: ['read', 'write', 'admin'] },
        },
      },
      required: ['email', 'count', 'confirmed', 'region', 'scopes'],
    }))
    assert.equal(messages.length, 6)
    const booleanSelect = rowComponents(messages[2]!)[0]
    assert.deepEqual(
      Array.isArray(booleanSelect?.options)
        ? booleanSelect.options.map((option) => (option as JsonObject).label)
        : [],
      ['True', 'False'],
    )
    assert.equal(rowComponents(messages[4]!)[0]?.min_values, 2)
    assert.equal(rowComponents(messages[4]!)[0]?.max_values, 2)
    const [key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    const followUps: string[] = []

    await internal.handleMcpElicitationModal(modalInteraction(
      `mcp-elicit-modal:${key}:0`,
      'not-an-email',
      followUps,
    ))
    assert.match(followUps.at(-1) || '', /valid email address/)
    await internal.handleMcpElicitationModal(modalInteraction(
      `mcp-elicit-modal:${key}:0`,
      'dev@example.com',
      followUps,
    ))
    await internal.handleMcpElicitationModal(modalInteraction(
      `mcp-elicit-modal:${key}:1`,
      '8',
      followUps,
    ))
    assert.match(followUps.at(-1) || '', /at most 5/)
    await internal.handleMcpElicitationModal(modalInteraction(
      `mcp-elicit-modal:${key}:1`,
      '4',
      followUps,
    ))
    await internal.handleMcpElicitationSelect(selectInteraction(
      `mcp-elicit-select:${key}:3`,
      ['option:1'],
      followUps,
    ))
    await internal.handleMcpElicitationSelect(selectInteraction(
      `mcp-elicit-select:${key}:4`,
      ['option:0', 'option:1'],
      followUps,
    ))

    assert.deepEqual(Object.fromEntries(Object.entries(
      internal.pendingMcpElicitations.get(key)?.content || {},
    )), {
      confirmed: true,
      email: 'dev@example.com',
      count: 4,
      region: 'eu',
      scopes: ['read', 'write'],
    })
    assert.match(messages[0]?.content || '', /Current: _Recorded_/)
    assert.doesNotMatch(messages[0]?.content || '', /dev@example\.com/)
    assert.match(messages[1]?.content || '', /Current: _Recorded_/)
    assert.doesNotMatch(messages[1]?.content || '', /Current:.*4/)
    await internal.handleButton(buttonInteraction(`mcp-elicit-action:${key}:submit`))
    assert.deepEqual(codex.responses, [{
      id: 'form-1',
      result: {
        action: 'accept',
        content: {
          confirmed: true,
          email: 'dev@example.com',
          count: 4,
          region: 'eu',
          scopes: ['read', 'write'],
        },
        _meta: null,
      },
    }])
    assert.equal(internal.pendingMcpElicitations.size, 0)
  } finally {
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Test ended._')
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('URL elicitations decline unsafe links and accept completed HTTPS flows', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  const request = (id: string, url: string): ServerRequest => ({
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      serverName: 'github',
      mode: 'url',
      _meta: null,
      message: 'Finish sign-in',
      url,
      elicitationId: 'github-auth-1',
    },
  })
  try {
    await internal.handleServerRequest(request('url-unsafe', 'http://example.com/finish'))
    assert.deepEqual(codex.responses, [{
      id: 'url-unsafe',
      result: { action: 'decline', content: null, _meta: null },
    }])
    assert.equal(internal.pendingMcpElicitations.size, 0)

    await internal.handleServerRequest(request('url-safe', 'https://example.com/finish'))
    const actionMessage = messages.at(-1)
    assert.ok(actionMessage)
    const components = rowComponents(actionMessage)
    assert.equal(components[0]?.style, ButtonStyle.Primary)
    assert.equal(components[0]?.url, undefined)
    assert.equal(components[1]?.label, 'I finished')
    const [key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    assert.equal(components[0]?.custom_id, `mcp-elicit-action:${key}:open`)
    let accessChecked = false
    internal.requireAccess = async () => {
      accessChecked = true
      return true
    }
    const linkReplies: string[] = []
    const linkPayloads: Array<{ content: string; ephemeral?: boolean }> = []
    await internal.handleButton(buttonInteraction(
      `mcp-elicit-action:${key}:open`,
      linkReplies,
      linkPayloads,
    ))
    assert.equal(accessChecked, true)
    assert.deepEqual(linkReplies, ['Open this link: <https://example.com/finish>'])
    assert.equal(linkPayloads[0]?.ephemeral, true)
    assert.equal(codex.responses.length, 1)
    await internal.handleButton(buttonInteraction(`mcp-elicit-action:${key}:accept`))
    assert.deepEqual(codex.responses.at(-1), {
      id: 'url-safe',
      result: { action: 'accept', content: null, _meta: null },
    })
  } finally {
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Test ended._')
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('tool approvals split complete disclosure and decline requests beyond the chunk budget', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  try {
    const tail = 'complete-tail-marker'
    await internal.handleServerRequest(formRequest('approval-split', {
      type: 'object',
      properties: {},
    }, {
      codex_approval_kind: 'mcp_tool_call',
      tool_params: {
        first: 'a'.repeat(2_200),
        second: `b${tail}`,
      },
    }))
    assert.ok(messages.length > 1)
    assert.match(messages.map((message) => message.content).join('\n'), new RegExp(tail))
    assert.equal(codex.responses.length, 0)
    assert.equal(internal.pendingMcpElicitations.size, 1)
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Replaced._')

    await internal.handleServerRequest(formRequest('approval-too-large', {
      type: 'object',
      properties: {},
    }, {
      codex_approval_kind: 'mcp_tool_call',
      tool_params: { payload: 'x'.repeat(30_000) },
    }))
    assert.deepEqual(codex.responses.at(-1), {
      id: 'approval-too-large',
      result: { action: 'decline', content: null, _meta: null },
    })
    assert.equal(internal.pendingMcpElicitations.size, 0)
    assert.match(messages.at(-1)?.content || '', /complete tool parameters were too large/)
  } finally {
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Test ended._')
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('Discord MCP forms round-trip an own __proto__ field without exposing its value', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  try {
    await internal.handleServerRequest(formRequest(
      'proto-form',
      JSON.parse(`{
        "type": "object",
        "properties": { "__proto__": { "type": "string", "title": "Prototype" } },
        "required": ["__proto__"]
      }`),
    ))
    const [key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    const pending = internal.pendingMcpElicitations.get(key)
    assert.ok(pending)
    assert.equal(Object.getPrototypeOf(pending.content), null)

    await internal.handleMcpElicitationModal(modalInteraction(
      `mcp-elicit-modal:${key}:0`,
      'round-trip-secret',
      [],
    ))
    assert.equal(Object.hasOwn(pending.content, '__proto__'), true)
    assert.equal(pending.content.__proto__, 'round-trip-secret')
    assert.match(messages[0]?.content || '', /Current: _Recorded_/)
    assert.doesNotMatch(messages[0]?.content || '', /round-trip-secret/)

    await internal.handleButton(buttonInteraction(`mcp-elicit-action:${key}:submit`))
    const result = codex.responses.at(-1)?.result as {
      content?: Record<string, unknown>
    }
    assert.ok(result.content)
    assert.equal(Object.hasOwn(result.content, '__proto__'), true)
    assert.equal(result.content.__proto__, 'round-trip-secret')
  } finally {
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Test ended._')
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('arbitrary OpenAI MCP forms remain unadvertised and are declined', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  try {
    await internal.handleServerRequest({
      id: 'openai-form',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        serverName: 'custom',
        mode: 'openai/form',
        _meta: null,
        message: 'Choose an image',
        requestedSchema: { type: 'openai/imagePicker' },
      },
    })
    assert.deepEqual(codex.responses, [{
      id: 'openai-form',
      result: { action: 'decline', content: null, _meta: null },
    }])
    assert.equal(messages.length, 0)
    assert.equal(internal.pendingMcpElicitations.size, 0)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('MCP expiry and pending-control cleanup cannot resolve a request twice', async () => {
  const { bot, internal, codex, messages, typingTimer } = harness()
  const schema = { type: 'object', properties: {} }
  try {
    await internal.handleServerRequest(formRequest('expires', schema))
    let [key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    assert.equal(await internal.expireMcpElicitation(key), true)
    assert.equal(await internal.expireMcpElicitation(key), false)
    assert.deepEqual(codex.responses, [{
      id: 'expires',
      result: { action: 'cancel', content: null, _meta: null },
    }])

    await internal.handleServerRequest(formRequest('external', schema))
    ;[key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    await internal.handleNotification({
      method: 'serverRequest/resolved',
      params: {
        requestId: 'external',
        threadId: 'codex-thread-1',
      },
    })
    assert.equal(await internal.expireMcpElicitation(key), false)
    assert.equal(codex.responses.length, 1)
    assert.match(messages.at(-1)?.edits.at(-1)?.content || '', /Resolved elsewhere/)

    await internal.handleServerRequest(formRequest('turn-ended', schema))
    ;[key] = internal.pendingMcpElicitations.keys()
    assert.ok(key)
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Turn ended._')
    assert.equal(await internal.expireMcpElicitation(key), false)
    assert.equal(codex.responses.length, 1)
    assert.equal(internal.pendingRequestControls.size, 0)
  } finally {
    await internal.dismissPendingControlsForChannel('discord-thread-1', '_Test ended._')
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})
