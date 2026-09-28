import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { ChatInputCommandInteraction } from 'discord.js'
import type { CordexConfig, SessionState } from '../src/types.js'
import type { ServerNotification } from '../src/types.js'

test('real Codex discovers and forks a spawned subagent', {
  skip: !process.env.CORDEX_SUBAGENT_TEST,
  timeout: 150_000,
}, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-subagent-live-'))
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-subagent-home-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const codex = new CodexAppServer()
  let bot: CordexDiscordBot | undefined
  let parentThreadId = ''
  let forkThreadId = ''
  try {
    await writeFile(path.join(workspace, 'fixture.json'), JSON.stringify({
      credit: 4,
      rows: [
        { id: 'a', amount: 17, due: '2026-09-20', done: false },
        { id: 'b', amount: 23, due: '2026-09-28', done: false },
        { id: 'c', amount: 25, due: '2026-09-27', done: false },
        { id: 'd', amount: 19, due: '2026-09-25', done: true },
        { id: 'e', amount: 4, due: '2026-09-25', done: false },
        { id: 'f', amount: 11, due: '2026-09-30', done: false },
        { id: 'g', amount: 8, due: '2026-09-27', done: true },
      ],
    }))
    const completed = new Promise<void>((resolve) => {
      codex.on('notification', (notification: ServerNotification) => {
        if (notification.method === 'turn/completed' && notification.params.threadId === parentThreadId) {
          resolve()
        }
      })
    })
    const parent = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    parentThreadId = parent.threadId
    await codex.startTurn({
      threadId: parentThreadId,
      effort: 'ultra',
      input: [{
        type: 'text',
        text: 'Use collaboration.spawn_agent exactly once. Ask that subagent to read fixture.json and sum amount for rows where done is false and due is on or before 2026-09-27, then subtract credit. Wait for its answer, independently verify the calculation against the file, and reply exactly parent-finished-42. Do not edit files.',
        text_elements: [],
      }],
    })
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Subagent live test timed out')), 120_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }

    const subagents = await codex.listSubagentThreads(parentThreadId)
    assert.ok(subagents.length > 0)
    const child = subagents[0]
    assert.ok(child)
    assert.notEqual(child.threadId, parentThreadId)
    const parentTurns = await codex.listThreadTurns(parentThreadId, 10)
    assert.ok(parentTurns.flatMap((turn) => turn.items).some(
      (item) => item.type === 'agentMessage' &&
        typeof item.text === 'string' && item.text.includes('parent-finished-42'),
    ))
    const raw = await codex.request('thread/read', { threadId: parentThreadId, includeTurns: true }) as {
      thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> }
    }
    const items = raw.thread?.turns?.flatMap((turn) => turn.items || []) || []
    const collaborationItems = items.filter((item) =>
      item.type === 'collabToolCall' || item.type === 'collabAgentToolCall')
    const itemTypes = [...new Set(items.map((item) => String(item.type || 'unknown')))]

    const discordThreadId = 'discord-subagent-e2e'
    const parentChannelId = 'project-subagent-e2e'
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
    const state = emptyState()
    const session: SessionState = {
      discordThreadId,
      parentChannelId,
      directory: workspace,
      codexThreadId: parentThreadId,
      model: parent.model,
      effort: 'ultra',
      updatedAt: new Date().toISOString(),
    }
    state.sessions[discordThreadId] = session
    bot = new CordexDiscordBot(config, state, codex)
    const messages: string[] = []
    let deferred = false
    const interaction = {
      channel: { id: discordThreadId, isThread: () => true },
      get deferred() { return deferred },
      replied: false,
      async deferReply() { deferred = true },
      async editReply(value: string | { content: string }) {
        messages.push(typeof value === 'string' ? value : value.content)
      },
      async followUp(value: { content: string }) { messages.push(value.content) },
    } as unknown as ChatInputCommandInteraction
    await (bot as unknown as {
      handleSubagentsCommand(value: ChatInputCommandInteraction): Promise<void>
    }).handleSubagentsCommand(interaction)
    assert.ok(messages.join('\n').includes(child.threadId))

    const forked = await codex.forkThread({
      threadId: child.threadId,
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    forkThreadId = forked.threadId
    assert.notEqual(forkThreadId, child.threadId)
    assert.ok((await codex.listThreadTurns(forkThreadId, 10)).length > 0)
    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-subagent-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex parent delegates a seven-record calculation, Discord lists child, and child is forked',
      command: 'npm run test:live-subagent',
      parentThreadId,
      childThreadId: child.threadId,
      forkThreadId,
      subagentCount: subagents.length,
      itemTypes,
      collaborationItems: collaborationItems.map((item) => ({
        type: item.type,
        tool: item.tool,
        receiverThreadId: item.receiverThreadId,
        newThreadId: item.newThreadId,
        agentStatus: item.agentStatus,
      })),
      discordReply: messages.join('\n'),
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (forkThreadId) await codex.request('thread/delete', { threadId: forkThreadId }).catch(() => undefined)
    if (parentThreadId) await codex.request('thread/delete', { threadId: parentThreadId }).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
