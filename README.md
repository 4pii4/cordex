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
- Codex skills, MCP, authentication, account, rate-limit, and context diagnostics
- Text and image input, code review, diffs, rollback, and controlled shell execution

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

## Install from source

Cordex is currently installed from source; no npm registry release is advertised
yet. From a local checkout of this repository:

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
| Sessions | `/new-session`, `/resume`, `/fork`, `/fork-subagent`, `/btw`, `/abort`, `/archive`, `/compact`, `/last-sessions`, `/session-id`, `/status` |
| Models and runtime | `/model`, `/model-variant`, `/unset-model-override`, `/mode`, `/fast`, `/permissions`, `/add-dir`, `/verbosity`, `/context-usage` |
| Goals | `/goal`, `/clear-goal` |
| Git and worktrees | `/diff`, `/review`, `/rollback`, `/new-worktree`, `/merge-worktree`, `/toggle-worktrees`, `/worktrees` |
| Automation | `/queue`, `/clear-queue`, `/schedule`, `/tasks`, `/cancel-task` |
| Codex services | `/skills`, `/mcp`, `/mcp-status`, `/mcp-login`, `/auth-status`, `/rate-limits`, `/account-usage`, `/login` |
| Host control | `/run-shell-command`, `!command`, `/yolo` |

Messages ending in `. queue` are queued behind the active turn. Removing that
suffix in an edit dequeues the message. `/mcp` enable and disable actions update
the global Codex configuration, not only the current Discord project.

`/yolo` switches the selected scope to approval-free `danger-full-access` mode.
`/run-shell-command` and the `!command` shortcut execute through the host shell in
the active project or session directory when `allowShellCommands` is enabled.
That directory may be an isolated worktree. Restrict both capabilities to
trusted users.

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

Cordex also persists an internal `categoryId` after creating its managed Discord
category. Do not edit or remove it manually; if it is missing or invalid, Cordex
creates a new managed category and re-synchronizes its channels there.

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
