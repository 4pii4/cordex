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

// Fault-injected notification-ingress integration, not live provider/guild E2E.
const repo = fileURLToPath(new URL('../', import.meta.url))
const home = await mkdtemp(path.join(tmpdir(), 'cordex-approval-reporting-home-'))
const evidence = await mkdtemp(path.join(tmpdir(), 'cordex-approval-reporting-evidence-'))
const previousHome = process.env.CORDEX_HOME
process.env.CORDEX_HOME = home
const state = emptyState()
const threadId = 'approval-reporting-thread'
const channelId = 'approval-reporting-channel'
const turnId = 'approval-reporting-turn'
const privateCanary = 'PRIVATE_APPROVAL_CANARY_DO_NOT_POST'
let phase = 'setup'
let offline = false
let blockedSend
let blockEntered = false
const transcript = []
const checks = []
const observations = []
const nonces = new Map()
const codex = Object.assign(new EventEmitter(), {
  async close() {},
  async getThreadGoal() { return undefined },
  async listBackgroundTerminals() { return [] },
})
state.channelVerbosity['approval-project'] = 'text_only'
state.sessions[channelId] = {
  discordThreadId: channelId, parentChannelId: 'approval-project', directory: home,
  codexThreadId: threadId, approvalsReviewer: 'auto_review',
  model: 'fixture-model', effort: 'low', updatedAt: new Date().toISOString(),
}
const channel = {
  id: channelId, name: 'Approval reporting protocol fixture', archived: false,
  isThread: () => true,
  async sendTyping() {},
  async send(payload) {
    if (offline) throw new Error('Fixture Discord is offline')
    const content = typeof payload === 'string' ? payload : payload.content || ''
    if (content.includes('fixture queue blockade') && blockedSend) {
      blockEntered = true
      await blockedSend.promise
    }
    if (payload.enforceNonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce)
    const message = { id: `approval-message-${transcript.length + 1}`, content,
      createdTimestamp: Date.now(), async edit() { return this } }
    transcript.push({ phase, content, nonce: payload.nonce, at: Date.now() })
    if (payload.enforceNonce) nonces.set(payload.nonce, message)
    return message
  },
}
const bot = new CordexDiscordBot({
  token: 'fixture-token', applicationId: 'fixture-application', guildId: 'fixture-guild',
  sandbox: 'read-only', approvalPolicy: 'never', allowAllUsers: true,
  allowShellCommands: false, projects: { 'approval-project': { directory: home } },
}, state, codex)
bot.client.channels.fetch = async (id) => id === channelId ? channel : undefined

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(condition, label, timeout = 10_000) {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(20)
  }
}
function send(method, params = {}) {
  codex.emit('notification', { method, params: { threadId, turnId, ...params } })
}
async function settle(includeBackground = false) {
  await waitFor(() => bot.pendingCodexNotifications.size === 0, 'notification ingress')
  if (includeBackground) {
    await waitFor(() => bot.pendingBackgroundWork.size === 0, 'delayed reporting')
    await waitFor(() => bot.pendingCodexNotifications.size === 0, 'final notification ingress')
  }
}
async function emit(method, params = {}) { send(method, params); await settle() }
function review(reviewId, status, action = { type: 'command', command: privateCanary, cwd: '/tmp', source: 'shell' }) {
  return { reviewId, targetItemId: action.type === 'networkAccess' ? null : 'same-parent-item',
    startedAtMs: Date.now(), completedAtMs: Date.now(), decisionSource: 'agent', action,
    review: { status, rationale: privateCanary, riskLevel: 'low', userAuthorization: 'high' } }
}
function legacy(status = 'approved', rationale = privateCanary) {
  return { message: `Automatic approval review ${status} (risk: low, authorization: high): ${rationale}` }
}
function check(name, passed, fields = {}) {
  checks.push({ name, passed, ...fields })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
}
function phaseMessages(name) { return transcript.filter((entry) => entry.phase === name).map((entry) => entry.content) }
function outcomeMessages(name) { return phaseMessages(name).filter((content) => /automatic review (approved|denied|timed out|aborted)/.test(content)) }
let fatal
try {
  await emit('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
  phase = 'completion-queued-behind-blocked-send'
  await emit('item/autoApprovalReview/started', review('blocked-review', 'inProgress'))
  await emit('guardianWarning', legacy())
  let release
  blockedSend = { promise: new Promise((resolve) => { release = resolve }) }
  send('warning', { message: 'fixture queue blockade' })
  await waitFor(() => blockEntered, 'blocked Discord send')
  send('item/autoApprovalReview/completed', review('blocked-review', 'approved'))
  await delay(2_500)
  release()
  await settle(true)
  blockedSend = undefined
  check('queued structured completion suppresses timer fallback despite a slow preceding send',
    outcomeMessages(phase).length === 1, { outcomes: outcomeMessages(phase).length })

  phase = 'persistence-and-send-failure'
  await emit('item/autoApprovalReview/started', review('disk-failure-review', 'inProgress'))
  await emit('guardianWarning', legacy('denied', 'unique disk failure reason'))
  offline = true
  await chmod(home, 0o500)
  await emit('item/autoApprovalReview/completed', {
    ...review('disk-failure-review', 'denied'),
    review: { status: 'denied', rationale: 'unique disk failure reason' },
  })
  await chmod(home, 0o700)
  offline = false
  await settle(true)
  check('failed persistence and failed best-effort send leave the legacy fallback usable',
    outcomeMessages(phase).length === 1 && outcomeMessages(phase)[0].includes('denied'),
    { outcomes: outcomeMessages(phase).length })

  phase = 'durable-outage-recovery'
  await emit('item/autoApprovalReview/started', review('outage-review', 'inProgress'))
  offline = true
  await emit('guardianWarning', legacy('approved', 'unique outage reason'))
  await emit('item/autoApprovalReview/completed', {
    ...review('outage-review', 'approved'),
    review: { status: 'approved', rationale: 'unique outage reason' },
  })
  await settle(true)
  const pending = state.discordOutbox.filter((entry) => entry.itemKey.includes('auto-review:'))
  check('an offline structured decision is retained once rather than replaced by a legacy duplicate',
    pending.length === 1 && pending[0].itemKey === 'auto-review:outage-review:completed')
  offline = false
  bot.client.emit(Events.ShardResume, 0, 0)
  await waitFor(() => state.discordOutbox.length === 0, 'reconnect drain')
  check('reconnect delivers the durable decision once', outcomeMessages(phase).length === 1)

  phase = 'concurrent-identical-reasons'
  const network = { type: 'networkAccess', host: 'fixture.invalid', port: 443, protocol: 'https', target: privateCanary }
  await emit('item/autoApprovalReview/started', review('network-one', 'inProgress', network))
  await emit('item/autoApprovalReview/started', review('network-two', 'inProgress', network))
  await emit('item/autoApprovalReview/completed', review('network-two', 'approved', network))
  await emit('item/autoApprovalReview/completed', review('network-one', 'approved', network))
  await emit('item/autoApprovalReview/completed', review('network-two', 'approved', network))
  await emit('item/autoApprovalReview/started', review('network-one', 'inProgress', network))
  check('concurrent targetless IDs with identical reasons remain distinct and reject duplicate/late-start events',
    outcomeMessages(phase).length === 2 && phaseMessages(phase).filter((v) => v.includes('is reviewing')).length === 2)

  phase = 'terminal-statuses-and-shared-parent'
  const statuses = ['approved', 'denied', 'timedOut', 'aborted']
  const actions = [
    { type: 'writeStdin', approvalId: 'stdin-one', processId: 'process-one', stdin: privateCanary, cwd: '/tmp' },
    { type: 'execve', program: '/tmp/fixture', argv: [privateCanary], cwd: '/tmp', source: 'unifiedExec' },
    { type: 'applyPatch', cwd: '/tmp', files: ['/tmp/' + privateCanary] },
    { type: 'mcpToolCall', server: 'fixture-server', toolName: privateCanary },
  ]
  for (let n = 0; n < statuses.length; n++) {
    await emit('item/autoApprovalReview/started', review(`status-${n}`, 'inProgress', actions[n]))
    await emit('item/autoApprovalReview/completed', review(`status-${n}`, statuses[n], actions[n]))
  }
  const outcomes = outcomeMessages(phase)
  check('shared-parent reviews preserve four distinct terminal decisions',
    outcomes.length === 4 && ['approved', 'denied', 'timed out', 'aborted'].every((s) => outcomes.some((v) => v.includes(s))))
  check('approval is not presented as execution success and timeout/abort do not grant approval',
    outcomes.some((v) => v.includes('does not confirm execution succeeded')) &&
    outcomes.filter((v) => v.includes('The action was not approved by this review')).length === 2)

  phase = 'strict-review-required'
  const strict = { startedAtMs: Date.now() }
  await emit('autoApprovalReview/strictReviewRequired', strict)
  await emit('autoApprovalReview/strictReviewRequired', strict)
  await emit('autoApprovalReview/strictReviewRequired', { ...strict, turnId: 'stale-turn' })
  await emit('autoApprovalReview/strictReviewRequired', { ...strict, threadId: 'unmapped-thread' })
  check('strict-review-required is visible once and stale/unmapped notices are ignored',
    phaseMessages(phase).length === 1 && /stricter automatic approval review/.test(phaseMessages(phase)[0]))

  phase = 'unknown-status-and-missing-id'
  await emit('item/autoApprovalReview/completed', review('future-review', 'futureStatus'))
  await emit('item/autoApprovalReview/completed', review('future-review', 'futureStatus'))
  await emit('item/autoApprovalReview/completed', review('future-review', 'approved'))
  const withoutId = review('discard-id', 'denied')
  delete withoutId.reviewId
  await emit('item/autoApprovalReview/completed', withoutId)
  check('unknown results warn once without client approval and allow a later recognized result',
    phaseMessages(phase).filter((v) => v.includes('No client approval was granted')).length === 1 && outcomeMessages(phase).length === 1)
  check('missing review IDs are reported rather than silently discarded',
    phaseMessages(phase).some((v) => v.includes('without its review ID')))

  phase = 'later-native-receipt-boundary'
  await emit('guardianWarning', legacy('denied', 'late receipt reason'))
  await settle(true)
  await emit('item/autoApprovalReview/completed', {
    ...review('late-receipt-review', 'denied'), review: { status: 'denied', rationale: 'late receipt reason' },
  })
  observations.push({ name: 'completion received only after fallback was already delivered',
    outcomes: outcomeMessages(phase).length, resolved: outcomeMessages(phase).length === 1,
    reason: 'legacy warning has no review ID; do not collapse independent native reviews by rationale alone' })
  check('text_only hides raw action data, risk, authorization and rationale across all delivery paths',
    transcript.every(({ content }) => !content.includes(privateCanary) && !content.includes('Reason:') && !content.includes('Risk assessed') && !content.includes('authorization assessed')))

  await emit('turn/completed', { turn: { id: turnId, status: 'interrupted', items: [] } })
  await settle(true)
  const persisted = await loadState()
  check('final state is idle with all output drained',
    !persisted.sessions[channelId].activeTurnId && persisted.discordOutbox.length === 0)
} catch (error) {
  fatal = { name: error.name, message: error.message, stack: error.stack }
} finally {
  await chmod(home, 0o700)
  if (blockedSend) blockedSend = undefined
  await bot.stop().catch((error) => { fatal ??= { name: error.name, message: error.message } })
  if (previousHome === undefined) delete process.env.CORDEX_HOME
  else process.env.CORDEX_HOME = previousHome
}
const fingerprints = {}
for (const relative of ['src/discord-bot.ts', 'dist/discord-bot.js', 'src/auto-review.ts', 'scripts/check-approval-reporting.mjs']) {
  fingerprints[relative] = createHash('sha256').update(await readFile(path.join(repo, relative))).digest('hex')
}
const result = {
  verificationScope: 'fault-injected notification-ingress integration; simulated Codex/Discord transports, no provider process or guild calls',
  command: 'rtk proxy node node_modules/typescript/bin/tsc -p tsconfig.json; rtk proxy node scripts/check-approval-reporting.mjs',
  completedAt: new Date().toISOString(), checks, observations, transcript, fingerprints,
  verified: !fatal && checks.length === 12 && checks.every((entry) => entry.passed),
  unresolved: ['Actual late-receipt correlation without a legacy review ID', 'Opaque native event retrieval for exact-action denied-action retry', 'Live provider and Discord UI verification'],
  ...(fatal ? { fatal } : {}),
}
await writeFile(path.join(evidence, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(`Verification artifact: ${path.join(evidence, 'result.json')}`)
await rm(home, { recursive: true })
assert.ok(result.verified, 'Approval reporting behavior check failed; inspect the artifact and unresolved boundaries')
