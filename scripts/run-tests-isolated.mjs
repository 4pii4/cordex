import { constants as osConstants, homedir, tmpdir } from 'node:os'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const testDirectory = path.join(repository, 'test')

function contains(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function explicitTestHome(value) {
  const candidate = path.resolve(value)
  const effectiveCordexHome = path.resolve(process.env.CORDEX_HOME || path.join(homedir(), '.cordex'))
  if (
    candidate === path.parse(candidate).root ||
    contains(homedir(), candidate) ||
    contains(repository, candidate) ||
    contains(effectiveCordexHome, candidate) ||
    contains(candidate, effectiveCordexHome)
  ) {
    throw new Error('CORDEX_TEST_HOME must be an empty isolated directory outside the home, repository, and effective Cordex home')
  }
  const stat = await lstat(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('CORDEX_TEST_HOME must be a real directory, not a file or symbolic link')
  }
  if ((await readdir(candidate)).length > 0) {
    throw new Error('CORDEX_TEST_HOME must be empty before the test run')
  }
  return candidate
}

const requestedHome = process.env.CORDEX_TEST_HOME?.trim()
const generated = requestedHome === undefined || requestedHome === ''
const testHome = generated
  ? await mkdtemp(path.join(tmpdir(), 'cordex-test-home-'))
  : await explicitTestHome(requestedHome)
if (generated) await chmod(testHome, 0o700)

const testFiles = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort((left, right) => left.localeCompare(right))
if (testFiles.length === 0) throw new Error(`No top-level test files found in ${testDirectory}`)

const childEnvironment = {
  ...process.env,
  CORDEX_HOME: testHome,
  CORDEX_TEST_ISOLATED: '1',
}
delete childEnvironment.CORDEX_TEST_HOME
delete childEnvironment.CORDEX_TEST_KEEP_HOME

console.log(`Cordex test state: ${testHome} (${generated ? 'generated isolation' : 'explicit isolation'})`)
console.log(`Cordex test files: ${testFiles.length}`)

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  cwd: repository,
  env: childEnvironment,
  stdio: 'inherit',
})

const forwardedSignals = ['SIGINT', 'SIGTERM']
for (const signal of forwardedSignals) {
  process.once(signal, () => child.kill(signal))
}

const result = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})

for (const signal of forwardedSignals) process.removeAllListeners(signal)

const succeeded = result.code === 0 && result.signal === null
const keepGenerated = process.env.CORDEX_TEST_KEEP_HOME === '1' || !succeeded
if (generated && !keepGenerated) {
  const expectedPrefix = `${path.join(tmpdir(), 'cordex-test-home-')}`
  if (!testHome.startsWith(expectedPrefix)) throw new Error('Refusing unsafe generated test-home cleanup')
  await rm(testHome, { recursive: true, force: true })
  console.log('Cordex test state removed after success.')
} else {
  console.log(`Cordex test state retained: ${testHome}`)
}

if (result.signal) {
  process.exitCode = 128 + (osConstants.signals[result.signal] || 1)
} else {
  process.exitCode = result.code ?? 1
}
