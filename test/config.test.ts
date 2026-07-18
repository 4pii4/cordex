import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acquireRuntimeLock,
  emptyState,
  getConfigPath,
  getStatePath,
  getManagementLockPath,
  getRuntimeLockPath,
  getProjectsDirectory,
  loadConfig,
  loadState,
  saveConfig,
  saveManagedConfig,
  saveState,
  StateSaveInvalidatedError,
  withManagementLock,
} from '../src/config.js'

test('config and session state round trip', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-test-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  try {
    await saveConfig({
      token: 'token',
      applicationId: 'app',
      guildId: 'guild',
      defaultEffort: 'max',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalTimeoutMinutes: 30,
      allowAllUsers: false,
      allowShellCommands: true,
      allowedUserIds: [' user ', 'user'],
      allowedRoleIds: ['role'],
      categoryId: 'category',
      projectsDirectory: path.join(directory, 'projects-root'),
      projects: { channel: { directory, kind: 'root', name: 'root' } },
    })
    assert.equal(getConfigPath(), path.join(directory, 'config.json'))
    const config = await loadConfig()
    assert.equal(config.projects.channel?.directory, directory)
    assert.equal(config.projects.channel?.kind, 'root')
    assert.equal(config.projectsDirectory, path.join(directory, 'projects-root'))
    assert.deepEqual(config.allowedUserIds, ['user'])
    assert.deepEqual(config.allowedRoleIds, ['role'])
    assert.equal(config.allowShellCommands, true)
    assert.equal(config.defaultEffort, 'max')
    assert.equal(config.approvalTimeoutMinutes, 30)
    assert.equal(config.categoryId, 'category')
    assert.equal(getProjectsDirectory(config), path.join(directory, 'projects-root'))

    const oldProjectsDir = process.env.CORDEX_PROJECTS_DIR
    const oldAllowedUsers = process.env.CORDEX_ALLOWED_USER_IDS
    const oldAllowedRoles = process.env.CORDEX_ALLOWED_ROLE_IDS
    const oldToken = process.env.CORDEX_DISCORD_TOKEN
    try {
      process.env.CORDEX_PROJECTS_DIR = path.join(directory, 'env-projects')
      process.env.CORDEX_ALLOWED_USER_IDS = 'env-user-1, env-user-2'
      process.env.CORDEX_ALLOWED_ROLE_IDS = 'env-role'
      process.env.CORDEX_DISCORD_TOKEN = 'env-token'
      assert.equal(getProjectsDirectory(config), path.join(directory, 'env-projects'))
      const environmentConfig = await loadConfig()
      assert.equal(environmentConfig.token, 'env-token')
      assert.deepEqual(environmentConfig.allowedUserIds, ['env-user-1', 'env-user-2'])
      assert.deepEqual(environmentConfig.allowedRoleIds, ['env-role'])
      await saveConfig(environmentConfig)
    } finally {
      if (oldProjectsDir === undefined) delete process.env.CORDEX_PROJECTS_DIR
      else process.env.CORDEX_PROJECTS_DIR = oldProjectsDir
      if (oldAllowedUsers === undefined) delete process.env.CORDEX_ALLOWED_USER_IDS
      else process.env.CORDEX_ALLOWED_USER_IDS = oldAllowedUsers
      if (oldAllowedRoles === undefined) delete process.env.CORDEX_ALLOWED_ROLE_IDS
      else process.env.CORDEX_ALLOWED_ROLE_IDS = oldAllowedRoles
      if (oldToken === undefined) delete process.env.CORDEX_DISCORD_TOKEN
      else process.env.CORDEX_DISCORD_TOKEN = oldToken
    }
    const persistedConfig = await loadConfig()
    assert.equal(persistedConfig.token, 'token')
    assert.deepEqual(persistedConfig.allowedUserIds, ['user'])
    assert.deepEqual(persistedConfig.allowedRoleIds, ['role'])

    const state = emptyState()
    state.channelModels.channel = 'gpt-test'
    state.channelEfforts.channel = 'max'
    state.channelFastMode.channel = true
    state.channelYoloMode.channel = true
    state.channelAutoWorktrees.channel = true
    state.channelVerbosity.channel = 'text_only'
    state.sessions.thread = {
      discordThreadId: 'thread',
      parentChannelId: 'channel',
      directory,
      codexThreadId: 'codex-thread',
      archived: true,
      activeTurnId: 'turn',
      workspaceRoots: [path.join(directory, 'extra')],
      permissions: ':read-only',
      fastMode: true,
      yoloMode: true,
      contextTokens: 1_000,
      contextWindow: 10_000,
      updatedAt: new Date(0).toISOString(),
    }
    state.tasks.task = {
      id: 'task',
      threadId: 'thread',
      prompt: 'scheduled',
      runAt: new Date(1).toISOString(),
      createdBy: 'user',
      status: 'scheduled',
    }
    state.queues.thread = [{
      id: 'direct-input',
      authorId: 'user',
      authorName: 'Discord User',
      input: [{ type: 'skill', name: 'reviewer', path: '/skills/reviewer/SKILL.md' }],
      displayText: '[reviewer skill]',
      createdAt: new Date(0).toISOString(),
      deliveryKind: 'direct',
    }]
    await saveState(state)
    assert.deepEqual(await loadState(), state)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('overlapping state writes persist call-time snapshots in order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-state-snapshot-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  try {
    const state = emptyState()
    state.channelModels.channel = 'first-save'
    const firstSave = saveState(state)
    state.channelModels.channel = 'second-save'
    const secondSave = saveState(state)
    state.channelModels.channel = 'mutated-after-save'
    await Promise.all([firstSave, secondSave])

    assert.equal((await loadState()).channelModels.channel, 'second-save')
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed state write invalidates overlapping snapshots captured behind it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-state-invalidation-'))
  const oldHome = process.env.CORDEX_HOME
  const oldNow = Date.now
  const oldRandom = Math.random
  process.env.CORDEX_HOME = directory
  const fixedNow = 1_721_234_567_890
  const failedRandom = 0.125
  const failedTemporary = `${getStatePath()}.${process.pid}.${fixedNow}.${failedRandom.toString(36).slice(2)}.tmp`
  try {
    await mkdir(failedTemporary)
    Date.now = () => fixedNow
    let randomCalls = 0
    Math.random = () => randomCalls++ === 0 ? failedRandom : 0.25

    const state = emptyState()
    state.channelModels.channel = 'failed-mutation'
    const failedSave = saveState(state)
    state.channelEfforts.channel = 'high'
    const overlappingSave = saveState(state)
    const overlappingRejection = assert.rejects(
      overlappingSave,
      (error) => error instanceof StateSaveInvalidatedError &&
        (error.cause as NodeJS.ErrnoException).code === 'EISDIR',
    )

    await assert.rejects(
      failedSave,
      (error) => (error as NodeJS.ErrnoException).code === 'EISDIR',
    )
    delete state.channelModels.channel
    await overlappingRejection
    assert.equal(await access(getStatePath()).then(() => true).catch(() => false), false)

    await rm(failedTemporary, { recursive: true, force: true })
    await saveState(state)
    const persisted = await loadState()
    assert.deepEqual(persisted.channelModels, {})
    assert.equal(persisted.channelEfforts.channel, 'high')
  } finally {
    Date.now = oldNow
    Math.random = oldRandom
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('state loading sanitizes persisted context usage fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-context-state-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  const baseSession = {
    discordThreadId: 'thread',
    parentChannelId: 'channel',
    directory,
    codexThreadId: 'codex-thread',
    updatedAt: new Date(0).toISOString(),
  }
  try {
    await writeFile(getStatePath(), JSON.stringify({
      sessions: {
        malformedTokens: {
          ...baseSession,
          archived: 'yes',
          contextTokens: '1000',
          contextWindow: 10_000,
        },
        malformedWindow: {
          ...baseSession,
          discordThreadId: 'thread-2',
          codexThreadId: 'codex-thread-2',
          contextTokens: 1_000,
          contextWindow: 0,
        },
        overWindow: {
          ...baseSession,
          discordThreadId: 'thread-3',
          codexThreadId: 'codex-thread-3',
          contextTokens: 11_000,
          contextWindow: 10_000,
        },
      },
    }))

    const state = await loadState()
    assert.equal(state.sessions.malformedTokens?.contextTokens, undefined)
    assert.equal(state.sessions.malformedTokens?.contextWindow, undefined)
    assert.equal(state.sessions.malformedTokens?.archived, undefined)
    assert.equal(state.sessions.malformedWindow?.contextTokens, 1_000)
    assert.equal(state.sessions.malformedWindow?.contextWindow, undefined)
    assert.equal(state.sessions.overWindow?.contextTokens, 11_000)
    assert.equal(state.sessions.overWindow?.contextWindow, 10_000)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('state loading gives legacy scheduled queue entries occurrence-unique delivery ids', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-legacy-scheduled-queue-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  try {
    await writeFile(getStatePath(), JSON.stringify({
      queues: {
        thread: [
          {
            id: 'task-repeat',
            authorId: 'user',
            authorName: 'scheduled task',
            input: [{ type: 'text', text: 'legacy occurrence', text_elements: [] }],
            displayText: 'legacy occurrence',
            createdAt: '2026-07-18T01:02:03.004Z',
          },
          {
            id: 'discord-message',
            authorId: 'user',
            authorName: 'Discord User',
            input: [{ type: 'text', text: 'normal queue', text_elements: [] }],
            displayText: 'normal queue',
            createdAt: '2026-07-18T01:02:04.004Z',
            sourceMessageId: 'discord-message',
            deliveryKind: 'invalid',
          },
          {
            id: 'interaction-id',
            authorId: 'user',
            authorName: 'scheduled task',
            input: [{ type: 'text', text: 'display-name collision', text_elements: [] }],
            displayText: 'display-name collision',
            createdAt: '2026-07-18T01:02:05.004Z',
          },
        ],
      },
      tasks: {
        'task-repeat': {
          id: 'task-repeat',
          threadId: 'thread',
          prompt: 'legacy occurrence',
          runAt: '2026-07-18T01:02:00.000Z',
          createdBy: 'user',
          status: 'running',
        },
      },
    }))

    const state = await loadState()
    assert.equal(
      state.queues.thread?.[0]?.id,
      'scheduled:task-repeat:2026-07-18T01:02:00.000Z',
    )
    assert.equal(state.queues.thread?.[1]?.id, 'discord-message')
    assert.equal(state.queues.thread?.[1]?.deliveryKind, undefined)
    assert.equal(state.queues.thread?.[2]?.id, 'interaction-id')
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('management lock serializes mutations and cleans up its lock file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-lock-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  const order: string[] = []
  let active = 0
  let maxActive = 0
  const lockedTask = (name: string) => withManagementLock(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    order.push(`${name}-start`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push(`${name}-end`)
    active--
  })
  try {
    await Promise.all([lockedTask('first'), lockedTask('second')])
    assert.equal(maxActive, 1)
    assert.ok(
      order.join(',') === 'first-start,first-end,second-start,second-end' ||
      order.join(',') === 'second-start,second-end,first-start,first-end',
    )
    await assert.rejects(access(getManagementLockPath()), /ENOENT/)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime lock is process-wide, fail-fast, and reusable after release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-runtime-lock-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  try {
    const release = await acquireRuntimeLock()
    assert.equal(await access(getRuntimeLockPath()).then(() => true).catch(() => false), true)
    await assert.rejects(acquireRuntimeLock(), /already running/)
    await release()
    assert.equal(await access(getRuntimeLockPath()).then(() => true).catch(() => false), false)

    const releaseAgain = await acquireRuntimeLock()
    await releaseAgain()
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('managed project writes preserve independently edited security settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-managed-config-'))
  const oldHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = directory
  try {
    await saveConfig({
      token: 'token',
      applicationId: 'application',
      guildId: 'guild',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      allowAllUsers: false,
      allowShellCommands: false,
      projects: {},
    })
    const stale = await loadConfig()
    const raw = JSON.parse(await readFile(getConfigPath(), 'utf8')) as Record<string, unknown>
    raw.sandbox = 'read-only'
    raw.allowedUserIds = ['new-operator']
    await writeFile(getConfigPath(), `${JSON.stringify(raw, null, 2)}\n`)

    stale.projects.project = { directory }
    await saveManagedConfig(stale)

    const current = await loadConfig()
    assert.equal(current.sandbox, 'read-only')
    assert.deepEqual(current.allowedUserIds, ['new-operator'])
    assert.equal(current.projects.project?.directory, directory)
  } finally {
    if (oldHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = oldHome
    await rm(directory, { recursive: true, force: true })
  }
})
