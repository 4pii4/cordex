import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction, ThreadChannel } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig, SessionState } from '../src/types.js'

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('real Codex session history stays searchable and scoped through archive and deletion', {
  skip: !process.env.CORDEX_SESSION_HISTORY_TEST,
  timeout: 140_000,
}, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordex-history-project-'))
  const otherWorkspace = await mkdtemp(path.join(tmpdir(), 'cordex-history-other-'))
  const cordexHome = await mkdtemp(path.join(tmpdir(), 'cordex-history-home-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = cordexHome
  const codex = new CodexAppServer()
  let bot: CordexDiscordBot | undefined
  let threadId = ''
  let deleted = false
  const title = `Cordex history E2E ${Date.now()}`
  let completed = false
  try {
    await writeFile(path.join(workspace, 'fixture.txt'), 'alpha beta gamma\n')
    const started = await codex.startThread({
      cwd: workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    threadId = started.threadId
    codex.on('notification', (notification) => {
      if (
        notification.method === 'turn/completed' &&
        notification.params.threadId === threadId &&
        typeof notification.params.turn === 'object' &&
        notification.params.turn !== null &&
        'status' in notification.params.turn &&
        notification.params.turn.status === 'completed'
      ) completed = true
    })
    await codex.startTurn({
      threadId,
      model: started.model,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Read fixture.txt, count its words, and reply exactly history-e2e-3. Do not edit files.',
        text_elements: [],
      }],
    })
    await waitFor(() => completed, 'completed Codex turn')
    await codex.setThreadName(threadId, title)
    await waitFor(async () =>
      (await codex.listAllThreads({ cwd: [workspace, otherWorkspace], searchTerm: title }))
        .some((thread) => thread.id === threadId),
    'named session in scoped history')

    const active = await codex.listAllThreads({ cwd: [workspace, otherWorkspace], searchTerm: title })
    const wrongDirectory = await codex.listAllThreads({ cwd: otherWorkspace, searchTerm: title })
    const wrongCase = await codex.listAllThreads({ cwd: workspace, searchTerm: title.toLowerCase() })
    assert.equal(active.filter((thread) => thread.id === threadId).length, 1)
    assert.equal(wrongDirectory.some((thread) => thread.id === threadId), false)
    assert.equal(wrongCase.some((thread) => thread.id === threadId), false)

    const config: CordexConfig = {
      token: 'fixture-token',
      applicationId: 'fixture-application',
      guildId: 'fixture-guild',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      allowAllUsers: true,
      allowShellCommands: false,
      projects: { 'fixture-project-channel': { directory: workspace } },
    }
    const state = emptyState()
    bot = new CordexDiscordBot(config, state, codex)
    const invokeHistory = async (query: string, includeArchived: boolean): Promise<string> => {
      const messages: string[] = []
      let deferred = false
      const interaction = {
        options: {
          getString: (name: string) => name === 'query' ? query : null,
          getBoolean: (name: string) => name === 'include-archived' ? includeArchived : null,
        },
        get deferred() { return deferred },
        replied: false,
        async deferReply() { deferred = true },
        async editReply(payload: string | { content: string }) {
          messages.push(typeof payload === 'string' ? payload : payload.content)
        },
        async followUp(payload: { content: string }) { messages.push(payload.content) },
      } as unknown as ChatInputCommandInteraction
      await (bot as unknown as {
        handleLastSessionsCommand(value: ChatInputCommandInteraction): Promise<void>
      }).handleLastSessionsCommand(interaction)
      return messages.join('\n')
    }
    const activeReply = await invokeHistory('Cordex history E2E', false)
    assert.match(activeReply, /Cordex history E2E/)
    assert.match(activeReply, new RegExp(threadId))
    assert.doesNotMatch(activeReply, /archived/)

    await codex.archiveThread(threadId)
    await waitFor(async () =>
      !(await codex.listAllThreads({ cwd: workspace, searchTerm: title }))
        .some((thread) => thread.id === threadId) &&
      (await codex.listAllThreads({ cwd: workspace, searchTerm: title, archived: true }))
        .some((thread) => thread.id === threadId),
    'archived session only in archived results')
    const hiddenArchivedReply = await invokeHistory('Cordex history E2E', false)
    const shownArchivedReply = await invokeHistory('Cordex history E2E', true)
    assert.doesNotMatch(hiddenArchivedReply, new RegExp(threadId))
    assert.match(shownArchivedReply, new RegExp(threadId))
    assert.match(shownArchivedReply, /archived/)
    await codex.unarchiveThread(threadId)
    await waitFor(async () =>
      (await codex.listAllThreads({ cwd: workspace, searchTerm: title }))
        .some((thread) => thread.id === threadId),
    'restored active session')
    const discordThreadId = 'discord-history-e2e'
    const session: SessionState = {
      discordThreadId,
      parentChannelId: 'fixture-project-channel',
      directory: workspace,
      codexThreadId: threadId,
      model: started.model,
      effort: 'low',
      updatedAt: new Date().toISOString(),
    }
    state.sessions[discordThreadId] = session
    let discordArchived = false
    const notices: string[] = []
    const channel = {
      id: discordThreadId,
      get archived() { return discordArchived },
      isThread: () => true,
      async send(payload: string | { content: string }) {
        const content = typeof payload === 'string' ? payload : payload.content
        notices.push(content)
        return { id: `notice-${notices.length}`, content }
      },
      async setArchived(archived: boolean) {
        discordArchived = archived
        return channel
      },
    } as unknown as ThreadChannel
    ;(bot.client.channels as unknown as { fetch(id: string): Promise<ThreadChannel> }).fetch =
      async (id: string) => {
        assert.equal(id, discordThreadId)
        return channel
      }
    const invokeDelete = async (confirmation: string): Promise<string> => {
      let reply = ''
      const interaction = {
        channel,
        options: { getString: (name: string) => name === 'confirm-session-id' ? confirmation : null },
        async deferReply() {},
        async editReply(value: string) { reply = value },
      } as unknown as ChatInputCommandInteraction
      await (bot as unknown as {
        handleDeleteSessionCommand(value: ChatInputCommandInteraction): Promise<void>
      }).handleDeleteSessionCommand(interaction)
      return reply
    }
    await assert.rejects(invokeDelete('wrong-session-id'), /Confirmation must match/)
    assert.equal(state.sessions[discordThreadId], session)
    assert.equal((await codex.listAllThreads({ cwd: workspace, searchTerm: title })).some(
      (thread) => thread.id === threadId,
    ), true)
    state.queues[discordThreadId] = [{
      id: 'history-queued',
      authorId: 'fixture-user',
      authorName: 'Fixture',
      input: [{ type: 'text', text: 'pending follow-up', text_elements: [] }],
      displayText: 'pending follow-up',
      createdAt: new Date().toISOString(),
      deliveryKind: 'queued',
    }]
    await assert.rejects(invokeDelete(threadId), /Clear queued prompts/)
    assert.equal(state.sessions[discordThreadId], session)
    delete state.queues[discordThreadId]
    const deleteReply = await invokeDelete(threadId)
    deleted = true
    const afterDelete = await codex.listAllThreads({ cwd: workspace, searchTerm: title })
    const archivedAfterDelete = await codex.listAllThreads({ cwd: workspace, searchTerm: title, archived: true })
    assert.equal(afterDelete.some((thread) => thread.id === threadId), false)
    assert.equal(archivedAfterDelete.some((thread) => thread.id === threadId), false)
    assert.equal(state.sessions[discordThreadId], undefined)
    assert.equal(discordArchived, true)
    assert.match(deleteReply, /Deleted Codex session/)
    assert.match(notices.join('\n'), /permanently deleted/)
    assert.equal(await readFile(path.join(workspace, 'fixture.txt'), 'utf8'), 'alpha beta gamma\n')

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-session-history-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex turn, title search, directory filtering, archive, unarchive, and permanent deletion',
      command: 'npm run test:live-session-history',
      threadId,
      title,
      completed,
      activeCount: active.length,
      wrongDirectoryCount: wrongDirectory.length,
      wrongCaseCount: wrongCase.length,
      activeReply,
      hiddenArchivedReply,
      shownArchivedReply,
      deleteReply,
      notices,
      discordArchived,
      queuedDeletionRejected: true,
      activeAfterDelete: afterDelete.length,
      archivedAfterDelete: archivedAfterDelete.length,
      completedE2E: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    if (threadId && !deleted) await codex.deleteThread(threadId).catch(() => undefined)
    await bot?.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(cordexHome, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(otherWorkspace, { recursive: true, force: true })
  }
})
