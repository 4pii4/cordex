import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Events } from 'discord.js'
import { CordexDiscordBot } from '../dist/discord-bot.js'
import { emptyState, loadState } from '../dist/config.js'

// A fault-injected protocol integration check, not live provider/guild proof.
// Use production notification ingress, persistence, retries and interval timers;
// replace only the Discord transport and advance the wall clock between phases.
const repo = fileURLToPath(new URL('../', import.meta.url))
const evidence = await mkdtemp(path.join(tmpdir(), 'cordex-notice-visibility-evidence-'))
const home = await mkdtemp(path.join(tmpdir(), 'cordex-notice-visibility-home-'))
const previousHome = process.env.CORDEX_HOME
process.env.CORDEX_HOME = home
const nativeNow = Date.now
let logicalTime = nativeNow()
Date.now = () => logicalTime
let phase = 'setup'
let offline = false
let failAcknowledgment = false
let attempts = 0
const transcript = []
const checks = []
const seenNonces = new Map()
const state = emptyState()
const threadId = 'visibility-protocol-thread'
const channelId = 'visibility-protocol-channel'
let turnId = 'visibility-turn-a'
state.channelVerbosity['visibility-project'] = 'text_only'
state.sessions[channelId] = {
  discordThreadId: channelId,
  parentChannelId: 'visibility-project',
  directory: home,
  codexThreadId: threadId,
  model: 'fixture-model',
  effort: 'low',
  updatedAt: new Date().toISOString(),
}
// Never launch a provider process from this isolated transport check. Native
// Codex launches belong to the separate, explicitly labeled live E2E gate.
const codex = Object.assign(new EventEmitter(), {
  async close() {},
  async getThreadGoal() { return undefined },
  async listBackgroundTerminals() { return [] },
})
const channel = {
  id: channelId,
  name: 'Notice visibility protocol fixture',
  archived: false,
  isThread: () => true,
  async sendTyping() {},
  async send(options) {
    attempts++
    if (offline) throw new Error('Fixture Discord transport is offline')
    if (options.enforceNonce && seenNonces.has(options.nonce)) {
      return seenNonces.get(options.nonce)
    }
    const content = typeof options === 'string' ? options : options.content || ''
    const message = {
      id: `visibility-message-${transcript.length + 1}`,
      content,
      createdTimestamp: logicalTime,
      async edit() { return this },
    }
    transcript.push({ phase, id: message.id, content, at: logicalTime, nonce: options.nonce })
    if (options.enforceNonce) seenNonces.set(options.nonce, message)
    if (failAcknowledgment) {
      failAcknowledgment = false
      await chmod(home, 0o500)
    }
    return message
  },
}
const bot = new CordexDiscordBot({
  token: 'fixture-token', applicationId: 'fixture-application', guildId: 'fixture-guild',
  sandbox: 'read-only', approvalPolicy: 'never', allowAllUsers: true,
  allowShellCommands: false, projects: { 'visibility-project': { directory: home } },
}, state, codex)
bot.client.channels.fetch = async (id) => id === channelId ? channel : undefined

async function waitFor(condition, label, timeout = 10_000) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
async function settle() {
  // Observe completion of the production ingress queues, without invoking their
  // private handlers or bypassing any notification routing/lifecycle guard.
  await waitFor(() => bot.pendingCodexNotifications.size === 0, 'notification ingress')
  await waitFor(() => bot.pendingBackgroundWork.size === 0, 'background delivery')
}
async function emit(method, params = {}) {
  codex.emit('notification', { method, params: { threadId, turnId, ...params } })
  await settle()
}
async function observeHeartbeatInterval() {
  // Exercise the real six-second typing/progress interval, not a direct call to
  // maybeReportRunProgress. Wall-clock advancement makes the sixty-second gates
  // deterministic without a minute-long sleep for each failure condition.
  await new Promise((resolve) => setTimeout(resolve, 7_000))
  await settle()
}
function heartbeats() { return transcript.filter((entry) => entry.content.startsWith('Codex is still working')) }
function check(name, passed, evidenceFields = {}) {
  checks.push({ name, passed, ...evidenceFields })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
}
async function start() {
  await emit('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
}

let fatal
try {
  await start()
  phase = 'duplicate-structured-notice'
  const buffering = { model: 'fixture-model', showBufferingUi: true, useCases: [], reasons: [] }
  await emit('model/safetyBuffering/updated', buffering)
  logicalTime += 65_000
  const heartbeatBeforeNoticeDuplicates = heartbeats().length
  for (let n = 0; n < 5; n++) await emit('model/safetyBuffering/updated', buffering)
  await observeHeartbeatInterval()
  check('duplicate notices do not hide prolonged silent work',
    heartbeats().length === heartbeatBeforeNoticeDuplicates + 1 &&
    transcript.filter((entry) => entry.content.includes('Codex is checking this response')).length === 1)

  phase = 'duplicate-completed-agent-item'
  logicalTime += 10_000
  const answer = { item: { id: 'visibility-answer', type: 'agentMessage', phase: 'commentary', text: 'visibility-original-answer' } }
  await emit('item/completed', answer)
  logicalTime += 65_000
  const heartbeatBeforeItemDuplicates = heartbeats().length
  for (let n = 0; n < 5; n++) await emit('item/completed', answer)
  await observeHeartbeatInterval()
  check('duplicate agent items do not hide prolonged silent work',
    heartbeats().length === heartbeatBeforeItemDuplicates + 1 &&
    transcript.filter((entry) => entry.content === 'visibility-original-answer').length === 1)

  phase = 'outage'
  offline = true
  logicalTime += 10_000
  const outageDeliveredBefore = transcript.length
  await emit('model/rerouted', { fromModel: 'fixture-model', toModel: 'fixture-model-two', reason: 'fixture reroute' })
  logicalTime += 65_000
  await observeHeartbeatInterval()
  check('unsent outage notices do not suppress pending activity',
    transcript.length === outageDeliveredBefore &&
    state.discordOutbox.some((entry) => entry.itemKey.startsWith('progress:') && entry.content.startsWith('Codex is still working')),
    { pendingBeforeReconnect: state.discordOutbox.map(({ itemKey, turnId }) => ({ itemKey, turnId })) })

  phase = 'current-turn-reconnect'
  logicalTime += 70_000
  offline = false
  bot.client.emit(Events.ShardResume, 0, 0)
  await waitFor(() => state.discordOutbox.length === 0, 'reconnect drain')
  await settle()
  const heartbeatAfterReconnectDrain = heartbeats().length
  await observeHeartbeatInterval()
  check('actual reconnect delivery suppresses an immediate redundant heartbeat',
    heartbeats().length === heartbeatAfterReconnectDrain,
    { heartbeatAfterReconnectDrain, heartbeatAfterInterval: heartbeats().length })

  phase = 'older-turn-outage'
  logicalTime += 10_000
  offline = true
  await emit('model/verification', { verifications: ['trustedAccessForCyber'] })
  await emit('turn/completed', { turn: { id: turnId, status: 'interrupted', items: [] } })
  logicalTime += 20_000
  turnId = 'visibility-turn-b'
  await start()
  phase = 'older-turn-reconnect'
  logicalTime += 65_000
  offline = false
  bot.client.emit(Events.ShardResume, 0, 0)
  await waitFor(() => state.discordOutbox.length === 0, 'old output drain')
  await settle()
  const heartbeatBeforeOldOutputInterval = heartbeats().length
  await observeHeartbeatInterval()
  check('replayed older-turn output does not hide newer-turn work',
    heartbeats().length === heartbeatBeforeOldOutputInterval + 1)

  phase = 'send-before-acknowledgment-failure'
  logicalTime += 70_000
  failAcknowledgment = true
  await emit('model/verification', { verifications: ['fixtureVerification'] })
  const ackWasPending = state.discordOutbox.some((entry) => entry.turnId === turnId && entry.itemKey === 'model-verification')
  await chmod(home, 0o700)
  bot.client.emit(Events.ShardResume, 0, 0)
  await waitFor(() => state.discordOutbox.length === 0, 'acknowledgment retry')
  await settle()
  const heartbeatAfterAckRecovery = heartbeats().length
  await observeHeartbeatInterval()
  check('visible send counts even when acknowledgment fails and nonce retry returns the same message',
    ackWasPending && heartbeats().length === heartbeatAfterAckRecovery &&
    transcript.filter((entry) => entry.content.includes('additional account verification')).length === 1,
    { acknowledgmentWasPending: ackWasPending })

  await emit('turn/completed', { turn: { id: turnId, status: 'interrupted', items: [] } })
  await waitFor(() => state.discordOutbox.length === 0, 'final durable drain')
  const persisted = await loadState()
  check('final state has no active turn or undelivered output',
    !persisted.sessions[channelId].activeTurnId && persisted.discordOutbox.length === 0)
} catch (error) {
  fatal = { name: error.name, message: error.message, stack: error.stack }
} finally {
  await chmod(home, 0o700)
  await bot.stop().catch((error) => { fatal ??= { name: error.name, message: error.message } })
  Date.now = nativeNow
  if (previousHome === undefined) delete process.env.CORDEX_HOME
  else process.env.CORDEX_HOME = previousHome
}

const fingerprints = {}
for (const relative of ['src/discord-bot.ts', 'dist/discord-bot.js', 'scripts/check-notice-visibility.mjs']) {
  fingerprints[relative] = createHash('sha256').update(await readFile(path.join(repo, relative))).digest('hex')
}
const result = {
  scenario: 'duplicate notices/items, outage recovery, old-turn replay, and acknowledgment failure during active work',
  verificationScope: 'fault-injected notification-ingress integration; simulated Codex/Discord transports, no provider process or guild calls',
  command: 'rtk proxy node node_modules/typescript/bin/tsc -p tsconfig.json; rtk proxy node scripts/check-notice-visibility.mjs',
  actualHeartbeatIntervalMs: 6_000,
  completedAt: new Date().toISOString(),
  attempts, checks, transcript, fingerprints,
  verified: !fatal && checks.length === 7 && checks.every((entry) => entry.passed),
  ...(fatal ? { fatal } : {}),
}
await writeFile(path.join(evidence, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(`Verification artifact: ${path.join(evidence, 'result.json')}`)
await rm(home, { recursive: true })
assert.ok(result.verified, 'Notice visibility behavior check failed; inspect the artifact')
