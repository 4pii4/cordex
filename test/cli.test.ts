import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  startCordexDaemonIpc,
  type CordexDaemonSendRequest,
} from '../src/daemon-ipc.js'
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

test('CLI send forwards a prompt and repeated absolute file paths to the authenticated daemon', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-cli-send-'))
  const attachment = path.join(home, 'context.txt')
  const secondAttachment = path.join(home, 'failure.log')
  await writeFile(attachment, 'context')
  await writeFile(secondAttachment, 'failure')
  const receivedRequests: CordexDaemonSendRequest[] = []
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      receivedRequests.push(request)
      return { threadId: request.target.id, position: 0 }
    },
  })
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'send',
        '--thread',
        '123456789012345678',
        '--file',
        attachment,
        '--file',
        secondAttachment,
        'Review',
        'this',
      ],
      { cwd: process.cwd(), env: { ...process.env, CORDEX_HOME: home } },
    )
    const received = receivedRequests.at(-1)
    assert.match(result.stdout, /Prompt accepted for Discord thread 123456789012345678/)
    assert.equal(received?.target.kind, 'thread')
    assert.equal(received?.target.id, '123456789012345678')
    assert.equal(received?.prompt, 'Review this')
    assert.deepEqual(received?.filePaths, [attachment, secondAttachment])
    assert.match(received?.requestId || '', /^[0-9a-f-]{36}$/)

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'send',
        '--thread',
        '123456789012345678',
        '--',
        '--verbose',
        '-v',
        '--projects-dir',
        'literal',
        '--help',
        '--version',
      ],
      { cwd: process.cwd(), env: { ...process.env, CORDEX_HOME: home } },
    )
    const secondReceived = receivedRequests.at(-1)
    assert.equal(
      secondReceived?.prompt,
      '--verbose -v --projects-dir literal --help --version',
    )
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('CLI send rejects invalid or excessive file paths before contacting the daemon', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-cli-files-'))
  let requests = 0
  const server = await startCordexDaemonIpc({
    home,
    async onSend(request) {
      requests++
      return { threadId: request.target.id, position: 0 }
    },
  })
  try {
    const missing = path.join(home, 'missing.txt')
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          'send',
          '--thread',
          '123456789012345678',
          '--file',
          missing,
          'Review',
        ],
        { cwd: process.cwd(), env: { ...process.env, CORDEX_HOME: home } },
      ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr || '', /File not found/)
        return true
      },
    )

    const attachment = path.join(home, 'context.txt')
    await writeFile(attachment, 'context')
    const repeatedFiles = Array.from({ length: 11 }, () => ['--file', attachment]).flat()
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/cli.ts',
          'send',
          '--thread',
          '123456789012345678',
          ...repeatedFiles,
          'Review',
        ],
        { cwd: process.cwd(), env: { ...process.env, CORDEX_HOME: home } },
      ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr || '', /at most 10 times/)
        return true
      },
    )
    assert.equal(requests, 0)
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('CLI send rejects unsafe channel creation without contacting a daemon', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'send',
        '--channel',
        '123456789012345678',
        'Start',
        'work',
      ],
      { cwd: process.cwd() },
    ),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr || ''
      assert.match(stderr, /Safe channel session creation is not supported yet/)
      return true
    },
  )
})
