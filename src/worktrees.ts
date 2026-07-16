import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { SessionState } from './types.js'

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
    child.once('exit', resolve)
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
  const baseRef = options.baseRef || 'HEAD'
  await git(projectDirectory, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  const directory = getManagedWorktreeDirectory({
    dataRoot: options.dataRoot,
    projectDirectory,
    branch,
  })
  await mkdir(path.dirname(directory), { recursive: true })
  await rm(directory, { recursive: true, force: true })
  await git(projectDirectory, ['worktree', 'add', '-b', branch, directory, baseRef])
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

export type MergeWorktreeResult =
  | { status: 'merged'; targetBranch: string; branch: string; commitCount: number; shortSha: string }
  | { status: 'conflict'; targetBranch: string; message: string }

async function isRebaseInProgress(directory: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const result = await runGit(directory, ['rev-parse', '--git-path', name])
    if (result.exitCode !== 0) continue
    const probe = await runGit(directory, ['rev-parse', '--verify', 'REBASE_HEAD'])
    if (probe.exitCode === 0) return true
  }
  return false
}

export async function mergeWorktree(options: {
  projectDirectory: string
  worktreeDirectory: string
  branch: string
  targetBranch?: string
}): Promise<MergeWorktreeResult> {
  const mainStatus = await git(options.projectDirectory, ['status', '--porcelain'])
  if (mainStatus) throw new Error('Main worktree has uncommitted changes')
  const worktreeStatus = await git(options.worktreeDirectory, ['status', '--porcelain'])
  if (worktreeStatus) throw new Error('Worktree has uncommitted changes; commit them first')
  const currentBranch = await git(options.projectDirectory, ['branch', '--show-current'])
  if (!currentBranch) throw new Error('Main worktree is detached; checkout merge target first')
  const targetBranch = options.targetBranch || currentBranch
  if (options.targetBranch) {
    await git(options.projectDirectory, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])
    if (currentBranch !== targetBranch) await git(options.projectDirectory, ['checkout', targetBranch])
  }
  const worktreeBranch = await git(options.worktreeDirectory, ['branch', '--show-current'])
  if (worktreeBranch && worktreeBranch !== options.branch) {
    throw new Error(`Worktree branch changed: expected ${options.branch}, found ${worktreeBranch}`)
  }
  const countText = await git(options.worktreeDirectory, [
    'rev-list',
    '--count',
    `${targetBranch}..HEAD`,
  ])
  const commitCount = Number(countText)
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    throw new Error(`Nothing to merge into ${targetBranch}`)
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
  await git(options.projectDirectory, ['merge', '--ff-only', options.branch])
  const shortSha = await git(options.projectDirectory, ['rev-parse', '--short', 'HEAD'])
  await git(options.worktreeDirectory, ['checkout', '--detach'])
  await git(options.projectDirectory, ['branch', '-d', options.branch])
  return { status: 'merged', targetBranch, branch: options.branch, commitCount, shortSha }
}
