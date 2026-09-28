import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { cordexDynamicTools } from '../src/action-buttons.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import { fileUploadToolName } from '../src/file-upload-tool.js'
import type { CordexConfig, ServerRequest, SessionState } from '../src/types.js'

async function waitFor(condition: () => boolean, label: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('real Codex creates a report and uploads it with a sandbox-safe dynamic tool', {
  skip: !process.env.CORDEX_FILE_UPLOAD_TOOL_TEST,
  timeout: 240_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-upload-tool-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-upload-tool-project-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const source = path.join(workspace, 'report.csv')
  await writeFile(source, 'id,amount\na,17\nb,23\nc,25\nd,19\ne,4\nf,11\ng,8\n')
  const codex = new CodexAppServer()
  const requests: ServerRequest[] = []
  codex.on('serverRequest', (request: ServerRequest) => requests.push(request))
  const discordThreadId = '1554010000000000000'
  const parentChannelId = '1554010000000000001'
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
  const delivered: Array<{ content: string; files: Array<{ name: string; bytes: Buffer }> }> = []
  const channel = {
    id: discordThreadId,
    guildId: config.guildId,
    parentId: parentChannelId,
    name: 'Upload tool E2E',
    get archived() { return channelArchived },
    isThread: () => true,
    async sendTyping() {},
    async setArchived(next: boolean) {
      channelArchived = next
      return channel
    },
    async send(payload: string | { content?: string; files?: Array<{ attachment: Buffer; name: string }> }) {
      const files = typeof payload === 'string' ? [] : (payload.files || []).map((file) => ({
        name: file.name,
        bytes: file.attachment,
      }))
      if (files.length > 0) {
        uploadAttempts++
        if (uploadAttempts === 1) throw new Error('Simulated Discord upload timeout')
      }
      const content = typeof payload === 'string' ? payload : payload.content || ''
      delivered.push({ content, files })
      return { id: `message-${delivered.length}`, content, async edit() { return this } }
    },
  } as unknown as ThreadChannel

  try {
    const catalog = await codex.listModels()
    const preferred = catalog.find((model) => model.model === 'gpt-6-luna' && !model.hidden)
    const started = await codex.startThread({
      cwd: workspace,
      ...(preferred ? { model: preferred.model } : {}),
      dynamicTools: cordexDynamicTools,
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
        text: 'Read report.csv, write summary.txt containing the count of 7 data records and total amount 107, then call cordex_upload_files with paths ["summary.txt", "report.csv"] to send both files in one Discord message. Use the tool, not a shell or CLI upload. Do not edit report.csv. End your final reply with upload-tool-e2e-ok.',
        text_elements: [],
      }],
    })
    await waitFor(() =>
      requests.some((request) => request.method === 'item/tool/call' && request.params.tool === fileUploadToolName) &&
      delivered.some((message) => message.content.includes('upload-tool-e2e-ok')) &&
      delivered.filter((message) => message.files.length > 0).length === 1 &&
      session.activeTurnId === undefined &&
      (state.discordOutbox?.length || 0) === 0,
    'real Codex tool call, grouped Discord files, and final reply')
    const upload = delivered.find((message) => message.files.length > 0)!
    assert.deepEqual(upload.files.map((file) => file.name), ['summary.txt', 'report.csv'])
    assert.deepEqual(upload.files.map((file) => file.bytes), [
      await readFile(path.join(workspace, 'summary.txt')),
      await readFile(source),
    ])
    assert.match(upload.files[0]!.bytes.toString(), /107/)
    assert.equal(uploadAttempts, 2)
    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-upload-tool-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex-created report uploaded through the project-scoped dynamic tool after a Discord timeout',
      command: 'npm run test:live-file-upload-tool',
      codexThreadId,
      toolCalled: true,
      uploadAttempts,
      fileNames: upload.files.map((file) => file.name),
      sha256: upload.files.map((file) => createHash('sha256').update(file.bytes).digest('hex')),
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
