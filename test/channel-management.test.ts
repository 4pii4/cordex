import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ChannelType, Collection, type Guild } from 'discord.js'
import {
  cordexCategoryPermissionOverwrites,
  cordexCategoryName,
  createProjectChannel,
  ensureCordexCategory,
  ensureRootChannel,
  rootChannelName,
  rootProjectDirectory,
  sanitizeChannelName,
} from '../src/channel-management.js'
import type { CordexConfig } from '../src/types.js'

function restrictedConfig(): Pick<
  CordexConfig,
  'allowAllUsers' | 'allowedUserIds' | 'allowedRoleIds' | 'categoryId' | 'projects'
> {
  return {
    allowAllUsers: false,
    allowedUserIds: ['trusted-user'],
    allowedRoleIds: ['trusted-role'],
    projects: {},
  }
}

function fakeGuild(): { guild: Guild; channels: Collection<string, any> } {
  const channels = new Collection<string, any>()
  let nextId = 0
  const guild = {
    id: 'guild',
    ownerId: 'owner',
    client: { user: { id: 'bot' } },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async (options: Record<string, unknown>) => {
        const id = `channel-${++nextId}`
        const created: Record<string, any> = {
          id,
          name: options.name,
          type: options.type,
          parentId: typeof options.parent === 'object' && options.parent !== null
            ? (options.parent as { id: string }).id
            : null,
          topic: options.topic,
          appliedPermissionOverwrites: options.permissionOverwrites,
        }
        created.permissionOverwrites = {
          set: async (overwrites: unknown) => {
            created.appliedPermissionOverwrites = overwrites
          },
        }
        created.setParent = async (parent: Record<string, any>, parentOptions?: { lockPermissions?: boolean }) => {
          created.parentId = parent.id
          if (parentOptions?.lockPermissions) {
            created.appliedPermissionOverwrites = parent.appliedPermissionOverwrites
          }
          return created
        }
        created.lockPermissions = async () => {
          const parent = channels.get(created.parentId)
          created.appliedPermissionOverwrites = parent?.appliedPermissionOverwrites
          created.lockCount = (created.lockCount || 0) + 1
          return created
        }
        channels.set(id, created)
        return created
      },
    },
  } as unknown as Guild
  return { guild, channels }
}

test('managed category and project channels are idempotent primitives', async () => {
  const { guild, channels } = fakeGuild()
  const config = restrictedConfig()
  const category = await ensureCordexCategory(guild, config, 'Cordex')
  const sameCategory = await ensureCordexCategory(guild, config, 'cordex')
  assert.equal(category.id, sameCategory.id)
  assert.equal(config.categoryId, category.id)
  assert.equal(cordexCategoryName('Other Bot'), 'Cordex Other Bot')
  assert.equal(sanitizeChannelName(' Hello, World! '), 'hello-world')
  assert.equal(sanitizeChannelName('---'), '')
  const overwriteIds = new Set(
    ((category as any).appliedPermissionOverwrites as Array<{ id: string }>).map(({ id }) => id),
  )
  assert.deepEqual(overwriteIds, new Set(['guild', 'owner', 'bot', 'trusted-user', 'trusted-role']))
  assert.deepEqual(cordexCategoryPermissionOverwrites(guild, { allowAllUsers: true }), [])

  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-channel-'))
  try {
    const created = await createProjectChannel({
      guild,
      projectDirectory: directory,
      config,
    })
    assert.equal(created.textChannel.parentId, category.id)
    assert.equal(created.project.directory, directory)
    assert.equal(created.project.kind, 'project')
    assert.equal(channels.size, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('root channel uses the configured projects directory and is idempotent', async () => {
  const { guild, channels } = fakeGuild()
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-project-root-'))
  const config: CordexConfig = {
    token: 'token',
    applicationId: 'app',
    guildId: 'guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projectsDirectory,
    projects: {},
  }
  try {
    const first = await ensureRootChannel({ guild, config, botName: 'Cordex' })
    assert.ok(first)
    assert.equal(first.created, true)
    assert.equal(first.projectDirectory, rootProjectDirectory(config))
    assert.equal(first.textChannel.name, rootChannelName('Cordex'))
    await access(path.join(first.projectDirectory, '.git'))
    assert.match(await readFile(path.join(first.projectDirectory, '.gitignore'), 'utf8'), /node_modules/)

    const second = await ensureRootChannel({ guild, config, botName: 'Cordex' })
    assert.ok(second)
    assert.equal(second.created, false)
    assert.equal(second.textChannel.id, first.textChannel.id)
    assert.equal((second.textChannel as any).lockCount, 1)
    assert.equal(channels.size, 2)
  } finally {
    await rm(projectsDirectory, { recursive: true, force: true })
  }
})

test('root setup does not adopt an unmapped same-name channel', async () => {
  const { guild, channels } = fakeGuild()
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-unowned-root-'))
  const config: CordexConfig = {
    token: 'token',
    applicationId: 'app',
    guildId: 'guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projectsDirectory,
    projects: {},
  }
  try {
    const category = await ensureCordexCategory(guild, config)
    channels.set('unowned', {
      id: 'unowned',
      name: 'cordex',
      type: ChannelType.GuildText,
      parentId: category.id,
    })
    const result = await ensureRootChannel({ guild, config })
    assert.equal(result, undefined)
    assert.deepEqual(config.projects, {})
  } finally {
    await rm(projectsDirectory, { recursive: true, force: true })
  }
})

test('root setup preserves an existing gitignore', async () => {
  const { guild } = fakeGuild()
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-root-gitignore-'))
  const config: CordexConfig = {
    token: 'token',
    applicationId: 'app',
    guildId: 'guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projectsDirectory,
    projects: {},
  }
  const root = rootProjectDirectory(config)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, '.gitignore'), 'custom-only\n')
    await ensureRootChannel({ guild, config })
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), 'custom-only\n')
  } finally {
    await rm(projectsDirectory, { recursive: true, force: true })
  }
})

test('root setup upgrades an existing legacy mapping to root kind', async () => {
  const { guild, channels } = fakeGuild()
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-legacy-root-'))
  const directory = path.join(projectsDirectory, 'cordex')
  const legacyRoot: Record<string, any> = {
    id: 'legacy-root',
    name: 'cordex',
    type: ChannelType.GuildText,
    parentId: null,
  }
  legacyRoot.setParent = async (parent: { id: string }) => {
    legacyRoot.parentId = parent.id
    return legacyRoot
  }
  legacyRoot.lockPermissions = async () => legacyRoot
  channels.set('legacy-root', legacyRoot)
  const config: CordexConfig = {
    token: 'token',
    applicationId: 'app',
    guildId: 'guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projectsDirectory,
    projects: { 'legacy-root': { directory } },
  }
  try {
    const result = await ensureRootChannel({ guild, config })
    assert.equal(result?.created, false)
    assert.equal(config.projects['legacy-root']?.kind, 'root')
    assert.equal(legacyRoot.parentId, config.categoryId)
  } finally {
    await rm(projectsDirectory, { recursive: true, force: true })
  }
})

test('managed setup does not commandeer an unrelated same-name category', async () => {
  const { guild, channels } = fakeGuild()
  channels.set('unrelated-category', {
    id: 'unrelated-category',
    name: 'Cordex',
    type: ChannelType.GuildCategory,
    permissionOverwrites: { set: async () => undefined },
  })
  const config = restrictedConfig()
  const category = await ensureCordexCategory(guild, config)
  assert.notEqual(category.id, 'unrelated-category')
  assert.equal(config.categoryId, category.id)
  assert.equal(channels.size, 2)
})

test('legacy project mappings are moved into the managed private category', async () => {
  const { guild } = fakeGuild()
  const projectsDirectory = await mkdtemp(path.join(tmpdir(), 'cordex-legacy-projects-'))
  const projectDirectory = path.join(projectsDirectory, 'existing-project')
  await mkdir(projectDirectory)
  const legacyChannel = await guild.channels.create({
    name: 'legacy-project',
    type: ChannelType.GuildText,
  }) as any
  const config: CordexConfig = {
    token: 'token',
    applicationId: 'app',
    guildId: 'guild',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    allowAllUsers: false,
    allowShellCommands: false,
    projectsDirectory,
    projects: { [legacyChannel.id]: { directory: projectDirectory } },
  }
  try {
    await ensureRootChannel({ guild, config })
    assert.equal(config.projects[legacyChannel.id]?.kind, 'project')
    assert.equal(legacyChannel.parentId, config.categoryId)
  } finally {
    await rm(projectsDirectory, { recursive: true, force: true })
  }
})
