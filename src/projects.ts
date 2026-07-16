import { realpathSync } from 'node:fs'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { runGit } from './worktrees.js'
import type {
  CordexConfig,
  CordexState,
  ProjectConfig,
  SessionState,
} from './types.js'

export function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

export type CreatedProject = {
  name: string
  directory: string
}

export type ProjectMapping = {
  channelId: string
  project: ProjectConfig
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function projectMappings(config: Pick<CordexConfig, 'projects'>): ProjectMapping[] {
  return Object.entries(config.projects)
    .map(([channelId, project]) => ({ channelId, project }))
    .sort((left, right) => {
      const leftName = left.project.name || path.basename(left.project.directory)
      const rightName = right.project.name || path.basename(right.project.directory)
      return leftName.localeCompare(rightName) || left.channelId.localeCompare(right.channelId)
    })
}

export function findProjectMapping(
  config: Pick<CordexConfig, 'projects'>,
  value: string,
): ProjectMapping | undefined {
  const direct = config.projects[value]
  if (direct) return { channelId: value, project: direct }
  const resolved = canonicalPath(value)
  return projectMappings(config).find(
    ({ project }) => canonicalPath(project.directory) === resolved,
  )
}

export function findProjectMappingForPath(
  config: Pick<CordexConfig, 'projects'>,
  directory: string,
): ProjectMapping | undefined {
  const resolved = canonicalPath(directory)
  return projectMappings(config)
    .filter(({ project }) => {
      const root = canonicalPath(project.directory)
      const relative = path.relative(root, resolved)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
    .sort(
      (left, right) =>
        canonicalPath(right.project.directory).length - canonicalPath(left.project.directory).length,
    )[0]
}

export function clearProjectChannelState(state: CordexState, channelId: string): void {
  delete state.channelModels[channelId]
  delete state.channelEfforts[channelId]
  delete state.channelFastMode[channelId]
  delete state.channelYoloMode[channelId]
  delete state.channelAutoWorktrees[channelId]
  delete state.channelVerbosity[channelId]
}

export function removeProjectChannelData(
  config: Pick<CordexConfig, 'projects'>,
  state: CordexState,
  channelId: string,
): { sessionIds: string[]; taskIds: string[] } {
  const sessionIds = Object.entries(state.sessions)
    .filter(([, session]) => session.parentChannelId === channelId)
    .map(([threadId]) => threadId)
  const sessionSet = new Set(sessionIds)
  const taskIds = Object.entries(state.tasks)
    .filter(([, task]) => sessionSet.has(task.threadId))
    .map(([taskId]) => taskId)
  for (const threadId of sessionIds) {
    delete state.sessions[threadId]
    delete state.queues[threadId]
  }
  for (const taskId of taskIds) delete state.tasks[taskId]
  clearProjectChannelState(state, channelId)
  delete config.projects[channelId]
  return { sessionIds, taskIds }
}

export async function resolveProjectRoot(directory: string): Promise<string> {
  const resolved = await realpath(path.resolve(directory))
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${resolved}`)
  const git = await runGit(resolved, ['rev-parse', '--show-toplevel'])
  if (git.exitCode !== 0 || !git.stdout) return resolved
  return realpath(path.resolve(git.stdout))
}

export function projectRemovalBlocker(
  sessions: Array<[string, SessionState]>,
  force: boolean,
): string | undefined {
  const active = sessions.find(([, session]) => session.activeTurnId)
  if (active) return `Session <#${active[0]}> has an active turn; abort it first`
  const unmerged = sessions.find(([, session]) => session.worktree && !session.worktree.merged)
  if (unmerged) return `Session <#${unmerged[0]}> has an unmerged worktree`
  if (sessions.length > 0 && !force) {
    return `Project has ${sessions.length} session${sessions.length === 1 ? '' : 's'}; rerun with force:true to archive them`
  }
  return undefined
}

export function projectRemapBlocker(
  existing: ProjectConfig | undefined,
  sessionCount: number,
  directory: string,
): string | undefined {
  if (!existing || canonicalPath(existing.directory) === canonicalPath(directory)) return undefined
  if (existing.kind === 'root') {
    return 'The Cordex root channel cannot be remapped; use /add-project for another project'
  }
  if (sessionCount > 0) return 'Cannot remap a channel that already has Cordex sessions'
  return undefined
}

export async function createProject(options: {
  rootDirectory: string
  name: string
}): Promise<CreatedProject> {
  const name = sanitizeProjectName(options.name)
  if (!name) throw new Error('Project name has no valid letters or numbers')
  const rootDirectory = path.resolve(options.rootDirectory)
  const directory = path.join(rootDirectory, name)
  await mkdir(rootDirectory, { recursive: true })
  try {
    await mkdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Project directory already exists: ${directory}`)
    }
    throw error
  }
  const initialized = await runGit(directory, ['init', '-b', 'main'])
  if (initialized.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`git init failed: ${initialized.stderr || initialized.stdout || `exit ${initialized.exitCode}`}`)
  }
  return { name, directory }
}
