import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type OverwriteData,
  type TextChannel,
} from 'discord.js'
import type { AccessPolicy } from './access.js'
import { assertDirectory, getProjectsDirectory } from './config.js'
import { runGit } from './worktrees.js'
import type { CordexConfig, ProjectConfig } from './types.js'

type ManagedCategoryConfig = AccessPolicy & {
  categoryId?: string
}

const defaultGitignore = `node_modules/
dist/
.env
.env.*
!.env.example
.DS_Store
tmp/
*.log
__pycache__/
*.pyc
.venv/
*.egg-info/
`

export const rootChannelTopic =
  'General channel for miscellaneous tasks with Cordex. It uses a managed local project directory.'

export function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

export function cordexCategoryName(botName?: string): string {
  const normalized = botName?.trim()
  if (!normalized || normalized.toLowerCase() === 'cordex') return 'Cordex'
  return `Cordex ${normalized}`.slice(0, 100)
}

export function rootChannelName(botName?: string): string {
  const normalized = sanitizeChannelName(botName || '')
  if (!normalized || normalized === 'cordex') return 'cordex'
  return `cordex-${normalized}`.slice(0, 100)
}

export function rootProjectDirectory(config: Pick<CordexConfig, 'projectsDirectory'>): string {
  return path.join(getProjectsDirectory(config), 'cordex')
}

export function cordexCategoryPermissionOverwrites(
  guild: Guild,
  access: AccessPolicy,
): OverwriteData[] {
  if (access.allowAllUsers) return []
  const allow = [PermissionFlagsBits.ViewChannel]
  const roleIds = [...new Set(access.allowedRoleIds || [])].filter((id) => id !== guild.id)
  const memberIds = [...new Set([
    guild.ownerId,
    guild.client.user?.id,
    ...(access.allowedUserIds || []),
  ].filter((id): id is string => Boolean(id)))]
  return [
    { id: guild.id, type: OverwriteType.Role, deny: allow },
    ...roleIds.map((id): OverwriteData => ({ id, type: OverwriteType.Role, allow })),
    ...memberIds.map((id): OverwriteData => ({ id, type: OverwriteType.Member, allow })),
  ]
}

export async function ensureCordexCategory(
  guild: Guild,
  config: ManagedCategoryConfig,
  botName?: string,
): Promise<CategoryChannel> {
  await guild.channels.fetch().catch(() => undefined)
  const name = cordexCategoryName(botName)
  const permissionOverwrites = cordexCategoryPermissionOverwrites(guild, config)
  let existing = config.categoryId
    ? guild.channels.cache.get(config.categoryId)
    : undefined
  if (existing?.type !== ChannelType.GuildCategory) {
    delete config.categoryId
    existing = undefined
  }
  if (existing) {
    await existing.permissionOverwrites.set(permissionOverwrites, 'Sync Cordex access policy')
    return existing
  }
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
  })
  config.categoryId = created.id
  return created
}

export type CreatedProjectChannel = {
  textChannel: TextChannel
  channelName: string
  project: ProjectConfig
}

export async function createProjectChannel(options: {
  guild: Guild
  projectDirectory: string
  config: ManagedCategoryConfig
  botName?: string
  kind?: ProjectConfig['kind']
  channelName?: string
  topic?: string
}): Promise<CreatedProjectChannel> {
  const directory = await assertDirectory(options.projectDirectory)
  const channelName =
    sanitizeChannelName(options.channelName || path.basename(directory)) || 'project'
  const category = await ensureCordexCategory(options.guild, options.config, options.botName)
  const textChannel = await options.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category,
    ...(options.topic ? { topic: options.topic } : {}),
  })
  return {
    textChannel,
    channelName,
    project: {
      directory,
      name: path.basename(directory),
      kind: options.kind || 'project',
    },
  }
}

async function initializeRootDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  const git = await runGit(directory, ['rev-parse', '--show-toplevel'])
  if (git.exitCode !== 0 || path.resolve(git.stdout) !== path.resolve(directory)) {
    await runGit(directory, ['init', '-b', 'main'])
  }
  await writeFile(path.join(directory, '.gitignore'), defaultGitignore, { flag: 'wx' }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    },
  )
}

export type RootChannelResult = {
  textChannel: TextChannel
  projectDirectory: string
  created: boolean
}

async function syncManagedChannel(
  channel: TextChannel,
  category: CategoryChannel,
): Promise<void> {
  if (channel.parentId !== category.id) {
    await channel.setParent(category, {
      lockPermissions: true,
      reason: 'Sync Cordex managed channel access policy',
    })
  } else {
    await channel.lockPermissions()
  }
}

export async function ensureRootChannel(options: {
  guild: Guild
  config: Pick<
    CordexConfig,
    | 'projects'
    | 'projectsDirectory'
    | 'allowAllUsers'
    | 'allowedUserIds'
    | 'allowedRoleIds'
    | 'categoryId'
  >
  botName?: string
}): Promise<RootChannelResult | undefined> {
  const configuredRoot = rootProjectDirectory(options.config)
  await initializeRootDirectory(configuredRoot)
  const projectDirectory = await assertDirectory(configuredRoot)
  await options.guild.channels.fetch()
  const category = await ensureCordexCategory(options.guild, options.config, options.botName)

  for (const [channelId, project] of Object.entries(options.config.projects)) {
    if (project.kind === 'root') continue
    project.kind = 'project'
    const channel = options.guild.channels.cache.get(channelId)
    if (channel?.type === ChannelType.GuildText) await syncManagedChannel(channel, category)
  }

  for (const [channelId, project] of Object.entries(options.config.projects)) {
    if (path.resolve(project.directory) !== projectDirectory) continue
    const channel = options.guild.channels.cache.get(channelId)
    if (channel?.type === ChannelType.GuildText) {
      if (project.kind !== 'root') project.kind = 'root'
      await syncManagedChannel(channel, category)
      return { textChannel: channel, projectDirectory, created: false }
    }
  }

  const expectedName = rootChannelName(options.botName)
  const unowned = options.guild.channels.cache.find(
    (channel): channel is TextChannel =>
      channel.type === ChannelType.GuildText &&
      channel.parentId === category.id &&
      (channel.name === 'cordex' || channel.name.startsWith('cordex-')),
  )
  if (unowned) return undefined

  const created = await createProjectChannel({
    guild: options.guild,
    projectDirectory,
    config: options.config,
    ...(options.botName ? { botName: options.botName } : {}),
    kind: 'root',
    channelName: expectedName,
    topic: rootChannelTopic,
  })
  options.config.projects[created.textChannel.id] = created.project
  return { textChannel: created.textChannel, projectDirectory, created: true }
}
