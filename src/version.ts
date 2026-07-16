import { readFile } from 'node:fs/promises'

let cachedVersion: string | undefined

export async function packageVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion
  const file = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const value = JSON.parse(file) as { version?: unknown }
  if (typeof value.version !== 'string' || !value.version) {
    throw new Error('Package version is missing from package.json')
  }
  cachedVersion = value.version
  return cachedVersion
}
