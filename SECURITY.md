# Security Policy

Cordex connects Discord users to a local Codex process with filesystem and shell
access. Permission bypasses, command-execution flaws, secret exposure, unsafe
path handling, and Discord access-control failures should be treated as security
issues.

## Supported versions

Before the first tagged release, security fixes are made on the current default
branch only. After releases begin, this section will identify supported release
lines.

## Reporting a vulnerability

Use this repository's private vulnerability-reporting feature when available.
Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Do not include bot tokens, account credentials, private
project data, or working exploits against systems you do not own.

If private reporting is unavailable, open a minimal public issue asking the
maintainers for a private contact channel. Do not disclose vulnerability details
in that issue. Maintainers will coordinate validation, remediation, and
disclosure privately; no fixed response-time guarantee is currently offered.

## Deployment guidance

- Run Cordex in a private Discord server and keep its managed category private.
- Keep `allowAllUsers` disabled and configure trusted user or role IDs explicitly.
- Do not rely on role names as an authorization boundary.
- Use `workspace-write` with `on-request` approvals by default.
- Avoid `/yolo` unless approval-free, unsandboxed access is explicitly intended.
- Keep direct shell commands disabled unless every allowed operator is trusted
  with the Cordex process account.
- Run the service under a dedicated operating-system account with limited access.
- Do not keep unrelated secrets readable by that account. Cordex and its Codex
  subprocess share the same operating-system identity; sandbox and permission
  settings remain part of the security boundary.
- Protect and periodically rotate the Discord bot token.
- Keep Cordex, Codex, Node.js, and dependencies updated.
- Review verbose logs before sharing them; they may contain sensitive prompts,
  commands, file paths, and protocol data.
