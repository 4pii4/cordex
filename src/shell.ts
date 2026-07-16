import { spawn } from 'node:child_process'

export type ShellResult = {
  output: string
  exitCode: number | null
  timedOut: boolean
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    process.kill(-child.pid, 0)
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The process group already exited.
  }
}

export async function runShellCommand(options: {
  command: string
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
}): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? 200_000
  const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', options.command] : ['-lc', options.command]
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let bytes = 0
  const append = (chunk: Buffer) => {
    if (bytes >= maxOutputBytes) return
    const remaining = maxOutputBytes - bytes
    const slice = chunk.subarray(0, remaining)
    output += slice.toString('utf8')
    bytes += slice.byteLength
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let timedOut = false
  let termination: Promise<void> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    termination = terminateProcessTree(child)
  }, timeoutMs)
  timer.unref()
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }).finally(() => clearTimeout(timer))
  if (termination) await termination
  if (bytes >= maxOutputBytes) output += '\n… output truncated'
  return { output: output.trimEnd(), exitCode, timedOut }
}
