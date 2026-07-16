import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { packageVersion } from '../src/version.js'

const execFileAsync = promisify(execFile)

test('CLI exposes public help and version commands without requiring configuration', async () => {
  const help = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--help'],
    { cwd: process.cwd() },
  )
  assert.match(help.stdout, /^Usage: cordex/m)
  assert.match(help.stdout, /--projects-dir <path>/)

  const version = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', '--version'],
    { cwd: process.cwd() },
  )
  assert.equal(version.stdout.trim(), await packageVersion())
})
