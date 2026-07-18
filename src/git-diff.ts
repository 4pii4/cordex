import { spawn } from 'node:child_process'

const defaultMaxDiffBytes = 40 * 1_024 * 1_024
const maxStderrBytes = 64 * 1_024

export type GitDiffResult = {
  patch: Buffer
  stderr: string
  exitCode: number | null
  timedOut: boolean
  tooLarge: boolean
}

export async function readGitDiff(options: {
  cwd: string
  maxBytes?: number
  timeoutMs?: number
}): Promise<GitDiffResult> {
  const maxBytes = options.maxBytes ?? defaultMaxDiffBytes
  const timeoutMs = options.timeoutMs ?? 120_000
  const child = spawn('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], {
    cwd: options.cwd,
    env: process.env,
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
    const remaining = maxStderrBytes - stderrBytes
    const slice = chunk.subarray(0, remaining)
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
    child.once('exit', resolve)
  }).finally(() => clearTimeout(timer))

  return {
    patch: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
    exitCode,
    timedOut,
    tooLarge,
  }
}
