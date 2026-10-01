import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSlashCommands, discordDescription } from '../src/discord-commands.js'

test('Discord command descriptions are centrally limited to 100 characters', () => {
  assert.equal(discordDescription('short description'), 'short description')
  assert.equal(discordDescription('x'.repeat(101)), 'x'.repeat(100))

  const descriptions: string[] = []
  const visit = (entry: {
    description?: string | undefined
    options?: unknown[] | undefined
  }) => {
    if (entry.description) descriptions.push(entry.description)
    for (const option of entry.options || []) {
      if (typeof option === 'object' && option !== null) {
        visit(option as {
          description?: string | undefined
          options?: unknown[] | undefined
        })
      }
    }
  }
  for (const command of buildSlashCommands()) visit(command)
  assert.ok(descriptions.length > 0)
  assert.ok(descriptions.every((description) => description.length <= 100))
})

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
    'rename',
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
    'skill',
    'skills',
    'mcp-status',
    'mcp',
    'mcp-login',
    'auth-status',
    'rate-limits',
    'account-usage',
    'rollback',
    'new-worktree',
    'toggle-worktrees',
    'worktrees',
    'merge-worktree',
    'delete-worktree',
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
    'reload',
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

  for (const commandName of ['model', 'model-variant']) {
    const command = buildSlashCommands().find((entry) => entry.name === commandName)
    const effort = command?.options?.find((option) => option.name === 'effort')
    assert.ok(effort && 'choices' in effort && Array.isArray(effort.choices))
    assert.deepEqual(
      effort.choices.map((choice) => choice.value),
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    )
  }

  const rename = buildSlashCommands().find((command) => command.name === 'rename')
  const renameName = rename?.options?.find((option) => option.name === 'name')
  assert.ok(renameName && 'required' in renameName && renameName.required)

  const skill = buildSlashCommands().find((command) => command.name === 'skill')
  const skillName = skill?.options?.find((option) => option.name === 'skill')
  const skillPrompt = skill?.options?.find((option) => option.name === 'prompt')
  assert.ok(skillName && 'required' in skillName && skillName.required)
  assert.ok('autocomplete' in skillName && skillName.autocomplete)
  assert.ok(skillPrompt && 'max_length' in skillPrompt && skillPrompt.max_length === 6_000)

  const legacyProject = buildSlashCommands().find((command) => command.name === 'project')
  assert.match(legacyProject?.description || '', /Legacy/)
  const createProject = buildSlashCommands().find((command) => command.name === 'create-new-project')
  assert.match(createProject?.description || '', /Create a git project/)

  for (const [commandName, optionName] of [
    ['new-worktree', 'base-branch'],
    ['merge-worktree', 'target-branch'],
  ] as const) {
    const command = buildSlashCommands().find((entry) => entry.name === commandName)
    const branch = command?.options?.find((option) => option.name === optionName)
    assert.ok(branch && 'autocomplete' in branch && branch.autocomplete)
  }
})
