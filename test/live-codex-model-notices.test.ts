import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Events, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, ServerNotification, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('real Codex turn reports verification, buffering, reroute, hooks, retry, and warnings durably', {
  skip: !process.env.CORDEX_MODEL_NOTICES_TEST,
  timeout: 210_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-model-notices-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-model-notices-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  await writeFile(path.join(workspace, 'slow-step.sh'), '#!/bin/sh\nsleep 90\nprintf notice-e2e-done\n')
  const codex = new CodexAppServer()
  let commandStarted = false
  const discordThreadId = '1554020000000000000'
  const parentChannelId = '1554020000000000001'
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  let archived = false
  let channelArchived = false
  let networkDown = true
  let sendAttempts = 0
  const delivered: string[] = []
  const channel = {
    id: discordThreadId,
    name: 'Model notices E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string }) {
      sendAttempts++
      if (networkDown) throw new Error('Simulated Discord outage')
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push(content)
      return { id: `message-${sendAttempts}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel
  codex.on('notification', (notification: ServerNotification) => {
    if (
      notification.method === 'item/started' &&
      notification.params.threadId === codexThreadId &&
      typeof notification.params.item === 'object' &&
      notification.params.item !== null &&
      !Array.isArray(notification.params.item) &&
      'type' in notification.params.item &&
      notification.params.item.type === 'commandExecution'
    ) commandStarted = true
  })

  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    codexThreadId = started.threadId
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
    bot = new CordexDiscordBot(config, state, codex)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
    const internal = bot as unknown as {
      runs: Map<string, { model: string; activeItems: Map<string, string> }>
    }
    const inject = (method: string, params: Record<string, unknown>) => {
      codex.emit('notification', { method, params } as ServerNotification)
    }

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Run bash slow-step.sh and wait for its stdout. Do not edit files. Then reply exactly notice-e2e-done.',
        text_elements: [],
      }],
    })
    await waitFor(() => Boolean(session.activeTurnId && internal.runs.has(codexThreadId) && commandStarted),
      'real active Codex command')
    const turnId = session.activeTurnId!
    const common = { threadId: codexThreadId, turnId }
    inject('model/safetyBuffering/updated', {
      ...common, model: started.model, useCases: ['private-use-case'], reasons: ['private-reason'],
      showBufferingUi: false, fasterModel: null,
    })
    inject('model/safetyBuffering/updated', {
      ...common, model: started.model, useCases: ['private-use-case'], reasons: ['private-reason'],
      showBufferingUi: true, fasterModel: null,
    })
    await waitFor(() => state.discordOutbox?.some((entry) => entry.itemKey === 'progress:safety-buffering') === true,
      'visible safety-buffering notice')
    inject('model/verification', { ...common, verifications: ['trustedAccessForCyber'] })
    await waitFor(() => state.discordOutbox?.some((entry) => entry.itemKey === 'model-verification') === true,
      'Trusted Access notice')
    assert.equal(state.discordOutbox?.some((entry) => entry.itemKey === 'progress:safety-buffering'), false)
    const routedModel = started.model === 'gpt-6-sol' ? 'gpt-6-luna' : 'gpt-6-sol'
    inject('model/rerouted', {
      ...common, fromModel: started.model, toModel: routedModel, reason: 'synthetic-route',
    })
    await waitFor(() => internal.runs.get(codexThreadId)?.model === routedModel,
      'current-turn model reroute')
    assert.equal(session.model, started.model)
    inject('model/verification', { ...common, verifications: [] })
    inject('model/safetyBuffering/updated', {
      ...common, model: started.model, useCases: [], reasons: [],
      showBufferingUi: false, fasterModel: null,
    })
    await waitFor(() =>
      internal.runs.get(codexThreadId)?.activeItems.has('__cordex_model_verification') === false &&
      internal.runs.get(codexThreadId)?.activeItems.has('__cordex_safety_buffering') === false,
    'resolved verification and safety-buffering activity')
    const hook = {
      id: 'synthetic-hook', eventName: 'preToolUse', handlerType: 'command', executionMode: 'sync',
      scope: 'turn', sourcePath: '/private/do-not-show/hook', source: 'project',
      displayOrder: 1, status: 'running', statusMessage: 'private-status',
      startedAt: 1, completedAt: null, durationMs: null, entries: [],
    }
    inject('hook/started', { ...common, run: hook })
    await waitFor(() => internal.runs.get(codexThreadId)?.activeItems.get('hook:synthetic-hook') ===
      'running a lifecycle hook', 'hook activity label')
    try {
      await waitFor(() => state.discordOutbox?.some((entry) =>
        entry.itemKey.startsWith('progress:') && entry.content.includes('running a lifecycle hook')) === true,
      'long-hook progress heartbeat', 100_000)
    } catch (error) {
      console.error(`Hook progress diagnostic: ${JSON.stringify({
        activeTurnId: session.activeTurnId,
        pendingProgress: (state.discordOutbox || [])
          .filter((entry) => entry.itemKey.startsWith('progress:'))
          .map((entry) => ({ itemKey: entry.itemKey, content: entry.content })),
      })}`)
      throw error
    }
    inject('hook/completed', {
      ...common, run: { ...hook, status: 'failed', completedAt: 2, durationMs: 1_000 },
    })
    await waitFor(() => state.discordOutbox?.some((entry) => entry.itemKey === 'hook:synthetic-hook:failure') === true,
      'failed-hook notice')
    assert.equal(internal.runs.get(codexThreadId)?.activeItems.has('hook:synthetic-hook'), false)
    inject('error', { ...common, error: { message: 'synthetic retry fault' }, willRetry: true })
    await waitFor(() => state.discordOutbox?.some((entry) => entry.itemKey.startsWith('progress:retry:')) === true,
      'durable retry warning')
    inject('warning', { ...common, message: 'synthetic scoped warning' })
    await waitFor(() => state.discordOutbox?.some((entry) => entry.itemKey.startsWith('warning:')) === true,
      'durable scoped warning')
    const pendingCount = state.discordOutbox?.length || 0
    inject('model/verification', {
      threadId: codexThreadId, turnId: 'stale-turn', verifications: ['trustedAccessForCyber'],
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(state.discordOutbox?.length || 0, pendingCount)
    assert.equal((state.discordOutbox || []).some((entry) =>
      /private-use-case|private-reason|private-status|do-not-show/.test(entry.content)), false)

    await waitFor(() => session.activeTurnId === undefined &&
      state.discordOutbox?.some((entry) => entry.content.includes('notice-e2e-done')) === true,
    'real Codex completion while Discord is offline')
    assert.equal(state.discordOutbox?.some((entry) => entry.itemKey.startsWith('progress:')), false)
    networkDown = false
    bot.client.emit(Events.ShardResume, 0, 0)
    await waitFor(() => delivered.some((content) => content.includes('notice-e2e-done')) &&
      (state.discordOutbox?.length || 0) === 0,
    'reconnected Discord delivery', 30_000)
    assert.equal(delivered.filter((content) => content.includes('Trusted Access for Cyber')).length, 1)
    assert.equal(delivered.filter((content) => content.includes('rerouted this turn')).length, 1)
    assert.equal(delivered.filter((content) => content.includes('lifecycle hook failed')).length, 1)
    assert.equal(delivered.filter((content) => content.includes('synthetic scoped warning')).length, 1)
    assert.equal(delivered.filter((content) => content.includes('notice-e2e-done')).length, 1)
    assert.equal(delivered.some((content) =>
      /private-use-case|private-reason|private-status|do-not-show|synthetic retry fault/.test(content)), false)
    inject('warning', { ...common, message: 'stale warning after completion' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(delivered.some((content) => content.includes('stale warning after completion')), false)
    bot.client.emit(Events.ShardResume, 0, 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(delivered.filter((content) => content.includes('Trusted Access for Cyber')).length, 1)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-model-notices-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex turn with schema-shaped model, hook, and warning notifications during a Discord outage',
      command: 'npm run test:live-model-notices',
      codexThreadId,
      turnId,
      requestedModel: session.model,
      reroutedModel: routedModel,
      sendAttempts,
      delivered,
      pendingOutbox: state.discordOutbox?.length || 0,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
    await codex.archiveThread(codexThreadId)
    archived = true
  } finally {
    if (codexThreadId && !archived) await codex.archiveThread(codexThreadId).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
