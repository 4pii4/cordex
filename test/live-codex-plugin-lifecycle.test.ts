import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { ChatInputCommandInteraction } from 'discord.js'
import { CodexAppServer } from '../src/codex-app-server.js'
import { listCodexCliPlugins } from '../src/codex-plugin-cli.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import { emptyState } from '../src/config.js'
import type { CordexConfig } from '../src/types.js'

function runCodex(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(process.env.CORDEX_CODEX_BIN || 'codex', args, {
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(
        ([name, value]) => name !== 'CORDEX_DISCORD_TOKEN' && typeof value === 'string',
      )),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Isolated Codex CLI command failed (${String(error.code || 'unknown')}): ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('Isolated Codex CLI command did not return JSON'))
      }
    })
  })
}

test('real Codex CLI installs, toggles, and removes an isolated local plugin', {
  skip: !process.env.CORDEX_PLUGIN_LIFECYCLE_TEST,
  timeout: 120_000,
}, async () => {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'cordex-plugin-lifecycle-'))
  const codexHome = path.join(isolatedRoot, 'codex-home')
  const cordexHome = path.join(isolatedRoot, 'cordex-home')
  const previousCordexHome = process.env.CORDEX_HOME
  process.env.CORDEX_HOME = cordexHome
  const marketplaceRoot = path.join(isolatedRoot, 'marketplace')
  const pluginName = 'cordex-e2e-plugin'
  const blockedPluginName = 'cordex-e2e-blocked'
  const defaultPluginName = 'cordex-e2e-default'
  const marketplaceName = 'cordex-e2e-fixture'
  const pluginId = `${pluginName}@${marketplaceName}`
  const fixture = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    pluginName,
  )
  const env = { CODEX_HOME: codexHome }
  let codex: CodexAppServer | undefined
  let bot: CordexDiscordBot | undefined
  try {
    await mkdir(codexHome, { recursive: true })
    await mkdir(path.join(marketplaceRoot, 'plugins'), { recursive: true })
    await mkdir(path.join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
    await cp(fixture, path.join(marketplaceRoot, 'plugins', pluginName), { recursive: true })
    for (const name of [blockedPluginName, defaultPluginName]) {
      const target = path.join(marketplaceRoot, 'plugins', name)
      await cp(fixture, target, { recursive: true })
      const manifestPath = path.join(target, '.codex-plugin', 'plugin.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      manifest.name = name
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    await writeFile(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: marketplaceName,
      interface: { displayName: 'Cordex E2E Fixture' },
      plugins: [{
        name: pluginName,
        source: { source: 'local', path: `./plugins/${pluginName}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Productivity',
      }, {
        name: blockedPluginName,
        source: { source: 'local', path: `./plugins/${blockedPluginName}` },
        policy: { installation: 'NOT_AVAILABLE', authentication: 'ON_USE' },
        category: 'Productivity',
      }, {
        name: defaultPluginName,
        source: { source: 'local', path: `./plugins/${defaultPluginName}` },
        policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_USE' },
        category: 'Productivity',
      }],
    }, null, 2) + '\n')

    const marketplace = await runCodex(
      ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'],
      env,
    ) as { marketplaceName?: string }
    assert.equal(marketplace.marketplaceName, marketplaceName)
    const before = await listCodexCliPlugins(true, { env })
    const candidate = before.available.find((entry) => entry.pluginId === pluginId)
    assert.equal(candidate?.installPolicy, 'AVAILABLE')
    assert.equal(before.installed.some((entry) => entry.pluginId === pluginId), false)

    codex = new CodexAppServer({ env })
    const parentChannelId = 'plugin-lifecycle-e2e'
    const config: CordexConfig = {
      token: 'fixture-token',
      applicationId: 'fixture-application',
      guildId: 'fixture-guild',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      allowAllUsers: true,
      allowShellCommands: false,
      projects: { [parentChannelId]: { directory: marketplaceRoot } },
    }
    bot = new CordexDiscordBot(config, emptyState(), codex, { pluginCliEnv: env })
    const invokePlugin = async (
      action: 'inspect' | 'install' | 'enable' | 'disable' | 'uninstall',
      confirmation?: string,
      selectedId = pluginId,
    ): Promise<string> => {
      let response = ''
      const interaction = {
        channel: { id: parentChannelId, isThread: () => false },
        options: {
          getString: (name: string) => name === 'action' ? action
            : name === 'plugin-id' ? selectedId
              : name === 'confirm-plugin-id' ? confirmation ?? null : null,
        },
        async deferReply() {},
        async editReply(value: string) { response = value },
      } as unknown as ChatInputCommandInteraction
      await (bot as unknown as {
        handlePluginCommand(value: ChatInputCommandInteraction): Promise<void>
      }).handlePluginCommand(interaction)
      return response
    }
    const inspect = await invokePlugin('inspect')
    assert.match(inspect, /not installed/)
    await assert.rejects(invokePlugin('install', 'wrong-id'), /Repeat the exact plugin ID/)
    const blocked = before.available.find((entry) => entry.installPolicy === 'NOT_AVAILABLE')
    if (blocked) {
      await assert.rejects(
        invokePlugin('install', blocked.pluginId, blocked.pluginId),
        /cannot override it/,
      )
    }
    const defaultAvailable = before.available.find(
      (entry) => entry.installPolicy === 'INSTALLED_BY_DEFAULT',
    )
    if (defaultAvailable) {
      await assert.rejects(
        invokePlugin('install', defaultAvailable.pluginId, defaultAvailable.pluginId),
        /cannot override it/,
      )
    }
    const managed = before.installed.find((entry) => entry.installPolicy === 'INSTALLED_BY_DEFAULT')
    if (managed) {
      await assert.rejects(
        invokePlugin('uninstall', managed.pluginId, managed.pluginId),
        /cannot change a managed\/default plugin/,
      )
    }
    assert.equal((await listCodexCliPlugins(false, { env })).installed.some(
      (entry) => entry.pluginId === pluginId,
    ), false)
    const installReply = await invokePlugin('install', pluginId)
    assert.match(installReply, /Installed/)
    const installed = await listCodexCliPlugins(false, { env })
    assert.equal(installed.installed.some((entry) => entry.pluginId === pluginId), true)

    const disableReply = await invokePlugin('disable', pluginId)
    assert.match(disableReply, /Effective state: \*\*disabled\*\*/)
    const disabled = await listCodexCliPlugins(false, { env })
    assert.equal(disabled.installed.find((entry) => entry.pluginId === pluginId)?.enabled, false)
    const enableReply = await invokePlugin('enable', pluginId)
    assert.match(enableReply, /Effective state: \*\*enabled\*\*/)
    const enabled = await listCodexCliPlugins(false, { env })
    assert.equal(enabled.installed.find((entry) => entry.pluginId === pluginId)?.enabled, true)

    const uninstallReply = await invokePlugin('uninstall', pluginId)
    assert.match(uninstallReply, /Uninstalled/)
    const removed = await listCodexCliPlugins(false, { env })
    assert.equal(removed.installed.some((entry) => entry.pluginId === pluginId), false)

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'cordex-plugin-lifecycle-evidence-'))
    const artifactPath = path.join(artifactDir, 'result.json')
    await writeFile(artifactPath, JSON.stringify({
      scenario: 'isolated real Codex local marketplace add, plugin install, disable, enable, uninstall',
      command: 'npm run test:live-plugin-lifecycle',
      pluginId,
      isolatedCodexHome: codexHome,
      availableBefore: candidate?.installPolicy,
      installedAfterAdd: true,
      disabledEffective: false,
      enabledEffective: true,
      installedAfterRemove: false,
      wrongConfirmationRejected: true,
      unavailablePolicyRejected: Boolean(blocked),
      defaultInstallPolicyRejected: Boolean(defaultAvailable),
      managedUninstallRejected: Boolean(managed),
      discordHandlerReplies: [inspect, installReply, disableReply, enableReply, uninstallReply],
      completed: true,
    }, null, 2) + '\n')
    console.log(`E2E artifact: ${artifactPath}`)
  } finally {
    await bot?.stop()
    await codex?.close()
    if (previousCordexHome === undefined) delete process.env.CORDEX_HOME
    else process.env.CORDEX_HOME = previousCordexHome
    await rm(isolatedRoot, { recursive: true, force: true })
  }
})
