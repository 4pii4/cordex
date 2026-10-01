<div align="center">
  <h1>Cordex</h1>
  <p>Run persistent OpenAI Codex sessions from Discord.</p>
</div>

Cordex turns Discord into a control surface for
[OpenAI Codex](https://developers.openai.com/codex/cli/). Each Discord channel
maps to a local project, and each thread is a persistent Codex session. Send a
message and Codex can read, edit, test, and run commands on the machine hosting
Cordex.

> [!WARNING]
> Cordex can read and modify local files, run shell commands, and—when explicitly
> enabled—run Codex without approvals or sandboxing. Run it on a machine and in a
> Discord server you control, restrict access to trusted members, and keep the
> default `workspace-write` sandbox with `on-request` approvals unless you fully
> understand the consequences.

## Quick Start

Requires Node.js 22 or newer and Git.

1. Install the Codex CLI, then authenticate it on the machine that will run
   Cordex:

   ```bash
   npm install -g @openai/codex
   codex login
   codex --version
   ```

2. Create a Discord application and collect its bot token, application ID, and
   server ID using the [Discord bot setup](#discord-bot-setup) below.

3. Start Cordex with one command:

   ```bash
   npx -y @4pii4/cordex@latest
   ```

   On the first run, Cordex asks for the three Discord values, saves its config,
   registers the slash commands, and starts the bot. Keep this process running.

4. As the Discord server owner, open the managed general channel (`#cordex` when
   the bot is named Cordex) and send a task. Cordex creates a thread for the new
   Codex session. Add an existing repository with `/add-project` or from another
   terminal:

   ```bash
   npx -y @4pii4/cordex@latest project add /absolute/path/to/project
   ```

For a permanent `cordex` command, install the package globally:

```bash
npm install -g @4pii4/cordex
cordex
```

## What is Cordex?

Cordex maps Discord's project and conversation structure directly onto the local
Codex runtime:

| Discord | Local Codex runtime |
| --- | --- |
| Project channel | Local project directory |
| Thread in that channel | Persistent Codex session |

Send a message in a project channel to start a session thread. Continue chatting
in that thread to keep working in the same Codex context. Switch projects by
switching channels, and switch tasks by switching threads.

## Core Features

- Remote Codex prompting from Discord with persistent, resumable sessions
- Live responses, compact tool activity, approvals, and structured user questions
- Dedicated Discord channels for local projects and optional git worktree isolation
- Project- or session-level model, reasoning, collaboration mode, and permission controls
- Queued and scheduled prompts with restart recovery
- Native Codex skill invocation plus MCP, authentication, account, rate-limit, and context diagnostics
- Codex plugin discovery and management, plus read-only hook trust and app state
- Reply-aware text and image input, code review, diffs, rollback, and controlled shell execution

## Setup

### Requirements

- Node.js 22 or newer
- A Codex CLI installation with app-server support
- A Discord application and bot added to a server you control
- Git (Cordex initializes its managed root repository at startup and also uses
  Git for project creation and worktree features)

Authenticate Codex on the host before starting Cordex:

```bash
codex login
codex --version
```

Cordex uses Codex's app-server interface, which is currently experimental. A
Codex CLI update can therefore require a corresponding Cordex update.

### Discord bot setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot**, create the bot user, and enable the **Message Content Intent**.
3. In the OAuth2 URL generator, select the `bot` and `applications.commands` scopes.
4. Grant the bot these permissions:

   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Manage Threads
   - Manage Channels
   - Manage Roles (shown as **Manage Permissions** in some Discord clients)
   - Read Message History
   - Attach Files

   The combined permission integer is `326686051344`. To skip selecting each
   permission manually, replace `APPLICATION_ID` in this invite URL:

   ```text
   https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=326686051344&scope=bot%20applications.commands
   ```
5. Install the bot into the intended Discord server.
6. Copy the bot token, application ID, and server ID for `cordex init`. Enable
   Discord Developer Mode if you need to copy the server ID.

Treat the bot token like a password. Never commit it, paste it into a Discord
channel, or expose it in logs.

### Install

Install the published CLI globally:

```bash
npm install -g @4pii4/cordex
cordex --version
```

Or run it without a global install:

```bash
npx -y @4pii4/cordex@latest --version
npx -y @4pii4/cordex@latest init
npx -y @4pii4/cordex@latest start
```

The remaining examples use the global `cordex` command for brevity. Without a
global install, replace it with `npx -y @4pii4/cordex@latest`.

### Initialize and run

If you installed Cordex globally, the explicit setup flow is:

```bash
cordex init
cordex doctor
cordex start
```

`cordex init` prompts for the Discord bot token, application ID, and server ID.
Rerunning it preserves existing settings when prompts are left blank. Changing
the server ID clears guild-scoped mappings, sessions, access grants, and direct
shell access so state from the previous server cannot carry over.
Running bare `cordex` also initializes the configuration when necessary and then
starts the bot. On startup, Cordex registers its slash commands and creates a
managed category with a general project channel. Name the Discord bot `Cordex`
to use the default `Cordex` category and `#cordex` channel; other bot names are
appended so multiple installations can coexist.

Add an existing local project from the terminal:

```bash
cordex project add /absolute/path/to/project
```

Alternatively, use `/add-project` in Discord. Use `/create-new-project` to create
a new git repository, Discord channel, and initial session together. Then send a
normal message in the project channel; Cordex creates a thread and starts Codex.

Useful terminal project commands include:

```bash
cordex project add .
cordex project create my-app --projects-dir ~/src
cordex project list --json
cordex project list --all --prune
cordex project open-in-discord
cordex project remove DISCORD_CHANNEL_ID
```

`cordex project remove` removes the local mapping without deleting project files.
Discord `/remove-project` deletes the selected managed Discord channel after its
safety checks.

While `cordex start` is running, another local process owned by the same operating-
system user can durably submit a prompt to an existing Cordex session thread:

```bash
cordex send --thread DISCORD_THREAD_ID "Run the focused tests"
cordex send --thread DISCORD_THREAD_ID --file ./failure.log "Diagnose this failure"
cordex send --thread DISCORD_THREAD_ID --file ./error.log --file ./screenshot.png "Investigate these artifacts"
```

The daemon reads up to ten repeated `--file` values itself and accepts mixed UTF-8
text plus PNG, JPEG, GIF, and WebP images within the same per-file and aggregate
limits as Discord input. Byte-identical images are sent to Codex once. It listens
on a mode-`0600` Unix socket under `~/.cordex/ipc` and authenticates each request
with a per-start mode-`0600` token. Accepted prompts enter the durable direct-
delivery ledger before the CLI reports success. Safe channel or session creation
is not yet exposed by this boundary; use `--thread` with an existing Cordex thread.

To post files back to Discord without starting another Codex turn:

```bash
cordex upload-to-discord --session CODEX_SESSION_ID ./screenshot-1.png ./screenshot-2.png
cordex upload-to-discord --thread DISCORD_THREAD_ID ./report.csv
```

Uploads keep up to ten files in one Discord message (an image grid for multiple
images), with an 8 MiB aggregate safety limit. Paths must resolve inside that
session's current directory by default, including after symlinks are resolved.
Use `--allow-outside-project` only for an explicit path you intend to disclose;
`--request-id ID` makes a retry idempotent. The daemon copies accepted bytes
into a private cache and retries Discord delivery across network failures and
bot restarts. Permanent Discord file rejection produces a visible text notice
instead of retrying the invalid upload forever. New Codex sessions also expose
`cordex_upload_files`, which lets
the agent deliver verified project files without connecting to the daemon
socket from its sandbox. Older sessions can use the CLI with a one-time Codex
command approval until they are recreated with the new tool.

Inside an existing Cordex thread, a message beginning with a mention of another
Discord user is stored as passive model context without starting or steering a
Codex turn. The next real prompt can use that user-to-user discussion.

For detailed backend logging, run:

```bash
cordex start --verbose
```

Verbose logs can include prompts, tool calls, commands, file paths, and Codex
protocol traffic. Store and share them accordingly.

## Commands

Slash commands are registered in the configured Discord server.

| Command | Description |
| --- | --- |
| `/add-project` | Map an existing local repository to a Discord channel |
| `/new-session` | Start another session, inheriting the current checkout when used in a thread |
| `/resume` | Reopen a previous active or archived Codex session |
| `/abort` | Interrupt the current Codex turn and warn if a command remains running |
| `/ps` / `/stop` | Inspect or terminate background commands left in the session |
| `/delete` | Permanently delete the current Codex transcript after exact-ID confirmation |
| `/plugins` / `/hooks` / `/apps` | Inspect extension availability and trust state |
| `/plugin` | Inspect, install, enable, disable, or uninstall a Codex plugin |
| `/subagents` / `/fork-subagent` | Inspect child agents or continue one in a new thread |
| `/model` | Change the model and reasoning settings for a channel or session |
| `/permissions` | List or select a Codex permission profile for the current session |
| `/queue` | Run a prompt after the current turn finishes |
| `/pending-prompts` / `/resolve-pending` | Privately review a prompt with uncertain Codex delivery, then retry or discard its exact ID |
| `/btw` | Fork the current context into a side session |
| `/new-worktree` | Fork the current session into an isolated Git worktree |
| `/merge-worktree` | Merge a completed worktree back into its target branch |
| `/diff` | Show or attach the complete current Git patch |
| `/status` | Show the working directory, current/next model, requested policy, context usage, and queue |
| `/debug-config` | Privately inspect Codex config layers, safe effective defaults, and managed policy presence |

<details>
<summary>Full command inventory and behavior</summary>

### Commands by area

| Area | Commands |
| --- | --- |
| Projects | `/add-project`, `/create-new-project`, `/remove-project`, `/project`, `/init` |
| Sessions | `/new-session`, `/resume`, `/rename`, `/fork`, `/subagents`, `/fork-subagent`, `/btw`, `/abort`, `/ps`, `/stop`, `/archive`, `/delete`, `/compact`, `/last-sessions`, `/session-id`, `/status`, `/debug-config` |
| Models and runtime | `/model`, `/model-variant`, `/unset-model-override`, `/mode`, `/fast`, `/permissions`, `/add-dir`, `/verbosity`, `/context-usage` |
| Goals | `/goal`, `/clear-goal` |
| Git and worktrees | `/diff`, `/review`, `/rollback`, `/new-worktree`, `/merge-worktree`, `/delete-worktree`, `/toggle-worktrees`, `/worktrees` |
| Automation | `/queue`, `/clear-queue`, `/pending-prompts`, `/resolve-pending`, `/schedule`, `/tasks`, `/cancel-task` |
| Codex services | `/skill`, `/skills`, `/skill-toggle`, `/skill-roots`, `/plugins`, `/plugin`, `/hooks`, `/apps`, `/mcp`, `/mcp-status`, `/mcp-login`, `/auth-status`, `/rate-limits`, `/account-usage` |
| Host control | `/run-shell-command`, `!command`, `/yolo`, `/restart` |

`/diff` renders small patches inline and attaches the complete binary-capable
patch when it exceeds Discord message limits.

Cordex treats Codex account and model-provider state as read-only. Manage
provider login, logout, credentials, and provider configuration directly on the
host with the Codex CLI. Discord can inspect authentication, limits, and usage,
but cannot mutate provider state. Per-session `/model` choices and MCP-server
OAuth are separate and remain available.

Discord `/init` asks Codex to generate repository-specific contributor guidance
in `AGENTS.md` in the current session directory. In a project channel, it starts
a session using the normal worktree preference. Existing guides require explicit
`update=true`; refreshes preserve their instructions, and linked or non-file
targets are rejected. Optional `instructions` adds project-specific guidance.
Codex reports generation through its normal progress/output path. Start a fresh
session with `/new-session` to load the updated guide. `/init` warns when
`AGENTS.override.md` is present and leaves it untouched. In live Codex 0.159.0,
even a zero-byte override prevented automatic loading of `AGENTS.md`; review
the override before assuming the generated guide is active. This differs from the terminal
`cordex init` command, which configures the Discord bot.

`/permissions reviewer=auto_review` routes eligible approval requests to Codex's
automatic reviewer; `reviewer=user` restores human approvals, and
`reviewer=default` restores the current project-configured reviewer. A `profile`
may be selected in the same command. Reviewer preferences apply to subsequent
turns and persist across session resume/fork and bot restart. They do not expand
filesystem or network access, and full access or `approval_policy=never` can
bypass review. Automatic-review notices distinguish approval from execution,
show separate denied/aborted/timed-out results, and omit rationale and action
details in `text_only` mode. Stricter-review requirements are surfaced without
claiming approval. Legacy-warning fallbacks share the thread's notification
queue and are suppressed only after the structured notice is durable or sent.
A completion first received after its legacy fallback was already posted can
still produce a second notice; that legacy warning carries no review ID.
`/approve` privately lists up to ten recent native denials in this session.
`/approve review:<exact ID>` records approval context for one retry using the
native `thread/approveGuardianDeniedAction` RPC and the official TUI's event
conversion. It does not start a turn, execute the action, change permissions,
disable review, or remember a command rule. Ask Codex to retry the exact action;
the reviewer can still deny it. Consumed/foreign IDs and unsupported native
payloads fail closed. Entries are in memory and expire when the native thread
closes, the runtime is replaced, or the session is deleted.
An uncertain RPC acceptance is not automatically resent. Approval commands and
their diagnostics have no public-output fallback.

`/review` supports uncommitted changes, a base branch, a specific commit, or
custom instructions. For `target=commit`, supply `commit` as a SHA, abbreviated
SHA, tag, or other Git revision; Cordex resolves it to an immutable commit in
the current session checkout and shows the full SHA when the review starts.
The optional `title` applies only to commit reviews. Review preserves project
files and the Git index.

During quiet turns, Cordex posts a status after about six seconds and then at
most once a minute without visible output. It reports the current activity
without exposing command details in `text_only` mode. Undelivered status
notices are superseded by newer progress or the final answer when Discord
reconnects. Cordex warns when a completed turn leaves a background command
running. `/abort` interrupts the Codex turn; a command that outlives it can be
inspected with `/ps` and ended with `/stop`.

Messages ending in `. queue` are queued behind the active turn. Removing that
suffix in an edit dequeues the message. In an existing session, punctuation
followed by a final `btw` suffix, such as `check the API too. btw`, forks the
message into a side session like `/btw`. `/mcp` enable and disable actions update
the global Codex configuration, not only the current Discord project. `/mcp`
reload rereads configuration without changing it and queues loaded-session
tool refreshes for subsequent turns.
`/archive` keeps the Discord-to-Codex mapping and session settings so `/resume`
can reopen the same thread; active goals, turns, queued prompts, and scheduled
tasks, plus any prompt delivery still awaiting recovery, must be resolved first.
`/rename` keeps the Discord and Codex titles in sync.
`/last-sessions` accepts a case-sensitive title fragment and can include archived
sessions. `/delete` requires the exact ID shown by `/session-id`; it permanently
removes the Codex transcript and spawned descendants, but keeps project files
and Discord history, then archives the Discord thread. Finish active work and
clear queued or scheduled work and background terminals before deleting.
`/plugins` browses the stable Codex CLI catalog; `/plugin` uses an exact plugin
ID to inspect, install, enable, disable, or uninstall a plugin in global Codex
configuration. Every change requires repeating that ID in
`confirm-plugin-id`. Managed or unavailable plugin policies cannot be
overridden. Installing or enabling a plugin does not automatically trust its
hooks, and a new Codex session may be needed to use its tools or skills.
`/hooks` and `/apps` inspect app-server state for the current project or
session; hook trust changes and app invocation are not yet available through
Discord.
`/subagents` lists known child threads and their current recorded status;
`/fork-subagent` lets you continue a selected child in a new Discord thread.
`/skill` invokes an enabled skill from the current session directory and accepts an
optional prompt; Cordex resolves the skill path from Codex metadata at submission time.
`/skill-toggle` updates a skill's enabled state through Codex configuration, while
`/skill-roots` replaces the runtime-only extra skill discovery directories.
`/tasks` includes bounded Run now, Cancel, and Delete controls. Scheduled occurrences
are persisted before execution, retain stable delivery IDs across restart, and do not
reappear after a concurrent cancellation or deletion.

Standard MCP `form` elicitations render in Discord with validated strings, dates,
URLs, numbers, booleans, and single- or multi-select enums. Empty approval forms can
offer session or permanent persistence when Codex explicitly advertises those choices.
MCP URL elicitations require credential-free HTTPS links, with stricter ChatGPT-host
validation for Codex Apps. Arbitrary `openai/form` schemas remain disabled and are
declined rather than rendered approximately.

Replies include a bounded quote and the referenced Discord author. Text
attachments use a MIME allowlist; PNG, JPEG, GIF, WebP, and common audio files
are downloaded to a bounded local cache before being sent to Codex. Audio is
described to app-server as an untrusted local file for inspection with project
tools; Cordex does not claim native model audio input. Persisted queued and
active-turn references protect cached attachments until their turn reaches a
terminal state. Unsupported, oversized, or timed-out attachments are reported
in the session instead of being silently ignored. The final rendered text input
also has an independent aggregate character limit so multiple attachments and
forwarded context cannot create an unbounded prompt.

Generated PNG, JPEG, and WebP images are validated from Codex's app-server
output and sent back as Discord attachments, including at text-only verbosity.
Cordex keeps pending uploads in a private, content-addressed cache and retries
them through the durable Discord outbox. If an image is unavailable or exceeds
the 8 MiB upload safety limit, the thread receives an explicit notice; project
assets saved by Codex are not removed with the upload cache.

Model choices use Codex's model catalog when available. Reasoning effort is validated
per model, including `max`, and `/fast` selects the model's advertised priority tier
instead of assuming one fixed service-tier name. Model, effort, Fast, permission, and
YOLO changes are persisted before they are applied to a live Codex thread.
`/status` distinguishes the active turn's model and effort from next-turn settings,
reports the requested sandbox and approval policy (or named profile), and shows
working directory, writable roots, and context usage when available.
`/debug-config` requests the effective config for that project or worktree,
shows Codex's resolved layers from lowest to highest precedence, and reports
managed requirements separately. It sends only setting names and selected
non-secret defaults in a private Discord reply; it never dumps raw config
values such as MCP environment variables.

`/goal` with an objective creates or updates Codex's persistent thread goal.
Active goal turns, including continuations started directly by Codex, stream to
the linked Discord thread and can accept queued or follow-up messages. Omitted
status and token-budget options preserve their existing values. If the whole
Cordex process exits during a turn, replacement startup pauses an active goal
and posts a durable Discord notice; inspect the latest output, then explicitly
resume it with `/goal status:active`. This prevents an interrupted goal from
remaining active but idle or replaying work without confirmation.

If the Codex app-server exits unexpectedly, Cordex retries it with bounded
exponential backoff, clears controls belonging to the failed process, reloads
persistent goal sessions, and resumes eligible queued work inside the surviving
Cordex process. Initialization and
RPC watchdogs also recycle a child that remains alive but stops responding.
After an ambiguous turn start or steer failure, Cordex checks Codex's persisted
client message IDs. That ID is a correlation field, not a guaranteed
idempotency key in the current Codex app-server. An unconfirmed turn RPC does
not cause an automatic client-ID replay: direct and queued prompts with
uncertain delivery require explicit review, including after a restart.
An explicit `turn/steer` RPC error is definitive rather than ambiguous. Cordex
keeps that input under the same delivery ID as ordinary queued work and runs it
as the next turn after the current turn ends; it does not require manual
Retry/Discard review.
Once Codex returns a new thread ID, Cordex persists that session mapping and
its first prompt together before starting a turn. Existing-session messages,
`/skill`, queued prompts, scheduled occurrences, and post-conflict recovery
instructions are likewise persisted before Codex delivery and stay recorded
until that acceptance is confirmed. A scheduled task found in `running`
state after restart reuses its occurrence ID. If no queue entry survives,
Cordex holds that occurrence for review unless persisted Codex history proves
acceptance; the ID alone does not guarantee Codex-side idempotency.
Positive history is reconciled before any uncertainty warning is posted, and
queued-delivery announcements use a durable delivery identity so restart
reconciliation cannot announce the same accepted prompt twice.
Before Codex returns a new thread ID, Cordex also saves the intended first
prompt and session settings as a pending start. If creation is interrupted,
Discord shows a durable warning; later messages are saved behind that prompt.
Use private `/pending-prompts` and exact-ID `/resolve-pending` to Retry into a
new saved Codex thread or Discard the selected prompt. An unanswered
`thread/start` may have created an empty orphan thread; Cordex does not guess
its ID or claim that the prompt ran.
When `/new-session` fails after this save, its command reply links the
preserved Discord thread rather than deleting that thread or its automatic
worktree. A project with unresolved pending starts cannot be removed until
the saved work is reviewed.
If a newly mapped Codex thread has no persisted rollout after a restart,
Cordex still posts the pending-prompt warning. `/resolve-pending` Retry first
saves a replacement Codex thread, then submits only the exact selected prompt;
Discard leaves later queued work held for its own review. A lost `thread/start`
response before Cordex learns the thread ID remains a separate orphan-thread
case.
If Codex cannot supply full stored history, Cordex holds saved work for
review instead of treating a status-only response as proof that delivery is
safe to repeat.
If Cordex restarts during a turn with saved prompts, it announces reconciliation
in the Discord thread before attempting automatic delivery. A prompt already
accepted by Codex is not sent again. If a prompt's acceptance is still
uncertain, Cordex holds it and later queued work, posts a durable warning,
and requires `/pending-prompts` followed by `/resolve-pending` with its exact
source ID. Retrying may duplicate side effects if Codex accepted the prompt
without persisting it yet; inspect the thread and files before choosing.
Completed Discord output and run footers use a separate durable outbox, so a partial
send or bot restart resumes only missing chunks and does not block the next queued turn.
If Discord becomes unavailable after acknowledging `/abort`, Cordex also stages
the abort result and any background-terminal warning in that durable outbox.
During a Discord connection outage, saved Codex work continues and its output
waits in the outbox. When the gateway reconnects, Cordex also catches up missed
messages in configured project channels and their session threads, even if
Discord cannot resume the old gateway session. Catch-up retains message order,
deduplicates gateway replay, and uses the same access checks as live messages.
This catch-up applies to reconnects within the running process; restart recovery
continues to use already-saved prompts.
Active turns also surface account-verification requirements, visible safety
buffering, model reroutes, slow lifecycle hooks, and retry warnings without
exposing internal classifier labels or hook source paths. A staged message
counts as visible activity only after Discord accepts it; offline progress is
superseded by newer real output before reconnect delivery.
Duplicate events that produce no new message do not reset the quiet-turn clock.
Reconnect sends count for their owning active turn, not a newer turn, and nonce
retries retain the message's original creation time for visibility accounting.
Before a turn exists, slow session creation and existing-session recovery send
non-notifying startup progress after a short grace period. The bot retries a
failed startup notice with the same nonce and stops that timer when the real
turn starts, fails, or the Discord thread is removed.
Archive and resume operations persist lifecycle intents before mutating Codex and
reconcile those intents against complete active and archived thread listings on
startup. A crash after either side accepts the operation therefore converges instead
of leaving Discord state permanently split from Codex.

At startup, Cordex refetches the Discord messages backing `. queue` entries so
offline edits replace the stored input and offline deletions remove it. Transient
Discord or attachment failures retain the last durable input, block that thread's
queued delivery, and retry reconciliation with capped backoff.

Discord prompt ingress is serialized per thread. Slash commands acknowledge
before waiting behind earlier messages, `/abort` stays on a priority path, and a
deleted thread is tombstoned and interrupted immediately so blocked preprocessing
cannot dispatch work after deletion. Startup also removes persisted sessions whose
Discord thread disappeared while Cordex was offline.
During shutdown, Cordex stops admitting new Discord and local-daemon requests, drains
already accepted interactions, scheduled work, Codex requests and notifications,
state/outbox queues, and deletion cleanup, then closes Codex and Discord. Concurrent
shutdown signals share the same drain instead of racing teardown.

`/yolo` switches the selected scope to approval-free `danger-full-access` mode.
`/run-shell-command` and the `!command` shortcut execute through the host shell in
the active project or session directory when `allowShellCommands` is enabled.
That directory may be an isolated worktree. Restrict both capabilities to
trusted users.

Starting `/new-session` inside an existing thread inherits that session's directory
and extra workspace roots without claiming ownership of its worktree. Worktree creation
refreshes configured remotes, prefers a strictly newer remote ref, and initializes
submodules recursively. `/merge-worktree` blocks while another live or starting session
shares the checkout; successful and no-op merges leave the session checkout detached at
the merged target commit. `/delete-worktree` then removes only that exact registered,
clean, merged checkout after confirming its feature branch is gone and no active,
archived, or starting session still references it. A persisted removal intent lets
startup finish an interruption between Git deletion and the final state update, after
which the session reloads at the mapped project root.

</details>

## Troubleshooting

- Run `cordex doctor` to confirm the config file, Codex executable, and mapped
  project directories can be read.
- Run `codex login` again if Codex itself reports an authentication failure.
- Rerun `cordex init` to update the Discord bot token, application ID, or server ID.
- Check that **Message Content Intent** is enabled and the bot has every permission
  listed in [Discord bot setup](#discord-bot-setup).
- Run `cordex start --verbose` when diagnosing startup, Discord, or Codex app-server
  failures. Verbose logs can contain prompts, commands, and local file paths.

## Configuration

The default home is `~/.cordex`. Cordex stores its configuration in
`~/.cordex/config.json` and runtime state alongside it. Configuration files are
written with restrictive filesystem permissions, but they still contain the
Discord bot token and must not be shared.

A representative configuration is:

```json
{
  "token": "DISCORD_BOT_TOKEN",
  "applicationId": "DISCORD_APPLICATION_ID",
  "guildId": "DISCORD_SERVER_ID",
  "sandbox": "workspace-write",
  "approvalPolicy": "on-request",
  "approvalTimeoutMinutes": 10,
  "allowAllUsers": false,
  "allowShellCommands": false,
  "allowedUserIds": ["TRUSTED_DISCORD_USER_ID"],
  "allowedRoleIds": ["TRUSTED_DISCORD_ROLE_ID"],
  "runtimeRestartUserIds": ["HOST_OPERATOR_DISCORD_USER_ID"],
  "projectsDirectory": "/absolute/path/for/new/projects",
  "projects": {}
}
```

Project mappings are normally managed by Cordex. Optional `defaultModel` and
`defaultEffort` fields can set initial preferences; available models come from
the installed Codex runtime. Valid configured effort values are
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
`approvalTimeoutMinutes` controls how long Discord approval buttons remain active
before Cordex denies the request and lets Codex continue; it defaults to 10.

Cordex also persists an internal `categoryId` after creating its managed Discord
category. Do not edit or remove it manually; if it is missing or invalid, Cordex
creates a new managed category and re-synchronizes its channels there.

Only one Cordex runtime may use a `CORDEX_HOME` at a time. A process-lifetime
`runtime.lock` fails fast on duplicate starts and is reclaimed when its recorded
process no longer exists.

Environment variables override the corresponding configuration or runtime path.
Credential overrides cannot bootstrap a missing config file; create one with
`cordex init` or create the file referenced by `CORDEX_CONFIG` first.

| Variable | Purpose |
| --- | --- |
| `CORDEX_DISCORD_TOKEN` | Discord bot token |
| `CORDEX_APPLICATION_ID` | Discord application ID |
| `CORDEX_GUILD_ID` | Discord server ID |
| `CORDEX_ALLOWED_USER_IDS` | Comma-separated trusted Discord user IDs |
| `CORDEX_ALLOWED_ROLE_IDS` | Comma-separated trusted Discord role IDs |
| `CORDEX_HOME` | Cordex state and configuration directory |
| `CORDEX_CONFIG` | Explicit configuration file path |
| `CORDEX_PROJECTS_DIR` | Default directory for newly created projects |
| `CORDEX_CODEX_BIN` | Alternate Codex executable |
| `CORDEX_VERBOSE=1` | Enable verbose backend logging |

Supported sandbox values are `read-only`, `workspace-write`, and
`danger-full-access`. Supported approval policies are `untrusted`, `on-request`,
and `never`.

Direct `/run-shell-command` and `!command` execution is disabled by default.
Set `allowShellCommands` to `true` only when every authorized Cordex operator is
also trusted with the full operating-system permissions of the Cordex process.

## Access control

By default, only the Discord server owner can use Cordex. Grant access by adding
immutable Discord user IDs to `allowedUserIds` or role IDs to `allowedRoleIds`.
The matching `CORDEX_ALLOWED_USER_IDS` and `CORDEX_ALLOWED_ROLE_IDS` environment
variables accept comma-separated overrides. Role names are intentionally not an
access boundary because they can be renamed or recreated. The `@everyone` role
ID is ignored; use `allowAllUsers` for an intentional server-wide grant.

Configure non-owner operator IDs before their first use. Restart Cordex after
changing access or direct-shell settings; live configuration refresh only
reloads project mappings and managed channel metadata.

Cordex-managed categories are private by default. On startup, Cordex synchronizes
the category so it is visible to the server owner, the bot, and configured user
or role IDs. Discord administrators can still bypass channel visibility rules.
Setting `allowAllUsers` to `true` removes the managed visibility restriction and
lets every server member invoke Cordex. Replies and command results are generally
public to anyone who can view the channel, so do not map Cordex to a public
channel or weaken the managed category permissions casually.

### Managed runtime restart

`/restart` is disabled unless the exact requesting Discord user ID appears in
`runtimeRestartUserIds` (or `CORDEX_RUNTIME_RESTART_USER_IDS`). It works only in
a linked session thread, first reports readiness, and then requires the current
Codex session ID as `confirm`. Cordex refuses the handoff while turns, queued or
uncertain prompts, running schedules, approvals, background terminals, lifecycle
mutations, or undelivered output remain.

After confirmation, Cordex acknowledges the interaction, stages a durable
replacement-ready message without sending it, shuts down cleanly, releases its
IPC/runtime lock, and exits with code `75`. An external supervisor must restart
nonzero exits, for example a systemd service with `Restart=on-failure`. The
replacement's normal outbox recovery sends the completion exactly once. This
command does not install updates; update the Codex/Cordex packages separately,
then use the handoff to load them.

For safer deployments, run Cordex under a dedicated operating-system account,
grant the bot only the required Discord permissions, map only intended projects,
and keep backups or version control for writable files.

## Development

Install dependencies and run the build plus local test suite:

```bash
npm ci
npm run check
npm link
```

`npm link` makes the checkout's `cordex` command available on the current machine.
The default `npm test` and `npm run check` commands always run with an isolated,
temporary `CORDEX_HOME`; an ambient live `CORDEX_HOME` is ignored. For retained
debug state, provide an empty safe directory through `CORDEX_TEST_HOME`, or set
`CORDEX_TEST_KEEP_HOME=1` to retain a generated directory after success. Live
integration scripts remain separate and opt-in.

The live suites launch real Codex integrations and may create Discord messages,
channels, sessions, worktrees, files, or account flows:

```bash
npm run test:live-all
```

For a long run that survives an interrupted terminal observation and writes a
private log plus a verifiable JSON result, use `npm run test:live-evidence`.
It prints a run directory; query that exact directory with
`node scripts/live-e2e-runner.mjs status <run-directory>`. Do not start another
run merely because a status poll times out.

Run live tests only with an authenticated test account, a dedicated Discord
server, and projects where those side effects are acceptable. Individual
`test:live-*` scripts are available for narrower integration checks. Some
account diagnostics skip when no compatible ChatGPT login is active.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and
[SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## Limitations

- Codex app-server is experimental and its protocol can change between CLI versions.
- Task output is normally public within its channel. Authentication, account,
  session-ID, and other sensitive diagnostic commands use ephemeral replies.
- `/rollback` continues the Discord session from an earlier Codex turn in a new
  Codex session. The previous session remains available, and local files are unchanged.
- Worktree automation requires mapped projects to be git repositories.
- MCP enable/disable actions affect the global Codex configuration.
- Cordex does not currently provide hosted session sharing, voice transcription,
  screen sharing, browser-hosted VS Code, remote diff hosting, Slack bridging,
  tunnels, or self-update/restart management.

## Kimaki attribution

Cordex ports the core Discord workflow of
[Kimaki](https://github.com/remorses/kimaki) from OpenCode to Codex. Kimaki's
original work is MIT-licensed, and its required copyright and license notices
are retained with this project. OpenCode-specific providers, plugins, commands,
and agents are not presented as Cordex features; Codex supplies its own models,
authentication, skills, plugins, MCP servers, and durable sessions.

Cordex is an independent community project and is not affiliated with or
endorsed by OpenAI or Discord.

## License

Copyright (C) 2026 Cordex contributors. Cordex is licensed under the GNU General
Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE).
