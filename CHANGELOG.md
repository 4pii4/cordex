# Changelog

All notable changes to Cordex are documented here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [Unreleased]

### Added

- Added bounded Discord audio inputs through the private content-addressed
  attachment cache, exposing the verified local file to Codex without claiming
  app-server-native audio support.

### Changed

- Made Codex account and model-provider state read-only from Cordex. Removed the
  Discord `/login` surface and account mutation wrappers, and added a fail-closed
  RPC boundary for auth, provider, verification, import, and generic config
  mutations while retaining account reads, per-session models, and MCP OAuth.

### Fixed

- Added a durable channel fallback for `/abort` results when Discord fails
  after acknowledging the interaction, preserving background-terminal warnings
  alongside the already durable terminal turn output.
- Distinguished explicit `turn/steer` RPC rejection from response loss,
  retaining the rejected input as normal next-turn work instead of incorrectly
  holding it for manual uncertain-delivery review.
- Kept cached image and audio inputs protected for the full active-turn
  lifetime, including process recovery, so unrelated cache pruning cannot
  remove an attachment after its persisted queue record is consumed.
- Kept saved queued work running when Discord typing delivery fails, and caught
  up missed project/thread messages after gateway reconnects that cannot resume
  their prior session. Catch-up preserves chronological ingress, deduplicates
  gateway replay, retains normal access checks, and retries transient REST reads.
- Paused active persistent goals during full-process crash recovery and posted
  explicit Discord resume guidance instead of leaving goals active but idle.
- Scoped Codex runtime restart/recovery notice identities to each Cordex process
  and retained restart warnings when a fast replacement becomes ready before
  state-reset persistence finishes.
- Removed empty queue records when the last pending new-session prompt is
  discarded, while retaining rollback on persistence failure, and pruned
  legacy empty unlinked queue records during startup.
- Made `/abort` durable during pre-ID Codex session creation: the saved prompt
  is held for review, a later successful `thread/start` is deleted instead of
  delivered, and restart recovery finishes any persisted cleanup.
- Reconciled positively matched scheduled occurrences before posting uncertain
  delivery warnings, and made scheduled-prompt announcements durable and
  idempotent across crash recovery.

## [0.3.0] - 2026-10-01

### Fixed

- Isolated the default package test suite from ambient live Cordex state, with
  fail-closed explicit test-home validation and failure-state retention.
- Serialized automatic-review warning fallbacks with native notifications and
  retained the fallback when both persistence and best-effort delivery fail.
  Surfaced native strict-review requirements without implying approval.
- Counted visible activity from actual Discord sends rather than completed
  outbox drains. Duplicate notices/items no longer suppress quiet-turn updates;
  reconnect delivery refreshes the owning active turn even if acknowledgment
  persistence fails. Older-turn output and nonce retries of old messages do not
  reset a newer turn's visibility clock.

### Added

- Added opt-in, exact-user `/restart` handoff with exact session confirmation,
  comprehensive idle checks, graceful exit code 75, and durable replacement-only
  Discord confirmation for restart-on-failure supervisors.
- Added private `/approve` denial listing and exact-ID one-retry authorization
  through the native app-server RPC, retaining normal automatic review and
  preventing automatic replay after uncertain acceptance. Verified real guarded
  export approval and a non-overridable denial after an exact retry marker.
- Added `/permissions reviewer` selection and durable, privacy-aware native
  automatic-review progress/outcome notices, including concurrent and targetless
  reviews, distinct terminal statuses, and stale/duplicate notification guards.
  Coalesced native legacy review warnings with their structured outcomes while
  keeping a privacy-aware fallback when a structured completion is missing.
- Added Discord `/init` to generate or explicitly refresh `AGENTS.md` through
  durable prompt delivery in session or project directories, with linked-target
  protection, preservation of existing guidance, and visible override warnings,
  including the zero-byte override discovery case.
- Added specific-commit reviews to `/review`, including checkout-scoped
  revision resolution, annotated tags, and a full-SHA start acknowledgment.

## [0.2.1] - 2026-09-28

### Fixed

- Shipped the compiled CLI and runtime files omitted from the `0.2.0` npm
  tarball. Use `0.2.1` instead of `0.2.0`.

## [0.2.0] - 2026-09-28

### Added

- Added private `/pending-prompts` and exact-ID `/resolve-pending` controls
  for direct or queued prompts whose Codex acceptance is uncertain.
- Added private `/debug-config` diagnostics for Codex config provenance,
  layer precedence, and managed requirements without dumping raw config.
- Added `upload-to-discord` for grouped, durable project-file delivery by
  Codex session or Discord thread ID, plus a project-scoped dynamic upload tool
  for newly created Codex sessions.
- Delivered Codex-generated images as durable Discord attachments with bounded
  format validation, retry, and explicit unavailable/oversize notices.
- Added `/ps` and `/stop` for Codex background terminals in a Discord session.
- Added exact-ID-confirmed `/delete` for the current Codex session, preserving
  project files and Discord history while archiving the thread.
- Added title search and archived-session inclusion to `/last-sessions`.
- Added bounded read-only `/plugins`, `/hooks`, and `/apps` discovery using the
  stable Codex CLI plugin catalog and app-server hook/app state.
- Added exact-ID-confirmed `/plugin` install, enable, disable, and uninstall
  using stable CLI actions plus effective-state verification in Codex config.
- Added `/subagents` for read-only child-thread discovery alongside
  `/fork-subagent` continuation.
- Added a detached live-E2E runner with private logs, process-aware status,
  exit-code accounting, and a hashed result artifact.
- Added a real Codex/MCP elicitation E2E fixture covering Discord tool
  approval, a five-field form, validation, and stale-control cleanup.
- Added `/mcp` reload to refresh loaded Codex sessions after project-local MCP
  configuration changes without writing global config.

### Fixed

- Prevented startup from deleting valid project and session mappings when
  Discord.js has not cached their guild yet; destructive pruning now checks
  raw Discord channel metadata and retains unverifiable entries.
- Reconciled idle or replacement Codex turns after an ambiguous steer without
  replaying the prompt or leaving a stale Discord activity heartbeat.
- Held restart-uncertain direct prompts and following queued work for explicit
  review, while reconciling already accepted client IDs without replay.
- Held direct and queued prompts after ambiguous in-process Codex turn RPC
  failures, with a durable queued handoff marker and no automatic client-ID
  replay; private slash commands now acknowledge before optional access lookup.
- Held recovered running scheduled occurrences with no surviving queue entry
  for delivery review, and stopped announcing them as delivered while held.
- Saved a new session's first prompt with its Codex thread mapping, then
  marked delivery before the turn RPC so an unacknowledged first message can
  be reviewed instead of silently lost or automatically replayed.
- Reported held first prompts even when their empty Codex thread has no
  persisted rollout; exact-ID Retry can save a replacement thread before
  delivery, while Discard keeps later queued work held for review.
- Limited empty-thread status-only recovery to a just-created Codex thread
  before any turn attempt; unsupported persisted history now holds saved work
  for review instead of silently replaying it.
- Persisted first prompts and settings before Codex returns a new thread ID;
  unmapped Discord threads now show durable pending-start review, queue later
  messages, and support exact-ID Retry or Discard without guessing an orphan
  Codex thread ID.
- Added privacy-safe timing diagnostics for Discord interaction age, initial
  callback latency, gateway ping, and event-loop delay to distinguish late
  slash-command delivery from slow acknowledgments.
- Updated private slash-command deferral to the flags-based ephemeral API
  and made slow successful acknowledgments visible in normal logs.
- Preserved new Discord session threads and automatic worktrees when Codex
  session creation fails after the first prompt is saved, and blocked project
  removal while pending starts still need review.
- Corrected the interrupted-turn restart notice when saved prompts are being
  reconciled automatically, so Discord no longer tells users to resend work
  that may already be running.
- Added bounded pre-turn Discord activity for slow new-session creation and
  existing-session recovery, with nonce-stable retry and timer cleanup when
  the active Codex turn takes over.
- Reported active-turn model verification, safety buffering, reroutes, long
  synchronous hooks, and retry warnings through scoped durable Discord output;
  staged-but-undelivered text no longer suppresses activity heartbeats.
- Made `/status` distinguish active from next-turn model settings and show the
  requested approval policy, sandbox, writable roots, working directory, and
  context usage instead of mislabeling YOLO as `workspace-write`.
- Restored `/rollback` on current Codex app-server versions by continuing from
  the retained turns in a new session; removing every turn starts a fresh session.
- Persisted a replacement managed category even when the root channel was
  intentionally deleted, preventing duplicate empty categories on restart.
- Made `/diff` include untracked files and work before the first Git commit,
  while keeping size and timeout failures explicit.
- Reloaded session-scoped Codex settings and reviews after a bot restart before
  sending RPCs that require a loaded thread.
- Kept root review turns active across nested review events, and added bounded,
  activity-aware progress and terminal messages for otherwise silent work.
- Superseded undelivered progress notices with newer activity or real output
  so reconnect does not replay stale working messages after the final answer.
- Retried durable Discord output with backoff while the bot remains running,
  including after a gateway reconnect.
- Reported background terminals still running after `/abort` instead of
  implying that every command process stopped.
- Warned once when a normally completed turn leaves a new background terminal
  running, without holding the final answer on terminal inspection.
- Queued durable notices for Codex runtime restarts and for Cordex startup
  when a session had an in-flight turn recorded.
- Made session history explicitly include app-server sources and page within
  mapped project directories, avoiding the global first-100 cutoff.
- Recognized current `collabToolCall` and legacy `collabAgentToolCall` items
  when discovering and displaying subagent activity.
- Stopped treating an intentional app-server shutdown as a child crash while
  preserving restart handling for unexpected exits.
- Kept structured-question answers moving when a Discord echo send fails, and
  fell back to message editing or a durable notice when an approval click
  could not update its original interaction.
- Bound each live Cordex state object to its original state-file path so late
  asynchronous writes cannot follow a changed `CORDEX_HOME`; live E2E fake bots
  now drain through `stop()` before restoring their test environment.
- Isolated the subagent, extension, and plugin-lifecycle fake bots in temporary
  Cordex homes so their event handlers cannot overwrite the user's live state.
- Passed the session's current directory on every Codex `turn/start`, so a
  retained session can use relative commands after its merged worktree is removed.
- Refused worktree creation when its deterministic managed directory already
  exists instead of recursively deleting that path.
- Retained Codex's effective reasoning effort from new and forked thread
  responses so first-turn status matches the real model setting before resume.

## [0.1.7] - 2026-08-01

### Added

- Structured Discord and Codex runtime logging with bounded, secret-safe
  diagnostics.
- Markdown-aware, Unicode-safe Discord output splitting with semantic and hard
  size limits.

### Changed

- Disabled passive goal and session auto-resume during startup and recovery;
  queued follow-ups remain recoverable without silently restarting work.
- Suppressed follow-up notifications only when an actual queued prompt exists,
  and omitted footers for empty successful turns.

### Fixed

- Made abort, Discord-thread deletion, and project removal crash-durable across
  Codex RPC failures, state-write failures, and restart reconciliation.
- Hardened prompt and outbox locking, rollback, late-output guards, and bounded
  deletion cleanup.
- Added root-channel tombstones, branch autocomplete, clamped command
  descriptions, and bounded `/clear-queue` details.

## [0.1.6] - 2026-08-01

### Fixed

- Kept durable Discord output within the 25-character nonce limit and normalized
  pending entries written with the legacy 32-character nonce format.

## [0.1.5] - 2026-07-19

### Changed

- Reworked the README around a one-command npm quick start, concise common-command
  guidance, corrected Discord permissions, and collapsed advanced runtime details.
- Replaced the init-only command hint with invocation-neutral startup guidance
  that is also accurate during a bare `npx` first run.

### Fixed

- Made inherited-session and worktree-race tests independent of an existing
  user-level Cordex configuration so clean CI homes exercise the intended logic.

## [0.1.4] - 2026-07-19

### Added

- Up to ten repeated `--file` attachments for `cordex send --thread`, with mixed
  UTF-8 text and image input, aggregate limits, legacy client compatibility, and
  duplicate-image suppression.
- Passive Discord conversation context for messages in Cordex threads that begin
  with a mention of another user, without starting or steering a Codex turn.
- `/skill-toggle` and `/skill-roots` controls backed by Codex skill configuration.
- Stable Codex app-server wrappers for thread item injection, hooks, plugins,
  marketplaces, skill configuration, account logout, and workspace messages.

### Changed

- `/diff` now delivers complete binary-capable patches, using bounded attachments
  when an inline response would be incomplete.
- `/worktrees` now inventories main, Cordex-managed, and unlinked Git worktrees with
  checkout state, branch comparison, reachability, lock, prune, and error details.

## [0.1.3] - 2026-07-19

### Added

- Authenticated local Unix-socket automation through `cordex send --thread`,
  including daemon-side text and image file ingestion with durable prompt enqueue.
- Stable MCP form and URL elicitation controls with typed validation, safe URL
  handling, empty-form persistence choices, and restart/timeout cleanup.
- `/delete-worktree` for exact, clean, merged worktree removal with durable startup
  reconciliation and session reload at the project root.

### Changed

- Made archive and resume crash-durable through persisted lifecycle intents and
  reconciliation against complete active and archived Codex thread listings.
- Graceful shutdown now stops new ingress and drains Discord interactions, Codex
  requests and notifications, scheduled work, state/outbox queues, and deletion
  cleanup before closing the runtime.

## [0.1.2] - 2026-07-18

### Added

- Public setup, security, configuration, command, and development documentation.
- Contribution and vulnerability-reporting guidance.
- Owner-only default access with explicit Discord user and role ID allowlists.
- Private-by-default managed Discord category permissions.
- Persistent managed-category identity and permission synchronization.
- Guild-scoped mapping and scheduled-task validation when server configuration changes.
- Opt-in direct host shell execution.
- Ephemeral authentication, account, and sensitive diagnostic replies.
- Discord streaming and restart recovery for autonomous Codex goal turns and continuations.
- Visible terminal goal states, backend warnings, and failed-turn errors.
- Automatic Codex app-server restart with bounded backoff and session rehydration.
- Initialization and RPC watchdogs for live but unresponsive Codex app-server children.
- Discord reply context, MIME-aware text attachments, and durable local image input.
- Exact Codex approval choices, external request-resolution cleanup, and `. btw` side-session suffixes.
- Reversible Discord/Codex session archive and resume with archived autocomplete choices.
- Bidirectional session title synchronization and the `/rename` command.
- Native `/skill` invocation with project-aware autocomplete and optional prompts.
- Configurable Discord approval expiry through `approvalTimeoutMinutes`.
- A process-lifetime runtime lock that prevents duplicate bot instances from
  sharing one Cordex state directory.
- Crash-recoverable existing-session prompt ingress with stable delivery IDs and
  startup reconciliation of queued Discord message edits and deletions.
- A durable Discord output outbox with stable chunk nonces, partial-send recovery,
  duplicate suppression, and restart replay for completed output and run footers.
- Bounded `/tasks` controls for running scheduled work immediately, cancelling an
  in-progress occurrence, and deleting terminal task history.
- Model-catalog support for model-specific reasoning efforts, service tiers,
  input modalities, and custom Fast-tier identifiers.

### Changed

- Standardized the project name, CLI, runtime identifiers, and configuration paths as Cordex.
- Raised the minimum supported Node.js version to 22.
- Made live-test environment setup portable across supported operating systems.
- Licensed Cordex under GPL-3.0-only while retaining required upstream notices.
- Preserved omitted goal fields and made queued prompts safe across autonomous
  goal continuations and failed turns.
- Serialized Discord message preprocessing and reconciled stale turn IDs so slow
  attachments, delayed lifecycle events, and rapid follow-ups preserve input order.
- Confirmed persisted client message IDs before retrying ambiguous turn delivery,
  preventing duplicate starts and steers after lost app-server responses.
- Kept queued prompts persisted until delivery confirmation, serialized queue
  edits with delivery, and assigned recurring tasks occurrence-unique IDs.
- Acknowledged serialized slash commands before waiting, kept `/abort` on its
  priority path, and interrupted deleted Discord threads immediately.
- Pruned sessions whose Discord threads were deleted while Cordex was offline,
  and deleted empty Codex threads that never materialized a first turn.
- Bounded attachment downloads by time, per-file size, per-message size, and a
  protected cache retention policy.
- Preserved worktree, model, permission, context, queue, and task metadata across
  archive/resume while reconciling external archive, close, and delete events.
- Canonicalized Discord and Codex session titles to a shared whitespace-normalized
  80-character form, including forks, worktrees, merges, and resumed sessions.
- Preserved native skill inputs through queued prompt edits and resumed history,
  with `skills/changed` and app-server restart cache invalidation.
- Retried transient queued-source reconciliation with capped backoff, recovered
  scheduled tasks left running across restart, and persisted merge-conflict
  recovery prompts before Codex delivery.
- Captured immutable state snapshots at each queued persistence boundary so
  later in-memory mutations cannot leak into an earlier commit, and invalidated
  snapshots behind a failed write cannot persist rolled-back state.
- Persisted model, Fast, permission, and YOLO settings before applying live Codex
  updates, with rollback when the RPC fails.
- Capped aggregate rendered Discord text input independently of attachment bytes,
  including forwarded content, embeds, polls, replies, and text attachments.
- Fetched configured remotes before worktree creation, preferred strictly newer
  refs across remotes, initialized submodules recursively, and serialized merge
  validation against sessions inheriting or actively using the same checkout.
- Finalized no-op worktree merges at the target commit and waited for Git helper
  processes to close before inspecting fetched refs.
- Staged terminal Discord output before turn finalization and held mutating
  interactions behind startup and app-server recovery barriers.
