import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Events, type ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, SessionState, ServerNotification } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('real generated images survive a Discord upload timeout and reach the thread exactly once', {
  skip: !process.env.CORDEX_GENERATED_IMAGE_TEST,
  timeout: 360_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-generated-image-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-generated-image-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const codex = new CodexAppServer()
  const discordThreadId = 'discord-generated-image-e2e'
  const parentChannelId = 'project-generated-image-e2e'
  const state = emptyState()
  state.channelVerbosity[parentChannelId] = 'text_only'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: workspace } },
  }
  let bot: CordexDiscordBot | undefined
  let codexThreadId = ''
  let archived = false
  let channelArchived = false
  let uploadAttempts = 0
  const delivered: Array<{ content: string; bytes: Buffer; name: string }> = []
  const generated = new Map<string, { sha256: string; savedPath?: string }>()
  const channel = {
    id: discordThreadId,
    name: 'Generated image E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string; files?: Array<{ attachment: Buffer; name?: string }> }) {
      const content = typeof payload === 'string' ? payload : payload.content || ''
      const file = typeof payload === 'string' ? undefined : payload.files?.[0]
      if (file) {
        uploadAttempts++
        if (uploadAttempts === 1) throw new Error('Simulated Discord upload timeout')
        assert.ok(Buffer.isBuffer(file.attachment))
        delivered.push({ content, bytes: file.attachment, name: file.name || '' })
      }
      return { id: `message-${uploadAttempts}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel

  codex.on('notification', (notification: ServerNotification) => {
    if (notification.method !== 'item/completed') return
    const item = notification.params.item
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('type' in item) || item.type !== 'imageGeneration') return
    if (!('id' in item) || typeof item.id !== 'string' || !('result' in item) || typeof item.result !== 'string') return
    generated.set(item.id, {
      sha256: createHash('sha256').update(Buffer.from(item.result, 'base64')).digest('hex'),
      ...('savedPath' in item && typeof item.savedPath === 'string' ? { savedPath: item.savedPath } : {}),
    })
  })

  try {
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'workspace-write',
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

    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: '$imagegen Generate a square teal compass icon on a pale background. Save the final image as assets/generated-e2e.png in this disposable project. Do not edit other files. Report the saved path and dimensions.',
        text_elements: [],
      }],
    })
    await waitFor(() => generated.size > 0, 'real imageGeneration item')
    await waitFor(() =>
      session.activeTurnId === undefined &&
      delivered.length === generated.size &&
      (state.discordOutbox?.length || 0) === 0,
    'all generated images delivered after retry')
    assert.equal(uploadAttempts, generated.size + 1)
    assert.equal(new Set(delivered.map((entry) => createHash('sha256').update(entry.bytes).digest('hex'))).size, generated.size)
    for (const entry of delivered) {
      const digest = createHash('sha256').update(entry.bytes).digest('hex')
      assert.ok([...generated.values()].some((item) => item.sha256 === digest))
      assert.match(entry.name, /\.png$/)
      assert.match(entry.content, /Generated image/)
      assert.ok(!entry.content.includes('iVBORw0KGgo'))
    }
    assert.ok((await stat(path.join(workspace, 'assets', 'generated-e2e.png'))).size > 0)
    bot.client.emit(Events.ShardResume, 0, 0)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(delivered.length, generated.size)
    const cachedFiles = await readdir(path.join(home, 'outgoing-media')).catch(() => [])
    assert.deepEqual(cachedFiles, [])

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-generated-image-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex image generation with Discord upload timeout and retry',
      command: 'npm run test:live-generated-image',
      codexThreadId,
      generated: [...generated.values()],
      uploadAttempts,
      delivered: delivered.map((entry) => ({
        name: entry.name,
        bytes: entry.bytes.length,
        sha256: createHash('sha256').update(entry.bytes).digest('hex'),
      })),
      pendingOutbox: state.discordOutbox?.length || 0,
      cachedFiles: cachedFiles.length,
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
