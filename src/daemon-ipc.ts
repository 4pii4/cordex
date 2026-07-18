import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { getCordexHome } from './config.js'
import { defaultDiscordInputLimits } from './discord-input.js'
import type { UserInput } from './types.js'

const protocolVersion = 1
const maxRequestBytes = defaultDiscordInputLimits.messageTextCharacters * 6 + 16 * 1_024
const maxResponseBytes = 64 * 1_024
const defaultRequestTimeoutMs = 15_000
const discordSnowflake = /^\d{17,20}$/
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

const imageMimeByExtension = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

const imageExtensionByMime = new Map([
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
])

export type CordexDaemonSendRequest = {
  requestId: string
  target: {
    kind: 'thread' | 'channel'
    id: string
  }
  prompt: string
  filePath?: string
}

export type CordexDaemonSendResult = {
  threadId: string
  position: number
}

export type CordexDaemonIpcServer = {
  socketPath: string
  tokenPath: string
  close(): Promise<void>
}

type RequestEnvelope = {
  version: 1
  token: string
  method: 'send'
  request: CordexDaemonSendRequest
}

type ResponseEnvelope = {
  version: 1
  requestId?: string
  ok: boolean
  result?: CordexDaemonSendResult
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ipcDirectory(home = getCordexHome()): string {
  return path.resolve(home, 'ipc')
}

export function getCordexDaemonSocketPath(home = getCordexHome()): string {
  return path.join(ipcDirectory(home), 'daemon.sock')
}

export function getCordexDaemonTokenPath(home = getCordexHome()): string {
  return path.join(ipcDirectory(home), 'daemon.token')
}

function authenticated(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function validateSendRequest(value: unknown): CordexDaemonSendRequest {
  if (!isRecord(value)) throw new Error('Invalid daemon send request')
  const requestId = value.requestId
  const target = value.target
  const prompt = value.prompt
  const filePath = value.filePath
  if (typeof requestId !== 'string' || !requestIdPattern.test(requestId)) {
    throw new Error('Invalid daemon request ID')
  }
  if (
    !isRecord(target) ||
    (target.kind !== 'thread' && target.kind !== 'channel') ||
    typeof target.id !== 'string' ||
    !discordSnowflake.test(target.id)
  ) {
    throw new Error('Target must contain a valid Discord thread or channel ID')
  }
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    prompt.length > defaultDiscordInputLimits.messageTextCharacters
  ) {
    throw new Error(
      `Prompt must contain 1-${defaultDiscordInputLimits.messageTextCharacters} characters`,
    )
  }
  if (
    filePath !== undefined &&
    (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 4_096)
  ) {
    throw new Error('File path must be an absolute local path')
  }
  return {
    requestId,
    target: { kind: target.kind, id: target.id },
    prompt,
    ...(typeof filePath === 'string' ? { filePath } : {}),
  }
}

function parseRequestEnvelope(raw: string, token: string): CordexDaemonSendRequest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Invalid daemon request JSON')
  }
  if (!isRecord(value) || typeof value.token !== 'string' || !authenticated(value.token, token)) {
    throw new Error('Daemon authentication failed')
  }
  if (value.version !== protocolVersion || value.method !== 'send') {
    throw new Error('Unsupported daemon IPC request')
  }
  return validateSendRequest(value.request)
}

function parseResponseEnvelope(raw: string, requestId: string): CordexDaemonSendResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Cordex daemon returned invalid JSON')
  }
  if (!isRecord(value) || value.version !== protocolVersion || value.requestId !== requestId) {
    throw new Error('Cordex daemon returned an invalid response')
  }
  if (value.ok !== true) {
    throw new Error(typeof value.error === 'string' ? value.error : 'Cordex daemon rejected the request')
  }
  if (
    !isRecord(value.result) ||
    typeof value.result.threadId !== 'string' ||
    !discordSnowflake.test(value.result.threadId) ||
    !Number.isSafeInteger(value.result.position) ||
    Number(value.result.position) < 0
  ) {
    throw new Error('Cordex daemon returned an invalid send result')
  }
  return {
    threadId: value.result.threadId,
    position: Number(value.result.position),
  }
}

function readSocketLine(socket: Socket, limit: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      socket.setTimeout(0)
    }
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value || '')
    }
    const consume = (allowUnterminated: boolean) => {
      const newline = buffer.indexOf('\n')
      if (newline < 0 && !allowUnterminated) return
      const line = newline < 0 ? buffer : buffer.slice(0, newline)
      const trailing = newline < 0 ? '' : buffer.slice(newline + 1)
      if (trailing.trim()) {
        finish(new Error('Daemon IPC accepts exactly one request per connection'))
        return
      }
      finish(undefined, line)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > limit) {
        finish(new Error('Daemon IPC message exceeds the size limit'))
        return
      }
      consume(false)
    }
    const onEnd = () => consume(true)
    const onError = (error: Error) => finish(error)
    const onTimeout = () => finish(new Error('Timed out waiting for the Cordex daemon'))
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}

function responsePayload(response: ResponseEnvelope): string {
  return `${JSON.stringify(response)}\n`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
}

export async function startCordexDaemonIpc(options: {
  onSend(request: CordexDaemonSendRequest): Promise<CordexDaemonSendResult>
  home?: string
  requestTimeoutMs?: number
}): Promise<CordexDaemonIpcServer> {
  const directory = ipcDirectory(options.home)
  const socketPath = getCordexDaemonSocketPath(options.home)
  const tokenPath = getCordexDaemonTokenPath(options.home)
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await unlink(socketPath).catch(() => undefined)
  await unlink(tokenPath).catch(() => undefined)
  const token = randomBytes(32).toString('hex')
  await writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 })

  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    void (async () => {
      let requestId: string | undefined
      try {
        const raw = await readSocketLine(socket, maxRequestBytes, requestTimeoutMs)
        const request = parseRequestEnvelope(raw, token)
        requestId = request.requestId
        const result = await options.onSend(request)
        socket.end(responsePayload({
          version: protocolVersion,
          requestId,
          ok: true,
          result,
        }))
      } catch (error) {
        socket.end(responsePayload({
          version: protocolVersion,
          ...(requestId ? { requestId } : {}),
          ok: false,
          error: errorText(error),
        }))
      }
    })()
  })

  try {
    server.listen(socketPath)
    await once(server, 'listening')
    await chmod(socketPath, 0o600)
  } catch (error) {
    await closeServer(server).catch(() => undefined)
    await unlink(socketPath).catch(() => undefined)
    await unlink(tokenPath).catch(() => undefined)
    throw error
  }

  let closed = false
  return {
    socketPath,
    tokenPath,
    async close() {
      if (closed) return
      closed = true
      await closeServer(server)
      await unlink(socketPath).catch(() => undefined)
      const currentToken = await readFile(tokenPath, 'utf8').catch(() => undefined)
      if (currentToken?.trim() === token) await unlink(tokenPath).catch(() => undefined)
    },
  }
}

export async function sendCordexDaemonPrompt(
  request: CordexDaemonSendRequest,
  options: { home?: string; timeoutMs?: number } = {},
): Promise<CordexDaemonSendResult> {
  const validated = validateSendRequest(request)
  const socketPath = getCordexDaemonSocketPath(options.home)
  const tokenPath = getCordexDaemonTokenPath(options.home)
  const token = await readFile(tokenPath, 'utf8')
    .then((value) => value.trim())
    .catch(() => {
      throw new Error('Cordex daemon is not running; start it with `cordex start`')
    })
  if (!token) throw new Error('Cordex daemon authentication token is unavailable')
  const envelope: RequestEnvelope = {
    version: protocolVersion,
    token,
    method: 'send',
    request: validated,
  }
  const socket = createConnection(socketPath)
  socket.on('error', () => undefined)
  try {
    const response = readSocketLine(
      socket,
      maxResponseBytes,
      options.timeoutMs ?? defaultRequestTimeoutMs,
    )
    await once(socket, 'connect')
    socket.write(`${JSON.stringify(envelope)}\n`)
    return parseResponseEnvelope(await response, validated.requestId)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      throw new Error('Cordex daemon is not running; start it with `cordex start`')
    }
    throw error
  } finally {
    socket.destroy()
  }
}

function matchesImageSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  }
  if (mime === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mime === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mime === 'image/webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

async function persistLocalImage(home: string, mime: string, bytes: Buffer): Promise<string> {
  const extension = imageExtensionByMime.get(mime)
  if (!extension) throw new Error(`Unsupported image type: ${mime}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = path.resolve(home, 'attachments')
  const target = path.join(directory, `${digest}${extension}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return target
}

export async function materializeCordexDaemonInput(options: {
  prompt: string
  filePath?: string
  home?: string
}): Promise<{ input: UserInput[]; displayText: string }> {
  const prompt = options.prompt
  if (!prompt.trim() || prompt.length > defaultDiscordInputLimits.messageTextCharacters) {
    throw new Error(
      `Prompt must contain 1-${defaultDiscordInputLimits.messageTextCharacters} characters`,
    )
  }
  if (!options.filePath) {
    return {
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      displayText: prompt.trim(),
    }
  }

  const source = await realpath(options.filePath).catch(() => {
    throw new Error(`File not found: ${options.filePath}`)
  })
  const metadata = await stat(source)
  if (!metadata.isFile()) throw new Error(`Not a regular file: ${options.filePath}`)
  const extension = path.extname(source).toLowerCase()
  const imageMime = imageMimeByExtension.get(extension)
  const limit = imageMime
    ? defaultDiscordInputLimits.imageAttachmentBytes
    : defaultDiscordInputLimits.textAttachmentBytes
  if (metadata.size > limit) {
    throw new Error(`File exceeds the ${limit}-byte ${imageMime ? 'image' : 'text'} limit`)
  }
  const bytes = await readFile(source)
  if (bytes.length > limit) {
    throw new Error(`File exceeds the ${limit}-byte ${imageMime ? 'image' : 'text'} limit`)
  }

  const displayText = `${prompt.trim()} [${path.basename(source)}]`
  if (imageMime) {
    if (!matchesImageSignature(imageMime, bytes)) {
      throw new Error(`File content does not match its ${extension} image extension`)
    }
    const localPath = await persistLocalImage(options.home || getCordexHome(), imageMime, bytes)
    return {
      input: [
        { type: 'text', text: prompt, text_elements: [] },
        { type: 'localImage', path: localPath },
      ],
      displayText,
    }
  }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Only UTF-8 text files and PNG, JPEG, GIF, or WebP images are supported')
  }
  if (content.includes('\u0000')) {
    throw new Error('Only UTF-8 text files and PNG, JPEG, GIF, or WebP images are supported')
  }
  const combined = [
    prompt,
    `Local CLI attachment ${JSON.stringify(path.basename(source))} (${bytes.length} bytes):`,
    content || '[empty file]',
  ].join('\n\n')
  if (combined.length > defaultDiscordInputLimits.messageTextCharacters) {
    throw new Error(
      `Prompt and file exceed the ${defaultDiscordInputLimits.messageTextCharacters}-character input limit`,
    )
  }
  return {
    input: [{ type: 'text', text: combined, text_elements: [] }],
    displayText,
  }
}
