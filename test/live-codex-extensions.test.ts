import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { listCodexCliPlugins } from '../src/codex-plugin-cli.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig } from '../src/types.js'

test('real Codex extension catalogs reach bounded Discord discovery controls', {
  skip: !process.env.CORDEX_EXTENSIONS_TEST,
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-extensions-project-'))
  const home = await mkdtemp(path.join(tmpdir(), 'cordex-extensions-home-'))
  const previousHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = home
  const parentChannelId = 'project-extensions-e2e'
  const config: CordexConfig = {
    token: 'fixture-token',
    applicationId: 'fixture-application',
    guildId: 'fixture-guild',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: { [parentChannelId]: { directory } },
  }
  const codex = new CodexAppServer()
  const bot = new CordexDiscordBot(config, emptyState(), codex)
  const channel = { id: parentChannelId, isThread: () => false }
  const invoke = async (
    method: 'handlePluginsCommand' | 'handleHooksCommand' | 'handleAppsCommand',
    strings: Record<string, string> = {},
    booleans: Record<string, boolean> = {},
  ): Promise<string> => {
    const messages: string[] = []
    let deferred = false
    const interaction = {
      channel,
      options: {
        getString: (name: string) => strings[name] ?? null,
        getBoolean: (name: string) => booleans[name] ?? null,
      },
      get deferred() { return deferred },
      replied: false,
      async deferReply() { deferred = true },
      async editReply(value: string | { content: string }) {
        messages.push(typeof value === 'string' ? value : value.content)
      },
      async followUp(value: { content: string }) { messages.push(value.content) },
    } as unknown as ChatInputCommandInteraction
    await (bot as unknown as Record<typeof method, (value: ChatInputCommandInteraction) => Promise<void>>)[method](interaction)
    return messages.join('\n')
  }

  try {
    const catalog = await listCodexCliPlugins(true)
    assert.ok(catalog.installed.length > 0)
    assert.ok(catalog.available.length > 20)
    const installedPlugin = catalog.installed[0]!
    const availablePlugin = catalog.available.find((entry) => entry.installPolicy === 'AVAILABLE')!
    assert.ok(availablePlugin)

    const installedReply = await invoke('handlePluginsCommand', { query: installedPlugin.pluginId })
    const availableReply = await invoke('handlePluginsCommand',
      { query: availablePlugin.pluginId }, { 'include-available': true })
    const broadReply = await invoke('handlePluginsCommand', {}, { 'include-available': true })
    assert.ok(installedReply.includes(installedPlugin.pluginId))
    assert.ok(availableReply.includes(availablePlugin.pluginId))
    assert.ok(broadReply.includes('showing first 20'))
    assert.ok(broadReply.split('\n').filter((line) => line.startsWith('• ')).length <= 20)

    const hookEntries = await codex.listHooks({ cwds: [directory] })
    const hooks = hookEntries.flatMap((entry) => entry.hooks)
    const hookReply = await invoke('handleHooksCommand',
      hooks[0] ? { event: hooks[0].eventName } : {})
    assert.ok(hookReply.includes(`${hooks[0]?.eventName || 'No matching hooks.'}`))
    for (const hook of hooks) {
      if (hook.sourcePath) assert.equal(hookReply.includes(hook.sourcePath), false)
      if (hook.command) assert.equal(hookReply.includes(hook.command), false)
    }

    const [availableApps, installedApps] = await Promise.all([
      codex.listApps(),
      codex.listInstalledApps(),
    ])
    const appsReply = await invoke('handleAppsCommand')
    assert.ok(appsReply.includes(`${availableApps.length} discoverable`))
    assert.ok(appsReply.includes(`${installedApps.length} installed`))
    assert.ok(appsReply.includes(`${installedApps.filter((app) => app.callable).length} callable`))

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-extensions-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'real Codex CLI and app-server extension discovery through bounded Discord handlers',
      command: 'npm run test:live-extensions',
      installedPlugins: catalog.installed.length,
      availablePlugins: catalog.available.length,
      broadPluginRows: broadReply.split('\n').filter((line) => line.startsWith('• ')).length,
      discoveredHooks: hooks.length,
      availableApps: availableApps.length,
      installedApps: installedApps.length,
      callableApps: installedApps.filter((app) => app.callable).length,
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    await bot.stop()
    await codex.close()
    if (previousHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
