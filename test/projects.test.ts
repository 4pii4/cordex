import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { emptyState } from '../src/config.js'
import {
  clearProjectChannelState,
  createProject,
  findProjectMapping,
  findProjectMappingForPath,
  projectRemovalBlocker,
  projectRemapBlocker,
  removeProjectChannelData,
  resolveProjectRoot,
  sanitizeProjectName,
} from '../src/projects.js'
import type { CordexConfig, SessionState } from '../src/types.js'

test('project names sanitize and new projects initialize git', async () => {
  assert.equal(sanitizeProjectName(' Hello, Cordex! '), 'hello-cordex')
  assert.equal(sanitizeProjectName('---'), '')
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-projects-'))
  try {
    const project = await createProject({ rootDirectory: root, name: 'Hello, Cordex!' })
    assert.equal(project.name, 'hello-cordex')
    await access(path.join(project.directory, '.git'))
    const head = await readFile(path.join(project.directory, '.git', 'HEAD'), 'utf8')
    assert.match(head, /refs\/heads\/main/)
    await assert.rejects(
      createProject({ rootDirectory: root, name: 'Hello, Cordex!' }),
      /already exists/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project removal guards active sessions and unmerged worktrees', () => {
  const session = (overrides: Partial<SessionState> = {}): SessionState => ({
    discordThreadId: 'thread',
    parentChannelId: 'channel',
    directory: '/project',
    codexThreadId: 'codex',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  })
  assert.match(projectRemovalBlocker([['active', session({ activeTurnId: 'turn' })]], true) || '', /active turn/)
  assert.match(
    projectRemovalBlocker([['worktree', session({ worktree: { projectDirectory: '/project', directory: '/worktree', branch: 'branch' } })]], true) || '',
    /unmerged worktree/,
  )
  assert.match(projectRemovalBlocker([['idle', session()]], false) || '', /force:true/)
  assert.equal(projectRemovalBlocker([['idle', session()]], true), undefined)
})

test('project remapping protects the root and channels with sessions', () => {
  assert.match(
    projectRemapBlocker({ directory: '/root', kind: 'root' }, 0, '/other') || '',
    /root channel cannot be remapped/,
  )
  assert.match(
    projectRemapBlocker({ directory: '/project', kind: 'project' }, 1, '/other') || '',
    /already has Cordex sessions/,
  )
  assert.equal(projectRemapBlocker({ directory: '/project', kind: 'project' }, 0, '/other'), undefined)
  assert.equal(projectRemapBlocker({ directory: '/project', kind: 'root' }, 5, '/project'), undefined)
})

test('project mappings resolve exact IDs and the deepest parent directory', () => {
  const config = {
    projects: {
      root: { directory: '/work/repo', name: 'repo' },
      nested: { directory: '/work/repo/packages/app', name: 'app' },
      sibling: { directory: '/work/repo-two', name: 'repo-two' },
    },
  } as Pick<CordexConfig, 'projects'>
  assert.equal(findProjectMapping(config, 'root')?.project.name, 'repo')
  assert.equal(findProjectMapping(config, '/work/repo')?.channelId, 'root')
  assert.equal(findProjectMappingForPath(config, '/work/repo/packages/app/src')?.channelId, 'nested')
  assert.equal(findProjectMappingForPath(config, '/work/repo/docs')?.channelId, 'root')
  assert.equal(findProjectMappingForPath(config, '/work/repo-two/src')?.channelId, 'sibling')
  assert.equal(findProjectMappingForPath(config, '/work/repository'), undefined)
})

test('channel state cleanup removes every project-level preference', () => {
  const state = emptyState()
  state.channelModels.channel = 'model'
  state.channelEfforts.channel = 'high'
  state.channelFastMode.channel = true
  state.channelYoloMode.channel = true
  state.channelAutoWorktrees.channel = true
  state.channelVerbosity.channel = 'text_only'
  clearProjectChannelState(state, 'channel')
  assert.deepEqual(state, emptyState())
})

test('project channel removal clears dependent sessions, queues, and tasks', () => {
  const config = {
    projects: { channel: { directory: '/project' } },
  } as Pick<CordexConfig, 'projects'>
  const state = emptyState()
  state.sessions.thread = {
    discordThreadId: 'thread',
    parentChannelId: 'channel',
    directory: '/project',
    codexThreadId: 'codex',
    updatedAt: new Date(0).toISOString(),
  }
  state.queues.thread = []
  state.tasks.task = {
    id: 'task',
    threadId: 'thread',
    prompt: 'later',
    runAt: new Date(1).toISOString(),
    createdBy: 'user',
    status: 'scheduled',
  }
  assert.deepEqual(removeProjectChannelData(config, state, 'channel'), {
    sessionIds: ['thread'],
    taskIds: ['task'],
  })
  assert.deepEqual(config.projects, {})
  assert.deepEqual(state, emptyState())
})

test('project root resolution normalizes nested git paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-project-root-resolution-'))
  try {
    const project = await createProject({ rootDirectory: root, name: 'Nested Root' })
    const nested = path.join(project.directory, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    assert.equal(await resolveProjectRoot(nested), project.directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project mapping lookup follows symlink aliases', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-project-symlink-'))
  try {
    const project = await createProject({ rootDirectory: root, name: 'Canonical' })
    await mkdir(path.join(project.directory, 'src'))
    const alias = path.join(root, 'alias')
    await symlink(project.directory, alias, 'dir')
    const config = {
      projects: { channel: { directory: project.directory } },
    } as Pick<CordexConfig, 'projects'>
    assert.equal(findProjectMappingForPath(config, path.join(alias, 'src'))?.channelId, 'channel')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
