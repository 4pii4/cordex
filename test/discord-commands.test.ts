import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSlashCommands } from '../src/discord-commands.js'

test('Discord command registry includes core and ported controls', () => {
  const names = buildSlashCommands().map((command) => command.name)
  for (const name of [
    'model',
    'model-variant',
    'unset-model-override',
    'mode',
    'fast',
    'yolo',
    'project',
    'add-project',
    'remove-project',
    'create-new-project',
    'add-dir',
    'permissions',
    'new-session',
    'resume',
    'fork',
    'fork-subagent',
    'btw',
    'compact',
    'goal',
    'clear-goal',
    'archive',
    'review',
    'diff',
    'schedule',
    'tasks',
    'cancel-task',
    'skills',
    'mcp-status',
    'mcp',
    'mcp-login',
    'auth-status',
    'rate-limits',
    'account-usage',
    'login',
    'rollback',
    'new-worktree',
    'toggle-worktrees',
    'worktrees',
    'merge-worktree',
    'queue',
    'clear-queue',
    'run-shell-command',
    'last-sessions',
    'context-usage',
    'verbosity',
    'session-id',
    'abort',
    'status',
  ]) {
    assert.ok(names.includes(name), `missing /${name}`)
  }

  const mcp = buildSlashCommands().find((command) => command.name === 'mcp')
  const action = mcp?.options?.find((option) => option.name === 'action')
  assert.ok(action && 'choices' in action && Array.isArray(action.choices))
  assert.deepEqual(action.choices.map((choice) => choice.value), [
    'status',
    'login',
    'enable-global',
    'disable-global',
  ])

  for (const commandName of ['add-project', 'remove-project']) {
    const command = buildSlashCommands().find((entry) => entry.name === commandName)
    const project = command?.options?.find((option) => option.name === 'project')
    assert.ok(project && 'required' in project && project.required)
    assert.ok('autocomplete' in project && project.autocomplete)
  }

  const legacyProject = buildSlashCommands().find((command) => command.name === 'project')
  assert.match(legacyProject?.description || '', /Legacy/)
  const createProject = buildSlashCommands().find((command) => command.name === 'create-new-project')
  assert.match(createProject?.description || '', /Create a git project/)
})
