import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const tracePath = process.env.CORDEX_PROVIDER_GUARD_TRACE
const realCodex = process.env.CORDEX_REAL_CODEX_BIN || '/usr/local/bin/codex'
if (!tracePath) throw new Error('CORDEX_PROVIDER_GUARD_TRACE is required')

const allowedAccountReads = new Set([
  'account/gatewayOAuth/read',
  'account/rateLimits/read',
  'account/read',
  'account/usage/read',
  'account/workspaceMessages/read',
])

function compactKeyPath(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[\s"'\[\]]/g, '')
    : ''
}

function protectedConfigWrite(message) {
  if (message.method === 'config/batchWrite') return true
  if (message.method !== 'config/value/write') return false
  const key = compactKeyPath(message.params?.keyPath)
  return key === 'model_provider' || key.startsWith('model_provider.') ||
    key === 'model_providers' || key.startsWith('model_providers.') ||
    key === 'preferred_auth_method' || key.startsWith('preferred_auth_method.') ||
    key === 'forced_login_method' || key.startsWith('forced_login_method.') ||
    key === 'forced_chatgpt_workspace_id' || key.startsWith('forced_chatgpt_workspace_id.')
}

function forbidden(message) {
  if (message.method === 'account/read') return message.params?.refreshToken === true
  if (message.method.startsWith('account/')) return !allowedAccountReads.has(message.method)
  if (message.method.startsWith('modelProvider/')) {
    return message.method !== 'modelProvider/capabilities/read'
  }
  if (message.method.startsWith('userVerification/')) {
    return message.method !== 'userVerification/status'
  }
  if (message.method.startsWith('externalAgentConfig/')) {
    return message.method !== 'externalAgentConfig/detect' &&
      message.method !== 'externalAgentConfig/import/readHistories'
  }
  return protectedConfigWrite(message)
}

function trace(message, intercepted) {
  appendFileSync(tracePath, `${JSON.stringify({
    method: typeof message.method === 'string' ? message.method : 'invalid',
    intercepted,
  })}\n`, { encoding: 'utf8' })
}

const child = spawn(realCodex, ['app-server', '--stdio'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    child.stdin.write(`${line}\n`)
    return
  }
  const intercepted = typeof message.method === 'string' && forbidden(message)
  trace(message, intercepted)
  if (intercepted && Object.hasOwn(message, 'id')) {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32099, message: 'provider-state fixture intercepted a forbidden request' },
    })}\n`)
    return
  }
  child.stdin.write(`${line}\n`)
})

child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.once('error', (error) => {
  console.error(`provider-state proxy failed: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal))
}
