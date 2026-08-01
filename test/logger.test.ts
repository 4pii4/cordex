import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogger } from '../src/logger.js'

type LogRecord = {
  timestamp: string
  level: string
  component: string
  event: string
  metadata?: Record<string, unknown>
  error?: {
    name: string
    message: string
    stack?: string
  }
}

function parseRecord(line: string): LogRecord {
  return JSON.parse(line) as LogRecord
}

test('structured logger gates routine records while always emitting warnings and errors', () => {
  const lines: string[] = []
  const logger = createLogger('fixture', {
    now: () => new Date('2026-08-01T12:34:56.789Z'),
    write: (line) => lines.push(line),
  })

  logger.debug('poll', { count: 1 })
  logger.info('ready', { pid: 42 })
  logger.warn('retry', { attempt: 2 })
  logger.error('terminal_failure', new Error('fixture failure'), { attempts: 3 })

  assert.equal(lines.length, 2)
  assert.deepEqual(parseRecord(lines[0]!), {
    timestamp: '2026-08-01T12:34:56.789Z',
    level: 'warn',
    component: 'fixture',
    event: 'retry',
    metadata: { attempt: 2 },
  })

  const failure = parseRecord(lines[1]!)
  assert.equal(failure.level, 'error')
  assert.equal(failure.component, 'fixture')
  assert.equal(failure.event, 'terminal_failure')
  assert.deepEqual(failure.metadata, { attempts: 3 })
  assert.equal(failure.error?.name, 'Error')
  assert.equal(failure.error?.message, 'fixture failure')
  assert.match(failure.error?.stack ?? '', /Error: fixture failure/)
})

test('structured logger redacts and bounds metadata without failing on hostile values', () => {
  const lines: string[] = []
  const logger = createLogger('fixture', {
    verbose: true,
    write: (line) => lines.push(line),
  })
  const circular: Record<string, unknown> = { safe: 'visible' }
  circular.self = circular
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'throwing', {
    enumerable: true,
    get() {
      throw new Error('getter must not run')
    },
  })

  assert.doesNotThrow(() => {
    logger.info('rpc_request', {
      method: 'turn/start',
      authorization: 'Bearer top-secret',
      accessToken: 'token-secret',
      prompt: 'private prompt',
      command: 'private shell command',
      toolInput: { command: 'private command' },
      longValue: 'x'.repeat(20_000),
      circular,
      hostile,
      unsupported: 12n,
    })
  })

  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0]!, 'utf8') <= 8_192)
  assert.doesNotMatch(
    lines[0]!,
    /top-secret|token-secret|private prompt|private shell command|private command/,
  )

  const record = parseRecord(lines[0]!)
  assert.equal(record.level, 'info')
  assert.equal(record.metadata?.method, 'turn/start')
  assert.equal(record.metadata?.authorization, '[REDACTED]')
  assert.equal(record.metadata?.accessToken, '[REDACTED]')
  assert.equal(record.metadata?.prompt, '[REDACTED]')
  assert.equal(record.metadata?.command, '[REDACTED]')
  assert.equal(record.metadata?.toolInput, '[REDACTED]')
  assert.equal((record.metadata?.circular as Record<string, unknown>)?.self, '[Circular]')
  assert.deepEqual(record.metadata?.hostile, { throwing: '[Accessor]' })
  assert.equal(record.metadata?.unsupported, '12n')
  assert.match(String(record.metadata?.longValue), /\[truncated\]$/)
})

test('structured logger caps Error fields and redacts inline credentials', () => {
  const lines: string[] = []
  const logger = createLogger('fixture', { write: (line) => lines.push(line) })
  const error = new Error('request failed with token=visible-secret')
  error.stack = `Error: token=visible-secret\n${'frame\n'.repeat(2_000)}`

  logger.error('request_failed', error)

  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0]!, 'utf8') <= 8_192)
  assert.doesNotMatch(lines[0]!, /visible-secret/)
  const record = parseRecord(lines[0]!)
  assert.equal(record.error?.message, 'request failed with token=[REDACTED]')
  assert.match(record.error?.stack ?? '', /\[truncated\]$/)
})
