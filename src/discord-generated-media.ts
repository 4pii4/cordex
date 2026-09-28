import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const maxDiscordGeneratedImageBytes = 8 * 1024 * 1024

export type GeneratedImageAttachment = {
  sha256: string
  format: 'png' | 'jpg' | 'webp'
  size: number
}

function imageFormat(bytes: Buffer): GeneratedImageAttachment['format'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg'
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return undefined
}

export function decodeGeneratedImage(result: unknown): {
  bytes: Buffer
  attachment: GeneratedImageAttachment
} {
  if (typeof result !== 'string' || !result) {
    throw new Error('Codex returned no image bytes')
  }
  if (result.length > Math.ceil(maxDiscordGeneratedImageBytes / 3) * 4 + 128 * 1024) {
    throw new Error('Codex image bytes exceed the 8 MiB Discord upload limit')
  }
  const dataUrl = /^data:image\/(png|jpeg|webp);base64,/i.exec(result)
  if (result.startsWith('data:') && !dataUrl) {
    throw new Error('Codex returned an unsupported image data URL')
  }
  const base64 = result.slice(dataUrl?.[0].length || 0).replace(/\s/g, '')
  if (
    base64.length > Math.ceil(maxDiscordGeneratedImageBytes / 3) * 4 + 4 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new Error('Codex image bytes are invalid or exceed the 8 MiB Discord upload limit')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length > maxDiscordGeneratedImageBytes) {
    throw new Error('Codex image bytes are empty or exceed the 8 MiB Discord upload limit')
  }
  const format = imageFormat(bytes)
  if (!format || (dataUrl && (dataUrl[1]?.toLowerCase() === 'jpeg' ? 'jpg' : dataUrl[1]?.toLowerCase()) !== format)) {
    throw new Error('Codex returned an unsupported or mismatched image format')
  }
  return {
    bytes,
    attachment: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      format,
      size: bytes.length,
    },
  }
}

export function validGeneratedImageAttachment(value: unknown): value is GeneratedImageAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256) &&
    (record.format === 'png' || record.format === 'jpg' || record.format === 'webp') &&
    Number.isSafeInteger(record.size) && Number(record.size) > 0 &&
    Number(record.size) <= maxDiscordGeneratedImageBytes
}

function filePath(directory: string, attachment: GeneratedImageAttachment): string {
  return path.join(directory, `${attachment.sha256}.${attachment.format}`)
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) throw new Error('Generated-image cache is not a directory')
}

export async function cacheGeneratedImage(
  directory: string,
  bytes: Buffer,
  attachment: GeneratedImageAttachment,
): Promise<void> {
  await ensureDirectory(directory)
  const destination = filePath(directory, attachment)
  try {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readCachedGeneratedImage(directory, attachment)
    if (!existing.equals(bytes)) throw new Error('Generated-image cache hash collision')
  }
}

export async function readCachedGeneratedImage(
  directory: string,
  attachment: GeneratedImageAttachment,
): Promise<Buffer> {
  const source = filePath(directory, attachment)
  const info = await lstat(source)
  if (!info.isFile() || info.size !== attachment.size) {
    throw new Error('Generated-image cache file is missing or has changed')
  }
  const bytes = await readFile(source)
  if (
    bytes.length !== attachment.size ||
    createHash('sha256').update(bytes).digest('hex') !== attachment.sha256 ||
    imageFormat(bytes) !== attachment.format
  ) {
    throw new Error('Generated-image cache content does not match the queued attachment')
  }
  return bytes
}

export function generatedImageFileName(attachment: GeneratedImageAttachment): string {
  return `codex-generated-${attachment.sha256.slice(0, 16)}.${attachment.format}`
}

export async function pruneGeneratedImageCache(
  directory: string,
  referenced: Iterable<GeneratedImageAttachment>,
): Promise<number> {
  try {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error('Generated-image cache is not a directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const protectedNames = new Set(Array.from(referenced, (attachment) =>
    `${attachment.sha256}.${attachment.format}`))
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(entry.name)) continue
    if (protectedNames.has(entry.name)) continue
    await unlink(path.join(directory, entry.name))
    removed++
  }
  return removed
}
