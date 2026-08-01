# Bug: Discord outbox nonces exceed the message API limit

> Status: FIXED
> Mode: default
> Severity: functional
> Author: Codex
> Last updated: 2026-08-01

## Symptom

Every completed Codex notification attempted to drain the durable Discord outbox, but Discord rejected the first pending message with `NONCE_TYPE_TOO_LONG`.

## Expected

Durable output messages use stable nonces no longer than Discord's 25-character limit, including output recovered from state written by the affected version.

## Reproduction

- Command: `rtk proxy node --import tsx --test --test-name-pattern='Discord outbox nonces|persisted legacy' test/discord-outbox.test.ts`
- Test location: `test/discord-outbox.test.ts:157`
- Reproduction stability: 3/3 runs failed before the fix with an actual nonce length of 32.

## Hypotheses & diagnosis

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Cordex generates a nonce longer than Discord accepts. | confirmed | `discordOutboxNonce()` generated `cx` plus 30 hex characters, while the installed Discord API types specify a 25-character maximum. |
| H2 | `discord.js` expands or rewrites a valid Cordex nonce. | eliminated | `MessagePayload.resolveBody()` forwards a supplied string nonce unchanged, and the 32-character value already exists before `channel.send()`. |

## Root cause

The durable outbox implementation used a 32-character deterministic nonce and its tests encoded the same incorrect upper bound. A failed send remained at the front of the outbox, so each later Codex notification retried the same invalid payload and logged the error again.

## Fix

- Changed file: `src/discord-outbox.ts:5`
- Generate 25-character deterministic nonces.
- Accept the previous deterministic 32-character nonce while loading state, then normalize it to the new value so pending output is retained.

## Verification

- V-1: focused regression tests passed after the fix.
- V-2: temporarily restored the old generator; both regression tests failed, then passed again after restoring the fix.
- V-3: `rtk npm run check` passed the production build, test typecheck, and repository suite: 343 tests, 327 passed, 16 skipped, 0 failed.
- V-4: `git diff --check` passed.

## Regression test

- Path: `test/discord-outbox.test.ts:157`
- Names: `Discord outbox nonces fit the message API limit` and `persisted legacy outbox nonces are normalized without dropping output`

## Pattern analysis

| Search | Result | Same issue elsewhere |
|---|---|---|
| `rtk proxy rg -n 'slice\(0, 30\)|length <= 32|nonce.length > 32' src test` | One intentional legacy fixture | No other production nonce generator or stale 32-character assertion remains. |
