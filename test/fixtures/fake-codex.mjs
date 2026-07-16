import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
let threadGoal = null
let mcpEnabled = true
let threadStartParams = null
let threadSettingsParams = null
let turnStartParams = null
const fixtureTurns = [
  {
    id: 'history-turn',
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    items: [
      {
        type: 'userMessage',
        id: 'history-user',
        clientId: null,
        content: [{ type: 'text', text: 'fixture history question', text_elements: [] }],
      },
      {
        type: 'agentMessage',
        id: 'history-agent',
        text: 'fixture history answer',
        phase: 'final',
        memoryCitation: null,
      },
    ],
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialized') return
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' } })
  } else if (message.method === 'thread/start') {
    threadStartParams = message.params
    send({
      id: message.id,
      result: { thread: { id: 'thread-1' }, model: message.params.model || 'gpt-test' },
    })
  } else if (message.method === 'fixture/threadStartParams') {
    send({ id: message.id, result: threadStartParams })
  } else if (message.method === 'fixture/threadSettingsParams') {
    send({ id: message.id, result: threadSettingsParams })
  } else if (message.method === 'fixture/turnStartParams') {
    send({ id: message.id, result: turnStartParams })
  } else if (message.method === 'thread/resume') {
    send({ id: message.id, result: {
      thread: {
        id: message.params.threadId,
        name: 'Fixture resumed thread',
        preview: 'fixture history question',
      },
      model: 'gpt-test',
      initialTurnsPage: message.params.initialTurnsPage
        ? { data: fixtureTurns, nextCursor: null, backwardsCursor: null }
        : null,
    } })
  } else if (message.method === 'thread/fork') {
    send({
      id: message.id,
      result: { thread: { id: 'thread-fork' }, model: message.params.model || 'gpt-test' },
    })
  } else if (message.method === 'thread/settings/update') {
    threadSettingsParams = message.params
    send({ id: message.id, result: {} })
  } else if (message.method === 'thread/compact/start' || message.method === 'thread/name/set' || message.method === 'thread/archive') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'review/start') {
    send({ id: message.id, result: { turn: { id: 'review-turn' }, reviewThreadId: message.params.threadId } })
  } else if (message.method === 'thread/rollback') {
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } })
  } else if (message.method === 'thread/goal/set') {
    threadGoal = {
      threadId: message.params.threadId,
      objective: message.params.objective,
      status: message.params.status || 'active',
      tokenBudget: message.params.tokenBudget,
      tokensUsed: 12,
      timeUsedSeconds: 3,
    }
    send({ id: message.id, result: { goal: threadGoal } })
  } else if (message.method === 'thread/goal/get') {
    send({ id: message.id, result: { goal: threadGoal } })
  } else if (message.method === 'thread/goal/clear') {
    const cleared = threadGoal !== null
    threadGoal = null
    send({ id: message.id, result: { cleared } })
  } else if (message.method === 'thread/list') {
    send({
      id: message.id,
      result: {
        data: [{ id: 'thread-1', preview: 'fixture preview', cwd: process.cwd(), updatedAt: 1 }],
        nextCursor: null,
        backwardsCursor: null,
      },
    })
  } else if (message.method === 'thread/read') {
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          turns: [
            {
              id: 'turn-with-subagents',
              items: [
                {
                  type: 'collabAgentToolCall',
                  id: 'spawn-1',
                  tool: 'spawnAgent',
                  status: 'completed',
                  senderThreadId: message.params.threadId,
                  receiverThreadIds: ['subagent-1'],
                  prompt: 'Inspect protocol gaps',
                  model: null,
                  reasoningEffort: null,
                  agentsStates: { 'subagent-1': { status: 'completed', message: null } },
                },
                {
                  type: 'subAgentActivity',
                  id: 'activity-1',
                  kind: 'interacted',
                  agentThreadId: 'subagent-1',
                  agentPath: '/root/protocol_gap_audit',
                },
                {
                  type: 'subAgentActivity',
                  id: 'activity-2',
                  kind: 'started',
                  agentThreadId: 'subagent-2',
                  agentPath: '/root/parity_review',
                },
                {
                  type: 'collabAgentToolCall',
                  id: 'peer-input',
                  tool: 'sendInput',
                  status: 'completed',
                  senderThreadId: message.params.threadId,
                  receiverThreadIds: ['unrelated-peer'],
                  prompt: 'Peer message',
                  model: null,
                  reasoningEffort: null,
                  agentsStates: {},
                },
              ],
            },
          ],
        },
      },
    })
  } else if (message.method === 'thread/turns/list') {
    send({
      id: message.id,
      result: { data: fixtureTurns, nextCursor: null, backwardsCursor: null },
    })
  } else if (message.method === 'turn/start') {
    turnStartParams = message.params
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    send({
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: message.params.threadId,
        turnId: 'turn-1',
        itemId: 'command-1',
        command: 'echo fixture',
      },
    })
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: message.params.threadId,
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: 'pong',
      },
    })
  } else if (message.id === 99) {
    send({ id: message.id, result: {} })
  } else if (message.method === 'turn/steer' || message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'model/list') {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: 'gpt-test',
            model: 'gpt-test',
            displayName: 'GPT Test',
            description: 'Fixture model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'high',
          },
        ],
        nextCursor: null,
      },
    })
  } else if (message.method === 'fuzzyFileSearch') {
    send({ id: message.id, result: {
      files: [
        {
          root: message.params.roots[0],
          path: 'src',
          match_type: 'directory',
          file_name: 'src',
          score: 200,
          indices: [0],
        },
        {
          root: message.params.roots[0],
          path: 'src/fixture.ts',
          match_type: 'file',
          file_name: 'fixture.ts',
          score: 100,
          indices: [4],
        },
      ],
    } })
  } else if (message.method === 'permissionProfile/list') {
    send({ id: message.id, result: {
      data: [
        { id: ':read-only', description: 'Read only', allowed: true },
        { id: ':workspace', description: 'Workspace access', allowed: true },
      ],
      nextCursor: null,
    } })
  } else if (message.method === 'skills/list') {
    send({
      id: message.id,
      result: { data: [{ cwd: process.cwd(), skills: [{ name: 'fixture-skill', description: 'Fixture', enabled: true }], errors: [] }] },
    })
  } else if (message.method === 'mcpServerStatus/list') {
    send({
      id: message.id,
      result: { data: [{ name: 'fixture-mcp', tools: { ping: {} }, authStatus: 'unsupported' }], nextCursor: null },
    })
  } else if (message.method === 'config/read') {
    send({ id: message.id, result: {
      config: {
        mcp_servers: {
          'fixture-mcp': {
            command: 'fixture',
            enabled: mcpEnabled,
          },
          'project-mcp': {
            command: 'project-fixture',
            enabled: true,
          },
        },
      },
      origins: {},
      layers: message.params.includeLayers ? [
        {
          name: { type: 'user', file: '/tmp/fixture-config.toml', profile: null },
          version: 'fixture-version',
          config: {
            mcp_servers: {
              'fixture-mcp': {
                command: 'fixture',
                enabled: mcpEnabled,
              },
            },
          },
          disabledReason: null,
        },
        {
          name: { type: 'project', dotCodexFolder: '/tmp/project/.codex' },
          version: 'project-version',
          config: {
            mcp_servers: {
              'project-mcp': {
                command: 'project-fixture',
                enabled: true,
              },
            },
          },
          disabledReason: null,
        },
      ] : null,
    } })
  } else if (message.method === 'config/value/write') {
    mcpEnabled = message.params.value === true
    send({ id: message.id, result: {
      status: 'ok',
      version: 'fixture-version',
      filePath: '/tmp/fixture-config.toml',
      overriddenMetadata: null,
    } })
  } else if (message.method === 'config/mcpServer/reload') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'mcpServer/oauth/login') {
    send({ id: message.id, result: { authorizationUrl: 'https://example.test/mcp-login' } })
  } else if (message.method === 'getAuthStatus') {
    send({ id: message.id, result: { authMethod: 'apikey', authToken: 'fixture-secret', requiresOpenaiAuth: false } })
  } else if (message.method === 'account/login/start') {
    send({ id: message.id, result: message.params.type === 'chatgptDeviceCode'
      ? { type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://example.test/device', userCode: 'ABCD-EFGH' }
      : { type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://example.test/oauth' } })
  } else if (message.method === 'account/login/cancel') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: false } })
  } else if (message.method === 'account/rateLimits/read') {
    send({ id: message.id, result: {
      rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '42' }, individualLimit: null, planType: 'plus', rateLimitReachedType: null },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    } })
  } else if (message.method === 'account/usage/read') {
    send({ id: message.id, result: { summary: { lifetimeTokens: 1000, peakDailyTokens: 200, longestRunningTurnSec: 60, currentStreakDays: 3, longestStreakDays: 5 }, dailyUsageBuckets: null } })
  } else {
    send({ id: message.id, error: { code: -32601, message: 'Unknown method' } })
  }
})
