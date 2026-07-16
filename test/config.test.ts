import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  emptyState,
  getConfigPath,
  getStatePath,
  getManagementLockPath,
  getProjectsDirectory,
  loadConfig,
  loadState,
  saveConfig,
  saveManagedConfig,
  saveState,
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
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
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
    state.channelEfforts.channel = 'high'
    state.channelFastMode.channel = true
    state.channelYoloMode.channel = true
    state.channelAutoWorktrees.channel = true
    state.channelVerbosity.channel = 'text_only'
    state.sessions.thread = {
      discordThreadId: 'thread',
      parentChannelId: 'channel',
      directory,
      codexThreadId: 'codex-thread',
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
    await saveState(state)
    assert.deepEqual(await loadState(), state)
  } finally {
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
