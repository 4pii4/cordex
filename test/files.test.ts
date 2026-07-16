import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildFileAutocompleteChoices,
  parseFileArguments,
  parseFileAutocomplete,
  resolveProjectFiles,
} from '../src/files.js'

test('new-session file hints parse and validate project files', async () => {
  assert.deepEqual(parseFileArguments('src/a.ts, src/b.ts, src/a.ts'), ['src/a.ts', 'src/b.ts'])
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-files-'))
  try {
    await writeFile(path.join(root, 'README.md'), 'read me\n')
    await writeFile(path.join(root, 'My File.md'), 'spaces work\n')
    assert.deepEqual(await resolveProjectFiles(root, 'README.md'), ['README.md'])
    assert.deepEqual(await resolveProjectFiles(root, 'README.md, My File.md'), ['README.md', 'My File.md'])
    await assert.rejects(resolveProjectFiles(root, '../outside.txt'), /outside the project/)
    await assert.rejects(resolveProjectFiles(root, 'missing.txt'), /does not exist/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('new-session file autocomplete preserves comma-separated selections', () => {
  assert.deepEqual(parseFileAutocomplete('src/a.ts, discord'), {
    previousFiles: ['src/a.ts'],
    currentQuery: 'discord',
  })
  assert.deepEqual(
    buildFileAutocompleteChoices('src/a.ts, discord', [
      'src/discord-bot.ts',
      'src/discord-commands.ts',
    ]),
    [
      { name: 'a.ts, discord-bot.ts', value: 'src/a.ts, src/discord-bot.ts' },
      { name: 'a.ts, discord-commands.ts', value: 'src/a.ts, src/discord-commands.ts' },
    ],
  )
})

test('file autocomplete documents Discord choice limit while manual parsing stays available', () => {
  const previous = `${'a'.repeat(60)}.ts, ${'b'.repeat(38)}.ts`
  assert.deepEqual(buildFileAutocompleteChoices(`${previous}, next`, ['src/next.ts']), [])
  assert.deepEqual(parseFileArguments(`${previous}, src/next.ts`), [
    `${'a'.repeat(60)}.ts`,
    `${'b'.repeat(38)}.ts`,
    'src/next.ts',
  ])
})
