import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ThreadChannel,
} from 'discord.js'
import {
  CodexAppServer,
  type CodexSkillMetadata,
  type CodexSkillsListEntry,
  type CodexSkillsListParams,
} from '../src/codex-app-server.js'
import { CordexDiscordBot } from '../src/discord-bot.js'
import type {
  CordexConfig,
  CordexState,
  ServerNotification,
  SessionState,
  UserInput,
} from '../src/types.js'

type SkillChoice = { name: string; value: string }

type InternalBot = {
  persistAndDeliverDirectPrompt(
    session: SessionState,
    channel: ThreadChannel,
    prompt: {
      id: string
      input: UserInput[]
    },
  ): Promise<void>
  handleAutocomplete(interaction: AutocompleteInteraction): Promise<void>
  handleNotification(notification: ServerNotification): Promise<void>
  handleSkillCommand(interaction: ChatInputCommandInteraction): Promise<void>
  memberAllowed(userId: string): Promise<boolean>
  refreshProjectsSafely(): Promise<void>
}

class SkillCodex extends EventEmitter {
  readonly listCalls: CodexSkillsListParams[] = []
  entriesByCwd = new Map<string, CodexSkillsListEntry>()
  listGate: { promise: Promise<void>; release(): void } | undefined

  async listSkills(params: CodexSkillsListParams): Promise<CodexSkillsListEntry[]> {
    this.listCalls.push(structuredClone(params))
    const response = (params.cwds || []).flatMap((cwd) => {
      const entry = this.entriesByCwd.get(path.resolve(cwd))
      return entry ? [structuredClone(entry)] : []
    })
    const gate = this.listGate
    this.listGate = undefined
    if (gate) await gate.promise
    return response
  }
}

function makeConfig(): CordexConfig {
  return {
    token: 'fixture-token',
    applicationId: 'application-1',
    guildId: 'guild-1',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    allowAllUsers: true,
    allowShellCommands: false,
    projects: {
      'parent-1': { directory: '/tmp/skill-project' },
      'parent-2': { directory: '/tmp/other-skill-project' },
    },
  }
}

function makeSession(
  discordThreadId = 'discord-skill-thread',
  parentChannelId = 'parent-1',
  directory = '/tmp/skill-project',
): SessionState {
  return {
    discordThreadId,
    parentChannelId,
    directory,
    codexThreadId: `codex-${discordThreadId}`,
    model: 'gpt-test',
    updatedAt: new Date(0).toISOString(),
  }
}

function makeState(sessions: SessionState[]): CordexState {
  return {
    channelModels: {},
    channelEfforts: {},
    channelFastMode: {},
    channelYoloMode: {},
    channelAutoWorktrees: {},
    channelVerbosity: {},
    sessions: Object.fromEntries(sessions.map((session) => [session.discordThreadId, session])),
    queues: {},
    tasks: {},
  }
}

function makeChannel(session: SessionState): ThreadChannel {
  return {
    id: session.discordThreadId,
    parentId: session.parentChannelId,
    guildId: 'guild-1',
    name: 'Skill session',
    isThread: () => true,
    toString: () => `<#${session.discordThreadId}>`,
  } as unknown as ThreadChannel
}

function makeSkill(
  name: string,
  options: Partial<CodexSkillMetadata> = {},
): CodexSkillMetadata {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    scope: 'repo',
    enabled: true,
    ...options,
  }
}

function setSkills(codex: SkillCodex, directory: string, skills: CodexSkillMetadata[]): void {
  const cwd = path.resolve(directory)
  codex.entriesByCwd.set(cwd, { cwd, skills, errors: [] })
}

function makeFixture(skills: CodexSkillMetadata[]) {
  const session = makeSession()
  const otherSession = makeSession(
    'discord-other-skill-thread',
    'parent-2',
    '/tmp/other-skill-project',
  )
  const state = makeState([session, otherSession])
  const codex = new SkillCodex()
  setSkills(codex, session.directory, skills)
  setSkills(codex, otherSession.directory, [makeSkill('other-skill', { scope: 'user' })])
  const bot = new CordexDiscordBot(makeConfig(), state, codex as unknown as CodexAppServer)
  const internal = bot as unknown as InternalBot
  internal.memberAllowed = async () => true
  internal.refreshProjectsSafely = async () => undefined
  return {
    bot,
    internal,
    codex,
    session,
    otherSession,
    channel: makeChannel(session),
    otherChannel: makeChannel(otherSession),
  }
}

function makeAutocompleteInteraction(
  channel: ThreadChannel,
  query: string,
  responses: SkillChoice[][],
): AutocompleteInteraction {
  return {
    guildId: 'guild-1',
    commandName: 'skill',
    channel,
    user: { id: 'user-1' },
    options: {
      getFocused: () => ({ name: 'skill', value: query }),
    },
    async respond(choices: SkillChoice[]) {
      responses.push(choices)
    },
  } as unknown as AutocompleteInteraction
}

function makeSkillInteraction(
  channel: ThreadChannel,
  skill: string,
  prompt: string | null,
  replies: unknown[],
  id = 'interaction-1',
): ChatInputCommandInteraction {
  return {
    id,
    user: { id: 'user-1', displayName: 'Skill User' },
    channel,
    options: {
      getString(name: string) {
        if (name === 'skill') return skill
        if (name === 'prompt') return prompt
        return null
      },
    },
    async reply(value: unknown) {
      replies.push(value)
    },
  } as unknown as ChatInputCommandInteraction
}

test('skill autocomplete filters enabled unique skills, caps choices, and caches per cwd', async () => {
  const skills = Array.from({ length: 30 }, (_, index) => makeSkill(`skill-${index}`, {
    interface: { displayName: `Skill ${index}`, shortDescription: `task ${index}` },
    scope: index % 2 === 0 ? 'repo' : 'user',
  }))
  skills.push(makeSkill('disabled-skill', { enabled: false }))
  skills.push(makeSkill('ambiguous-skill', { path: '/one/SKILL.md' }))
  skills.push(makeSkill('ambiguous-skill', { path: '/two/SKILL.md', scope: 'user' }))
  const fixture = makeFixture(skills)
  const responses: SkillChoice[][] = []
  try {
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, 'task 2', responses),
    )
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.otherChannel, '', responses),
    )

    assert.equal(responses[0]?.length, 25)
    assert.equal(responses[0]?.some((choice) => choice.value === 'disabled-skill'), false)
    assert.equal(responses[0]?.some((choice) => choice.value === 'ambiguous-skill'), false)
    assert.ok(responses[0]?.every((choice) => /\((repo|user)\)$/.test(choice.name)))
    assert.ok(responses[1]?.every((choice) => choice.value.includes('2')))
    assert.deepEqual(fixture.codex.listCalls, [
      { cwds: [path.resolve(fixture.session.directory)], forceReload: false },
      { cwds: [path.resolve(fixture.otherSession.directory)], forceReload: false },
    ])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('skills/changed invalidates autocomplete metadata cache', async () => {
  const fixture = makeFixture([makeSkill('first-skill')])
  const responses: SkillChoice[][] = []
  try {
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )
    setSkills(fixture.codex, fixture.session.directory, [makeSkill('second-skill')])
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )
    assert.deepEqual(responses[1]?.map((choice) => choice.value), ['first-skill'])

    await fixture.internal.handleNotification({ method: 'skills/changed', params: {} })
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )

    assert.deepEqual(responses[2]?.map((choice) => choice.value), ['second-skill'])
    assert.equal(fixture.codex.listCalls.length, 2)
  } finally {
    fixture.bot.client.destroy()
  }
})

test('skill metadata invalidation cannot repopulate a stale in-flight response', async () => {
  const fixture = makeFixture([makeSkill('old-skill')])
  const responses: SkillChoice[][] = []
  let release!: () => void
  fixture.codex.listGate = {
    promise: new Promise<void>((resolve) => { release = resolve }),
    release,
  }
  try {
    const pending = fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )
    await new Promise((resolve) => setImmediate(resolve))
    setSkills(fixture.codex, fixture.session.directory, [makeSkill('new-skill')])
    await fixture.internal.handleNotification({ method: 'skills/changed', params: {} })
    release()
    await pending

    assert.deepEqual(responses[0]?.map((choice) => choice.value), ['new-skill'])
    assert.equal(fixture.codex.listCalls.length, 2)
  } finally {
    release()
    fixture.bot.client.destroy()
  }
})

test('mismatched skills/list cwd fails closed instead of leaking another project', async () => {
  const fixture = makeFixture([makeSkill('safe-skill')])
  const responses: SkillChoice[][] = []
  try {
    fixture.codex.entriesByCwd.set(path.resolve(fixture.session.directory), {
      cwd: '/tmp/unrelated-project',
      skills: [makeSkill('unrelated-skill')],
      errors: [],
    })
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, '', responses),
    )
    assert.deepEqual(responses[0], [])
  } finally {
    fixture.bot.client.destroy()
  }
})

test('/skill revalidates metadata and dispatches exact skill-only and skill-plus-prompt input', async () => {
  const fixture = makeFixture([makeSkill('reviewer', { path: '/old/reviewer/SKILL.md' })])
  const dispatched: Array<{
    channelId: string
    parentChannelId: string
    input: UserInput[]
    clientUserMessageId?: string
  }> = []
  const replies: unknown[] = []
  fixture.internal.persistAndDeliverDirectPrompt = async (session, channel, prompt) => {
    dispatched.push({
      channelId: channel.id,
      parentChannelId: session.parentChannelId,
      input: prompt.input,
      clientUserMessageId: prompt.id,
    })
  }
  try {
    await fixture.internal.handleAutocomplete(
      makeAutocompleteInteraction(fixture.channel, 'review', []),
    )
    setSkills(fixture.codex, fixture.session.directory, [
      makeSkill('reviewer', { path: '/current/reviewer/SKILL.md' }),
    ])

    await fixture.internal.handleSkillCommand(
      makeSkillInteraction(fixture.channel, 'reviewer', 'Check the current diff.', replies),
    )
    await fixture.internal.handleSkillCommand(
      makeSkillInteraction(fixture.channel, 'reviewer', null, replies, 'interaction-2'),
    )

    assert.deepEqual(dispatched, [
      {
        channelId: fixture.channel.id,
        parentChannelId: fixture.session.parentChannelId,
        input: [
          { type: 'skill', name: 'reviewer', path: '/current/reviewer/SKILL.md' },
          { type: 'text', text: 'Check the current diff.', text_elements: [] },
        ],
        clientUserMessageId: 'interaction-1',
      },
      {
        channelId: fixture.channel.id,
        parentChannelId: fixture.session.parentChannelId,
        input: [{ type: 'skill', name: 'reviewer', path: '/current/reviewer/SKILL.md' }],
        clientUserMessageId: 'interaction-2',
      },
    ])
    assert.deepEqual(fixture.codex.listCalls, [
      { cwds: [path.resolve(fixture.session.directory)], forceReload: false },
      { cwds: [path.resolve(fixture.session.directory)], forceReload: true },
      { cwds: [path.resolve(fixture.session.directory)], forceReload: true },
    ])
    assert.equal(replies.length, 2)
  } finally {
    fixture.bot.client.destroy()
  }
})

test('/skill rejects unknown, disabled, ambiguous, and archived selections', async () => {
  const fixture = makeFixture([
    makeSkill('disabled-skill', { enabled: false }),
    makeSkill('ambiguous-skill', { path: '/one/SKILL.md' }),
    makeSkill('ambiguous-skill', { path: '/two/SKILL.md' }),
  ])
  try {
    await assert.rejects(
      fixture.internal.handleSkillCommand(
        makeSkillInteraction(fixture.channel, 'missing-skill', null, []),
      ),
      /Unknown Codex skill/,
    )
    await assert.rejects(
      fixture.internal.handleSkillCommand(
        makeSkillInteraction(fixture.channel, 'disabled-skill', null, []),
      ),
      /disabled/,
    )
    await assert.rejects(
      fixture.internal.handleSkillCommand(
        makeSkillInteraction(fixture.channel, 'ambiguous-skill', null, []),
      ),
      /Ambiguous/,
    )
    fixture.session.archived = true
    await assert.rejects(
      fixture.internal.handleSkillCommand(
        makeSkillInteraction(fixture.channel, 'disabled-skill', null, []),
      ),
      /archived/,
    )
  } finally {
    fixture.bot.client.destroy()
  }
})
