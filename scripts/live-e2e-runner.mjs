import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function start() {
  const runDir = await mkdtemp(path.join(tmpdir(), 'cordex-live-all-'))
  const worker = spawn(process.execPath, [scriptPath, 'worker', runDir], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  if (!worker.pid) throw new Error('Could not start live E2E worker')
  worker.unref()
  await writeJson(path.join(runDir, 'launch.json'), {
    runDir,
    workerPid: worker.pid,
    command: 'npm run test:live-all',
    requestedAt: new Date().toISOString(),
  })
  process.stdout.write(`${JSON.stringify({ runDir, workerPid: worker.pid })}\n`)
}

async function worker(runDir) {
  if (!runDir || !path.isAbsolute(runDir)) throw new Error('Worker requires an absolute run directory')
  const startedAt = new Date().toISOString()
  const logPath = path.join(runDir, 'run.log')
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
  const digest = createHash('sha256')
  let logBytes = 0
  const child = spawn('npm', ['run', 'test:live-all'], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await writeJson(path.join(runDir, 'running.json'), {
    runDir,
    workerPid: process.pid,
    suitePid: child.pid ?? null,
    startedAt,
    command: 'npm run test:live-all',
  })
  const record = (chunk) => {
    digest.update(chunk)
    logBytes += chunk.length
    log.write(chunk)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ exitCode: null, signal: null, error: error.message }))
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, error: null }))
  })
  await new Promise((resolve, reject) => log.end((error) => error ? reject(error) : resolve()))
  const output = await readFile(logPath, 'utf8')
  const counts = (name) => [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))]
    .map((match) => Number(match[1]))
  const stages = [...output.matchAll(/^> @\S+ (test:live(?:-[\w-]+)?)$/gm)]
    .map((match) => match[1])
  const result = {
    status: outcome.exitCode === 0 ? 'passed' : 'failed',
    command: 'npm run test:live-all',
    runDir,
    workerPid: process.pid,
    suitePid: child.pid ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...outcome,
    stages,
    tapTotals: {
      passed: counts('pass').reduce((sum, value) => sum + value, 0),
      failed: counts('fail').reduce((sum, value) => sum + value, 0),
      skipped: counts('skipped').reduce((sum, value) => sum + value, 0),
    },
    logPath,
    logBytes,
    logSha256: digest.digest('hex'),
  }
  const temporary = path.join(runDir, 'result.json.tmp')
  await writeJson(temporary, result)
  await rename(temporary, path.join(runDir, 'result.json'))
  process.exitCode = outcome.exitCode === 0 ? 0 : 1
}

async function status(runDir) {
  if (!runDir || !path.isAbsolute(runDir)) throw new Error('Status requires an absolute run directory')
  const result = await readJson(path.join(runDir, 'result.json'))
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const running = await readJson(path.join(runDir, 'running.json'))
  const launch = await readJson(path.join(runDir, 'launch.json'))
  const workerPid = running?.workerPid || launch?.workerPid
  if (!workerPid) throw new Error('Run directory has no worker identity')
  let alive = false
  try {
    process.kill(workerPid, 0)
    const commandLine = await readFile(`/proc/${workerPid}/cmdline`, 'utf8')
    const args = commandLine.split('\0')
    const stat = await readFile(`/proc/${workerPid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3)
    alive = args.includes(scriptPath) && args.includes('worker') && args.includes(runDir) &&
      state !== 'Z' && state !== 'X'
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'ENOENT' && error?.code !== 'EPERM') throw error
  }
  process.stdout.write(`${JSON.stringify({
    status: alive ? 'running' : 'incomplete',
    runDir,
    workerPid,
    suitePid: running?.suitePid ?? null,
    startedAt: running?.startedAt ?? null,
    logPath: path.join(runDir, 'run.log'),
  })}\n`)
}

const [mode, runDir] = process.argv.slice(2)
try {
  if (mode === 'start') await start()
  else if (mode === 'worker') await worker(runDir)
  else if (mode === 'status') await status(runDir)
  else throw new Error('Usage: live-e2e-runner.mjs start|status <absolute-run-directory>')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
