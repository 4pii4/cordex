import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Attachment, Message as DiscordMessage } from 'discord.js'
import {
  buildDiscordInput,
  isSupportedTextMimeType,
  pruneDiscordAttachmentCache,
  type DiscordInputMessage,
} from '../src/discord-input.js'

function attachment(options: {
  name: string
  contentType: string | null
  size: number
  url?: string
}): Attachment {
  return {
    name: options.name,
    contentType: options.contentType,
    size: options.size,
    url: options.url || `https://cdn.example/${options.name}`,
  } as Attachment
}

function message(options: {
  content?: string
  attachments?: Attachment[]
  reference?: DiscordMessage
  fetchReferenceError?: Error
  embeds?: DiscordInputMessage['embeds']
  poll?: DiscordInputMessage['poll']
  messageSnapshots?: DiscordInputMessage['messageSnapshots']
  mentions?: DiscordInputMessage['mentions']
  guild?: DiscordInputMessage['guild']
} = {}): DiscordInputMessage {
  const attachments = new Map((options.attachments || []).map((item, index) => [String(index), item]))
  return {
    id: 'message-1',
    content: options.content || '',
    author: { id: 'user-1', username: 'sender', displayName: 'Sender' },
    attachments,
    reference: options.reference || options.fetchReferenceError
      ? { messageId: 'reference-1' }
      : null,
    async fetchReference() {
      if (options.fetchReferenceError) throw options.fetchReferenceError
      if (!options.reference) throw new Error('No reference')
      return options.reference
    },
    ...(options.embeds !== undefined ? { embeds: options.embeds } : {}),
    ...(options.poll !== undefined ? { poll: options.poll } : {}),
    ...(options.messageSnapshots !== undefined
      ? { messageSnapshots: options.messageSnapshots }
      : {}),
    ...(options.mentions !== undefined ? { mentions: options.mentions } : {}),
    ...(options.guild !== undefined ? { guild: options.guild } : {}),
  } as unknown as DiscordInputMessage
}

test('reply context includes author identity and bounded quoted text', async () => {
  const referenced = {
    content: `first line\n${'x'.repeat(80)}`,
    cleanContent: `first line\n${'x'.repeat(80)}`,
    author: { id: 'user-2', username: 'alice', displayName: 'Alice' },
  } as DiscordMessage
  const result = await buildDiscordInput({
    message: message({ content: '<@123> please continue', reference: referenced }),
    botUserId: '123',
    limits: { replyTextCharacters: 40 },
  })
  assert.equal(result.feedback.length, 0)
  assert.equal(result.input.length, 1)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.match(text, /Reply context from Alice \(@alice\) \(Discord id user-2\):/)
  assert.match(text, /> first line/)
  assert.match(text, /\[reply truncated\]/)
  assert.match(text, /Current Discord message:\nplease continue/)
  assert.doesNotMatch(text, /x{50}/)
})

test('rich Discord content resolves visible mentions and omits private metadata', async () => {
  const mentions = {
    users: new Map([
      ['999', { displayName: 'Cordex', username: 'cordex' }],
      ['111', { displayName: 'Global Alice', username: 'alice' }],
    ]),
    roles: new Map([['222', { name: 'Reviewers' }]]),
    channels: new Map([['333', { name: 'engineering' }]]),
  } as unknown as NonNullable<DiscordInputMessage['mentions']>
  const snapshots = new Map([
    ['snapshot-1', {
      content: 'Forwarded note from <@444>.',
      mentions: {
        users: new Map([['444', { displayName: 'Bob', username: 'bob' }]]),
      },
      embeds: [{ title: 'Forwarded title', description: 'Forwarded details' }],
      author: { id: 'private-author-id' },
      webhookId: 'private-webhook-id',
    }],
  ]) as unknown as NonNullable<DiscordInputMessage['messageSnapshots']>
  const result = await buildDiscordInput({
    message: message({
      content: '<@999> Ask <@111> and <@!111> from <@&222> in <#333>.',
      mentions,
      guild: {
        members: {
          cache: new Map([['111', { displayName: 'Guild Alice' }]]),
        },
      } as unknown as NonNullable<DiscordInputMessage['guild']>,
      embeds: [{
        author: { name: 'Release Bot' },
        title: 'Build report',
        url: 'https://example.test/build',
        description: 'All checks passed.',
        fields: [{ name: 'Commit', value: 'abc123', inline: false }],
        footer: { text: 'CI' },
        privateToken: 'embed-private-token',
      }] as unknown as NonNullable<DiscordInputMessage['embeds']>,
      poll: {
        question: { text: 'Deploy now?' },
        answers: new Map([
          [1, { text: 'Yes', voteCount: 42 }],
          [2, { text: 'No', voteCount: 7 }],
        ]),
        privateToken: 'poll-private-token',
      } as unknown as NonNullable<DiscordInputMessage['poll']>,
      messageSnapshots: snapshots,
    }),
    botUserId: '999',
  })

  assert.equal(result.feedback.length, 0)
  assert.equal(result.input.length, 1)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.match(text, /^Ask @Guild Alice and @Guild Alice from @Reviewers in #engineering\./)
  assert.doesNotMatch(text, /<@!?999>|@Cordex/)
  assert.match(text, /<embed>\nAuthor: Release Bot\nTitle: Build report/)
  assert.match(text, /URL: https:\/\/example\.test\/build/)
  assert.match(text, /All checks passed\.\nCommit: abc123\nFooter: CI\n<\/embed>/)
  assert.match(text, /<poll>\nQuestion: Deploy now\?\n- Yes\n- No\n<\/poll>/)
  assert.match(text, /<forwarded-message>\nForwarded note from @Bob\./)
  assert.match(text, /Title: Forwarded title\nForwarded details/)
  assert.doesNotMatch(text, /private-author-id|private-webhook-id|private-token|voteCount|42|7/)
})

test('rich Discord context has an independent cap and tolerates partial shapes', async () => {
  const content = 'keep the complete Discord prompt'
  const result = await buildDiscordInput({
    message: message({
      content,
      embeds: [{
        title: 'Partial embed',
        description: 'x'.repeat(200),
      }] as unknown as NonNullable<DiscordInputMessage['embeds']>,
      poll: {
        answers: new Map([[1, { text: 'Optional answer' }]]),
      } as unknown as NonNullable<DiscordInputMessage['poll']>,
      messageSnapshots: new Map([
        ['empty', { content: null, embeds: undefined, mentions: undefined }],
        ['visible', { content: 'Forwarded fallback', embeds: [] }],
      ]) as unknown as NonNullable<DiscordInputMessage['messageSnapshots']>,
    }),
    limits: { richContextCharacters: 80 },
  })

  assert.equal(result.feedback.length, 0)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.ok(text.startsWith(`${content}\n\n<embed>`))
  const richContext = text.slice(content.length + 2)
  assert.ok(richContext.length <= 80)
  assert.match(richContext, /\[Discord context truncated\]$/)
  assert.doesNotMatch(text, /x{100}/)
})

test('text attachment allowlist rejects unsupported and advertised oversize files explicitly', async () => {
  assert.equal(isSupportedTextMimeType('application/problem+json; charset=utf-8'), true)
  assert.equal(isSupportedTextMimeType('application/zip'), false)
  const requested: string[] = []
  const result = await buildDiscordInput({
    message: message({
      content: 'inspect these',
      attachments: [
        attachment({ name: 'data.json', contentType: 'application/json; charset=utf-8', size: 12 }),
        attachment({ name: 'archive.zip', contentType: 'application/zip', size: 5 }),
        attachment({ name: 'large.txt', contentType: 'text/plain', size: 101 }),
      ],
    }),
    limits: { textAttachmentBytes: 100 },
    fetchImpl: async (url) => {
      requested.push(url)
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(requested.length, 1)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.match(text, /Discord attachment "data\.json"/)
  assert.match(text, /\{"ok":true\}/)
  assert.deepEqual(result.feedback.map((item) => item.code), [
    'attachment-unsupported',
    'attachment-too-large',
  ])
  assert.match(result.feedback[0]?.message || '', /archive\.zip/)
  assert.match(result.feedback[1]?.message || '', /large\.txt/)
})

test('images are downloaded to stable localImage paths and deduplicated by content', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-discord-input-'))
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const inputMessage = message({
    attachments: [attachment({ name: 'screen.png', contentType: 'image/png', size: bytes.length })],
  })
  const build = () => buildDiscordInput({
    message: inputMessage,
    attachmentDirectory: directory,
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
  })
  try {
    const first = await build()
    const second = await build()
    assert.equal(first.feedback.length, 0)
    assert.equal(first.input.length, 1)
    assert.equal(first.input[0]?.type, 'localImage')
    assert.deepEqual(second.input, first.input)
    const localPath = first.input[0]?.type === 'localImage' ? first.input[0].path : ''
    assert.equal(path.dirname(localPath), directory)
    assert.equal(path.extname(localPath), '.png')
    assert.deepEqual(await readFile(localPath), bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('attachment cache pruning removes expired and over-budget orphan images only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cordex-discord-cache-'))
  const expiredImage = path.join(directory, `${'a'.repeat(64)}.png`)
  const queuedImage = path.join(directory, `${'b'.repeat(64)}.jpg`)
  const overBudgetImage = path.join(directory, `${'c'.repeat(64)}.webp`)
  const unrelatedFile = path.join(directory, 'notes.txt')
  const now = Date.now()
  try {
    await Promise.all([
      writeFile(expiredImage, 'old!'),
      writeFile(queuedImage, 'queued'),
      writeFile(overBudgetImage, 'overflow'),
      writeFile(unrelatedFile, 'unrelated content that is outside the managed image cache'),
    ])
    const old = new Date(now - 10_000)
    await Promise.all([
      utimes(expiredImage, old, old),
      utimes(queuedImage, old, old),
      utimes(unrelatedFile, old, old),
    ])

    const result = await pruneDiscordAttachmentCache({
      directory,
      protectedPaths: [queuedImage],
      maxAgeMs: 1_000,
      maxBytes: 6,
      now,
    })

    assert.deepEqual(result, { removedFiles: 2, removedBytes: 12, retainedBytes: 6 })
    await assert.rejects(readFile(expiredImage), { code: 'ENOENT' })
    await assert.rejects(readFile(overBudgetImage), { code: 'ENOENT' })
    assert.equal((await readFile(queuedImage, 'utf8')), 'queued')
    assert.match(await readFile(unrelatedFile, 'utf8'), /outside the managed image cache/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('actual download size and reply fetch failures produce feedback without phantom input', async () => {
  const result = await buildDiscordInput({
    message: message({
      attachments: [attachment({ name: 'small.txt', contentType: 'text/plain', size: 1 })],
      fetchReferenceError: new Error('deleted'),
    }),
    limits: { textAttachmentBytes: 4 },
    fetchImpl: async () => new Response('12345', { headers: { 'content-type': 'text/plain' } }),
  })
  assert.deepEqual(result.input, [])
  assert.deepEqual(result.feedback.map((item) => item.code), [
    'reply-unavailable',
    'attachment-too-large',
  ])
})

test('reply feedback distinguishes deleted references from retryable fetch failures', async () => {
  const deleted = await buildDiscordInput({
    message: message({
      content: 'Continue without the deleted reply.',
      fetchReferenceError: Object.assign(new Error('Unknown Message'), { code: 10_008 }),
    }),
  })
  const transient = await buildDiscordInput({
    message: message({
      content: 'Retry the unavailable reply.',
      fetchReferenceError: new Error('Temporary Discord failure'),
    }),
  })

  assert.equal(deleted.feedback[0]?.code, 'reply-unavailable')
  assert.equal(deleted.feedback[0]?.retryable, false)
  assert.equal(transient.feedback[0]?.code, 'reply-unavailable')
  assert.equal(transient.feedback[0]?.retryable, true)
})

test('stalled attachment fetches and bodies time out with explicit feedback', async () => {
  const keepAlive = setInterval(() => undefined, 1_000)
  try {
    for (const stalledAt of ['fetch', 'body'] as const) {
      let signal: AbortSignal | undefined
      const startedAt = Date.now()
      const result = await buildDiscordInput({
        message: message({
          attachments: [
            attachment({ name: `${stalledAt}.txt`, contentType: 'text/plain', size: 1 }),
          ],
        }),
        limits: { downloadTimeoutMs: 20 },
        fetchImpl: (_url, init) => {
          signal = init?.signal || undefined
          if (stalledAt === 'fetch') return new Promise<Response>(() => undefined)
          return Promise.resolve(new Response(new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }), { headers: { 'content-type': 'text/plain' } }))
        },
      })

      assert.ok(Date.now() - startedAt < 500, `${stalledAt} timeout should finish promptly`)
      assert.equal(signal?.aborted, true)
      assert.deepEqual(result.input, [])
      assert.deepEqual(result.feedback.map((item) => item.code), ['attachment-download-failed'])
      assert.match(result.feedback[0]?.message || '', /timed out/)
      assert.equal(result.feedback[0]?.attachmentName, `${stalledAt}.txt`)
    }
  } finally {
    clearInterval(keepAlive)
  }
})

test('aggregate attachment budget is enforced before later sequential downloads', async () => {
  const requested: string[] = []
  let activeFetches = 0
  let maxActiveFetches = 0
  const result = await buildDiscordInput({
    message: message({
      attachments: [
        attachment({ name: 'first.txt', contentType: 'text/plain', size: 3 }),
        attachment({ name: 'second.txt', contentType: 'text/plain', size: 3 }),
        attachment({ name: 'third.txt', contentType: 'text/plain', size: 3 }),
      ],
    }),
    limits: { messageAttachmentBytes: 6 },
    fetchImpl: async (url) => {
      requested.push(url)
      activeFetches += 1
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeFetches -= 1
      return new Response('abc', { headers: { 'content-type': 'text/plain' } })
    },
  })

  assert.deepEqual(requested, [
    'https://cdn.example/first.txt',
    'https://cdn.example/second.txt',
  ])
  assert.equal(maxActiveFetches, 1)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.match(text, /Discord attachment "first\.txt"/)
  assert.match(text, /Discord attachment "second\.txt"/)
  assert.doesNotMatch(text, /third\.txt/)
  assert.deepEqual(result.feedback.map((item) => item.code), ['attachment-total-too-large'])
  assert.equal(result.feedback[0]?.attachmentName, 'third.txt')
})

test('aggregate text character budget bounds multiple text attachments', async () => {
  const bodies = new Map([
    ['https://cdn.example/first.txt', 'a'.repeat(80)],
    ['https://cdn.example/second.txt', 'b'.repeat(80)],
    ['https://cdn.example/third.txt', 'THIRD-TAIL-SHOULD-NOT-APPEAR'],
  ])
  const requested: string[] = []
  const limit = 220
  const result = await buildDiscordInput({
    message: message({
      content: 'inspect all files',
      attachments: [
        attachment({ name: 'first.txt', contentType: 'text/plain', size: 80 }),
        attachment({ name: 'second.txt', contentType: 'text/plain', size: 80 }),
        attachment({ name: 'third.txt', contentType: 'text/plain', size: 32 }),
      ],
    }),
    limits: { messageTextCharacters: limit },
    fetchImpl: async (url) => {
      requested.push(url)
      return new Response(bodies.get(url), { headers: { 'content-type': 'text/plain' } })
    },
  })

  assert.deepEqual(requested, [...bodies.keys()])
  assert.equal(result.feedback.length, 0)
  assert.equal(result.input.length, 1)
  const text = result.input[0]?.type === 'text' ? result.input[0].text : ''
  assert.ok(text.length <= limit)
  assert.match(text, /^inspect all files\n\nDiscord attachment "first\.txt"/)
  assert.match(text, /\[Discord input truncated\]$/)
  assert.doesNotMatch(text, /THIRD-TAIL-SHOULD-NOT-APPEAR/)
})
