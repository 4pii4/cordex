import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { readGitDiff } from '../src/git-diff.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

test('readGitDiff returns the complete text and binary patch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-git-diff-'))
  try {
    await git(directory, ['init', '-b', 'main'])
    await git(directory, ['config', 'user.email', 'cordex@test.invalid'])
    await git(directory, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(directory, 'notes.txt'), 'base\n')
    await writeFile(path.join(directory, 'asset.bin'), Buffer.from([0, 1, 2, 3]))
    await git(directory, ['add', '.'])
    await git(directory, ['commit', '-m', 'base'])

    const largeLine = `updated-unicode-${'x'.repeat(8_000)}-xin chao\n`
    await writeFile(path.join(directory, 'notes.txt'), largeLine)
    await writeFile(path.join(directory, 'asset.bin'), Buffer.from([0, 8, 7, 6, 5]))
    const result = await readGitDiff({ cwd: directory })

    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.tooLarge, false)
    assert.match(result.patch.toString('utf8'), /updated-unicode-/)
    assert.match(result.patch.toString('utf8'), /GIT binary patch/)
    assert.ok(result.patch.length > 8_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readGitDiff reports an explicit size overflow instead of truncating', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-git-diff-limit-'))
  try {
    await git(directory, ['init', '-b', 'main'])
    await git(directory, ['config', 'user.email', 'cordex@test.invalid'])
    await git(directory, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(directory, 'notes.txt'), 'base\n')
    await git(directory, ['add', '.'])
    await git(directory, ['commit', '-m', 'base'])
    await writeFile(path.join(directory, 'notes.txt'), `${'changed\n'.repeat(2_000)}`)

    const result = await readGitDiff({ cwd: directory, maxBytes: 128 })
    assert.equal(result.tooLarge, true)
    assert.ok(result.patch.length <= 128)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readGitDiff preserves git failures for the caller', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-git-diff-error-'))
  try {
    const result = await readGitDiff({ cwd: directory })
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /not a git repository/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
