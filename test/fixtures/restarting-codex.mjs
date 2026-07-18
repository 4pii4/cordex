import fs from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = process.argv[2]
const mode = process.argv[3] || 'recover'

if (mode === 'ignore-term') process.on('SIGTERM', () => undefined)

const state = (() => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { spawnCount: 0 }
  }
})()
state.spawnCount += 1
fs.writeFileSync(statePath, JSON.stringify(state))

let initialized = false
let serverRequestResult = null
const lines = createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'hang-first-initialize' && state.spawnCount === 1) return
    if (mode === 'crash-initialize') {
      setImmediate(() => process.exit(31))
      return
    }
    send({
      id: message.id,
      result: { userAgent: 'restart-fixture', platformFamily: 'unix', platformOs: 'linux' },
    })
    return
  }
  if (message.method === 'initialized') {
    initialized = true
    return
  }
  if (message.method === 'fixture/crash') {
    setImmediate(() => process.exit(23))
    return
  }
  if (message.method === 'fixture/hang') return
  if (message.method === 'fixture/serverRequest') {
    send({ id: message.id, result: {} })
    send({
      id: 77,
      method: 'fixture/requestApproval',
      params: { spawnCount: state.spawnCount },
    })
    return
  }
  if (message.id === 77 && message.method === undefined) {
    serverRequestResult = message.result
    return
  }
  if (message.method === 'fixture/serverRequestResult') {
    send({ id: message.id, result: serverRequestResult })
    return
  }
  if (message.method === 'fixture/ping') {
    if (!initialized) {
      send({ id: message.id, error: { code: -32000, message: 'Not initialized' } })
      return
    }
    send({ id: message.id, result: { spawnCount: state.spawnCount } })
    return
  }
  send({ id: message.id, error: { code: -32601, message: 'Unknown method' } })
})
