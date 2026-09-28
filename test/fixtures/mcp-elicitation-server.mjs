import { createInterface } from 'node:readline'
import { appendFile, writeFile } from 'node:fs/promises'

const resultPath = process.argv[2]
const tracePath = process.argv[3]
if (!resultPath) throw new Error('MCP elicitation fixture requires a result path')

const toolName = 'collect_trip_preferences'
const pendingCalls = new Map()
let clientSupportsElicitation = false

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const requestedSchema = {
  type: 'object',
  properties: {
    destination: { type: 'string', title: 'Destination', minLength: 3, maxLength: 20 },
    days: { type: 'integer', title: 'Days', minimum: 2, maximum: 14 },
    pace: {
      type: 'string',
      title: 'Pace',
      enum: ['relaxed', 'balanced', 'fast'],
      enumNames: ['Relaxed', 'Balanced', 'Fast'],
    },
    activities: {
      type: 'array',
      title: 'Activities',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: ['museum', 'hiking', 'food'] },
    },
    includeTravel: { type: 'boolean', title: 'Include travel time' },
  },
  required: ['destination', 'days', 'pace', 'activities', 'includeTravel'],
}

async function handle(message) {
  if (!message || typeof message !== 'object') return
  if (tracePath) {
    await appendFile(tracePath, `${JSON.stringify({
      pid: process.pid,
      id: message.id ?? null,
      method: message.method ?? null,
      hasResult: Object.hasOwn(message, 'result'),
      hasError: Object.hasOwn(message, 'error'),
      action: message.result?.action ?? null,
    })}\n`, { mode: 0o600 })
  }
  if (message.method === 'initialize') {
    clientSupportsElicitation = Boolean(message.params?.capabilities?.elicitation)
    send({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cordex-elicitation-e2e', version: '1.0.0' },
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
        tools: [{
          name: toolName,
          description: 'Collect five trip preferences by asking the user through MCP elicitation.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== toolName) {
      send({ id: message.id, error: { code: -32602, message: 'Unknown fixture tool' } })
      return
    }
    const elicitationId = `elicitation-${message.id}`
    pendingCalls.set(elicitationId, message.id)
    send({
      id: elicitationId,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Choose preferences for a medium-complexity trip plan.',
        requestedSchema,
      },
    })
    return
  }
  if (message.id && pendingCalls.has(message.id)) {
    const callId = pendingCalls.get(message.id)
    pendingCalls.delete(message.id)
    const result = message.result || { action: 'cancel', content: null }
    await writeFile(resultPath, `${JSON.stringify({
      clientSupportsElicitation,
      action: result.action,
      content: result.content,
    }, null, 2)}\n`, { mode: 0o600 })
    send({
      id: callId,
      result: {
        content: [{
          type: 'text',
          text: result.action === 'accept'
            ? `Trip preferences accepted: ${JSON.stringify(result.content)}`
            : `Trip preferences ${result.action || 'cancelled'}`,
        }],
        isError: result.action !== 'accept',
      },
    })
    return
  }
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
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
