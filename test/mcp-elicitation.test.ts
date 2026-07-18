import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isMcpToolApproval,
  mcpElicitationPersistModes,
  mcpToolApprovalDisplayParams,
  parseMcpElicitationForm,
  parseMcpElicitationNumberInput,
  validateMcpElicitationContent,
  validateMcpElicitationUrl,
} from '../src/mcp-elicitation.js'

test('stable MCP form primitives parse with defaults and validate typed content', () => {
  const form = parseMcpElicitationForm({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      email: {
        type: 'string',
        title: 'Email',
        minLength: 3,
        maxLength: 80,
        format: 'email',
        default: 'dev@example.com',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        default: 3,
      },
      ratio: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      confirmed: {
        type: 'boolean',
        default: true,
      },
      action: {
        type: 'string',
        enum: ['allow', 'deny'],
        enumNames: ['Allow', 'Deny'],
        default: 'allow',
      },
      region: {
        type: 'string',
        oneOf: [
          { const: 'us', title: 'United States' },
          { const: 'eu', title: 'Europe' },
        ],
      },
      scopes: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'read', title: 'Read' },
            { const: 'write', title: 'Write' },
            { const: 'admin', title: 'Admin' },
          ],
        },
        default: ['read'],
      },
      tags: {
        type: 'array',
        items: { type: 'string', enum: ['one', 'two'] },
      },
    },
    required: ['email', 'count', 'confirmed', 'region', 'scopes'],
  })

  assert.equal(Object.getPrototypeOf(form.initialContent), null)
  assert.deepEqual(Object.fromEntries(Object.entries(form.initialContent)), {
    email: 'dev@example.com',
    count: 3,
    confirmed: true,
    action: 'allow',
    scopes: ['read'],
  })
  assert.deepEqual(form.fields.map((field) => field.kind), [
    'string',
    'number',
    'number',
    'boolean',
    'singleSelect',
    'singleSelect',
    'multiSelect',
    'multiSelect',
  ])

  const content = {
    ...form.initialContent,
    ratio: 0.5,
    region: 'eu',
    scopes: ['read', 'write'],
    tags: ['two'],
  }
  assert.equal(validateMcpElicitationContent(form, content), undefined)
  assert.match(
    validateMcpElicitationContent(form, { ...content, email: 'invalid' }) || '',
    /valid email address/,
  )
  assert.match(
    validateMcpElicitationContent(form, { ...content, count: 2.5 }) || '',
    /integer/,
  )
  assert.match(
    validateMcpElicitationContent(form, { ...content, scopes: [] }) || '',
    /at least 1 selections/,
  )
  const { region: _region, ...missingRegion } = content
  assert.match(validateMcpElicitationContent(form, missingRegion) || '', /region is required/)
})

test('standard string formats and numeric input parsing reject invalid submissions', () => {
  const form = parseMcpElicitationForm({
    type: 'object',
    properties: {
      uri: { type: 'string', format: 'uri' },
      date: { type: 'string', format: 'date' },
      timestamp: { type: 'string', format: 'date-time' },
    },
    required: ['uri', 'date', 'timestamp'],
  })
  assert.equal(validateMcpElicitationContent(form, {
    uri: 'urn:isbn:9780141036144',
    date: '2026-07-19',
    timestamp: '2026-07-19T12:30:15+07:00',
  }), undefined)
  assert.match(validateMcpElicitationContent(form, {
    uri: 'relative/path',
    date: '2026-02-30',
    timestamp: '2026-07-19 12:30:15',
  }) || '', /absolute URI/)
  assert.equal(parseMcpElicitationNumberInput('+1.25e2'), 125)
  assert.equal(parseMcpElicitationNumberInput('0x10'), undefined)
  assert.equal(parseMcpElicitationNumberInput('Infinity'), undefined)
})

test('unsupported or impossible MCP schemas are declined by the parser', () => {
  assert.throws(() => parseMcpElicitationForm({
    type: 'object',
    properties: { nested: { type: 'object' } },
  }), /type is unsupported/)
  assert.throws(() => parseMcpElicitationForm({
    type: 'object',
    properties: {
      choice: { type: 'string', enum: Array.from({ length: 26 }, (_, index) => String(index)) },
    },
  }), /more than 25 options/)
  assert.throws(() => parseMcpElicitationForm({
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 26 }, (_, index) => [`field-${index}`, { type: 'boolean' }]),
    ),
  }), /more than 25 fields/)
  assert.throws(() => parseMcpElicitationForm({
    type: 'object',
    properties: { count: { type: 'integer', default: 1.5 } },
  }), /must be a safe integer/)
  assert.throws(() => parseMcpElicitationForm({
    type: 'object',
    properties: {},
    required: ['missing'],
  }), /unknown property/)
})

test('URL elicitations require credential-free HTTPS and restrict Codex Apps hosts', () => {
  assert.equal(
    validateMcpElicitationUrl('https://example.com/finish', 'server'),
    'https://example.com/finish',
  )
  assert.equal(validateMcpElicitationUrl('http://example.com/finish', 'server'), undefined)
  assert.equal(validateMcpElicitationUrl('https://user:pass@example.com', 'server'), undefined)
  assert.equal(
    validateMcpElicitationUrl('https://auth.chatgpt.com/connect', 'codex_apps'),
    'https://auth.chatgpt.com/connect',
  )
  assert.equal(
    validateMcpElicitationUrl('https://example.com/connect', 'codex_apps'),
    undefined,
  )
})

test('approval metadata exposes only supported persistence choices and display params', () => {
  const meta = {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['always', 'unknown', 'session'],
    tool_params: {
      title: 'Roadmap review',
      visibility: 'private',
    },
    tool_params_display: [
      { name: 'title', display_name: 'Title', value: 'stale display value' },
    ],
  }
  assert.equal(isMcpToolApproval(meta), true)
  assert.deepEqual(mcpElicitationPersistModes(meta), ['session', 'always'])
  assert.deepEqual(mcpToolApprovalDisplayParams(meta), [
    {
      name: 'title',
      displayName: 'Title',
      value: 'Roadmap review',
    },
    {
      name: 'visibility',
      displayName: 'visibility',
      value: 'private',
    },
  ])
})

test('form content records preserve an own __proto__ field without prototype mutation', () => {
  const form = parseMcpElicitationForm(JSON.parse(`{
    "type": "object",
    "properties": {
      "__proto__": { "type": "string", "default": "initial" }
    },
    "required": ["__proto__"]
  }`))

  assert.equal(Object.getPrototypeOf(form.initialContent), null)
  assert.equal(Object.hasOwn(form.initialContent, '__proto__'), true)
  assert.equal(form.initialContent.__proto__, 'initial')
  form.initialContent.__proto__ = 'updated'
  assert.equal(validateMcpElicitationContent(form, form.initialContent), undefined)
  assert.equal(form.initialContent.__proto__, 'updated')
})
