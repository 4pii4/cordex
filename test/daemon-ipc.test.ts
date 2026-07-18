import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
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

test('daemon IPC authenticates requests, accepts legacy filePath, and cleans up private runtime files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-ipc-'))
  const requests: Array<{ target: string; prompt: string; filePaths?: string[] }> = []
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      requests.push({
        target: `${request.target.kind}:${request.target.id}`,
        prompt: request.prompt,
        ...(request.filePaths ? { filePaths: request.filePaths } : {}),
      })
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
    await sendCordexDaemonPrompt({
      requestId: 'legacy-file-path',
      target: { kind: 'thread', id: '123456789012345678' },
      prompt: 'Inspect legacy input',
      filePath: '/tmp/legacy-input.txt',
    }, { home })
    assert.deepEqual(requests, [
      {
        target: 'thread:123456789012345678',
        prompt: 'Run the focused tests',
      },
      {
        target: 'thread:123456789012345678',
        prompt: 'Inspect legacy input',
        filePaths: ['/tmp/legacy-input.txt'],
      },
    ])
  } finally {
    await server.close()
  }
  await assert.rejects(access(getCordexDaemonSocketPath(home)))
  await assert.rejects(access(getCordexDaemonTokenPath(home)))
  await rm(home, { recursive: true, force: true })
})

test('daemon IPC wire budget accepts the full prompt and attachment-path limits', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-unicode-'))
  let received: { promptLength: number; fileCount: number } | undefined
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      received = {
        promptLength: request.prompt.length,
        fileCount: request.filePaths?.length || 0,
      }
      return { threadId: request.target.id, position: 0 }
    },
  })
  try {
    const prompt = '界'.repeat(120_000)
    const filePaths = Array.from(
      { length: 10 },
      (_, index) => `/${index}${'界'.repeat(4_094)}`,
    )
    await sendCordexDaemonPrompt({
      requestId: 'unicode-limit',
      target: { kind: 'thread', id: '123456789012345678' },
      prompt,
      filePaths,
    }, { home })
    assert.deepEqual(received, { promptLength: prompt.length, fileCount: 10 })
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon input materialization combines mixed files deterministically and deduplicates images', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-input-'))
  try {
    const textPath = path.join(home, 'notes.txt')
    await writeFile(textPath, 'line one\nline two\n')
    const secondTextPath = path.join(home, 'failure.log')
    await writeFile(secondTextPath, 'failure details\n')

    const pngPath = path.join(home, 'pixel.png')
    await writeFile(pngPath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]))
    const duplicatePngPath = path.join(home, 'pixel-copy.png')
    await writeFile(duplicatePngPath, await readFile(pngPath))
    const materialized = await materializeCordexDaemonInput({
      home,
      prompt: 'Review these inputs',
      filePaths: [textPath, pngPath, secondTextPath, duplicatePngPath],
    })
    assert.equal(materialized.input.length, 2)
    const combined = materialized.input[0]?.type === 'text' ? materialized.input[0].text : ''
    assert.ok(combined.indexOf('line two') < combined.indexOf('failure details'))
    assert.equal(materialized.input[1]?.type, 'localImage')
    const persisted = materialized.input[1]?.type === 'localImage'
      ? materialized.input[1].path
      : ''
    assert.match(persisted, /attachments\/[0-9a-f]{64}\.png$/)
    await access(persisted)
    assert.equal((await readdir(path.join(home, 'attachments'))).length, 1)
    assert.equal(
      materialized.displayText,
      'Review these inputs [notes.txt, pixel.png, failure.log, pixel-copy.png]',
    )

    const legacy = await materializeCordexDaemonInput({
      home,
      prompt: 'Review legacy input',
      filePath: textPath,
    })
    assert.match(legacy.input[0]?.type === 'text' ? legacy.input[0].text : '', /line two/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon input materialization enforces file-count, per-file, and aggregate limits', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-daemon-limits-'))
  try {
    const small = path.join(home, 'small.txt')
    await writeFile(small, 'small')
    await assert.rejects(
      materializeCordexDaemonInput({
        home,
        prompt: 'Too many',
        filePaths: Array.from({ length: 11 }, () => small),
      }),
      /at most 10 files/,
    )

    const oversizedText = path.join(home, 'oversized.txt')
    await writeFile(oversizedText, 'x')
    await truncate(oversizedText, 1_000_001)
    await assert.rejects(
      materializeCordexDaemonInput({
        home,
        prompt: 'Too large',
        filePaths: [oversizedText],
      }),
      /1000000-byte text limit/,
    )

    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    const aggregatePaths: string[] = []
    for (let index = 0; index < 3; index++) {
      const filePath = path.join(home, `large-${index}.png`)
      await writeFile(filePath, pngHeader)
      await truncate(filePath, 14_000_000)
      aggregatePaths.push(filePath)
    }
    await assert.rejects(
      materializeCordexDaemonInput({
        home,
        prompt: 'Aggregate too large',
        filePaths: aggregatePaths,
      }),
      /40000000-byte aggregate attachment limit/,
    )
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
