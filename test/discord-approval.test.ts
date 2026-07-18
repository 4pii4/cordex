import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  type ActionRowBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type ThreadChannel,
} from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  JsonObject,
  ServerRequest,
  SessionState,
} from '../src/types.js'

class FakeCodex extends EventEmitter {
  readonly responses: Array<{ id: string | number; result: unknown }> = []

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result })
  }
}

type SentPayload = {
  content: string
  components?: ActionRowBuilder<ButtonBuilder>[]
  allowedMentions?: { parse: string[] }
}

type FakeMessage = {
  content: string
  edits: Array<{ content: string; components: unknown[] }>
  edit(payload: { content: string; components: unknown[] }): Promise<FakeMessage>
}

type InternalBot = {
  runs: Map<string, unknown>
  approvals: Map<string, unknown>
  requireAccess(interaction: ButtonInteraction): Promise<boolean>
  handleServerRequest(request: ServerRequest): Promise<void>
  handleButton(interaction: ButtonInteraction): Promise<void>
}

function makeConfig(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { 'parent-1': { directory: process.cwd() } },
  }
}

function makeState(session: SessionState): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: { [session.discordThreadId]: session },
    queues: {},
    tasks: {},
  }
}

function makeHarness(): {
  bot: CordexDiscordBot
  internal: InternalBot
  codex: FakeCodex
  sent: SentPayload[]
  typingTimer: NodeJS.Timeout
} {
  const session: SessionState = {
    discordThreadId: 'discord-thread-1',
    parentChannelId: 'parent-1',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    activeTurnId: 'turn-1',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const sent: SentPayload[] = []
  const channel = {
    id: session.discordThreadId,
    isThread() {
      return true
    },
    async send(payload: SentPayload) {
      sent.push(payload)
      const message: FakeMessage = {
        content: payload.content,
        edits: [],
        async edit(update) {
          this.content = update.content
          this.edits.push(update)
          return this
        },
      }
      return message
    },
  } as unknown as ThreadChannel
  const codex = new FakeCodex()
  const bot = new CordexDiscordBot(makeConfig(), makeState(session), codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  internal.requireAccess = async () => true
  const typingTimer = setInterval(() => undefined, 60_000)
  typingTimer.unref()
  internal.runs.set(session.codexThreadId, {
    session,
    channel,
    model: 'fixture-model',
    effort: 'medium',
    turnId: 'turn-1',
    startedAt: Date.now(),
    agentText: new Map(),
    typingTimer,
  })
  return { bot, internal, codex, sent, typingTimer }
}

function buttonLabels(payload: SentPayload): string[] {
  return (payload.components ?? []).flatMap((row) =>
    row.components.map((button) => {
      const data = button.toJSON()
      return 'label' in data ? data.label : ''
    }))
}

function buttonId(payload: SentPayload, index: number): string {
  const button = (payload.components ?? []).flatMap((row) => row.components)[index]
  assert.ok(button)
  const data = button.toJSON()
  assert.ok('custom_id' in data && data.custom_id)
  return data.custom_id
}

async function clickApproval(
  internal: InternalBot,
  customId: string,
): Promise<Array<{ content: string; components: unknown[] }>> {
  const updates: Array<{ content: string; components: unknown[] }> = []
  await internal.handleButton({
    customId,
    user: {
      id: 'user-1',
      toString() {
        return '<@user-1>'
      },
    },
    async reply() {},
    async update(payload: { content: string; components: unknown[] }) {
      updates.push(payload)
    },
  } as unknown as ButtonInteraction)
  return updates
}

function modernCommandRequest(
  id: string,
  availableDecisions: unknown[],
): ServerRequest {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      command: 'curl https://api.example.test/data',
      cwd: '/workspace/project',
      reason: 'Needs managed network access',
      networkApprovalContext: { host: 'api.example.test', protocol: 'https' },
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: { read: ['/workspace/shared'], write: null },
      },
      proposedExecpolicyAmendment: ['curl', 'https://api.example.test/data'],
      proposedNetworkPolicyAmendments: [{ host: 'api.example.test', action: 'allow' }],
      availableDecisions,
    },
  }
}

test('modern command approvals render only offered decisions and pass structured decisions through', async () => {
  const { bot, internal, codex, sent, typingTimer } = makeHarness()
  const structuredDecision = {
    acceptWithExecpolicyAmendment: {
      execpolicy_amendment: ['curl', 'https://api.example.test/data'],
    },
  }
  try {
    await internal.handleServerRequest(modernCommandRequest(
      'approval-structured',
      ['decline', structuredDecision],
    ))

    const payload = sent.at(-1)
    assert.ok(payload)
    assert.deepEqual(buttonLabels(payload), ['Deny', 'Accept and Remember Command'])
    assert.deepEqual(payload.allowedMentions, { parse: [] })
    assert.match(payload.content, /\*\*Command:\*\* `curl https:\/\/api\.example\.test\/data`/)
    assert.match(payload.content, /\*\*Working directory:\*\* `\/workspace\/project`/)
    assert.match(payload.content, /\*\*Reason:\*\* `Needs managed network access`/)
    assert.match(payload.content, /\*\*Network context:\*\*/)
    assert.match(payload.content, /\*\*Additional permissions:\*\*/)
    assert.match(payload.content, /\*\*Proposed exec policy amendment:\*\*/)
    assert.match(payload.content, /\*\*Proposed network amendments:\*\*/)

    const updates = await clickApproval(internal, buttonId(payload, 1))
    assert.deepEqual(codex.responses, [{
      id: 'approval-structured',
      result: { decision: structuredDecision },
    }])
    assert.match(updates[0]?.content || '', /Approved and command policy updated by <@user-1>/)
    assert.equal(internal.approvals.size, 0)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('modern command approvals preserve network amendments and cancel decisions exactly', async () => {
  const { bot, internal, codex, sent, typingTimer } = makeHarness()
  const networkDecision = {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: 'api.example.test', action: 'deny' },
    },
  }
  try {
    await internal.handleServerRequest(modernCommandRequest('approval-network', [
      'accept',
      'acceptForSession',
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['curl', 'https://api.example.test/data'],
        },
      },
      networkDecision,
      'decline',
      'cancel',
    ]))
    const networkPayload = sent.at(-1)
    assert.ok(networkPayload)
    assert.deepEqual(networkPayload.components?.map((row) => row.components.length), [5, 1])
    assert.deepEqual(buttonLabels(networkPayload), [
      'Accept',
      'Accept for Session',
      'Accept and Remember Command',
      'Always Deny api.example.test',
      'Deny',
      'Deny and Stop',
    ])
    await clickApproval(internal, buttonId(networkPayload, 3))

    await internal.handleServerRequest(modernCommandRequest('approval-cancel', ['cancel']))
    const cancelPayload = sent.at(-1)
    assert.ok(cancelPayload)
    assert.deepEqual(buttonLabels(cancelPayload), ['Deny and Stop'])
    await clickApproval(internal, buttonId(cancelPayload, 0))

    assert.deepEqual(codex.responses, [
      { id: 'approval-network', result: { decision: networkDecision } },
      { id: 'approval-cancel', result: { decision: 'cancel' } },
    ])
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('approval expiry uses the configured timeout and continues Codex with denial', async () => {
  const { bot, internal, codex, typingTimer } = makeHarness()
  ;(bot as unknown as { config: CordexConfig }).config.approvalTimeoutMinutes = 0.001
  try {
    await internal.handleServerRequest(modernCommandRequest(
      'approval-timeout',
      ['accept', 'decline'],
    ))
    const pending = Array.from(internal.approvals.values())[0] as
      | { message: FakeMessage }
      | undefined
    assert.ok(pending)

    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepEqual(codex.responses, [{
      id: 'approval-timeout',
      result: { decision: 'decline' },
    }])
    assert.match(pending.message.edits.at(-1)?.content || '', /Approval expired/)
    assert.equal(internal.approvals.size, 0)
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})

test('legacy, permissions, and file approvals keep safe fallback choices', async () => {
  const { bot, internal, codex, sent, typingTimer } = makeHarness()
  const requests: Array<{ request: ServerRequest; expected: JsonObject; details: RegExp[] }> = [
    {
      request: {
        id: 'legacy-command',
        method: 'execCommandApproval',
        params: {
          conversationId: 'codex-thread-1',
          command: ['npm', 'test'],
          cwd: '/workspace/project',
          reason: 'Run verification',
        },
      },
      expected: { decision: 'approved_for_session' },
      details: [/\*\*Working directory:\*\*/, /\*\*Reason:\*\*/],
    },
    {
      request: {
        id: 'legacy-patch',
        method: 'applyPatchApproval',
        params: {
          conversationId: 'codex-thread-1',
          reason: 'Write generated files',
          grantRoot: '/workspace/generated',
          fileChanges: { '/workspace/generated/output.ts': { type: 'add' } },
        },
      },
      expected: { decision: 'approved_for_session' },
      details: [/\*\*Grant root:\*\*/, /\*\*Files:\*\*/],
    },
    {
      request: {
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'codex-thread-1',
          turnId: 'turn-1',
          cwd: '/workspace/project',
          reason: 'Read shared inputs',
          permissions: {
            network: null,
            fileSystem: { read: ['/workspace/shared'], write: null },
          },
        },
      },
      expected: {
        permissions: {
          fileSystem: { read: ['/workspace/shared'], write: null },
        },
        scope: 'session',
      },
      details: [/\*\*Working directory:\*\*/, /\*\*Requested permissions:\*\*/],
    },
    {
      request: {
        id: 'file-change',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'codex-thread-1',
          turnId: 'turn-1',
          reason: 'Write outside the current sandbox',
          grantRoot: '/workspace/generated',
        },
      },
      expected: { decision: 'acceptForSession' },
      details: [/\*\*Reason:\*\*/, /\*\*Grant root:\*\*/],
    },
  ]

  try {
    for (const { request, expected, details } of requests) {
      await internal.handleServerRequest(request)
      const payload = sent.at(-1)
      assert.ok(payload)
      assert.deepEqual(buttonLabels(payload), ['Accept', 'Accept Always', 'Deny'])
      for (const detail of details) assert.match(payload.content, detail)
      await clickApproval(internal, buttonId(payload, 1))
    }
    assert.deepEqual(codex.responses, requests.map(({ request, expected }) => ({
      id: request.id,
      result: expected,
    })))
  } finally {
    clearInterval(typingTimer)
    bot.client.destroy()
  }
})
