import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexAppServer } from '../src/codex-app-server.js'
import { isMcpToolApproval } from '../src/mcp-elicitation.js'
import type { ServerNotification, ServerRequest } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('real Codex reloads project MCP tools into an already-loaded thread', {
  skip: !process.env.CORDEX_MCP_RELOAD_TEST,
  timeout: 240_000,
}, async () => {
  const workspace = await mkdtemp(path.join(process.cwd(), '.cordex-mcp-reload-e2e-'))
  const fixturePath = path.resolve('test/fixtures/mcp-elicitation-server.mjs')
  const resultPath = path.join(workspace, 'mcp-result.json')
  const tracePath = path.join(workspace, 'mcp-trace.jsonl')
  const serverName = 'cordex_e2e_reload'
  const configPath = path.join(workspace, '.codex', 'config.toml')
  const projectConfig = (enabled: boolean) => [
    `[mcp_servers.${serverName}]`,
    'command = "node"',
    `args = ${JSON.stringify([fixturePath, resultPath, tracePath])}`,
    `enabled = ${enabled}`,
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 120',
    '',
  ].join('\n')
  await mkdir(path.join(workspace, '.codex'))
  await writeFile(configPath, projectConfig(false))
  const codex = new CodexAppServer()
  const requests: ServerRequest[] = []
  const completed = new Map<string, string>()
  const errors: string[] = []
  codex.on('serverRequest', (request: ServerRequest) => {
    requests.push(request)
    try {
      if (request.method === 'currentTime/read') {
        codex.respondTo(request, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      } else if (request.method === 'mcpServer/elicitation/request' && isMcpToolApproval(request.params._meta)) {
        codex.respondTo(request, { action: 'accept', content: null, _meta: null })
      } else if (request.method === 'mcpServer/elicitation/request' && request.params.mode === 'form') {
        codex.respondTo(request, {
          action: 'accept',
          content: {
            destination: 'Osaka',
            days: 4,
            pace: 'fast',
            activities: ['museum', 'hiking'],
            includeTravel: false,
          },
          _meta: null,
        })
      } else {
        errors.push(`Unexpected server request: ${request.method}`)
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  })
  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'turn/completed') return
    const turn = notification.params.turn
    if (typeof turn === 'object' && turn !== null && 'id' in turn && typeof turn.id === 'string' &&
      'status' in turn && typeof turn.status === 'string') {
      completed.set(turn.id, turn.status)
    }
  })
  let threadId = ''
  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    threadId = started.threadId
    const initiallyLoaded = await codex.listMcpServers(threadId)
    const initialServer = initiallyLoaded.find((server) => server.name === serverName)
    assert.equal(Boolean(initialServer && typeof initialServer.tools === 'object' &&
      initialServer.tools !== null && 'collect_trip_preferences' in initialServer.tools), false)
    const initialConfigured = await codex.listConfiguredMcpServers(workspace)
    assert.ok(initialConfigured.some((server) =>
      server.name === serverName && !server.enabled && server.scope === 'project'),
    JSON.stringify(initialConfigured.filter((server) => server.name === serverName)))
    await writeFile(configPath, projectConfig(true))
    const beforeTurnId = await codex.startTurn({
      threadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: `Check if the ${serverName} collect_trip_preferences MCP tool is available in this already-loaded thread. If it is unavailable, reply exactly reload-before-unavailable. Do not use other tools or edit files.`,
        text_elements: [],
      }],
    })
    await waitFor(() => completed.has(beforeTurnId), 'pre-reload turn completion')
    assert.equal(completed.get(beforeTurnId), 'completed')
    assert.equal(requests.filter((request) => request.method === 'mcpServer/elicitation/request').length, 0)

    await codex.reloadMcpServers()
    const configured = await codex.listConfiguredMcpServers(workspace)
    const effective = await codex.request('config/read', {
      cwd: workspace,
      includeLayers: true,
    }) as {
      config?: { projects?: Record<string, unknown> }
      layers?: Array<{ name?: { type?: string; dotCodexFolder?: string } }>
    }
    assert.ok(configured.some((server) => server.name === serverName && server.enabled && server.scope === 'project'),
      JSON.stringify({
        configured: configured.filter((server) => server.name === serverName),
        trust: effective.config?.projects?.[workspace] || null,
        projectLayers: effective.layers?.filter((layer) => layer.name?.type === 'project').map((layer) => layer.name),
      }))
    const afterTurnId = await codex.startTurn({
      threadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: `Now call the collect_trip_preferences MCP tool from ${serverName} exactly once. Wait for its form response, then reply exactly reload-after-done. Do not edit files.`,
        text_elements: [],
      }],
    })
    await waitFor(() => completed.has(afterTurnId), 'post-reload turn completion', 120_000)
    assert.equal(completed.get(afterTurnId), 'completed')
    assert.deepEqual(errors, [])
    const elicitationRequests = requests.filter((request) => request.method === 'mcpServer/elicitation/request')
    assert.ok(elicitationRequests.some((request) => isMcpToolApproval(request.params._meta)))
    assert.ok(elicitationRequests.some((request) => request.params.mode === 'form' &&
      !isMcpToolApproval(request.params._meta)))
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      clientSupportsElicitation: boolean
      action: string
      content: unknown
    }
    assert.equal(result.clientSupportsElicitation, true)
    assert.equal(result.action, 'accept')
    assert.deepEqual(result.content, {
      destination: 'Osaka',
      days: 4,
      pace: 'fast',
      activities: ['museum', 'hiking'],
      includeTravel: false,
    })

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-mcp-reload-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, `${JSON.stringify({
      scenario: 'project MCP server enabled after thread load and made callable by app-server reload',
      command: 'npm run test:live-mcp-reload',
      threadId,
      beforeTurnId,
      beforeStatus: completed.get(beforeTurnId),
      beforeElicitationRequests: 0,
      reloadCalled: true,
      projectScopedServer: serverName,
      afterTurnId,
      afterStatus: completed.get(afterTurnId),
      elicitationModes: elicitationRequests.map((request) => ({
        mode: request.params.mode,
        toolApproval: isMcpToolApproval(request.params._meta),
      })),
      result,
      completed: true,
    }, null, 2)}\n`, { mode: 0o600 })
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (threadId) await codex.archiveThread(threadId).catch(() => undefined)
    await codex.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
