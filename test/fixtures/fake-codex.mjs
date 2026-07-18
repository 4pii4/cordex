import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
let threadGoal = null
let mcpEnabled = true
let threadStartParams = null
let threadResumeParams = null
let threadSettingsParams = null
let threadListParams = null
let turnStartParams = null
let turnSteerParams = null
let skillsListParams = null
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
  } else if (message.method === 'fixture/threadResumeParams') {
    send({ id: message.id, result: threadResumeParams })
  } else if (message.method === 'fixture/threadSettingsParams') {
    send({ id: message.id, result: threadSettingsParams })
  } else if (message.method === 'fixture/threadListParams') {
    send({ id: message.id, result: threadListParams })
  } else if (message.method === 'fixture/turnStartParams') {
    send({ id: message.id, result: turnStartParams })
  } else if (message.method === 'fixture/turnSteerParams') {
    send({ id: message.id, result: turnSteerParams })
  } else if (message.method === 'fixture/skillsListParams') {
    send({ id: message.id, result: skillsListParams })
  } else if (message.method === 'thread/resume') {
    threadResumeParams = message.params
    send({ id: message.id, result: {
      thread: {
        id: message.params.threadId,
        name: 'Fixture resumed thread',
        preview: 'fixture history question',
      },
      model: 'gpt-test',
      reasoningEffort: 'medium',
      serviceTier: 'priority',
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
  } else if (message.method === 'thread/unarchive') {
    send({
      id: message.id,
      result: message.params.threadId === 'missing-thread-response'
        ? {}
        : {
            thread: {
              id: message.params.threadId,
              preview: 'fixture unarchived preview',
              name: 'Fixture unarchived thread',
              cwd: process.cwd(),
              updatedAt: 2,
            },
          },
    })
  } else if (message.method === 'thread/compact/start' || message.method === 'thread/name/set' || message.method === 'thread/archive' || message.method === 'thread/delete') {
    send({ id: message.id, result: {} })
  } else if (message.method === 'review/start') {
    send({ id: message.id, result: { turn: { id: 'review-turn' }, reviewThreadId: message.params.threadId } })
  } else if (message.method === 'thread/rollback') {
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } })
  } else if (message.method === 'thread/goal/set') {
    const previous = threadGoal
    threadGoal = {
      threadId: message.params.threadId,
      objective: message.params.objective ?? previous?.objective,
      status: message.params.status ?? previous?.status ?? 'active',
      tokenBudget: Object.hasOwn(message.params, 'tokenBudget')
        ? message.params.tokenBudget
        : previous?.tokenBudget,
      tokensUsed: previous?.tokensUsed ?? 12,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 3,
    }
    send({ id: message.id, result: { goal: threadGoal } })
  } else if (message.method === 'thread/goal/get') {
    send({ id: message.id, result: { goal: threadGoal } })
  } else if (message.method === 'thread/goal/clear') {
    const cleared = threadGoal !== null
    threadGoal = null
    send({ id: message.id, result: { cleared } })
  } else if (message.method === 'thread/list') {
    threadListParams = message.params
    const paginated = message.params.searchTerm === 'paginated lifecycle'
    const page = paginated && message.params.cursor === 'fixture-next-page' ? 2 : 1
    send({
      id: message.id,
      result: {
        data: [{
          id: paginated
            ? `thread-page-${page}`
            : message.params.archived ? 'thread-archived' : 'thread-1',
          preview: message.params.archived ? 'fixture archived preview' : 'fixture preview',
          cwd: process.cwd(),
          updatedAt: 1,
        }],
        nextCursor: paginated && page === 1 ? 'fixture-next-page' : null,
        backwardsCursor: null,
      },
    })
  } else if (message.method === 'thread/read') {
    const runtimeStatus = message.params.threadId === 'thread-idle'
      ? { type: 'idle' }
      : message.params.threadId === 'thread-not-loaded'
        ? { type: 'notLoaded' }
        : message.params.threadId === 'thread-system-error'
          ? { type: 'systemError' }
          : { type: 'active', activeFlags: ['waitingOnApproval'] }
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          name: 'Fixture thread',
          preview: 'Fixture thread preview',
          cwd: process.cwd(),
          updatedAt: 1,
          status: runtimeStatus,
          turns: runtimeStatus.type === 'active' ? [
            {
              id: 'turn-with-subagents',
              status: 'inProgress',
              items: [
                {
                  type: 'userMessage',
                  id: 'fixture-user-message',
                  clientId: 'fixture-client-message',
                  content: [{ type: 'text', text: 'Fixture prompt', text_elements: [] }],
                },
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
          ] : [],
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
  } else if (message.method === 'turn/steer') {
    turnSteerParams = message.params
    send({ id: message.id, result: {} })
  } else if (message.method === 'turn/interrupt') {
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
    skillsListParams = message.params
    send({
      id: message.id,
      result: {
        data: [
          {
            cwd: process.cwd(),
            skills: [
              {
                name: 'fixture-skill',
                description: 'Fixture skill',
                shortDescription: 'Fixture',
                interface: {
                  displayName: 'Fixture Skill',
                  shortDescription: 'Fixture interface',
                  iconSmall: `${process.cwd()}/skills/fixture/icon-small.png`,
                  iconLarge: `${process.cwd()}/skills/fixture/icon-large.png`,
                  brandColor: '#123456',
                  defaultPrompt: 'Run the fixture skill.',
                },
                dependencies: {
                  tools: [
                    {
                      type: 'mcp',
                      value: 'fixture-tool',
                      description: 'Fixture tool',
                      transport: 'stdio',
                      command: 'fixture-command',
                      url: 'https://example.test/fixture',
                    },
                  ],
                },
                path: `${process.cwd()}/skills/fixture/SKILL.md`,
                scope: 'repo',
                enabled: true,
              },
              {
                name: 'nullable-skill',
                description: 'Fixture null optionals',
                shortDescription: null,
                interface: {
                  displayName: 'Nullable Skill',
                  shortDescription: null,
                  iconSmall: null,
                  iconLarge: null,
                  brandColor: null,
                  defaultPrompt: null,
                },
                dependencies: {
                  tools: [
                    {
                      type: 'mcp',
                      value: 'nullable-tool',
                      description: null,
                      transport: null,
                      command: null,
                      url: null,
                    },
                  ],
                },
                path: `${process.cwd()}/skills/nullable/SKILL.md`,
                scope: 'user',
                enabled: true,
              },
              {
                name: 'null-containers-skill',
                description: 'Fixture null containers',
                shortDescription: null,
                interface: null,
                dependencies: null,
                path: `${process.cwd()}/skills/null-containers/SKILL.md`,
                scope: 'system',
                enabled: false,
              },
            ],
            errors: [
              {
                path: `${process.cwd()}/skills/broken/SKILL.md`,
                message: 'Fixture skill error',
              },
            ],
          },
        ],
      },
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
