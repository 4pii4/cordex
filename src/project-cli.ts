import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type APIChannel,
  type Guild,
} from 'discord.js'
import { createProjectChannel } from './channel-management.js'
import {
  assertDirectory,
  getProjectsDirectory,
  loadConfig,
  saveManagedConfig,
  withManagementLock,
} from './config.js'
import { isUnknownDiscordChannelError } from './discord-errors.js'
import {
  createProject,
  findProjectMappingForPath,
  projectMappings,
} from './projects.js'
import type { CordexConfig } from './types.js'

type ProjectListEntry = {
  channel_id: string
  channel_name: string
  guild_id: string
  guild_name: string
  directory: string | null
  folder_name: string | null
  deleted: boolean
  is_local: boolean
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function positionalArgs(args: string[], optionsWithValues: string[] = []): string[] {
  const values = new Set(optionsWithValues)
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!argument) continue
    if (values.has(argument)) {
      index++
      continue
    }
    if (argument.startsWith('-')) continue
    positional.push(argument)
  }
  return positional
}

async function withGuild<T>(config: CordexConfig, run: (guild: Guild, client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  try {
    await client.login(config.token)
    const guild = await client.guilds.fetch(config.guildId)
    return await run(guild, client)
  } finally {
    client.destroy()
  }
}

async function assertProjectNotMapped(
  config: CordexConfig,
  directory: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token)
  for (const existing of projectMappings(config)) {
    if (path.resolve(existing.project.directory) !== path.resolve(directory)) continue
    try {
      const channel = await rest.get(Routes.channel(existing.channelId))
      if (channel) throw new Error(`Directory already maps to channel ${existing.channelId}`)
    } catch (error) {
      if (!isUnknownDiscordChannelError(error)) throw error
      delete config.projects[existing.channelId]
      await saveManagedConfig(config)
    }
  }
}

async function addProject(directoryValue: string | undefined): Promise<void> {
  const created = await withManagementLock(async () => {
    const config = await loadConfig()
    const directory = await assertDirectory(directoryValue || '.')
    await assertProjectNotMapped(config, directory)
    const created = await withGuild(config, async (guild, client) => {
      const channel = await createProjectChannel({
        guild,
        projectDirectory: directory,
        config,
        ...(client.user?.username ? { botName: client.user.username } : {}),
      })
      config.projects[channel.textChannel.id] = channel.project
      try {
        await saveManagedConfig(config)
      } catch (error) {
        delete config.projects[channel.textChannel.id]
        await channel.textChannel.delete('Cordex mapping could not be saved').catch(() => undefined)
        throw error
      }
      return { channelId: channel.textChannel.id, channelName: channel.channelName }
    })
    return { ...created, directory, guildId: config.guildId }
  })
  console.log(`Created #${created.channelName} for ${created.directory}`)
  console.log(`https://discord.com/channels/${created.guildId}/${created.channelId}`)
}

async function createNewProject(name: string | undefined, args: string[]): Promise<void> {
  if (!name) throw new Error('Usage: cordex project create <name> [--projects-dir <path>]')
  const created = await withManagementLock(async () => {
    const config = await loadConfig()
    const override = optionValue(args, '--projects-dir')
    const rootDirectory = override ? path.resolve(override) : getProjectsDirectory(config)
    const createdProject = await createProject({ rootDirectory, name })
    const createdChannel = await withGuild(config, async (guild, client) => {
      const channel = await createProjectChannel({
        guild,
        projectDirectory: createdProject.directory,
        config,
        ...(client.user?.username ? { botName: client.user.username } : {}),
      })
      config.projects[channel.textChannel.id] = {
        ...channel.project,
        name: createdProject.name,
      }
      try {
        await saveManagedConfig(config)
      } catch (error) {
        delete config.projects[channel.textChannel.id]
        await channel.textChannel.delete('Cordex mapping could not be saved').catch(() => undefined)
        throw error
      }
      return { channelId: channel.textChannel.id }
    })
    return { createdProject, createdChannel, guildId: config.guildId }
  })
  console.log(`Created project ${created.createdProject.name} at ${created.createdProject.directory}`)
  console.log(`https://discord.com/channels/${created.guildId}/${created.createdChannel.channelId}`)
}

function channelGuildId(channel: APIChannel): string {
  return 'guild_id' in channel && typeof channel.guild_id === 'string' ? channel.guild_id : ''
}

function channelName(channel: APIChannel): string {
  return 'name' in channel && typeof channel.name === 'string' ? channel.name : ''
}

async function listProjects(args: string[]): Promise<void> {
  const config = await loadConfig()
  const rest = new REST({ version: '10' }).setToken(config.token)
  const guild = await rest
    .get(Routes.guild(config.guildId))
    .catch(() => undefined) as { name?: string } | undefined
  const entries: ProjectListEntry[] = []

  for (const { channelId, project } of projectMappings(config)) {
    let channel: APIChannel | undefined
    let deleted = false
    try {
      channel = await rest.get(Routes.channel(channelId)) as APIChannel
    } catch (error) {
      deleted = isUnknownDiscordChannelError(error)
      if (!deleted) throw error
    }
    entries.push({
      channel_id: channelId,
      channel_name: channel ? channelName(channel) : '',
      guild_id: channel ? channelGuildId(channel) || config.guildId : config.guildId,
      guild_name: guild?.name || '',
      directory: project.directory,
      folder_name: path.basename(project.directory),
      deleted,
      is_local: true,
    })
  }

  if (args.includes('--all')) {
    const channels = await rest.get(Routes.guildChannels(config.guildId)) as APIChannel[]
    const local = new Set(entries.map((entry) => entry.channel_id))
    const categoryIds = new Set(config.categoryId ? [config.categoryId] : [])
    for (const channel of channels) {
      const parentId = 'parent_id' in channel ? channel.parent_id : undefined
      if (channel.type !== 0 || !parentId || !categoryIds.has(parentId) || local.has(channel.id)) {
        continue
      }
      entries.push({
        channel_id: channel.id,
        channel_name: channelName(channel),
        guild_id: config.guildId,
        guild_name: guild?.name || '',
        directory: null,
        folder_name: null,
        deleted: false,
        is_local: false,
      })
    }
  }

  const directoryCounts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.is_local || entry.deleted || !entry.directory) continue
    directoryCounts.set(entry.directory, (directoryCounts.get(entry.directory) || 0) + 1)
  }
  for (const [directory, count] of directoryCounts) {
    if (count > 1) {
      console.warn(`Directory ${directory} is registered in ${count} channels; use channel ID to disambiguate.`)
    }
  }

  if (args.includes('--prune')) {
    await withManagementLock(async () => {
      const latest = await loadConfig()
      for (const entry of entries.filter((candidate) => candidate.is_local && candidate.deleted)) {
        delete latest.projects[entry.channel_id]
      }
      await saveManagedConfig(latest)
    })
  }

  const visible = args.includes('--prune') ? entries.filter((entry) => !entry.deleted) : entries
  if (args.includes('--json')) {
    console.log(JSON.stringify(visible, null, 2))
    return
  }
  if (visible.length === 0) {
    console.log('No projects registered')
    return
  }
  for (const entry of visible) {
    const label = entry.channel_name ? `#${entry.channel_name}` : entry.channel_id
    console.log(`\n${label}${entry.guild_name ? ` (${entry.guild_name})` : ''}${entry.deleted ? ' (deleted)' : ''}${entry.is_local ? '' : ' [remote]'}`)
    if (entry.directory) {
      console.log(`   Folder: ${entry.folder_name}`)
      console.log(`   Directory: ${entry.directory}`)
    } else {
      console.log('   (Not registered on this machine)')
    }
    console.log(`   Channel ID: ${entry.channel_id}`)
    console.log(`   Guild ID: ${entry.guild_id}`)
  }
}

async function removeProjectMapping(channelId: string | undefined): Promise<void> {
  if (!channelId) throw new Error('Usage: cordex project remove <channel-id>')
  const result = await withManagementLock(async () => {
    const config = await loadConfig()
    const project = config.projects[channelId]
    if (!project) throw new Error(`No project mapping found for channel ${channelId}`)
    delete config.projects[channelId]
    await saveManagedConfig(config)
    return project
  })
  console.log(`Removed mapping ${channelId} -> ${result.directory}`)
}

async function openProjectInDiscord(): Promise<void> {
  const config = await loadConfig()
  const mapping = findProjectMappingForPath(config, process.cwd())
  if (!mapping) throw new Error(`No project channel found for ${process.cwd()}`)
  const url = `https://discord.com/channels/${config.guildId}/${mapping.channelId}`
  console.log(url)
  if (!process.stdout.isTTY) return
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  spawn(command, commandArgs, { detached: true, stdio: 'ignore' }).unref()
}

export async function runProjectCli(args: string[]): Promise<boolean> {
  if (args[0] === 'add-project') {
    await addProject(positionalArgs(args.slice(1))[0])
    return true
  }
  if (args[0] !== 'project') return false
  const subcommand = args[1]
  const rest = args.slice(2)
  if (subcommand === 'add') {
    await addProject(positionalArgs(rest)[0])
  } else if (subcommand === 'create') {
    await createNewProject(positionalArgs(rest, ['--projects-dir'])[0], rest)
  } else if (subcommand === 'list') {
    await listProjects(rest)
  } else if (subcommand === 'remove') {
    await removeProjectMapping(positionalArgs(rest)[0])
  } else if (subcommand === 'open-in-discord') {
    await openProjectInDiscord()
  } else {
    throw new Error(
      'Usage: cordex project <add [directory]|create <name>|list [--json --all --prune]|remove <channel-id>|open-in-discord>',
    )
  }
  return true
}
