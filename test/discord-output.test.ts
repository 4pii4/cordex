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
  assert.match(formatCompletedToolItem({
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'failed',
    prompt: 'inspect',
  }, 'tools_and_text') || '', /^⨯ agent/)
  assert.equal(formatCompletedToolItem({
    type: 'imageGeneration',
    status: 'failed',
    savedPath: '/tmp/image.png',
  }, 'tools_and_text'), '⨯ imageGeneration *image.png*')
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

test('Markdown splitting applies the semantic target below the Discord hard limit', () => {
  const first = `${'a'.repeat(760)}\n\n`
  const second = 'b'.repeat(680)
  const chunks = splitMarkdownForDiscord(first + second, 1_900)

  assert.deepEqual(chunks, [first, second])
})

test('Markdown splitting prefers headings and keeps their body attached', () => {
  const first = `# Summary\n\n${'a'.repeat(600)}\n\n${'b'.repeat(560)}\n\n`
  const second = `## Details\n\n${'c'.repeat(320)}`
  const chunks = splitMarkdownForDiscord(first + second, 1_900)

  assert.deepEqual(chunks, [first, second])
})

test('Markdown splitting does not orphan a heading before an oversized body line', () => {
  const heading = '## Details\n\n'
  const content = heading + 'x'.repeat(2_500)
  const chunks = splitMarkdownForDiscord(content, 1_900)

  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.ok(chunks[0]?.startsWith(heading))
  assert.ok((chunks[0]?.length || 0) > heading.length)
  assert.ok(chunks.every((chunk) => chunk.trim() !== heading.trim()))
  assert.equal(chunks.join(''), content)
})

test('Markdown splitting keeps list items whole when a list boundary fits', () => {
  const prefix = `${'x'.repeat(1_050)}\n`
  const firstItem = `- First ${'a'.repeat(180)}\n`
  const secondItem = `- Second ${'b'.repeat(180)}\n`
  const chunks = splitMarkdownForDiscord(prefix + firstItem + secondItem, 1_900)

  assert.deepEqual(chunks, [prefix + firstItem, secondItem])
})

test('Markdown splitting keeps a table intact when it fits the hard limit', () => {
  const header = '| Name | Value |\n| --- | --- |\n'
  const rows = Array.from({ length: 6 }, (_, index) =>
    `| row ${index + 1} | ${'x'.repeat(230)} |\n`).join('')
  const content = header + rows

  assert.ok(content.length > 1_300)
  assert.deepEqual(splitMarkdownForDiscord(content, 1_900), [content])
})

test('Markdown splitting reopens long fenced code blocks with their language', () => {
  const content = `\`\`\`ts\n${'const value = 1\n'.repeat(90)}\`\`\`\n`
  const chunks = splitMarkdownForDiscord(content, 1_900)

  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.ok(chunks.every((chunk) => chunk.startsWith('```ts\n')))
  for (const chunk of chunks) {
    assert.equal((chunk.match(/\`\`\`/g) || []).length % 2, 0, chunk)
  }
  assert.equal(chunks.join('').replaceAll('```\n```ts\n', ''), content)
})

test('Markdown splitting unnests fenced code beneath list items for Discord', () => {
  const content = [
    '- Example:',
    '  ```ts',
    '  function demo() {',
    '    return 1',
    '  }',
    '  ```',
    '',
  ].join('\n')

  assert.deepEqual(splitMarkdownForDiscord(content, 1_900), [[
    '- Example:',
    '',
    '```ts',
    'function demo() {',
    '  return 1',
    '}',
    '```',
    '',
  ].join('\n')])
})

test('Markdown splitting limits Discord headings to h3 outside code blocks', () => {
  const content = [
    '#### Details',
    '',
    '```md',
    '#### Keep this code literal',
    '```',
    '',
    '###### More',
  ].join('\n')

  assert.deepEqual(splitMarkdownForDiscord(content), [[
    '### Details',
    '',
    '```md',
    '#### Keep this code literal',
    '```',
    '',
    '### More',
  ].join('\n')])
})

test('Markdown splitting preserves content while enforcing the 1900 character hard limit', () => {
  const content = `\`\`\`ts\n${'x'.repeat(1_890)}\n\`\`\`\n`
  const chunks = splitMarkdownForDiscord(content)

  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.equal(chunks.join('').replaceAll('```\n```ts\n', ''), content)
})

test('Markdown splitting never cuts a Unicode surrogate pair', () => {
  const content = `a${'😀'.repeat(1_000)}`
  const chunks = splitMarkdownForDiscord(content)
  const hasLoneSurrogate = (value: string): boolean => {
    for (let index = 0; index < value.length; index++) {
      const current = value.charCodeAt(index)
      if (current >= 0xd800 && current <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (next < 0xdc00 || next > 0xdfff) return true
        index++
      } else if (current >= 0xdc00 && current <= 0xdfff) {
        return true
      }
    }
    return false
  }

  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.ok(chunks.every((chunk) => !hasLoneSurrogate(chunk)))
  assert.equal(chunks.join(''), content)
  assert.throws(
    () => splitMarkdownForDiscord('😀', 1),
    /maxLength 1 cannot contain one Unicode character/,
  )
})

test('Markdown splitting never emits empty or whitespace-only chunks', () => {
  const chunks = splitMarkdownForDiscord(`x\n${'\n'.repeat(2_600)}y`)

  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.ok(chunks.every((chunk) => Boolean(chunk.trim())))
  assert.deepEqual(splitMarkdownForDiscord('  \n\t\n'), ['…'])
})

test('Markdown splitting keeps a boundary space inside the hard limit', () => {
  const chunks = splitMarkdownForDiscord(`${'x'.repeat(16)} ${'y'.repeat(20)}`, 16)

  assert.ok(chunks.every((chunk) => chunk.length <= 16))
  assert.ok(chunks.every((chunk) => Boolean(chunk.trim())))
})

test('Markdown splitting recognizes and reopens four-backtick fences', () => {
  const short = ['````md', '```', 'literal triple fence', '```', '````', ''].join('\n')
  assert.deepEqual(splitMarkdownForDiscord(short), [short])

  const content = `\`\`\`\`ts\n${'const value = 1\n'.repeat(100)}\`\`\`\`\n`
  const chunks = splitMarkdownForDiscord(content)

  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900))
  assert.ok(chunks.every((chunk) => chunk.startsWith('````ts\n')))
  assert.ok(chunks.every((chunk) => chunk.endsWith('````\n')))
  assert.equal(chunks.join('').replaceAll('````\n````ts\n', ''), content)
})

test('Markdown splitting degrades fences safely at tiny limits', () => {
  const content = `\`\`\`js\nabcdef\n\`\`\`\n`
  for (let maxLength = 1; maxLength <= 10; maxLength++) {
    const chunks = splitMarkdownForDiscord(content, maxLength)
    assert.ok(chunks.every((chunk) => chunk.length <= maxLength), `maxLength ${maxLength}`)
    assert.ok(chunks.every((chunk) => Boolean(chunk.trim())), `maxLength ${maxLength}`)
    assert.ok(chunks.every((chunk) => !chunk.includes('`')), `maxLength ${maxLength}`)
  }

  const unclosed = `\`\`\`ts\n${'x'.repeat(80)}`
  const chunks = splitMarkdownForDiscord(unclosed, 25)
  assert.ok(chunks.every((chunk) => chunk.length <= 25))
  assert.ok(chunks.every((chunk) => Boolean(chunk.trim())))
  assert.ok(chunks.every((chunk) => (chunk.match(/\`\`\`/g) || []).length % 2 === 0))
})
