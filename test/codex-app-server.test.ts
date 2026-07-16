import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from '../src/codex-app-server.js'
import type { DynamicToolSpec, ServerNotification } from '../src/types.js'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs')

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
    assert.equal(resumed.name, 'Fixture resumed thread')
    assert.equal(resumed.turns[0]?.items[0]?.type, 'userMessage')
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
    await codex.setThreadName(thread.threadId, 'Fixture')
    const goal = await codex.setThreadGoal(thread.threadId, 'Ship fixture', 1_000, 'paused')
    assert.equal(goal.objective, 'Ship fixture')
    assert.equal(goal.status, 'paused')
    assert.equal((await codex.getThreadGoal(thread.threadId))?.tokenBudget, 1_000)
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
    assert.equal((await codex.listThreadTurns(thread.threadId))[0]?.id, 'history-turn')
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
