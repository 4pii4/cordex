export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LoggerOptions = {
  verbose?: boolean
  write?: (line: string) => void
  now?: () => Date
}

type LogMetadata = Record<string, unknown>

type ErrorRecord = {
  name: string
  message: string
  stack?: string
}

type LogRecord = {
  timestamp: string
  level: LogLevel
  component: string
  event: string
  metadata?: LogMetadata
  error?: ErrorRecord
}

const MAX_LINE_BYTES = 8_192
const MAX_STRING_BYTES = 1_024
const MAX_STACK_BYTES = 4_096
const MAX_DEPTH = 4
const MAX_OBJECT_KEYS = 32
const MAX_ARRAY_ITEMS = 20
const REDACTED = '[REDACTED]'

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const suffix = '...[truncated]'
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8')
  let used = 0
  let output = ''
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > budget) break
    output += character
    used += bytes
  }
  return `${output}${suffix}`
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(authorization|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
}

function boundedString(value: string, maxBytes = MAX_STRING_BYTES): string {
  return truncateUtf8(redactInlineSecrets(value), maxBytes)
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized.includes('password') ||
    normalized === 'passwd' ||
    normalized.includes('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey')
  ) {
    return true
  }
  if (
    normalized === 'prompt' ||
    normalized.endsWith('prompt') ||
    normalized === 'params' ||
    normalized === 'payload' ||
    normalized === 'input' ||
    normalized === 'output' ||
    normalized === 'command' ||
    normalized === 'arguments' ||
    normalized === 'result'
  ) {
    return true
  }
  return normalized.includes('tool') && (
    normalized.includes('input') ||
    normalized.includes('output') ||
    normalized.includes('argument') ||
    normalized.includes('result')
  )
}

function errorString(error: Error, field: 'name' | 'message' | 'stack'): string | undefined {
  try {
    const value = error[field]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function sanitizeError(error: Error): ErrorRecord {
  const name = boundedString(errorString(error, 'name') || 'Error', 128)
  const message = boundedString(errorString(error, 'message') || 'Unknown error')
  const stack = errorString(error, 'stack')
  return {
    name,
    message,
    ...(stack ? { stack: boundedString(stack, MAX_STACK_BYTES) } : {}),
  }
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return boundedString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'symbol') return boundedString(String(value))
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (value instanceof Error) return sanitizeError(value)
  if (value instanceof Date) {
    try {
      return value.toISOString()
    } catch {
      return '[Invalid Date]'
    }
  }
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array depth limit]' : '[Object depth limit]'
  if (seen.has(value)) return '[Circular]'

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen))
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
      }
      return items
    }

    const output: LogMetadata = {}
    let descriptors: PropertyDescriptorMap
    try {
      descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
      return '[Uninspectable object]'
    }
    const keys = Object.keys(descriptors)
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      const outputKey = boundedString(key, 128)
      if (shouldRedactKey(key)) {
        output[outputKey] = REDACTED
        continue
      }
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) {
        output[outputKey] = '[Accessor]'
        continue
      }
      output[outputKey] = sanitizeValue(descriptor.value, depth + 1, seen)
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      output._truncatedKeys = keys.length - MAX_OBJECT_KEYS
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function sanitizeMetadata(metadata: LogMetadata): LogMetadata {
  return sanitizeValue(metadata, 0, new Set()) as LogMetadata
}

export class StructuredLogger {
  private readonly component: string
  private readonly verbose: boolean
  private readonly write: (line: string) => void
  private readonly now: () => Date

  constructor(component: string, options: LoggerOptions = {}) {
    this.component = boundedString(component, 128)
    this.verbose = options.verbose === true
    this.write = options.write ?? ((line) => console.error(line))
    this.now = options.now ?? (() => new Date())
  }

  debug(event: string, metadata?: LogMetadata): void {
    this.emit('debug', event, metadata)
  }

  info(event: string, metadata?: LogMetadata): void {
    this.emit('info', event, metadata)
  }

  warn(event: string, metadata?: LogMetadata): void {
    this.emit('warn', event, metadata)
  }

  error(event: string, error: unknown, metadata?: LogMetadata): void {
    this.emit('error', event, metadata, error)
  }

  private emit(level: LogLevel, event: string, metadata?: LogMetadata, error?: unknown): void {
    if (!this.verbose && level !== 'warn' && level !== 'error') return
    let timestamp: string
    try {
      timestamp = this.now().toISOString()
    } catch {
      timestamp = new Date().toISOString()
    }
    const record: LogRecord = {
      timestamp,
      level,
      component: this.component,
      event: boundedString(event, 192),
      ...(metadata ? { metadata: sanitizeMetadata(metadata) } : {}),
      ...(error instanceof Error
        ? { error: sanitizeError(error) }
        : error === undefined
          ? {}
          : { error: { name: 'Error', message: boundedString(String(error)) } }),
    }
    let line = JSON.stringify(record)
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      line = JSON.stringify({
        ...record,
        ...(record.metadata ? { metadata: { _truncated: 'log size limit' } } : {}),
      })
    }
    try {
      this.write(line)
    } catch {
      // Diagnostics must not take down the runtime they are describing.
    }
  }
}

export function createLogger(component: string, options?: LoggerOptions): StructuredLogger {
  return new StructuredLogger(component, options)
}
