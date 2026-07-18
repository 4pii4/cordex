import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CodexAppServer } from '../src/codex-app-server.js'
import { emptyState } from '../src/config.js'
import {
  getCordexDaemonSocketPath,
  getCordexDaemonTokenPath,
  materializeCordexDaemonInput,
  sendCordexDaemonPrompt,
  startCordexDaemonIpc,
} from '../src/daemon-ipc.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, QueuedPrompt, SessionState } from '../src/types.js'

test('daemon IPC authenticates requests and cleans up private runtime files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-ipc-'))
  const requests: string[] = []
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      requests.push(`${request.target.kind}:${request.target.id}:${request.prompt}`)
      return { threadId: request.target.id, position: 0 }
    },
  })
  try {
    assert.equal((await stat(server.tokenPath)).mode & 0o777, 0o600)
    assert.equal((await stat(server.socketPath)).mode & 0o777, 0o600)
    assert.equal((await readFile(server.tokenPath, 'utf8')).trim().length, 64)
    const result = await sendCordexDaemonPrompt({
      requestId: 'request-1',
      target: { kind: 'thread', id: '123456789012345678' },
      prompt: 'Run the focused tests',
    }, { home })
    assert.deepEqual(result, { threadId: '123456789012345678', position: 0 })
    assert.deepEqual(requests, ['thread:123456789012345678:Run the focused tests'])
  } finally {
    await server.close()
  }
  await assert.rejects(access(getCordexDaemonSocketPath(home)))
  await assert.rejects(access(getCordexDaemonTokenPath(home)))
  await rm(home, { recursive: true, force: true })
})

test('daemon IPC wire budget accepts the full documented non-ASCII prompt limit', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-unicode-'))
  let receivedLength = 0
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      receivedLength = request.prompt.length
      return { threadId: request.target.id, position: 0 }
    },
  })
  try {
    const prompt = '界'.repeat(120_000)
    await sendCordexDaemonPrompt({
      requestId: 'unicode-limit',
      target: { kind: 'thread', id: '123456789012345678' },
      prompt,
    }, { home })
    assert.equal(receivedLength, prompt.length)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon input materialization embeds UTF-8 text and persists validated images', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-input-'))
  try {
    const textPath = path.join(home, 'notes.txt')
    await writeFile(textPath, 'line one\nline two\n')
    const textInput = await materializeCordexDaemonInput({
      home,
      prompt: 'Review these notes',
      filePath: textPath,
    })
    assert.equal(textInput.input.length, 1)
    assert.match(textInput.input[0]?.type === 'text' ? textInput.input[0].text : '', /line two/)
    assert.equal(textInput.displayText, 'Review these notes [notes.txt]')

    const pngPath = path.join(home, 'pixel.png')
    await writeFile(pngPath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]))
    const imageInput = await materializeCordexDaemonInput({
      home,
      prompt: 'Inspect this image',
      filePath: pngPath,
    })
    assert.equal(imageInput.input[1]?.type, 'localImage')
    const persisted = imageInput.input[1]?.type === 'localImage' ? imageInput.input[1].path : ''
    assert.match(persisted, /attachments\/[0-9a-f]{64}\.png$/)
    await access(persisted)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon prompt ingress durably enqueues a stable direct delivery before returning', async () => {
  const state = emptyState()
  const session: SessionState = {
    discordThreadId: '123456789012345678',
    parentChannelId: '223456789012345678',
    directory: process.cwd(),
    codexThreadId: 'codex-thread-1',
    model: 'gpt-5',
    updatedAt: new Date(0).toISOString(),
  }
  state.sessions[session.discordThreadId] = session
  const config: CordexConfig = {
    token: 'token',
    applicationId: '323456789012345678',
    guildId: '423456789012345678',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projects: {
      [session.parentChannelId]: { directory: process.cwd(), name: 'Cordex' },
    },
  }
  const codex = new EventEmitter() as CodexAppServer
  const bot = new CordexDiscordBot(config, state, codex)
  const channel = { id: session.discordThreadId, isThread: () => true }
  ;(bot.client.channels as unknown as { fetch(id: string): Promise<typeof channel> }).fetch =
    async () => channel
  let persisted: QueuedPrompt | undefined
  let recoveryStarted = false
  let finishRecovery: (() => void) | undefined
  const recovery = new Promise<void>((resolve) => {
    finishRecovery = resolve
  })
  const internal = bot as unknown as {
    enqueuePrompt(threadId: string, prompt: QueuedPrompt): Promise<number>
    recoverPersistedPrompts(session: SessionState, channel: unknown): Promise<void>
  }
  internal.enqueuePrompt = async (_threadId, prompt) => {
    persisted = prompt
    return 0
  }
  internal.recoverPersistedPrompts = async () => {
    recoveryStarted = true
    await recovery
  }
  try {
    const result = await bot.enqueueDaemonPrompt({
      threadId: session.discordThreadId,
      requestId: 'stable-request',
      input: [{ type: 'text', text: 'Continue the port', text_elements: [] }],
      displayText: 'Continue the port',
    })
    assert.deepEqual(result, { threadId: session.discordThreadId, position: 0 })
    assert.equal(recoveryStarted, true)
    assert.equal(persisted?.id, 'cli:stable-request')
    assert.equal(persisted?.deliveryKind, 'direct')
    assert.equal(persisted?.authorName, 'Cordex CLI')
  } finally {
    finishRecovery?.()
    bot.client.destroy()
  }
})
