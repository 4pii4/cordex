import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from '../src/codex-app-server.js'

type RawRequester = {
  request(method: string, params: unknown): Promise<unknown>
}

const protectedAttempts: Array<{ method: string; params: unknown }> = [
  { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
  { method: 'account/login/cancel', params: { loginId: 'fixture-login' } },
  { method: 'account/logout', params: undefined },
  { method: 'account/gatewayOAuth/login', params: undefined },
  { method: 'account/gatewayOAuth/cancel', params: undefined },
  { method: 'account/bedrock/setup', params: {} },
  { method: 'account/rateLimitResetCredit/consume', params: {} },
  { method: 'account/sendAddCreditsNudgeEmail', params: {} },
  { method: 'account/futureMutation', params: {} },
  { method: 'account/read', params: { refreshToken: true } },
  { method: 'modelProvider/credentials/write', params: {} },
  { method: 'modelProvider/capabilities/update', params: {} },
  { method: 'userVerification/enroll', params: {} },
  { method: 'userVerification/delete', params: {} },
  { method: 'externalAgentConfig/import', params: {} },
  { method: 'externalAgentConfig/import/recordHistory', params: {} },
  { method: 'config/batchWrite', params: { writes: [] } },
  { method: 'config/value/write', params: { keyPath: 'model_provider', value: 'fixture' } },
  { method: 'config/value/write', params: { keyPath: ' MODEL_PROVIDERS . fixture ', value: {} } },
  { method: 'config/value/write', params: { keyPath: '["preferred_auth_method"]', value: 'fixture' } },
  { method: 'config/value/write', params: { keyPath: '"forced_login_method"', value: 'fixture' } },
  { method: 'config/value/write', params: { keyPath: 'forced_chatgpt_workspace_id', value: 'fixture' } },
]

test('Cordex keeps real Codex provider state read-only at the RPC boundary', {
  skip: !process.env.CORDEX_PROVIDER_STATE_LOCK_TEST,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordex-provider-state-lock-'))
  const codexHome = path.join(root, 'codex-home')
  const tracePath = path.join(root, 'proxy.jsonl')
  await mkdir(codexHome, { mode: 0o700 })
  await writeFile(path.join(codexHome, 'config.toml'), [
    '[mcp_servers.provider_guard]',
    'command = "/usr/bin/true"',
    'enabled = true',
    '',
  ].join('\n'), { mode: 0o600 })
  await writeFile(tracePath, '', { mode: 0o600 })
  const proxyPath = fileURLToPath(new URL('./fixtures/provider-state-readonly-proxy.mjs', import.meta.url))
  const codex = new CodexAppServer({
    command: process.execPath,
    args: [proxyPath],
    env: {
      CODEX_HOME: codexHome,
      CORDEX_PROVIDER_GUARD_TRACE: tracePath,
      CORDEX_REAL_CODEX_BIN: process.env.CORDEX_REAL_CODEX_BIN || '/usr/local/bin/codex',
    },
  })
  const denied: string[] = []
  try {
    assert.equal(await codex.getAccount(), null)
    const auth = await codex.getAuthStatus()
    assert.equal(auth.hasToken, false)

    const raw = codex as unknown as RawRequester
    await raw.request('config/value/write', {
      keyPath: 'plugins."fixture@provider_guard".enabled',
      value: true,
      mergeStrategy: 'upsert',
    })
    await raw.request('config/value/write', {
      keyPath: 'mcp_servers."provider_guard".enabled',
      value: false,
      mergeStrategy: 'upsert',
    })
    for (const attempt of protectedAttempts) {
      await assert.rejects(
        raw.request(attempt.method, attempt.params),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.name, 'CodexProviderStateReadOnlyError')
          assert.match(error.message, /provider state is read-only/i)
          assert.ok(error.message.includes(attempt.method))
          return true
        },
      )
      denied.push(attempt.method)
    }
  } finally {
    await codex.close()
  }

  const trace = (await readFile(tracePath, 'utf8')).trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; intercepted: boolean })
  assert.ok(trace.some((entry) => entry.method === 'initialize' && !entry.intercepted))
  assert.ok(trace.some((entry) => entry.method === 'account/read' && !entry.intercepted))
  assert.ok(trace.some((entry) => entry.method === 'getAuthStatus' && !entry.intercepted))
  assert.equal(
    trace.filter((entry) => entry.method === 'config/value/write' && !entry.intercepted).length,
    2,
  )
  assert.equal(trace.some((entry) => entry.intercepted), false)
  await assert.rejects(access(path.join(codexHome, 'auth.json')), { code: 'ENOENT' })

  const artifactPath = process.env.CORDEX_PROVIDER_STATE_LOCK_ARTIFACT
  if (artifactPath) {
    await writeFile(artifactPath, `${JSON.stringify({
      schemaVersion: 1,
      realCodex: true,
      isolatedCodexHome: true,
      protectedAttemptCount: protectedAttempts.length,
      locallyDeniedMethods: [...new Set(denied)],
      proxyObservedMethods: [...new Set(trace.map((entry) => entry.method))],
      proxyObservedForbiddenCount: trace.filter((entry) => entry.intercepted).length,
      authFileCreated: false,
    }, null, 2)}\n`, { mode: 0o600 })
  }
  await rm(root, { recursive: true, force: true })
})
