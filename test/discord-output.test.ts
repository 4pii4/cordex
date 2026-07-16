import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatCompletedToolItem,
  formatAssistantText,
  formatModelBanner,
  formatRunFooter,
  formatShellCommandResult,
  rewriteLocalFileLinks,
  splitMarkdownForDiscord,
} from '../src/discord-output.js'

test('local file links become readable Discord-safe references', () => {
  assert.equal(formatAssistantText('hello world'), 'hello world')
  assert.doesNotMatch(formatAssistantText('hello world'), /^⬥/)
  assert.equal(
    rewriteLocalFileLinks('[KillAura.java:687](/win/data/src/Raven-bS/KillAura.java:687)'),
    '`KillAura.java:687` — `/win/data/src/Raven-bS/KillAura.java:687`',
  )
  assert.equal(
    rewriteLocalFileLinks('[My Report.md](</tmp/My Project/My Report.md:3>)'),
    '`My Report.md` — `/tmp/My Project/My Report.md:3`',
  )
})

test('tool output follows Kimaki compact symbols and verbosity filtering', () => {
  const rendered = formatCompletedToolItem({
    type: 'commandExecution',
    command: 'sed -n 1,20p src/app.ts',
    cwd: '/project',
    status: 'completed',
    exitCode: 0,
    durationMs: 42,
    aggregatedOutput: 'source text',
    commandActions: [{ type: 'read', path: '/project/src/app.ts' }],
  }, 'tools_and_text')
  assert.equal(rendered, '┣ bash _sed -n 1,20p src/app.ts_')
  assert.equal(formatCompletedToolItem({
    type: 'commandExecution',
    command: 'cat src/app.ts',
    status: 'completed',
    commandActions: [{ type: 'read', path: '/project/src/app.ts' }],
  }, 'text_and_essential_tools'), undefined)
  assert.equal(formatCompletedToolItem({
    type: 'commandExecution',
    command: 'npm test',
    status: 'completed',
  }, 'text_and_essential_tools'), '┣ bash _npm test_')
  assert.equal(formatCompletedToolItem({
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: '/project/src/app.ts', diff: '@@\n-old\n+new', kind: { type: 'update' } }],
  }, 'text_and_essential_tools'), '◼︎ apply_patch *app.ts* (+1-1)')
  assert.equal(formatCompletedToolItem({ type: 'reasoning' }, 'tools_and_text'), '┣ thinking')
  assert.equal(formatCompletedToolItem({
    type: 'dynamicToolCall',
    namespace: null,
    tool: 'cordex_action_buttons',
    arguments: { buttons: ['Continue'] },
  }, 'tools_and_text'), undefined)
  assert.equal(formatCompletedToolItem({ type: 'commandExecution', command: 'pwd' }, 'text_only'), undefined)
})

test('verbose Discord output includes MCP, dynamic, web, image, and subagent tools', () => {
  const items = [
    { type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'fast' } },
    { type: 'dynamicToolCall', namespace: null, tool: 'buttons', status: 'completed', arguments: { label: 'Go' } },
    { type: 'webSearch', query: 'Codex fast mode', action: { type: 'search' } },
    { type: 'imageView', path: '/tmp/image.png' },
    { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child'], prompt: 'inspect' },
  ]
  const rendered = items.map((item) => formatCompletedToolItem(item, 'tools_and_text')).join('\n')
  assert.match(rendered, /docs_search/)
  assert.match(rendered, /buttons/)
  assert.match(rendered, /Codex fast mode/)
  assert.match(rendered, /image\.png/)
  assert.match(rendered, /┣ agent \*\*inspect\*\*/)
  assert.equal(formatCompletedToolItem(items[2] || {}, 'text_and_essential_tools'), undefined)
  assert.equal(formatCompletedToolItem({
    type: 'mcpToolCall',
    server: 'repo',
    tool: 'read',
    status: 'completed',
    arguments: { path: 'README.md' },
  }, 'text_and_essential_tools'), undefined)
})

test('run footer follows Kimaki project branch duration context model order', () => {
  assert.equal(formatRunFooter({
    project: 'Raven-bS',
    branch: 'main',
    duration: '17m 19s',
    contextPercent: 3,
    model: 'gpt-5.6',
    effort: 'high',
  }), '*Raven-bS ⋅ main ⋅ 17m 19s ⋅ 3% ⋅ gpt-5.6 (high)*')
  const overWindow = formatRunFooter({
    project: 'cordex',
    duration: '1s',
    contextPercent: 3_168,
    model: 'gpt-5.6-sol\n',
    effort: 'xhigh',
  })
  assert.equal(overWindow, '*cordex ⋅ 1s ⋅ 3168% ⋅ gpt-5.6-sol (xhigh)*')
  assert.doesNotMatch(overWindow, /completed|context/)
  assert.equal(formatRunFooter({
    project: 'cordex',
    duration: '1s',
    contextPercent: Number.NaN,
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
  }), '*cordex ⋅ 1s ⋅ gpt-5.6-sol (xhigh)*')
  assert.equal(formatModelBanner('gpt-5.6', 'high'), '*using gpt-5.6 (high)*')
})

test('shell results share Kimaki command exit format and strip ANSI', () => {
  assert.equal(formatShellCommandResult({
    command: 'npm test',
    output: '\u001b[32mpassed\u001b[0m',
    exitCode: 0,
  }), '`npm test` exited with 0\n```\npassed\n```')
  const truncated = formatShellCommandResult({
    command: 'npm test',
    output: 'x'.repeat(3_000),
    exitCode: 1,
  })
  assert.ok(truncated.length <= 1_900)
  assert.match(truncated, /\.\.\. truncated/)
})

test('Markdown splitting preserves fenced code blocks', () => {
  const chunks = splitMarkdownForDiscord(`Before\n\n\`\`\`ts\n${'const value = 1\n'.repeat(30)}\`\`\`\nAfter`, 120)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 120))
  for (const chunk of chunks) {
    assert.equal((chunk.match(/\`\`\`/g) || []).length % 2, 0, chunk)
  }
})
