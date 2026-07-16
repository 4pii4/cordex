# Contributing to Cordex

Contributions are welcome. Keep changes focused, explain user-visible behavior,
and include tests or documentation when the change warrants them.

## Local setup

Requirements are Node.js 22 or newer and npm. A Codex login and Discord bot are
needed only for live integration tests.

```bash
npm ci
npm run check
```

`npm run check` builds the TypeScript project and runs the local test suite.

## Pull requests

- Open an issue first for substantial behavior or architecture changes.
- Add focused tests for fixes and new behavior.
- Update README documentation and the `Unreleased` changelog when users are affected.
- Keep credentials, private Discord IDs, logs, and local configuration out of commits.
- Do not mix unrelated cleanup into a functional change.
- Confirm `npm run check` passes before requesting review.

## Live tests

Live suites are opt-in because they launch real Codex processes and can modify
Discord, account, filesystem, git, and worktree state.

```bash
npm run test:live-all
```

Run them only with explicit authorization, a dedicated test server, and
throwaway or backed-up projects. Prefer the narrower `test:live-*` scripts when
validating a specific integration.

Report security-sensitive findings through the private process in
[SECURITY.md](SECURITY.md), not through a public issue or pull request.
