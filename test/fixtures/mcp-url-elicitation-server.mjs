import { createInterface } from 'node:readline'
import { appendFile } from 'node:fs/promises'

const resultPath = process.argv[2]
if (!resultPath) throw new Error('MCP URL elicitation fixture requires a result path')

const requests = new Map()
let urlCapability = false

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(message) {
  if (!message || typeof message !== 'object') return
  if (message.method === 'initialize') {
    urlCapability = Boolean(message.params?.capabilities?.elicitation?.url)
    send({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cordex-url-elicitation-e2e', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'ping') {
    send({ id: message.id, result: {} })
    return
  }
  if (message.method === 'tools/list') {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: 'confirm_safe_url',
            description: 'Ask the user to inspect a harmless HTTPS example page using MCP URL elicitation.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'reject_unsafe_url',
            description: 'Ask the user to inspect an insecure HTTP example page; the client should decline it.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    if (name !== 'confirm_safe_url' && name !== 'reject_unsafe_url') {
      send({ id: message.id, error: { code: -32602, message: 'Unknown fixture tool' } })
      return
    }
    const requestId = `url-request-${message.id}`
    requests.set(requestId, { callId: message.id, name })
    send({
      id: requestId,
      method: 'elicitation/create',
      params: {
        mode: 'url',
        elicitationId: `cordex-url-${message.id}`,
        message: name === 'confirm_safe_url'
          ? 'Inspect the harmless example page, then confirm in Discord that you opened it.'
          : 'This insecure HTTP example page must be rejected before opening.',
        url: name === 'confirm_safe_url' ? 'https://example.com/' : 'http://example.com/',
      },
    })
    return
  }
  if (message.id !== undefined && requests.has(message.id)) {
    const { callId, name } = requests.get(message.id)
    requests.delete(message.id)
    const result = message.result || { action: 'cancel', content: null }
    await appendFile(resultPath, `${JSON.stringify({
      name,
      urlCapability,
      action: result.action,
      content: result.content ?? null,
    })}\n`, { mode: 0o600 })
    send({
      id: callId,
      result: {
        content: [{ type: 'text', text: `${name}: ${result.action || 'cancel'}` }],
        isError: result.action !== 'accept',
      },
    })
    return
  }
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  void handle(message).catch((error) => {
    if (message?.id !== undefined) {
      send({ id: message.id, error: { code: -32603, message: String(error) } })
    }
  })
})
