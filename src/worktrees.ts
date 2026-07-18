import { createHash } from 'node:crypto'
import { access, lstat, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionState } from './types.js'

const SUBMODULE_INIT_TIMEOUT_MS = 10 * 60_000
const WORKTREE_REMOVE_TIMEOUT_MS = 10 * 60_000

export type GitResult = { stdout: string; stderr: string; exitCode: number | null }

export async function runGit(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  timer.unref()
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

function gitError(args: string[], result: GitResult): Error {
  return new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw gitError(args, result)
  return result.stdout
}

async function fetchRemoteBranch(directory: string, remote: string, branch: string): Promise<GitResult> {
  let result = await runGit(directory, ['fetch', remote, branch], 15_000)
  if (result.exitCode === 0) return result
  await delay(25)
  result = await runGit(directory, ['fetch', remote, branch], 15_000)
  return result
}

export function slugifyWorktreeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function formatWorktreeBranch(name: string): string {
  const slug = slugifyWorktreeName(name)
  return slug ? `codex/cordex-${slug}` : ''
}

export function getManagedWorktreeDirectory(options: {
  dataRoot: string
  projectDirectory: string
  branch: string
}): string {
  const hash = createHash('sha1').update(path.resolve(options.projectDirectory)).digest('hex').slice(0, 8)
  const name = options.branch.replace(/^codex\/cordex-/, '').replaceAll('/', '-')
  return path.join(options.dataRoot, 'worktrees', hash, name)
}

export type CreatedWorktree = {
  directory: string
  branch: string
  projectDirectory: string
}

export function activeWorktreeSessions(sessions: SessionState[]): SessionState[] {
  return sessions
    .filter((session) => session.worktree && !session.worktree.merged)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export async function resolveBestBaseRef(options: {
  directory: string
  branch: string
}): Promise<string> {
  const remotes = await runGit(options.directory, ['remote'])
  const remoteNames = remotes.exitCode === 0
    ? new Set(remotes.stdout.split('\n').map((remote) => remote.trim()).filter(Boolean))
    : new Set<string>()
  const remoteQualified = options.branch.startsWith('refs/remotes/')
    ? options.branch.slice('refs/remotes/'.length)
    : options.branch
  if (remoteQualified.includes('/')) {
    const separator = remoteQualified.indexOf('/')
    const remote = remoteQualified.slice(0, separator)
    const branch = remoteQualified.slice(separator + 1)
    if (remoteNames.has(remote) && branch) {
      await fetchRemoteBranch(options.directory, remote, branch)
      return options.branch
    }
  }

  for (const remote of ['upstream', 'origin']) {
    const fetched = await fetchRemoteBranch(options.directory, remote, options.branch)
    if (fetched.exitCode !== 0) continue

    const remoteRef = `${remote}/${options.branch}`
    const remoteFullRef = `refs/remotes/${remoteRef}`
    const remoteExists = await runGit(options.directory, ['rev-parse', '--verify', remoteFullRef])
    if (remoteExists.exitCode !== 0) continue

    const localFullRef = `refs/heads/${options.branch}`
    const localExists = await runGit(options.directory, ['rev-parse', '--verify', localFullRef])
    if (localExists.exitCode !== 0) return remoteRef

    const [remoteAhead, localAhead] = await Promise.all([
      runGit(options.directory, ['rev-list', '--count', `${localFullRef}..${remoteFullRef}`]),
      runGit(options.directory, ['rev-list', '--count', `${remoteFullRef}..${localFullRef}`]),
    ])
    if (remoteAhead.exitCode !== 0 || localAhead.exitCode !== 0) continue

    const remoteAheadCount = Number.parseInt(remoteAhead.stdout, 10)
    const localAheadCount = Number.parseInt(localAhead.stdout, 10)
    if (!Number.isFinite(remoteAheadCount) || !Number.isFinite(localAheadCount)) continue
    if (remoteAheadCount > 0 && localAheadCount > 0) continue
    if (remoteAheadCount > 0) return remoteRef
  }

  return options.branch
}

async function listSubmodulePaths(directory: string): Promise<string[]> {
  try {
    await access(path.join(directory, '.gitmodules'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const args = ['config', '--file', '.gitmodules', '--get-regexp', '^submodule[.].*[.]path$']
  const result = await runGit(directory, args)
  if (result.exitCode === 1) return []
  if (result.exitCode !== 0) throw gitError(args, result)

  const paths = result.stdout.split('\n').map((line) => {
    const separator = line.search(/\s/)
    if (separator < 0) throw new Error(`Invalid .gitmodules path entry: ${line}`)
    return line.slice(separator).trim()
  })
  return [...new Set(paths.filter(Boolean))]
}

function isContainedDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

async function sourceSubmoduleReference(
  projectDirectory: string,
  submodulePath: string,
): Promise<string | undefined> {
  const candidate = path.resolve(projectDirectory, submodulePath)
  if (!isContainedDirectory(projectDirectory, candidate)) return undefined
  const result = await runGit(projectDirectory, ['-C', candidate, 'rev-parse', '--show-toplevel'])
  if (result.exitCode !== 0 || path.resolve(result.stdout) !== candidate) return undefined
  return candidate
}

function submoduleUpdateArgs(submodulePath: string, reference?: string): string[] {
  return [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive',
    ...(reference ? ['--reference', reference] : []),
    '--',
    submodulePath,
  ]
}

async function initializeSubmodules(projectDirectory: string, worktreeDirectory: string): Promise<void> {
  const submodulePaths = await listSubmodulePaths(worktreeDirectory)
  for (const submodulePath of submodulePaths) {
    const reference = await sourceSubmoduleReference(projectDirectory, submodulePath)
    let referencedFailure: Error | undefined
    if (reference) {
      const args = submoduleUpdateArgs(submodulePath, reference)
      const result = await runGit(worktreeDirectory, args, SUBMODULE_INIT_TIMEOUT_MS)
      if (result.exitCode === 0) continue
      referencedFailure = gitError(args, result)
    }

    const args = submoduleUpdateArgs(submodulePath)
    const result = await runGit(worktreeDirectory, args, SUBMODULE_INIT_TIMEOUT_MS)
    if (result.exitCode === 0) continue
    const failure = gitError(args, result)
    throw new Error(
      `Submodule initialization failed for ${submodulePath}: ${failure.message}`
        + (referencedFailure ? `; local reference attempt failed: ${referencedFailure.message}` : ''),
      { cause: failure },
    )
  }
}

async function cleanupFailedWorktree(options: {
  projectDirectory: string
  directory: string
  branch: string
}): Promise<string[]> {
  await runGit(options.projectDirectory, ['worktree', 'remove', '--force', options.directory])
  const failures: string[] = []
  await rm(options.directory, { recursive: true, force: true }).catch((error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error))
  })
  await runGit(options.projectDirectory, ['worktree', 'prune'])
  await runGit(options.projectDirectory, ['branch', '-D', options.branch])
  await runGit(options.projectDirectory, ['worktree', 'prune'])

  const branch = await runGit(options.projectDirectory, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${options.branch}`,
  ])
  if (branch.exitCode === 0) failures.push(`branch still exists: ${options.branch}`)

  const worktrees = await runGit(options.projectDirectory, ['worktree', 'list', '--porcelain'])
  if (worktrees.exitCode !== 0) {
    failures.push(gitError(['worktree', 'list', '--porcelain'], worktrees).message)
  } else {
    const registered = worktrees.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .some((line) => path.resolve(line.slice('worktree '.length)) === path.resolve(options.directory))
    if (registered) failures.push(`worktree is still registered: ${options.directory}`)
  }
  return failures
}

export async function createWorktree(options: {
  projectDirectory: string
  dataRoot: string
  name: string
  baseRef?: string
}): Promise<CreatedWorktree> {
  const projectDirectory = path.resolve(options.projectDirectory)
  const topLevel = path.resolve(await git(projectDirectory, ['rev-parse', '--show-toplevel']))
  if (topLevel !== projectDirectory) {
    throw new Error(`Worktrees require mapped project to be git root: ${topLevel}`)
  }
  const branch = formatWorktreeBranch(options.name)
  if (!branch) throw new Error('Worktree name has no valid letters or numbers')
  const branchCheck = await runGit(projectDirectory, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (branchCheck.exitCode === 0) throw new Error(`Branch already exists: ${branch}`)
  const baseRef = options.baseRef
    ? await resolveBestBaseRef({ directory: projectDirectory, branch: options.baseRef })
    : 'HEAD'
  await git(projectDirectory, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  const directory = getManagedWorktreeDirectory({
    dataRoot: options.dataRoot,
    projectDirectory,
    branch,
  })
  await mkdir(path.dirname(directory), { recursive: true })
  await rm(directory, { recursive: true, force: true })
  await git(projectDirectory, ['worktree', 'add', '-b', branch, directory, baseRef])
  try {
    await initializeSubmodules(projectDirectory, directory)
  } catch (error) {
    const cleanupFailures = await cleanupFailedWorktree({ projectDirectory, directory, branch })
    if (cleanupFailures.length > 0) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}; cleanup failed: ${cleanupFailures.join('; ')}`, { cause: error })
    }
    throw error
  }
  return { directory, branch, projectDirectory }
}

export async function removeWorktree(worktree: CreatedWorktree): Promise<void> {
  const removed = await runGit(worktree.projectDirectory, [
    'worktree',
    'remove',
    '--force',
    worktree.directory,
  ])
  if (removed.exitCode !== 0) throw gitError(['worktree', 'remove', '--force', worktree.directory], removed)
  const deleted = await runGit(worktree.projectDirectory, ['branch', '-D', worktree.branch])
  if (deleted.exitCode !== 0) throw gitError(['branch', '-D', worktree.branch], deleted)
  await runGit(worktree.projectDirectory, ['worktree', 'prune'])
}

export type RegisteredGitWorktree = {
  directory: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason?: string
  prunable: boolean
  prunableReason?: string
  isMainWorktree: boolean
}

function parseRegisteredWorktrees(output: string): RegisteredGitWorktree[] {
  const worktrees: RegisteredGitWorktree[] = []
  let fields: string[] = []

  const finishRecord = (): void => {
    if (fields.length === 0) return
    let directory: string | undefined
    let head: string | undefined
    let branch: string | undefined
    let detached = false
    let bare = false
    let locked = false
    let lockedReason: string | undefined
    let prunable = false
    let prunableReason: string | undefined
    for (const field of fields) {
      if (field.startsWith('worktree ')) directory = field.slice('worktree '.length)
      else if (field.startsWith('HEAD ')) head = field.slice('HEAD '.length)
      else if (field.startsWith('branch ')) branch = field.slice('branch '.length)
      else if (field === 'detached') detached = true
      else if (field === 'bare') bare = true
      else if (field === 'locked') locked = true
      else if (field.startsWith('locked ')) {
        locked = true
        lockedReason = field.slice('locked '.length)
      } else if (field === 'prunable') prunable = true
      else if (field.startsWith('prunable ')) {
        prunable = true
        prunableReason = field.slice('prunable '.length)
      }
    }
    if (!directory) throw new Error('Invalid git worktree registration: missing directory')
    worktrees.push({
      directory: path.resolve(directory),
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
      detached,
      bare,
      locked,
      ...(lockedReason ? { lockedReason } : {}),
      prunable,
      ...(prunableReason ? { prunableReason } : {}),
      isMainWorktree: worktrees.length === 0,
    })
    fields = []
  }

  for (const field of output.split('\0')) {
    if (field) fields.push(field)
    else finishRecord()
  }
  finishRecord()
  return worktrees
}

export async function listRegisteredWorktrees(projectDirectory: string): Promise<RegisteredGitWorktree[]> {
  const output = await git(projectDirectory, ['worktree', 'list', '--porcelain', '-z'])
  return parseRegisteredWorktrees(output)
}

export type MergedWorktreeRemovalOptions = {
  projectDirectory: string
  worktreeDirectory: string
  branch: string
}

export type MergedWorktreeRemovalInspection =
  | {
      status: 'ready'
      registration: RegisteredGitWorktree & { head: string }
      containingBranches: string[]
      checkoutPresent: boolean
    }
  | { status: 'already-removed'; directory: string }

export type MergedWorktreeRemovalResult =
  | { status: 'removed'; directory: string; head: string }
  | { status: 'already-removed'; directory: string }

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function localBranchExists(projectDirectory: string, branch: string): Promise<boolean> {
  const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]
  const result = await runGit(projectDirectory, args)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw gitError(args, result)
}

async function absoluteGitPath(directory: string, name: '--git-common-dir'): Promise<string> {
  const value = await git(directory, ['rev-parse', name])
  return path.resolve(directory, value)
}

export async function inspectMergedWorktreeRemoval(
  options: MergedWorktreeRemovalOptions,
): Promise<MergedWorktreeRemovalInspection> {
  const projectDirectory = path.resolve(options.projectDirectory)
  const worktreeDirectory = path.resolve(options.worktreeDirectory)
  const projectTopLevel = path.resolve(await git(projectDirectory, ['rev-parse', '--show-toplevel']))
  if (projectTopLevel !== projectDirectory) {
    throw new Error(`Worktree project directory is not the git root: ${projectTopLevel}`)
  }
  if (worktreeDirectory === projectDirectory) {
    throw new Error('Refusing to remove the main worktree')
  }

  const registrations = await listRegisteredWorktrees(projectDirectory)
  const matches = registrations.filter((candidate) => candidate.directory === worktreeDirectory)
  if (matches.length > 1) {
    throw new Error(`Multiple git worktree registrations match ${worktreeDirectory}`)
  }
  if (matches.length === 0) {
    if (await pathExists(worktreeDirectory)) {
      throw new Error(`Worktree directory is not registered in this repository: ${worktreeDirectory}`)
    }
    if (await localBranchExists(projectDirectory, options.branch)) {
      throw new Error(`Worktree feature branch still exists: ${options.branch}`)
    }
    return { status: 'already-removed', directory: worktreeDirectory }
  }

  const registration = matches[0]!
  if (registration.isMainWorktree || registration.bare) {
    throw new Error(`Refusing to remove a primary git worktree: ${registration.directory}`)
  }
  if (registration.locked) {
    throw new Error(
      `Worktree is locked${registration.lockedReason ? `: ${registration.lockedReason}` : ''}`,
    )
  }
  if (!registration.detached || registration.branch) {
    const found = registration.branch?.replace(/^refs\/heads\//, '') || 'an attached HEAD'
    throw new Error(`Worktree registration is not merged and detached; found ${found}`)
  }
  if (!registration.head) throw new Error('Worktree registration has no HEAD commit')
  if (await localBranchExists(projectDirectory, options.branch)) {
    throw new Error(`Worktree feature branch still exists: ${options.branch}`)
  }

  const containingOutput = await git(projectDirectory, [
    'for-each-ref',
    '--format=%(refname:short)',
    `--contains=${registration.head}`,
    'refs/heads/',
  ])
  const containingBranches = containingOutput.split('\n').map((value) => value.trim()).filter(Boolean)
  if (containingBranches.length === 0) {
    throw new Error(`Worktree HEAD ${registration.head.slice(0, 12)} is not merged into a local branch`)
  }

  const checkoutPresent = await pathExists(worktreeDirectory)
  if (checkoutPresent) {
    const worktreeTopLevel = path.resolve(
      await git(worktreeDirectory, ['rev-parse', '--show-toplevel']),
    )
    if (worktreeTopLevel !== registration.directory) {
      throw new Error(
        `Worktree checkout does not match its registration: expected ${registration.directory}, found ${worktreeTopLevel}`,
      )
    }
    const [projectCommonDirectory, worktreeCommonDirectory] = await Promise.all([
      absoluteGitPath(projectDirectory, '--git-common-dir'),
      absoluteGitPath(worktreeDirectory, '--git-common-dir'),
    ])
    if (projectCommonDirectory !== worktreeCommonDirectory) {
      throw new Error('Worktree checkout belongs to a different git repository')
    }
    const worktreeHead = await git(worktreeDirectory, ['rev-parse', 'HEAD'])
    if (worktreeHead !== registration.head) {
      throw new Error(
        `Worktree checkout HEAD does not match its registration: expected ${registration.head}, found ${worktreeHead}`,
      )
    }
    const symbolicHead = await runGit(worktreeDirectory, ['symbolic-ref', '--quiet', 'HEAD'])
    if (symbolicHead.exitCode === 0) {
      throw new Error(`Worktree checkout is still attached to ${symbolicHead.stdout}`)
    }
    if (symbolicHead.exitCode !== 1) {
      throw gitError(['symbolic-ref', '--quiet', 'HEAD'], symbolicHead)
    }
    const status = await git(worktreeDirectory, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ])
    if (status) throw new Error('Worktree has uncommitted changes; clean it before removal')
  }

  return {
    status: 'ready',
    registration: registration as RegisteredGitWorktree & { head: string },
    containingBranches,
    checkoutPresent,
  }
}

export async function removeMergedWorktree(
  options: MergedWorktreeRemovalOptions,
): Promise<MergedWorktreeRemovalResult> {
  const inspection = await inspectMergedWorktreeRemoval(options)
  if (inspection.status === 'already-removed') return inspection

  const hasSubmodules = inspection.checkoutPresent
    && (await listSubmodulePaths(inspection.registration.directory)).length > 0
  if (hasSubmodules) {
    const deinitArgs = ['submodule', 'deinit', '--all']
    const deinitialized = await runGit(
      inspection.registration.directory,
      deinitArgs,
      WORKTREE_REMOVE_TIMEOUT_MS,
    )
    if (deinitialized.exitCode !== 0) throw gitError(deinitArgs, deinitialized)
    await inspectMergedWorktreeRemoval(options)
  }
  // Git requires --force for linked worktrees that have submodule metadata,
  // even after a clean deinit. The safety inspection above still gates it.
  const args = [
    'worktree',
    'remove',
    ...(hasSubmodules ? ['--force'] : []),
    inspection.registration.directory,
  ]
  const removed = await runGit(
    path.resolve(options.projectDirectory),
    args,
    WORKTREE_REMOVE_TIMEOUT_MS,
  )
  if (removed.exitCode !== 0) {
    try {
      const reconciled = await inspectMergedWorktreeRemoval(options)
      if (reconciled.status === 'already-removed') return reconciled
    } catch {
      // Preserve the removal failure when the target is still not safely reconciled.
    }
    throw gitError(args, removed)
  }

  const reconciled = await inspectMergedWorktreeRemoval(options)
  if (reconciled.status !== 'already-removed') {
    throw new Error(`Git reported success but worktree is still registered: ${reconciled.registration.directory}`)
  }
  return {
    status: 'removed',
    directory: reconciled.directory,
    head: inspection.registration.head,
  }
}

export type MergeWorktreeResult =
  | { status: 'merged'; targetBranch: string; branch: string; commitCount: number; shortSha: string }
  | { status: 'already-merged'; targetBranch: string; branch: string; shortSha: string }
  | { status: 'conflict'; targetBranch: string; message: string }
  | { status: 'nothing-to-merge'; targetBranch: string; branch: string }

async function isRebaseInProgress(directory: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const result = await runGit(directory, ['rev-parse', '--git-path', name])
    if (result.exitCode !== 0) continue
    const probe = await runGit(directory, ['rev-parse', '--verify', 'REBASE_HEAD'])
    if (probe.exitCode === 0) return true
  }
  return false
}

async function checkedOutWorktreeForBranch(
  projectDirectory: string,
  branch: string,
): Promise<string | undefined> {
  const output = await git(projectDirectory, ['worktree', 'list', '--porcelain'])
  let worktreeDirectory: string | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktreeDirectory = line.slice('worktree '.length)
      continue
    }
    if (line === `branch refs/heads/${branch}`) return worktreeDirectory
  }
  return undefined
}

async function deleteBranchRef(
  projectDirectory: string,
  branch: string,
  expectedHead: string,
): Promise<void> {
  await git(projectDirectory, ['update-ref', '-d', `refs/heads/${branch}`, expectedHead])
}

export async function mergeWorktree(options: {
  projectDirectory: string
  worktreeDirectory: string
  branch: string
  targetBranch?: string
}): Promise<MergeWorktreeResult> {
  const worktreeStatus = await git(options.worktreeDirectory, ['status', '--porcelain'])
  if (worktreeStatus) throw new Error('Worktree has uncommitted changes; commit them first')
  const currentBranch = await git(options.projectDirectory, ['branch', '--show-current'])
  if (!currentBranch && !options.targetBranch) {
    throw new Error('Main worktree is detached; specify a merge target')
  }
  const targetBranch = options.targetBranch || currentBranch
  await git(options.projectDirectory, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])
  const worktreeBranch = await git(options.worktreeDirectory, ['branch', '--show-current'])
  if (!worktreeBranch) {
    let inspection: MergedWorktreeRemovalInspection
    try {
      inspection = await inspectMergedWorktreeRemoval(options)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Worktree is detached; cannot prove it was already merged: ${detail}`)
    }
    if (inspection.status !== 'ready') {
      throw new Error('Worktree is detached and no longer registered')
    }
    const targetContainsHead = await runGit(options.projectDirectory, [
      'merge-base',
      '--is-ancestor',
      inspection.registration.head,
      `refs/heads/${targetBranch}`,
    ])
    if (targetContainsHead.exitCode === 1) {
      throw new Error(
        `Worktree is detached but its HEAD is not merged into ${targetBranch}`,
      )
    }
    if (targetContainsHead.exitCode !== 0) {
      throw gitError(
        [
          'merge-base',
          '--is-ancestor',
          inspection.registration.head,
          `refs/heads/${targetBranch}`,
        ],
        targetContainsHead,
      )
    }
    const shortSha = await git(
      options.projectDirectory,
      ['rev-parse', '--short', inspection.registration.head],
    )
    return {
      status: 'already-merged',
      targetBranch,
      branch: options.branch,
      shortSha,
    }
  }
  if (currentBranch === targetBranch) {
    const mainStatus = await git(options.projectDirectory, ['status', '--porcelain'])
    if (mainStatus) throw new Error('Main worktree has uncommitted changes')
  } else {
    const checkedOutAt = await checkedOutWorktreeForBranch(options.projectDirectory, targetBranch)
    if (checkedOutAt) {
      throw new Error(`Merge target ${targetBranch} is checked out at ${checkedOutAt}`)
    }
  }
  if (worktreeBranch !== options.branch) {
    throw new Error(`Worktree branch changed: expected ${options.branch}, found ${worktreeBranch}`)
  }
  const targetHead = await git(options.projectDirectory, ['rev-parse', `refs/heads/${targetBranch}`])
  const worktreeHead = await git(options.worktreeDirectory, ['rev-parse', 'HEAD'])
  const countText = await git(options.worktreeDirectory, [
    'rev-list',
    '--count',
    `${targetBranch}..HEAD`,
  ])
  const commitCount = Number(countText)
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    await git(options.worktreeDirectory, ['checkout', '--detach', targetHead])
    await deleteBranchRef(options.projectDirectory, options.branch, worktreeHead)
    return { status: 'nothing-to-merge', targetBranch, branch: options.branch }
  }
  const rebase = await runGit(options.worktreeDirectory, ['rebase', targetBranch], 10 * 60_000)
  if (rebase.exitCode !== 0) {
    if (await isRebaseInProgress(options.worktreeDirectory)) {
      return {
        status: 'conflict',
        targetBranch,
        message: rebase.stderr || rebase.stdout || 'Rebase conflict',
      }
    }
    throw gitError(['rebase', targetBranch], rebase)
  }
  const rebasedHead = await git(options.worktreeDirectory, ['rev-parse', 'HEAD'])
  if (currentBranch === targetBranch) {
    await git(options.projectDirectory, ['merge', '--ff-only', options.branch])
  } else {
    const ancestor = await runGit(options.projectDirectory, [
      'merge-base',
      '--is-ancestor',
      targetHead,
      rebasedHead,
    ])
    if (ancestor.exitCode !== 0) {
      throw new Error(`Rebased worktree is not a fast-forward of ${targetBranch}`)
    }
    await git(options.projectDirectory, [
      'update-ref',
      `refs/heads/${targetBranch}`,
      rebasedHead,
      targetHead,
    ])
  }
  const mergedHead = await git(options.projectDirectory, ['rev-parse', `refs/heads/${targetBranch}`])
  const shortSha = await git(options.projectDirectory, ['rev-parse', '--short', mergedHead])
  await git(options.worktreeDirectory, ['checkout', '--detach', mergedHead])
  await deleteBranchRef(options.projectDirectory, options.branch, rebasedHead)
  return { status: 'merged', targetBranch, branch: options.branch, commitCount, shortSha }
}
