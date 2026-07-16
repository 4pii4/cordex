import assert from 'node:assert/strict'
import test from 'node:test'
import type { JsonObject } from '../src/types.js'
import {
  applyContextUsage,
  contextUsagePercent,
  formatContextUsage,
  isContextTokenCount,
  isContextWindowSize,
  parseContextUsage,
} from '../src/context-usage.js'

const breakdown = (totalTokens: number): JsonObject => ({
  totalTokens,
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
})

const payload = (options: {
  threadId?: unknown
  turnId?: unknown
  total?: unknown
  last?: unknown
  modelContextWindow?: unknown
  omitModelContextWindow?: boolean
} = {}): JsonObject => ({
  threadId: Object.hasOwn(options, 'threadId') ? options.threadId : 'thread-1',
  turnId: Object.hasOwn(options, 'turnId') ? options.turnId : 'turn-1',
  tokenUsage: {
    total: Object.hasOwn(options, 'total') ? options.total : breakdown(90_000),
    last: Object.hasOwn(options, 'last') ? options.last : breakdown(32_000),
    ...(options.omitModelContextWindow
      ? {}
      : {
          modelContextWindow: Object.hasOwn(options, 'modelContextWindow')
            ? options.modelContextWindow
            : 128_000,
        }),
  },
})

test('parseContextUsage uses last.totalTokens, not cumulative totalTokens', () => {
  assert.deepEqual(parseContextUsage(payload()), {
    threadId: 'thread-1',
    turnId: 'turn-1',
    contextTokens: 32_000,
    contextWindow: 128_000,
  })
})

test('parseContextUsage accepts zero usage and an explicit unknown window', () => {
  assert.deepEqual(parseContextUsage(payload({
    total: breakdown(10),
    last: breakdown(0),
    modelContextWindow: null,
  })), {
    threadId: 'thread-1',
    turnId: 'turn-1',
    contextTokens: 0,
    contextWindow: null,
  })
})

test('parseContextUsage accepts an empty turn id used by unattributed replay events', () => {
  assert.deepEqual(parseContextUsage(payload({ turnId: '' })), {
    threadId: 'thread-1',
    turnId: '',
    contextTokens: 32_000,
    contextWindow: 128_000,
  })
})

test('parseContextUsage rejects an absent context-window field', () => {
  assert.equal(parseContextUsage(payload({ omitModelContextWindow: true })), undefined)
})

test('parseContextUsage rejects malformed protocol payloads', () => {
  const cases: Array<[string, JsonObject]> = [
    ['missing thread id', payload({ threadId: undefined })],
    ['empty thread id', payload({ threadId: '   ' })],
    ['padded thread id', payload({ threadId: ' thread-1 ' })],
    ['non-string thread id', payload({ threadId: 1 })],
    ['missing turn id', payload({ turnId: undefined })],
    ['whitespace-only turn id', payload({ turnId: '   ' })],
    ['padded turn id', payload({ turnId: ' turn-1 ' })],
    ['non-string turn id', payload({ turnId: false })],
    ['null tokenUsage', { ...payload(), tokenUsage: null }],
    ['array tokenUsage', { ...payload(), tokenUsage: [] }],
    ['missing total breakdown', payload({ total: undefined })],
    ['null total breakdown', payload({ total: null })],
    ['partial total breakdown', payload({ total: { totalTokens: 1 } })],
    ['invalid total input tokens', payload({ total: { ...breakdown(1), inputTokens: -1 } })],
    ['missing last breakdown', payload({ last: undefined })],
    ['null last breakdown', payload({ last: null })],
    ['partial last breakdown', payload({ last: { totalTokens: 1 } })],
    ['invalid last cached tokens', payload({ last: { ...breakdown(1), cachedInputTokens: 1.5 } })],
    ['missing model context window', payload({ omitModelContextWindow: true })],
    ['string model context window', payload({ modelContextWindow: '128000' })],
    ['zero model context window', payload({ modelContextWindow: 0 })],
    ['negative model context window', payload({ modelContextWindow: -1 })],
    ['fractional model context window', payload({ modelContextWindow: 1.5 })],
    ['NaN model context window', payload({ modelContextWindow: NaN })],
    ['non-finite model context window', payload({ modelContextWindow: Infinity })],
    ['unsafe model context window', payload({ modelContextWindow: Number.MAX_SAFE_INTEGER + 1 })],
    ['missing last total tokens', payload({ last: { ...breakdown(1), totalTokens: undefined } })],
    ['string last total tokens', payload({ last: { ...breakdown(1), totalTokens: '1' } })],
    ['negative last total tokens', payload({ last: { ...breakdown(1), totalTokens: -1 } })],
    ['fractional last total tokens', payload({ last: { ...breakdown(1), totalTokens: 1.5 } })],
    ['non-finite last total tokens', payload({ last: { ...breakdown(1), totalTokens: NaN } })],
    ['unsafe last total tokens', payload({ last: { ...breakdown(1), totalTokens: Number.MAX_SAFE_INTEGER + 1 } })],
  ]

  for (const [label, candidate] of cases) {
    assert.equal(parseContextUsage(candidate), undefined, label)
  }
})

test('context count and window guards accept only safe integer protocol values', () => {
  assert.equal(isContextTokenCount(0), true)
  assert.equal(isContextTokenCount(Number.MAX_SAFE_INTEGER), true)
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.equal(isContextTokenCount(value), false, `token value ${String(value)}`)
  }

  assert.equal(isContextWindowSize(1), true)
  assert.equal(isContextWindowSize(Number.MAX_SAFE_INTEGER), true)
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.equal(isContextWindowSize(value), false, `window value ${String(value)}`)
  }
})

test('contextUsagePercent rounds used percentage without capping over-window usage', () => {
  assert.equal(contextUsagePercent(0, 128_000), 0)
  assert.equal(contextUsagePercent(32_000, 128_000), 25)
  assert.equal(contextUsagePercent(64_640, 128_000), 51)
  assert.equal(contextUsagePercent(130_000, 128_000), 102)
  assert.equal(contextUsagePercent(32_000, null), undefined)
  assert.equal(contextUsagePercent(32_000, undefined), undefined)
  assert.equal(contextUsagePercent(-1, 128_000), undefined)
})

test('formatContextUsage preserves raw tokens and reports an unavailable limit', () => {
  assert.equal(
    formatContextUsage({ contextTokens: 32_000, contextWindow: 128_000 }),
    '25%, 32,000 / 128,000 tokens',
  )
  assert.equal(
    formatContextUsage({ contextTokens: 130_000, contextWindow: 128_000 }),
    '102%, 130,000 / 128,000 tokens',
  )
  assert.equal(
    formatContextUsage({ contextTokens: 32_000 }),
    '32,000 tokens (context limit unavailable)',
  )
  assert.equal(
    formatContextUsage({ contextTokens: 32_000, contextWindow: 0 }),
    '32,000 tokens (context limit unavailable)',
  )
  assert.equal(formatContextUsage({ contextTokens: -1, contextWindow: 128_000 }), undefined)
})

test('applyContextUsage stores raw counts and clears an explicitly unknown window', () => {
  const session: { contextTokens?: number; contextWindow?: number } = {
    contextTokens: 10,
    contextWindow: 100,
  }
  applyContextUsage(session, { contextTokens: 130, contextWindow: 128 })
  assert.deepEqual(session, { contextTokens: 130, contextWindow: 128 })

  applyContextUsage(session, { contextTokens: 131, contextWindow: null })
  assert.deepEqual(session, { contextTokens: 131 })
})
