# Changelog

All notable changes to Cordex will be documented in this file. The project aims
to follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning once tagged releases begin.

## [Unreleased]

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
