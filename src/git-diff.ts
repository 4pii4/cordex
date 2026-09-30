import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'

const defaultMaxDiffBytes = 40 * 1_024 * 1_024
const maxStderrBytes = 64 * 1_024

export type GitDiffResult = {
  patch: Buffer
  stderr: string
  exitCode: number | null
  timedOut: boolean
  tooLarge: boolean
}

async function runGit(
  cwd: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitDiffResult> {
  const child = spawn('git', args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let tooLarge = false
  let timedOut = false

  child.stdout.on('data', (chunk: Buffer) => {
    if (tooLarge) return
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > maxBytes) {
      tooLarge = true
      child.kill('SIGKILL')
      return
    }
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= maxStderrBytes) return
    const slice = chunk.subarray(0, maxStderrBytes - stderrBytes)
    stderr.push(slice)
    stderrBytes += slice.byteLength
  })

  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  timer.unref()
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))

  return {
    patch: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
    exitCode,
    timedOut,
    tooLarge,
  }
}

export async function resolveGitCommit(options: {
  cwd: string
  revision: string
  timeoutMs?: number
}): Promise<string> {
  if (
    !options.revision.trim() ||
    options.revision.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(options.revision)
  ) throw new Error('Commit revision must be a nonempty, single-line Git revision')

  const gitEnvironment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  for (const name of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  ]) delete gitEnvironment[name]
  const result = await runGit(
    options.cwd,
    ['rev-parse', '--verify', '--end-of-options', `${options.revision.trim()}^{commit}`],
    128,
    options.timeoutMs ?? 10_000,
    gitEnvironment,
  )
  if (result.timedOut) throw new Error('Git commit lookup timed out')
  const sha = result.patch.toString('utf8').trim()
  if (result.exitCode !== 0 || result.tooLarge || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
    throw new Error('Unable to resolve a commit from that revision in this session checkout')
  }
  return sha.toLowerCase()
}

export async function readGitDiff(options: {
  cwd: string
  maxBytes?: number
  timeoutMs?: number
}): Promise<GitDiffResult> {
  const maxBytes = options.maxBytes ?? defaultMaxDiffBytes
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  const empty = Buffer.alloc(0)
  const run = async (args: string[], remainingBytes: number): Promise<GitDiffResult> => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { patch: empty, stderr: 'Git diff timed out', exitCode: null, timedOut: true, tooLarge: false }
    }
    return runGit(options.cwd, args, remainingBytes, remainingMs)
  }
  const fail = (result: GitDiffResult): GitDiffResult => ({ ...result, patch: empty })

  const repository = await run(['rev-parse', '--is-inside-work-tree'], 128)
  if (repository.exitCode !== 0 || repository.timedOut || repository.tooLarge) {
    return fail(repository)
  }
  if (repository.patch.toString('utf8').trim() !== 'true') {
    return { patch: empty, stderr: 'Not a Git working tree', exitCode: 1, timedOut: false, tooLarge: false }
  }

  const head = await run(['rev-parse', '--verify', '-q', 'HEAD'], 128)
  if (head.timedOut || head.tooLarge || (head.exitCode !== 0 && head.exitCode !== 1)) {
    return fail(head)
  }
  const hasHead = head.exitCode === 0
  const patches: Buffer[] = []
  let totalBytes = 0

  if (hasHead) {
    const tracked = await run(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], maxBytes)
    if (tracked.exitCode !== 0 || tracked.timedOut || tracked.tooLarge) return fail(tracked)
    patches.push(tracked.patch)
    totalBytes += tracked.patch.length
  }

  const paths = await run(
    hasHead
      ? ['ls-files', '--others', '--exclude-standard', '-z']
      : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    maxBytes,
  )
  if (paths.exitCode !== 0 || paths.timedOut || paths.tooLarge) return fail(paths)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let names: string[]
  try {
    names = decoder.decode(paths.patch).split('\0').filter(Boolean)
  } catch {
    return {
      patch: empty,
      stderr: 'Git path list contains a filename that is not valid UTF-8',
      exitCode: 1,
      timedOut: false,
      tooLarge: false,
    }
  }

  for (const name of names) {
    let exists = true
    try {
      await lstat(path.join(options.cwd, name))
    } catch (error) {
      if (hasHead || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      exists = false // A staged file may have been deleted before the first commit.
    }
    if (!exists) continue
    const untracked = await run(
      ['diff', '--no-index', '--binary', '--no-ext-diff', '--', '/dev/null', name],
      maxBytes - totalBytes,
    )
    if (untracked.timedOut || untracked.tooLarge) return fail(untracked)
    if (untracked.exitCode !== 1 && untracked.exitCode !== 0) return fail(untracked)
    if (untracked.patch.length === 0) {
      return {
        patch: empty,
        stderr: untracked.stderr || `Git produced no patch for ${name}`,
        exitCode: 1,
        timedOut: false,
        tooLarge: false,
      }
    }
    patches.push(untracked.patch)
    totalBytes += untracked.patch.length
  }

  return {
    patch: Buffer.concat(patches),
    stderr: '',
    exitCode: 0,
    timedOut: false,
    tooLarge: false,
  }
}
