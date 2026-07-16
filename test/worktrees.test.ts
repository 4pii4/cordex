import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activeWorktreeSessions, createWorktree, mergeWorktree, runGit, slugifyWorktreeName } from '../src/worktrees.js'
import type { SessionState } from '../src/types.js'

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args)
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
}

test('worktree create, branch commit, rebase, fast-forward merge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])

    const created = await createWorktree({
      projectDirectory: root,
      dataRoot,
      name: 'Feature: Discord Queue',
    })
    assert.equal(created.branch, 'codex/cordex-feature-discord-queue')
    assert.equal(slugifyWorktreeName('Feature: Discord Queue'), 'feature-discord-queue')
    await writeFile(path.join(created.directory, 'README.md'), 'base\nfeature\n')
    await git(created.directory, ['add', 'README.md'])
    await git(created.directory, ['commit', '-m', 'feature'])

    const result = await mergeWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })
    assert.equal(result.status, 'merged')
    if (result.status === 'merged') assert.equal(result.commitCount, 1)
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'base\nfeature\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree merge rejects dirty main checkout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-dirty-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-dirty-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'dirty' })
    await writeFile(path.join(root, 'README.md'), 'dirty\n')
    await assert.rejects(
      mergeWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
      }),
      /Main worktree has uncommitted changes/,
    )
    await runGit(root, ['worktree', 'remove', '--force', created.directory])
    await runGit(root, ['branch', '-D', created.branch])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree merge checks out and merges into explicit target branch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-target-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-target-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    await git(root, ['branch', 'release'])
    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'target-release' })
    await writeFile(path.join(created.directory, 'README.md'), 'base\nrelease feature\n')
    await git(created.directory, ['add', 'README.md'])
    await git(created.directory, ['commit', '-m', 'release feature'])

    const result = await mergeWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
      targetBranch: 'release',
    })
    assert.equal(result.status, 'merged')
    if (result.status === 'merged') assert.equal(result.targetBranch, 'release')
    const branch = await runGit(root, ['branch', '--show-current'])
    assert.equal(branch.stdout, 'release')
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'base\nrelease feature\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('active worktree listing spans projects and sorts newest first', () => {
  const session = (id: string, updatedAt: string, merged = false): SessionState => ({
    discordThreadId: id,
    parentChannelId: `project-${id}`,
    directory: `/worktree/${id}`,
    codexThreadId: `codex-${id}`,
    worktree: {
      projectDirectory: `/project/${id}`,
      directory: `/worktree/${id}`,
      branch: `branch-${id}`,
      ...(merged ? { merged: true } : {}),
    },
    updatedAt,
  })
  const result = activeWorktreeSessions([
    session('old', new Date(1).toISOString()),
    session('merged', new Date(3).toISOString(), true),
    session('new', new Date(2).toISOString()),
  ])
  assert.deepEqual(result.map((item) => item.discordThreadId), ['new', 'old'])
})
