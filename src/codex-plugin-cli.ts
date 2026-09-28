import { execFile } from 'node:child_process'

export type CodexCliPlugin = {
  pluginId: string
  name: string
  marketplaceName: string
  version: string | null
  installed: boolean
  enabled: boolean
  installPolicy: string
  authPolicy: string
}

export type CodexCliPluginCatalog = {
  installed: CodexCliPlugin[]
  available: CodexCliPlugin[]
}

export type CodexPluginCliOptions = {
  env?: NodeJS.ProcessEnv
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePlugin(value: unknown): CodexCliPlugin {
  if (!isRecord(value) ||
    typeof value.pluginId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.marketplaceName !== 'string' ||
    (value.version !== null && typeof value.version !== 'string') ||
    typeof value.installed !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    typeof value.installPolicy !== 'string' ||
    typeof value.authPolicy !== 'string') {
    throw new Error('Codex plugin CLI returned an invalid plugin entry')
  }
  return {
    pluginId: value.pluginId,
    name: value.name,
    marketplaceName: value.marketplaceName,
    version: value.version,
    installed: value.installed,
    enabled: value.enabled,
    installPolicy: value.installPolicy,
    authPolicy: value.authPolicy,
  }
}

async function runPluginCommand(
  args: string[],
  options: CodexPluginCliOptions = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.env.CORDEX_CODEX_BIN || 'codex', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...options.env }).filter(
          ([name, value]) => name !== 'CORDEX_DISCORD_TOKEN' && typeof value === 'string',
        ),
      ),
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`Codex plugin CLI failed (${String(error.code || 'unknown')})`))
        return
      }
      resolve(stdout)
    })
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('Codex plugin CLI did not return JSON')
  }
  return parsed
}

export async function listCodexCliPlugins(
  includeAvailable = false,
  options: CodexPluginCliOptions = {},
): Promise<CodexCliPluginCatalog> {
  const parsed = await runPluginCommand(
    ['plugin', 'list', ...(includeAvailable ? ['--available'] : []), '--json'],
    options,
  )
  if (!isRecord(parsed) || !Array.isArray(parsed.installed) || !Array.isArray(parsed.available)) {
    throw new Error('Codex plugin CLI returned an invalid catalog')
  }
  return {
    installed: parsed.installed.map(parsePlugin),
    available: parsed.available.map(parsePlugin),
  }
}

function validPluginId(pluginId: string): string {
  if (!pluginId || pluginId.length > 200 || /[\r\n\0]/.test(pluginId)) {
    throw new Error('Invalid Codex plugin ID')
  }
  return pluginId
}

export async function installCodexCliPlugin(
  pluginId: string,
  options: CodexPluginCliOptions = {},
): Promise<string> {
  const parsed = await runPluginCommand(
    ['plugin', 'add', validPluginId(pluginId), '--json'],
    options,
    120_000,
  )
  if (!isRecord(parsed) || parsed.pluginId !== pluginId) {
    throw new Error('Codex plugin add returned an unexpected plugin ID')
  }
  return pluginId
}

export async function removeCodexCliPlugin(
  pluginId: string,
  options: CodexPluginCliOptions = {},
): Promise<string> {
  const parsed = await runPluginCommand(
    ['plugin', 'remove', validPluginId(pluginId), '--json'],
    options,
    120_000,
  )
  if (!isRecord(parsed) || parsed.pluginId !== pluginId) {
    throw new Error('Codex plugin remove returned an unexpected plugin ID')
  }
  return pluginId
}
