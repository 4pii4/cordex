import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAppServer } from '../src/codex-app-server.js'

test('real Codex globally toggles configured MCP servers and reloads', {
  skip: !process.env.CORDEX_MCP_CONFIG_TEST,
  timeout: 30_000,
}, async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'cordex-mcp-config-live-'))
  const configPath = path.join(codexHome, 'config.toml')
  await writeFile(configPath, [
    '[mcp_servers."fixture.dot"]',
    'command = "node"',
    'args = ["-e", "process.stdin.resume()"]',
    'enabled = true',
    'startup_timeout_sec = 1',
    '',
  ].join('\n'))
  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  const codex = new CodexAppServer()
  try {
    assert.deepEqual(await codex.listConfiguredMcpServers(), [
      {
        name: 'fixture.dot',
        enabled: true,
        scope: 'global',
        globalConfigurable: true,
        filePath: configPath,
      },
    ])
    const disabled = await codex.setMcpServerEnabled('fixture.dot', false)
    assert.equal(disabled.status, 'ok')
    assert.equal(disabled.filePath, configPath)
    assert.equal(disabled.effectiveEnabled, false)
    assert.match(await readFile(configPath, 'utf8'), /enabled = false/)

    const enabled = await codex.setMcpServerEnabled('fixture.dot', true)
    assert.equal(enabled.effectiveEnabled, true)
    assert.match(await readFile(configPath, 'utf8'), /enabled = true/)
  } finally {
    await codex.close()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(codexHome, { recursive: true, force: true })
  }
})
