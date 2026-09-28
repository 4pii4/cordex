import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const maxDiscordOutgoingFiles = 10
export const maxDiscordOutgoingBytes = 8 * 1024 * 1024

export type OutgoingFileAttachment = {
  sha256: string
  size: number
  name: string
}

function withinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeFileName(value: string): string {
  const name = path.basename(value).replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()
  if (!name || name === '.' || name === '..') throw new Error('File has no safe attachment name')
  return [...name].slice(0, 100).join('')
}

export function validOutgoingFileAttachment(value: unknown): value is OutgoingFileAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isSafeInteger(record.size) && Number(record.size) >= 0 &&
    Number(record.size) <= maxDiscordOutgoingBytes &&
    typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 100 &&
    !/[\u0000-\u001f\u007f/\\]/.test(record.name) &&
    record.name !== '.' && record.name !== '..'
}

export function validOutgoingFileAttachments(value: unknown): value is OutgoingFileAttachment[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxDiscordOutgoingFiles &&
    value.every(validOutgoingFileAttachment) &&
    value.reduce((total, item) => total + Number(item.size), 0) <= maxDiscordOutgoingBytes
}

export async function readOutgoingFiles(options: {
  paths: string[]
  sessionDirectory: string
  allowOutsideProject: boolean
  rejectHidden?: boolean
}): Promise<Array<{ bytes: Buffer; attachment: OutgoingFileAttachment }>> {
  if (options.paths.length === 0 || options.paths.length > maxDiscordOutgoingFiles) {
    throw new Error(`Specify 1-${maxDiscordOutgoingFiles} files`)
  }
  const sessionRoot = await realpath(options.sessionDirectory)
  const results: Array<{ bytes: Buffer; attachment: OutgoingFileAttachment }> = []
  const names = new Set<string>()
  let total = 0
  for (const requested of options.paths) {
    if (!path.isAbsolute(requested)) throw new Error('Upload paths must be absolute')
    const resolved = await realpath(requested)
    if (!options.allowOutsideProject && !withinOrEqual(sessionRoot, resolved)) {
      throw new Error('File resolves outside the current session directory; use --allow-outside-project explicitly')
    }
    if (options.rejectHidden && path.relative(sessionRoot, resolved)
      .split(path.sep).some((segment) => segment.startsWith('.'))) {
      throw new Error('Upload tool cannot send hidden files or hidden directories')
    }
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('Upload source is not a regular file')
      if (info.size > maxDiscordOutgoingBytes - total) {
        throw new Error('Files exceed the 8 MiB Discord upload safety limit')
      }
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    if (bytes.length > maxDiscordOutgoingBytes - total) {
      throw new Error('Files exceed the 8 MiB Discord upload safety limit')
    }
    total += bytes.length
    const digest = createHash('sha256').update(bytes).digest('hex')
    let name = safeFileName(resolved)
    if (names.has(name)) {
      const extension = path.extname(name)
      const stem = name.slice(0, name.length - extension.length)
      name = `${[...stem].slice(0, 85).join('')}-${digest.slice(0, 8)}${extension}`
    }
    names.add(name)
    results.push({ bytes, attachment: { sha256: digest, size: bytes.length, name } })
  }
  return results
}

async function ensureCacheDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) throw new Error('Outgoing-file cache is not a directory')
}

function cachePath(directory: string, attachment: OutgoingFileAttachment): string {
  return path.join(directory, attachment.sha256)
}

export async function cacheOutgoingFile(
  directory: string,
  bytes: Buffer,
  attachment: OutgoingFileAttachment,
): Promise<void> {
  await ensureCacheDirectory(directory)
  const destination = cachePath(directory, attachment)
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readCachedOutgoingFile(directory, attachment)
    if (!existing.equals(bytes)) throw new Error('Outgoing-file cache hash collision')
  }
}

export async function readCachedOutgoingFile(
  directory: string,
  attachment: OutgoingFileAttachment,
): Promise<Buffer> {
  const source = cachePath(directory, attachment)
  const info = await lstat(source)
  if (!info.isFile() || info.size !== attachment.size) {
    throw new Error('Outgoing-file cache file is missing or has changed')
  }
  const bytes = await readFile(source)
  if (
    bytes.length !== attachment.size ||
    createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
  ) {
    throw new Error('Outgoing-file cache content does not match the queued attachment')
  }
  return bytes
}

export async function pruneOutgoingFileCache(
  directory: string,
  referenced: Iterable<OutgoingFileAttachment>,
): Promise<number> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Outgoing-file cache is not a directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const entries = await readdir(directory, { withFileTypes: true })
  const protectedNames = new Set(Array.from(referenced, (attachment) => attachment.sha256))
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
    if (protectedNames.has(entry.name)) continue
    await unlink(path.join(directory, entry.name))
    removed++
  }
  return removed
}
