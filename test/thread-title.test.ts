import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultThreadTitle,
  normalizeThreadTitle,
  threadTitleMaxLength,
} from '../src/thread-title.js'

test('thread titles collapse whitespace and fall back when empty', () => {
  assert.equal(normalizeThreadTitle('  Build\n\t the   feature  '), 'Build the feature')
  assert.equal(normalizeThreadTitle(' \n\t '), defaultThreadTitle)
})

test('thread titles preserve the limit and truncate the final decorated title', () => {
  const exact = 'a'.repeat(threadTitleMaxLength)
  assert.equal(normalizeThreadTitle(exact), exact)

  const decorated = `\u2b26 ${'b'.repeat(threadTitleMaxLength)}`
  const normalized = normalizeThreadTitle(decorated)
  assert.equal(normalized.length, threadTitleMaxLength)
  assert.equal(normalized, `\u2b26 ${'b'.repeat(threadTitleMaxLength - 3)}\u2026`)

  const emojiBoundary = normalizeThreadTitle(`${'a'.repeat(78)}\ud83d\ude00bc`)
  assert.equal(Array.from(emojiBoundary).length, threadTitleMaxLength)
  assert.equal(emojiBoundary, `${'a'.repeat(78)}\ud83d\ude00\u2026`)
})
