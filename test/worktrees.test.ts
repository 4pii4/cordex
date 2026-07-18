import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  activeWorktreeSessions,
  createWorktree,
  formatWorktreeBranch,
  getManagedWorktreeDirectory,
  inspectMergedWorktreeRemoval,
  listRegisteredWorktrees,
  listWorktreeInventory,
  mergeWorktree,
  removeMergedWorktree,
  resolveBestBaseRef,
  runGit,
  slugifyWorktreeName,
} from '../src/worktrees.js'
import type { SessionState } from '../src/types.js'

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(cwd, args)
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function createWorktreeFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-removal-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-removal-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    const created = await createWorktree({ projectDirectory: root, dataRoot, name })
    return { root, dataRoot, created }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
    throw error
  }
}

async function commitAndMergeFixture(
  root: string,
  created: Awaited<ReturnType<typeof createWorktree>>,
): Promise<void> {
  await writeFile(path.join(created.directory, 'README.md'), 'base\nfeature\n')
  await git(created.directory, ['add', 'README.md'])
  await git(created.directory, ['commit', '-m', 'feature'])
  const merged = await mergeWorktree({
    projectDirectory: root,
    worktreeDirectory: created.directory,
    branch: created.branch,
  })
  assert.equal(merged.status, 'merged')
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

test('worktree merge recognizes a completed merge after its caller lost the result', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('merge recovery')
  try {
    await commitAndMergeFixture(root, created)
    const expectedShortSha = await gitOutput(root, ['rev-parse', '--short', 'main'])

    assert.deepEqual(await mergeWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    }), {
      status: 'already-merged',
      targetBranch: 'main',
      branch: created.branch,
      shortSha: expectedShortSha,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree merge returns a typed result when there are no commits to merge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-empty-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-empty-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])

    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'empty' })
    await writeFile(path.join(root, 'TARGET.md'), 'target advanced\n')
    await git(root, ['add', 'TARGET.md'])
    await git(root, ['commit', '-m', 'advance target'])
    const result = await mergeWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })

    assert.deepEqual(result, {
      status: 'nothing-to-merge',
      targetBranch: 'main',
      branch: created.branch,
    })
    assert.equal(await gitOutput(created.directory, ['branch', '--show-current']), '')
    assert.equal(
      await gitOutput(created.directory, ['rev-parse', 'HEAD']),
      await gitOutput(root, ['rev-parse', 'main']),
    )
    assert.equal(await readFile(path.join(created.directory, 'TARGET.md'), 'utf8'), 'target advanced\n')
    assert.equal(
      (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${created.branch}`])).exitCode,
      1,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree merge rejects detached HEAD instead of deleting an unmerged branch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-detached-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-detached-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])

    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'detached' })
    await writeFile(path.join(created.directory, 'README.md'), 'detached commit\n')
    await git(created.directory, ['add', 'README.md'])
    await git(created.directory, ['commit', '-m', 'detached work'])
    await git(created.directory, ['checkout', '--detach'])

    await assert.rejects(
      mergeWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
      }),
      /Worktree is detached/,
    )
    assert.equal(
      (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${created.branch}`])).exitCode,
      0,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree creation initializes a submodule commit available only from the source checkout', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-submodule-'))
  const root = path.join(sandbox, 'parent')
  const submoduleRemote = path.join(sandbox, 'module.git')
  const submoduleLocal = path.join(sandbox, 'module-local')
  const dataRoot = path.join(sandbox, 'data')
  const sourceSubmodule = path.join(root, 'deps', 'module')
  try {
    await mkdir(root, { recursive: true })
    await git(sandbox, ['init', '--bare', '-b', 'main', submoduleRemote])
    await git(sandbox, ['clone', submoduleRemote, submoduleLocal])
    await git(submoduleLocal, ['config', 'user.email', 'cordex@test.invalid'])
    await git(submoduleLocal, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(submoduleLocal, 'README.md'), 'remote commit\n')
    await git(submoduleLocal, ['add', 'README.md'])
    await git(submoduleLocal, ['commit', '-m', 'remote commit'])
    await git(submoduleLocal, ['push', 'origin', 'HEAD:main'])

    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'parent\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'parent'])
    await git(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleRemote,
      'deps/module',
    ])
    await git(root, ['commit', '-m', 'add submodule'])

    await writeFile(path.join(submoduleLocal, 'README.md'), 'local-only commit\n')
    await git(submoduleLocal, ['add', 'README.md'])
    await git(submoduleLocal, ['commit', '-m', 'local-only commit'])
    const localOnlySha = await gitOutput(submoduleLocal, ['rev-parse', 'HEAD'])
    await git(sourceSubmodule, ['fetch', submoduleLocal, 'main'])
    await git(sourceSubmodule, ['checkout', localOnlySha])
    await git(root, ['add', 'deps/module'])
    await git(root, ['commit', '-m', 'pin local-only submodule commit'])
    assert.notEqual((await runGit(submoduleRemote, ['cat-file', '-e', localOnlySha])).exitCode, 0)

    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'submodule' })
    const createdSubmodule = path.join(created.directory, 'deps', 'module')
    assert.equal(await gitOutput(createdSubmodule, ['rev-parse', 'HEAD']), localOnlySha)
    assert.equal(await readFile(path.join(createdSubmodule, 'README.md'), 'utf8'), 'local-only commit\n')
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('worktree creation and merged removal handle submodules without a source checkout', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-submodule-fallback-'))
  const root = path.join(sandbox, 'parent')
  const submoduleRemote = path.join(sandbox, 'module.git')
  const submoduleLocal = path.join(sandbox, 'module-local')
  const dataRoot = path.join(sandbox, 'data')
  try {
    await mkdir(root, { recursive: true })
    await git(sandbox, ['init', '--bare', '-b', 'main', submoduleRemote])
    await git(sandbox, ['clone', submoduleRemote, submoduleLocal])
    await git(submoduleLocal, ['config', 'user.email', 'cordex@test.invalid'])
    await git(submoduleLocal, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(submoduleLocal, 'README.md'), 'module\n')
    await git(submoduleLocal, ['add', 'README.md'])
    await git(submoduleLocal, ['commit', '-m', 'module'])
    await git(submoduleLocal, ['push', 'origin', 'HEAD:main'])

    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'parent\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'parent'])
    await git(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleRemote,
      'deps/module',
    ])
    await git(root, ['commit', '-m', 'add submodule'])
    await git(root, ['submodule', 'deinit', '--force', '--', 'deps/module'])

    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'fallback' })
    assert.equal(
      await readFile(path.join(created.directory, 'deps', 'module', 'README.md'), 'utf8'),
      'module\n',
    )
    const merged = await mergeWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })
    assert.equal(merged.status, 'nothing-to-merge')
    assert.equal((await removeMergedWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })).status, 'removed')
    await assert.rejects(access(created.directory))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('worktree creation cleans up its branch and directory when submodule initialization fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-submodule-failure-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-submodule-failure-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    const head = await gitOutput(root, ['rev-parse', 'HEAD'])
    await writeFile(
      path.join(root, '.gitmodules'),
      `[submodule "broken"]\n\tpath = broken\n\turl = ${path.join(root, 'missing.git')}\n`,
    )
    await git(root, ['add', '.gitmodules'])
    await git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},broken`])
    await git(root, ['commit', '-m', 'add broken submodule'])

    const branch = formatWorktreeBranch('broken submodule')
    const directory = getManagedWorktreeDirectory({ dataRoot, projectDirectory: root, branch })
    await assert.rejects(
      createWorktree({ projectDirectory: root, dataRoot, name: 'broken submodule' }),
      /Submodule initialization failed for broken/,
    )
    await assert.rejects(access(directory))
    assert.equal(
      (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode,
      1,
    )
    assert.equal((await gitOutput(root, ['worktree', 'list', '--porcelain'])).includes(directory), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree base resolution uses a remote only when it is strictly ahead', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-base-'))
  const origin = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-origin-'))
  const upstream = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-upstream-'))
  const publisher = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-publisher-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-base-data-'))
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    await git(root, ['branch', 'local-ahead'])
    await git(root, ['branch', 'remote-ahead'])
    await git(root, ['branch', 'diverged'])
    await git(root, ['branch', 'multiple-remotes'])

    await git(origin, ['init', '--bare'])
    await git(upstream, ['init', '--bare'])
    await git(root, ['remote', 'add', 'origin', origin])
    await git(root, ['remote', 'add', 'upstream', upstream])
    for (const remote of ['origin', 'upstream']) {
      await git(root, [
        'push',
        remote,
        'main',
        'local-ahead',
        'remote-ahead',
        'diverged',
        'multiple-remotes',
      ])
    }

    assert.equal(await resolveBestBaseRef({ directory: root, branch: 'main' }), 'main')

    await git(root, ['checkout', 'local-ahead'])
    await writeFile(path.join(root, 'LOCAL.md'), 'local\n')
    await git(root, ['add', 'LOCAL.md'])
    await git(root, ['commit', '-m', 'local ahead'])
    assert.equal(await resolveBestBaseRef({ directory: root, branch: 'local-ahead' }), 'local-ahead')

    await git(tmpdir(), ['clone', '--branch', 'main', origin, publisher])
    await git(publisher, ['config', 'user.email', 'cordex@test.invalid'])
    await git(publisher, ['config', 'user.name', 'Cordex Test'])
    await git(publisher, ['checkout', '-b', 'remote-ahead', 'origin/remote-ahead'])
    await writeFile(path.join(publisher, 'REMOTE.md'), 'remote\n')
    await git(publisher, ['add', 'REMOTE.md'])
    await git(publisher, ['commit', '-m', 'remote ahead'])
    await git(publisher, ['push', 'origin', 'remote-ahead'])
    const remoteAheadRef = await resolveBestBaseRef({ directory: root, branch: 'remote-ahead' })
    assert.equal(remoteAheadRef, 'origin/remote-ahead')

    await git(root, ['checkout', 'diverged'])
    await writeFile(path.join(root, 'LOCAL-DIVERGED.md'), 'local\n')
    await git(root, ['add', 'LOCAL-DIVERGED.md'])
    await git(root, ['commit', '-m', 'local divergence'])
    await git(publisher, ['checkout', '-b', 'diverged', 'origin/diverged'])
    await writeFile(path.join(publisher, 'REMOTE-DIVERGED.md'), 'remote\n')
    await git(publisher, ['add', 'REMOTE-DIVERGED.md'])
    await git(publisher, ['commit', '-m', 'remote divergence'])
    await git(publisher, ['push', 'origin', 'diverged'])
    assert.equal(await resolveBestBaseRef({ directory: root, branch: 'diverged' }), 'diverged')

    await git(root, ['checkout', 'multiple-remotes'])
    await writeFile(path.join(root, 'LOCAL-MULTI.md'), 'local descendant\n')
    await git(root, ['add', 'LOCAL-MULTI.md'])
    await git(root, ['commit', '-m', 'local multiple-remotes commit'])
    await git(root, ['push', 'origin', 'multiple-remotes'])

    await git(publisher, ['remote', 'add', 'upstream', upstream])
    await git(publisher, ['fetch', 'upstream', 'multiple-remotes'])
    await git(publisher, ['checkout', '-B', 'upstream-diverged', 'upstream/multiple-remotes'])
    await writeFile(path.join(publisher, 'UPSTREAM-DIVERGED.md'), 'upstream divergence\n')
    await git(publisher, ['add', 'UPSTREAM-DIVERGED.md'])
    await git(publisher, ['commit', '-m', 'upstream divergence'])
    await git(publisher, ['push', 'upstream', 'HEAD:multiple-remotes'])

    await git(publisher, ['fetch', 'origin', 'multiple-remotes'])
    await git(publisher, ['checkout', '-B', 'origin-ahead', 'origin/multiple-remotes'])
    await writeFile(path.join(publisher, 'ORIGIN-AHEAD.md'), 'origin ahead\n')
    await git(publisher, ['add', 'ORIGIN-AHEAD.md'])
    await git(publisher, ['commit', '-m', 'origin strictly ahead'])
    await git(publisher, ['push', 'origin', 'HEAD:multiple-remotes'])
    assert.equal(
      await resolveBestBaseRef({ directory: root, branch: 'multiple-remotes' }),
      'origin/multiple-remotes',
    )

    await git(publisher, ['checkout', 'main'])
    await git(publisher, ['checkout', '-b', 'remote-only'])
    await writeFile(path.join(publisher, 'REMOTE-ONLY.md'), 'remote only\n')
    await git(publisher, ['add', 'REMOTE-ONLY.md'])
    await git(publisher, ['commit', '-m', 'remote only'])
    await git(publisher, ['push', 'origin', 'remote-only'])
    assert.equal(
      await resolveBestBaseRef({ directory: root, branch: 'remote-only' }),
      'origin/remote-only',
    )

    await git(publisher, ['checkout', 'main'])
    await writeFile(path.join(publisher, 'EXPLICIT-REMOTE.md'), 'explicit remote freshness\n')
    await git(publisher, ['add', 'EXPLICIT-REMOTE.md'])
    await git(publisher, ['commit', '-m', 'advance explicit remote ref'])
    await git(publisher, ['push', 'origin', 'main'])
    assert.equal(await resolveBestBaseRef({ directory: root, branch: 'origin/main' }), 'origin/main')
    assert.equal(
      await gitOutput(root, ['show', 'origin/main:EXPLICIT-REMOTE.md']),
      'explicit remote freshness',
    )

    const created = await createWorktree({
      projectDirectory: root,
      dataRoot,
      name: 'fresh remote base',
      baseRef: remoteAheadRef,
    })
    assert.equal(await gitOutput(created.directory, ['show', 'HEAD:REMOTE.md']), 'remote')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
    await rm(upstream, { recursive: true, force: true })
    await rm(publisher, { recursive: true, force: true })
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

test('worktree merge fast-forwards an explicit target without checking it out', async () => {
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
    assert.equal(branch.stdout, 'main')
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'base\n')
    assert.equal(
      await gitOutput(root, ['show', 'release:README.md']),
      'base\nrelease feature',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('worktree merge rejects an explicit target checked out in another worktree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-target-busy-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-target-busy-data-'))
  const releaseDirectory = path.join(dataRoot, 'release-checkout')
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    await git(root, ['branch', 'release'])
    const created = await createWorktree({ projectDirectory: root, dataRoot, name: 'busy-target' })
    await writeFile(path.join(created.directory, 'README.md'), 'base\nfeature\n')
    await git(created.directory, ['add', 'README.md'])
    await git(created.directory, ['commit', '-m', 'feature'])
    await git(root, ['worktree', 'add', releaseDirectory, 'release'])

    await assert.rejects(
      mergeWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
        targetBranch: 'release',
      }),
      /Merge target release is checked out/,
    )
    assert.equal(
      (await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${created.branch}`])).exitCode,
      0,
    )
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

test('git worktree inventory includes manual checkouts with exact status and divergence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-inventory-'))
  const linkedDirectory = await mkdtemp(path.join(tmpdir(), 'cordex manual worktree-'))
  await rm(linkedDirectory, { recursive: true, force: true })
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    await git(root, ['worktree', 'add', '-b', 'manual-feature', linkedDirectory])

    await writeFile(path.join(linkedDirectory, 'FEATURE.md'), 'feature\n')
    await git(linkedDirectory, ['add', 'FEATURE.md'])
    await git(linkedDirectory, ['commit', '-m', 'feature'])
    await writeFile(path.join(root, 'MAIN.md'), 'main moved\n')
    await git(root, ['add', 'MAIN.md'])
    await git(root, ['commit', '-m', 'advance main'])

    const mainHead = await gitOutput(root, ['rev-parse', 'main'])
    const featureHead = await gitOutput(linkedDirectory, ['rev-parse', 'HEAD'])
    const inventory = await listWorktreeInventory(root)
    assert.equal(inventory.length, 2)

    const main = inventory.find((entry) => entry.isMainWorktree)
    assert.ok(main)
    assert.equal(main.directory, path.resolve(root))
    assert.equal(main.head, mainHead)
    assert.equal(main.branch, 'refs/heads/main')
    assert.equal(main.detached, false)
    assert.equal(main.checkoutPresent, true)
    assert.equal(main.checkoutState, 'clean')
    assert.equal(main.clean, true)
    assert.deepEqual(main.comparison, {
      ref: 'refs/heads/main',
      head: mainHead,
      relation: 'same',
      ahead: 0,
      behind: 0,
      merged: true,
      containsComparison: true,
    })
    assert.equal(main.reachableFromLocalBranch, true)
    assert.ok(main.containingBranches?.includes('main'))
    assert.deepEqual(main.errors, [])

    const linked = inventory.find((entry) => entry.directory === path.resolve(linkedDirectory))
    assert.ok(linked)
    assert.equal(linked.isMainWorktree, false)
    assert.equal(linked.head, featureHead)
    assert.equal(linked.branch, 'refs/heads/manual-feature')
    assert.equal(linked.detached, false)
    assert.equal(linked.checkoutState, 'clean')
    assert.equal(linked.clean, true)
    assert.deepEqual(linked.comparison, {
      ref: 'refs/heads/main',
      head: mainHead,
      relation: 'diverged',
      ahead: 1,
      behind: 1,
      merged: false,
      containsComparison: false,
    })
    assert.deepEqual(linked.containingBranches, ['manual-feature'])
    assert.equal(linked.reachableFromLocalBranch, true)
    assert.deepEqual(linked.errors, [])

    await writeFile(path.join(linkedDirectory, 'UNTRACKED.md'), 'dirty\n')
    const dirty = (await listWorktreeInventory(root)).find(
      (entry) => entry.directory === path.resolve(linkedDirectory),
    )
    assert.ok(dirty)
    assert.equal(dirty.checkoutState, 'dirty')
    assert.equal(dirty.clean, false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(linkedDirectory, { recursive: true, force: true })
  }
})

test('git worktree inventory preserves detached, locked, and prunable registrations', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('inventory merged')
  const lockedDirectory = path.join(dataRoot, 'locked worktree')
  const missingDirectory = path.join(dataRoot, 'missing worktree')
  try {
    await commitAndMergeFixture(root, created)
    await git(root, ['branch', 'locked-branch'])
    await git(root, ['worktree', 'add', lockedDirectory, 'locked-branch'])
    await git(root, ['worktree', 'lock', '--reason', 'inventory test', lockedDirectory])
    await git(root, ['branch', 'missing-branch'])
    await git(root, ['worktree', 'add', missingDirectory, 'missing-branch'])
    await rm(missingDirectory, { recursive: true, force: true })

    const inventory = await listWorktreeInventory(root)
    assert.equal(inventory.length, 4)

    const merged = inventory.find((entry) => entry.directory === path.resolve(created.directory))
    assert.ok(merged)
    assert.equal(merged.detached, true)
    assert.equal(merged.branch, undefined)
    assert.equal(merged.checkoutState, 'clean')
    assert.equal(merged.clean, true)
    assert.equal(merged.comparison?.relation, 'same')
    assert.equal(merged.comparison?.merged, true)
    assert.equal(merged.reachableFromLocalBranch, true)
    assert.ok(merged.containingBranches?.includes('main'))

    const locked = inventory.find((entry) => entry.directory === path.resolve(lockedDirectory))
    assert.ok(locked)
    assert.equal(locked.locked, true)
    assert.equal(locked.lockedReason, 'inventory test')
    assert.equal(locked.checkoutPresent, true)
    assert.equal(locked.checkoutState, 'clean')

    const missing = inventory.find((entry) => entry.directory === path.resolve(missingDirectory))
    assert.ok(missing)
    assert.equal(missing.prunable, true)
    assert.match(missing.prunableReason || '', /non-existent location/)
    assert.equal(missing.checkoutPresent, false)
    assert.equal(missing.checkoutState, 'missing')
    assert.equal(missing.clean, null)
    assert.equal(missing.comparison?.relation, 'same')
    assert.equal(missing.comparison?.merged, true)
    assert.deepEqual(missing.errors, [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('git worktree inventory marks unrelated histories without invented ahead counts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-inventory-unrelated-'))
  const linkedDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-unrelated-'))
  await rm(linkedDirectory, { recursive: true, force: true })
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, ['config', 'user.email', 'cordex@test.invalid'])
    await git(root, ['config', 'user.name', 'Cordex Test'])
    await writeFile(path.join(root, 'README.md'), 'base\n')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'base'])
    const emptyTree = await gitOutput(root, ['mktree'])
    const unrelatedHead = await gitOutput(root, ['commit-tree', emptyTree, '-m', 'unrelated root'])
    await git(root, ['branch', 'unrelated', unrelatedHead])
    await git(root, ['worktree', 'add', linkedDirectory, 'unrelated'])

    const entry = (await listWorktreeInventory(root)).find(
      (candidate) => candidate.directory === path.resolve(linkedDirectory),
    )
    assert.ok(entry)
    assert.deepEqual(entry.comparison, {
      ref: 'refs/heads/main',
      head: await gitOutput(root, ['rev-parse', 'main']),
      relation: 'unrelated',
      ahead: null,
      behind: null,
      merged: false,
      containsComparison: false,
    })
    assert.deepEqual(entry.containingBranches, ['unrelated'])
    assert.deepEqual(entry.errors, [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(linkedDirectory, { recursive: true, force: true })
  }
})

test('git worktree inventory handles an unborn main branch without inventing a HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-worktree-inventory-unborn-'))
  try {
    await git(root, ['init', '-b', 'main'])
    const inventory = await listWorktreeInventory(root)
    assert.equal(inventory.length, 1)
    assert.deepEqual(inventory[0], {
      directory: path.resolve(root),
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMainWorktree: true,
      checkoutPresent: true,
      checkoutState: 'clean',
      clean: true,
      containingBranches: null,
      reachableFromLocalBranch: null,
      comparison: null,
      errors: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merged worktree removal is exact and idempotent', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('safe removal')
  try {
    await commitAndMergeFixture(root, created)
    const inspection = await inspectMergedWorktreeRemoval({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })
    assert.equal(inspection.status, 'ready')
    if (inspection.status === 'ready') {
      assert.equal(inspection.registration.detached, true)
      assert.equal(inspection.registration.branch, undefined)
      assert.deepEqual(inspection.containingBranches, ['main'])
      assert.equal(inspection.checkoutPresent, true)
    }

    const removed = await removeMergedWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })
    assert.equal(removed.status, 'removed')
    await assert.rejects(access(created.directory))
    assert.equal(
      (await listRegisteredWorktrees(root)).some(
        (registration) => registration.directory === path.resolve(created.directory),
      ),
      false,
    )

    assert.deepEqual(await removeMergedWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    }), {
      status: 'already-removed',
      directory: path.resolve(created.directory),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('merged worktree removal rejects a dirty checkout', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('dirty removal')
  try {
    await commitAndMergeFixture(root, created)
    await writeFile(path.join(created.directory, 'UNTRACKED.md'), 'keep me\n')
    await assert.rejects(
      removeMergedWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
      }),
      /uncommitted changes/,
    )
    await access(created.directory)
    assert.equal(
      (await listRegisteredWorktrees(root)).some(
        (registration) => registration.directory === path.resolve(created.directory),
      ),
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('merged worktree removal rejects a surviving feature branch', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('surviving branch')
  try {
    await commitAndMergeFixture(root, created)
    await git(root, ['branch', created.branch, 'HEAD'])
    await assert.rejects(
      removeMergedWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
      }),
      /feature branch still exists/,
    )
    await access(created.directory)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('merged worktree removal rejects an unreachable detached commit', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('unreachable commit')
  try {
    await writeFile(path.join(created.directory, 'README.md'), 'unmerged\n')
    await git(created.directory, ['add', 'README.md'])
    await git(created.directory, ['commit', '-m', 'unmerged'])
    await git(created.directory, ['checkout', '--detach'])
    await git(root, ['branch', '-D', created.branch])

    await assert.rejects(
      removeMergedWorktree({
        projectDirectory: root,
        worktreeDirectory: created.directory,
        branch: created.branch,
      }),
      /not merged into a local branch/,
    )
    await access(created.directory)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('merged worktree removal rejects an unregistered directory', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('registration mismatch')
  const unregistered = path.join(dataRoot, 'not-the-registered-worktree')
  try {
    await commitAndMergeFixture(root, created)
    await mkdir(unregistered, { recursive: true })
    await assert.rejects(
      removeMergedWorktree({
        projectDirectory: root,
        worktreeDirectory: unregistered,
        branch: created.branch,
      }),
      /not registered in this repository/,
    )
    await access(unregistered)
    await access(created.directory)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})

test('merged worktree removal reconciles a registered checkout already missing on disk', async () => {
  const { root, dataRoot, created } = await createWorktreeFixture('stale registration')
  try {
    await commitAndMergeFixture(root, created)
    await rm(created.directory, { recursive: true, force: true })
    const inspection = await inspectMergedWorktreeRemoval({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })
    assert.equal(inspection.status, 'ready')
    if (inspection.status === 'ready') assert.equal(inspection.checkoutPresent, false)

    assert.equal((await removeMergedWorktree({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    })).status, 'removed')
    assert.deepEqual(await inspectMergedWorktreeRemoval({
      projectDirectory: root,
      worktreeDirectory: created.directory,
      branch: created.branch,
    }), {
      status: 'already-removed',
      directory: path.resolve(created.directory),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
})
