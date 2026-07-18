import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from '../src/codex-app-server.js'
import type {
  CodexAppServerReadyEvent,
  CodexAppServerRestartEvent,
} from '../src/codex-app-server.js'
import type {
  DynamicToolSpec,
  ServerNotification,
  ServerRequest,
  UserInput,
} from '../src/types.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs')
const restartFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'restarting-codex.mjs',
)

const dynamicTools: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'fixture_action',
    description: 'Execute a fixture action.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

test('Codex app-server validates RPC watchdog timeouts before spawning', () => {
  assert.throws(
    () => new CodexAppServer({ initializeTimeoutMs: 0 }),
    /initializeTimeoutMs must be an integer >= 1/,
  )
  assert.throws(
    () => new CodexAppServer({ requestTimeoutMs: 1.5 }),
    /requestTimeoutMs must be an integer >= 1/,
  )
})

test('Codex app-server client covers thread, turn, stream, model, steer, interrupt', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  const notification = new Promise<ServerNotification>((resolve) => {
    codex.once('notification', resolve)
  })
  try {
    const thread = await codex.startThread({
      cwd: process.cwd(),
      model: 'gpt-test',
      serviceTier: 'fast',
      dynamicTools,
      runtimeWorkspaceRoots: [process.cwd()],
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    assert.deepEqual(thread, { threadId: 'thread-1', model: 'gpt-test' })
    assert.deepEqual(await codex.request('fixture/threadStartParams', {}), {
      cwd: process.cwd(),
      model: 'gpt-test',
      serviceTier: 'fast',
      dynamicTools,
      runtimeWorkspaceRoots: [process.cwd()],
      sandbox: 'workspace-write',
      permissions: null,
      approvalPolicy: 'on-request',
    })
    const resumed = await codex.resumeThread({
      threadId: thread.threadId,
      includeTurns: true,
      cwd: process.cwd(),
      model: thread.model,
      runtimeWorkspaceRoots: [process.cwd()],
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    assert.equal(resumed.model, 'gpt-test')
    assert.equal(resumed.effort, 'medium')
    assert.equal(resumed.serviceTier, 'priority')
    assert.equal(resumed.name, 'Fixture resumed thread')
    assert.equal(resumed.turns[0]?.items[0]?.type, 'userMessage')
    assert.deepEqual(await codex.request('fixture/threadResumeParams', {}), {
      threadId: thread.threadId,
      cwd: process.cwd(),
      model: thread.model,
      runtimeWorkspaceRoots: [process.cwd()],
      sandbox: 'workspace-write',
      permissions: null,
      approvalPolicy: 'on-request',
      initialTurnsPage: {
        limit: 30,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    })
    await codex.updateThreadSettings({ threadId: thread.threadId, effort: 'max' })
    assert.deepEqual(await codex.request('fixture/threadSettingsParams', {}), {
      threadId: thread.threadId,
      effort: 'max',
    })
    const fork = await codex.forkThread({
      threadId: thread.threadId,
      cwd: process.cwd(),
      model: thread.model,
      runtimeWorkspaceRoots: [process.cwd()],
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    assert.deepEqual(fork, { threadId: 'thread-fork', model: 'gpt-test' })
    await codex.compactThread(thread.threadId)
    await codex.deleteThread('empty-fixture-thread')
    await codex.setThreadName(thread.threadId, 'Fixture')
    const goal = await codex.setThreadGoal(thread.threadId, {
      objective: 'Ship fixture',
      tokenBudget: 1_000,
      status: 'paused',
    })
    assert.equal(goal.objective, 'Ship fixture')
    assert.equal(goal.status, 'paused')
    assert.equal((await codex.getThreadGoal(thread.threadId))?.tokenBudget, 1_000)
    const revisedGoal = await codex.setThreadGoal(thread.threadId, { objective: 'Ship revised fixture' })
    assert.equal(revisedGoal.objective, 'Ship revised fixture')
    assert.equal(revisedGoal.status, 'paused')
    assert.equal(revisedGoal.tokenBudget, 1_000)
    const activatedGoal = await codex.setThreadGoal(thread.threadId, { status: 'active' })
    assert.equal(activatedGoal.objective, 'Ship revised fixture')
    assert.equal(activatedGoal.status, 'active')
    assert.equal(activatedGoal.tokenBudget, 1_000)
    assert.equal(await codex.clearThreadGoal(thread.threadId), true)
    assert.equal(await codex.getThreadGoal(thread.threadId), null)
    await codex.updateThreadSettings({
      threadId: thread.threadId,
      model: 'gpt-test',
      effort: 'high',
      serviceTier: 'fast',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    assert.deepEqual(await codex.request('fixture/threadSettingsParams', {}), {
      threadId: thread.threadId,
      model: 'gpt-test',
      effort: 'high',
      serviceTier: 'fast',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
    })
    const review = await codex.startReview({
      threadId: thread.threadId,
      target: { type: 'custom', instructions: 'Check fixture' },
    })
    assert.deepEqual(review, { turnId: 'review-turn', reviewThreadId: thread.threadId })
    await codex.rollbackThread(thread.threadId, 1)
    assert.equal((await codex.listThreads({ cwd: process.cwd() }))[0]?.id, 'thread-1')
    assert.deepEqual(await codex.getThreadSummary(thread.threadId), {
      id: thread.threadId,
      name: 'Fixture thread',
      preview: 'Fixture thread preview',
      cwd: process.cwd(),
      updatedAt: 1,
    })
    assert.equal((await codex.listThreadTurns(thread.threadId))[0]?.id, 'history-turn')
    assert.deepEqual(await codex.getThreadRuntimeState(thread.threadId), {
      status: 'active',
      activeTurnId: 'turn-with-subagents',
      activeFlags: ['waitingOnApproval'],
      userMessageClientIds: ['fixture-client-message'],
    })
    assert.deepEqual(await codex.getThreadRuntimeState('thread-idle'), { status: 'idle' })
    assert.deepEqual(await codex.getThreadRuntimeState('thread-not-loaded'), { status: 'notLoaded' })
    assert.deepEqual(await codex.getThreadRuntimeState('thread-system-error'), {
      status: 'systemError',
    })
    assert.deepEqual(await codex.listSubagentThreads(thread.threadId), [
      {
        threadId: 'subagent-2',
        agentPath: '/root/parity_review',
        activity: 'started',
      },
      {
        threadId: 'subagent-1',
        agentPath: '/root/protocol_gap_audit',
        prompt: 'Inspect protocol gaps',
        status: 'completed',
        activity: 'interacted',
      },
    ])
    const request = new Promise<{ id: string | number; method: string }>((resolve) => {
      codex.once('serverRequest', resolve)
    })
    const turnId = await codex.startTurn({
      threadId: thread.threadId,
      input: [{ type: 'text', text: 'ping', text_elements: [] }],
      model: thread.model,
      effort: 'high',
      serviceTier: 'fast',
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      runtimeWorkspaceRoots: [process.cwd()],
    })
    assert.equal(turnId, 'turn-1')
    assert.deepEqual(await codex.request('fixture/turnStartParams', {}), {
      threadId: thread.threadId,
      input: [{ type: 'text', text: 'ping', text_elements: [] }],
      model: thread.model,
      effort: 'high',
      serviceTier: 'fast',
      sandboxPolicy: { type: 'dangerFullAccess' },
      approvalPolicy: 'never',
      runtimeWorkspaceRoots: [process.cwd()],
      collaborationMode: null,
      clientUserMessageId: null,
    })
    const serverRequest = await request
    assert.equal(serverRequest.method, 'item/commandExecution/requestApproval')
    codex.respond(serverRequest.id, { decision: 'accept' })
    assert.equal((await notification).method, 'item/agentMessage/delta')
    await codex.steerTurn({
      threadId: thread.threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: 'more', text_elements: [] }],
    })
    await codex.interruptTurn(thread.threadId, turnId)
    const models = await codex.listModels()
    assert.equal(models[0]?.model, 'gpt-test')
    assert.equal(models[0]?.isDefault, true)
    assert.deepEqual(await codex.fuzzyFileSearch([process.cwd()], 'fixture'), [
      {
        root: process.cwd(),
        path: 'src/fixture.ts',
        fileName: 'fixture.ts',
        score: 100,
      },
    ])
    assert.equal((await codex.listPermissionProfiles(process.cwd()))[0]?.id, ':read-only')
    assert.equal((await codex.listSkills(process.cwd()))[0]?.skills !== undefined, true)
    assert.equal((await codex.listMcpServers(thread.threadId))[0]?.name, 'fixture-mcp')
    assert.deepEqual(await codex.listConfiguredMcpServers(process.cwd()), [
      {
        name: 'fixture-mcp',
        enabled: true,
        scope: 'global',
        globalConfigurable: true,
        filePath: '/tmp/fixture-config.toml',
      },
      {
        name: 'project-mcp',
        enabled: true,
        scope: 'project',
        globalConfigurable: false,
      },
    ])
    assert.deepEqual(await codex.setMcpServerEnabled('fixture-mcp', false, process.cwd()), {
      status: 'ok',
      filePath: '/tmp/fixture-config.toml',
      effectiveEnabled: false,
    })
    assert.deepEqual(await codex.listConfiguredMcpServers(process.cwd()), [
      {
        name: 'fixture-mcp',
        enabled: false,
        scope: 'global',
        globalConfigurable: true,
        filePath: '/tmp/fixture-config.toml',
      },
      {
        name: 'project-mcp',
        enabled: true,
        scope: 'project',
        globalConfigurable: false,
      },
    ])
    await assert.rejects(
      codex.setMcpServerEnabled('project-mcp', false, process.cwd()),
      /project-scoped/,
    )
    await codex.setMcpServerEnabled('fixture-mcp', true, process.cwd())
    assert.equal(await codex.loginMcpServer('fixture-mcp', thread.threadId), 'https://example.test/mcp-login')
    assert.deepEqual(await codex.getAuthStatus(), {
      authMethod: 'apikey',
      hasToken: true,
      requiresOpenaiAuth: false,
    })
    assert.deepEqual(await codex.getAccount(), { type: 'apiKey' })
    assert.equal((await codex.getAccountRateLimits()).rateLimits !== undefined, true)
    assert.equal((await codex.getAccountUsage()).summary !== undefined, true)
    assert.deepEqual(await codex.startAccountLogin('chatgpt'), {
      type: 'chatgpt',
      loginId: 'fixture-login',
      authUrl: 'https://example.test/oauth',
    })
    assert.deepEqual(await codex.startAccountLogin('chatgptDeviceCode'), {
      type: 'chatgptDeviceCode',
      loginId: 'fixture-login',
      verificationUrl: 'https://example.test/device',
      userCode: 'ABCD-EFGH',
    })
    await codex.cancelAccountLogin('fixture-login')
  } finally {
    await codex.close()
  }
})

test('Codex app-server parses stable model catalog metadata conservatively', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  try {
    await codex.request('fixture/threadStartParams', {})
    let page = 0
    codex.request = async (method, params) => {
      assert.equal(method, 'model/list')
      if (page++ === 0) {
        assert.deepEqual(params, { cursor: null, limit: 100 })
        return {
          data: [
            {
              id: 'gpt-rich',
              model: 'gpt-rich',
              displayName: 'GPT Rich',
              description: 'Rich catalog metadata',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'max',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Faster answers' },
                { reasoningEffort: 'max', description: 'Maximum reasoning' },
                { reasoningEffort: 'future', description: 'Unknown effort' },
                { reasoningEffort: 'high', description: 42 },
              ],
              serviceTiers: [
                { id: 'standard', name: 'Standard', description: 'Standard latency' },
                { id: 'fast', name: 'Fast', description: 'Lower latency' },
                { id: 'broken', name: 'Broken' },
              ],
              defaultServiceTier: 'standard',
              inputModalities: ['text', 'image', 'audio'],
            },
            { id: 'invalid-model-without-slug' },
          ],
          nextCursor: 'page-2',
        }
      }

      assert.deepEqual(params, { cursor: 'page-2', limit: 100 })
      return {
        data: [
          {
            id: 'gpt-fallback',
            model: 'gpt-fallback',
            displayName: 42,
            description: null,
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: 'future',
            supportedReasoningEfforts: [{ reasoningEffort: 'future', description: 'Unknown' }],
            serviceTiers: 'fast',
            defaultServiceTier: 42,
            inputModalities: ['audio'],
          },
        ],
        nextCursor: null,
      }
    }

    assert.deepEqual(await codex.listModels(), [
      {
        id: 'gpt-rich',
        model: 'gpt-rich',
        displayName: 'GPT Rich',
        description: 'Rich catalog metadata',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'max',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Faster answers' },
          { reasoningEffort: 'max', description: 'Maximum reasoning' },
        ],
        serviceTiers: [
          { id: 'standard', name: 'Standard', description: 'Standard latency' },
          { id: 'fast', name: 'Fast', description: 'Lower latency' },
        ],
        defaultServiceTier: 'standard',
        inputModalities: ['text', 'image'],
      },
      {
        id: 'gpt-fallback',
        model: 'gpt-fallback',
        displayName: 'gpt-fallback',
        description: '',
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: 'medium',
      },
    ])
    assert.equal(page, 2)
  } finally {
    await codex.close()
  }
})

test('Codex app-server supports reversible archive lifecycle and archived thread listing', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  try {
    await codex.archiveThread('thread-archived')
    assert.deepEqual(await codex.unarchiveThread('thread-archived'), {
      id: 'thread-archived',
      preview: 'fixture unarchived preview',
      name: 'Fixture unarchived thread',
      cwd: process.cwd(),
      updatedAt: 2,
    })
    await assert.rejects(
      codex.unarchiveThread('missing-thread-response'),
      /Codex thread\/unarchive omitted a valid thread/,
    )

    assert.equal((await codex.listThreads())[0]?.id, 'thread-1')
    assert.deepEqual(await codex.request('fixture/threadListParams', {}), {
      limit: 25,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cwd: null,
      searchTerm: null,
      archived: false,
    })

    assert.equal((await codex.listThreads({
      cwd: process.cwd(),
      searchTerm: 'fixture',
      limit: 10,
      archived: true,
    }))[0]?.id, 'thread-archived')
    assert.deepEqual(await codex.request('fixture/threadListParams', {}), {
      limit: 10,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cwd: process.cwd(),
      searchTerm: 'fixture',
      archived: true,
    })

    assert.deepEqual(
      (await codex.listAllThreads({ searchTerm: 'paginated lifecycle' }))
        .map((thread) => thread.id),
      ['thread-page-1', 'thread-page-2'],
    )
    assert.deepEqual(await codex.request('fixture/threadListParams', {}), {
      cursor: 'fixture-next-page',
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      cwd: null,
      searchTerm: 'paginated lifecycle',
      archived: false,
    })
  } finally {
    await codex.close()
  }
})

test('Codex app-server exposes native skill input and the typed skills/list protocol', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  try {
    const skillInput: UserInput[] = [
      {
        type: 'skill',
        name: 'fixture-skill',
        path: `${process.cwd()}/skills/fixture/SKILL.md`,
      },
    ]
    const serverRequest = once(codex, 'serverRequest') as Promise<[ServerRequest]>
    assert.equal(
      await codex.startTurn({ threadId: 'thread-1', input: skillInput }),
      'turn-1',
    )
    assert.deepEqual(await codex.request('fixture/turnStartParams', {}), {
      threadId: 'thread-1',
      input: skillInput,
      model: null,
      effort: null,
      runtimeWorkspaceRoots: null,
      collaborationMode: null,
      clientUserMessageId: null,
    })
    const [request] = await serverRequest
    codex.respond(request.id, { decision: 'accept' })
    await codex.steerTurn({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: skillInput,
    })
    assert.deepEqual(await codex.request('fixture/turnSteerParams', {}), {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: skillInput,
      clientUserMessageId: null,
    })

    const otherCwd = path.join(process.cwd(), 'other-workspace')
    const entries = await codex.listSkills({
      cwds: [process.cwd(), otherCwd],
      forceReload: true,
    })
    assert.deepEqual(entries, [
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
            interface: { displayName: 'Nullable Skill' },
            dependencies: {
              tools: [{ type: 'mcp', value: 'nullable-tool' }],
            },
            path: `${process.cwd()}/skills/nullable/SKILL.md`,
            scope: 'user',
            enabled: true,
          },
          {
            name: 'null-containers-skill',
            description: 'Fixture null containers',
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
    ])
    assert.deepEqual(await codex.request('fixture/skillsListParams', {}), {
      cwds: [process.cwd(), otherCwd],
      forceReload: true,
    })

    await codex.listSkills({ cwds: [process.cwd()] })
    assert.deepEqual(await codex.request('fixture/skillsListParams', {}), {
      cwds: [process.cwd()],
    })

    await codex.listSkills(process.cwd())
    assert.deepEqual(await codex.request('fixture/skillsListParams', {}), {
      cwds: [process.cwd()],
      forceReload: false,
    })

    await codex.listSkills()
    assert.deepEqual(await codex.request('fixture/skillsListParams', {}), {
      cwds: [],
      forceReload: false,
    })
  } finally {
    await codex.close()
  }
})

test('Codex app-server exposes stable skill, hook, plugin, marketplace, and account RPCs', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  const pluginInterface = {
    displayName: 'Fixture Plugin',
    shortDescription: 'Fixture short description',
    longDescription: 'Fixture long description',
    developerName: 'Fixture Developer',
    category: 'developer-tools',
    capabilities: ['tools'],
    websiteUrl: 'https://example.test/plugin',
    privacyPolicyUrl: null,
    termsOfServiceUrl: null,
    defaultPrompt: ['Run fixture'],
    brandColor: '#123456',
    composerIcon: '/tmp/fixture/icon.png',
    composerIconUrl: null,
    logo: '/tmp/fixture/logo.png',
    logoDark: null,
    logoUrl: null,
    logoUrlDark: null,
    screenshots: ['/tmp/fixture/screenshot.png'],
    screenshotUrls: [],
  }
  const pluginSummary = {
    id: 'fixture-plugin-id',
    remotePluginId: 'fixture-remote-id',
    version: '1.2.3',
    localVersion: '1.2.2',
    name: 'fixture-plugin',
    shareContext: {
      remotePluginId: 'fixture-remote-id',
      remoteVersion: '1.2.3',
      discoverability: 'PRIVATE',
      shareUrl: 'https://example.test/share',
      creatorAccountUserId: 'fixture-user',
      creatorName: 'Fixture User',
      sharePrincipals: [
        { principalType: 'workspace', principalId: 'workspace-1', role: 'reader', name: 'Workspace' },
      ],
    },
    source: {
      type: 'git',
      url: 'https://example.test/plugin.git',
      path: 'plugins/fixture',
      refName: 'main',
      sha: '0123456789abcdef',
    },
    installed: true,
    enabled: true,
    installPolicy: 'AVAILABLE',
    installPolicySource: 'WORKSPACE_SETTING',
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    interface: pluginInterface,
    keywords: ['fixture', 'testing'],
  }
  const marketplace = {
    name: 'fixture-marketplace',
    path: '/tmp/fixture-marketplace',
    interface: { displayName: 'Fixture Marketplace' },
    plugins: [pluginSummary],
  }
  const appSummary = {
    id: 'fixture-app',
    name: 'Fixture App',
    description: null,
    installUrl: 'https://example.test/install',
    category: 'testing',
  }
  const pluginDetail = {
    marketplaceName: 'fixture-marketplace',
    marketplacePath: '/tmp/fixture-marketplace',
    summary: pluginSummary,
    shareUrl: 'https://example.test/share',
    description: 'Fixture plugin detail',
    skills: [
      {
        name: 'fixture-skill',
        description: 'Fixture skill',
        shortDescription: null,
        interface: null,
        path: '/tmp/fixture/SKILL.md',
        enabled: true,
      },
    ],
    hooks: [{ key: 'fixture-hook', eventName: 'preToolUse' }],
    apps: [appSummary],
    appTemplates: [
      {
        templateId: 'fixture-template',
        name: 'Fixture Template',
        description: null,
        category: null,
        canonicalConnectorId: null,
        logoUrl: null,
        logoUrlDark: null,
        materializedAppIds: ['fixture-app'],
        reason: null,
      },
    ],
    mcpServers: ['fixture-mcp'],
  }
  const expectedCalls: Array<{ method: string; params: unknown; result: unknown }> = [
    {
      method: 'thread/inject_items',
      params: { threadId: 'thread-1', items: [{ type: 'message', role: 'user' }, 'marker'] },
      result: {},
    },
    {
      method: 'skills/config/write',
      params: { path: '/tmp/fixture/SKILL.md', enabled: false },
      result: { effectiveEnabled: false },
    },
    {
      method: 'skills/extraRoots/set',
      params: { extraRoots: ['/tmp/skills-one', '/tmp/skills-two'] },
      result: {},
    },
    {
      method: 'hooks/list',
      params: { cwds: [process.cwd()] },
      result: {
        data: [
          {
            cwd: process.cwd(),
            hooks: [
              {
                key: 'fixture-hook',
                eventName: 'preToolUse',
                handlerType: 'command',
                matcher: 'Bash',
                command: 'echo fixture',
                timeoutSec: 30,
                statusMessage: null,
                sourcePath: '/tmp/fixture/hooks.json',
                source: 'project',
                pluginId: null,
                displayOrder: -1,
                enabled: true,
                isManaged: false,
                currentHash: 'fixture-hash',
                trustStatus: 'trusted',
              },
            ],
            warnings: ['fixture warning'],
            errors: [{ path: '/tmp/broken-hook', message: 'fixture error' }],
          },
        ],
      },
    },
    {
      method: 'plugin/list',
      params: { cwds: [process.cwd()], marketplaceKinds: ['local'] },
      result: {
        marketplaces: [marketplace],
        marketplaceLoadErrors: [],
        featuredPluginIds: ['fixture-plugin-id'],
      },
    },
    {
      method: 'plugin/installed',
      params: { cwds: null, installSuggestionPluginNames: ['fixture-plugin'] },
      result: { marketplaces: [marketplace], marketplaceLoadErrors: [] },
    },
    {
      method: 'plugin/read',
      params: {
        marketplacePath: '/tmp/fixture-marketplace',
        pluginName: 'fixture-plugin',
      },
      result: { plugin: pluginDetail },
    },
    {
      method: 'plugin/skill/read',
      params: {
        remoteMarketplaceName: 'fixture-marketplace',
        remotePluginId: 'fixture-remote-id',
        skillName: 'fixture-skill',
      },
      result: { contents: '# Fixture skill' },
    },
    {
      method: 'plugin/install',
      params: { remoteMarketplaceName: 'fixture-marketplace', pluginName: 'fixture-plugin' },
      result: { authPolicy: 'ON_INSTALL', appsNeedingAuth: [appSummary] },
    },
    {
      method: 'plugin/uninstall',
      params: { pluginId: 'fixture-plugin-id' },
      result: {},
    },
    {
      method: 'marketplace/add',
      params: {
        source: 'https://example.test/marketplace.git',
        refName: 'main',
        sparsePaths: null,
      },
      result: {
        marketplaceName: 'fixture-marketplace',
        installedRoot: '/tmp/fixture-marketplace',
        alreadyAdded: false,
      },
    },
    {
      method: 'marketplace/remove',
      params: { marketplaceName: 'fixture-marketplace' },
      result: {
        marketplaceName: 'fixture-marketplace',
        installedRoot: '/tmp/fixture-marketplace',
      },
    },
    {
      method: 'marketplace/upgrade',
      params: { marketplaceName: null },
      result: {
        selectedMarketplaces: ['fixture-marketplace'],
        upgradedRoots: ['/tmp/fixture-marketplace'],
        errors: [{ marketplaceName: 'broken-marketplace', message: 'fixture failure' }],
      },
    },
    { method: 'account/logout', params: undefined, result: {} },
    {
      method: 'account/workspaceMessages/read',
      params: undefined,
      result: {
        featureEnabled: true,
        messages: [
          {
            messageId: 'fixture-message',
            messageType: 'announcement',
            messageBody: 'Fixture announcement',
            createdAt: -100,
            archivedAt: null,
          },
        ],
      },
    },
  ]

  try {
    await codex.request('fixture/threadStartParams', {})
    codex.request = async (method, params) => {
      const expected = expectedCalls.shift()
      assert.ok(expected, `Unexpected Codex request ${method}`)
      assert.equal(method, expected.method)
      assert.deepEqual(params, expected.params)
      return expected.result
    }

    await codex.injectThreadItems('thread-1', [{ type: 'message', role: 'user' }, 'marker'])
    assert.deepEqual(await codex.writeSkillConfig({
      path: '/tmp/fixture/SKILL.md',
      enabled: false,
    }), { effectiveEnabled: false })
    await codex.setSkillsExtraRoots(['/tmp/skills-one', '/tmp/skills-two'])
    assert.deepEqual(await codex.listHooks({ cwds: [process.cwd()] }), [
      {
        cwd: process.cwd(),
        hooks: [
          {
            key: 'fixture-hook',
            eventName: 'preToolUse',
            handlerType: 'command',
            matcher: 'Bash',
            command: 'echo fixture',
            timeoutSec: 30n,
            statusMessage: null,
            sourcePath: '/tmp/fixture/hooks.json',
            source: 'project',
            pluginId: null,
            displayOrder: -1n,
            enabled: true,
            isManaged: false,
            currentHash: 'fixture-hash',
            trustStatus: 'trusted',
          },
        ],
        warnings: ['fixture warning'],
        errors: [{ path: '/tmp/broken-hook', message: 'fixture error' }],
      },
    ])
    assert.deepEqual(await codex.listPlugins({
      cwds: [process.cwd()],
      marketplaceKinds: ['local'],
    }), {
      marketplaces: [marketplace],
      marketplaceLoadErrors: [],
      featuredPluginIds: ['fixture-plugin-id'],
    })
    assert.deepEqual(await codex.listInstalledPlugins({
      cwds: null,
      installSuggestionPluginNames: ['fixture-plugin'],
    }), { marketplaces: [marketplace], marketplaceLoadErrors: [] })
    assert.deepEqual(await codex.readPlugin({
      marketplacePath: '/tmp/fixture-marketplace',
      pluginName: 'fixture-plugin',
    }), pluginDetail)
    assert.equal(await codex.readPluginSkill({
      remoteMarketplaceName: 'fixture-marketplace',
      remotePluginId: 'fixture-remote-id',
      skillName: 'fixture-skill',
    }), '# Fixture skill')
    assert.deepEqual(await codex.installPlugin({
      remoteMarketplaceName: 'fixture-marketplace',
      pluginName: 'fixture-plugin',
    }), { authPolicy: 'ON_INSTALL', appsNeedingAuth: [appSummary] })
    await codex.uninstallPlugin('fixture-plugin-id')
    assert.deepEqual(await codex.addMarketplace({
      source: 'https://example.test/marketplace.git',
      refName: 'main',
      sparsePaths: null,
    }), {
      marketplaceName: 'fixture-marketplace',
      installedRoot: '/tmp/fixture-marketplace',
      alreadyAdded: false,
    })
    assert.deepEqual(await codex.removeMarketplace('fixture-marketplace'), {
      marketplaceName: 'fixture-marketplace',
      installedRoot: '/tmp/fixture-marketplace',
    })
    assert.deepEqual(await codex.upgradeMarketplaces(), {
      selectedMarketplaces: ['fixture-marketplace'],
      upgradedRoots: ['/tmp/fixture-marketplace'],
      errors: [{ marketplaceName: 'broken-marketplace', message: 'fixture failure' }],
    })
    await codex.logoutAccount()
    assert.deepEqual(await codex.getAccountWorkspaceMessages(), {
      featureEnabled: true,
      messages: [
        {
          messageId: 'fixture-message',
          messageType: 'announcement',
          messageBody: 'Fixture announcement',
          createdAt: -100,
          archivedAt: null,
        },
      ],
    })
    assert.equal(expectedCalls.length, 0)
  } finally {
    await codex.close()
  }
})

test('Codex app-server rejects malformed stable management responses', async () => {
  const codex = new CodexAppServer({ command: process.execPath, args: [fixture] })
  try {
    await codex.request('fixture/threadStartParams', {})

    await assert.rejects(
      codex.writeSkillConfig(
        { enabled: true } as Parameters<CodexAppServer['writeSkillConfig']>[0],
      ),
      /exactly one of path or name/,
    )
    await assert.rejects(
      codex.readPlugin(
        { pluginName: 'fixture' } as Parameters<CodexAppServer['readPlugin']>[0],
      ),
      /exactly one of marketplacePath or remoteMarketplaceName/,
    )

    codex.request = async () => ({ effectiveEnabled: 'false' })
    await assert.rejects(
      codex.writeSkillConfig({ name: 'fixture', enabled: false }),
      /skills\/config\/write omitted effectiveEnabled/,
    )

    codex.request = async () => ({
      data: [{ cwd: process.cwd(), hooks: [{ enabled: true, isManaged: false }], warnings: [], errors: [] }],
    })
    await assert.rejects(codex.listHooks(), /hooks\/list hook returned an invalid key/)

    codex.request = async () => ({ marketplaces: [], marketplaceLoadErrors: [] })
    await assert.rejects(codex.listPlugins(), /plugin\/list featuredPluginIds/)

    codex.request = async () => ({ plugin: { marketplaceName: 'fixture' } })
    await assert.rejects(
      codex.readPlugin({ remoteMarketplaceName: 'fixture-marketplace', pluginName: 'fixture' }),
      /plugin\/read returned invalid/,
    )

    codex.request = async () => ({ featureEnabled: true, messages: [{
      messageId: 'fixture',
      messageType: 'headline',
      messageBody: 'Fixture',
      createdAt: Number.MAX_SAFE_INTEGER + 1,
      archivedAt: null,
    }] })
    await assert.rejects(
      codex.getAccountWorkspaceMessages(),
      /account workspace message createdAt returned an invalid timestamp/,
    )
  } finally {
    await codex.close()
  }
})

test('Codex app-server rejects failed RPCs and reinitializes a replacement child', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordex-app-server-restart-'))
  const statePath = path.join(directory, 'state.json')
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [restartFixture, statePath],
    restart: { maxAttempts: 3, initialDelayMs: 25, maxDelayMs: 100, resetAfterMs: 1_000 },
  })
  const readyEvents: CodexAppServerReadyEvent[] = []
  codex.on('ready', (event) => readyEvents.push(event))

  try {
    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 1 })
    const firstServerRequest = once(codex, 'serverRequest')
    await codex.request('fixture/serverRequest', {})
    const [staleRequest] = await firstServerRequest as [ServerRequest]

    const restarting = once(codex, 'restarting')
    const crashRejection = assert.rejects(
      codex.request('fixture/crash', {}),
      /Codex app-server exited \(23\)/,
    )
    const [restartEvent] = await restarting as [CodexAppServerRestartEvent]
    assert.equal(restartEvent.generation, 2)
    assert.equal(restartEvent.attempt, 1)
    assert.equal(restartEvent.delayMs, 25)
    assert.throws(() => codex.respond(99, {}), /Codex app-server is restarting/)
    await crashRejection

    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 2 })
    const secondServerRequest = once(codex, 'serverRequest')
    await codex.request('fixture/serverRequest', {})
    const [currentRequest] = await secondServerRequest as [ServerRequest]
    assert.equal(currentRequest.id, staleRequest.id)
    assert.throws(
      () => codex.respondTo(staleRequest, { decision: 'accept' }),
      /previous app-server generation/,
    )
    assert.throws(
      () => codex.respondTo(staleRequest, { decision: 'accept' }),
      /Unknown or already answered/,
    )
    codex.respondTo(currentRequest, { decision: 'accept' })
    assert.deepEqual(await codex.request('fixture/serverRequestResult', {}), {
      decision: 'accept',
    })
    assert.throws(
      () => codex.respondTo(currentRequest, { decision: 'accept' }),
      /Unknown or already answered/,
    )
    assert.equal(readyEvents.length, 2)
    assert.deepEqual(readyEvents.map((event) => event.generation), [1, 3])
    assert.equal(codex.generation, 3)
    assert.equal(readyEvents[1]?.restartAttempt, 1)
  } finally {
    await codex.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex app-server supervises a child that hangs during initialization', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordex-app-server-init-timeout-'))
  const statePath = path.join(directory, 'state.json')
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [restartFixture, statePath, 'hang-first-initialize'],
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 3_000,
    restart: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, resetAfterMs: 1_000 },
  })
  const restarts: CodexAppServerRestartEvent[] = []
  codex.on('restarting', (event) => restarts.push(event))

  try {
    const restarting = once(codex, 'restarting')
    const recoveredRequest = codex.request('fixture/ping', {})
    const [restartEvent] = await restarting as [CodexAppServerRestartEvent]
    assert.match(restartEvent.error.message, /Codex RPC initialize timed out after 2000ms/)
    assert.deepEqual(await recoveredRequest, { spawnCount: 2 })
    const recoveredGeneration = codex.generation
    await delay(250)
    assert.equal(codex.generation, recoveredGeneration)
    assert.equal(restarts.length, 1)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { spawnCount: number }
    assert.equal(state.spawnCount, 2)
  } finally {
    await codex.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex app-server times out a hung RPC and recovers on a replacement child', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordex-app-server-rpc-timeout-'))
  const statePath = path.join(directory, 'state.json')
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [restartFixture, statePath],
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 500,
    restart: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, resetAfterMs: 1_000 },
  })
  const restarts: CodexAppServerRestartEvent[] = []
  codex.on('restarting', (event) => restarts.push(event))

  try {
    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 1 })
    const restarting = once(codex, 'restarting')
    const timeoutRejection = assert.rejects(
      codex.request('fixture/hang', {}),
      /Codex RPC fixture\/hang timed out after 500ms/,
    )
    const [restartEvent] = await restarting as [CodexAppServerRestartEvent]
    assert.match(restartEvent.error.message, /fixture\/hang timed out after 500ms/)
    await timeoutRejection
    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 2 })
    const recoveredGeneration = codex.generation
    await delay(100)
    assert.equal(codex.generation, recoveredGeneration)
    assert.equal(restarts.length, 1)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { spawnCount: number }
    assert.equal(state.spawnCount, 2)
  } finally {
    await codex.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex app-server terminates a failed child before starting its replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordex-app-server-stdio-'))
  const statePath = path.join(directory, 'state.json')
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [restartFixture, statePath, 'ignore-term'],
    restart: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, resetAfterMs: 1_000 },
  })

  try {
    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 1 })
    const oldChild = codex.child
    const oldPid = oldChild.pid
    assert.notEqual(oldPid, undefined)
    const lifecycle: string[] = []
    const oldExit = new Promise<NodeJS.Signals | null>((resolve) => {
      oldChild.once('exit', (_code, signal) => {
        lifecycle.push('old-exit')
        resolve(signal)
      })
    })
    const restarting = once(codex, 'restarting')
    const replacementReady = new Promise<CodexAppServerReadyEvent>((resolve) => {
      codex.once('ready', (event: CodexAppServerReadyEvent) => {
        lifecycle.push('replacement-ready')
        resolve(event)
      })
    })

    oldChild.stdout.emit('error', new Error('forced stdout read failure'))
    const [restartEvent] = await restarting as [CodexAppServerRestartEvent]
    assert.equal(restartEvent.generation, 2)
    const signal = await oldExit
    const readyEvent = await replacementReady
    assert.equal(signal, 'SIGKILL')
    assert.equal(readyEvent.generation, 3)
    assert.deepEqual(lifecycle, ['old-exit', 'replacement-ready'])
    assert.notEqual(codex.child.pid, oldPid)
    assert.deepEqual(await codex.request('fixture/ping', {}), { spawnCount: 2 })
  } finally {
    await codex.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Codex app-server bounds spawn-error retries with exponential backoff', async () => {
  const command = path.join(os.tmpdir(), `missing-cordex-${process.pid}-${Date.now()}`)
  const codex = new CodexAppServer({
    command,
    restart: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, resetAfterMs: 1_000 },
  })
  const restarts: CodexAppServerRestartEvent[] = []
  codex.on('restarting', (event) => restarts.push(event))
  const failed = once(codex, 'failed')

  try {
    await assert.rejects(
      codex.request('fixture/ping', {}),
      /Codex app-server restart attempts exhausted after 2 attempts/,
    )
    const [failure] = await failed as [Error]
    assert.match(failure.message, /restart attempts exhausted/)
    assert.deepEqual(restarts.map(({ attempt, delayMs }) => ({ attempt, delayMs })), [
      { attempt: 1, delayMs: 1 },
      { attempt: 2, delayMs: 2 },
    ])
  } finally {
    await codex.close()
  }
})

test('Codex app-server close cancels a scheduled restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cordex-app-server-close-'))
  const statePath = path.join(directory, 'state.json')
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [restartFixture, statePath, 'crash-initialize'],
    restart: { maxAttempts: 3, initialDelayMs: 75, maxDelayMs: 100, resetAfterMs: 1_000 },
  })

  try {
    const restarting = once(codex, 'restarting')
    const pendingRejection = assert.rejects(
      codex.request('fixture/ping', {}),
      /Codex app-server is closed/,
    )
    await restarting
    await codex.close()
    await pendingRejection
    await delay(125)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { spawnCount: number }
    assert.equal(state.spawnCount, 1)
    await assert.rejects(codex.request('fixture/ping', {}), /Codex app-server is closed/)
  } finally {
    await codex.close()
    await rm(directory, { recursive: true, force: true })
  }
})
