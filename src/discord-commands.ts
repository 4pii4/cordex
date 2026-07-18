import { SlashCommandBuilder } from 'discord.js'
import type { ReasoningEffort } from './types.js'

const effortChoices: ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]

export function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Show or change Codex model')
      .addStringOption((option) =>
        option.setName('model').setDescription('Codex model').setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('effort')
          .setDescription('Reasoning effort')
          .addChoices(...effortChoices.map((effort) => ({ name: effort, value: effort }))),
      )
      .addStringOption((option) =>
        option
          .setName('scope')
          .setDescription('Where preference applies')
          .addChoices(
            { name: 'current session', value: 'session' },
            { name: 'project channel', value: 'channel' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('Show or change Codex collaboration mode')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Collaboration mode')
          .addChoices(
            { name: 'default', value: 'default' },
            { name: 'plan', value: 'plan' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fast')
      .setDescription('Show or change Codex Fast mode')
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('Fast mode action')
          .addChoices(
            { name: 'Status', value: 'status' },
            { name: 'On', value: 'on' },
            { name: 'Off', value: 'off' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('yolo')
      .setDescription('Show or change approval-free, unsandboxed mode')
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('YOLO mode action')
          .addChoices(
            { name: 'Status', value: 'status' },
            { name: 'On', value: 'on' },
            { name: 'Off', value: 'off' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('model-variant')
      .setDescription('Set reasoning effort for current model')
      .addStringOption((option) =>
        option
          .setName('effort')
          .setDescription('Reasoning effort')
          .setRequired(true)
          .addChoices(...effortChoices.map((effort) => ({ name: effort, value: effort }))),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('unset-model-override')
      .setDescription('Remove current session or channel model override')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('project')
      .setDescription('Legacy: map the current channel to a local project directory')
      .addStringOption((option) =>
        option.setName('path').setDescription('Absolute or local project path').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription('Create a Discord channel for an existing local project')
      .addStringOption((option) =>
        option
          .setName('project')
          .setDescription('Recent Codex project or an absolute directory')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('remove-project')
      .setDescription('Delete a managed project channel and its local mapping')
      .addStringOption((option) =>
        option
          .setName('project')
          .setDescription('Managed project channel')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option.setName('force').setDescription('Archive idle sessions before removing the mapping'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('create-new-project')
      .setDescription('Create a git project, its Discord channel, and an initial session')
      .addStringOption((option) =>
        option.setName('name').setDescription('New project name').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('add-dir')
      .setDescription('Allow current session to access an extra directory')
      .addStringOption((option) =>
        option.setName('directory').setDescription('Path relative to session, or * for all directories'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('permissions')
      .setDescription('List or select a Codex permission profile for this session')
      .addStringOption((option) =>
        option.setName('profile').setDescription('Profile ID, or default to clear override'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('new-session')
      .setDescription('Start a new Codex session')
      .addStringOption((option) =>
        option.setName('prompt').setDescription('Initial prompt').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('files')
          .setDescription('Comma-separated files; longer lists can be typed manually')
          .setAutocomplete(true)
          .setMaxLength(6_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume an existing Codex session')
      .addStringOption((option) =>
        option.setName('session').setDescription('Codex thread ID').setRequired(true).setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rename')
      .setDescription('Rename the current Discord and Codex session')
      .addStringOption((option) =>
        option.setName('name').setDescription('New session name').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription('Fork current Codex session into a new Discord thread')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('fork-subagent')
      .setDescription('Fork a Codex subagent task into a new Discord thread')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('btw')
      .setDescription('Fork current context and ask a side question')
      .addStringOption((option) =>
        option.setName('prompt').setDescription('Side question').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription('Compact current Codex context')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('goal')
      .setDescription('Show or set the persistent Codex thread goal')
      .addStringOption((option) =>
        option.setName('objective').setDescription('Goal objective; omit to show current goal'),
      )
      .addIntegerOption((option) =>
        option.setName('token-budget').setDescription('Optional goal token budget').setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription('Goal lifecycle status')
          .addChoices(
            { name: 'Active', value: 'active' },
            { name: 'Paused', value: 'paused' },
            { name: 'Blocked', value: 'blocked' },
            { name: 'Complete', value: 'complete' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('clear-goal')
      .setDescription('Clear the current Codex thread goal')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('archive')
      .setDescription('Archive current Discord and Codex session')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('review')
      .setDescription('Run a Codex code review in current session')
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('Review target')
          .addChoices(
            { name: 'uncommitted changes', value: 'uncommitted' },
            { name: 'base branch', value: 'base' },
            { name: 'custom instructions', value: 'custom' },
          ),
      )
      .addStringOption((option) => option.setName('branch').setDescription('Base branch, when target=base'))
      .addStringOption((option) => option.setName('instructions').setDescription('Custom review instructions'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('diff')
      .setDescription('Show git diff for current project or session')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('Schedule a prompt in current session')
      .addStringOption((option) => option.setName('prompt').setDescription('Prompt to send').setRequired(true))
      .addIntegerOption((option) => option.setName('delay-seconds').setDescription('Seconds until first run').setMinValue(1).setRequired(true))
      .addIntegerOption((option) => option.setName('repeat-seconds').setDescription('Repeat interval in seconds'))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('tasks')
      .setDescription('List scheduled prompts')
      .addBooleanOption((option) =>
        option.setName('all').setDescription('Include completed, cancelled, and failed tasks'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('cancel-task')
      .setDescription('Cancel scheduled prompt')
      .addStringOption((option) => option.setName('id').setDescription('Task ID').setRequired(true))
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('Invoke a Codex skill in the current session')
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription('Enabled Codex skill')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('Optional instruction for the skill')
          .setMaxLength(6_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('List Codex skills available in project')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill-toggle')
      .setDescription('Enable or disable a Codex skill')
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription('Codex skill')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option.setName('enabled').setDescription('Desired skill state').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('skill-roots')
      .setDescription('Set runtime-only extra Codex skill discovery roots')
      .addStringOption((option) =>
        option
          .setName('paths')
          .setDescription('Comma-separated absolute directories; empty clears roots')
          .setMaxLength(4_000),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp-status')
      .setDescription('List Codex MCP server status')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp')
      .setDescription('List, authenticate, or globally toggle Codex MCP servers')
      .addStringOption((option) =>
        option
          .setName('action')
          .setDescription('MCP action; toggles persist in global Codex config')
          .addChoices(
            { name: 'Show status', value: 'status' },
            { name: 'Authenticate', value: 'login' },
            { name: 'Enable globally', value: 'enable-global' },
            { name: 'Disable globally', value: 'disable-global' },
          ),
      )
      .addStringOption((option) =>
        option.setName('server').setDescription('Configured MCP server').setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('mcp-login')
      .setDescription('Start OAuth login for a Codex MCP server')
      .addStringOption((option) =>
        option.setName('server').setDescription('MCP server name').setRequired(true).setAutocomplete(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('auth-status')
      .setDescription('Show Codex authentication and account status')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rate-limits')
      .setDescription('Show Codex account rate-limit usage and resets')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('account-usage')
      .setDescription('Show Codex lifetime token and streak statistics')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('login')
      .setDescription('Start Codex account login')
      .addStringOption((option) =>
        option
          .setName('method')
          .setDescription('Login flow')
          .addChoices(
            { name: 'Browser OAuth', value: 'chatgpt' },
            { name: 'Device code', value: 'chatgptDeviceCode' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('rollback')
      .setDescription('Remove recent turns from Codex history; files stay unchanged')
      .addIntegerOption((option) =>
        option.setName('turns').setDescription('Turns to remove').setMinValue(1).setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('new-worktree')
      .setDescription('Fork current session into an isolated git worktree')
      .addStringOption((option) =>
        option.setName('name').setDescription('Worktree name; defaults to thread name'),
      )
      .addStringOption((option) =>
        option.setName('base-branch').setDescription('Git ref to branch from; defaults to HEAD'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('toggle-worktrees')
      .setDescription('Toggle automatic worktrees for new sessions in this channel')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('worktrees')
      .setDescription('List active worktree sessions across all projects')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('merge-worktree')
      .setDescription('Rebase and fast-forward merge worktree into main checkout')
      .addStringOption((option) =>
        option.setName('target-branch').setDescription('Local branch to merge into; defaults to current branch'),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('delete-worktree')
      .setDescription('Delete a clean worktree after it has been merged')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Queue a prompt after current turn')
      .addStringOption((option) =>
        option.setName('message').setDescription('Prompt to queue').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('clear-queue')
      .setDescription('Clear queued prompts')
      .addIntegerOption((option) =>
        option.setName('position').setDescription('1-based queue position').setMinValue(1),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('run-shell-command')
      .setDescription('Run a shell command in project directory')
      .addStringOption((option) =>
        option.setName('command').setDescription('Shell command').setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('last-sessions')
      .setDescription('List recent Codex sessions across all mapped projects')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('context-usage')
      .setDescription('Show token usage and context window for current session')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('verbosity')
      .setDescription('Show or set output verbosity for this project channel')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('Output detail level')
          .addChoices(
            { name: 'Tools and text', value: 'tools_and_text' },
            { name: 'Text and essential tools', value: 'text_and_essential_tools' },
            { name: 'Text only', value: 'text_only' },
          ),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('session-id')
      .setDescription('Show current Codex session ID and local resume command')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription('Stop active Codex turn')
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show Cordex session status')
      .setDMPermission(false),
  ].map((command) => command.toJSON())
}
