import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState, loadState } from '../src/config.js'
import { sendCordexDaemonUpload, startCordexDaemonIpc, type CordexDaemonIpcServer } from '../src/daemon-ipc.js'
import type { CordexConfig, SessionState, ServerNotification } from '../src/types.js'

const execFileAsync = promisify(execFile)

async function waitFor(condition: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('real Codex session uploads a mixed file group once across Discord outage and bot restart', {
  skip: !process.env.CORDEX_FILE_UPLOAD_TEST,
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-upload-home-'))
  const project = await mkdtemp(path.join(tmpdir(), 'cordex-upload-project-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'cordex-upload-outside-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const discordThreadId = '1554000000000000000'
  const parentChannelId = '1554000000000000001'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory: project } },
  }
  const codex = new CodexAppServer()
  let restartedCodex: CodexAppServer | undefined
  let firstBot: CordexDiscordBot | undefined
  let restartedBot: CordexDiscordBot | undefined
  let firstIpc: CordexDaemonIpcServer | undefined
  let restartedIpc: CordexDaemonIpcServer | undefined
  let codexThreadId = ''
  let archived = false
  let networkDown = true
  let rejectNextFile = false
  let channelArchived = false
  let sendAttempts = 0
  const delivered: Array<{ content: string; files: Array<{ name: string; bytes: Buffer }> }> = []
  const channel = {
    id: discordThreadId,
    guildId: config.guildId,
    parentId: parentChannelId,
    name: 'File upload E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string; files?: Array<{ attachment: Buffer; name: string }> }) {
      sendAttempts++
      if (networkDown) throw new Error('Simulated Discord outage')
      const content = typeof payload === 'string' ? payload : payload.content || ''
      const files = typeof payload === 'string' ? [] : (payload.files || []).map((file) => ({
        name: file.name,
        bytes: file.attachment,
      }))
      if (files.length > 0 && rejectNextFile) {
        rejectNextFile = false
        throw Object.assign(new Error('Simulated invalid Discord file'), { status: 400, code: 50046 })
      }
      delivered.push({ content, files })
      return { id: `message-${sendAttempts}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y8FtJQAAAAASUVORK5CYII=', 'base64')
  const sourceNames = ['chart-a.png', 'chart-b.png', 'report.csv']
  const sources = sourceNames.map((name) => path.join(project, name))
  const originalCsv = Buffer.from('id,amount\na,17\nb,23\nc,25\nd,19\ne,4\nf,11\ng,8\n')
  const outsideFile = path.join(outside, 'outside-note.txt')
  const escaped = path.join(project, 'escape-note.txt')
  const requestId = 'upload-e2e-001'
  const cliPath = path.resolve('src/cli.ts')

  async function cli(args: string[]): Promise<string> {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cliPath, 'upload-to-discord', ...args], {
      cwd: path.resolve('.'),
      env: { ...process.env, CORDEX_HOME: home },
      timeout: 30_000,
    })
    return result.stdout.trim()
  }

  function attachChannel(bot: CordexDiscordBot): void {
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
  }

  function startIpc(bot: CordexDiscordBot): Promise<CordexDaemonIpcServer> {
    return startCordexDaemonIpc({
      home,
      async onSend() { throw new Error('Prompt sending is outside this upload E2E') },
      async onUpload(request) {
        return bot.uploadDaemonFiles({
          target: request.target,
          requestId: request.requestId,
          filePaths: request.filePaths,
          allowOutsideProject: request.allowOutsideProject === true,
        })
      },
    })
  }

  try {
    await writeFile(sources[0]!, png)
    await writeFile(sources[1]!, png)
    await writeFile(sources[2]!, originalCsv)
    await writeFile(outsideFile, 'outside opt-in fixture\n')
    await symlink(outsideFile, escaped)
    const started = await codex.startThread({ cwd: project, sandbox: 'workspace-write', approvalPolicy: 'never' })
    codexThreadId = started.threadId
    let materialized = false
    codex.on('notification', (notification: ServerNotification) => {
      if (
        notification.method === 'turn/completed' &&
        notification.params.threadId === codexThreadId &&
        typeof notification.params.turn === 'object' &&
        notification.params.turn !== null &&
        !Array.isArray(notification.params.turn) &&
        'status' in notification.params.turn &&
        notification.params.turn.status === 'completed'
      ) materialized = true
    })
    await codex.startTurn({
      threadId: codexThreadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Read report.csv, count its seven data records, and reply exactly upload-session-ready-7. Do not edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() => materialized, 'persisted real Codex session turn', 90_000)
    const state = emptyState()
    const session: SessionState = {
      discordThreadId,
      parentChannelId,
      directory: project,
      codexThreadId,
      model: started.model,
      updatedAt: new Date().toISOString(),
    }
    state.sessions[discordThreadId] = session
    firstBot = new CordexDiscordBot(config, state, codex)
    attachChannel(firstBot)
    firstIpc = await startIpc(firstBot)

    await assert.rejects(
      cli(['--session', codexThreadId, '--request-id', 'escape-e2e', escaped]),
      /resolves outside the current session directory/,
    )
    assert.equal(state.discordOutbox?.length || 0, 0)

    const accepted = await cli(['--session', codexThreadId, '--request-id', requestId, ...sources])
    assert.match(accepted, /3 files queued for Discord thread/)
    await waitFor(() => sendAttempts >= 1 && (state.discordOutbox?.length || 0) === 1,
      'first Discord attempt and persisted mixed-file outbox')
    assert.equal(state.discordOutbox?.[0]?.fileAttachments?.length, 3)
    await writeFile(sources[2]!, 'changed after acceptance\n')
    await firstIpc.close()
    firstIpc = undefined
    await firstBot.stop()
    firstBot = undefined
    await codex.close()

    const recoveredState = await loadState()
    assert.equal(recoveredState.discordOutbox?.[0]?.fileAttachments?.length, 3)
    restartedCodex = new CodexAppServer()
    restartedBot = new CordexDiscordBot(config, recoveredState, restartedCodex)
    attachChannel(restartedBot)
    networkDown = false
    await (restartedBot as unknown as { recoverDiscordOutbox(): Promise<void> }).recoverDiscordOutbox()
    await waitFor(() => delivered.length === 1 && (recoveredState.discordOutbox?.length || 0) === 0,
      'restart delivery of exactly one grouped file message')
    const group = delivered[0]!
    assert.equal(group.files.length, 3)
    assert.deepEqual(group.files.map((file) => file.name), sourceNames)
    assert.deepEqual(group.files.map((file) => file.bytes), [png, png, originalCsv])
    assert.match(group.content, /Uploaded 3 files/)
    await (restartedBot as unknown as { recoverDiscordOutbox(): Promise<void> }).recoverDiscordOutbox()
    assert.equal(delivered.length, 1)

    restartedIpc = await startIpc(restartedBot)
    const duplicate = await sendCordexDaemonUpload({
      requestId,
      target: { kind: 'session', id: codexThreadId },
      filePaths: sources,
    }, { home })
    assert.equal(duplicate.fileCount, 0)
    assert.equal(delivered.length, 1)
    const outsideAccepted = await cli([
      '--thread', discordThreadId,
      '--allow-outside-project',
      '--request-id', 'outside-e2e',
      outsideFile,
    ])
    assert.match(outsideAccepted, /1 file queued for Discord thread/)
    await waitFor(() => delivered.length === 2 && (recoveredState.discordOutbox?.length || 0) === 0,
      'explicit outside-project upload')
    assert.equal(delivered[1]?.files[0]?.bytes.toString(), 'outside opt-in fixture\n')
    rejectNextFile = true
    const rejectedAccepted = await cli([
      '--thread', discordThreadId,
      '--request-id', 'rejected-file-e2e',
      sources[0]!,
    ])
    assert.match(rejectedAccepted, /1 file queued for Discord thread/)
    await waitFor(() => delivered.length === 3 && (recoveredState.discordOutbox?.length || 0) === 0,
      'permanent Discord file rejection fallback')
    assert.equal(delivered[2]?.files.length, 0)
    assert.match(delivered[2]?.content || '', /Discord rejected one or more file attachments/)
    const cached = await readdir(path.join(home, 'outgoing-files')).catch(() => [])
    assert.deepEqual(cached, [])
    assert.equal((await readFile(sources[2]!)).toString(), 'changed after acceptance\n')

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-file-upload-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex session upload through CLI and authenticated daemon, Discord outage, restart, and explicit outside opt-in',
      command: 'npm run test:live-file-upload',
      codexThreadId,
      discordThreadId,
      fileNames: group.files.map((file) => file.name),
      sha256: group.files.map((file) => createHash('sha256').update(file.bytes).digest('hex')),
      sendAttempts,
      groupedMessages: delivered.filter((message) => message.files.length > 0).length,
      duplicateFileCount: duplicate.fileCount,
      symlinkEscapeRejected: true,
      outsideOptInDelivered: true,
      permanentRejectionFallback: true,
      cacheFiles: cached.length,
      pendingOutbox: recoveredState.discordOutbox?.length || 0,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
    await restartedCodex.archiveThread(codexThreadId)
    archived = true
  } finally {
    await restartedIpc?.close().catch(() => undefined)
    await firstIpc?.close().catch(() => undefined)
    if (codexThreadId && !archived) {
      await (restartedCodex || codex).archiveThread(codexThreadId).catch(() => undefined)
    }
    await restartedBot?.stop().catch(() => undefined)
    await firstBot?.stop().catch(() => undefined)
    await restartedCodex?.close().catch(() => undefined)
    await codex.close().catch(() => undefined)
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
