import { constants } from 'node:fs'
import { access, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isContextTokenCount, isContextWindowSize } from './context-usage.js'
import type { CordexConfig, CordexState, ReasoningEffort, VerbosityLevel } from './types.js'

const efforts = new Set<ReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
])

const verbosityLevels = new Set<VerbosityLevel>([
  'tools_and_text',
  'text_and_essential_tools',
  'text_only',
])

let stateWriteTail: Promise<void> = Promise.resolve()

export function getCordexHome(): string {
  return process.env.CORDEX_HOME || path.join(homedir(), '.cordex')
}

export function getConfigPath(): string {
  return process.env.CORDEX_CONFIG || path.join(getCordexHome(), 'config.json')
}

export function getStatePath(): string {
  return path.join(getCordexHome(), 'state.json')
}

export function getManagementLockPath(): string {
  return path.join(getCordexHome(), 'management.lock')
}

export async function withManagementLock<T>(
  run: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const lockPath = getManagementLockPath()
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (options.timeoutMs ?? 3 * 60_000)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lockStat = await stat(lockPath).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > 2 * 60_000) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`)
      await delay(50)
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void handle?.utimes(now, now).catch(() => undefined)
  }, 30_000)
  heartbeat.unref()
  try {
    return await run()
  } finally {
    clearInterval(heartbeat)
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

export function getProjectsDirectory(config?: Pick<CordexConfig, 'projectsDirectory'>): string {
  return path.resolve(
    process.env.CORDEX_PROJECTS_DIR ||
      config?.projectsDirectory ||
      path.join(getCordexHome(), 'projects'),
  )
}

export const emptyState = (): CordexState => ({
  channelModels: {},
  channelEfforts: {},
  channelFastMode: {},
  channelYoloMode: {},
  channelAutoWorktrees: {},
  channelVerbosity: {},
  sessions: {},
  queues: {},
  tasks: {},
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )]
}

function environmentList(name: string, fallback: unknown): string[] {
  const value = process.env[name]
  return value === undefined ? stringList(fallback) : stringList(value.split(','))
}

function parseConfig(value: unknown): CordexConfig {
  if (!isRecord(value)) throw new Error('Config must be a JSON object')
  const token = process.env.CORDEX_DISCORD_TOKEN || value.token
  const applicationId = process.env.CORDEX_APPLICATION_ID || value.applicationId
  const guildId = process.env.CORDEX_GUILD_ID || value.guildId
  if (typeof token !== 'string' || !token) throw new Error('Missing Discord bot token')
  if (typeof applicationId !== 'string' || !applicationId) {
    throw new Error('Missing Discord application ID')
  }
  if (typeof guildId !== 'string' || !guildId) throw new Error('Missing Discord guild ID')

  const sandbox = value.sandbox ?? 'workspace-write'
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(sandbox))) {
    throw new Error(`Invalid sandbox mode: ${String(sandbox)}`)
  }
  const approvalPolicy = value.approvalPolicy ?? 'on-request'
  if (!['untrusted', 'on-request', 'never'].includes(String(approvalPolicy))) {
    throw new Error(`Invalid approval policy: ${String(approvalPolicy)}`)
  }
  const projects: CordexConfig['projects'] = {}
  if (isRecord(value.projects)) {
    for (const [channelId, project] of Object.entries(value.projects)) {
      if (!isRecord(project) || typeof project.directory !== 'string') continue
      projects[channelId] = {
        directory: path.resolve(project.directory),
        ...(typeof project.name === 'string' ? { name: project.name } : {}),
        ...(project.kind === 'root' || project.kind === 'project' ? { kind: project.kind } : {}),
      }
    }
  }
  const defaultEffort = value.defaultEffort
  if (defaultEffort !== undefined && !efforts.has(defaultEffort as ReasoningEffort)) {
    throw new Error(`Invalid default reasoning effort: ${String(defaultEffort)}`)
  }
  const allowedUserIds = environmentList('CORDEX_ALLOWED_USER_IDS', value.allowedUserIds)
  const allowedRoleIds = environmentList('CORDEX_ALLOWED_ROLE_IDS', value.allowedRoleIds)
    .filter((roleId) => roleId !== guildId)
  return {
    token,
    applicationId,
    guildId,
    ...(typeof value.defaultModel === 'string' ? { defaultModel: value.defaultModel } : {}),
    ...(defaultEffort ? { defaultEffort: defaultEffort as ReasoningEffort } : {}),
    sandbox: sandbox as CordexConfig['sandbox'],
    approvalPolicy: approvalPolicy as CordexConfig['approvalPolicy'],
    allowAllUsers: value.allowAllUsers === true,
    allowShellCommands: value.allowShellCommands === true,
    ...(allowedUserIds.length > 0 ? { allowedUserIds } : {}),
    ...(allowedRoleIds.length > 0 ? { allowedRoleIds } : {}),
    ...(typeof value.categoryId === 'string' && value.categoryId
      ? { categoryId: value.categoryId }
      : {}),
    ...(typeof value.projectsDirectory === 'string'
      ? { projectsDirectory: path.resolve(value.projectsDirectory) }
      : {}),
    projects,
  }
}

export async function loadConfig(): Promise<CordexConfig> {
  const file = await readFile(getConfigPath(), 'utf8').catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error(`Config not found: ${getConfigPath()}. Run cordex init.`)
    }
    throw error
  })
  return parseConfig(JSON.parse(file))
}

function parseSessions(value: unknown): CordexState['sessions'] {
  if (!isRecord(value)) return {}
  const sessions: CordexState['sessions'] = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    if (
      typeof raw.discordThreadId !== 'string' ||
      typeof raw.parentChannelId !== 'string' ||
      typeof raw.directory !== 'string' ||
      typeof raw.codexThreadId !== 'string' ||
      typeof raw.updatedAt !== 'string'
    ) continue

    const session = { ...raw } as CordexState['sessions'][string]
    if (!isContextTokenCount(raw.contextTokens)) {
      delete session.contextTokens
      delete session.contextWindow
    } else if (isContextWindowSize(raw.contextWindow)) {
      session.contextTokens = raw.contextTokens
      session.contextWindow = raw.contextWindow
    } else {
      session.contextTokens = raw.contextTokens
      delete session.contextWindow
    }
    sessions[id] = session
  }
  return sessions
}

export async function loadState(): Promise<CordexState> {
  const file = await readFile(getStatePath(), 'utf8').catch(() => undefined)
  if (!file) return emptyState()
  const value: unknown = JSON.parse(file)
  if (!isRecord(value)) return emptyState()
  return {
    channelModels: isRecord(value.channelModels)
      ? Object.fromEntries(Object.entries(value.channelModels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {},
    channelEfforts: isRecord(value.channelEfforts)
      ? Object.fromEntries(
          Object.entries(value.channelEfforts).filter(
            (entry): entry is [string, ReasoningEffort] => efforts.has(entry[1] as ReasoningEffort),
          ),
        )
      : {},
    channelFastMode: isRecord(value.channelFastMode)
      ? Object.fromEntries(
          Object.entries(value.channelFastMode).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        )
      : {},
    channelYoloMode: isRecord(value.channelYoloMode)
      ? Object.fromEntries(
          Object.entries(value.channelYoloMode).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        )
      : {},
    channelAutoWorktrees: isRecord(value.channelAutoWorktrees)
      ? Object.fromEntries(
          Object.entries(value.channelAutoWorktrees).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        )
      : {},
    channelVerbosity: isRecord(value.channelVerbosity)
      ? Object.fromEntries(
          Object.entries(value.channelVerbosity).filter(
            (entry): entry is [string, VerbosityLevel] => verbosityLevels.has(entry[1] as VerbosityLevel),
          ),
        )
      : {},
    sessions: parseSessions(value.sessions),
    queues: isRecord(value.queues)
      ? Object.fromEntries(
          Object.entries(value.queues).filter(
            (entry): entry is [string, CordexState['queues'][string]] => Array.isArray(entry[1]),
          ),
        )
      : {},
    tasks: isRecord(value.tasks)
      ? Object.fromEntries(
          Object.entries(value.tasks).filter((entry): entry is [string, CordexState['tasks'][string]] => {
            if (!isRecord(entry[1])) return false
            return (
              typeof entry[1].id === 'string' &&
              typeof entry[1].threadId === 'string' &&
              typeof entry[1].prompt === 'string' &&
              typeof entry[1].runAt === 'string' &&
              typeof entry[1].createdBy === 'string' &&
              ['scheduled', 'running', 'completed', 'failed', 'cancelled'].includes(String(entry[1].status))
            )
          }),
        )
      : {},
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, filePath)
}

async function configForPersistence(config: CordexConfig): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = { ...config }
  const overriddenFields = [
    ['CORDEX_DISCORD_TOKEN', 'token'],
    ['CORDEX_APPLICATION_ID', 'applicationId'],
    ['CORDEX_GUILD_ID', 'guildId'],
    ['CORDEX_ALLOWED_USER_IDS', 'allowedUserIds'],
    ['CORDEX_ALLOWED_ROLE_IDS', 'allowedRoleIds'],
  ] as const
  if (!overriddenFields.some(([environmentName]) => process.env[environmentName] !== undefined)) {
    return output
  }
  const raw = await readFile(getConfigPath(), 'utf8')
    .then((file) => JSON.parse(file) as unknown)
    .catch(() => undefined)
  for (const [environmentName, field] of overriddenFields) {
    if (process.env[environmentName] === undefined) continue
    if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, field)) {
      output[field] = raw[field]
    } else {
      delete output[field]
    }
  }
  return output
}

export async function saveConfig(config: CordexConfig): Promise<void> {
  await writeJsonAtomic(getConfigPath(), await configForPersistence(config))
}

export async function saveManagedConfig(
  config: Pick<CordexConfig, 'projects' | 'categoryId'>,
): Promise<void> {
  const raw = await readFile(getConfigPath(), 'utf8')
    .then((file) => JSON.parse(file) as unknown)
    .catch(() => undefined)
  const output: Record<string, unknown> = isRecord(raw) ? { ...raw } : {}
  output.projects = config.projects
  if (config.categoryId) output.categoryId = config.categoryId
  else delete output.categoryId
  await writeJsonAtomic(getConfigPath(), output)
}

export async function saveState(state: CordexState): Promise<void> {
  const statePath = getStatePath()
  const write = stateWriteTail
    .catch(() => undefined)
    .then(() => writeJsonAtomic(statePath, state))
  stateWriteTail = write.catch(() => undefined)
  await write
}

export async function assertDirectory(directory: string): Promise<string> {
  const resolved = await realpath(path.resolve(directory))
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${resolved}`)
  await access(resolved, constants.R_OK | constants.W_OK)
  return resolved
}
