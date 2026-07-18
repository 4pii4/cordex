# Cordex

Cordex runs persistent Codex sessions from Discord. A Discord channel maps to a
local project, and each Discord thread stays attached to one Codex session.
Responses, tool activity, approvals, and follow-up questions stream back to the
place where the work was requested.

> [!WARNING]
> Cordex can read and modify local files, run shell commands, and—when explicitly
> enabled—run Codex without approvals or sandboxing. Run it on a machine and in a
> Discord server you control, restrict access to trusted members, and keep the
> default `workspace-write` sandbox with `on-request` approvals unless you fully
> understand the consequences.

## What Cordex provides

- Remote Codex prompting from Discord with persistent, resumable sessions
- Live responses, compact tool activity, approvals, and structured user questions
- Dedicated Discord channels for local projects and optional git worktree isolation
- Project- or session-level model, reasoning, collaboration mode, and permission controls
- Queued and scheduled prompts with restart recovery
- Native Codex skill invocation plus MCP, authentication, account, rate-limit, and context diagnostics
- Reply-aware text and image input, code review, diffs, rollback, and controlled shell execution

The core mapping is deliberately simple:

| Discord | Local Codex runtime |
| --- | --- |
| Project channel | Local project directory |
| Thread in that channel | Persistent Codex session |

Send a message in a project channel to start a session thread. Continue chatting
in the thread to keep working in the same Codex context.

## Requirements

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

## Discord setup

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
   - Add Reactions
   - Use Application Commands
5. Install the bot into the intended Discord server.
6. Copy the bot token, application ID, and server ID for `cordex init`. Enable
   Discord Developer Mode if you need to copy the server ID.

Treat the bot token like a password. Never commit it, paste it into a Discord
channel, or expose it in logs.

## Install

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

For local source development from a checkout of this repository:

```bash
npm ci
npm run build
npm link
```

`npm link` makes the `cordex` command available on the current machine.

## Quick start

Write the initial configuration, validate the local setup, and start the bot:

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

For detailed backend logging, run:

```bash
cordex start --verbose
```

Verbose logs can include prompts, tool calls, commands, file paths, and Codex
protocol traffic. Store and share them accordingly.

## Command overview

Slash commands are registered in the configured Discord server.

| Area | Commands |
| --- | --- |
| Projects | `/add-project`, `/create-new-project`, `/remove-project`, `/project` |
| Sessions | `/new-session`, `/resume`, `/rename`, `/fork`, `/fork-subagent`, `/btw`, `/abort`, `/archive`, `/compact`, `/last-sessions`, `/session-id`, `/status` |
| Models and runtime | `/model`, `/model-variant`, `/unset-model-override`, `/mode`, `/fast`, `/permissions`, `/add-dir`, `/verbosity`, `/context-usage` |
| Goals | `/goal`, `/clear-goal` |
| Git and worktrees | `/diff`, `/review`, `/rollback`, `/new-worktree`, `/merge-worktree`, `/toggle-worktrees`, `/worktrees` |
| Automation | `/queue`, `/clear-queue`, `/schedule`, `/tasks`, `/cancel-task` |
| Codex services | `/skill`, `/skills`, `/mcp`, `/mcp-status`, `/mcp-login`, `/auth-status`, `/rate-limits`, `/account-usage`, `/login` |
| Host control | `/run-shell-command`, `!command`, `/yolo` |

Messages ending in `. queue` are queued behind the active turn. Removing that
suffix in an edit dequeues the message. In an existing session, punctuation
followed by a final `btw` suffix, such as `check the API too. btw`, forks the
message into a side session like `/btw`. `/mcp` enable and disable actions update
the global Codex configuration, not only the current Discord project.
`/archive` keeps the Discord-to-Codex mapping and session settings so `/resume`
can reopen the same thread; active goals, turns, queued prompts, and scheduled
tasks, plus any prompt delivery still awaiting recovery, must be resolved first.
`/rename` keeps the Discord and Codex titles in sync.
`/skill` invokes an enabled skill from the current session directory and accepts an
optional prompt; Cordex resolves the skill path from Codex metadata at submission time.
`/tasks` includes bounded Run now, Cancel, and Delete controls. Scheduled occurrences
are persisted before execution, retain stable delivery IDs across restart, and do not
reappear after a concurrent cancellation or deletion.

Replies include a bounded quote and the referenced Discord author. Text
attachments use a MIME allowlist; PNG, JPEG, GIF, and WebP images are downloaded
to a bounded local cache before being sent to Codex. Unsupported, oversized, or
timed-out attachments are reported in the session instead of being silently
ignored. The final rendered text input also has an independent aggregate character
limit so multiple attachments and forwarded context cannot create an unbounded prompt.

Model choices use Codex's model catalog when available. Reasoning effort is validated
per model, including `max`, and `/fast` selects the model's advertised priority tier
instead of assuming one fixed service-tier name. Model, effort, Fast, permission, and
YOLO changes are persisted before they are applied to a live Codex thread.

`/goal` with an objective creates or updates Codex's persistent thread goal.
Active goal turns, including continuations started directly by Codex, stream to
the linked Discord thread, resume when Cordex restarts, and can accept queued or
follow-up messages. Omitted status and token-budget options preserve their
existing values.

If the Codex app-server exits unexpectedly, Cordex retries it with bounded
exponential backoff, clears controls belonging to the failed process, reloads
persistent goal sessions, and resumes eligible queued work. Initialization and
RPC watchdogs also recycle a child that remains alive but stops responding.
After an ambiguous turn start or steer failure, Cordex checks Codex's persisted
client message IDs before retrying so an accepted prompt is not delivered twice.
Existing-session messages, `/skill`, queued prompts, scheduled occurrences, and
post-conflict recovery instructions are persisted before Codex delivery and stay
recorded until that acceptance is confirmed. Scheduled tasks found in `running`
state after restart retry the same occurrence ID instead of creating a duplicate.
Completed Discord output and run footers use a separate durable outbox, so a partial
send or bot restart resumes only missing chunks and does not block the next queued turn.

At startup, Cordex refetches the Discord messages backing `. queue` entries so
offline edits replace the stored input and offline deletions remove it. Transient
Discord or attachment failures retain the last durable input, block that thread's
queued delivery, and retry reconciliation with capped backoff.

Discord prompt ingress is serialized per thread. Slash commands acknowledge
before waiting behind earlier messages, `/abort` stays on a priority path, and a
deleted thread is tombstoned and interrupted immediately so blocked preprocessing
cannot dispatch work after deletion. Startup also removes persisted sessions whose
Discord thread disappeared while Cordex was offline.

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
the merged target commit.

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
  "projectsDirectory": "/absolute/path/for/new/projects",
  "projects": {}
}
```

Project mappings are normally managed by Cordex. Optional `defaultModel` and
`defaultEffort` fields can set initial preferences; available models come from
the installed Codex runtime. Valid configured effort values are
`minimal`, `low`, `medium`, `high`, `xhigh`, and `ultra`.
`approvalTimeoutMinutes` controls how long Discord approval buttons remain active
before Cordex denies the request and lets Codex continue; it defaults to 10.

Cordex also persists an internal `categoryId` after creating its managed Discord
category. Do not edit or remove it manually; if it is missing or invalid, Cordex
creates a new managed category and re-synchronizes its channels there.

Only one Cordex runtime may use a `CORDEX_HOME` at a time. A process-lifetime
`runtime.lock` fails fast on duplicate starts and is reclaimed when its recorded
process no longer exists.

Environment variables override the corresponding configuration or runtime path:

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

For safer deployments, run Cordex under a dedicated operating-system account,
grant the bot only the required Discord permissions, map only intended projects,
and keep backups or version control for writable files.

## Development

Install dependencies and run the build plus local test suite:

```bash
npm ci
npm run check
```

The live suites launch real Codex integrations and may create Discord messages,
channels, sessions, worktrees, files, or account flows:

```bash
npm run test:live-all
```

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
- `/rollback` changes Codex conversation history but intentionally does not restore files.
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
