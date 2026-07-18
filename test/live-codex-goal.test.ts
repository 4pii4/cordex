import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type { CordexConfig, CordexState, SessionState } from '../src/types.js'

function waitFor(condition: () => boolean, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for goal output'))
      }
    }, 25)
    timer.unref()
  })
}

test('active Codex goals automatically resume after restart and stream through Cordex', {
  skip: !process.env.CORDEX_LIVE_TEST,
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-live-goal-home-'))
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-live-goal-project-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  let setupCodex: CodexAppServer | undefined = new CodexAppServer()
  let codex: CodexAppServer | undefined
  let threadId = ''
  let bot: CordexDiscordBot | undefined

  try {
    const started = await setupCodex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    threadId = started.threadId
    await setupCodex.setThreadGoal(threadId, {
      objective: 'Reply exactly cordex-goal-stream-ok, then mark this goal complete.',
      tokenBudget: 4_000,
      status: 'paused',
    })
    await setupCodex.close()
    setupCodex = undefined
    codex = new CodexAppServer()
    const session: SessionState = {
      discordThreadId: 'discord-live-goal',
      parentChannelId: 'parent-live-goal',
      directory: workspace,
      codexThreadId: threadId,
      model: started.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    }
    const config: CordexConfig = {
      token: 'fixture-token',
      applicationId: 'application-live-goal',
      guildId: 'guild-live-goal',
      defaultModel: started.model,
      defaultEffort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      allowAllUsers: true,
      allowShellCommands: false,
      projects: { [session.parentChannelId]: { directory: workspace } },
    }
    const state: CordexState = {
      channelModels: {},
      channelEfforts: {},
      channelFastMode: {},
      channelYoloMode: {},
      channelAutoWorktrees: {},
      channelVerbosity: {},
      sessions: { [session.discordThreadId]: session },
      queues: {},
      tasks: {},
    }
    const sent: string[] = []
    const channel = {
      id: session.discordThreadId,
      isThread: () => true,
      async sendTyping() {},
      async send(payload: string | { content?: string }) {
        const content = typeof payload === 'string' ? payload : payload.content || ''
        sent.push(content)
        return {
          content,
          async edit() {
            return this
          },
        }
      },
    } as unknown as ThreadChannel

    bot = new CordexDiscordBot(config, state, codex)
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, session.discordThreadId)
        return channel
      }

    await codex.setThreadGoal(threadId, { status: 'active' })
    await (bot as unknown as { resumeActiveGoalSessions(): Promise<void> })
      .resumeActiveGoalSessions()
    await waitFor(() =>
      sent.some((content) => /cordex-goal-stream-ok/i.test(content)) &&
      sent.some((content) => content.includes(started.model)),
    )
    let finalGoal = await codex.getThreadGoal(threadId)
    const goalDeadline = Date.now() + 30_000
    while (finalGoal?.status !== 'complete' && Date.now() < goalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      finalGoal = await codex.getThreadGoal(threadId)
    }

    assert.ok(sent.some((content) => /cordex-goal-stream-ok/i.test(content)), sent.join('\n'))
    assert.equal(finalGoal?.status, 'complete')
    assert.equal(session.activeTurnId, undefined)
  } finally {
    if (threadId && codex) {
      await codex.clearThreadGoal(threadId).catch(() => undefined)
      await codex.archiveThread(threadId).catch(() => undefined)
    }
    bot?.client.destroy()
    await codex?.close()
    await setupCodex?.close()
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})
